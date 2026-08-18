// Pure streak + rolling-active-weeks derivation. Input is the set of UTC days on
// which the account did a genuine (streak-ticking) act — derived server-side from
// on-chain history so it can't be self-inflated.

/** The chain ladder's rolling window, and the default for anyone who omits it. */
export const DEFAULT_ACTIVE_WEEKS_WINDOW = 26;

/**
 * ════ THE STREAK DOES NOT RESET. IT DECAYS, TWICE AS FAST AS IT GROWS ════
 *
 * Owner ruling, 2026-08-18: "it doesnt reset to zero if you skip one day, it just
 * degrades twice as fast than it grows. so if it goes up by 1 for being here that
 * day, you lose 2 if youre not."
 *
 * ★ WHAT THIS REPLACES, AND WHY THE REPLACEMENT IS SIMPLER RATHER THAN CLEVERER.
 *
 * The previous model was consecutive-days-backwards-until-a-break, plus a "freeze"
 * ledger (a Duolingo mercy) that bridged up to two missed days, plus a per-reader
 * daily GOAL that decided whether today counted at all. Three mechanics existed to
 * soften one cliff: a single missed day threw away months of showing up, so a mercy
 * had to be invented, and the mercy then needed a durable ledger, a per-run cap, a
 * spend record and an idempotency argument — every one of which shipped a bug of its
 * own (see migration 0028 and this file's own history).
 *
 * A decay removes the cliff instead of padding it. Miss one day out of thirty and the
 * number goes 30 -> 28, which is a fact the reader can absorb; there is nothing to
 * bank, nothing to spend, nothing to invalidate, and no state beyond the day set.
 * The freeze ledger and the goal are DELETED, not disabled.
 *
 * ★ TWO-TO-ONE IS THE WHOLE MECHANIC. Showing up is worth +1 and a missed day costs
 * -2, so holding a number steady means being here two days in three; growing it means
 * more than that. That asymmetry is what stops the score from being a slow-moving
 * attendance average nobody can lose.
 *
 * ★ IT FLOORS AT ZERO AND NEVER GOES NEGATIVE. A negative streak is a punishment, and
 * a person coming back after a long absence is the last reader this product should
 * put in a hole they have to climb out of before anything registers.
 */
export const STREAK_GAIN_PER_ACTIVE_DAY = 1;
export const STREAK_LOSS_PER_MISSED_DAY = 2;

/**
 * The longest span the accumulator will walk, in days.
 *
 * Ten years. Not a correctness bound — the real bound is `countFromUTC`, which no
 * caller can set earlier than the day Lumen started watching the account — but a
 * loop over caller-supplied dates gets a hard stop regardless of what the caller
 * believes it is passing.
 */
export const MAX_STREAK_WALK_DAYS = 3650;

export interface StreakInputs {
  actDaysUTC: string[]; // 'YYYY-MM-DD' days with a genuine act (unordered, may dup)
  todayUTC: string; // 'YYYY-MM-DD'
  /**
   * The day the count starts from, with the score at zero.
   *
   * ★ EVERYBODY STARTS AT ZERO ON THE DAY LUMEN STARTED COUNTING THEM, which is the
   * same rule the RANK already uses (`deriveLeagueInputs.firstObservedDayUTC`, and
   * the /ranks page says it in as many words: "days you have shown up since Lumen
   * started counting you"). It is what makes the number EXACT rather than a floor: a
   * decay accumulated from an unknown starting value would only ever be a lower
   * bound, because history we never read could only have added to it.
   *
   * The caller passes the LATER of "the day we started watching" (`observedFromUTC`)
   * and "the oldest day our day set is complete from". Omitted (or empty) means "the
   * oldest act day we hold", which is the right default for a path that observed
   * every day of the account's life — the Lumen-native ladder, whose accounts were
   * created here.
   */
  countFromUTC?: string;
  /**
   * The day Lumen started counting this account, i.e. where the score IDEALLY starts.
   *
   * Only ever compared against `countFromUTC` to decide `isLowerBound`. It is a
   * separate input rather than a boolean the caller works out for itself because the
   * comparison is a date off-by-one, and this codebase has already shipped that exact
   * class of bug twice (see walk-coverage.ts). One place, one rule, one test.
   *
   * Omitted means "the caller has nothing earlier to wish for", so the count is exact.
   */
  observedFromUTC?: string;
  /**
   * How many trailing weeks `activeWeeks` counts over. Defaults to the chain
   * ladder's 26.
   *
   * ★ IT IS A PARAMETER BECAUSE THE CALLER PRINTS IT. Every consumer renders
   * "active N of the last M weeks", where M comes from the caller's own
   * `coverage.windowWeeks`. The Lumen-native path measures presence over a
   * 60-day window and reports M = 9, while this function was hardcoded to 26 —
   * so an account with acts older than nine weeks would have produced
   * "active 12 of the last 9 weeks", a sentence that is false on its face.
   * One window, passed in, so N and M cannot disagree.
   */
  windowWeeks?: number;
}

