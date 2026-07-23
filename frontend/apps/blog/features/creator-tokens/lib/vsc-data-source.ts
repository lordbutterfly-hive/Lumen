import type {
  Ask,
  AskInput,
  AnswerInput,
  DeliveryRecord,
  HolderPosition,
  Market,
  MyAsksResult,
  PrepayInput,
  Quote,
  ReclaimInput,
  RefundHolderInput,
  RefundInput,
  RegisterMarketInput,
  RenewSubscriptionInput,
  SetCapInput,
  SetFaceInput,
  TransferCreditsInput,
  WalletPositionsResult
} from '../types';
import type { CreatorTokensConfig, CreatorTokensDataSource } from './creator-tokens-data-source';
import {
  MAX_ASK_DEADLINE_BLOCKS,
  MAX_CAP_CREDITS_BASE_UNITS,
  MAX_FACE_BASE_UNITS,
  MAX_PREPAID_PERIODS,
  MIN_ASK_DEADLINE_BLOCKS,
  MIN_CAP_CREDITS_BASE_UNITS,
  MIN_FACE_BASE_UNITS,
  OBS_WINDOW,
  RECLAIM_GRACE_BLOCKS,
  REGISTRATION_FEE_BASE_UNITS,
  SUBSCRIPTION_FEE_BASE_UNITS,
  SUBSCRIPTION_PERIOD_BLOCKS,
  askRateFromObservations,
  baseUnitsToHuman,
  blockToEpochMs,
  canInflowOpen,
  commissionOwedForBaseUnits,
  creditsForAskBaseUnits,
  decodeObservationRing,
  deriveFaceBandBaseUnits,
  deriveGraceExpiresAtBlock,
  derivePhase,
  floorRatioForDisplay,
  humanToBaseUnits,
  refundPayoutBaseUnits,
  settlementRateBaseUnits,
  type AskRateEstimate
} from './contract-math';
import {
  type CustomJsonOp,
  answerPayload,
  askPayload,
  buildOp,
  prepayPayload,
  reclaimPayload,
  refundHolderPayload,
  refundPayload,
  registerPayload,
  renewPayload,
  setCapPayload,
  setFacePayload,
  transferCreditsPayload
} from './vsc/op-builders';
// Side-effect-only import: runs the payload-contract self-test in
// development (see that file's own doc for why it lives here rather than in
// op-builders.ts — importing it FROM op-builders.ts would be circular, since
// this file imports the payload builders FROM op-builders.ts).
import './vsc/payload-contract.selftest';
import {
  CreatorTokensGqlClient,
  buildAskFromParsed,
  getJsonProp,
  isWellFormedDid,
  kBal,
  kCap,
  kEscrow,
  kFace,
  kFaceAnchor,
  kFaceAnchorAt,
  kFaceSetAt,
  kObs,
  kObsIdx,
  kPaidUntil,
  kPaused,
  kRegisteredAt,
  kReserve,
  kSeq,
  kState,
  kSupply,
  parseEscrow,
  toDid,
  toU64,
  unknownMarket,
  STATE_CLOSED
} from './vsc/reads';

// Real, on-chain implementation. Reads live contract state via GraphQL
// getStateByKeys (plumbing + decoding in ./vsc/reads.ts); builds custom_json
// ops for writes (./vsc/op-builders.ts) and signs+broadcasts them through
// whatever `broadcaster` this instance was constructed with. Mirrors
// features/prediction-market/lib/vsc-market-data-source.ts's shape and its
// "no broadcaster wired -> reads work, writes throw" FALLBACK contract
// (assertBroadcaster()/broadcast() below) — but finding C-B fixed the actual
// production wiring: creator-tokens-data-source.ts's
// getCreatorTokensDataSource() now always supplies a real broadcaster
// (./vsc/broadcaster.ts's hiveTransactionBroadcaster) on a provisioned
// build, so this fallback only fires for a caller that constructs
// VscCreatorTokensDataSource directly without one (e.g. a future test).
//
// No shared vsc-gql.ts/op-builders.ts exists for this feature to import at
// the top level (this task owns only the files listed in the brief) — a
// minimal, self-contained GQL client and op builder live under ./vsc/ rather
// than reaching into prediction-market's own lib, which is a different
// feature's own file.

export type Broadcaster = (op: CustomJsonOp) => Promise<string>;

export interface VscCreatorTokensDataSourceDeps {
  config: CreatorTokensConfig;
  gql?: CreatorTokensGqlClient;
  broadcaster?: Broadcaster;
}

const NO_BROADCASTER_MSG = 'VscCreatorTokensDataSource: no broadcaster wired — inject the transaction service';

/** Coerce a wire value to a non-negative integer count; anything malformed reads as 0 (the DTO's own convention — a count field is always an int, never absent, on a healthy DeliveryRecordView). */
function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : 0;
}

export class VscCreatorTokensDataSource implements CreatorTokensDataSource {
  private readonly config: CreatorTokensConfig;
  private readonly gql: CreatorTokensGqlClient;
  private readonly broadcaster?: Broadcaster;

  constructor(deps: VscCreatorTokensDataSourceDeps) {
    this.config = deps.config;
    this.gql = deps.gql ?? new CreatorTokensGqlClient(deps.config.gqlUrl);
    this.broadcaster = deps.broadcaster;
  }

  // ---- reads ----

