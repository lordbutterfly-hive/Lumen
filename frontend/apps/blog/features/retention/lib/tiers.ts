import { LeagueBand, LeagueTier } from '../types';

/**
 * THE LADDER — rank 0, then nine numbered rungs, every one of them a light that exists.
 *
 *   0 Unranked — nothing measured yet. Where EVERY account starts, veterans included.
 *   1 Spark   — it just caught. Nobody has found you yet.
 *   2 Ember   — it is holding on its own.
 *   3 Candle   — small, steady, and the same people keep coming back.
 *   4 Lantern — enough people read you that it stopped being luck.
 *   5 Torch   — THE MARK APPEARS. People can see you from across the room.
 *   6 Beacon  — fixed. Strangers steer by it.
 *   7 Halo    — you are one of the reasons somebody opens the app.
 *   8 Aurora  — sky scale, well outside your own circle.
 *   9 Lumen   — the unit itself, and the house name. Rare by construction.
 *
 * ★ THE PREVIOUS LADDER OPENED ON FOUR ABSENCES AND THAT WAS THE BUG (2026-08-09).
 *
 * It ran Void → Abyss → Smoke → Ash → Ember → Torch → Beacon → Aurora → Lumen,
 * and the dark band was defended in this very file as "the honest reading of an
 * account nobody has met yet". The defence misses what a rank NAME is: something
 * you say about a person. "You're Smoke" is not a reading, it is a verdict, and
 * the owner's reaction to it was the correct one. Worse, the thing those four
 * names describe is OUR failure to distribute a new account, not the account's
 * failure to be interesting. So the arc no longer runs dark → light. It runs
 * SMALL → FAR: every rung is alight, and what grows is how far the light carries.
 *
 * Colour is the at-20px signal and it alternates warm → cool → white on purpose
 * (the 2026-07-20 build map's own grammar): Ember coal-red, Candle brass, Lantern
 * teal, Torch amber, Beacon azure, Halo violet, then the two Celestial rungs go
 * iridescent and white-gold. Adjacent rungs never share a hue, which is what makes
 * them separable at nav size where the name is not visible.
 *
 * EXPORTS (this module is the single source of truth for the ladder):
 *   TierInfo          — the per-rung metadata shape
 *   TIERS             — Record<LeagueTier, TierInfo>
 *   TIER_ORDER        — LeagueTier[], index 0..9 = rank 0..9 (index IS the rank)
 *   TOTAL_RANKS       — 9 (the top RANK; there are ten states, see below)
 *   MAX_TIER_INDEX    — 9
 *   rankNumber(tier)  — 0..9
 *   tierAtRank(n)     — LeagueTier | undefined
 *   nextTier(tier)    — LeagueTier | undefined (undefined at rung 9)
 *   hasMark(tier)     — boolean (same predicate as showBylineEmblem)
 *
 * i18n: every rung carries `labelKey` ('retention.tier.<id>') for the NAME and
 * `blurbKey` ('retention.tier_blurb.<id>') for the one line above. The strings
 * belong to whoever owns copy — this module only owns the keys. A rung number is
 * rendered as "<n>/<TOTAL_RANKS>" or via 'retention.rank_of'.
 *
 * There are NO divisions. See types.ts for why they were cut.
 */
export interface TierInfo {
  tier: LeagueTier;
  band: LeagueBand;
  /** 1..9 — the rung number shown to the user. Equals TIER_ORDER index + 1. */
  order: number;
  /** True from Torch up. Identical to the Kindling→Signal band boundary. */
  showBylineEmblem: boolean;
  /** Top two rungs only, and only on the large profile emblem. */
  animated: boolean;
  /** The at-20px signal. Canonical LIGHT-theme values; the emblem's token map handles dark. */
  color: { core: string; frame: string; glow: string };
  labelKey: string;
  blurbKey: string;
}

