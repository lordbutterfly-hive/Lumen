import { computeStreak } from '@/blog/features/retention/lib/compute-streak';
import { MAX_TIER_INDEX, TIERS, TIER_ORDER, TOTAL_RANKS, nextTier } from '@/blog/features/retention/lib/tiers';
import type { LeagueRank, RetentionSummary } from '@/blog/features/retention/types';
import { PRESENCE_WINDOW_WEEKS, activityArmPosition, type ArmPosition } from './bands';
import { creditGivers, type GiverCredit } from './credit-givers';
import type { RetentionFacts } from './facts-query';

/**
 * Facts from Postgres -> the same `LeagueRank` the chain path returns.
 *
 * This is the ONLY place the Lumen-native numbers become a rank, and it mirrors
 * `computeLeague` step for step: three arm positions, weakest one wins, ties broken by
 * least progress, `standing` as the weighted composite. Nothing here re-derives the
 * ladder — the tier vocabulary, rung numbers, emblem rule and `nextTier` all come from
 * `features/retention/lib/tiers.ts`, so a change to the ladder reaches lite accounts
 * without a second edit.
 *
 * WHAT DIFFERS FROM THE CHAIN PATH, and why each difference is an improvement rather
 * than a compromise:
 *
 *   * The rulers are Lumen-scaled (`bands.ts`) — the chain rulers cannot resolve a
 *     population whose oldest member is 48 hours old.
 *   * ★ ENGAGEMENT IS MEASURED, NOT PROXIED — AND THE CHAIN PATH HAS NOW COPIED THIS
 *     (2026-08-09). This note used to read "the chain path derives engagement from Hive
 *     reputation and is therefore ceiling-limited". It no longer does: the argument
 *     made here won, the proxy and its whole ceiling apparatus were deleted, and both
 *     ladders now count real distinct people who really engaged real posts. What
 *     remains different is only the RULER (see bands.ts) — the chain arm wants ~40
 *     credited givers for the public mark against Lumen's 2, because Hive has years of
 *     accounts and Lumen is weeks old.
 *   * The engagement arm is bounded HARDER (`credit-givers.ts`), because on Lumen a
 *     giver costs one captcha and on Hive it costs an account. compute-league.ts's own
 *     `distinctGivers` docstring flags exactly this gap as unfixed on the chain side
 *     ("~80 throwaway accounts buy the full breadth multiplier ... the floor belongs
 *     where the voters are read"). This is that floor, on the side that owns the reads.
 */

export interface LiteRetentionResult {
  summary: RetentionSummary;
  /** The honest measurement detail behind the rank — surfaced for the UI and for ops. */
  detail: {
    ageDays: number;
    activeDaysInWindow: number;
    postCount: number;
    /** The body scan hit its bound, so `stats.wordsWritten` is a floor. */
    wordsCapped: boolean;
    givers: GiverCredit;
    /** True when the giver scan hit its cost cap, so giver counts are a lower bound. */
    giversCapped: boolean;
    /** One arm now — see bands.ts. Kept as an object so the detail shape stays stable. */
    arms: { activity: ArmPosition };
  };
}

/** 'YYYY-MM-DD' in UTC. */
function utcDayString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

