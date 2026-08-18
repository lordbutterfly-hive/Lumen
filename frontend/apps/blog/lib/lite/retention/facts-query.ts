import { query } from '../db/pool';
import {
  GIVER_SCAN_LIMIT,
  VOUCHED_MIN_ACTIVE_DAYS,
  VOUCHED_MIN_AGE_DAYS
} from './credit-givers';
import { PRESENCE_WINDOW_DAYS } from './bands';
// Cross-lane on purpose: the arm's window and the ladder's own rank-9 threshold must agree,
// or the two drift the way PRESENCE_WINDOW_DAYS and this arm did — see the header comment
// below, and ladder.test.ts §11b.
import { ACTIVITY_WINDOW_DAYS } from '@/blog/features/retention/lib/compute-league';
// Cross-lane on purpose, and load-bearing: ONE word-count implementation serves both
// ladders. See `RetentionFacts.wordsWritten`.
import { countWords } from '@/blog/features/retention/lib/act-stats';
import type { AuthoredWords } from '@/blog/lib/lite/repositories/hive-retention-repository';

/**
 * The read behind the Lumen-native league. No chain call, no N+1 — every arm is a CTE
 * over an index added in migration 0025.
 *
 * ★ TWO STATEMENTS SINCE 2026-08-18, NOT ONE. The second reads post BODIES for the
 * word-count stat, because counting words in SQL would fork the rule that the chain path
 * already owns in TypeScript. See `loadWordCount` for the trade and the bound.
 *
 * WHAT IT ANSWERS, and from where:
 *   tenure     <- lumen_user.created_at
 *   act days   <- distinct UTC days with a row in lumen_post / lumen_vote / lumen_reblog
 *                 / lumen_follow, returned UNWINDOWED as day strings so the PURE
 *                 `computeStreak` does the streak and active-week arithmetic (this module
 *                 deliberately does none of it)
 *   engagement <- distinct OTHER users who voted / reblogged / replied to my posts,
 *                 split into vouched vs unknown so `creditGivers` can budget them
 *
 * ★ TWO WINDOWED COUNTS OVER THE SAME `my_days` SET, FOR TWO DIFFERENT JOBS (fixed 2026-08-11).
 * `active_days_in_window` (windowed on PRESENCE_WINDOW_DAYS, 60) is the "active N of the last
 * M days" PRESENCE stat — a UI number, nothing ranks on it.
 * `active_days_in_activity_window` (windowed on ACTIVITY_WINDOW_DAYS, 365) is what
 * `bands.ts`'s `activityArmPosition` actually ranks on. They used to be the SAME column,
 * windowed on PRESENCE_WINDOW_DAYS alone — so the arm could never see past 60 days, and since
 * the ladder's rank-9 threshold is 260 days, ranks 5 through 9 were unawardable to any lite
 * account by any behaviour whatsoever. `compute.ts` now reads `activeDaysInActivityWindow`
 * for the arm and `activeDaysInWindow` for the presence stat; do not let them collapse back
 * into one field.
 *
 * ★ TWO THINGS IN HERE ARE NOT OBVIOUS AND WERE MEASURED, NOT ASSUMED.
 *
 * 1. THE PERMLINK JOIN. Received engagement does NOT reliably join on
 *    (hive_author, hive_permlink). A Lumen post has two names — the local placeholder
 *    `lite-<ulid>` and the broadcast `lumen-<ulid>` — and engagement captures whichever
 *    was on screen, with `target_author` sometimes the publisher account and sometimes
 *    the lite display name. On the live QA database the (hive_author, hive_permlink)
 *    join finds 1 of the 6 authors who have actually received engagement; resolving the
 *    permlink to its ULID via `lumen_permlink_post_id` finds all 6. Migration 0025 adds
 *    the function and the expression indexes that make it a primary-key lookup.
 *
 * 2. VOTE DAYS COME FROM `first_cast_at`, NOT `updated_at`. `updated_at` is bumped by
 *    every re-vote, so it both loses the day the vote was really cast and would let one
 *    toggled vote tick a streak daily forever. Migration 0025 adds the immutable column
 *    and a trigger that pins it. Rows written before that migration carry the backfilled
 *    estimate, which is exact for every vote never re-cast.
 *
 * Only UPVOTES count as received engagement (`weight > 0`): a downvote is engagement in
 * the literal sense and the opposite of it in every sense that matters. Retracted votes
 * and reblogs (`active = false`), deleted posts and replies, and suspended or banned
 * givers are all excluded.
 */

