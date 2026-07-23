import type { LeagueInputs } from './compute-league';

// Pure derivation of the league keystone inputs from raw chain facts. Kept out of
// the API route so every mapping here is unit-testable without a network call.
//
// HONESTY NOTE (this file is the place where "chain fact" becomes "score", so the
// approximations live here and nowhere else):
//   - ageDays and activeWeeks are EXACT — account creation date and authored-act
//     days both come straight off chain.
//   - receivedEngagement is a PROXY. The true keystone is stake-weighted received
//     engagement per unit of output, which would require walking every vote on
//     every post. We approximate it with formatted reputation (itself a
//     stake-weighted running total of received approval) blended with observed
//     per-post vote breadth. Documented as a proxy in the API response so no
//     consumer mistakes it for a measured quantity.
//   - distinctGivers is EXACT but SAMPLED — distinct voters over the most recent
//     N posts, not over all history.

export const REP_FLOOR = 25; // a fresh account starts here

/**
 * Top of the reputation band, calibrated against a real sample pulled from
 * api.hive.blog on 2026-07-20 rather than guessed:
 *
 *   taskmaster4450 85.87 · acidyo 84.30 · theycallmedan 79.91 · blocktrades 79.79
 *   lordbutterfly  79.77 · arcange   79.06 · ocdb           77.37 · gtg        76.10
 *   hivebuzz       74.23 · smooth    73.52 · starkerz       72.54 · ned        69.78
 *   techcoderx     67.21
 *
 * The first version used 72, which put every established account at a saturated
 * 1.0 — @lordbutterfly came out at the Lumen apex, which is supposed to be rare.
 * A scale that saturates is a scale that has stopped measuring.
 */
export const REP_CEILING = 88;

/**
 * The apex (Halo / Aurora / Lumen) is NOT reachable from this proxy, by design.
 *
 * Reputation is a stake-weighted running total of received approval — a decent
 * proxy for the engagement keystone, but not a measurement of it. The Celestial
 * band is meant to be population-capped and to require the real per-account
 * signal, so the proxy's output is compressed into the bands below it and tops
 * out inside Beacon. This mirrors the same cap already applied to the byline
 * tier in compute-league.ts, and it is the honest behaviour: a layer that cannot
 * resolve the apex must decline to award it rather than fake the precision.
 */
export const PROXY_BAND_CEILING = 0.79; // just under the Halo threshold (0.8)

/**
 * Formatted Hive reputation (~25 new … ~86 top) → 0..PROXY_BAND_CEILING.
 * Monotonic, saturating, and never negative for the sub-25 accounts that exist
 * after heavy downvoting.
 */
export function engagementFromReputation(formattedRep: number): number {
  const span = REP_CEILING - REP_FLOOR;
  return clamp01((formattedRep - REP_FLOOR) / span) * PROXY_BAND_CEILING;
}

export interface ChainFacts {
  createdISO: string; // account creation timestamp
  formattedReputation: number;
  actDaysUTC: string[]; // days with an authored act (posts + comments)
  activeWeeks: number; // from computeStreak, trailing 26 weeks
  distinctGivers: number; // distinct voters sampled over recent posts
  sampledPosts: number; // how many posts the sample covered
  totalVotesOnSample: number;
  nowMs: number; // injected so this stays pure and testable
}

export function deriveLeagueInputs(f: ChainFacts): LeagueInputs {
  const created = Date.parse(
    // Hive timestamps come back without a zone; they are UTC.
    /[zZ]|[+-]\d{2}:\d{2}$/.test(f.createdISO) ? f.createdISO : `${f.createdISO}Z`
  );
  const ageDays = Number.isFinite(created) ? Math.max(0, Math.floor((f.nowMs - created) / 86_400_000)) : 0;

  // Reputation ALONE is the engagement signal here. An earlier version blended in
  // observed vote breadth, which double-counted: compute-league already gates the
  // raw signal by distinct-giver breadth (`e * (0.4 + 0.6 * breadth)`), so adding
  // breadth here inflated every established account into the apex. One signal,
  // gated once, in the place that owns the gating.
  const receivedEngagement = engagementFromReputation(f.formattedReputation);

  return {
    receivedEngagement,
    distinctGivers: Math.max(0, Math.floor(f.distinctGivers)),
    ageDays,
    activeWeeks: Math.max(0, Math.floor(f.activeWeeks))
  };
}

/** The honest "what's gating your next promotion" meters, each 0..1. */
export function deriveGate(inp: LeagueInputs): { engagement: number; tenure: number; activeWeeks: number } {
  return {
    engagement: clamp01(inp.receivedEngagement),
    tenure: clamp01(inp.ageDays / 730), // 2y saturates, matching tenureBandIdx's apex
    activeWeeks: clamp01(inp.activeWeeks / 26)
  };
}

/** 'YYYY-MM-DD' in UTC from a Hive timestamp string. */
export function utcDay(ts: string): string {
  const withZone = /[zZ]|[+-]\d{2}:\d{2}$/.test(ts) ? ts : `${ts}Z`;
  const d = new Date(withZone);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