  async readMarket(creator: string): Promise<Market | null> {
    const keys = [
      kFace(creator),
      kFaceSetAt(creator),
      kFaceAnchor(creator),
      kFaceAnchorAt(creator),
      kCap(creator),
      kSupply(creator),
      kReserve(creator),
      kPaidUntil(creator),
      kState(creator),
      kRegisteredAt(creator),
      kPaused()
    ];
    let state: Record<string, string | null>;
    let head: number | null;
    try {
      [state, head] = await Promise.all([this.gql.getStateByKeys(this.config.contractId, keys), this.gql.getHeadBlock()]);
    } catch {
      return unknownMarket(creator);
    }

    const registeredAtBlock = toU64(state[kRegisteredAt(creator)]);
    if (registeredAtBlock === 0) return null; // never registered — prepay.go's own kRegisteredAt==0 convention

    // Phase is meaningless without a head block to compare paidUntil against
    // — never guess. The read technically "worked" but is unusable, so this
    // is UNKNOWN too, not a silently-wrong phase.
    if (head === null) return unknownMarket(creator);

    return this.buildMarket(
      creator,
      {
        faceBaseUnits: toU64(state[kFace(creator)]),
        faceSetAtBlock: toU64(state[kFaceSetAt(creator)]),
        faceAnchorBaseUnits: toU64(state[kFaceAnchor(creator)]),
        faceAnchorAtBlock: toU64(state[kFaceAnchorAt(creator)]),
        capBaseUnits: toU64(state[kCap(creator)]),
        supplyBaseUnits: toU64(state[kSupply(creator)]),
        reserveBaseUnits: toU64(state[kReserve(creator)]),
        paidUntilBlock: toU64(state[kPaidUntil(creator)]),
        closedStored: state[kState(creator)] === STATE_CLOSED,
        globalInflowPaused: state[kPaused()] === '1',
        registeredAtBlock
      },
      head
    );
  }

  // Shared Market construction, used both by readMarket (from live chain
  // state) and by registerMarket's optimistic PENDING result (from the caller's
  // inputs) so the two can never derive Market fields differently. Pure — no
  // I/O; every argument is already a resolved base-unit value + a real head.
  private buildMarket(
    creator: string,
    s: {
      faceBaseUnits: number;
      faceSetAtBlock: number;
      faceAnchorBaseUnits: number;
      faceAnchorAtBlock: number;
      capBaseUnits: number;
      supplyBaseUnits: number;
      reserveBaseUnits: number;
      paidUntilBlock: number;
      closedStored: boolean;
      globalInflowPaused: boolean;
      registeredAtBlock: number;
    },
    head: number
  ): Market {
    const phase = derivePhase(s.closedStored, s.paidUntilBlock, head);
    const graceExpiresAtBlock = deriveGraceExpiresAtBlock(s.paidUntilBlock);
    const faceBandRaw = deriveFaceBandBaseUnits(s.faceBaseUnits, s.faceSetAtBlock, s.faceAnchorBaseUnits, s.faceAnchorAtBlock, head);
    const canFlow = canInflowOpen(phase, s.globalInflowPaused);

    return {
      creator,
      faceHbd: baseUnitsToHuman(s.faceBaseUnits),
      faceSetAtBlock: s.faceSetAtBlock,
      faceBand: {
        minHbd: baseUnitsToHuman(faceBandRaw.minHbd),
        maxHbd: baseUnitsToHuman(faceBandRaw.maxHbd),
        bandActive: faceBandRaw.bandActive,
        windowEndsAtBlock: faceBandRaw.windowEndsAtBlock
      },
      capCredits: baseUnitsToHuman(s.capBaseUnits),
      supplyCredits: baseUnitsToHuman(s.supplyBaseUnits),
      reserveHbd: baseUnitsToHuman(s.reserveBaseUnits),
      paidUntilBlock: s.paidUntilBlock,
      paidUntilAt: blockToEpochMs(s.paidUntilBlock, head),
      registeredAtBlock: s.registeredAtBlock,
      phase,
      graceExpiresAtBlock,
      graceExpiresAt: blockToEpochMs(graceExpiresAtBlock, head),
      globalInflowPaused: s.globalInflowPaused,
      canPrepay: canFlow,
      canAsk: canFlow,
      refundPricePerCredit: floorRatioForDisplay(s.reserveBaseUnits, s.supplyBaseUnits)
    };
  }

  async readHolderPosition(creator: string, holder: string): Promise<HolderPosition | null> {
    const keys = [kRegisteredAt(creator), kSupply(creator), kReserve(creator), kBal(creator, holder)];
    const state = await this.gql.getStateByKeys(this.config.contractId, keys); // rejects on failure — see interface doc
    if (toU64(state[kRegisteredAt(creator)]) === 0) return null;

    const creditsBaseUnits = toU64(state[kBal(creator, holder)]);
    const supplyBaseUnits = toU64(state[kSupply(creator)]);
    const reserveBaseUnits = toU64(state[kReserve(creator)]);
    const floorBaseUnits = supplyBaseUnits > 0 ? refundPayoutBaseUnits(reserveBaseUnits, creditsBaseUnits, supplyBaseUnits) : 0;
    return { creator, holder, creditsHeld: baseUnitsToHuman(creditsBaseUnits), floorValueHbd: baseUnitsToHuman(floorBaseUnits) };
  }

  async readWallet(holder: string): Promise<WalletPositionsResult> {
    // No reverse "which creators has this holder touched" index exists
    // on-chain — indexer-backed (spec §2.5), never blocks the read path.
    // WIRING-VERIFY (deploy): endpoint shape assumed, no indexer deployed yet.
    //
    // RULE unavailable ≠ empty: a bare [] used to conflate "the indexer read
    // failed / isn't configured" with "this holder genuinely holds nothing" —
    // for a BALANCE view that is a lie. Resolve a discriminated result so the
    // consumer can render "couldn't load your holdings" distinctly from "you
    // hold nothing yet".
    if (!this.config.indexerUrl) return { positions: [], unavailable: true };
    try {
      const res = await fetch(`${this.config.indexerUrl}/holders/${encodeURIComponent(holder)}/positions`);
      if (!res.ok) return { positions: [], unavailable: true };
      const json: unknown = await res.json();
      const positions = getJsonProp(json, 'positions');
      if (!Array.isArray(positions)) return { positions: [], unavailable: true };
      const creators = positions.map((p) => getJsonProp(p, 'creator')).filter((c): c is string => typeof c === 'string');
      const results = await Promise.all(creators.map((creator) => this.readHolderPosition(creator, holder).catch(() => null)));
      return { positions: results.filter((p): p is HolderPosition => p !== null && p.creditsHeld > 0), unavailable: false };
    } catch {
      return { positions: [], unavailable: true };
    }
  }

