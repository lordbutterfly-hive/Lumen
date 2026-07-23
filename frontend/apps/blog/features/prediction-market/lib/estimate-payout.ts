import type { RoundState } from '../types';

// Parimutuel payout is NEVER fixed at bet time — it depends on the FINAL pool.
// These are ESTIMATES mirroring the contract's math (floor(stake·distributable/
// winPool) at claim). Always show them as estimates, never as a guaranteed number.

/** If I add `amount` to `bucketId` right now, what would I claim if it wins? */
export function estimateBetPayout(round: RoundState, bucketId: string, amount: number): number {
  const bucket = round.buckets.find((b) => b.id === bucketId);
  if (!bucket || amount <= 0) return 0;
  const bucketPool = bucket.poolAmount + amount;
  const totalPool = round.totalPool + amount;
  const netPool = totalPool * (1 - round.feeBps / 10_000);
  return (amount / bucketPool) * netPool;
}

/** Current payout-per-unit-staked for a bucket (the implied multiplier / odds). */
export function impliedMultiplier(round: RoundState, bucketId: string): number | null {
  const bucket = round.buckets.find((b) => b.id === bucketId);
  if (!bucket || bucket.poolAmount <= 0) return null;
  const netPool = round.totalPool * (1 - round.feeBps / 10_000);
  return netPool / bucket.poolAmount;
}
