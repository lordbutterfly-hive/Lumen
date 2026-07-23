import type { BucketDirection } from '../types';

// The 7 weekly threshold buckets (matches the contract's computeStrikes: 6 strikes
// at ±10/20/30% ⇒ 7 mutually-exclusive buckets — 3 below, a middle "near current"
// band, 3 above). This is a protocol convention, NOT a contract constant: the roll
// snapshots the current oracle price as the reference and sets each on-chain strike
// = reference × mult. The contract only sees the resulting absolute bps strikes.
//
// Labels are shown as CONCRETE $ THRESHOLDS (not percentages), derived per-round
// from the reference price via bucketUsdLabel(). The %-string here is only a
// fallback for when no reference price is available.
export interface BucketDef {
  id: string;
  label: string; // %-move fallback; data sources override with a concrete-$ label
  direction: BucketDirection;
  // Relative bounds as fractions of the reference price. null = open-ended.
  loMult: number | null;
  hiMult: number | null;
}

export const BUCKET_DEFS: BucketDef[] = [
  { id: 'b_lo', label: '≤ −30%', direction: 'down', loMult: null, hiMult: 0.7 },
  { id: 'b_d20', label: '−30% to −20%', direction: 'down', loMult: 0.7, hiMult: 0.8 },
  { id: 'b_d10', label: '−20% to −10%', direction: 'down', loMult: 0.8, hiMult: 0.9 },
  { id: 'flat', label: 'Near current', direction: 'flat', loMult: 0.9, hiMult: 1.1 },
  { id: 'b_u10', label: '+10% to +20%', direction: 'up', loMult: 1.1, hiMult: 1.2 },
  { id: 'b_u20', label: '+20% to +30%', direction: 'up', loMult: 1.2, hiMult: 1.3 },
  { id: 'b_hi', label: '≥ +30%', direction: 'up', loMult: 1.3, hiMult: null }
];

// Format a $ threshold from the reference price ($ float) × a relative multiplier.
function usd(refUsd: number, mult: number): string {
  return '$' + (refUsd * mult).toFixed(3);
}

// Concrete-$ threshold label for a bucket, derived from the round's reference
// price ($ float) — the "clear threshold numbers instead of percentages" ask.
//   open-low  → "Below $X"   ·   open-high → "Above $X"   ·   mid → "$X – $Y"
export function bucketUsdLabel(def: BucketDef, refUsd: number): string {
  if (!refUsd || refUsd <= 0) return def.label;
  if (def.loMult === null && def.hiMult !== null) return 'Below ' + usd(refUsd, def.hiMult);
  if (def.hiMult === null && def.loMult !== null) return 'Above ' + usd(refUsd, def.loMult);
  if (def.loMult !== null && def.hiMult !== null) return usd(refUsd, def.loMult) + ' – ' + usd(refUsd, def.hiMult);
  return def.label;
}