export interface RetentionFacts {
  createdAt: Date;
  /** 'YYYY-MM-DD' UTC days on which this user did something. Feeds `computeStreak`. */
  actDaysUTC: string[];
  /**
   * Distinct active days inside the trailing PRESENCE_WINDOW_DAYS (60). This is the "active N
   * of the last M days" UI stat only — NOT what the ladder ranks on. See
   * `activeDaysInActivityWindow` for that.
   */
  activeDaysInWindow: number;
  /**
   * Distinct active days inside the trailing ACTIVITY_WINDOW_DAYS (365) — the value
   * `bands.ts`'s `activityArmPosition` actually reads. Deliberately a SEPARATE field from
   * `activeDaysInWindow` above: the two windows measure different spans for different
   * consumers, and sharing one column was the bug that made ranks 5-9 unreachable
   * (fixed 2026-08-11).
   */
  activeDaysInActivityWindow: number;
  /** Distinct OTHER users who engaged this user's posts, split for the budget. */
  vouchedGivers: number;
  unknownGivers: number;
  /** True when GIVER_SCAN_LIMIT bit, so the giver counts are a lower bound. */
  giversCapped: boolean;
  postCount: number;
  /**
   * Words this user has written, over the same five windows the chain path serves.
   *
   * ★ COUNTED IN TYPESCRIPT, NOT IN SQL, AND THAT IS THE WHOLE POINT. The chain path
   * counts words with `act-stats.ts:countWords` (markdown furniture, code blocks, image
   * markup and raw URLs stripped first). A `regexp_split_to_array(body, '\s+')` here
   * would be a SECOND implementation of the same number, and the two would disagree on
   * every post containing a code fence — which is exactly the "two numbers, both
   * defensible, one of them wrong on screen" class this feature keeps having to fix. One
   * function, both paths.
   *
   * The WINDOWING is done here in TS as well, off each row's `created_at`, for the same
   * reason: the bucket boundaries have to agree with the chain path's, and they are
   * cheaper to keep in one place than to mirror in two dialects.
   */
  wordsWritten: AuthoredWords;
  /** The body scan hit `WORDS_SCAN_LIMIT`, so `wordsWritten` is a lower bound. */
  wordsCapped: boolean;
}

interface FactsRow {
  created_at: Date;
  act_days: string[] | null;
  active_days_in_window: string;
  active_days_in_activity_window: string;
  vouched_givers: string;
  unknown_givers: string;
  scanned_givers: string;
  post_count: string;
}

