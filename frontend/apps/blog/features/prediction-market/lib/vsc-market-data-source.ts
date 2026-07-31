import type { ClaimInput, Bucket, MarketAsset, MarketStatus, MyPosition, PlaceBetInput, RoundState } from '../types';
import type { MarketDataSource } from './market-data-source';
import type { MarketConfig } from './market-config';
import { BUCKET_DEFS, bucketUsdLabel } from './bucket-defs';
import { baseUnitsToHuman } from './vsc-money';
import { buildBetOp, buildClaimOp, buildReclaimOp, type ContractAsset, type CustomJsonOp } from './op-builders';
import { DefaultVscGqlClient, type VscGqlClient } from './vsc-gql';
import { MagiIndexerClient } from './magi-indexer';
import { buildOddsSeries } from './pool-series';

// Real, on-chain implementation of MarketDataSource. Reads live contract state
// via GraphQL getStateByKeys; builds (but does not itself sign) the bet/claim
// custom_json ops via the pure op-builders. Swapped in for the Mock by
// getMarketDataSource() only when getMarketConfig() is non-null.

// The active-round pointer this weekly market reads. The contract keys it per
// asset (active|hive, active|hbd); this deployment's primary market is the
// hive-staked one (DEPLOY-RUNBOOK §5 / market/keys.go kActiveRound). A hbd
// market would read active|hbd instead.
const POINTER_ASSET: ContractAsset = 'hive';

// Hive L1 blocks are ~3s. lock/settle are Hive L1 heights (contract block.height
// == the node's last_processed_block basis), so this converts a height delta to
// wall-clock ms for the lock countdown.
const MS_PER_BLOCK = 3_000;

// refprice / settle price are stored in bps of the HBD/HIVE feed (10000 = 1.0).
const BPS_SCALE = 10_000;

// market/params.go SettleWindowBlocks — the window a settle must land inside.
// Mirrored here ONLY to derive `reclaimable` from the same rule the contract
// enforces; if it ever changes on chain this must change with it, which is why
// it is named after the constant rather than inlined as 1200.
const SETTLE_WINDOW_BLOCKS = 1200;

const NO_BROADCASTER_MSG = 'VscMarketDataSource: no broadcaster wired — inject the transaction service';

// ── State-key builders. COUPLING WARNING: these MUST mirror market/keys.go
// byte-for-byte (rk / rkOutcomePool / rkStake / rkStakeTotal / rkClaimed).
// Keys are already per-contract namespaced by the store, so no contract prefix.
function rk(id: number, field: string): string {
  return `rd|${id}|${field}`;
}
function rkOutcomePool(id: number, k: number): string {
  return `rd|${id}|op|${k}`;
}
function rkStake(id: number, acct: string, k: number): string {
  return `rd|${id}|st|${acct}|${k}`;
}
function rkStakeTotal(id: number, acct: string): string {
  return `rd|${id}|stt|${acct}`;
}
function rkClaimed(id: number, acct: string): string {
  return `rd|${id}|cl|${acct}`;
}
function activePointerKey(): string {
  return `active|${POINTER_ASSET}`;
}

