'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { LeagueRank, RetentionStats, RetentionToday } from '../types';

// Data source for the retention summary: `/api/streak/[user]`, and nothing else.
//
// TWO LAYERS, TWO OWNERS (the anti-farm invariant, expressed as architecture):
//   - LEAGUE (tier, division, standing, gate meters, tenure, streak, active
//     weeks) is CHAIN-DERIVED and comes from the route. None of it can be
//     self-inflated because none of it is client-supplied.
//   - HABIT (level, XP, daily tasks) was cosmetic and partly forgeable by design
//     ("showed up", "read something"). There is no task ledger, so there was
//     nothing real to serve — the layer was hardcoded constants, IDENTICAL for
//     every user, and it has been removed rather than shown. This hook no longer
//     merges anything into the server's answer.
//
// The old NEXT_PUBLIC_RETENTION_SOURCE toggle is gone. It selected between the
// route and `mockSummary()`, and there is no mock any more; it was also set in no
// env file and absent from the running server's environment, so it had never
// selected anything in the first place.

/** Why a feed walk stopped short of the full window — see the route's CappedReason. */
export type RetentionCappedReason = 'time_budget' | 'call_failed' | 'page_cap';

/**
 * How much history the server actually read.
 *
 * ★ `activeWeeksIsLowerBound` IS LOAD-BEARING FOR THE UI. Render "active at least N
 * weeks" whenever it is true; presenting a truncated figure as a measured one
 * demotes real accounts on the strength of how busy a Hive node happened to be.
 *
 * It is now much rarer than it was. It used to be a synonym for "this request's walk
 * was truncated", which on a 20-second clock meant nearly always — a daily poster
 * since 2018 was routinely served 11 of 26 weeks. Since migration 0028 the server
 * merges every walk it has ever done for the account, and the flag asks the narrower
 * question: does the boundary of the merged set fall INSIDE the window? For a
 * returning reader the answer becomes no, permanently.
 */
export interface RetentionCoverage {
  windowWeeks: number;
  /** ISO timestamp of the oldest post actually read ('' if none). */
  postsOldestSeen: string;
  /** ISO timestamp of the oldest comment actually read ('' if none). */
  commentsOldestSeen: string;
  /** True when history older than `*OldestSeen` was never read. */
  capped: boolean;
  /** True exactly when `capped` — `activeWeeks` is a floor, not a measurement. */
  activeWeeksIsLowerBound: boolean;
  /**
   * `streakDays` is a floor too: the run was still going where the walk stopped
   * reading, so the real streak is at least that long and possibly much longer.
   * SAME RULE AS `activeWeeksIsLowerBound` — render "N+ day streak", never a bare
   * N. Optional: the chain route grew this field on 2026-08-08 and the lumen path
   * never needs it (it reads the whole history in one query).
   */
  streakDaysIsLowerBound?: boolean;
  /** Oldest UTC day from which the merged act-day set is known to be complete. */
  daySetCompleteFrom?: string;
  /** Same boundary, over the STORED union rather than one request's walk. */
  completeFrom?: string;
  /**
   * The account's whole history is stored, so `stats.longestStreakDays` is a
   * measurement. When false it is a floor over the history we happen to hold.
   */
  historyComplete?: boolean;
  /** Which bound bit; null when not capped. Optional: older builds omit it. */
  cappedReason?: RetentionCappedReason | null;
  /** The comments feed failed entirely, so comment-days are missing from the streak. */
  commentsFeedUnavailable: boolean;
  /** LUMEN PATH ONLY — the presence arm's real unit is days, not weeks. */
  windowDays?: number;
  /** LUMEN PATH ONLY — distinct active days inside `windowDays`. */
  activeDays?: number;
  /** LUMEN PATH ONLY — the giver scan cap bit, so giver counts are a floor. */
  giversAreLowerBound?: boolean;
}

/**
 * How the credited giver count was reached.
 *
 * `sampled.distinctGivers` is NOT a raw voter count — it is stake-floored and
 * budgeted, so a swarm of zero-stake accounts cannot buy ladder breadth. This
 * block exposes the split so a low number is explainable to the user ("you have
 * support, but from accounts with no stake behind them") instead of mysterious.
 * Optional: a server predating the 2026-08-08 floors omits it.
 */
