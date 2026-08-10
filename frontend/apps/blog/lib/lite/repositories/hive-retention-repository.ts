import { query, withTransaction, execOn } from '@/blog/lib/lite/db/pool';

/**
 * ════ PERSISTED RETENTION HISTORY FOR HIVE ACCOUNTS ════
 *
 * The store behind migration 0028. It turns the retention route's feed walk from a
 * thing that must complete inside 20 seconds into a thing that only has to read
 * what is NEW, which is what makes activeWeeks, the streak, the longest-ever run
 * and "who found you this week" measurements rather than lower bounds.
 *
 * ★ EVERY READ HERE IS SCOPED BY WHAT WE ACTUALLY WALKED. `oldest_walked` is
 * carried on the cursor precisely so a caller can tell "nothing happened in March"
 * from "March was never read". A function in this file will happily return a small
 * number; it will never return a small number that PRETENDS to be a total. The
 * caller gets `historyComplete` with every answer and must publish it.
 *
 * WRITES ARE ADDITIVE AND IDEMPOTENT. Act-days and givers are `ON CONFLICT DO
 * NOTHING` sets, so a re-walk of overlapping history is free and concurrent
 * refreshes of the same account cannot corrupt each other. Nothing in here ever
 * deletes an act-day: a day that happened stays happened, and the chain is the
 * authority on that, not our walk depth.
 */

export interface HiveWalkCursor {
  hiveAccount: string;
  /** Oldest UTC day ('YYYY-MM-DD') both feeds have been read back to. */
  oldestWalked: string | null;
  /** Newest UTC day read. An incremental walk only needs to reach this. */
  newestWalked: string | null;
  /** The walk reached account creation: activeWeeks and the streak are exact. */
  historyComplete: boolean;
  /** When we first started watching this account. Gates the "new people" stat. */
  firstBuiltAt: Date;
}

interface CursorRow {
  hive_account: string;
  oldest_walked: Date | string | null;
  newest_walked: Date | string | null;
  history_complete: boolean;
  first_built_at: Date;
}