export interface StreakResult {
  /**
   * The streak: +1 per day present, -2 per day missed, floored at zero.
   *
   * Still called `streakDays` on the wire and in every consumer. It is measured in
   * days and it is the same quantity a consecutive-day streak was measured in — a
   * rename would have touched every surface to say the same thing.
   */
  streakDays: number;
  activeWeeks: number; // distinct ISO weeks in the trailing window with >= 1 act
  /** The day the accumulation actually started from, 'YYYY-MM-DD'. */
  countedFromUTC: string;
  /**
   * The count started LATER than the day the account was first observed, so days
   * before it were never read and could only have added to the score.
   *
   * ★ THE FLOOR IS REAL AND IT IS ONE-DIRECTIONAL. Clamping at zero makes the
   * accumulation monotone in its starting value, so computing from zero can only
   * ever UNDERSTATE. A caller that starts at the first observed day is exact; one
   * that had to start later (a walk that never reached back that far) is publishing
   * a floor and must say so — the same rule `activeWeeksIsLowerBound` already
   * follows.
   */
  isLowerBound: boolean;
}

export function computeStreak(inp: StreakInputs): StreakResult {
  const days = new Set(inp.actDaysUTC.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)));
  const today = parse(inp.todayUTC);

  // Where the count begins. `countFromUTC` when the caller supplied one, else the
  // oldest act day we hold — which for the Lumen-native path IS the first observed
  // day, because Lumen created the account.
  const oldestAct = [...days].sort()[0] ?? inp.todayUTC;
  const requested = inp.countFromUTC && /^\d{4}-\d{2}-\d{2}$/.test(inp.countFromUTC) ? inp.countFromUTC : oldestAct;
  // Never start after today, and never start before the loop guard reaches.
  const guardFloor = fmt(addDays(today, -MAX_STREAK_WALK_DAYS));
  const start = requested > inp.todayUTC ? inp.todayUTC : requested < guardFloor ? guardFloor : requested;

  let score = 0;
  let cursor = parse(start);
  for (let guard = 0; guard <= MAX_STREAK_WALK_DAYS; guard++) {
    const key = fmt(cursor);
    if (days.has(key)) {
      score += STREAK_GAIN_PER_ACTIVE_DAY;
    } else if (key !== inp.todayUTC) {
      // ★ TODAY IS NEVER CHARGED. The day is not over: a reader opening the app at
      // 09:00 UTC has not missed it, and docking them for a day still in progress
      // would show a number that goes back up later in the same session. A missed
      // today is charged tomorrow, by the same rule as every other day.
      score = Math.max(0, score - STREAK_LOSS_PER_MISSED_DAY);
    }
    if (key === inp.todayUTC) break;
    cursor = addDays(cursor, 1);
  }

  const windowWeeks =
    Number.isFinite(inp.windowWeeks) && (inp.windowWeeks as number) > 0
      ? Math.floor(inp.windowWeeks as number)
      : DEFAULT_ACTIVE_WEEKS_WINDOW;
  // ★ THE WINDOW IS COUNTED IN ISO WEEKS, NOT IN DAYS — because that is the unit
  // the answer is REPORTED in.
  //
  // This used to admit any day inside a trailing `windowWeeks * 7` DAY span, then
  // count the distinct ISO weeks those days fell in. An inclusive 182-day span
  // touches up to TWENTY-SEVEN ISO weeks, so `activeWeeks` could come back 27
  // while every consumer prints "active {activeWeeks} of the last 26 weeks".
  // Proven, not theorised: a daily poster over 200 days returns 27 under the old
  // rule (see the mutation in the accompanying test). The number was not merely
  // odd-looking, it was arithmetically impossible as stated.
  //
  // Anchoring on each week's THURSDAY is the standard ISO trick — Thursday is
  // always inside its own ISO week and its own ISO year — so "how many weeks ago"
  // is an exact integer with no year-boundary special case. Exactly `windowWeeks`
  // buckets are in range, therefore `activeWeeks <= windowWeeks` ALWAYS, which is
  // the invariant the printed sentence depends on.
  const todayThu = isoWeekThursdayMs(today);
  const weeks = new Set<string>();
  for (const d of days) {
    const dt = parse(d);
    if (Number.isNaN(dt.getTime())) continue;
    const weeksAgo = Math.round((todayThu - isoWeekThursdayMs(dt)) / (7 * 86_400_000));
    // Future-dated acts (weeksAgo < 0) count as this week rather than being
    // dropped: a clock skew on one side must not erase somebody's presence.
    if (weeksAgo < windowWeeks) weeks.add(isoWeek(dt));
  }

  return {
    streakDays: score,
    activeWeeks: weeks.size,
    countedFromUTC: start,
    // Exact when we began at or before the day the account was first observed;
    // a floor whenever the walk forced a later start. Compared against `start` (the
    // day actually used) rather than against what was requested, so the ten-year
    // guard clamp is caught by the same test instead of hiding behind it.
    isLowerBound: Boolean(inp.observedFromUTC) && start > (inp.observedFromUTC as string)
  };
}

function parse(d: string): Date {
  return new Date(d + 'T00:00:00Z');
}
function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}
/**
 * Epoch ms of the Thursday of `d`'s ISO week. Thursday is the only weekday
 * guaranteed to sit in the same ISO week AND the same ISO year as itself, which
 * is why both the week label and the week distance are derived from it — one
 * anchor, so a label and a distance can never disagree about which week a day is
 * in.
 */
function isoWeekThursdayMs(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  return t.getTime();
}

function isoWeek(d: Date): string {
  const t = new Date(isoWeekThursdayMs(d));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${weekNo}`;
}
