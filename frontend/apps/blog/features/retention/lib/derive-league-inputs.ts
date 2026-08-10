import { ACTIVITY_SATURATION_DAYS, ACTIVITY_WINDOW_DAYS, type LeagueInputs } from './compute-league';

// Pure derivation of the league keystone inputs from raw chain facts. Kept out of
// the API route so every mapping here is unit-testable without a network call.
//
// HONESTY NOTE (this file is where "chain fact" becomes "ladder input", so the
// approximations live here and nowhere else):
//   - ageDays and activeWeeks are EXACT — account creation date and authored-act
//     days both come straight off chain. `activeWeeks` is exact only as far as the
//     walk actually READ; the route flags a truncated walk as
//     `coverage.activeWeeksIsLowerBound` and the client must render it as a floor.
//   - creditedGivers is MEASURED and SAMPLED — distinct voters over the recent
//     posts the route sampled, after the stake floors and the unknown-tier budget
//     in credited-givers.ts. Sampled, so it is a floor on lifetime breadth; never
//     extrapolated upward.
//
// ★ THERE IS NO PROXY IN THIS FILE ANY MORE (2026-08-09).
//
// It used to own `engagementFromReputation`, REP_FLOOR, REP_CEILING,
// PROXY_BAND_CEILING and the whole MAX_AWARDABLE_* / UNAWARDABLE_TIERS /
// isCeilingLimited apparatus. That apparatus existed for exactly one reason — the
// reputation proxy saturated below the top of the ladder, so three rungs could not
// be awarded to anybody and the UI had to explain why. The proxy is gone
// (compute-league.ts says why at length), so the explanation is gone with it, and
// with it the last thing on this ladder that was not a measurement.

export interface ChainFacts {
  /**
   * Every UTC act-day the route knows about — stored history union this walk's findings.
   * Unfiltered; the observation gate below is applied HERE and only here.
   */
  actDaysUTC: string[];
  /**
   * The UTC day Lumen first started watching this account
   * (`lumen_hive_walk_cursor.first_built_at`), or '' when it has never been recorded.
   */
  firstObservedDayUTC: string;
  nowMs: number; // injected so this stays pure and testable
}

/**
 * Chain facts → the one ladder input.
 *
 * ★★ TWO FILTERS, AND BOTH ARE THE POINT.
 *
 * 1. AT OR AFTER `firstObservedDayUTC`. The route walks up to 26 weeks of Hive history and
 *    stores every act-day it finds, so the raw set hands a long-standing account ~180 days on
 *    its very first request. Counting those is exactly how @gtg, @tarazkp and @lordbutterfly all
 *    measured **Aurora, rank 8 of 9** before doing anything on Lumen. Days before we were
 *    watching happened, and they are shown as stats ("On Hive since 2016", "Shown up on 94+
 *    days") — they just do not buy rank here.
 *
 *    ★ AND AN EMPTY `firstObservedDayUTC` COUNTS NOTHING, rather than counting everything. A
 *    missing cursor means we have no idea when we started watching, and the permissive default
 *    would silently restore the imported-history bug for exactly the accounts whose records are
 *    incomplete. Fail closed: rank 0 until the cursor exists, which the first successful walk
 *    writes.
 *
 * 2. INSIDE THE TRAILING WINDOW. This is the decay, and it needs no separate mechanism: a day
 *    stops counting once it is older than ACTIVITY_WINDOW_DAYS, so going quiet lowers the number
 *    on its own with no penalty event and nothing to notify.
 */
export function deriveLeagueInputs(f: ChainFacts): LeagueInputs {
  const cutoffMs = f.nowMs - ACTIVITY_WINDOW_DAYS * 86_400_000;
  const firstMs = f.firstObservedDayUTC ? Date.parse(`${f.firstObservedDayUTC}T00:00:00Z`) : Number.NaN;
  // No cursor means no observation window, which means nothing observed. See (1) above.
  if (!Number.isFinite(firstMs)) return { observedActDays: 0 };

  const seen = new Set<string>();
  for (const day of f.actDaysUTC) {
    if (!day) continue;
    const ms = Date.parse(`${day}T00:00:00Z`);
    if (!Number.isFinite(ms)) continue;
    if (ms < firstMs) continue;
    if (ms < cutoffMs) continue;
    seen.add(day);
  }
  return { observedActDays: seen.size };
}

/**
 * The arm as a 0..1 fraction of saturation. ONE meter now, because there is one arm.
 *
 * It used to return three (`engagement`, `tenure`, `activeWeeks`) and the profile card rendered
 * all three as percentage bars under "What's actually holding you here" — a wall of abstraction,
 * and the engagement meter was measurably wrong besides. The card has drawn a single bar off
 * `rank.progressToNext` since 2026-08-09, so nothing consumed the other two except dormancy,
 * which now reads the Hive tenure year directly instead of borrowing an arm.
 */
export function deriveGate(inp: LeagueInputs): { activity: number } {
  return { activity: clamp01(inp.observedActDays / ACTIVITY_SATURATION_DAYS) };
}

/** 'YYYY-MM-DD' in UTC from a Hive timestamp string. */
export function utcDay(ts: string): string {
  const withZone = /[zZ]|[+-]\d{2}:\d{2}$/.test(ts) ? ts : `${ts}Z`;
  const d = new Date(withZone);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