export interface RetentionGiverTrust {
  /** Voters with real stake behind the vote — credited in full. */
  established: number;
  /** Voters above the dust floor but below the established bar. */
  unknown: number;
  /** How many of `unknown` the budget actually credited. */
  unknownCredited: number;
  /** Distinct voters rejected as dust — includes zero-stake votes and downvotes. */
  dustRejected: number;
  /** The author's own vote, dropped before any of the above. Optional: newer field. */
  selfExcluded?: number;
  minRshares: number;
  establishedMinRshares: number;
}

/**
 * How many DISTINCT PEOPLE really upvoted, on either path — the quantity the
 * "N people have engaged with your posts" sentence is about, which is NOT the
 * same as the number the ladder scored. See retention-facts.tsx.
 */
export function headcountOfGivers(provenance: RetentionProvenance | undefined): number | undefined {
  if (!provenance) return undefined;
  if (provenance.source === 'lumen') return provenance.sampled?.distinctGivers;
  const trust = provenance.giverTrust;
  return trust ? trust.established + trust.unknown : provenance.sampled?.distinctGivers;
}

/**
 * How many of those people the LADDER actually counted — the trust-weighted
 * subset, which is a smaller number than the headcount above and a different
 * quantity from it.
 *
 * ★ BOTH NUMBERS, OR NEITHER (found by a UX tester, 2026-08-08). The headcount was
 * printed directly above the promotion gauge, which is driven by this one, with
 * nothing saying they were two different measurements. A reader who checks the
 * arithmetic gets an exact mismatch on every account — measured live:
 *
 *   blocktrades  1564 shown  ·  1111 counted        acidyo  683  ·  543
 *   steevc        397 shown  ·   290 counted        arcange 484  ·  373
 *
 * Both figures are honest (established + min(unknown, 15) is the anti-farm bound,
 * see credited-givers.ts) and the presentation was not: it invited exactly the
 * conclusion that the page inflates. Printing the smaller number under the word
 * "people" is NOT the fix — that was the earlier bug, a trust-weighted score
 * wearing a headcount's sentence. The fix is to say both and say which is which.
 */
export function creditedOfGivers(provenance: RetentionProvenance | undefined): number | undefined {
  if (!provenance) return undefined;
  if (provenance.source === 'lumen') {
    return provenance.sampled?.creditedGivers ?? provenance.sampled?.distinctGivers;
  }
  // The chain route puts `givers.credited` in this field and says so — it is the
  // figure `deriveLeagueInputs` scored, not a headcount.
  return provenance.sampled?.distinctGivers;
}

/**
 * How many posts the giver figures were actually read from.
 *
 * ★ NOT `postsScanned` (found while checking the footnote, 2026-08-08).
 * `postsScanned` is the depth of the FEED WALK — the input to active-weeks and the
 * streak — while votes are read from `overPosts` posts only (VOTE_SAMPLE_POSTS = 3
 * on the chain path, a bounded cost on a route that already truncates itself).
 * The footnote said "Counted across your last 160 posts" to @acidyo when the
 * people-count came from three. Same class of error as `activeWeeksIsLowerBound`:
 * a number presented tighter than it really is, is a lie with better typography.
 *
 * The Lumen path sets both fields to the same post count (it reads the whole
 * history in one query), so this changes nothing there.
 */
export function postsBehindGivers(provenance: RetentionProvenance | undefined): number | undefined {
  if (!provenance) return undefined;
  const over = provenance.sampled?.overPosts;
  return typeof over === 'number' && over > 0 ? over : provenance.sampled?.postsScanned;
}

/**
 * Which ladder computed this answer. THE DISCRIMINANT — branch on it before
 * printing anything that names a chain ("On Hive since…", "Time on Hive"), or
 * before comparing a lite rung to a chain rung. The two ladders share a
 * vocabulary but not a ruler (lib/lite/retention/bands.ts), and only the chain
 * one carries the reputation-proxy ceiling (lib/derive-league-inputs.ts).
 */
export type RetentionSource = 'chain' | 'lumen';

