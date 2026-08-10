// Pure streak + rolling-active-weeks derivation. Input is the set of UTC days on
// which the account did a genuine (streak-ticking) act — derived server-side from
// on-chain history so it can't be self-inflated. A banked freeze bridges one
// missed day (Duolingo mercy; prevents the churn cliff).

/** The chain ladder's rolling window, and the default for anyone who omits it. */
export const DEFAULT_ACTIVE_WEEKS_WINDOW = 26;

/**
 * ★ THE MOST FREEZES THAT MAY EVER SIT INSIDE ONE UNBROKEN RUN.
 *
 * RUNTIME-PROVEN NECESSARY, not defensive (2026-08-09, @lordbutterfly through the live
 * route). The ledger's "hold at most 2" cap bounds what is AVAILABLE PER READ, and the
 * streak is recomputed on every read — so with 80 stored act-days the account had
 * earned 11 freezes, spent 2 on the first two gaps, and had 2 available again on the
 * next cache miss five minutes later. Each read would bridge two more gaps and record
 * them, so the streak grew by two every five minutes, without the account doing
 * anything. A lifetime pool behind a per-read cap is not a cap.
 *
 * Bounding the RUN fixes it at the only place that knows what the run is: days already
 * covered count against the same allowance as new ones, so a run can never contain more
 * than this many missed days however many freezes the account has banked.
 *
 * Keep this equal to the ledger's `FREEZE_MAX_HELD`
 * (lib/lite/repositories/hive-retention-repository.ts) — the ladder test asserts it.
 */
export const MAX_FREEZES_IN_RUN = 2;

export interface StreakInputs {
  actDaysUTC: string[]; // 'YYYY-MM-DD' days with a genuine act (unordered, may dup)
  todayUTC: string; // 'YYYY-MM-DD'
  freezeAvailable: number; // banked freezes that can each bridge one gap
  /**
   * Days a freeze ALREADY paid for on a previous read (`lumen_hive_freeze_spent`).
   *
   * ★ A SEPARATE INPUT FROM `actDaysUTC`, AND THE DISTINCTION IS THE WHOLE MECHANIC.
   * The first version fed spent days back in as act-days, which made the streak
   * IDEMPOTENT but not STABLE: a bridged day then counted as a day of activity, so the
   * same account read 4 on the request that spent the freeze and 5 on the next one.
   * Caught by the round-trip assertion in the ladder test, not by inspection.
   *
   * A covered day bridges the gap WITHOUT incrementing the run and WITHOUT spending
   * budget again — which is also what a freeze means everywhere else it exists: it
   * protects the streak, it does not pretend you showed up.
   */
  coveredDaysUTC?: string[];
  /**
   * Authored acts recorded TODAY, and the goal they must reach for today to count.
   *
   * ★ THE GOAL NOW GATES THE STREAK (2026-08-09, owner instruction). Until now the
   * picker was decorative: `computeStreak` collapsed `actDaysUTC` to a SET, so a day
   * counted on its first act and the chosen target changed only the ring's denominator.
   * A council seat called that out against this feature's own design doc, which had
   * always said "the streak ticks when the goal is met, not on the first act".
   *
   * ★ ONLY TODAY IS GATED, AND THAT IS DELIBERATE. The persisted act-day store
   * (migration 0028) records DAYS, not per-day counts, so historical days cannot be
   * re-judged against a goal — and re-judging them would retroactively destroy streaks
   * people already earned under the old rule, which is a far worse outcome than a
   * mechanic that starts applying from today. This is also exactly how the mechanic
   * behaves elsewhere: your past is settled, today's target is the one you have to meet.
   *
   * Omit both to keep the old any-act behaviour.
   */
  todayActs?: number;
  dailyGoal?: number;
  /**
   * The most missed days that may sit inside this run, counting both already-covered
   * days and newly bridged ones. Defaults to MAX_FREEZES_IN_RUN.
   *
   * This is the bound that makes the mercy finite. `freezeAvailable` alone cannot:
   * it is spent and then replenished from a lifetime pool on the next read, which
   * grows the streak forever (see MAX_FREEZES_IN_RUN for the runtime proof).
   */
  maxFreezesInRun?: number;
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
   * Not reachable while the platform is two days old; guaranteed reachable in
   * ten weeks. One window, passed in, so N and M cannot disagree.
   */
  windowWeeks?: number;
}