function toU64(value: string | null | undefined): number {
  if (!value) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// A frontend bucketId is a fixed %-move label (bucket-defs.ts); its array index
// IS the contract outcome index (matches indexer/api.go BucketIDs).
function outcomeForBucketId(bucketId: string): number {
  return BUCKET_DEFS.findIndex((def) => def.id === bucketId);
}

function parseRoundId(roundId: string): number | null {
  const n = Number(roundId);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function deriveStatus(rawState: string, lock: number, head: number | null): MarketStatus {
  if (rawState === 'settled') return 'settled';
  if (rawState === 'void') return 'void';
  // F-L20: fail CLOSED when the head height is unavailable. "locked" is DERIVED
  // (open && now>=lock), so without a head we CANNOT confirm the betting window is still
  // open — returning 'open' let the UI enable a bet that, if the window had already
  // closed, is a wasted on-chain transaction. Treat an unknown head as 'locked' (the
  // safe, non-bettable state); it re-derives to 'open' as soon as a head is read.
  if (head === null) return 'locked';
  if (lock > 0 && head >= lock) return 'locked';
  return 'open';
}

function deriveClosesAt(lock: number, head: number | null): number {
  // TODO(lock-derivation): falls back to "now" when the head height is
  // unavailable (localNodeInfo read failed) — the countdown then reads as
  // already-locked rather than guessing a wrong time.
  if (head === null || lock === 0) return Date.now();
  return Date.now() + (lock - head) * MS_PER_BLOCK;
}

export type Broadcaster = (op: CustomJsonOp) => Promise<string>;

export interface VscMarketDataSourceDeps {
  config: MarketConfig;
  gql?: VscGqlClient; // injectable for testing
  // Broadcasting is React-context-bound (smart-signer lives behind hooks), so it
  // is injected rather than constructed here. Without it, placeBet/claim throw;
  // reads still work fully. See getMarketDataSource() for the current wiring.
  broadcaster?: Broadcaster;
}

export class VscMarketDataSource implements MarketDataSource {
  private readonly config: MarketConfig;
  private readonly gql: VscGqlClient;
  private readonly broadcaster?: Broadcaster;

  constructor(deps: VscMarketDataSourceDeps) {
    this.config = deps.config;
    this.gql = deps.gql ?? new DefaultVscGqlClient(deps.config.gqlUrl);
    this.broadcaster = deps.broadcaster;
  }

  async readRound(roundId?: string): Promise<RoundState | null> {
    const id = roundId !== undefined ? parseRoundId(roundId) : await this.resolveActiveRoundId();
    if (id === null) return null;

    const keys = buildRoundKeys(id);
    const [state, head] = await Promise.all([
      this.gql.getStateByKeys(this.config.contractId, keys),
      this.gql.getHeadBlock()
    ]);

    const rawState = state[rk(id, 'state')];
    if (!rawState) return null; // round does not exist

    const totalPool = baseUnitsToHuman(state[rk(id, 'pool')]);
    const refUsd = toU64(state[rk(id, 'refprice')]) / BPS_SCALE;
    const buckets: Bucket[] = BUCKET_DEFS.map((def) => ({
      ...def,
      label: bucketUsdLabel(def, refUsd),
      poolAmount: 0,
      oddsPct: 0
    }));
    buckets.forEach((bucket, i) => {
      bucket.poolAmount = baseUnitsToHuman(state[rkOutcomePool(id, i)]);
      bucket.oddsPct = totalPool > 0 ? Math.round((bucket.poolAmount / totalPool) * 100) : 0;
    });

    const assetRaw = state[rk(id, 'asset')] ?? '';
    const asset: MarketAsset = assetRaw === 'hbd' ? 'HBD' : 'HIVE';
    const lock = toU64(state[rk(id, 'lock')]);

    // No indexer configured ⇒ genuinely unknown, not zero.
    const bettors = this.config.indexerUrl ? await this.readBettors(this.config.indexerUrl, id) : null;

    const round: RoundState = {
      roundId: String(id),
      asset,
      status: deriveStatus(rawState, lock, head),
      // On-chain human label (market/create.go rd|id|label). Empty for a round
      // created without one — never a hardcoded UI string here.
      question: state[rk(id, 'label')] ?? '',
      referencePrice: refUsd,
      closesAt: deriveClosesAt(lock, head),
      buckets,
      totalPool,
      bettors,
      feeBps: toU64(state[rk(id, 'fb')])
    };

    if (rawState === 'settled') {
      const win = toU64(state[rk(id, 'win')]);
      round.settledBucketId = BUCKET_DEFS[win]?.id ?? String(win);
      round.settlementPrice = toU64(state[rk(id, 'price')]) / BPS_SCALE;
    } else if (rawState === 'void') {
      const voidReason = state[rk(id, 'vr')];
      if (voidReason) round.voidReason = voidReason;
    }

    return round;
  }

  async readMyPosition(roundId: string, username: string): Promise<MyPosition | null> {
    if (!username) return null;
    const id = parseRoundId(roundId);
    if (id === null) return null;

    const acct = `hive:${username}`; // state keys use the VSC DID form, not the bare name
    const keys = buildPositionKeys(id, acct);
    const map = await this.gql.getStateByKeys(this.config.contractId, keys);

    const totalStaked = baseUnitsToHuman(map[rkStakeTotal(id, acct)]);
    const claimed = map[rkClaimed(id, acct)] === '1';
    if (totalStaked <= 0 && !claimed) return null; // no position in this round

    const stakeByBucket: Record<string, number> = {};
    BUCKET_DEFS.forEach((def, i) => {
      const amt = baseUnitsToHuman(map[rkStake(id, acct, i)]);
      if (amt > 0) stakeByBucket[def.id] = amt;
    });

    const rawState = map[rk(id, 'state')] ?? '';
    const resolved = rawState === 'settled' || rawState === 'void';

    // market/reclaim.go's gate, verbatim: STILL OPEN and STRICTLY past
    // settleBlock + SettleWindowBlocks + grace. A staker with nothing at stake
    // has nothing to reclaim, so a zero balance is excluded — the contract would
    // accept the call and pay them zero, which is a wasted fee and a confusing
    // button.
    const head = await this.gql.getHeadBlock();
    const settleBlock = toU64(map[rk(id, 'settle')]);
    const graceBlocks = toU64(map[rk(id, 'grace')]);
    const pastDeadline =
      head !== null && settleBlock > 0 && head > settleBlock + SETTLE_WINDOW_BLOCKS + graceBlocks;
    const reclaimable = rawState === 'open' && pastDeadline && totalStaked > 0 && !claimed;
    let claimable = false;
    if (resolved && !claimed) {
      if (rawState === 'void') {
        claimable = totalStaked > 0; // full refund of stake
      } else {
        const win = toU64(map[rk(id, 'win')]);
        claimable = baseUnitsToHuman(map[rkStake(id, acct, win)]) > 0; // winning-bucket stake only
      }
    }

    // NOTE: realized `payout` is not derivable from getStateByKeys (the contract
    // does not store per-account payout); it comes from the indexer's positions
    // endpoint if/when that is wired. Left undefined here.
    return { roundId: String(id), stakeByBucket, totalStaked, claimed, reclaimable, claimable };
  }

  async placeBet(input: PlaceBetInput): Promise<MyPosition> {
    const id = parseRoundId(input.roundId);
    if (id === null) throw new Error(`VscMarketDataSource: invalid roundId ${input.roundId}`);
    const outcome = outcomeForBucketId(input.bucketId);
    if (outcome < 0) throw new Error(`VscMarketDataSource: unknown bucket ${input.bucketId}`);
    if (!this.broadcaster) throw new Error(NO_BROADCASTER_MSG);

    const asset = await this.readRoundAsset(id);
    const prev = await this.readMyPosition(input.roundId, input.username);

    const op = buildBetOp({
      contractId: this.config.contractId,
      netId: this.config.netId,
      username: input.username,
      roundId: id,
      asset,
      outcome,
      amount: input.amount,
      rcLimit: this.config.rcLimit
    });
    await this.broadcaster(op);

    // OPTIMISTIC only: the broadcaster resolving means the bet op was ACCEPTED
    // on Hive L1 — it is NOT yet executed on VSC L2, and L2 may still reject it
    // (bad state, insufficient escrow, round already locked). This number is a
    // best-effort projection, not confirmed state. useMarket's positionQuery
    // (refetchInterval + a scheduled reconcile after the mutation) replaces it
    // with real on-chain state on the next poll, reverting it if L2 rejected.
    const stakeByBucket = { ...(prev?.stakeByBucket ?? {}) };
    stakeByBucket[input.bucketId] = (stakeByBucket[input.bucketId] ?? 0) + input.amount;
    return {
      roundId: String(id),
      stakeByBucket,
      totalStaked: (prev?.totalStaked ?? 0) + input.amount,
      // A bet just placed is on an OPEN, pre-lock round by definition.
      reclaimable: false,
      claimed: false,
      claimable: false
    };
  }

  async claim(input: ClaimInput): Promise<MyPosition> {
    const id = parseRoundId(input.roundId);
    if (id === null) throw new Error(`VscMarketDataSource: invalid roundId ${input.roundId}`);
    if (!this.broadcaster) throw new Error(NO_BROADCASTER_MSG);

    const prev = await this.readMyPosition(input.roundId, input.username);
    const op = buildClaimOp({
      contractId: this.config.contractId,
      netId: this.config.netId,
      username: input.username,
      roundId: id,
      rcLimit: this.config.rcLimit
    });
    await this.broadcaster(op);

    return {
      roundId: String(id),
      stakeByBucket: prev?.stakeByBucket ?? {},
      totalStaked: prev?.totalStaked ?? 0,
      claimed: true,
      reclaimable: false,
      claimable: false
    };
  }

  /**
   * market/reclaim.go Reclaim — force a round that is stuck past its deadline to
   * VOID and pull back this caller's own full stake, in one call. Permissionless
   * and dependent on nothing: no oracle, no keeper, no owner.
   *
   * Posting authority only (no asset draw), same as claim. The contract pays the
   * CALLER and can never pay anyone else, so there is no payee to get wrong.
   */
  async reclaim(input: ClaimInput): Promise<MyPosition> {
    const id = parseRoundId(input.roundId);
    if (id === null) throw new Error(`VscMarketDataSource: invalid roundId ${input.roundId}`);
    if (!this.broadcaster) throw new Error(NO_BROADCASTER_MSG);

    const prev = await this.readMyPosition(input.roundId, input.username);
    const op = buildReclaimOp({
      contractId: this.config.contractId,
      netId: this.config.netId,
      username: input.username,
      roundId: id,
      rcLimit: this.config.rcLimit
    });
    await this.broadcaster(op);

    // Optimistic, and flagged as such by the caller's poll: a reclaim both voids
    // the round and settles this account, so both doors close.
    return {
      roundId: String(id),
      stakeByBucket: prev?.stakeByBucket ?? {},
      totalStaked: prev?.totalStaked ?? 0,
      claimed: true,
      reclaimable: false,
      claimable: false
    };
  }

  private async resolveActiveRoundId(): Promise<number | null> {
    const key = activePointerKey();
    const map = await this.gql.getStateByKeys(this.config.contractId, [key]);
    const raw = map[key];
    if (!raw) return null;
    const pointer = Number(raw); // stored as id+1; 0/absent = no active round
    if (!Number.isFinite(pointer) || pointer <= 0) return null;
    return pointer - 1;
  }

  /**
   * The chart's series, folded from the indexer's per-bet running pool totals.
   * Chain state cannot answer this at all — it holds only the CURRENT pool per
   * bucket, with no time dimension — which is why the chart was a flat
   * placeholder until the indexer landed.
   *
   * Degrades to null on every failure path (no indexer, unreachable, too little
   * history), and the caller falls back to the labelled placeholder.
   */
  async readPoolSeries(roundId: string, outcomeCount: number): Promise<number[][] | null> {
    const id = parseRoundId(roundId);
    if (id === null || !this.config.indexerUrl) return null;
    try {
      const client = new MagiIndexerClient(this.config.indexerUrl, this.config.contractId);
      const points = await client.readPoolHistory(id);
      return buildOddsSeries(points, outcomeCount);
    } catch {
      return null;
    }
  }

  private async readRoundAsset(id: number): Promise<ContractAsset> {
    const key = rk(id, 'asset');
    const map = await this.gql.getStateByKeys(this.config.contractId, [key]);
    return map[key] === 'hbd' ? 'hbd' : 'hive';
  }

  // Bettors count needs the indexer (getStateByKeys cannot derive it: stakes are
  // keyed by account, and contract state holds no roster to enumerate).
  //
  // Reads the Magi indexer's `lumen_pm_round_summary` view over Hasura. This
  // used to hit `${indexerUrl}/rounds/:id/bettors` on this repo's own Go
  // indexer, which was deleted — its production event source could never be fed,
  // because go-vsc-node's public GraphQL exposes no path to a contract's
  // persisted logs.
  //
  // Still never blocks the read path — a round must render even when the index
  // is down — but a failure now degrades to NULL, not 0. Returning 0 asserted
  // "nobody has bet on this", which is a different and often false claim.
  private async readBettors(indexerUrl: string, id: number): Promise<number | null> {
    try {
      const client = new MagiIndexerClient(indexerUrl, this.config.contractId);
      const summary = await client.readRoundSummary(id);
      // A round the indexer has not seen yet is unknown, not empty: the roll
      // event may simply not have been folded at the time of this read.
      return summary?.bettors ?? null;
    } catch {
      return null;
    }
  }
}

function buildRoundKeys(id: number): string[] {
  const keys = [
    rk(id, 'state'),
    rk(id, 'asset'),
    rk(id, 'pool'),
    rk(id, 'fb'),
    rk(id, 'lock'),
    rk(id, 'settle'),
    rk(id, 'refprice'),
    rk(id, 'win'),
    rk(id, 'price'),
    rk(id, 'vr'),
    rk(id, 'label')
  ];
  BUCKET_DEFS.forEach((_, i) => keys.push(rkOutcomePool(id, i)));
  return keys;
}

function buildPositionKeys(id: number, acct: string): string[] {
  // `settle` + `grace` are read so `reclaimable` can be derived from the SAME
  // rule market/reclaim.go enforces, rather than the UI guessing at a deadline.
  const keys = [
    rkStakeTotal(id, acct),
    rkClaimed(id, acct),
    rk(id, 'state'),
    rk(id, 'win'),
    rk(id, 'settle'),
    rk(id, 'grace')
  ];
  BUCKET_DEFS.forEach((_, i) => keys.push(rkStake(id, acct, i)));
  return keys;
}