  async readCreatorAsks(creator: string, opts?: { limit?: number }): Promise<Ask[]> {
    const limit = opts?.limit ?? 50;
    const seqState = await this.gql.getStateByKeys(this.config.contractId, [kSeq(creator)]);
    const seqCount = toU64(seqState[kSeq(creator)]);
    if (seqCount === 0) return [];

    const start = Math.max(0, seqCount - limit);
    const seqs: number[] = [];
    for (let s = start; s < seqCount; s++) seqs.push(s);

    const [state, head] = await Promise.all([this.gql.getStateByKeys(this.config.contractId, seqs.map((s) => kEscrow(creator, s))), this.gql.getHeadBlock()]);

    const asks: Ask[] = [];
    for (const s of seqs) {
      const raw = state[kEscrow(creator, s)];
      if (!raw) continue;
      const parsed = parseEscrow(raw);
      if (!parsed) continue;
      asks.push(buildAskFromParsed(creator, s, parsed, head));
    }
    return asks.sort((a, b) => a.deadlineBlock - b.deadlineBlock);
  }

  async readMyAsks(asker: string): Promise<MyAsksResult> {
    // Indexer-backed for the same reason readWallet is: no reverse
    // asker->{creator,seq} index exists on-chain. WIRING-VERIFY (deploy).
    // Same unavailable-vs-empty discriminator as readWallet (RULE: unavailable
    // ≠ empty) — a bare [] can't tell "the indexer is down" from "you've asked
    // no one".
    if (!this.config.indexerUrl) return { asks: [], unavailable: true };
    try {
      const res = await fetch(`${this.config.indexerUrl}/askers/${encodeURIComponent(asker)}/asks`);
      if (!res.ok) return { asks: [], unavailable: true };
      const json: unknown = await res.json();
      const refs = getJsonProp(json, 'asks');
      if (!Array.isArray(refs)) return { asks: [], unavailable: true };
      const pairs = refs
        .map((r) => ({ creator: getJsonProp(r, 'creator'), seq: getJsonProp(r, 'seq') }))
        .filter((p): p is { creator: string; seq: number } => typeof p.creator === 'string' && typeof p.seq === 'number');

      const keys = pairs.map((p) => kEscrow(p.creator, p.seq));
      const [state, head] = await Promise.all([this.gql.getStateByKeys(this.config.contractId, keys), this.gql.getHeadBlock()]);
      const asks: Ask[] = [];
      for (const p of pairs) {
        const raw = state[kEscrow(p.creator, p.seq)];
        const parsed = raw ? parseEscrow(raw) : null;
        if (parsed) asks.push(buildAskFromParsed(p.creator, p.seq, parsed, head));
      }
      return { asks: asks.sort((a, b) => b.deadlineBlock - a.deadlineBlock), unavailable: false };
    } catch {
      return { asks: [], unavailable: true };
    }
  }

  async readDeliveryRecord(creator: string): Promise<DeliveryRecord> {
    // Never contract state (SPEC §1.7.1) — always indexer, always resolves
    // (never rejects), degrading to source:'unavailable'. WIRING-VERIFY (deploy).
    //
    // WIRE CONTRACT (pin-to-DTO fix): this reads the indexer's ACTUAL
    // DeliveryRecordView shape (/mnt/o/CREATOR-TOKENS/indexer/api.go) — flat
    // answered/missed/pending COUNTS + responseBlocks + the M1 distinctAskers/
    // selfDealtExcluded fields. The prior version read a `windows` array that
    // the DTO has never had, so every call fell through to the empty
    // 'unavailable' record and the delivery record — the product's central
    // trust signal — could never render even when the indexer was healthy.
    const empty: DeliveryRecord = {
      creator,
      answeredCount: 0,
      missedCount: 0,
      pendingCount: 0,
      responseBlocks: [],
      distinctAskers: 0,
      selfDealtExcluded: 0,
      source: 'unavailable'
    };
    if (!this.config.indexerUrl) return empty;
    try {
      const res = await fetch(`${this.config.indexerUrl}/creators/${encodeURIComponent(creator)}/delivery`);
      if (!res.ok) return empty;
      const json: unknown = await res.json();
      // A healthy indexer always echoes `creator` (rec.Creator); its absence
      // means this is not a DeliveryRecordView (error body / wrong endpoint) —
      // unavailable, never a fabricated all-zero "answered nothing".
      if (typeof getJsonProp(json, 'creator') !== 'string') return empty;
      const rawBlocks = getJsonProp(json, 'responseBlocks');
      const responseBlocks = Array.isArray(rawBlocks)
        ? rawBlocks.map((b) => Number(b)).filter((n): n is number => Number.isFinite(n))
        : [];
      return {
        creator,
        answeredCount: toCount(getJsonProp(json, 'answeredCount')),
        missedCount: toCount(getJsonProp(json, 'missedCount')),
        pendingCount: toCount(getJsonProp(json, 'pendingCount')),
        responseBlocks,
        distinctAskers: toCount(getJsonProp(json, 'distinctAskers')),
        selfDealtExcluded: toCount(getJsonProp(json, 'selfDealtExcluded')),
        source: 'indexer'
      };
    } catch {
      return empty;
    }
  }