/** Honesty metadata — how solid each number in the body is. */
export interface RetentionProvenance {
  source: RetentionSource;
  computedAt: string;
  /** Field names that are exact chain facts rather than samples or proxies. */
  exact: string[];
  sampled: {
    /** The CREDITED giver count — see `giverTrust`, not a raw voter tally. */
    distinctGivers: number;
    overPosts: number;
    postsScanned: number;
    commentsScanned: number;
    /** LUMEN PATH ONLY — what the arm read after the anti-farm budget. */
    creditedGivers?: number;
    vouchedGivers?: number;
    unknownGivers?: number;
    unknownBudget?: number;
  };
  giverTrust?: RetentionGiverTrust;
  coverage: RetentionCoverage;
  /**
   * Human-readable notes on numbers that stand in for something else. EMPTY on
   * the lumen path by construction — nothing there proxies for anything — so
   * every member is optional.
   */
  proxied: {
    /** Gone since 2026-08-09: the engagement arm is measured, not proxied. */
    receivedEngagement?: string;
    streakDays?: string;
    distinctGivers?: string;
    newPeople?: string;
  };
}

/**
 * The route's 200 body, verbatim. This is the wire contract — the hook reshapes
 * nothing, so what a component reads here is exactly what the server computed.
 */
export interface RetentionSummaryResponse {
  username: string;
  rank: LeagueRank;
  /** Promotion-gate meters, each 0..1. */
  /** ONE meter now: the activity arm as a 0..1 fraction. The other two arms are deleted. */
  gate: { activity: number };
  tenureYear: number;
  streakDays: number;
  /** A LOWER bound whenever `provenance.coverage.activeWeeksIsLowerBound`. */
  activeWeeks: number;
  /**
   * The interesting numbers. Optional because a server predating 2026-08-09 omits
   * the block entirely, and because individual fields are ABSENT rather than zero
   * when they cannot be stated honestly — read every one of them with a
   * `typeof === 'number'` guard, never with `?? 0`. A zero here is a claim.
   */
  stats?: RetentionStats;
  /** The daily loop. Optional: a server predating 2026-08-09 omits it. */
  today?: RetentionToday;
  provenance: RetentionProvenance;
}

async function fetchRetention(username: string): Promise<RetentionSummaryResponse> {
  const res = await fetch(`/api/streak/${encodeURIComponent(username)}`);
  if (!res.ok) throw new Error(`retention fetch failed: ${res.status}`);
  return (await res.json()) as RetentionSummaryResponse;
}

/**
 * ★ A LUMEN LITE ACCOUNT HAS NO CHAIN TENURE, SO THERE IS NOTHING TO ASK FOR.
 *
 * `/api/streak/[user]` derives rank, streak and active weeks from the CHAIN, and
 * answers `404 account not found` for a name that has no Hive account. Four of
 * six UX testers independently noticed it firing — and failing — on essentially
 * every page load, with no streak UI anywhere on screen to show for it. The
 * consumers already render nothing without data, so the only thing the call was
 * producing was load: this is the route that was once measured taking 639
 * seconds, and it was being issued for readers it can never answer.
 *
 * `chainAccount` defaults to true so existing callers keep their behaviour; the
 * profile passes the account's real tier.
 */
export function useRetention(
  username: string,
  chainAccount = true
): UseQueryResult<RetentionSummaryResponse> {
  return useQuery({
    queryKey: ['retention', username],
    queryFn: () => fetchRetention(username),
    enabled: Boolean(username) && chainAccount,
    staleTime: 5 * 60 * 1000,
    // On a failed chain read we deliberately do NOT substitute anything: the
    // consumers all render null without data, so the block disappears rather
    // than showing a fabricated tier. A wrong status is worse than no status.
    //
    // ★ retry 1 → 0 (2026-08-11). The route's own cache never stores a failure (FAIL
    // LOUD — see the route's docs), so a retry on a 502 does not "try again cheaply", it
    // re-pays the ENTIRE upstream fan-out a second time against upstream that measurably
    // 502s and runs 1-6s per call. That doubled exactly the cost of the requests that were
    // already struggling, for a widget that renders nothing differently whether the first
    // or the second attempt is the one that eventually fails. The route's own
    // stale-while-revalidate layer (streak-cache.ts) is what should absorb a transient
    // upstream miss, not a client-side retry against the same flaky call.
    retry: 0
  });
}
