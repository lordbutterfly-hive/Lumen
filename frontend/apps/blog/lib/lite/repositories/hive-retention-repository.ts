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

/**
 * ★★★ EVERY `DATE` COLUMN IS READ AS TEXT, AND THIS FUNCTION IS NOW A GUARD RATHER THAN A
 * CONVERSION (fixed 2026-08-18, runtime-proven — every stored day was one day early).
 *
 * node-postgres parses a `DATE` into a JS `Date` at LOCAL midnight. `toISOString()` then
 * converts to UTC, so on any host east of Greenwich the calendar date moves BACK a day:
 * `2026-08-13` came back as `'2026-08-12'` on a CEST box (UTC+2). It is invisible in a UTC
 * container and wrong everywhere else, which is the worst shape a date bug can have.
 *
 * ★ THE DAMAGE WAS NOT A COSMETIC OFF-BY-ONE, IT WAS DOUBLE COUNTING. `/api/streak/[user]`
 * unions the STORED day set with THIS request's walk, and the walk derives its days from
 * ISO timestamps — correctly. So one real day of activity appeared twice in the merged
 * set, once shifted and once not. Measured on @lordbutterfly before the fix: 8 observed
 * act-days where the account had 6, `streakDays` 7 where the decay gives 3, and the RANK
 * arm (`deriveLeagueInputs.observedActDays`) inflated by the same mechanism — so this was
 * silently moving people up the ladder as well.
 *
 * `to_char(col, 'YYYY-MM-DD')` in the SQL means no `Date` is ever constructed and the
 * process timezone cannot enter the answer. This function stays because the row types
 * still allow a `Date` (a caller that forgets the cast gets the old behaviour rather than
 * a crash), and because `null` still has to be handled.
 */