// $1 user_id · $2 presence window days · $3 giver scan limit
// $4 vouched min age days · $5 vouched min active days · $6 activity (arm) window days
const SQL = `
WITH me AS (
  SELECT user_id, created_at FROM lumen_user WHERE user_id = $1
),
-- My posts that are eligible to EARN rank from engagement. Deliberately the same
-- predicate the rest of the codebase uses for "a post you may engage with"
-- (content/engagement-target.ts: feedVisibility === 'visible' && !deletedLocally), not
-- a looser one invented here. Engagement received on content that moderation removed
-- must not buy rank, and one definition of "servable" is better than two.
mine AS (
  SELECT post_id FROM lumen_post
   WHERE user_id = $1 AND deleted_locally = false AND feed_visibility = 'visible'
),
-- Every UTC day on which I acted, from all four act tables.
--
-- Deliberately NOT filtered by visibility or deletion, unlike "mine" above. Presence
-- measures "did you show up", and a post that was later hidden or that you later
-- deleted was still written on the day it was written; moderation is not a retroactive
-- edit of your history. The account-level lever for a bad actor is "status"
-- (suspended/banned), which stops them acting at all — silently rewriting their
-- calendar is not a second, quieter version of that.
my_days AS (
          SELECT (created_at    AT TIME ZONE 'UTC')::date AS d FROM lumen_post   WHERE user_id           = $1
  UNION   SELECT (first_cast_at AT TIME ZONE 'UTC')::date      FROM lumen_vote   WHERE voter_user_id     = $1
  UNION   SELECT (created_at    AT TIME ZONE 'UTC')::date      FROM lumen_reblog WHERE reblogger_user_id = $1
  UNION   SELECT (created_at    AT TIME ZONE 'UTC')::date      FROM lumen_follow WHERE follower_user_id  = $1
),
-- Distinct OTHER users who engaged my posts. UNION (not UNION ALL) is what makes this
-- a DISTINCT-GIVER count: one person voting on ten of my posts is one giver, exactly as
-- one person replying ten times is one giver.
raw_givers AS (
          SELECT v.voter_user_id AS giver
            FROM lumen_vote v
            JOIN mine m ON m.post_id = lumen_permlink_post_id(v.target_permlink)
           WHERE v.active AND v.weight > 0 AND v.voter_user_id <> $1
  UNION   SELECT r.reblogger_user_id
            FROM lumen_reblog r
            JOIN mine m ON m.post_id = lumen_permlink_post_id(r.target_permlink)
           WHERE r.active AND r.reblogger_user_id <> $1
  UNION   SELECT c.user_id
            FROM lumen_post c
            JOIN mine m ON m.post_id = lumen_permlink_post_id(c.parent_ref ->> 'permlink')
           WHERE c.parent_ref IS NOT NULL AND c.deleted_locally = false
             AND c.feed_visibility = 'visible' AND c.user_id <> $1
),
-- Bounded and deterministic: ORDER BY before LIMIT so the same account always yields
-- the same answer even when the cap bites.
givers AS (
  SELECT giver FROM raw_givers ORDER BY giver LIMIT $3
),
-- Each giver's own distinct active days — the second half of the vouched test.
giver_days AS (
  SELECT g.giver, count(*) AS days
    FROM givers g
    CROSS JOIN LATERAL (
              SELECT (created_at    AT TIME ZONE 'UTC')::date AS d FROM lumen_post   WHERE user_id           = g.giver
      UNION   SELECT (first_cast_at AT TIME ZONE 'UTC')::date      FROM lumen_vote   WHERE voter_user_id     = g.giver
      UNION   SELECT (created_at    AT TIME ZONE 'UTC')::date      FROM lumen_reblog WHERE reblogger_user_id = g.giver
      UNION   SELECT (created_at    AT TIME ZONE 'UTC')::date      FROM lumen_follow WHERE follower_user_id  = g.giver
    ) x
   GROUP BY g.giver
),
-- A giver counts in full only if they are themselves established; everyone else is
-- 'unknown' and gets budgeted by creditGivers(). Suspended/banned givers count as
-- nothing at all.
classified AS (
  SELECT (u.created_at <= now() - make_interval(days => $4::int)
          AND COALESCE(gd.days, 0) >= $5::int) AS vouched
    FROM givers g
    JOIN lumen_user u ON u.user_id = g.giver
    LEFT JOIN giver_days gd ON gd.giver = g.giver
   WHERE u.status IN ('active', 'upgraded')
)
SELECT (SELECT created_at FROM me)                                        AS created_at,
       (SELECT array_agg(d::text ORDER BY d) FROM my_days)                AS act_days,
       (SELECT count(*) FROM my_days
         WHERE d > (now() AT TIME ZONE 'UTC')::date - $2::int)            AS active_days_in_window,
       -- The ARM's own count, over the wider ACTIVITY_WINDOW_DAYS ($6) — see the header
       -- comment. Same my_days set, different span, kept as its own column on purpose.
       (SELECT count(*) FROM my_days
         WHERE d > (now() AT TIME ZONE 'UTC')::date - $6::int)            AS active_days_in_activity_window,
       (SELECT count(*) FROM classified WHERE vouched)                    AS vouched_givers,
       (SELECT count(*) FROM classified WHERE NOT vouched)                AS unknown_givers,
       (SELECT count(*) FROM givers)                                      AS scanned_givers,
       (SELECT count(*) FROM mine)                                        AS post_count
`;