export function computeLiteRetention(
  username: string,
  facts: RetentionFacts,
  nowMs: number = Date.now()
): LiteRetentionResult {
  const createdMs = facts.createdAt.getTime();
  const ageDays = Number.isFinite(createdMs)
    ? Math.max(0, Math.floor((nowMs - createdMs) / 86_400_000))
    : 0;

  // The streak and active-weeks numbers come from the PURE, shared implementation.
  // `windowWeeks` is the Lumen presence window, NOT the chain ladder's 26 — the
  // wire reports the same constant as `coverage.windowWeeks`, and the shared UI
  // copy prints "active {activeWeeks} of the last {windowWeeks} weeks". Passing
  // it here is what stops those two numbers from being measured over different
  // spans (see PRESENCE_WINDOW_WEEKS in bands.ts).
  // ★ NO `countFromUTC` AND NO `observedFromUTC` ON THIS PATH, AND THAT IS EXACT RATHER
  // THAN SLOPPY. Lumen created this account, so it observed every day of its life: the
  // day set has no holes and the decay's zero start IS the account's first day. The
  // chain path has to pass both because a Hive account existed before Lumen saw it and
  // its walk can leave gaps.
  const streak = computeStreak({
    actDaysUTC: facts.actDaysUTC,
    todayUTC: utcDayString(nowMs),
    windowWeeks: PRESENCE_WINDOW_WEEKS
  });

  const givers = creditGivers(facts.vouchedGivers, facts.unknownGivers);

  // ★ ONE ARM, SHARED WITH THE CHAIN LADDER. A lite account's every day was observed by Lumen
  // (Lumen created it), so its day count needs no `first_built_at` gate — see bands.ts.
  //
  // ★ READS `activeDaysInActivityWindow`, NOT `activeDaysInWindow` (fixed 2026-08-11). The
  // latter is windowed to PRESENCE_WINDOW_DAYS (60) for the "active N of the last M days"
  // presence stat below; the ladder's rank-9 threshold is 260 days, so feeding the arm that
  // 60-day figure made ranks 5-9 unawardable to any lite account by any behaviour whatsoever.
  // See facts-query.ts's header comment for where the two counts come from.
  const arms = { activity: activityArmPosition(facts.activeDaysInActivityWindow) };

  // One arm, so there is nothing to take a MIN of and nothing to tie with — the same
  // simplification `computeLeague` got. The rule the two paths share is now the arm itself.
  const binding = arms.activity;
  const idx = Math.max(0, Math.min(MAX_TIER_INDEX, binding.index));
  const tier = TIER_ORDER[idx];
  const info = TIERS[tier];


  const rank: LeagueRank = {
    tier,
    rankNumber: info.order,
    totalRanks: TOTAL_RANKS,
    showBylineEmblem: info.showBylineEmblem,
    bindingArm: binding.arm,
    progressToNext: binding.progress,
    remainingToNext: binding.remaining,
    armUnit: binding.unit,
    nextTierGuaranteed: binding.remaining !== null,
    nextTier: nextTier(tier)
  };

  return {
    summary: {
      username,
      rank,
      streakDays: streak.streakDays,
      activeWeeks: streak.activeWeeks,
      tenureYear: new Date(createdMs).getUTCFullYear(),
      // One meter, matching the one arm. It was three (engagement/tenure/activeWeeks) and the
      // other two measured things that no longer buy a rank.
      gate: { activity: arms.activity.progress === 1 ? 1 : clamp01(arms.activity.index / MAX_TIER_INDEX) },
      // ★ ONLY WHAT THIS PATH REALLY MEASURES. `people` is the RAW distinct-giver
      // count, never the budgeted one: the budget is a score and does not get to wear
      // the word "people". Everything else the chain path serves (first-time givers,
      // reach, weekday pattern, longest run) is answerable from our own tables but is
      // not selected by facts-query.ts yet, and an absent field renders no line while
      // a zero renders a false one.
      //
      // ★ `postsRead` IS GONE FROM THE TYPE (2026-08-09). It fed "N of M posts got
      // engagement", which is deleted along with every other vote-amount line: "vote
      // amounts dont matter, theyre all botted", and a windowed count of votes or comments
      // may not be printed unless it is all-time. `peopleOverPosts` replaces it as the
      // SCOPE of the headcount rather than a stat of its own — and on this path the answer
      // is every post the account has, which is why the copy branches on
      // `provenance.source` to say "all N posts" instead of "the last N".
      stats: {
        people: givers.vouched + givers.unknown,
        peopleOverPosts: facts.postCount,
        // ★ ALL-TIME AND EXACT ON THIS PATH (unless the body scan capped — see
        // `wordsCapped`, which the wire turns into `coverage.historyComplete: false`).
        // Lumen holds every post a lite account ever wrote, so there is no walk to
        // truncate and no window to caveat. ABSENT rather than zero when there is
        // nothing: a "0 words" line would tell somebody who has just joined that they
        // have written nothing, which is true and unkind and not worth a line.
        ...(facts.wordsWritten.all > 0 ? { wordsWritten: facts.wordsWritten } : {})
      },
      today: {
        // Authored acts today, from the same day set the streak uses. Posts and
        // comments only, matching the chain path — one currency on both sides.
        acts: facts.actDaysUTC.filter((d) => d === utcDayString(nowMs)).length
      }
    },
    detail: {
      ageDays,
      wordsCapped: facts.wordsCapped,
      activeDaysInWindow: facts.activeDaysInWindow,
      postCount: facts.postCount,
      givers,
      giversCapped: facts.giversCapped,
      arms
    }
  };
}
