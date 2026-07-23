import { LeagueTier, LeagueBand } from '../types';

// The 9-tier "Lightkeeper" ladder — a light-intensity arc (banked coal → blinding
// radiance). Divisions IV→I on the six lower tiers; the Celestial apex is
// percentile/population-capped. The public byline emblem appears only from Torch
// up, so a byline emblem always means "proven regular". Colors are the at-20px
// signal (warm → cool → white-gold). Dark-theme variants are handled in the
// emblem component's CSS token map; these are the canonical light values.
export interface TierInfo {
  tier: LeagueTier;
  band: LeagueBand;
  order: number; // 1..9
  hasDivisions: boolean; // false for the capped apex
  showBylineEmblem: boolean; // Torch and up
  animated: boolean; // apex only, and only on the large profile emblem
  color: { core: string; frame: string; glow: string };
  labelKey: string; // i18n key (locales/en/common_blog.json)
}

export const TIERS: Record<LeagueTier, TierInfo> = {
  [LeagueTier.Ember]: { tier: LeagueTier.Ember, band: LeagueBand.Kindling, order: 1, hasDivisions: true, showBylineEmblem: false, animated: false, color: { core: '#7C3A28', frame: '#5E4B45', glow: '#A85436' }, labelKey: 'retention.tier.ember' },
  [LeagueTier.Spark]: { tier: LeagueTier.Spark, band: LeagueBand.Kindling, order: 2, hasDivisions: true, showBylineEmblem: false, animated: false, color: { core: '#B96A2E', frame: '#7A5230', glow: '#E89A3C' }, labelKey: 'retention.tier.spark' },
  [LeagueTier.Candle]: { tier: LeagueTier.Candle, band: LeagueBand.Kindling, order: 3, hasDivisions: true, showBylineEmblem: false, animated: false, color: { core: '#D6A02E', frame: '#8A7433', glow: '#F2C868' }, labelKey: 'retention.tier.candle' },
  [LeagueTier.Torch]: { tier: LeagueTier.Torch, band: LeagueBand.MadeLight, order: 4, hasDivisions: true, showBylineEmblem: true, animated: false, color: { core: '#EFB61E', frame: '#9A7A1E', glow: '#FFD84A' }, labelKey: 'retention.tier.torch' },
  [LeagueTier.Lantern]: { tier: LeagueTier.Lantern, band: LeagueBand.MadeLight, order: 5, hasDivisions: true, showBylineEmblem: true, animated: false, color: { core: '#FFD98A', frame: '#1E8F8A', glow: '#FFC24A' }, labelKey: 'retention.tier.lantern' },
  [LeagueTier.Beacon]: { tier: LeagueTier.Beacon, band: LeagueBand.MadeLight, order: 6, hasDivisions: true, showBylineEmblem: true, animated: false, color: { core: '#6FB0FF', frame: '#2E6FD0', glow: '#BFE0FF' }, labelKey: 'retention.tier.beacon' },
  [LeagueTier.Halo]: { tier: LeagueTier.Halo, band: LeagueBand.Celestial, order: 7, hasDivisions: false, showBylineEmblem: true, animated: true, color: { core: '#B48CFF', frame: '#7A4FD0', glow: '#E4D6FF' }, labelKey: 'retention.tier.halo' },
  [LeagueTier.Aurora]: { tier: LeagueTier.Aurora, band: LeagueBand.Celestial, order: 8, hasDivisions: false, showBylineEmblem: true, animated: true, color: { core: '#2FC6C0', frame: '#8A4FD0', glow: '#F2C868' }, labelKey: 'retention.tier.aurora' },
  [LeagueTier.Lumen]: { tier: LeagueTier.Lumen, band: LeagueBand.Celestial, order: 9, hasDivisions: false, showBylineEmblem: true, animated: true, color: { core: '#FFF3C4', frame: '#E9C86A', glow: '#FFD24D' }, labelKey: 'retention.tier.lumen' }
};

// Floor→apex order. Index 0..8 maps to the per-arm keystone bands in compute-league.
export const TIER_ORDER: LeagueTier[] = [
  LeagueTier.Ember,
  LeagueTier.Spark,
  LeagueTier.Candle,
  LeagueTier.Torch,
  LeagueTier.Lantern,
  LeagueTier.Beacon,
  LeagueTier.Halo,
  LeagueTier.Aurora,
  LeagueTier.Lumen
];