  async readQuote(creator: string): Promise<Quote> {
    const obsKeys = Array.from({ length: OBS_WINDOW }, (_, i) => kObs(creator, i));
    const [state, head] = await Promise.all([this.gql.getStateByKeys(this.config.contractId, [kFace(creator), kObsIdx(creator), ...obsKeys]), this.gql.getHeadBlock()]);

    const faceBaseUnits = toU64(state[kFace(creator)]);
    const commissionHbd = baseUnitsToHuman(commissionOwedForBaseUnits(faceBaseUnits));
    const base: Omit<Quote, 'rate' | 'creditsRequired' | 'creditsRequiredBaseUnits' | 'oracleStatus' | 'asOfBlock'> = {
      creator,
      faceHbd: baseUnitsToHuman(faceBaseUnits),
      commissionHbd
    };
    const unpriced = (oracleStatus: Quote['oracleStatus'], asOfBlock: number): Quote => ({
      ...base,
      rate: null,
      creditsRequired: null,
      creditsRequiredBaseUnits: null,
      oracleStatus,
      asOfBlock
    });

    if (head === null) return unpriced('unavailable', 0);

    // ask.go: core.Ask (and this preview's real counterpart, core.Ask's
    // wrapper `quote`) both check `face > 0` BEFORE ever computing a
    // settlement rate ("creator has no face price set") — no PAR fallback
    // rescues a market with no posted price at all. Checked here, ahead of
    // the TWAP/PAR branch below, for the same reason.
    if (faceBaseUnits <= 0) return unpriced('unavailable', head);

    const obsIdxCount = toU64(state[kObsIdx(creator)]);
    const points = decodeObservationRing(obsKeys.map((k) => state[k]), obsIdxCount);
    // C-C fix: a corrupt/absent observation ring used to make this preview
    // refuse to price at all (oracleStatus/rate/creditsRequired all null)
    // and ask() would hard-throw on it. On the real contract, ask.go's
    // SettlementRate falls back to PAR on ANY non-nil AskRate error —
    // including the ErrState a corrupt ring produces (twap.go) — so a
    // corrupt/empty ring must fall into the SAME PAR path as
    // 'insufficient_observations' below, not an early, harder refusal that
    // disagrees with what ask() would actually do.
    const estimate: AskRateEstimate = points === null ? { rateBaseUnits: null, status: 'unavailable' } : askRateFromObservations(points, head);

    // C-C: port core.Ask's own SettlementRate (ask.go) — the TWAP when
    // AskRate's guards pass, or PAR when they don't. PAR is the DEFAULT
    // state for a live deployment today (no DEX pool feeds RecordObs yet),
    // so this preview must price it, and ask() below must actually be able
    // to broadcast at it — previously a non-'ok' oracleStatus mapped to
    // rate:null/creditsRequired:null and ask() hard-threw before ever
    // reaching the chain (vsc-data-source.ts's old ask(), see the report).
    const settlement = settlementRateBaseUnits(estimate);
    const creditsRequiredBaseUnits = creditsForAskBaseUnits(faceBaseUnits, settlement.rateBaseUnits);
    return {
      ...base,
      rate: baseUnitsToHuman(settlement.rateBaseUnits),
      creditsRequired: baseUnitsToHuman(creditsRequiredBaseUnits),
      creditsRequiredBaseUnits,
      // oracleStatus keeps reporting AskRate's OWN status (not collapsed to
      // 'ok' just because a price is now always available) — this is what
      // lets the UI explain WHY the price shown is PAR rather than a live
      // TWAP (types.ts's own doc); it never gates whether pricing/ask()
      // succeeds anymore.
      oracleStatus: estimate.status,
      asOfBlock: head
    };
  }

  // ---- writes ----

  async registerMarket(input: RegisterMarketInput): Promise<Market> {
    this.assertBroadcaster();
    const faceBaseUnits = humanToBaseUnits(input.faceHbd);
    const capBaseUnits = humanToBaseUnits(input.capCredits);
    // market.go:132-134 (core.Register). Zero-extra-read: fixed protocol
    // constants, no chain read needed (this is a brand-new market — no band
    // exists yet, unlike setFace's guard below).
    if (faceBaseUnits < MIN_FACE_BASE_UNITS || faceBaseUnits > MAX_FACE_BASE_UNITS) {
      throw new Error('VscCreatorTokensDataSource: face out of range [MinFace, MaxFace]');
    }
    // market.go:135-137 (core.Register).
    if (capBaseUnits < MIN_CAP_CREDITS_BASE_UNITS || capBaseUnits > MAX_CAP_CREDITS_BASE_UNITS) {
      throw new Error('VscCreatorTokensDataSource: cap out of range [MinCap, MaxCap]');
    }
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'register',
      payload: registerPayload(faceBaseUnits, capBaseUnits, REGISTRATION_FEE_BASE_UNITS),
      hbdLegBaseUnits: REGISTRATION_FEE_BASE_UNITS,
      activeAuth: input.creator,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
    // A Hive broadcast resolves at L1-accept — BEFORE the L2 contract executes
    // — so an immediate readMarket() returns PRE-execution state, here `null`
    // ("never registered"). It is NOT true that the market "did not appear":
    // it WILL, once L2 runs. Never throw on that racy read and never present
    // it as the outcome. Return the EXPECTED post-state, flagged `pending`, and
    // let useCreatorToken's poll reconcile it against real chain state (mirrors
    // ask()'s `:pending` Ask and prediction-market's optimistic placeBet).
    const head = await this.gql.getHeadBlock();
    if (head === null) return { ...unknownMarket(input.creator), pending: true };
    return {
      ...this.buildMarket(
        input.creator,
        {
          faceBaseUnits,
          faceSetAtBlock: head,
          faceAnchorBaseUnits: faceBaseUnits,
          faceAnchorAtBlock: head,
          capBaseUnits,
          supplyBaseUnits: 0,
          reserveBaseUnits: 0,
          // core.Register grants the first subscription period (mock parity:
          // paidUntil = head + SubscriptionPeriod).
          paidUntilBlock: head + SUBSCRIPTION_PERIOD_BLOCKS,
          closedStored: false,
          globalInflowPaused: false,
          registeredAtBlock: head
        },
        head
      ),
      pending: true
    };
  }

