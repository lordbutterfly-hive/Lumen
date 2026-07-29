// Domain types for the Hive Price Weekly Market UI. Zero logic here.

export type BucketDirection = 'down' | 'flat' | 'up';
export type MarketStatus = 'open' | 'locked' | 'settled' | 'void';
export type MarketAsset = 'HIVE' | 'HBD';

export interface Bucket {
  id: string;
  label: string; // e.g. "≤ −20%"
  direction: BucketDirection;
  poolAmount: number; // staked in this bucket, in round.asset units
  oddsPct: number; // 0-100 implied pool share (opool[k]/pool)
}

export interface RoundState {
  roundId: string;
  asset: MarketAsset; // a round is single-asset (rd|id|asset)
  status: MarketStatus; // NOTE: "locked" is derived (open && now>=lock), not a raw contract state
  question: string;
  referencePrice: number; // Monday-open reference the strikes were set against
  closesAt: number; // epoch ms — betting closes (lock)
  buckets: Bucket[]; // always the 5 %-move buckets
  totalPool: number;
  // Distinct accounts in the round. NULL means "we could not find out" — the
  // indexer is unconfigured or unreachable — and must never render as a number.
  // Contract state cannot answer this: stakes are keyed by account with no
  // roster to enumerate, so it only exists by folding the bet events. It used to
  // degrade silently to 0, which reads as the fact "nobody has bet".
  bettors: number | null;
  feeBps: number; // per-round fee snapshot (rd|id|fb)
  settledBucketId?: string;
  settlementPrice?: number; // labeled HBD/HIVE (peg proxy, not HIVE/USD)
  voidReason?: string;
}

export interface MyPosition {
  roundId: string;
  stakeByBucket: Record<string, number>;
  totalStaked: number;
  claimed: boolean;
  claimable: boolean;
  payout?: number;
}

export interface PlaceBetInput {
  roundId: string;
  username: string;
  bucketId: string;
  amount: number;
}

export interface ClaimInput {
  roundId: string;
  username: string;
}