/**
 * How many of a user's most recent bodies the word count reads.
 *
 * Lumen is weeks old and the busiest lite account has tens of posts, so this bites
 * nothing today — it exists so the query stays bounded when that stops being true.
 * When it does bite, `wordsCapped` makes the figure render as "at least N", which is the
 * same floor phrasing the chain path already uses for a truncated walk.
 */
export const WORDS_SCAN_LIMIT = 2000;

/**
 * Total words, from the bodies themselves.
 *
 * ★ A SECOND STATEMENT, AND THE ROUTE'S "ONE ROUND TRIP" CLAIM IS UPDATED RATHER THAN
 * QUIETLY BROKEN (see the header). It could not be folded into the statement above
 * without either shipping every body as an aggregated array column (the same bytes, one
 * fewer round trip, far worse to read) or counting words in SQL, which would fork the
 * word-count rule in two. It is one index scan on `ix_lumen_post_user_created` and it is
 * ordered newest-first so the cap, if it ever bites, drops the OLDEST posts — a floor
 * that grows the right way.
 */
async function loadWordCount(
  userId: string,
  nowMs: number
): Promise<{ words: AuthoredWords; capped: boolean }> {
  const { rows } = await query<{ body: string | null; created_at: Date | null }>(
    `SELECT body, created_at FROM lumen_post
      WHERE user_id = $1 AND body <> ''
      ORDER BY post_id DESC
      LIMIT $2`,
    [userId, WORDS_SCAN_LIMIT]
  );
  const words: AuthoredWords = { day: 0, week: 0, month: 0, monthPrior: 0, year: 0, all: 0 };
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const startOf = (days: number) => new Date(nowMs - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const d1 = today;
  const d7 = startOf(7);
  const d30 = startOf(30);
  const d365 = startOf(365);
  const d60 = startOf(60);
  for (const row of rows) {
    const n = countWords(row.body ?? '');
    if (n <= 0) continue;
    words.all += n;
    // `created_at` is a timestamptz, so `toISOString` is the true UTC day — unlike a bare
    // DATE column, which node-postgres parses at LOCAL midnight (see
    // hive-retention-repository.ts:toDayString for the day-shift that caused).
    const day = row.created_at ? row.created_at.toISOString().slice(0, 10) : '';
    if (!day) continue;
    if (day >= d365) words.year += n;
    if (day >= d30) words.month += n;
    else if (day >= d60) words.monthPrior += n;
    if (day >= d7) words.week += n;
    if (day === d1) words.day += n;
  }
  return { words, capped: rows.length >= WORDS_SCAN_LIMIT };
}

export async function loadRetentionFacts(
  userId: string,
  nowMs: number = Date.now()
): Promise<RetentionFacts | null> {
  const { rows } = await query<FactsRow>(SQL, [
    userId,
    PRESENCE_WINDOW_DAYS,
    GIVER_SCAN_LIMIT,
    VOUCHED_MIN_AGE_DAYS,
    VOUCHED_MIN_ACTIVE_DAYS,
    ACTIVITY_WINDOW_DAYS
  ]);
  const row = rows[0];
  if (!row || !row.created_at) return null;

  // Only once the user is known to exist — a missing row above returns before this, so a
  // bad user id costs one query rather than two.
  const volume = await loadWordCount(userId, nowMs);

  const scanned = Number(row.scanned_givers);
  return {
    createdAt: row.created_at,
    actDaysUTC: row.act_days ?? [],
    activeDaysInWindow: Number(row.active_days_in_window),
    activeDaysInActivityWindow: Number(row.active_days_in_activity_window),
    vouchedGivers: Number(row.vouched_givers),
    unknownGivers: Number(row.unknown_givers),
    giversCapped: scanned >= GIVER_SCAN_LIMIT,
    postCount: Number(row.post_count),
    wordsWritten: volume.words,
    wordsCapped: volume.capped
  };
}

/**
 * The statement itself, so an operator can EXPLAIN it or sweep it across the whole
 * table without copying it into a second place that can then drift. Parameters, in
 * order: user_id, presence window days, giver scan limit, vouched min age days,
 * vouched min active days, activity (arm) window days.
 */
export const RETENTION_FACTS_SQL = SQL;