  async renewSubscription(input: RenewSubscriptionInput): Promise<Market> {
    this.assertBroadcaster();
    // market.go:207-209 (core.Renew). Zero-extra-read: bounds periods before
    // any arithmetic, exactly mirroring core's own ordering (this check runs
    // before core computes newPaidUntil).
    if (input.periods < 1 || input.periods > MAX_PREPAID_PERIODS) {
      throw new Error('VscCreatorTokensDataSource: periods out of range [1, MaxPrepaidPeriods]');
    }
    // market.go:194-199 (core.Renew) -> RequireInflowOpen (finding M-d) — the
    // SAME phase+pause gate prepay()/ask() already read the market for.
    // Renew is permissionless (any fan may pay), but the MARKET must still
    // be ACTIVE/OVERDUE and not globally paused — a lapsed-past-grace or
    // CLOSED market cannot be "renewed" back to life (SPEC §1.7.5 routes
    // that case through Register instead). Skipped — never blocked — when
    // the market can't be read or was never registered, same "band check
    // only, not an existence check" reasoning as every other guard in this
    // file that reads a fresh Market. market.canPrepay/canAsk are the exact
    // same RequireInflowOpen boolean (readMarket computes one `canFlow` and
    // assigns it to both), so reusing canPrepay here rather than importing
    // canInflowOpen a second time keeps this in lockstep with those two
    // guards by construction.
    //
    // Also fetches head independently (not derived from readMarket, which
    // does not expose the head it used internally) for the newPaidUntil
    // bound check below — market.go:218-235 (core.Renew): newPaidUntil =
    // max(currentPaidUntil, head) + periods*SubscriptionPeriod, rejected
    // outright (never clamped) if it lands further than MaxPrepaidPeriods
    // ahead of `head`. The two reads race by at most the width of this
    // Promise.all, which cannot matter here: this is a client-side
    // pre-check only, the chain re-validates independently at the real
    // execution block regardless of what this call observed.
    const [market, head] = await Promise.all([this.readMarket(input.creator), this.gql.getHeadBlock()]);
    if (market && market.phase !== 'UNKNOWN') {
      if (!market.canPrepay) {
        throw new Error('VscCreatorTokensDataSource: market inflow is not open (frozen, closed, or globally paused)');
      }
      if (head !== null) {
        const base = Math.max(market.paidUntilBlock, head);
        const newPaidUntil = base + input.periods * SUBSCRIPTION_PERIOD_BLOCKS;
        const maxAllowed = head + MAX_PREPAID_PERIODS * SUBSCRIPTION_PERIOD_BLOCKS;
        if (newPaidUntil > maxAllowed) {
          throw new Error('VscCreatorTokensDataSource: extension exceeds MaxPrepaidPeriods ahead of now');
        }
      }
    }
    const paidBaseUnits = SUBSCRIPTION_FEE_BASE_UNITS * input.periods;
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'renew',
      payload: renewPayload(toDid(input.creator), input.periods, paidBaseUnits),
      hbdLegBaseUnits: paidBaseUnits,
      activeAuth: input.caller,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
    // Optimistic PENDING result (see registerMarket): project the extended
    // paidUntil locally from the pre-broadcast read rather than re-reading
    // PRE-execution state. If the pre-read was unusable (null/UNKNOWN/no head)
    // we cannot project it — surface an UNKNOWN pending market so the UI shows
    // "unconfirmed", never a fabricated value.
    if (!market || market.phase === 'UNKNOWN' || head === null) {
      return { ...(market ?? unknownMarket(input.creator)), pending: true };
    }
    const newPaidUntilBlock = Math.max(market.paidUntilBlock, head) + input.periods * SUBSCRIPTION_PERIOD_BLOCKS;
    const renewedPhase = derivePhase(false, newPaidUntilBlock, head);
    const graceExpiresAtBlock = deriveGraceExpiresAtBlock(newPaidUntilBlock);
    const canFlow = canInflowOpen(renewedPhase, market.globalInflowPaused);
    return {
      ...market,
      paidUntilBlock: newPaidUntilBlock,
      paidUntilAt: blockToEpochMs(newPaidUntilBlock, head),
      graceExpiresAtBlock,
      graceExpiresAt: blockToEpochMs(graceExpiresAtBlock, head),
      phase: renewedPhase,
      canPrepay: canFlow,
      canAsk: canFlow,
      pending: true
    };
  }

  async setFace(input: SetFaceInput): Promise<Market> {
    this.assertBroadcaster();
    const newFaceBaseUnits = humanToBaseUnits(input.newFaceHbd);
    // market.go:282-284 (core.SetFace). Zero-extra-read: fixed protocol
    // range, independent of the anti-rug band below — both are separate,
    // unconditional AND checks on-chain.
    if (newFaceBaseUnits < MIN_FACE_BASE_UNITS || newFaceBaseUnits > MAX_FACE_BASE_UNITS) {
      throw new Error('VscCreatorTokensDataSource: face out of range [MinFace, MaxFace]');
    }
    // market.go:303-331 (core.SetFace) — the 2x/7-day anti-rug band, anchored
    // to a rolling WINDOW (see contract-math.ts's deriveFaceBandBaseUnits doc
    // for the same-day fix this mirrors; the STALE pre-fix port compared
    // against the last change instead). Requires a real market read, unlike
    // the bound check above. Compared in HUMAN units directly against
    // Market.faceBand (already human-converted by readMarket) to avoid a
    // needless base<->human round-trip. Skipped — never blocked — when the
    // market can't be read or was never registered: this is a band check
    // only, never the excluded market-existence guard.
    const market = await this.readMarket(input.creator);
    if (market && market.phase !== 'UNKNOWN') {
      if (input.newFaceHbd < market.faceBand.minHbd || input.newFaceHbd > market.faceBand.maxHbd) {
        throw new Error('VscCreatorTokensDataSource: face change exceeds the 2x/7-day band (measured against the window anchor, not the last change)');
      }
    }
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'setFace',
      payload: setFacePayload(newFaceBaseUnits),
      // C1 fix: the contract now requires ACTIVE authority on every write
      // entrypoint (a posting key is the low-trust key this app is
      // routinely delegated; a posting-signed setFace would let a merely-
      // delegated key reprice a creator's market). Was postingAuth.
      activeAuth: input.creator,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
    // Optimistic PENDING result (see registerMarket): overlay the new face on
    // the pre-broadcast read (every OTHER field is unchanged by setFace). The
    // derived faceBand shifts with the new face, but a slightly-stale band on a
    // clearly-pending result is reconciled by the next poll.
    if (!market || market.phase === 'UNKNOWN') {
      return { ...(market ?? unknownMarket(input.creator)), pending: true };
    }
    return { ...market, faceHbd: input.newFaceHbd, pending: true };
  }