export function toDayString(v: Date | string | null): string | null {
  if (v === null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  // Local components, NOT `toISOString()`: node-postgres built this Date at LOCAL
  // midnight, so its local calendar fields are the true stored date.
  const y = v.getFullYear();
  const m = String(v.getMonth() + 1).padStart(2, '0');
  const d = String(v.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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
    // ★ `to_char`, NOT the bare DATE columns — see `toDayString`. A DATE parsed into a JS
    // Date lands on LOCAL midnight and shifts a day under `toISOString()`.
    `SELECT hive_account,
            to_char(oldest_walked, 'YYYY-MM-DD') AS oldest_walked,
            to_char(newest_walked, 'YYYY-MM-DD') AS newest_walked,
            history_complete,
            first_built_at
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
  /**
   * Words authored per UTC day, as this walk saw them (migration 0038).
   *
   * A TOTAL per day, not a delta: the row keeps `GREATEST(stored, incoming)`, which is
   * what makes the incremental walk's deliberate three-day overlap re-writable without
   * counting those days twice. Omit it and no volume row is touched at all — an older
   * caller, or a walk that read no bodies, must not zero what a previous walk proved.
   */
  wordsByDayUTC?: Record<string, number>;
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

    // Words per day (migration 0038). Same transaction as the day set and the cursor:
    // a widened cursor is a claim to have read history, and the volume is part of what
    // was read.
    const volumeDays = Object.entries(input.wordsByDayUTC ?? {}).filter(
      ([day, words]) => Boolean(day) && Number.isFinite(words) && words > 0
    );
    if (volumeDays.length > 0) {
      await exec(
        `INSERT INTO lumen_hive_authored_volume (hive_account, act_day, words)
         SELECT $1, d.day::date, d.words::int
           FROM unnest($2::text[], $3::int[]) AS d(day, words)
         ON CONFLICT (hive_account, act_day) DO UPDATE
           SET words = GREATEST(lumen_hive_authored_volume.words, EXCLUDED.words)`,
        [
          input.hiveAccount,
          volumeDays.map(([day]) => day),
          volumeDays.map(([, words]) => Math.floor(words))
        ]
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
 * ════ WORDS AUTHORED, PER TIME WINDOW ════
 *
 * ★ FIVE WINDOWS FROM ONE INDEX SCAN (owner, 2026-08-18: "this needs to change with time
 * look3d at. one day 7 days, one time all time... as long as it doesnt slow the load. if
 * its quick and cheap to check").
 *
 * It is cheap, and this is why: the store is one row per (account, UTC day), so every
 * window is a `SUM` over a contiguous prefix of the SAME primary-key scan. Five
 * `FILTER (WHERE ...)` aggregates read the rows once and cost one comparison each — no
 * extra round trip, no extra index, no second statement. The route already made this call;
 * it now returns five numbers instead of one.
 *
 * ★ SHORTER WINDOWS ARE MORE TRUSTWORTHY THAN THE LONG ONE, WHICH IS THE OPPOSITE OF THE
 * USUAL SHAPE. The feed walk runs NEWEST-FIRST under a clock, so the recent end is always
 * read and the far end is what gets truncated. `all` is a floor until
 * `lumen_hive_walk_cursor.history_complete`; `day` and `week` are exact for anyone whose
 * walk has ever completed a page. The caller decides which windows it may present as
 * measurements by comparing each window's start against `coverage.completeFrom`.
 */
export interface AuthoredWords {
  /** Today, UTC. */
  day: number;
  /** The trailing 7 days, today included. */
  week: number;
  /** The trailing 30 days. */
  month: number;
  /** The 30 days BEFORE that, so the month can be reported as a direction. */
  monthPrior: number;
  /** The trailing 365 days. */
  year: number;
  /** Everything the store holds. A floor until the walk has reached account creation. */
  all: number;
}

export const EMPTY_AUTHORED_WORDS: AuthoredWords = { day: 0, week: 0, month: 0, monthPrior: 0, year: 0, all: 0 };

export async function sumAuthoredWords(hiveAccount: string): Promise<AuthoredWords> {
  const { rows } = await query<{
    d: string | null;
    w: string | null;
    m: string | null;
    mp: string | null;
    y: string | null;
    a: string | null;
  }>(
    // The window boundaries are computed in SQL against the DATABASE's idea of the UTC
    // day, deliberately: the day set stored here was written from UTC day strings, so
    // comparing it against a day derived in the Node process would let the app server's
    // timezone decide what "today" means. That is the exact bug `toDayString` above
    // documents, one layer up.
    `SELECT COALESCE(SUM(words) FILTER (WHERE act_day = (now() AT TIME ZONE 'utc')::date), 0)            AS d,
            COALESCE(SUM(words) FILTER (WHERE act_day > (now() AT TIME ZONE 'utc')::date - 7), 0)        AS w,
            COALESCE(SUM(words) FILTER (WHERE act_day > (now() AT TIME ZONE 'utc')::date - 30), 0)       AS m,
            COALESCE(SUM(words) FILTER (WHERE act_day > (now() AT TIME ZONE 'utc')::date - 60
                                          AND act_day <= (now() AT TIME ZONE 'utc')::date - 30), 0)     AS mp,
            COALESCE(SUM(words) FILTER (WHERE act_day > (now() AT TIME ZONE 'utc')::date - 365), 0)      AS y,
            COALESCE(SUM(words), 0)                                                                     AS a
       FROM lumen_hive_authored_volume
      WHERE hive_account = $1`,
    [hiveAccount]
  );
  const r = rows[0];
  const n = (v: string | null | undefined) => {
    const x = Number(v ?? 0);
    return Number.isFinite(x) ? x : 0;
  };
  return { day: n(r?.d), week: n(r?.w), month: n(r?.m), monthPrior: n(r?.mp), year: n(r?.y), all: n(r?.a) };
}

/**
 * Where this account's lifetime word count sits in the population, as a percentile.
 *
 * ★ ONE GROUPED SCAN OF A TABLE WITH ONE ROW PER (ACCOUNT, DAY). Bounded by the calendar
 * rather than by how prolific anyone is, and the route caches its whole response for five
 * minutes, so this is paid at most once per account per TTL.
 *
 * `null` when the population is too small to place anybody honestly — a percentile over
 * eleven accounts is a ranking, not a statistic, and "you have written more than 90% of
 * Lumen" would mean "more than nine people".
 */
export const PERCENTILE_MIN_POPULATION = 20;

export async function authoredWordsPercentile(words: number): Promise<number | null> {
  if (!(words > 0)) return null;
  const { rows } = await query<{ n: string; below: string }>(
    `WITH totals AS (
       SELECT hive_account, SUM(words) AS w FROM lumen_hive_authored_volume GROUP BY 1
     )
     SELECT (SELECT count(*) FROM totals) AS n,
            (SELECT count(*) FROM totals WHERE w < $1) AS below`,
    [words]
  );
  const n = Number(rows[0]?.n ?? 0);
  const below = Number(rows[0]?.below ?? 0);
  if (!Number.isFinite(n) || n < PERCENTILE_MIN_POPULATION) return null;
  return Math.round((below / n) * 100);
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
    // ★ AS TEXT. This is the read that was one day early on every non-UTC host, and the
    // one whose damage compounded: the route unions these days with a walk that dates its
    // items correctly, so a single day of activity was counted twice. See `toDayString`.
    `SELECT to_char(act_day, 'YYYY-MM-DD') AS act_day
       FROM lumen_hive_act_day
      WHERE hive_account = $1
      ORDER BY act_day ASC`,
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

// ★ THE FREEZE LEDGER IS GONE (2026-08-18, owner: "no freezes. dump that").
//
// `FREEZE_EARNED_PER_ACTIVE_DAYS`, `FREEZE_MAX_HELD`, `FreezeState`, `readFreezeState`
// and `recordFreezeSpent` lived here, backed by `lumen_hive_freeze_spent` (migration
// 0028 §4). Their whole job was to bridge missed days so a single absence did not throw
// away a consecutive-day streak. The streak decays instead of resetting now
// (compute-streak.ts: +1 a day present, -2 a day absent, floored at zero), so there is
// no cliff left to bridge and the mercy has nothing to protect. The table is dropped in
// migration 0037.

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

// ★ THE DAILY GOAL IS GONE (2026-08-18, owner: "no setting of anyhting").
//
// `DAILY_GOAL_MIN/MAX/DEFAULT`, `readDailyGoalFor` and `writeDailyGoalFor` lived here,
// backed by `lumen_retention_goal` (migration 0029 §1) and written through
// `/api/retention/goal`. The goal decided whether TODAY counted toward the streak, which
// is why it had to be server-held at all. The streak no longer has a per-day target: a
// day with any authored act is +1 and a day without one is -2. The route, the API and the
// picker are deleted; the table is dropped in migration 0037.

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
