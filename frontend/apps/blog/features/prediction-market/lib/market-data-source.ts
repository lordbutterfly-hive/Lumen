import { getStorageItem, setStorageItem, StorageTTL } from '@ui/lib/storage-with-ttl';
import type { ClaimInput, MyPosition, PlaceBetInput, RoundState } from '../types';
import { BUCKET_DEFS, bucketUsdLabel } from './bucket-defs';
import { getMarketConfig, isMarketDemoEnabled } from './market-config';
import { VscMarketDataSource } from './vsc-market-data-source';
import { hiveTransactionBroadcaster } from './vsc/broadcaster';

/**
 * The swap boundary between the UI and the market data. When a contract is
 * provisioned (REACT_APP_VSC_MARKET_*) this is the VscMarketDataSource; with no
 * contract and no dev demo flag the market is unavailable (getMarketDataSource()
 * returns null). The Mock is dev-only, behind REACT_APP_MARKET_DEMO=1.
 * VscMarketDataSource implements the same interface — readRound/readMyPosition via GraphQL
 * `getStateByKeys(contractId, ["rd|<id>|state", ...])`, placeBet/claim via a
 * Hive `custom_json` op (`id:"vsc.call"`, action:"bet"/"claim", with a
 * `transfer.allow` intent for the escrow draw). See
 * `/mnt/o/HIVE-BLOG-REBUILD/FRONTEND-AUDIT-AND-FIXES-2026-07-19.md`.
 * No UI component imports a concrete source — they only call getMarketDataSource().
 */
export interface MarketDataSource {
  readRound(roundId?: string): Promise<RoundState | null>;
  readMyPosition(roundId: string, username: string): Promise<MyPosition | null>;
  placeBet(input: PlaceBetInput): Promise<MyPosition>;
  claim(input: ClaimInput): Promise<MyPosition>;
  /**
   * Per-outcome pool share over the life of the round, for the chart. NULL means
   * "no usable history" — no indexer configured, the index is unreachable, or
   * fewer than two distinct blocks have bets. The caller must fall back to the
   * flat placeholder and SAY it is one, never draw a line from a null.
   */
  readPoolSeries(roundId: string, outcomeCount: number): Promise<number[][] | null>;
}

const MOCK_REF = 0.294; // reference price ($) the strikes were set against
const MOCK_POOLS = [18, 42, 118, 205, 96, 39, 14]; // seeded pool per bucket (7 buckets, round.asset units)
const posKey = (roundId: string, username: string) => `pm-mock-pos-${roundId}-${username}`;

// In-memory mock. The pools are static; placeBet/claim persist a simulated
// position to TTL storage so a dev reload doesn't lose the fake bet. Mock-only —
// the real source must never persist positions client-side.
class MockMarketDataSource implements MarketDataSource {
  private buildRound(): RoundState {
    const buckets = BUCKET_DEFS.map((def, i) => ({
      ...def,
      label: bucketUsdLabel(def, MOCK_REF),
      poolAmount: MOCK_POOLS[i],
      oddsPct: 0
    }));
    const totalPool = buckets.reduce((sum, b) => sum + b.poolAmount, 0);
    buckets.forEach((b) => {
      b.oddsPct = Math.round((b.poolAmount / totalPool) * 100);
    });
    return {
      roundId: 'mock-1',
      asset: 'HBD',
      status: 'open',
      question: 'Where will $HIVE close this week?',
      referencePrice: MOCK_REF,
      closesAt: 1_700_000_000_000 + 2 * 86_400_000, // fixed base; real source uses lock block → time
      buckets,
      totalPool,
      bettors: 34,
      feeBps: 200
    };
  }

  async readRound(): Promise<RoundState> {
    // closesAt is recomputed relative to "now" so the mock countdown ticks live.
    const round = this.buildRound();
    return { ...round, closesAt: nowPlus(2, 14) };
  }

  async readMyPosition(roundId: string, username: string): Promise<MyPosition | null> {
    if (!username) return null;
    return getStorageItem<MyPosition>(posKey(roundId, username)) ?? null;
  }

  async placeBet(input: PlaceBetInput): Promise<MyPosition> {
    await delay(400); // simulate broadcast latency
    const key = posKey(input.roundId, input.username);
    const prev = getStorageItem<MyPosition>(key);
    const stakeByBucket = { ...(prev?.stakeByBucket ?? {}) };
    stakeByBucket[input.bucketId] = (stakeByBucket[input.bucketId] ?? 0) + input.amount;
    const position: MyPosition = {
      roundId: input.roundId,
      stakeByBucket,
      totalStaked: Object.values(stakeByBucket).reduce((sum, v) => sum + v, 0),
      claimed: false,
      claimable: false
    };
    setStorageItem(key, position, StorageTTL.SESSION);
    return position;
  }

  async claim(input: ClaimInput): Promise<MyPosition> {
    await delay(400);
    const key = posKey(input.roundId, input.username);
    const prev = getStorageItem<MyPosition>(key);
    const position: MyPosition = {
      roundId: input.roundId,
      stakeByBucket: prev?.stakeByBucket ?? {},
      totalStaked: prev?.totalStaked ?? 0,
      claimed: true,
      claimable: false
    };
    setStorageItem(key, position, StorageTTL.SESSION);
    return position;
  }

  // The Mock has static pools and therefore no history. It returns null rather
  // than synthesising a plausible-looking curve: a fabricated series is exactly
  // the kind of thing that survives into a demo and gets believed.
  async readPoolSeries(): Promise<number[][] | null> {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowPlus(days: number, hours: number): number {
  return Date.now() + days * 86_400_000 + hours * 3_600_000;
}

let instance: MarketDataSource | null = null;
let resolved = false;

/**
 * The market data source, or `null` when the market is genuinely UNAVAILABLE
 * (no contract provisioned and not running in dev demo mode). Callers MUST treat
 * a null return as "not available yet" and render an honest unavailable state —
 * never a bettable UI. See useMarket()/MarketTab/MarketWidget.
 */
export function getMarketDataSource(): MarketDataSource | null {
  if (!resolved) {
    const config = getMarketConfig();
    if (config) {
      // Real source once a contract is configured (REACT_APP_VSC_MARKET_*). The
      // Vsc source reads live state immediately; placeBet/claim broadcast via the
      // injected hiveTransactionBroadcaster (transactionService-backed, reads the
      // app's live signer fresh on every call — see vsc/broadcaster.ts).
      instance = new VscMarketDataSource({ config, broadcaster: hiveTransactionBroadcaster });
    } else if (isMarketDemoEnabled()) {
      // Dev-only: explicit REACT_APP_MARKET_DEMO=1 opts into the in-memory Mock.
      instance = new MockMarketDataSource();
    } else {
      // Unconfigured AND no dev demo flag → the market does not exist yet. Return
      // null so the UI is honest-unavailable. We must NEVER default to the Mock
      // here: it fabricates a round (fixed question, invented pool, fake per-
      // bucket odds) and persists a fake bet position to storage, letting a user
      // "bet" on invented data and see a fake position (a HIGH-severity lie).
      instance = null;
    }
    resolved = true;
  }
  return instance;
}