  async setCap(input: SetCapInput): Promise<Market> {
    this.assertBroadcaster();
    const newCapBaseUnits = humanToBaseUnits(input.newCapCredits);
    // market.go:350-352 (core.SetCap). Zero-extra-read: fixed protocol range
    // only — the separate cap-vs-current-supply guard (market.go:354-357)
    // needs an extra read (kSupply) and is explicitly out of scope for this
    // pass (see the report: "cap-vs-supply" is on the excluded list).
    if (newCapBaseUnits < MIN_CAP_CREDITS_BASE_UNITS || newCapBaseUnits > MAX_CAP_CREDITS_BASE_UNITS) {
      throw new Error('VscCreatorTokensDataSource: cap out of range [MinCap, MaxCap]');
    }
    // Read the CURRENT market BEFORE broadcasting so the optimistic PENDING
    // result below overlays the new cap on real prior state — not a racy
    // post-write read (which returns PRE-execution state, see registerMarket).
    const market = await this.readMarket(input.creator);
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'setCap',
      payload: setCapPayload(newCapBaseUnits),
      // C1 fix: active authority required on every write — see setFace's
      // identical comment above. Was postingAuth.
      activeAuth: input.creator,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
    if (!market || market.phase === 'UNKNOWN') {
      return { ...(market ?? unknownMarket(input.creator)), pending: true };
    }
    return { ...market, capCredits: input.newCapCredits, pending: true };
  }

  async prepay(input: PrepayInput): Promise<HolderPosition> {
    this.assertBroadcaster();
    const hbdBaseUnits = humanToBaseUnits(input.hbdAmount);
    // prepay.go:54-56 (core.Prepay). Zero-extra-read.
    if (hbdBaseUnits <= 0) {
      throw new Error('VscCreatorTokensDataSource: hbdAmount must be positive');
    }
    // prepay.go:50-52 -> market.go:73-83 RequireInflowOpen (core.Prepay) —
    // the canPrepay gate. Requires a real market read (Market.canPrepay is
    // exactly RequireInflowOpen's own result, see readMarket() above).
    // Skipped — never blocked — when the market can't be read or was never
    // registered, same "band check only, not an existence check" reasoning
    // as setFace's guard.
    const market = await this.readMarket(input.creator);
    if (market && market.phase !== 'UNKNOWN') {
      if (!market.canPrepay) {
        throw new Error('VscCreatorTokensDataSource: market inflow is not open (frozen, closed, or globally paused)');
      }
      // prepay.go:68-75 (core.Prepay) — ErrCap: supply+hbdPaid must not
      // exceed the market's cap (finding M-b). Compared in base units (not
      // the human-converted Market fields directly) to avoid compounding a
      // second round of 3-decimal rounding on top of the two conversions
      // readMarket() already performed — mirrors mock-data-source.ts's own
      // base-unit prepay guard.
      const supplyBaseUnits = humanToBaseUnits(market.supplyCredits);
      const capBaseUnits = humanToBaseUnits(market.capCredits);
      if (supplyBaseUnits + hbdBaseUnits > capBaseUnits) {
        throw new Error('VscCreatorTokensDataSource: prepay would exceed the market cap');
      }
    }
    // Read the CURRENT position BEFORE broadcasting (readHolderPosition rejects
    // on read failure — catch it) so the optimistic result is built from real
    // prior credits, never a racy post-write read.
    const priorPosition = await this.readHolderPosition(input.creator, input.holder).catch(() => null);
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'prepay',
      payload: prepayPayload(toDid(input.creator), hbdBaseUnits),
      hbdLegBaseUnits: hbdBaseUnits,
      activeAuth: input.holder,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
    // Optimistic PENDING result (see registerMarket): credit the prepay locally
    // (PAR: +hbdAmount credits, human units) rather than re-reading
    // PRE-execution state — which would show the OLD balance and read as
    // "you paid HBD, got 0 credits". floorValueHbd is best-effort (prior
    // value); the poll reconciles the exact floor.
    const priorCredits = priorPosition?.creditsHeld ?? 0;
    return {
      creator: input.creator,
      holder: input.holder,
      creditsHeld: priorCredits + input.hbdAmount,
      floorValueHbd: priorPosition?.floorValueHbd ?? 0,
      pending: true
    };
  }

