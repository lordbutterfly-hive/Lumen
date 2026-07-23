import type { Bucket, BucketDirection } from './types';

// Presentation-only. Maps each outcome (bucket) to a graded diverging colour for
// the Coinbase-style skin: reds for "below" outcomes, greens for "above", a warm
// neutral for "flat". More-extreme outcomes read darker/more saturated. Generic
// over N buckets — works for the current 5 %-move buckets or a future 7
// price-strike set without hard-coding a colour per label.
//
// Ordering assumption (matches bucket-defs.ts / the contract outcome index):
// buckets run most-negative → flat → most-positive, so within the "down" group
// the FIRST entry is the most extreme, and within the "up" group the LAST is.

const UP_SCALE = ['#4f9e6a', '#2f7d4f', '#1e7a45']; // light → dark (more extreme up = darker)
const DOWN_SCALE = ['#e0663e', '#c0392b', '#8f1f14']; // light → dark (more extreme down = darker)
const FLAT_COLOR = '#b0870a'; // warm neutral gold

function pick(scale: string[], pos: number, len: number, invert: boolean): string {
  if (len <= 1) return scale[scale.length - 1];
  const t = pos / (len - 1); // 0..1 along the group
  const idx = Math.round((invert ? 1 - t : t) * (scale.length - 1));
  return scale[idx];
}

/** outcome id → hex colour. */
export function buildOutcomeColorMap(buckets: Bucket[]): Record<string, string> {
  const groups: Record<BucketDirection, string[]> = { down: [], flat: [], up: [] };
  buckets.forEach((bucket) => groups[bucket.direction].push(bucket.id));

  const map: Record<string, string> = {};
  groups.up.forEach((id, i) => {
    map[id] = pick(UP_SCALE, i, groups.up.length, false); // last = darkest
  });
  groups.down.forEach((id, i) => {
    map[id] = pick(DOWN_SCALE, i, groups.down.length, true); // first = darkest
  });
  groups.flat.forEach((id) => {
    map[id] = FLAT_COLOR;
  });
  return map;
}
