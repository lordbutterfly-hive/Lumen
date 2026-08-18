import { PRESENCE_WINDOW_DAYS, PRESENCE_WINDOW_WEEKS } from './bands';
import type { LiteRetentionResult } from './compute';

/**
 * The wire body for GET /api/lite/retention.
 *
 * Deliberately shaped to be STRUCTURALLY COMPATIBLE with `RetentionSummaryResponse`
 * (features/retention/hooks/use-retention.ts) — same field names, same nesting, same
 * `provenance` block — so `RetentionFacts`, `ProfileLeagueCard` and `LeagueShowcase`
 * render a lite account with no special-casing at all. The one intentional difference
 * is the discriminant: `provenance.source` is `'lumen'`, not `'chain'`. That is exactly
 * what a discriminant is for, and it is the field a consumer must branch on before
 * comparing a lite rung to a chain rung — the two ladders share a vocabulary but not a
 * ruler (see bands.ts), and mixing them in one leaderboard without checking this would
 * be comparing days to years.
 *
 * ★ WHAT THIS PATH CAN HONESTLY CLAIM THAT THE CHAIN PATH CANNOT.
 *
 * The chain route walks Hive feeds backwards under a 20-second wall-clock budget, so
 * its `activeWeeks` is routinely a clock-truncated FLOOR and it must set
 * `coverage.activeWeeksIsLowerBound` to make the UI say "active at least N weeks".
 * This path reads the complete day set out of our own database in one statement. There
 * is no walk, no page cap and no budget, so the number is a MEASUREMENT and
 * `activeWeeksIsLowerBound` is false — the UI prints the exact figure. Likewise
 * `proxied` is empty: the chain path derives engagement from Hive reputation and says
 * so, whereas this one counts the actual distinct people who actually engaged.
 *
 * The one bound that CAN bite here is the giver scan cap, and it gets its own field
 * (`giversAreLowerBound`) rather than being folded into `capped`. `capped` is
 * documented upstream as meaning "history older than what was read was never read",
 * which is never true for us; overloading it to mean something else would quietly
 * flip the honest `activeWeeks` claim above into a dishonest one.
 */

export interface LiteRetentionCoverage {
  /** Weeks, so the shared "N of the last M weeks" copy works unchanged. */
  windowWeeks: number;
  /** The arm's REAL unit at Lumen scale. `windowWeeks` is this, rounded up. */
  windowDays: number;
  /** Distinct active days inside `windowDays` — the value the presence arm read. */
  activeDays: number;
  postsOldestSeen: string;
  commentsOldestSeen: string;
  /** Always false: one query reads the whole history, so nothing is left unread. */
  capped: boolean;
  /** Always false — see the block comment. `activeWeeks` here is exact. */
  activeWeeksIsLowerBound: boolean;
  cappedReason: null;
  commentsFeedUnavailable: boolean;
  /** True when the giver SCAN cap bit, so the giver counts are a lower bound. */
  giversAreLowerBound: boolean;
  /**
   * The whole history is held, so counts derived from it are totals rather than floors.
   * True by construction here — Lumen owns every post a lite account ever made — except
   * when the word-count body scan hits its bound (`WORDS_SCAN_LIMIT`).
   */
  historyComplete: boolean;
}

export interface LiteRetentionSampled {
  /**
   * The RAW count of distinct other people who engaged your posts. This is what the
   * "N people engaged with your posts" sentence means and it is factually true.
   * It is NOT what the ladder scored — see `creditedGivers`.
   */
  distinctGivers: number;
  /**
   * What the engagement arm actually read, after the anti-farm budget in
   * `credit-givers.ts`. Always <= `distinctGivers`. When the two differ, the gap IS
   * the explanation for why the arm moved less than the raw number suggests, and any
   * UI explaining the gate should quote this one.
   */
  creditedGivers: number;
  /** Givers established enough to count one-for-one (7d old, 3 active days). */
  vouchedGivers: number;
  /** Everyone else who engaged you — counted, but only up to `unknownBudget`. */
  unknownGivers: number;
  unknownBudget: number;
  overPosts: number;
  postsScanned: number;
  commentsScanned: number;
}

