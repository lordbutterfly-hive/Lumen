/**
 * completionPctOf is the ONE derivation of the completion rate (creator page +
 * creators board). Pinned after 2026-09-22, when the two surfaces disagreed:
 * the board trusted the indexer view's completion_pct, NULL on the live
 * indexer for every creator with answers and zero misses, and filed hbd-temp
 * (1 of 1, rated 5.0) as "Delivery record unavailable".
 */
import assert from 'node:assert/strict';
import { completionPctOf } from '../../features/creator-tokens/market/format';

const cases: Array<[number, number, number | null]> = [
  [0, 0, null], // nothing resolved: no record, never 0%
  [1, 0, 100], // the live hbd-temp shape that the view returned as NULL
  [2, 1, 67],
  [0, 1, 0], // asked once, missed once: a real 0%
  [3, 3, 50],
  [199, 1, 100], // rounds, never truncates to 99
];
for (const [answered, missed, want] of cases) {
  assert.equal(completionPctOf(answered, missed), want, `completionPctOf(${answered}, ${missed})`);
}
assert.equal(completionPctOf(Number.NaN, 0), null, 'a non-number total is no record, not a crash');
console.log(`meritum-completion-pct: ${cases.length + 1} checks passed`);