/** DATE columns come back as a Date in node-postgres; we want the UTC day string. */
function toDayString(v: Date | string | null): string | null {
  if (v === null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return v.toISOString().slice(0, 10);
}

function mapCursor(r: CursorRow): HiveWalkCursor {
  return {
    hiveAccount: r.hive_account,
    oldestWalked: toDayString(r.oldest_walked),
    newestWalked: toDayString(r.newest_walked),
    historyComplete: r.history_complete,
    firstBuiltAt: r.first_built_at
  };
}

export async function findHiveWalkCursor(hiveAccount: string): Promise<HiveWalkCursor | null> {
  const { rows } = await query<CursorRow>(
    `SELECT hive_account, oldest_walked, newest_walked, history_complete, first_built_at
       FROM lumen_hive_walk_cursor
      WHERE hive_account = $1`,
    [hiveAccount]
  );
  return rows[0] ? mapCursor(rows[0]) : null;
}

export interface RecordWalkInput {
  hiveAccount: string;
  /** UTC day strings with an authored act. May duplicate and may be unsorted. */
  actDaysUTC: string[];
  /** Oldest day this walk read back to. */
  oldestWalked: string;
  /** Newest day this walk read. */
  newestWalked: string;
  /** This walk reached account creation. */
  historyComplete: boolean;
}

/**
 * Record one walk's findings: add its act-days, and widen the cursor.
 *
 * ★ THE CURSOR ONLY EVER WIDENS, AND THAT IS A CORRECTNESS REQUIREMENT, NOT TIDINESS.
 *
 * A refresh is INCREMENTAL — it reads back to `newest_walked` and stops, so its own
 * `oldestWalked` is recent. Writing that value in would move the "complete from
 * here" boundary FORWARD and throw away every month we had already proven, turning
 * an exact history back into a lower bound on every visit. So `oldest_walked` takes
 * a LEAST and `newest_walked` takes a GREATEST, and `history_complete` is sticky:
 * once the walk has touched account creation, no later partial walk may un-prove it.
 *
 * One transaction, because a widened cursor with unwritten days is a claim to have
 * read history we have not stored.
 */
export async function recordHiveWalk(input: RecordWalkInput): Promise<void> {
  const days = [...new Set(input.actDaysUTC.filter(Boolean))];

  await withTransaction(async (client) => {
    const exec = execOn(client);

    if (days.length > 0) {
      // One statement, one round trip: unnest the day array rather than issuing a
      // write per day. A decade of daily posting is ~3,650 days and this is called
      // on a cold profile view.
      await exec(
        `INSERT INTO lumen_hive_act_day (hive_account, act_day)
         SELECT $1, d::date FROM unnest($2::text[]) AS d
         ON CONFLICT DO NOTHING`,
        [input.hiveAccount, days]
      );
    }

    await exec(
      `INSERT INTO lumen_hive_walk_cursor
              (hive_account, oldest_walked, newest_walked, history_complete)
       VALUES ($1, $2::date, $3::date, $4)
       ON CONFLICT (hive_account) DO UPDATE SET
         oldest_walked    = LEAST(
                              COALESCE(lumen_hive_walk_cursor.oldest_walked, EXCLUDED.oldest_walked),
                              EXCLUDED.oldest_walked
                            ),
         newest_walked    = GREATEST(
                              COALESCE(lumen_hive_walk_cursor.newest_walked, EXCLUDED.newest_walked),
                              EXCLUDED.newest_walked
                            ),
         history_complete = lumen_hive_walk_cursor.history_complete OR EXCLUDED.history_complete,
         updated_at       = now()`,
      [input.hiveAccount, input.oldestWalked, input.newestWalked, input.historyComplete]
    );
  });
}

/**
 * Every stored act-day for an account, oldest first.
 *
 * Returned in full rather than aggregated in SQL because the arithmetic that
 * consumes it — `computeStreak`, `longestRun`, `busiestWeekday` — is PURE and
 * tested, and reimplementing streak logic in SQL would be a second implementation
 * of the one thing on this feature that is genuinely fiddly. A decade of daily
 * posting is ~3,650 short strings.
 */
export async function listHiveActDays(hiveAccount: string): Promise<string[]> {
  const { rows } = await query<{ act_day: Date | string }>(
    `SELECT act_day FROM lumen_hive_act_day WHERE hive_account = $1 ORDER BY act_day ASC`,
    [hiveAccount]
  );
  return rows.map((r) => toDayString(r.act_day)).filter((d): d is string => d !== null);
}

export interface GiverDelta {
  /** Distinct givers now on record for this account. */
  total: number;
  /** Of those, how many we first observed inside the requested window. */
  newInWindow: number;
  /**
   * The most recently first-seen giver inside the window, or null.
   *
   * ★ A NAME, NOT A COUNT, AND THAT IS THE WHOLE POINT. "1 new person read you" is a
   * statistic; "@tarazkp read you for the first time today" is an event, and it is
   * the single best thing this feature can tell anybody. It is also the one line
   * nothing else on Hive can produce, because nothing else keeps a record of who it
   * had already seen.
   */
  newestName: string | null;
}

/**
 * Add observed givers and report how many of them are new.
 *
 * ★ "NEW" MEANS NEW TO US, AND THE CALLER MUST NOT PRINT IT UNTIL THAT IS THE SAME
 * THING. `first_seen` is the day WE first observed a giver, so on a freshly built
 * account every giver is "new" and @blocktrades would be told that 1,564 people
 * discovered him this week. `newPeopleIsTrustworthy` below is the gate, and it is
 * the caller's job to check it — this function reports the raw delta because ops
 * wants the raw delta.
 *
 * Takes RAW distinct givers, not the credited count. The budgeted figure is a score
 * for the ladder arm; a headcount is what a sentence with the word "people" in it
 * gets to use.
 */
export async function recordHiveGivers(
  hiveAccount: string,
  givers: string[],
  windowDays: number
): Promise<GiverDelta> {
  const distinct = [...new Set(givers.filter(Boolean).map((g) => g.toLowerCase()))];

  if (distinct.length > 0) {
    await query(
      `INSERT INTO lumen_hive_giver (hive_account, giver)
       SELECT $1, g FROM unnest($2::text[]) AS g
       ON CONFLICT DO NOTHING`,
      [hiveAccount, distinct]
    );
  }

  const { rows } = await query<{ total: string; new_in_window: string; newest_name: string | null }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE fresh) AS new_in_window,
            -- The newest first-seen giver, ties broken alphabetically so the answer is
            -- STABLE across reads. Without the tiebreak, two givers first seen on the
            -- same day would swap places between requests and the nudge would name a
            -- different person each time the page was refreshed.
            (array_agg(giver ORDER BY first_seen DESC, giver ASC) FILTER (WHERE fresh))[1] AS newest_name
       FROM (
         SELECT giver,
                first_seen,
                first_seen >= ((now() AT TIME ZONE 'utc')::date - $2::int) AS fresh
           FROM lumen_hive_giver
          WHERE hive_account = $1
       ) g`,
    [hiveAccount, windowDays]
  );

  return {
    total: Number(rows[0]?.total ?? 0),
    newInWindow: Number(rows[0]?.new_in_window ?? 0),
    newestName: rows[0]?.newest_name ?? null
  };
}

/**
 * Have we been watching this account for longer than the window the "new people"
 * number is measured over? If not, the number is an artefact of our first build and
 * must not be shown.
 */
export function newPeopleIsTrustworthy(cursor: HiveWalkCursor | null, windowDays: number): boolean {
  if (!cursor) return false;
  const watchedMs = Date.now() - cursor.firstBuiltAt.getTime();
  return watchedMs >= windowDays * 86_400_000;
}

/**
 * ════ STREAK FREEZES ════
 *
 * One freeze earned per FREEZE_EARNED_PER_ACTIVE_DAYS active days, at most
 * FREEZE_MAX_HELD held at once. Earned from the act-day set, so it is chain-derived
 * and unforgeable — a freeze changes the streak, and the streak is the one number
 * here that is deliberately not client-supplied.
 *
 * ★ THE HOLD CAP IS WHAT MAKES IT MERCY RATHER THAN AN EXEMPTION. Without it, a
 * decade-old daily poster banks ~500 freezes and can be absent for over a year with
 * an unbroken streak, which stops the streak meaning anything. Two is what Duolingo
 * grants for the same reason: enough to survive a bad week, not enough to survive
 * losing interest.
 */
export const FREEZE_EARNED_PER_ACTIVE_DAYS = 7;
export const FREEZE_MAX_HELD = 2;

export interface FreezeState {
  /** Days a freeze has already covered. Fed back in as covered days. */
  spentDays: string[];
  /** How many are available to spend on NEW gaps right now. */
  available: number;
  /** Lifetime earned, for the "N freezes banked" line and for ops. */
  earned: number;
}

/**
 * Read the freeze ledger and work out the budget.
 *
 * `activeDays` is the size of the stored act-day set, which is why this takes it as
 * a parameter rather than counting rows itself: the caller has already merged the
 * stored days with this request's walk, and the merged set is the honest total.
 */
export async function readFreezeState(hiveAccount: string, activeDays: number): Promise<FreezeState> {
  const { rows } = await query<{ covered_day: Date | string }>(
    `SELECT covered_day FROM lumen_hive_freeze_spent WHERE hive_account = $1 ORDER BY covered_day DESC`,
    [hiveAccount]
  );
  const spentDays = rows.map((r) => toDayString(r.covered_day)).filter((d): d is string => d !== null);
  const earned = Math.floor(Math.max(0, activeDays) / FREEZE_EARNED_PER_ACTIVE_DAYS);
  // `max(0, ...)` because the cap can shrink the entitlement below what has already
  // been spent if the rules are ever retuned downward. A negative budget would then
  // read as "you owe us a freeze", which is not a thing.
  const available = Math.max(0, Math.min(FREEZE_MAX_HELD, earned - spentDays.length));
  return { spentDays, available, earned };
}

/** Record the days a freeze covered. Idempotent: a covered day is covered once. */
export async function recordFreezeSpent(hiveAccount: string, days: string[]): Promise<void> {
  const distinct = [...new Set(days.filter(Boolean))];
  if (distinct.length === 0) return;
  await query(
    `INSERT INTO lumen_hive_freeze_spent (hive_account, covered_day)
     SELECT $1, d::date FROM unnest($2::text[]) AS d
     ON CONFLICT DO NOTHING`,
    [hiveAccount, distinct]
  );
}

/**
 * How many distinct viewer feeds this author's posts landed in — for the current window
 * AND the one before it, so reach can be reported as a direction instead of a still
 * figure. (It replaced a single-window `countFeedsReached`, which had one caller.)
 *
 * `post_key` is `author/permlink`, so this is a prefix match — which is why migration
 * 0028 adds a `text_pattern_ops` index on it. Without that opclass Postgres cannot use
 * an index for `LIKE 'author/%'` and would scan the busiest table in the schema on every
 * cold profile view. The `_` in the pattern is escaped: Hive account names permit no
 * underscore, but the escape costs nothing and this string is interpolated from a route
 * parameter.
 *
 * ★ IT COUNTS DISTINCT VIEWERS, NOT IMPRESSIONS. The same reader being served the same
 * post on four page loads is one person who saw it, and "landed in 340 feeds" has to mean
 * 340 people or it is just a page-view counter with a friendlier name.
 *
 * ★ TWO WINDOWS, ONE SCAN — filtered aggregates rather than two calls, because the prefix
 * scan is the expensive part and doubling it to print "+18" would be a bad trade.
 *
 * ★ A ZERO PRIOR WINDOW IS NOT A TREND, AND THE CALLER MUST NOT DRAW ONE. `prior === 0`
 * is ambiguous by construction: it means EITHER this account reached nobody last week OR
 * `lumen_feed_served` was not recording yet. Those license opposite claims, and this query
 * cannot tell them apart, so the route publishes `feedsReachedPrev` only when it is above
 * zero and the client renders a direction only when it is present. Understating a real
 * rise is the safe side of that trade; "340 more than last week" invented out of our own
 * table's age is not. Exactly the failure `newPeople`/`newPeopleIsTrustworthy` guards,
 * where `first_seen` means "first seen BY US".
 */
export async function countFeedsReachedWithPrior(
  hiveAccount: string,
  windowDays: number
): Promise<{ current: number; prior: number }> {
  const prefix = `${hiveAccount.toLowerCase().replace(/([%_\\])/g, '\\$1')}/%`;
  const { rows } = await query<{ current: string; prior: string }>(
    `SELECT
       count(DISTINCT viewer) FILTER (
         WHERE served_at >= now() - make_interval(days => $2::int)
       ) AS current,
       count(DISTINCT viewer) FILTER (
         WHERE served_at >= now() - make_interval(days => $2::int * 2)
           AND served_at <  now() - make_interval(days => $2::int)
       ) AS prior
     FROM lumen_feed_served
     WHERE post_key LIKE $1
       AND served_at >= now() - make_interval(days => $2::int * 2)`,
    [prefix, windowDays]
  );
  const r = rows[0];
  return { current: Number(r?.current ?? 0), prior: Number(r?.prior ?? 0) };
}

/**
 * ════ THE DAILY GOAL (migration 0029) ════
 *
 * Server-side because it now GATES THE STREAK. While the picker was cosmetic it lived in
 * localStorage and `daily-goal.ts` said outright that it "measures nothing". Wiring it to
 * the streak makes it load-bearing, and a load-bearing input to a deliberately
 * unforgeable number cannot be client-supplied.
 *
 * `account` is a Hive name OR a lite ULID — one key domain for both identities, the same
 * way `lumen_feed_store.viewer` already spans them.
 */
export const DAILY_GOAL_MIN = 1;
export const DAILY_GOAL_MAX = 20;
/** The smallest goal, and the default. See `readDailyGoalFor`. */
export const DAILY_GOAL_DEFAULT = 1;

/**
 * The reader's committed goal, or the smallest one.
 *
 * ★ THE DEFAULT MUST BE THE SMALLEST GOAL, AND THAT IS A CORRECTNESS PROPERTY NOW, NOT A
 * KINDNESS. With the goal gating the streak, defaulting to anything above 1 would mean a
 * reader who never opened the picker could silently fail a target they never chose and
 * lose a streak to it. At 1, behaviour is identical to the pre-gating rule, so nobody's
 * existing streak changes meaning until they deliberately raise their own bar.
 */
export async function readDailyGoalFor(account: string): Promise<number> {
  const { rows } = await query<{ goal: number }>(
    `SELECT goal FROM lumen_retention_goal WHERE account = $1`,
    [account]
  );
  const g = rows[0]?.goal;
  return typeof g === 'number' && g >= DAILY_GOAL_MIN && g <= DAILY_GOAL_MAX ? g : DAILY_GOAL_DEFAULT;
}

/** Set the goal. Clamped here as well as by the CHECK, so a bad caller cannot 500. */
export async function writeDailyGoalFor(account: string, goal: number): Promise<number> {
  const clamped = Math.max(DAILY_GOAL_MIN, Math.min(DAILY_GOAL_MAX, Math.floor(goal)));
  await query(
    `INSERT INTO lumen_retention_goal (account, goal)
     VALUES ($1, $2)
     ON CONFLICT (account) DO UPDATE SET goal = EXCLUDED.goal, updated_at = now()`,
    [account, clamped]
  );
  return clamped;
}

/**
 * ════ THE RANK SNAPSHOT, FOR THE BYLINE MARK (migration 0029) ════
 *
 * Written as a side effect of a real rank computation; read by a pure SELECT so a feed of
 * N authors costs one query and zero Hive calls. This is the "batch endpoint" that
 * `league-byline.tsx` has been waiting for since it was unmounted.
 */
export interface RankMark {
  account: string;
  tier: string;
  rankNumber: number;
  showMark: boolean;
  computedAt: Date;
}

/**
 * How long a stored rank may be shown.
 *
 * ★ A STALE MARK IS WORSE THAN NO MARK. Ranks decay on long absence, so a row computed
 * weeks ago can name a rung the account has since dropped below — and a mark that
 * contradicts the profile is the exact bug that got this component unmounted in the first
 * place. Seven days: long enough that a feed is mostly populated, short enough that a
 * decayed rank stops being asserted.
 */
export const RANK_MARK_TTL_DAYS = 7;

export async function recordRankMark(
  account: string,
  tier: string,
  rankNumber: number,
  showMark: boolean
): Promise<void> {
  await query(
    `INSERT INTO lumen_hive_rank (account, tier, rank_number, show_mark, computed_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (account) DO UPDATE SET
       tier = EXCLUDED.tier,
       rank_number = EXCLUDED.rank_number,
       show_mark = EXCLUDED.show_mark,
       computed_at = now()`,
    [account, tier, rankNumber, showMark]
  );
}

/**
 * Marks for a batch of authors. Accounts with no row, or a row older than the TTL, are
 * simply ABSENT from the result — the caller draws nothing for them.
 */
export async function listRankMarks(accounts: string[]): Promise<RankMark[]> {
  const distinct = [...new Set(accounts.filter(Boolean).map((a) => a.toLowerCase()))];
  if (distinct.length === 0) return [];
  const { rows } = await query<{
    account: string;
    tier: string;
    rank_number: number;
    show_mark: boolean;
    computed_at: Date;
  }>(
    `SELECT account, tier, rank_number, show_mark, computed_at
       FROM lumen_hive_rank
      WHERE account = ANY($1::citext[])
        AND computed_at >= now() - make_interval(days => $2::int)`,
    [distinct, RANK_MARK_TTL_DAYS]
  );
  return rows.map((r) => ({
    account: r.account,
    tier: r.tier,
    rankNumber: r.rank_number,
    showMark: r.show_mark,
    computedAt: r.computed_at
  }));
}