  async ask(input: AskInput): Promise<Ask> {
    this.assertBroadcaster();
    if (input.deadlineBlocks < MIN_ASK_DEADLINE_BLOCKS) throw new Error('VscCreatorTokensDataSource: deadline below MinAskDeadline');
    // ask.go enforces BOTH bounds on-chain; without this the tx broadcasts,
    // reverts, and the asker pays RC for a rejection we could see locally.
    if (input.deadlineBlocks > MAX_ASK_DEADLINE_BLOCKS) throw new Error('VscCreatorTokensDataSource: deadline above MaxAskDeadline');
    // ask.go:233-238 (core.Ask) — contentHash validation, mirroring
    // answer()'s identical guard on answerHash below (finding M-c). Zero-
    // extra-read.
    if (input.contentHash === '') {
      throw new Error('VscCreatorTokensDataSource: contentHash must not be empty');
    }
    if (input.contentHash.includes('|')) {
      throw new Error("VscCreatorTokensDataSource: contentHash must not contain '|'");
    }
    // ask.go:239-244 (core.Ask) — reject a missing/zero maxCredits cap
    // client-side (finding C-D / the report's item #5) rather than letting
    // an effectively-unlimited-spend call reach the chain: this is the
    // asker's own signed cap protecting against a creator spiking `face`
    // between signing and execution (see AskInput.maxCreditsBaseUnits's own
    // doc) — a call that arrives with no real cap defeats the whole point of
    // the guard existing, whether or not core would also catch it.
    if (!Number.isFinite(input.maxCreditsBaseUnits) || input.maxCreditsBaseUnits <= 0) {
      throw new Error('VscCreatorTokensDataSource: maxCreditsBaseUnits must be > 0');
    }
    // ask.go:255-257 -> market.go:73-83 RequireInflowOpen (core.Ask) — the
    // canAsk gate, identical in shape to prepay()'s canPrepay guard above
    // (same RequireInflowOpen chokepoint on the Go side, same Market field
    // pair on this side). Skipped — never blocked — when the market can't be
    // read or was never registered; see prepay()'s comment for why.
    const market = await this.readMarket(input.creator);
    if (market && market.phase !== 'UNKNOWN' && !market.canAsk) {
      throw new Error('VscCreatorTokensDataSource: market inflow is not open (frozen, closed, or globally paused)');
    }
    // C-C fix: core.Ask's own SettlementRate NEVER fails — it settles at PAR
    // whenever the TWAP's guards don't pass (the default state today, no DEX
    // pool wired) — so readQuote() now always returns a priced
    // creditsRequiredBaseUnits once a face price exists, regardless of
    // oracleStatus. The only genuine block left is a real read failure or a
    // market with no face price at all, both of which surface as
    // creditsRequiredBaseUnits === null. Previously this method hard-threw
    // on any non-'ok' oracleStatus, which — since no DEX feed exists yet —
    // meant EVERY ask on a real deployment reverted before ever reaching the
    // chain.
    const quote = await this.readQuote(input.creator);
    if (quote.creditsRequiredBaseUnits === null) {
      throw new Error(`VscCreatorTokensDataSource: unable to price this ask (${quote.oracleStatus})`);
    }
    // ask.go:295-297 (core.Ask) — creditsSpent > maxCredits, checked
    // client-side against the SAME quote fetched immediately above (so this
    // can only fire when the ask was already, definitely going to revert on
    // the chain's own identical check) — the MEDIUM-severity theme this
    // whole file already applies (fail fast locally rather than spend RC on
    // a guaranteed revert).
    if (quote.creditsRequiredBaseUnits > input.maxCreditsBaseUnits) {
      throw new Error('VscCreatorTokensDataSource: settlement price exceeds maxCreditsBaseUnits');
    }
    // C-D fix: faceHbd is human-scaled and was previously round-tripped
    // through humanToBaseUnits for the commission calc — unaffected by this
    // fix, left as-is (not part of the cited defect: the mismatch was
    // maxCredits' UNIT, not the commission leg).
    const commissionBaseUnits = commissionOwedForBaseUnits(humanToBaseUnits(quote.faceHbd));
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'ask',
      payload: askPayload(
        toDid(input.creator),
        input.contentHash,
        input.deadlineBlocks,
        commissionBaseUnits,
        input.maxCreditsBaseUnits
      ),
      hbdLegBaseUnits: commissionBaseUnits,
      activeAuth: input.asker,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
    // The contract assigns `seq` server-side; the frontend cannot know it
    // before the tx lands. Return an optimistic placeholder — the caller
    // must re-read readCreatorAsks() to get the real seq once confirmed. This
    // is the canonical PENDING pattern the Market/HolderPosition writes now
    // mirror: unconfirmed both structurally (seq -1, id `:pending`) and via
    // the explicit `pending` flag.
    return {
      id: `${input.creator}:pending`,
      creator: input.creator,
      seq: -1,
      asker: input.asker,
      creditsEscrowed: quote.creditsRequired ?? 0,
      deadlineBlock: quote.asOfBlock + input.deadlineBlocks,
      deadlineAt: blockToEpochMs(quote.asOfBlock + input.deadlineBlocks, quote.asOfBlock),
      reclaimableAtBlock: quote.asOfBlock + input.deadlineBlocks + RECLAIM_GRACE_BLOCKS,
      reclaimableAt: blockToEpochMs(quote.asOfBlock + input.deadlineBlocks + RECLAIM_GRACE_BLOCKS, quote.asOfBlock),
      status: 'awaiting',
      contentHash: input.contentHash,
      answerHash: null,
      pending: true
    };
  }

  async answer(input: AnswerInput): Promise<Ask> {
    this.assertBroadcaster();
    // ask.go:354-356 (core.Answer). Zero-extra-read.
    if (input.answerHash === '') {
      throw new Error('VscCreatorTokensDataSource: answerHash must not be empty');
    }
    // ask.go:357-359 (core.Answer). Zero-extra-read.
    if (input.answerHash.includes('|')) {
      throw new Error("VscCreatorTokensDataSource: answerHash must not contain '|'");
    }
    // ask.go:368-370 (core.Answer) — the answer half of the I6 disjoint
    // window (block <= deadline). Needs the CURRENT chain head, fetched
    // fresh rather than trusting any cached value the caller might be
    // holding — a stale head could let this guard pass locally on a call
    // that would still revert on-chain a moment later. Deliberately does
    // NOT re-read the escrow itself (kEscrow) to get the deadline — that
    // would incidentally implement the excluded escrow-existence check;
    // AnswerInput.deadlineBlock (extended 2026-07-20) carries it instead,
    // sourced from the Ask the caller already has.
    const head = await this.gql.getHeadBlock();
    if (head === null) {
      throw new Error('VscCreatorTokensDataSource: cannot verify the answer window (chain head unavailable)');
    }
    if (head > input.deadlineBlock) {
      throw new Error('VscCreatorTokensDataSource: answer window closed');
    }
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'answer',
      payload: answerPayload(input.seq, input.answerHash),
      // C1 fix: active authority required on every write — see setFace's
      // identical comment above. Was postingAuth.
      activeAuth: input.creator,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
    // Optimistic: the read-back is pre-L2-execution, so project the ask to
    // answered and flag it pending — the poll reconciles against real state.
    // (Completes fix 5; the stall left answer/reclaim as stale read-backs.)
    const answered = await this.readOneAsk(input.creator, input.seq);
    return { ...answered, status: 'answered', answerHash: input.answerHash, pending: true };
  }