export const TIERS: Record<LeagueTier, TierInfo> = {
  // ★ RANK 0. No mark, no animation, and the emblem renders NOTHING at any size — see
  // emblems/league-emblem.tsx. A lit flame for an account with no measured activity would be
  // the same overstatement the rest of this feature spends its time removing. Colours are
  // present only because the type requires them; nothing draws with them.
  [LeagueTier.Unranked]: {
    tier: LeagueTier.Unranked,
    band: LeagueBand.Kindling,
    order: 0,
    showBylineEmblem: false,
    animated: false,
    color: { core: '#C6C9CE', frame: '#9CA3AF', glow: '#E4E6E9' },
    labelKey: 'retention.tier.unranked',
    blurbKey: 'retention.tier_blurb.unranked'
  },
  [LeagueTier.Spark]: {
    tier: LeagueTier.Spark,
    band: LeagueBand.Kindling,
    order: 1,
    showBylineEmblem: false,
    animated: false,
    color: { core: '#A8724A', frame: '#7A5236', glow: '#D9A272' },
    labelKey: 'retention.tier.spark',
    blurbKey: 'retention.tier_blurb.spark'
  },
  [LeagueTier.Ember]: {
    tier: LeagueTier.Ember,
    band: LeagueBand.Kindling,
    order: 2,
    showBylineEmblem: false,
    animated: false,
    color: { core: '#C24A22', frame: '#8C3D22', glow: '#F27B3D' },
    labelKey: 'retention.tier.ember',
    blurbKey: 'retention.tier_blurb.ember'
  },
  [LeagueTier.Candle]: {
    tier: LeagueTier.Candle,
    band: LeagueBand.Kindling,
    order: 3,
    showBylineEmblem: false,
    animated: false,
    color: { core: '#D6A02E', frame: '#9C7320', glow: '#F5CE74' },
    labelKey: 'retention.tier.candle',
    blurbKey: 'retention.tier_blurb.candle'
  },
  [LeagueTier.Lantern]: {
    tier: LeagueTier.Lantern,
    band: LeagueBand.Kindling,
    order: 4,
    showBylineEmblem: false,
    animated: false,
    color: { core: '#2FB0A8', frame: '#1F7C77', glow: '#7FD8D2' },
    labelKey: 'retention.tier.lantern',
    blurbKey: 'retention.tier_blurb.lantern'
  },
  [LeagueTier.Torch]: {
    tier: LeagueTier.Torch,
    band: LeagueBand.Signal,
    order: 5,
    showBylineEmblem: true,
    animated: false,
    color: { core: '#EFA31E', frame: '#A0701C', glow: '#FFC94F' },
    labelKey: 'retention.tier.torch',
    blurbKey: 'retention.tier_blurb.torch'
  },
  [LeagueTier.Beacon]: {
    tier: LeagueTier.Beacon,
    band: LeagueBand.Signal,
    order: 6,
    showBylineEmblem: true,
    animated: false,
    color: { core: '#6FB0FF', frame: '#3D74B8', glow: '#BBD9FF' },
    labelKey: 'retention.tier.beacon',
    blurbKey: 'retention.tier_blurb.beacon'
  },
  [LeagueTier.Halo]: {
    tier: LeagueTier.Halo,
    band: LeagueBand.Signal,
    order: 7,
    showBylineEmblem: true,
    animated: false,
    color: { core: '#B48CFF', frame: '#7A5CC4', glow: '#DCC9FF' },
    labelKey: 'retention.tier.halo',
    blurbKey: 'retention.tier_blurb.halo'
  },
  [LeagueTier.Aurora]: {
    tier: LeagueTier.Aurora,
    band: LeagueBand.Celestial,
    order: 8,
    showBylineEmblem: true,
    animated: true,
    color: { core: '#56E0C4', frame: '#3FA9C9', glow: '#C4A6FF' },
    labelKey: 'retention.tier.aurora',
    blurbKey: 'retention.tier_blurb.aurora'
  },
  [LeagueTier.Lumen]: {
    tier: LeagueTier.Lumen,
    band: LeagueBand.Celestial,
    order: 9,
    showBylineEmblem: true,
    animated: true,
    color: { core: '#FFF6D8', frame: '#E7C86A', glow: '#FFE9A3' },
    labelKey: 'retention.tier.lumen',
    blurbKey: 'retention.tier_blurb.lumen'
  }
};

/** Floor → apex. Index 0..8 is what the keystone arms in compute-league.ts return. */
export const TIER_ORDER: LeagueTier[] = [
  LeagueTier.Unranked,
  LeagueTier.Spark,
  LeagueTier.Ember,
  LeagueTier.Candle,
  LeagueTier.Lantern,
  LeagueTier.Torch,
  LeagueTier.Beacon,
  LeagueTier.Halo,
  LeagueTier.Aurora,
  LeagueTier.Lumen
];

/**
 * The TOP rank number, not the number of states.
 *
 * ★ THERE ARE TEN STATES AND NINE RANKS, and the distinction is load-bearing: rank 0 is not a
 * tenth rank, it is the absence of one. "rank 0 of 9" is the true sentence for a new account and
 * `TOTAL_RANKS = TIER_ORDER.length` would have made it "rank 0 of 10", implying a rung above
 * Lumen. Index and order are now IDENTICAL (index 0 = rank 0), which also removes the
 * off-by-one that ran through every arm table.
 */
export const TOTAL_RANKS = TIER_ORDER.length - 1; // 9
export const MAX_TIER_INDEX = TIER_ORDER.length - 1; // 9

/** 0..9. The number the UI shows next to the name. Identical to the TIER_ORDER index. */
export function rankNumber(tier: LeagueTier): number {
  return TIERS[tier].order;
}

/** Inverse of rankNumber. Undefined outside 0..TOTAL_RANKS. */
export function tierAtRank(rank: number): LeagueTier | undefined {
  return TIER_ORDER[rank];
}

/** The rung above, or undefined at rank 9. */
export function nextTier(tier: LeagueTier): LeagueTier | undefined {
  return TIER_ORDER[TIERS[tier].order + 1];
}

/** Carries a public mark. Identical to TIERS[tier].showBylineEmblem, by construction. */
export function hasMark(tier: LeagueTier): boolean {
  return TIERS[tier].band !== LeagueBand.Kindling;
}
