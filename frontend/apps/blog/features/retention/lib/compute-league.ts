import { Division, LeagueRank, LeagueTier } from '../types';
import { TIERS, TIER_ORDER } from './tiers';

// The keystone-gated league computation — the anti-farm heart of the system.
//
// The visible tier is the MINIMUM of three independent keystone arms:
//   - received stake-weighted engagement (breadth of DISTINCT established givers),
//   - account tenure (uncompressible calendar time),
//   - rolling active-weeks (sustained presence, the decay/demotion driver).
// You cannot rise past your weakest arm, so a high-emission bot with no real
// received engagement / thin tenure is pinned to the floor forever. EXP, tasks,
// and streak length are NOT inputs here (anti-farm invariant AF-1). Thresholds
// are illustrative — calibrate on real percentile data before launch.

export interface LeagueInputs {
  receivedEngagement: number; // 0..1, stake-weighted, per-giver-capped
  distinctGivers: number; // distinct ESTABLISHED accounts who engaged you (diversity ⇒ sybil resistance)
  ageDays: number;
  activeWeeks: number; // rolling active-weeks of trailing 26
}

function tenureBandIdx(ageDays: number): number {
  if (ageDays < 14) return 0; // Ember
  if (ageDays < 30) return 1; // Spark
  if (ageDays < 90) return 2; // Candle
  if (ageDays < 180) return 3; // Torch
  if (ageDays < 365) return 4; // Lantern
  if (ageDays < 730) return 5; // Beacon
  return 8; // tenure alone never caps below apex once >= 2y
}

function activeWeeksBandIdx(activeWeeks: number): number {
  if (activeWeeks < 1) return 0;
  if (activeWeeks < 3) return 1;
  if (activeWeeks < 6) return 2;
  if (activeWeeks < 10) return 3;
  if (activeWeeks < 16) return 4;
  if (activeWeeks < 22) return 5;
  return 8;
}

function engagementBandIdx(receivedEngagement: number, distinctGivers: number): number {
  // Breadth of distinct established givers gates the raw signal — one whale or one
  // sockpuppet ring cannot crown you; you need many real accounts to value you.
  const breadth = Math.min(distinctGivers / 80, 1); // ~80 distinct givers ≈ full breadth
  const e = receivedEngagement * (0.4 + 0.6 * breadth);
  if (e < 0.05) return 0;
  if (e < 0.15) return 1;
  if (e < 0.3) return 2;
  if (e < 0.45) return 3;
  if (e < 0.62) return 4;
  if (e < 0.8) return 5;
  if (e < 0.9) return 6; // Halo
  if (e < 0.97) return 7; // Aurora
  return 8; // Lumen
}

export function computeLeague(inp: LeagueInputs): LeagueRank {
  const idx = Math.min(
    tenureBandIdx(inp.ageDays),
    activeWeeksBandIdx(inp.activeWeeks),
    engagementBandIdx(inp.receivedEngagement, inp.distinctGivers)
  );
  const tier = TIER_ORDER[idx];
  const info = TIERS[tier];

  const standing = Math.round(
    100 *
      (0.55 * clamp01(inp.receivedEngagement) +
        0.25 * Math.min(inp.activeWeeks / 26, 1) +
        0.2 * Math.min(inp.ageDays / 730, 1))
  );

  let division: Division | undefined;
  if (info.hasDivisions) {
    // Finer split within the tier by the standing's position; refined server-side
    // on real percentiles. IV (weakest) .. I (strongest).
    const within = ((standing % 25) / 25) * 4; // 0..4
    division = (4 - Math.min(3, Math.floor(within))) as Division;
  }

  return { tier, division, standing, showBylineEmblem: info.showBylineEmblem };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

// Cheap byline tier from a Hive account's (formatted) reputation — the only
// per-author signal available on a feed post WITHOUT a fetch. Reputation is
// stake-weighted received approval, i.e. a proxy for the dominant keystone arm.
// Low reputation → Ember (which LeagueByline hides), so the emblem only shows for
// genuinely-established authors (Torch+). Deliberately CAPPED at Beacon: the rare
// Celestial apex (Halo/Aurora/Lumen) can never be inferred from reputation alone —
// it requires the full server-computed keystone (engagement + tenure + active-weeks).
export function bylineTierFromReputation(reputation: number): LeagueTier {
  const r = reputation || 0;
  if (r < 55) return LeagueTier.Ember; // hidden (below Torch)
  if (r < 63) return LeagueTier.Torch;
  if (r < 70) return LeagueTier.Lantern;
  return LeagueTier.Beacon; // cap — apex needs the real per-author keystone
}