  async reclaim(input: ReclaimInput): Promise<Ask> {
    this.assertBroadcaster();
    // ask.go:414-416 (core.Reclaim) — the reclaim half of the I6 disjoint
    // window (block > deadline+ReclaimGrace). Same fresh-head, no-escrow-read
    // reasoning as answer()'s identical guard above; ReclaimInput.deadlineBlock
    // was extended 2026-07-20 to carry the escrow's deadline for the same reason.
    const head = await this.gql.getHeadBlock();
    if (head === null) {
      throw new Error('VscCreatorTokensDataSource: cannot verify the reclaim window (chain head unavailable)');
    }
    if (head <= input.deadlineBlock + RECLAIM_GRACE_BLOCKS) {
      throw new Error('VscCreatorTokensDataSource: reclaim window not open');
    }
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'reclaim',
      payload: reclaimPayload(toDid(input.creator), input.seq),
      // C1 fix: active authority required on every write — see setFace's
      // identical comment above. Was postingAuth.
      activeAuth: input.asker,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
    // Optimistic: project to reclaimed and flag pending (see answer()).
    const reclaimed = await this.readOneAsk(input.creator, input.seq);
    return { ...reclaimed, status: 'reclaimed', pending: true };
  }

  async refund(input: RefundInput): Promise<HolderPosition> {
    this.assertBroadcaster();
    // refund.go:105-107 (core.Refund). Zero-extra-read.
    if (humanToBaseUnits(input.credits) <= 0) {
      throw new Error('VscCreatorTokensDataSource: credits must be positive');
    }
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'refund',
      payload: refundPayload(toDid(input.creator), humanToBaseUnits(input.credits)),
      // C1 fix: active authority required on every write — see setFace's
      // identical comment above. Was postingAuth.
      activeAuth: input.holder,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
    // Optimistic: the read-back is pre-L2, so project the credit reduction and
    // flag pending rather than show the pre-refund balance as the outcome.
    const position = await this.readHolderPosition(input.creator, input.holder);
    if (!position) throw new Error(`VscCreatorTokensDataSource: no such market ${input.creator}`);
    return { ...position, creditsHeld: Math.max(0, position.creditsHeld - input.credits), pending: true };
  }

  async refundHolder(input: RefundHolderInput): Promise<HolderPosition> {
    this.assertBroadcaster();
    // finding M-e: `holder` is the actual payout DESTINATION (never the
    // caller — refund.go's own "can only ever pay the rightful owner, never
    // the caller"), distinct from every other write's account fields, which
    // are all either the signer or a market identifier. core's own
    // validAccount is only a '|' guard, run AFTER the tx has already spent
    // the caller's RC — reject a malformed destination client-side first so
    // a broadcast can never strand a payout at an address the contract
    // would have accepted but that means nothing.
    const holderDid = toDid(input.holder);
    if (!isWellFormedDid(holderDid)) {
      throw new Error('VscCreatorTokensDataSource: holder account is not well-formed');
    }
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'refundHolder',
      payload: refundHolderPayload(toDid(input.creator), holderDid),
      // C1 fix: active authority required on every write — see setFace's
      // identical comment above. Was postingAuth.
      activeAuth: input.caller,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
    // Optimistic: refundHolder pays out the holder's ENTIRE balance, so project
    // creditsHeld to 0 and flag pending (see refund()).
    const position = await this.readHolderPosition(input.creator, input.holder);
    if (!position) throw new Error(`VscCreatorTokensDataSource: no such market ${input.creator}`);
    return { ...position, creditsHeld: 0, pending: true };
  }

  async transferCredits(input: TransferCreditsInput): Promise<void> {
    this.assertBroadcaster();
    const toDidAccount = toDid(input.to);
    // prepay.go:115-117 (core.TransferCredits). Zero-extra-read. Compared as
    // DIDs (not the raw input strings) so an inconsistently-prefixed pair
    // (e.g. "alice" vs "hive:alice", which core would treat as the SAME
    // account) is still caught here rather than sailing through as
    // "different" only to collide once toDid() is applied on the wire.
    if (toDid(input.from) === toDidAccount) {
      throw new Error('VscCreatorTokensDataSource: from and to must be different accounts');
    }
    // prepay.go:118-120 (core.TransferCredits). Zero-extra-read.
    if (humanToBaseUnits(input.amount) <= 0) {
      throw new Error('VscCreatorTokensDataSource: amount must be positive');
    }
    // finding M-e: `to` is a genuine third-party DESTINATION distinct from
    // the signer (`from`) — same "reject a malformed destination before it
    // can strand funds" reasoning as refundHolder's holder guard above.
    if (!isWellFormedDid(toDidAccount)) {
      throw new Error('VscCreatorTokensDataSource: destination account is not well-formed');
    }
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'transfer', // the wasm export is `transfer`, not `transferCredits`
      payload: transferCreditsPayload(toDid(input.creator), toDidAccount, humanToBaseUnits(input.amount)),
      // C1 fix: active authority required on every write — see setFace's
      // identical comment above. Was postingAuth.
      activeAuth: input.from,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
  }

  private assertBroadcaster(): void {
    if (!this.broadcaster) throw new Error(NO_BROADCASTER_MSG);
  }

  private async broadcast(op: CustomJsonOp): Promise<string> {
    if (!this.broadcaster) throw new Error(NO_BROADCASTER_MSG);
    return this.broadcaster(op);
  }

  private async readOneAsk(creator: string, seq: number): Promise<Ask> {
    const [state, head] = await Promise.all([this.gql.getStateByKeys(this.config.contractId, [kEscrow(creator, seq)]), this.gql.getHeadBlock()]);
    const raw = state[kEscrow(creator, seq)];
    const parsed = raw ? parseEscrow(raw) : null;
    if (!parsed) throw new Error(`VscCreatorTokensDataSource: no such escrow ${creator}:${seq}`);
    return buildAskFromParsed(creator, seq, parsed, head);
  }
}