export interface LiteRetentionProvenance {
  source: 'lumen';
  computedAt: string;
  exact: string[];
  sampled: LiteRetentionSampled;
  coverage: LiteRetentionCoverage;
  /** Empty by construction: nothing on this path stands in for anything else. */
  proxied: Record<string, string>;
}

export interface LiteRetentionResponse {
  ok: true;
  username: string;
  rank: LiteRetentionResult['summary']['rank'];
  gate: LiteRetentionResult['summary']['gate'];
  tenureYear: number;
  streakDays: number;
  activeWeeks: number;
  /**
   * The interesting numbers, in the same shape the chain path serves.
   *
   * ★ ONLY WHAT THIS PATH CAN ACTUALLY MEASURE TODAY. `people` is real (the raw
   * distinct-giver count out of our own tables) and `postsRead` is real. The rest —
   * votes received, posts that landed, first-time givers, reach, weekday pattern,
   * longest run — are all answerable from `lumen_post` / `lumen_vote` /
   * `lumen_feed_served`, but the query in facts-query.ts does not select them yet and
   * inventing them here would be worse than omitting them. A missing field renders no
   * line; a zero renders a false one.
   */
  stats: LiteRetentionResult['summary']['stats'];
  /** Today's authored acts, so the streak card works for a lite account too. */
  today: LiteRetentionResult['summary']['today'];
  provenance: LiteRetentionProvenance;
  /** The three arm positions, so a UI can name the binding arm's actual numbers. */
  arms: LiteRetentionResult['detail']['arms'];
}

export function toLiteRetentionResponse(
  result: LiteRetentionResult,
  nowMs: number = Date.now()
): LiteRetentionResponse {
  const { summary, detail } = result;
  return {
    ok: true,
    username: summary.username,
    rank: summary.rank,
    gate: summary.gate,
    tenureYear: summary.tenureYear,
    streakDays: summary.streakDays,
    activeWeeks: summary.activeWeeks,
    stats: summary.stats,
    today: summary.today,
    provenance: {
      source: 'lumen',
      computedAt: new Date(nowMs).toISOString(),
      // Every one of these is read directly out of our own tables. Nothing is
      // sampled, estimated or proxied, which is the whole reason this path exists.
      exact: [
        'ageDays',
        'tenureYear',
        'activeDays',
        'activeWeeks',
        'streakDays',
        'distinctGivers',
        'postsScanned'
      ],
      sampled: {
        distinctGivers: detail.givers.vouched + detail.givers.unknown,
        creditedGivers: detail.givers.credited,
        vouchedGivers: detail.givers.vouched,
        unknownGivers: detail.givers.unknown,
        unknownBudget: detail.givers.budget,
        overPosts: detail.postCount,
        postsScanned: detail.postCount,
        commentsScanned: 0
      },
      coverage: {
        // THE SAME constant `computeStreak` counted `activeWeeks` over — see
        // PRESENCE_WINDOW_WEEKS. Deriving it a second time here is what let the
        // two drift apart.
        windowWeeks: PRESENCE_WINDOW_WEEKS,
        windowDays: PRESENCE_WINDOW_DAYS,
        activeDays: detail.activeDaysInWindow,
        postsOldestSeen: '',
        commentsOldestSeen: '',
        capped: false,
        activeWeeksIsLowerBound: false,
        cappedReason: null,
        commentsFeedUnavailable: false,
        giversAreLowerBound: detail.giversCapped,
        // ★ TRUE BY CONSTRUCTION ON THIS PATH: Lumen created the account and holds every
        // post it ever made, so there is no unread history for anything to be a floor
        // against. The one exception is a body scan that hit its bound — see
        // `WORDS_SCAN_LIMIT` — which makes the word count (and only the word count) a
        // lower bound, and this is the flag every consumer already reads for that.
        historyComplete: !detail.wordsCapped
      },
      proxied: {}
    },
    arms: detail.arms
  };
}