export interface StreakResult {
  streakDays: number;
  activeWeeks: number; // distinct ISO weeks in the trailing window with >= 1 act
  /**
   * The day the streak BROKE — the first day going backwards with no act, in
   * 'YYYY-MM-DD'. `''` when nothing broke it inside the guard (i.e. the day set
   * runs unbroken as far back as this function looked).
   *
   * ★ WHY A CALLER NEEDS THIS AND CANNOT DERIVE IT. `streakDays` is only a
   * MEASUREMENT if the day set is COMPLETE back past the break. The chain caller
   * builds `actDaysUTC` from feed walks that stop on a 20-second wall-clock
   * budget, so its day set is a newest-first PREFIX of history — and a break that
   * falls in the part that was never walked is not a break, it is a hole in the
   * data. Comparing this date against how far the walk actually got is the only
   * way to tell "your streak is 32 days" from "your streak is AT LEAST 32 days".
   * Without it a caller has to either guess, or mark every capped walk inexact —
   * and the second option understates short streaks that are provably complete.
   */
  streakBrokeOnUTC: string;
  /**
   * The missed days a banked freeze bridged on THIS run, newest first.
   *
   * The caller persists them (`lumen_hive_freeze_spent`, migration 0028) and feeds
   * them back in as covered days on the next call. Without that the mercy is not
   * durable: the streak is recomputed from scratch on every read, so a freeze
   * accounted for as a bare counter would break the streak the moment the budget ran
   * out — the exact churn cliff the mechanic exists to prevent.
   */
  freezesUsedOn: string[];
}

export function computeStreak(inp: StreakInputs): StreakResult {
  const days = new Set(inp.actDaysUTC);
  const covered = new Set(inp.coveredDaysUTC ?? []);
  let streak = 0;
  let freezes = Math.max(0, inp.freezeAvailable);
  const maxInRun = Number.isFinite(inp.maxFreezesInRun as number)
    ? Math.max(0, Math.floor(inp.maxFreezesInRun as number))
    : MAX_FREEZES_IN_RUN;
  /** Missed days bridged inside this run, already-covered ones included. */
  let bridged = 0;

  // ★ TODAY ONLY COUNTS ONCE THE GOAL IS MET. With a goal of 1 (the default) this is
  // identical to the old rule, so nobody's existing streak changes meaning until they
  // raise their own bar. Above 1, a partial day behaves exactly like a day with no act
  // yet: the run is counted as ending yesterday and is NOT broken mid-day.
  const goal = Math.max(1, Math.floor(inp.dailyGoal ?? 1));
  // ★ THE DAY SET AND THE COUNT CAN DISAGREE, AND THE DAY SET WINS ON "AT LEAST ONE".
  //
  // `actDaysUTC` is the MERGED history (stored + this request's walk) while `todayActs`
  // comes from THIS request's walk alone. So an incremental walk that missed today's post
  // — or a stored day written by an earlier visit — produces `todayActs: 0` for a day the
  // set knows about. Read literally that withholds a day the reader genuinely earned, and
  // at goal 1 it made the gated path disagree with the ungated one, which my own test
  // caught. If the set contains today, that is at least one act.
  const actsToday = Math.max(inp.todayActs ?? 0, days.has(inp.todayUTC) ? 1 : 0);
  const todayMetGoal = inp.todayActs === undefined ? true : actsToday >= goal;

  // If today has no act *yet* — or has some but not enough — don't break mid-day; count
  // the run ending yesterday.
  let cursor = parse(inp.todayUTC);
  if (!days.has(fmt(cursor)) || !todayMetGoal) cursor = addDays(cursor, -1);

  let brokeOn = '';
  const freezesUsedOn: string[] = [];
  for (let guard = 0; guard < 3650; guard++) {
    const key = fmt(cursor);
    if (days.has(key)) {
      streak++;
    } else if (bridged >= maxInRun) {
      // The run has already used all the mercy a run may contain. This branch comes
      // BEFORE the covered/freeze checks on purpose: an already-covered day beyond the
      // cap must break the run too, or a long-lived account walks backwards through
      // history on freezes it banked years ago.
      brokeOn = key;
      break;
    } else if (covered.has(key)) {
      // Already paid for. Step over it: no increment (nothing happened that day) and
      // no second charge against the earned budget — but it does count against the
      // run's allowance.
      bridged++;
    } else if (freezes > 0) {
      freezes--; // a banked freeze bridges one missed day
      bridged++;
      // ★ WHICH day it bridged, not just how many. The caller PERSISTS these so the
      // same gap is not re-paid on the next read — the streak is recomputed from
      // scratch every time, so a freeze that only decremented a counter would let the
      // streak break the moment the budget ran out, undoing mercy already granted.
      freezesUsedOn.push(key);
    } else {
      brokeOn = key;
      break;
    }
    cursor = addDays(cursor, -1);
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
  const todayThu = isoWeekThursdayMs(parse(inp.todayUTC));
  const weeks = new Set<string>();
  for (const d of inp.actDaysUTC) {
    const dt = parse(d);
    if (Number.isNaN(dt.getTime())) continue;
    const weeksAgo = Math.round((todayThu - isoWeekThursdayMs(dt)) / (7 * 86_400_000));
    // Future-dated acts (weeksAgo < 0) count as this week rather than being
    // dropped: a clock skew on one side must not erase somebody's presence.
    if (weeksAgo < windowWeeks) weeks.add(isoWeek(dt));
  }

  return { streakDays: streak, activeWeeks: weeks.size, streakBrokeOnUTC: brokeOn, freezesUsedOn };
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
