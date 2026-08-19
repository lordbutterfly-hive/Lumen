import type {
  Ask,
  AskInput,
  AnswerInput,
  BuyInput,
  BuyQuote,
  ClaimTradeFeesInput,
  CloseIfDrainedInput,
  CreateOfferingInput,
  DeclineInput,
  DeleteOfferingInput,
  DeliveryRecord,
  CreatorSummary,
  Offering,
  PricePoint,
  RateInput,
  SetOfferingPriceInput,
  SetOfferingTitleInput,
  HolderPosition,
  Market,
  MyAsksResult,
  Quote,
  ReclaimInput,
  RefundHolderInput,
  RefundInput,
  RegisterMarketInput,
  RenewSubscriptionInput,
  RetireInput,
  SellInput,
  SellQuote,
  SetCapInput,
  SetFaceInput,
  TransferTokensInput,
  WalletPositionsResult,
  WithdrawTreasuryInput
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
  SUBSCRIPTION_FEE_BASE_UNITS,
  SUBSCRIPTION_PERIOD_BLOCKS,
  askRateFromObservations,
  LONG_RING_CFG,
  baseUnitsToHuman,
  blockToEpochMs,
  canInflowOpen,
  commissionOwedForBaseUnits,
  creditsForAskBaseUnits,
  decodeObservationRing,
  deriveFaceBandBaseUnits,
  deriveGraceExpiresAtBlock,
  derivePhase,
  floorPricePerTokenBaseUnits,
  humanToBaseUnits,
  quoteBuyBaseUnits,
  quoteSellBaseUnits,
  refundNetBaseUnits,
  reserveCoverageRatio,
  settlementRateBaseUnits,
  BLOCKS_PER_DAY,
  spotRateBaseUnits,
  displayPricePerTokenBaseUnits,
  splitFaceBaseUnits,
  type AskRateEstimate
} from './contract-math';
import {
  type CustomJsonOp,
  answerPayload,
  askPayload,
  buildOp,
  buyPayload,
  claimTradeFeesPayload,
  closeIfDrainedPayload,
  createOfferingPayload,
  declinePayload,
  deleteOfferingPayload,
  ratePayload,
  reclaimPayload,
  refundHolderPayload,
  refundPayload,
  registerPayload,
  renewPayload,
  retirePayload,
  sellPayload,
  setCapPayload,
  setFacePayload,
  setOfferingPricePayload,
  setOfferingTitlePayload,
  transferTokensPayload,
  withdrawTreasuryPayload
} from './vsc/op-builders';
// Side-effect-only import: runs the payload-contract self-test in
// development (see that file's own doc for why it lives here rather than in
// op-builders.ts — importing it FROM op-builders.ts would be circular, since
// this file imports the payload builders FROM op-builders.ts).
import './vsc/payload-contract.selftest';
import './vsc/price-display.selftest';
// Same side-effect wiring, for the same reason: the spender-shape guard and
// its tripwire (audit anomaly A5-07) must run at app startup in development,
// not only when somebody happens to import them.
import './vsc/spender-shape.selftest';
import { MagiIndexerClient } from './vsc/hasura';
import {
  CreatorTokensGqlClient,
  buildAskFromParsed,
  isWellFormedDid,
  kAcqBlock,
  kBal,
  kMatured,
  decodeMaturedLeHex,
  kCap,
  kEscrow,
  kFace,
  kFaceAnchor,
  kFaceAnchorAt,
  kFaceSetAt,
  kFeeBal,
  kObs,
  kObsIdx,
  kObsLong,
  kObsLongIdx,
  kOfferEpoch,
  kOfferIds,
  kOfferPrice,
  kOfferTitle,
  parseOfferIds,
  kDelinquentUntil,
  kPaidUntil,
  kPaused,
  kRegisteredAt,
  kReserve,
  kRetiredAt,
  kSeq,
  kState,
  kSupply,
  decodeRetiredAt,
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
// ★ CURVE-PIVOT REWRITE (2026-07-24): the contract moved from a PAR
// "access credit" model (core/prepay.go — DELETED) to a bonding curve
// (core/curve.go/buy.go/sell.go/refund.go). See types.ts's own file-level
// doc for THE 1000x UNIT TRAP this rewrite is built around: TOKENS (supply,
// cap, balances) are whole INTEGERS now, never run through
// baseUnitsToHuman()/humanToBaseUnits() — only HBD amounts get that
// conversion. Every method below that touches a token quantity is commented
// at the exact point the trap would bite.
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

/** Shared "n is a positive whole token count" guard — every buy/sell/refund/transfer amount on the curve is an integer (curve.go indexes price by the token ordinal; there is no fractional token). */
function assertPositiveTokenCount(n: number, label: string): void {
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`VscCreatorTokensDataSource: ${label} must be a positive whole number (tokens are integers on the curve)`);
  }
}

/** holdclock.go heldBlocksAt, replicated client-side: unset (0) OR >= block both read as 0 held — MAXIMALLY FRESH, i.e. MAXIMUM exit tax, never as ancient. See holdclock.go's own "zero-value convention" doc — getting this backwards would preview a 0% tax on a position the chain taxes at 20%. */
function heldBlocksFromAcq(acqBlock: number, block: number): number {
  return acqBlock === 0 || acqBlock >= block ? 0 : block - acqBlock;
}

interface BuildMarketState {
  faceBaseUnits: number;
  faceSetAtBlock: number;
  faceAnchorBaseUnits: number;
  faceAnchorAtBlock: number;
  capTokens: number;
  supplyTokens: number;
  reserveBaseUnits: number;
  paidUntilBlock: number;
  closedStored: boolean;
  globalInflowPaused: boolean;
  registeredAtBlock: number;
  retiredAtBlock: number | null;
  /** kDelinquentUntil — the delivery gate's inflow-refusal deadline. 0 = clear. */
  delinquentUntilBlock: number;
}

export class VscCreatorTokensDataSource implements CreatorTokensDataSource {
  private readonly config: CreatorTokensConfig;
  private readonly gql: CreatorTokensGqlClient;
  private readonly broadcaster?: Broadcaster;
  private readonly indexer: MagiIndexerClient | null;

  constructor(deps: VscCreatorTokensDataSourceDeps) {
    this.config = deps.config;
    this.gql = deps.gql ?? new CreatorTokensGqlClient(deps.config.gqlUrl);
    // The Magi indexer (magi-mongo-indexer via Hasura) serves the three reads
    // contract state structurally cannot: holder->creators, asker->asks, and
    // the delivery history. Null when unconfigured — those reads then report
    // `unavailable`, which is honest, rather than empty, which is a lie.
    this.indexer = deps.config.indexerUrl ? new MagiIndexerClient(deps.config.indexerUrl, deps.config.contractId) : null;
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
      kPaused(),
      kRetiredAt(creator),
      kDelinquentUntil(creator)
    ];
    let state: Record<string, string | null>;
    let head: number | null;
    try {
      [state, head] = await Promise.all([this.gql.getStateByKeys(this.config.contractId, keys), this.gql.getHeadBlock()]);
    } catch {
      return unknownMarket(creator);
    }

    const registeredAtBlock = toU64(state[kRegisteredAt(creator)]);
    if (registeredAtBlock === 0) return null; // never registered — market.go's own kRegisteredAt==0 convention

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
        // ★ 1000x TRAP: capTokens/supplyTokens are raw integer TOKEN counts
        // (core/curve.go — a token is a whole unit). toU64 reads the exact
        // on-chain integer; NEVER wrap these in baseUnitsToHuman().
        capTokens: toU64(state[kCap(creator)]),
        supplyTokens: toU64(state[kSupply(creator)]),
        reserveBaseUnits: toU64(state[kReserve(creator)]),
        paidUntilBlock: toU64(state[kPaidUntil(creator)]),
        closedStored: state[kState(creator)] === STATE_CLOSED,
        globalInflowPaused: state[kPaused()] === '1',
        registeredAtBlock,
        retiredAtBlock: decodeRetiredAt(state[kRetiredAt(creator)]),
        delinquentUntilBlock: toU64(state[kDelinquentUntil(creator)])
      },
      head
    );
  }

  // Shared Market construction, used both by readMarket (from live chain
  // state) and by registerMarket's/retire's optimistic PENDING results (from
  // the caller's inputs) so the two can never derive Market fields
  // differently. Pure — no I/O; every argument is already a resolved
  // base-unit/token value + a real head.
  private buildMarket(creator: string, s: BuildMarketState, head: number): Market {
    // market.go Phase(): MAX(naturalPhase, retiredPhase). contract-math.ts's
    // derivePhase takes retiredAtBlock as its 4th arg and reproduces the fold
    // exactly — a retired market can never display as ACTIVE even during its
    // still-technically-OVERDUE 5-day notice window.
    const phase = derivePhase(s.closedStored, s.paidUntilBlock, head, s.retiredAtBlock);
    const graceExpiresAtBlock = deriveGraceExpiresAtBlock(s.paidUntilBlock);
    const faceBandRaw = deriveFaceBandBaseUnits(s.faceBaseUnits, s.faceSetAtBlock, s.faceAnchorBaseUnits, s.faceAnchorAtBlock, head);

    // market.go RequireInflowOpen (the shared gate buy.go's Buy and ask.go's
    // Ask both call): phase in {ACTIVE, OVERDUE} AND !globalInflowPaused AND
    // NOT marketRetired. contract-math.ts's canInflowOpen() only knows
    // {phase, globalInflowPaused} — it predates RULING K3, under which a
    // RETIRED market refuses ALL new inflows for its ENTIRE wind-down,
    // INCLUDING the OVERDUE notice window (where phase alone would still
    // read OVERDUE and canInflowOpen() would say "open"). The
    // `retiredAtBlock === null` AND below restores the full on-chain gate
    // without editing that already-verified building block — see
    // Market.canBuy's own doc in types.ts.
    //
    // ★ THE DELIVERY GATE (2026-07-27), the second condition canInflowOpen()
    // does not know about. RequireInflowOpen also refuses while the creator is
    // DELINQUENT — they ignored too many paying customers — and that refusal
    // is invisible in phase, in the pause flag and in retiredAtBlock. Without
    // this term the UI renders a live Buy button on a market that reverts every
    // single attempt, and the buyer pays RC to find out. INFLOWS ONLY: sell,
    // refund, reclaim and claim all stay open while delinquent, by design.
    const delinquent = s.delinquentUntilBlock > head;
    const canFlow = canInflowOpen(phase, s.globalInflowPaused) && s.retiredAtBlock === null && !delinquent;

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
      // ★ 1000x TRAP: raw integer token counts, NOT baseUnitsToHuman'd.
      capTokens: s.capTokens,
      supplyTokens: s.supplyTokens,
      reserveHbd: baseUnitsToHuman(s.reserveBaseUnits),
      paidUntilBlock: s.paidUntilBlock,
      paidUntilAt: blockToEpochMs(s.paidUntilBlock, head),
      registeredAtBlock: s.registeredAtBlock,
      phase,
      graceExpiresAtBlock,
      graceExpiresAt: blockToEpochMs(graceExpiresAtBlock, head),
      globalInflowPaused: s.globalInflowPaused,
      canBuy: canFlow,
      canAsk: canFlow,
      delinquentUntilBlock: delinquent ? s.delinquentUntilBlock : null,
      retiredAtBlock: s.retiredAtBlock,
      floorPriceHbd: baseUnitsToHuman(floorPricePerTokenBaseUnits(s.reserveBaseUnits, s.supplyTokens)),
      spotPriceHbd: baseUnitsToHuman(displayPricePerTokenBaseUnits(s.supplyTokens)),
      reserveCoverage: reserveCoverageRatio(s.reserveBaseUnits, s.supplyTokens)
    };
  }

  async readHolderPosition(creator: string, holder: string): Promise<HolderPosition | null> {
    const keys = [kRegisteredAt(creator), kSupply(creator), kReserve(creator), kBal(creator, holder), kAcqBlock(creator, holder)];
    // rejects on failure — see interface doc. heldBlocks (below) needs a real
    // chain head (the exit tax RATE is time-dependent, holdclock.go), so this
    // read is genuinely incomplete without one — reject rather than guess.
    // F-C5 — the MATURED bucket is a separate key family AND a separate wire
    // encoding, so it needs its own hex-encoded read (see decodeMaturedLeHex).
    // core/matured.go totalBalance: "EVERY guard that used to read kBal alone
    // must read this instead, or a holder is refused access to tokens they
    // demonstrably own." Reading kBal alone here understated a holder's whole
    // position by exactly their matured tokens.
    const [state, maturedState, head] = await Promise.all([
      this.gql.getStateByKeys(this.config.contractId, keys),
      this.gql.getStateByKeysHex(this.config.contractId, [kMatured(creator, holder)]),
      this.gql.getHeadBlock()
    ]);
    if (toU64(state[kRegisteredAt(creator)]) === 0) return null;
    if (head === null) {
      throw new Error('VscCreatorTokensDataSource: cannot compute the exit tax (chain head unavailable)');
    }
    const tokensMatured = decodeMaturedLeHex(maturedState[kMatured(creator, holder)]);
    if (tokensMatured === null) {
      // Undecodable ≠ zero. Reporting 0 here would tell a holder they own
      // nothing in the matured bucket and understate their exit value — the
      // same class of lie F-L19 is about. Refuse the read instead.
      throw new Error('VscCreatorTokensDataSource: matured balance unreadable (unexpected wire encoding)');
    }

    // ★ 1000x TRAP: tokensHeld/supplyTokens are raw integer token counts.
    const tokensMaturing = toU64(state[kBal(creator, holder)]);
    const tokensHeld = tokensMaturing + tokensMatured;
    const supplyTokens = toU64(state[kSupply(creator)]);
    const reserveBaseUnits = toU64(state[kReserve(creator)]);
    const acqBlock = toU64(state[kAcqBlock(creator, holder)]);
    const heldBlocks = heldBlocksFromAcq(acqBlock, head);

    // refund.go refundPayout + the K2 exit tax carve (contract-math.ts
    // refundNetBaseUnits): the TAXED NET, not the untaxed gross — see
    // HolderPosition.floorValueHbd's own doc in types.ts for why showing the
    // gross would overstate a fresh holder's payout by up to 20%.
    const { netBaseUnits, taxBps } = refundNetBaseUnits(
      reserveBaseUnits,
      tokensHeld,
      supplyTokens,
      heldBlocks,
      tokensMaturing
    );
    return {
      creator,
      holder,
      tokensHeld,
      floorValueHbd: baseUnitsToHuman(netBaseUnits),
      heldBlocks,
      exitTaxBps: taxBps
    };
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
    if (!this.indexer) return { positions: [], unavailable: true };
    try {
      // lumen_ct_balances is the reverse index: it replays every token move and
      // reports which markets this account still holds. The per-market POSITION
      // (taxed floor value, hold clock) is then read from CHAIN STATE, not from
      // the indexer — an exit-tax figure has to be current to the block, and a
      // replayed one would be stale the moment anything moved.
      const rows = await this.indexer.balancesOf(toDid(holder));
      const results = await Promise.all(rows.map((r) => this.readHolderPosition(r.creator, holder).catch(() => null)));
      return { positions: results.filter((p): p is HolderPosition => p !== null && p.tokensHeld > 0), unavailable: false };
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
    if (!this.indexer) return { asks: [], unavailable: true };
    try {
      // The indexer supplies the (creator, seq) PAIRS — the part no chain key
      // can answer. Each escrow is then read from chain state, so the status and
      // deadline shown are current rather than a replay that may lag a block.
      const rows = await this.indexer.asksOf(toDid(asker));
      const keys = rows.map((r) => kEscrow(r.creator, r.seq));
      const [state, head] = await Promise.all([this.gql.getStateByKeys(this.config.contractId, keys), this.gql.getHeadBlock()]);
      const asks: Ask[] = [];
      for (const r of rows) {
        const raw = state[kEscrow(r.creator, r.seq)];
        const parsed = raw ? parseEscrow(raw) : null;
        if (parsed) asks.push(buildAskFromParsed(r.creator, r.seq, parsed, head));
      }
      return { asks: asks.sort((a, b) => b.deadlineBlock - a.deadlineBlock), unavailable: false };
    } catch {
      return { asks: [], unavailable: true };
    }
  }

  async readDeliveryRecord(creator: string): Promise<DeliveryRecord> {
    // Never contract state (SPEC §1.7.1) — always indexer, always resolves
    // (never rejects), degrading to source:'unavailable'. WIRING-VERIFY (deploy).
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
    if (!this.indexer) return empty;
    try {
      const row = await this.indexer.deliveryOf(toDid(creator));
      // No row = this creator has no indexed history. That is genuinely EMPTY,
      // not unavailable: the query succeeded and the answer is "nothing yet".
      if (!row) return { ...empty, source: 'indexer' };
      return {
        creator,
        answeredCount: row.answeredCount,
        missedCount: row.missedCount,
        // Pending asks are live escrows, which the view does not track (it folds
        // resolutions). The creator's own inbox read covers that; leaving it 0
        // here is a known, bounded gap rather than a wrong number.
        pendingCount: 0,
        // The view returns a MEDIAN, already aggregated in SQL. The old REST
        // shape returned every raw block delta; one median in a list keeps the
        // consumer's own median-of-list logic correct on a single element.
        responseBlocks: row.medianResponseBlocks !== null ? [row.medianResponseBlocks] : [],
        distinctAskers: 0,
        selfDealtExcluded: 0,
        source: 'indexer'
      };
    } catch {
      return empty;
    }
  }

  /**
   * offeringId (2026-07-28) selects WHICH posted price this quote prices. It
   * must be the same id the ask will carry, because the ask settles at that
   * offering's own banded price and the commission leg is carved out of THAT
   * number — a quote that priced the generic `face` while the ask charged a
   * $200 service would sign a `transfer.allow` for the wrong HBD amount and
   * revert, or preview a cost the buyer never agreed to.
   *
   * Absent/0 = the creator's legacy single face price, exactly as on-chain.
   */
  async readQuote(creator: string, offeringId?: number): Promise<Quote> {
    const obsKeys = Array.from({ length: OBS_WINDOW }, (_, i) => kObs(creator, i));
    const obsLongKeys = Array.from({ length: OBS_WINDOW }, (_, i) => kObsLong(creator, i));
    const [state, head] = await Promise.all([
      this.gql.getStateByKeys(this.config.contractId, [
        kFace(creator),
        kObsIdx(creator),
        kObsLongIdx(creator),
        kRegisteredAt(creator),
        kSupply(creator),
        ...obsKeys,
        ...obsLongKeys
      ]),
      this.gql.getHeadBlock()
    ]);

    // The posted price this ask will actually settle against. For a named
    // offering that is the offering's own price key, never kFace — and a
    // MISSING or deleted offering resolves 0, which flows into the `face <= 0`
    // refusal below exactly as the contract's own "no such offering" does.
    let faceBaseUnits = toU64(state[kFace(creator)]);
    if (offeringId !== undefined && offeringId > 0) {
      faceBaseUnits = await this.readOfferingPriceBaseUnits(creator, offeringId);
    }
    // ask.go splitFace (USER RULING 2026-07-27): the posted face is the
    // buyer's TOTAL — commission is carved OUT of it, never drawn on top.
    // tokenLegBaseUnits (never the raw face) is what creditsForAsk must
    // price; see splitFaceBaseUnits's own doc (contract-math.ts) for the
    // "posted 200 cost 224" autopsy this closes.
    const { tokenLegBaseUnits, commissionBaseUnits } = splitFaceBaseUnits(faceBaseUnits);
    const commissionHbd = baseUnitsToHuman(commissionBaseUnits);
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

    // ask.go: core.Ask (and this preview's real counterpart, core.SettleSpend's
    // wrapper `quote`) both check `face > 0` BEFORE ever computing a
    // settlement rate ("creator has no face price set").
    if (faceBaseUnits <= 0) return unpriced('unavailable', head);

    const supplyTokens = toU64(state[kSupply(creator)]);
    const obsIdxCount = toU64(state[kObsIdx(creator)]);
    const points = decodeObservationRing(obsKeys.map((k) => state[k]), obsIdxCount);
    const estimate: AskRateEstimate = points === null ? { rateBaseUnits: null, status: 'unavailable' } : askRateFromObservations(points, head);

    // F-C3: the LONG (7-day) arm of settlement's min(short, long, spot). Same packed ring
    // format, decoded identically, but read with the long constants and DROPPED before the
    // market's current registration epoch — the long counter survives re-registration, so
    // without the epoch filter a re-registered market would price off the dead incarnation
    // (core/twap.go askRateLong). Omitting this arm let the preview exceed execution
    // whenever the long window was the binding constraint.
    const longIdxCount = toU64(state[kObsLongIdx(creator)]);
    const registeredAtBlock = toU64(state[kRegisteredAt(creator)]);
    const longPoints = decodeObservationRing(obsLongKeys.map((k) => state[k]), longIdxCount);
    const longEstimate: AskRateEstimate =
      longPoints === null
        ? { rateBaseUnits: null, status: 'unavailable' }
        : askRateFromObservations(longPoints, head, { ...LONG_RING_CFG, sinceBlock: registeredAtBlock });

    // ★ RULING C REWRITE (2026-07-24) — THE PAR FALLBACK IS DELETED.
    // contract-math.ts's settlementRateBaseUnits now REFUSES (rateBaseUnits:
    // null) instead of inventing PAR whenever the TWAP guards don't pass; see
    // its own doc and Quote.rate's doc (types.ts). When it refuses, this
    // preview reports the refusal and creditsForAskBaseUnits is NEVER called
    // with a null rate — the ask action must read as unavailable, exactly
    // mirroring what a real ask() call would do right now (RequireInflowOpen
    // is a separate gate; this is the settlement-refusal gate).
    const settlement = settlementRateBaseUnits(estimate, longEstimate, supplyTokens);
    if (settlement.rateBaseUnits === null) {
      return unpriced(settlement.status, head);
    }
    const creditsRequiredBaseUnits = creditsForAskBaseUnits(tokenLegBaseUnits, settlement.rateBaseUnits);
    return {
      ...base,
      rate: baseUnitsToHuman(settlement.rateBaseUnits),
      // ask.go's escrowed "credits" spend the SAME whole-token balance
      // Buy/Sell operate on (kBal) — NOT a 3-decimal PAR quantity any more,
      // so creditsRequired is the same raw integer as creditsRequiredBaseUnits,
      // never baseUnitsToHuman'd (the pre-pivot version of this file divided
      // by 1000 here — see types.ts's Quote.creditsRequired doc).
      creditsRequired: creditsRequiredBaseUnits,
      creditsRequiredBaseUnits,
      oracleStatus: settlement.status,
      asOfBlock: head
    };
  }

  async readFeeBalance(account: string): Promise<number> {
    const state = await this.gql.getStateByKeys(this.config.contractId, [kFeeBal(account)]);
    return baseUnitsToHuman(toU64(state[kFeeBal(account)]));
  }

  async quoteBuy(creator: string, tokens: number): Promise<BuyQuote> {
    assertPositiveTokenCount(tokens, 'tokens');
    const [state, head] = await Promise.all([
      this.gql.getStateByKeys(this.config.contractId, [kRegisteredAt(creator), kSupply(creator), kCap(creator), kPaidUntil(creator), kState(creator), kPaused(), kRetiredAt(creator)]),
      this.gql.getHeadBlock()
    ]);
    if (toU64(state[kRegisteredAt(creator)]) === 0) {
      throw new Error(`VscCreatorTokensDataSource: no such market ${creator}`);
    }
    if (head === null) {
      throw new Error('VscCreatorTokensDataSource: cannot price this buy (chain head unavailable)');
    }
    // buy.go buyCompute: RequireInflowOpen first (market.go — phase +
    // pause + not-retired), THEN the cap check. Mirrored client-side so a
    // doomed call fails fast rather than spending RC on a guaranteed revert.
    const closedStored = state[kState(creator)] === STATE_CLOSED;
    const paidUntilBlock = toU64(state[kPaidUntil(creator)]);
    const retiredAtBlock = decodeRetiredAt(state[kRetiredAt(creator)]);
    const phase = derivePhase(closedStored, paidUntilBlock, head, retiredAtBlock);
    const globalInflowPaused = state[kPaused()] === '1';
    if (!(canInflowOpen(phase, globalInflowPaused) && retiredAtBlock === null)) {
      throw new Error('VscCreatorTokensDataSource: market inflow is not open (frozen, closed, retiring, or globally paused)');
    }
    const supplyTokens = toU64(state[kSupply(creator)]);
    const capTokens = toU64(state[kCap(creator)]);
    if (supplyTokens + tokens > capTokens) {
      throw new Error('VscCreatorTokensDataSource: buy would exceed the market cap');
    }
    const q = quoteBuyBaseUnits(supplyTokens, tokens);
    return {
      tokens: q.tokens,
      costHbd: baseUnitsToHuman(q.costBaseUnits),
      feeHbd: baseUnitsToHuman(q.feeBaseUnits),
      totalDueHbd: baseUnitsToHuman(q.totalDueBaseUnits),
      rateAfterHbd: baseUnitsToHuman(q.rateAfterBaseUnits)
    };
  }

  async quoteSell(creator: string, seller: string, tokens: number): Promise<SellQuote> {
    assertPositiveTokenCount(tokens, 'tokens');
    const [state, head] = await Promise.all([
      this.gql.getStateByKeys(this.config.contractId, [
        kRegisteredAt(creator),
        kSupply(creator),
        kBal(creator, seller),
        kAcqBlock(creator, seller),
        kPaidUntil(creator),
        kState(creator),
        kRetiredAt(creator)
      ]),
      this.gql.getHeadBlock()
    ]);
    if (toU64(state[kRegisteredAt(creator)]) === 0) {
      throw new Error(`VscCreatorTokensDataSource: no such market ${creator}`);
    }
    if (head === null) {
      throw new Error('VscCreatorTokensDataSource: cannot price this sell (chain head unavailable)');
    }
    // sell.go sellCompute: balance checked first ("clearer error than the
    // rail for the common mistake").
    const bal = toU64(state[kBal(creator, seller)]);
    if (bal < tokens) {
      throw new Error('VscCreatorTokensDataSource: insufficient tokens');
    }
    // sell.go's rail switch (market.go inWindDown): the curve rail is CLOSED
    // exactly when the market is retired OR naturally FROZEN/CLOSED. Retired
    // closes the rail from the retire block on — INCLUDING the still-OVERDUE
    // notice window (RULING K3) — so this checks retiredAtBlock directly,
    // never only `phase`.
    const closedStored = state[kState(creator)] === STATE_CLOSED;
    const paidUntilBlock = toU64(state[kPaidUntil(creator)]);
    const retiredAtBlock = decodeRetiredAt(state[kRetiredAt(creator)]);
    const phase = derivePhase(closedStored, paidUntilBlock, head, retiredAtBlock);
    if (retiredAtBlock !== null || phase === 'FROZEN' || phase === 'CLOSED') {
      throw new Error('VscCreatorTokensDataSource: curve sell is closed while the market winds down (retired/frozen/closed); exit via refund() instead');
    }
    const supplyTokens = toU64(state[kSupply(creator)]);
    const acqBlock = toU64(state[kAcqBlock(creator, seller)]);
    const heldBlocks = heldBlocksFromAcq(acqBlock, head);
    const q = quoteSellBaseUnits(supplyTokens, tokens, heldBlocks);
    if (q === null) {
      // curve.go SellProceeds errors when k > S — unreachable given the
      // balance check above (bal <= supply, I3), kept as the same
      // defense-in-depth the Go source documents for its own identical check.
      throw new Error('VscCreatorTokensDataSource: sell exceeds supply');
    }
    return {
      tokens: q.tokens,
      grossHbd: baseUnitsToHuman(q.grossBaseUnits),
      taxHbd: baseUnitsToHuman(q.taxBaseUnits),
      feeHbd: baseUnitsToHuman(q.feeBaseUnits),
      netHbd: baseUnitsToHuman(q.netBaseUnits),
      taxBps: q.taxBps,
      heldBlocks: q.heldBlocks
    };
  }

  // ---- writes ----

  async registerMarket(input: RegisterMarketInput): Promise<Market> {
    this.assertBroadcaster();
    const faceBaseUnits = humanToBaseUnits(input.faceHbd);
    // market.go registerCheck (core.Register). Zero-extra-read: fixed
    // protocol constants, no chain read needed (this is a brand-new market —
    // no band exists yet, unlike setFace's guard below).
    if (faceBaseUnits < MIN_FACE_BASE_UNITS || faceBaseUnits > MAX_FACE_BASE_UNITS) {
      throw new Error('VscCreatorTokensDataSource: face out of range [MinFace, MaxFace]');
    }
    // ★ 1000x TRAP: capTokens is ALREADY the raw integer token count
    // (RegisterMarketInput.capTokens) — no humanToBaseUnits() here, unlike
    // faceBaseUnits above. MinCap/MaxCap (params.go) bound the raw integer.
    const capTokens = input.capTokens;
    if (!Number.isInteger(capTokens) || capTokens < MIN_CAP_CREDITS_BASE_UNITS || capTokens > MAX_CAP_CREDITS_BASE_UNITS) {
      throw new Error('VscCreatorTokensDataSource: cap out of range [MinCap, MaxCap]');
    }
    const firstBuyTokens = input.firstBuyTokens ?? 0;
    if (!Number.isFinite(firstBuyTokens) || !Number.isInteger(firstBuyTokens) || firstBuyTokens < 0) {
      throw new Error('VscCreatorTokensDataSource: firstBuyTokens must be a non-negative whole number');
    }
    if (firstBuyTokens > capTokens) {
      throw new Error('VscCreatorTokensDataSource: firstBuyTokens would exceed the market cap');
    }
    // launch.go RegisterWithFirstBuy: the optional first buy is an ORDINARY
    // Buy executed atomically with registration, at supply === 0 (a brand-new
    // market) — same curve math as any other Buy (buy.go), just previewed
    // here via quoteBuyBaseUnits(0, firstBuyTokens) since there is no live
    // market yet to call quoteBuy() against.
    const firstBuyQuote = firstBuyTokens > 0 ? quoteBuyBaseUnits(0, firstBuyTokens) : null;
    const totalDueBaseUnits = firstBuyQuote?.totalDueBaseUnits ?? 0;

    // REGISTRATION IS FREE (LOCKED-MECHANISM "Revenue"): no fee is drawn for
    // the registration itself — hbdLegBaseUnits is set ONLY when a first buy
    // is present, and it is exactly that buy's TotalDue (cost+fee), the
    // buyer's own transfer.allow slippage bound (buy.go's own doc).
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'register',
      payload: registerPayload(faceBaseUnits, capTokens, firstBuyTokens),
      hbdLegBaseUnits: totalDueBaseUnits > 0 ? totalDueBaseUnits : undefined,
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
          capTokens,
          // A market a moment old cannot be delinquent — registerApply zeroes
          // all three delivery keys (core/market.go), which is also the premise
          // launch.go's launchBuyCheck relies on to keep the first Buy
          // infallible. Anything but 0 here would be inventing state.
          delinquentUntilBlock: 0,
          // supply/reserve reflect the optional atomic first buy: the curve
          // leg ONLY enters the reserve (buy.go's own "the fee NEVER enters
          // kReserve" rule) — firstBuyQuote.costBaseUnits, never totalDue.
          supplyTokens: firstBuyTokens,
          reserveBaseUnits: firstBuyQuote?.costBaseUnits ?? 0,
          // core.Register grants the first subscription period (mock parity:
          // paidUntil = head + SubscriptionPeriod).
          paidUntilBlock: head + SUBSCRIPTION_PERIOD_BLOCKS,
          closedStored: false,
          globalInflowPaused: false,
          registeredAtBlock: head,
          retiredAtBlock: null
        },
        head
      ),
      pending: true
    };
  }

  async renewSubscription(input: RenewSubscriptionInput): Promise<Market> {
    this.assertBroadcaster();
    // market.go Renew: periods bounded before any arithmetic, exactly
    // mirroring core's own ordering (this check runs before core computes
    // newPaidUntil).
    if (input.periods < 1 || input.periods > MAX_PREPAID_PERIODS) {
      throw new Error('VscCreatorTokensDataSource: periods out of range [1, MaxPrepaidPeriods]');
    }
    // market.go Renew -> RequireInflowOpen — the SAME phase+pause+not-retired
    // gate Buy/Ask already read the market for. Renew is permissionless (any
    // fan may pay), but the MARKET must still be able to accept inflows — a
    // lapsed-past-grace, CLOSED, or RETIRING market cannot be "renewed" back
    // to life (market.go Renew's own marketRetired guard; SPEC §1.7.5 routes
    // a genuine lapse through Register instead). Skipped — never blocked —
    // when the market can't be read or was never registered, same "band
    // check only, not an existence check" reasoning as every other guard in
    // this file that reads a fresh Market. market.canBuy/canAsk are the exact
    // same RequireInflowOpen boolean (buildMarket computes one `canFlow` and
    // assigns it to both), so reusing canBuy here rather than re-deriving it
    // keeps this in lockstep with those two guards by construction.
    const [market, head] = await Promise.all([this.readMarket(input.creator), this.gql.getHeadBlock()]);
    if (market && market.phase !== 'UNKNOWN') {
      if (!market.canBuy) {
        throw new Error('VscCreatorTokensDataSource: market inflow is not open (frozen, closed, retiring, or globally paused)');
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
    const renewedPhase = derivePhase(false, newPaidUntilBlock, head, market.retiredAtBlock);
    const graceExpiresAtBlock = deriveGraceExpiresAtBlock(newPaidUntilBlock);
    const canFlow = canInflowOpen(renewedPhase, market.globalInflowPaused) && market.retiredAtBlock === null;
    return {
      ...market,
      paidUntilBlock: newPaidUntilBlock,
      paidUntilAt: blockToEpochMs(newPaidUntilBlock, head),
      graceExpiresAtBlock,
      graceExpiresAt: blockToEpochMs(graceExpiresAtBlock, head),
      phase: renewedPhase,
      canBuy: canFlow,
      canAsk: canFlow,
      pending: true
    };
  }

  async setFace(input: SetFaceInput): Promise<Market> {
    this.assertBroadcaster();
    const newFaceBaseUnits = humanToBaseUnits(input.newFaceHbd);
    // market.go SetFace. Zero-extra-read: fixed protocol range, independent
    // of the anti-rug band below — both are separate, unconditional AND
    // checks on-chain.
    if (newFaceBaseUnits < MIN_FACE_BASE_UNITS || newFaceBaseUnits > MAX_FACE_BASE_UNITS) {
      throw new Error('VscCreatorTokensDataSource: face out of range [MinFace, MaxFace]');
    }
    // market.go SetFace — the 2x/7-day anti-rug band, anchored to a rolling
    // WINDOW (kFaceAnchor/kFaceAnchorAt). Requires a real market read, unlike
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
    // ★ 1000x TRAP: newCapTokens is ALREADY the raw integer token count — no
    // humanToBaseUnits() (see registerMarket's identical note).
    const newCapTokens = input.newCapTokens;
    // market.go SetCap. Zero-extra-read: fixed protocol range only — the
    // separate cap-vs-current-supply guard (market.go SetCap) needs an extra
    // read (kSupply) and is explicitly out of scope for this pass (mirrors
    // the pre-pivot version of this method).
    if (!Number.isInteger(newCapTokens) || newCapTokens < MIN_CAP_CREDITS_BASE_UNITS || newCapTokens > MAX_CAP_CREDITS_BASE_UNITS) {
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
      payload: setCapPayload(newCapTokens),
      activeAuth: input.creator,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
    if (!market || market.phase === 'UNKNOWN') {
      return { ...(market ?? unknownMarket(input.creator)), pending: true };
    }
    return { ...market, capTokens: newCapTokens, pending: true };
  }

  async buy(input: BuyInput): Promise<HolderPosition> {
    this.assertBroadcaster();
    assertPositiveTokenCount(input.tokens, 'tokens');
    // buy.go buyCompute — the exact area-step cost, fee and TotalDue.
    // quoteBuy() already runs every guard Buy itself would run (existence,
    // RequireInflowOpen incl. the RULING K3 retired check, and the cap
    // check), so a rejection here means a real Buy would ALSO reject.
    const quote = await this.quoteBuy(input.creator, input.tokens);
    if (input.maxTotalHbd !== undefined && quote.totalDueHbd > input.maxTotalHbd) {
      throw new Error('VscCreatorTokensDataSource: quoted total due exceeds maxTotalHbd');
    }
    // Read the CURRENT position BEFORE broadcasting (see registerMarket's own
    // doc: a post-broadcast read returns PRE-L2-execution state).
    const priorPosition = await this.readHolderPosition(input.creator, input.buyer).catch(() => null);
    const totalDueBaseUnits = humanToBaseUnits(quote.totalDueHbd);
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'buy',
      // ★ 1000x TRAP: input.tokens is the raw integer token count — op-builders'
      // buyPayload() sends it as an intStr, never through humanToBaseUnits().
      payload: buyPayload(toDid(input.creator), input.tokens),
      // buy.go's own doc: "the buyer's own signed transfer.allow on that draw"
      // IS the slippage protection — this IS that draw, computed from the
      // SAME quote the caller's optional maxTotalHbd was just checked against.
      hbdLegBaseUnits: totalDueBaseUnits,
      activeAuth: input.buyer,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
    // Optimistic PENDING result: project the minted tokens onto the prior
    // balance. heldBlocks is projected as 0 (maximally fresh) rather than
    // carried over from priorPosition — holdclock.go's creditInflow always
    // re-averages the clock TOWARD `now` on a Buy (never away from it), so
    // keeping the OLD heldBlocks would understate the tax the position now
    // actually carries; 0 is the conservative (treasury-favouring) direction
    // used everywhere else unset/uncertain hold-time is displayed.
    // floorValueHbd is best-effort (kept at the pre-buy figure): an exact
    // post-buy value needs a fresh (reserve, supply) read, since the curve's
    // floor is not a simple linear function of tokens added.
    const priorTokens = priorPosition?.tokensHeld ?? 0;
    return {
      creator: input.creator,
      holder: input.buyer,
      tokensHeld: priorTokens + input.tokens,
      floorValueHbd: priorPosition?.floorValueHbd ?? 0,
      heldBlocks: 0,
      exitTaxBps: priorPosition?.exitTaxBps ?? 0,
      pending: true
    };
  }

  async sell(input: SellInput): Promise<HolderPosition> {
    this.assertBroadcaster();
    assertPositiveTokenCount(input.tokens, 'tokens');
    // sell.go sellCompute — the exact area-step gross, K2 tax, fee and net.
    // quoteSell() already runs every guard Sell itself would run (balance,
    // the rail switch).
    const quote = await this.quoteSell(input.creator, input.seller, input.tokens);
    if (input.minNetHbd !== undefined && quote.netHbd < input.minNetHbd) {
      throw new Error('VscCreatorTokensDataSource: quoted net proceeds below minNetHbd');
    }
    // Read the CURRENT position BEFORE broadcasting (see registerMarket's own
    // doc).
    const priorPosition = await this.readHolderPosition(input.creator, input.seller);
    if (!priorPosition) throw new Error(`VscCreatorTokensDataSource: no such market ${input.creator}`);
    const minNetBaseUnits = input.minNetHbd !== undefined ? humanToBaseUnits(input.minNetHbd) : undefined;
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'sell',
      // ★ 1000x TRAP: input.tokens is the raw integer token count —
      // op-builders' sellPayload() sends it as an intStr.
      payload: sellPayload(toDid(input.creator), input.tokens, minNetBaseUnits),
      activeAuth: input.seller,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
    // Optimistic PENDING result: project the sold tokens off the pre-broadcast
    // balance. Unlike Buy, selling never re-ages the remainder (holdclock.go
    // debitBalance: wacq is untouched by a debit), so the prior
    // heldBlocks/exitTaxBps stay exactly right for what remains.
    // floorValueHbd is kept at its pre-sell figure (same best-effort
    // simplification as buy() — an exact post-sell value needs a fresh
    // (reserve, supply) read).
    const nextTokens = Math.max(0, priorPosition.tokensHeld - input.tokens);
    return {
      creator: input.creator,
      holder: input.seller,
      tokensHeld: nextTokens,
      floorValueHbd: priorPosition.floorValueHbd,
      heldBlocks: priorPosition.heldBlocks,
      exitTaxBps: priorPosition.exitTaxBps,
      pending: true
    };
  }

  async retire(input: RetireInput): Promise<Market> {
    this.assertBroadcaster();
    const [priorMarket, head] = await Promise.all([this.readMarket(input.creator), this.gql.getHeadBlock()]);
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'retire',
      payload: retirePayload(toDid(input.creator)),
      activeAuth: input.creator,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
    if (!priorMarket || priorMarket.phase === 'UNKNOWN' || head === null) {
      return { ...(priorMarket ?? unknownMarket(input.creator)), pending: true };
    }
    // market.go Retire stamps kRetiredAt at the block THIS call executes at
    // — a height this client cannot know precisely before confirmation.
    // `head` (read just before broadcasting) is the closest honest estimate;
    // the poll reconciles the exact mark. RULING D/K3: from this block on the
    // market is in its 5-day OVERDUE notice (derivePhase's 4th arg reproduces
    // the MAX(natural, retired) fold), and — the load-bearing K3 change —
    // BOTH new inflows AND the curve Sell rail close IMMEDIATELY, not just
    // once the notice expires to FROZEN.
    const retiredAtBlock = head;
    const retiredPhase = derivePhase(false, priorMarket.paidUntilBlock, head, retiredAtBlock);
    return {
      ...priorMarket,
      retiredAtBlock,
      phase: retiredPhase,
      canBuy: false,
      canAsk: false,
      pending: true
    };
  }

  /**
   * offerings.go ListOfferings, read directly from state (the wasmexport of the
   * same name is a contract-side helper; a frontend reads keys, it does not
   * call exports).
   *
   * THREE SEQUENTIAL READS, and the order is load-bearing: offering keys are
   * EPOCH-SCOPED (Register bumps kOfferEpoch to orphan a dead incarnation's
   * whole catalogue in one write), and the id list lives under the epoch, so
   * neither the ids nor the per-offering keys can be built until the epoch is
   * known. Reading with a stale or assumed epoch returns a DEAD shop that looks
   * perfectly live.
   *
   * An absent epoch key is 0, which is the correct first-incarnation value —
   * not an error.
   */
  /**
   * One offering's posted price in base units, or 0 if it does not exist or was
   * deleted. Two reads, for the same epoch-scoping reason listOfferings has
   * three — see its doc.
   */
  private async readOfferingPriceBaseUnits(creator: string, offeringId: number): Promise<number> {
    const epochState = await this.gql.getStateByKeys(this.config.contractId, [kOfferEpoch(creator)]);
    const epoch = toU64(epochState[kOfferEpoch(creator)]);
    const priceKey = kOfferPrice(creator, epoch, offeringId);
    const state = await this.gql.getStateByKeys(this.config.contractId, [priceKey]);
    return toU64(state[priceKey]);
  }

  /**
   * The ranked creator list. TWO SOURCES, deliberately:
   *
   *   - the ORDER and the delivery stats come from the indexer view, which does
   *     the ranking in SQL so no client can quietly re-rank on price or volume;
   *   - the PRICE and CAP come from a single BATCHED chain read, because the
   *     indexer stores no price (it is a pure function of supply) and a replayed
   *     one would be stale the moment anyone traded.
   *
   * One getStateByKeys covers every creator at once — 3 keys each, and the
   * client batches internally — so this is two round trips regardless of how
   * many creators come back, not two per creator.
   */
  async readDiscovery(limit = 60): Promise<CreatorSummary[]> {
    if (!this.indexer) throw new Error('VscCreatorTokensDataSource: discovery needs the Magi indexer (CREATOR_TOKENS_INDEXER_URL)');
    const rows = await this.indexer.discovery(limit);
    if (rows.length === 0) return [];

    const keys = rows.flatMap((r) => [kSupply(r.creator), kFace(r.creator), kRegisteredAt(r.creator)]);
    const [state, head] = await Promise.all([this.gql.getStateByKeys(this.config.contractId, keys), this.gql.getHeadBlock()]);

    return rows
      .map((r) => {
        // A market the chain has never registered cannot be shown, whatever the
        // index says — the index can lag, and chain state is the record.
        if (toU64(state[kRegisteredAt(r.creator)]) === 0) return null;
        const supply = toU64(state[kSupply(r.creator)]);
        const priceBaseUnits = spotRateBaseUnits(supply);
        const faceBaseUnits = toU64(state[kFace(r.creator)]);
        return {
          creator: r.creator,
          completionPct: r.completionPct,
          avgRating: r.avgRating,
          ratingCount: r.ratingCount,
          answeredCount: r.answeredCount,
          missedCount: r.missedCount,
          medianResponseBlocks: r.medianResponseBlocks,
          priceHbd: baseUnitsToHuman(priceBaseUnits),
          marketCapHbd: baseUnitsToHuman(priceBaseUnits * supply),
          faceHbd: baseUnitsToHuman(faceBaseUnits),
          // "New" is measured from the LATEST registration, and only when we
          // actually know the head — guessing would put every creator in the
          // new shelf, or none.
          isNew: head !== null && r.registeredBlock > 0 && head - r.registeredBlock < 30 * BLOCKS_PER_DAY
        };
      })
      .filter((c): c is CreatorSummary => c !== null);
  }

  /**
   * Price history. The indexer stores SUPPLY at each trade, never a price — the
   * price is a pure function of supply on a bonding curve, and storing it would
   * be a second copy of the curve that can disagree with the buy button. This
   * applies the same ported formula the quote path uses.
   */
  async readPriceHistory(creator: string, limit = 200): Promise<PricePoint[]> {
    if (!this.indexer) throw new Error('VscCreatorTokensDataSource: price history needs the Magi indexer (CREATOR_TOKENS_INDEXER_URL)');
    const points = await this.indexer.priceHistoryOf(creator, limit);
    // ★ Same function the headline price uses (2026-08-07) — a chart drawn from
    // the ORACLE rate would print 0 for a market that has been fully sold back
    // to supply 0, while the header showed the real 1.000 HBD reset price.
    // Identical for every supply >= 1; this only fixes that one point.
    return points.map((p) => ({ block: p.block, priceHbd: baseUnitsToHuman(displayPricePerTokenBaseUnits(p.supplyAfter)) }));
  }

  async listOfferings(creator: string): Promise<Offering[]> {
    const epochState = await this.gql.getStateByKeys(this.config.contractId, [kOfferEpoch(creator)]);
    const epoch = toU64(epochState[kOfferEpoch(creator)]);

    const idsKey = kOfferIds(creator, epoch);
    const idsState = await this.gql.getStateByKeys(this.config.contractId, [idsKey]);
    const ids = parseOfferIds(idsState[idsKey]);
    if (ids.length === 0) return [];

    const keys = ids.flatMap((id) => [kOfferPrice(creator, epoch, id), kOfferTitle(creator, epoch, id)]);
    const state = await this.gql.getStateByKeys(this.config.contractId, keys);

    const out: Offering[] = [];
    for (const id of ids) {
      const priceBaseUnits = toU64(state[kOfferPrice(creator, epoch, id)]);
      // price 0 means deleted or never set, and the contract REFUSES an ask
      // against it rather than falling back to the face price. Listing it
      // would advertise a service that cannot be bought.
      if (priceBaseUnits <= 0) continue;
      out.push({
        offeringId: id,
        title: state[kOfferTitle(creator, epoch, id)] ?? '',
        priceHbd: baseUnitsToHuman(priceBaseUnits),
        priceBaseUnits
      });
    }
    return out;
  }

  async ask(input: AskInput): Promise<Ask> {
    this.assertBroadcaster();
    if (input.deadlineBlocks < MIN_ASK_DEADLINE_BLOCKS) throw new Error('VscCreatorTokensDataSource: deadline below MinAskDeadline');
    // ask.go enforces BOTH bounds on-chain; without this the tx broadcasts,
    // reverts, and the asker pays RC for a rejection we could see locally.
    if (input.deadlineBlocks > MAX_ASK_DEADLINE_BLOCKS) throw new Error('VscCreatorTokensDataSource: deadline above MaxAskDeadline');
    // ask.go Ask — contentHash validation, mirroring answer()'s identical
    // guard on answerHash below. Zero-extra-read.
    if (input.contentHash === '') {
      throw new Error('VscCreatorTokensDataSource: contentHash must not be empty');
    }
    if (input.contentHash.includes('|')) {
      throw new Error("VscCreatorTokensDataSource: contentHash must not contain '|'");
    }
    // ask.go Ask — reject a missing/zero maxCredits cap client-side rather
    // than letting an effectively-unlimited-spend call reach the chain: this
    // is the asker's own signed cap protecting against a creator spiking
    // `face` between signing and execution (see AskInput.maxCreditsBaseUnits's
    // own doc) — a call that arrives with no real cap defeats the whole point
    // of the guard existing, whether or not core would also catch it.
    if (!Number.isFinite(input.maxCreditsBaseUnits) || input.maxCreditsBaseUnits <= 0) {
      throw new Error('VscCreatorTokensDataSource: maxCreditsBaseUnits must be > 0');
    }
    // ask.go Ask -> market.go RequireInflowOpen — the canAsk gate, identical
    // in shape to buy()'s canBuy guard above (same RequireInflowOpen
    // chokepoint on the Go side, same Market field pair on this side).
    // Skipped — never blocked — when the market can't be read or was never
    // registered; see quoteBuy()'s comment for why.
    const market = await this.readMarket(input.creator);
    if (market && market.phase !== 'UNKNOWN' && !market.canAsk) {
      throw new Error('VscCreatorTokensDataSource: market inflow is not open (frozen, closed, retiring, or globally paused)');
    }
    // ★ RULING C: core.Ask's own settlement (settlement.go) now REFUSES
    // rather than falling back to PAR — readQuote() reflects that refusal via
    // creditsRequiredBaseUnits === null, and this call must refuse identically
    // rather than inventing a rate.
    // Quote the SAME offering the ask will name, or the commission leg and the
    // maxCredits check below would both be computed against the wrong posted
    // price (see readQuote's offeringId doc).
    const quote = await this.readQuote(input.creator, input.offeringId);
    if (quote.creditsRequiredBaseUnits === null) {
      throw new Error(`VscCreatorTokensDataSource: unable to price this ask (${quote.oracleStatus})`);
    }
    // ask.go Ask — creditsSpent > maxCredits, checked client-side against the
    // SAME quote fetched immediately above (so this can only fire when the
    // ask was already, definitely going to revert on the chain's own
    // identical check) — fail fast locally rather than spend RC on a
    // guaranteed revert.
    if (quote.creditsRequiredBaseUnits > input.maxCreditsBaseUnits) {
      throw new Error('VscCreatorTokensDataSource: settlement price exceeds maxCreditsBaseUnits');
    }
    // H2 fix (kept): the wrapper computes the EXACT commission itself via
    // core.CommissionOwedFor — main.go's `ask` entrypoint no longer reads a
    // commissionHbdPaid payload field at all (askPayload lost that parameter
    // with the pivot), so this is the intents-only HBD leg, never a wire field.
    const commissionBaseUnits = commissionOwedForBaseUnits(humanToBaseUnits(quote.faceHbd));
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'ask',
      payload: askPayload(toDid(input.creator), input.contentHash, input.deadlineBlocks, input.maxCreditsBaseUnits, input.offeringId),
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
      tokensEscrowed: quote.creditsRequired ?? 0,
      // Unconfirmed: the chain stamps the real hold clock at execution. 0
      // reads as maximally FRESH, which is the safe direction to guess.
      acqBlock: 0,
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
    // ask.go Answer. Zero-extra-read.
    if (input.answerHash === '') {
      throw new Error('VscCreatorTokensDataSource: answerHash must not be empty');
    }
    // ask.go Answer. Zero-extra-read.
    if (input.answerHash.includes('|')) {
      throw new Error("VscCreatorTokensDataSource: answerHash must not contain '|'");
    }
    // ask.go Answer — the answer half of the I6 disjoint window (block <=
    // deadline). Needs the CURRENT chain head, fetched fresh rather than
    // trusting any cached value the caller might be holding — a stale head
    // could let this guard pass locally on a call that would still revert
    // on-chain a moment later. Deliberately does NOT re-read the escrow
    // itself (kEscrow) to get the deadline — that would incidentally
    // implement the excluded escrow-existence check; AnswerInput.deadlineBlock
    // carries it instead, sourced from the Ask the caller already has.
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
      activeAuth: input.creator,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
    // Optimistic: the read-back is pre-L2-execution, so project the ask to
    // answered and flag it pending — the poll reconciles against real state.
    const answered = await this.readOneAsk(input.creator, input.seq);
    return { ...answered, status: 'answered', answerHash: input.answerHash, pending: true };
  }

  /**
   * ask.go Decline — the creator's free, honest "no". Legal in the SAME window
   * an Answer is (block <= deadlineBlock), so it uses the identical fresh-head
   * guard answer() does, for the identical reason: the escrow's deadline comes
   * from the Ask the caller already holds, so no second chain read is needed.
   *
   * NOT a miss against the delivery record, and it refunds the commission in
   * full — so this is strictly better for both sides than a creator letting an
   * ask rot, and it is what makes ask-flooding pointless as a grief.
   */
  async decline(input: DeclineInput): Promise<Ask> {
    this.assertBroadcaster();
    const head = await this.gql.getHeadBlock();
    if (head === null) {
      throw new Error('VscCreatorTokensDataSource: cannot verify the decline window (chain head unavailable)');
    }
    if (head > input.deadlineBlock) {
      throw new Error('VscCreatorTokensDataSource: decline window closed (the answer window is over; the asker reclaims from here)');
    }
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'decline',
      payload: declinePayload(toDid(input.creator), input.seq),
      activeAuth: input.creator,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
    const declined = await this.readOneAsk(input.creator, input.seq);
    return { ...declined, status: 'declined', pending: true };
  }

  async rate(input: RateInput): Promise<void> {
    this.assertBroadcaster();
    // Bounds are enforced on-chain too; failing here keeps a guaranteed revert
    // from costing the buyer RC.
    if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) {
      throw new Error('VscCreatorTokensDataSource: score must be a whole number 1-5');
    }
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'rate',
      payload: ratePayload(toDid(input.creator), input.seq, input.score),
      activeAuth: input.rater,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
  }

  async reclaim(input: ReclaimInput): Promise<Ask> {
    this.assertBroadcaster();
    // ask.go Reclaim — the reclaim half of the I6 disjoint window (block >
    // deadline+ReclaimGrace). Same fresh-head, no-escrow-read reasoning as
    // answer()'s identical guard above; ReclaimInput.deadlineBlock carries
    // the escrow's deadline for the same reason.
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
    assertPositiveTokenCount(input.tokens, 'tokens');
    // Read the CURRENT position AND market BEFORE broadcasting (see
    // registerMarket's own doc) — the market read doubles as refund.go's own
    // rail-switch guard: Refund is the WIND-DOWN rail, open ONLY once the
    // market is winding down (retired, or naturally FROZEN/CLOSED); while it
    // trades, the exit is sell() instead (sell.go/refund.go's shared
    // rail-switch doc — the two rails are state-disjoint by construction).
    const [priorPosition, market] = await Promise.all([this.readHolderPosition(input.creator, input.holder), this.readMarket(input.creator)]);
    if (!priorPosition) throw new Error(`VscCreatorTokensDataSource: no such market ${input.creator}`);
    if (input.tokens > priorPosition.tokensHeld) {
      throw new Error('VscCreatorTokensDataSource: insufficient tokens');
    }
    if (market && market.phase !== 'UNKNOWN') {
      const windingDown = market.retiredAtBlock !== null || market.phase === 'FROZEN' || market.phase === 'CLOSED';
      if (!windingDown) {
        throw new Error('VscCreatorTokensDataSource: pro-rata refund opens only at wind-down (retired/frozen/closed); while the market trades, exit via sell() instead');
      }
    }
    const minNetBaseUnits = input.minNetHbd !== undefined ? humanToBaseUnits(input.minNetHbd) : undefined;
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'refund',
      // ★ 1000x TRAP: input.tokens is the raw integer token count — the wire
      // field is still named `credits` (main.go's payload shape predates the
      // pivot), but op-builders' refundPayload() sends it as an intStr, never
      // through humanToBaseUnits().
      payload: refundPayload(toDid(input.creator), input.tokens, minNetBaseUnits),
      activeAuth: input.holder,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
    // Optimistic PENDING result: project the redeemed tokens off the
    // pre-broadcast balance (same best-effort floorValueHbd simplification as
    // sell() — refund.go's pro-rata floor is not a simple linear function of
    // tokens removed either).
    const nextTokens = Math.max(0, priorPosition.tokensHeld - input.tokens);
    return {
      creator: input.creator,
      holder: input.holder,
      tokensHeld: nextTokens,
      floorValueHbd: priorPosition.floorValueHbd,
      heldBlocks: priorPosition.heldBlocks,
      exitTaxBps: priorPosition.exitTaxBps,
      pending: true
    };
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
    // H3/EXITTAX-1: RefundHolder is gated to the SAME wind-down rail as
    // Refund itself (refund.go: "under RULING A/K the pull is rail-routed on
    // the same inWindDown predicate... the two gates now coincide"). Mirrors
    // refund()'s identical guard above.
    const [priorPosition, market] = await Promise.all([this.readHolderPosition(input.creator, input.holder), this.readMarket(input.creator)]);
    if (!priorPosition) throw new Error(`VscCreatorTokensDataSource: no such market ${input.creator}`);
    if (market && market.phase !== 'UNKNOWN') {
      const windingDown = market.retiredAtBlock !== null || market.phase === 'FROZEN' || market.phase === 'CLOSED';
      if (!windingDown) {
        throw new Error('VscCreatorTokensDataSource: refundHolder is only available once wind-down opens (retired/frozen/closed); the holder may still exit via sell()');
      }
    }
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'refundHolder',
      payload: refundHolderPayload(toDid(input.creator), holderDid),
      activeAuth: input.caller,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
    // refund.go RefundHolder always pays out the holder's ENTIRE balance —
    // tokensHeld projects to exactly 0, not an estimate.
    return {
      creator: input.creator,
      holder: input.holder,
      tokensHeld: 0,
      floorValueHbd: 0,
      heldBlocks: priorPosition.heldBlocks,
      exitTaxBps: 0,
      pending: true
    };
  }

  async transferTokens(input: TransferTokensInput): Promise<void> {
    this.assertBroadcaster();
    const toDidAccount = toDid(input.to);
    // main.go Transfer. Zero-extra-read. Compared as DIDs (not the raw input
    // strings) so an inconsistently-prefixed pair (e.g. "alice" vs
    // "hive:alice", which core would treat as the SAME account) is still
    // caught here rather than sailing through as "different" only to collide
    // once toDid() is applied on the wire.
    if (toDid(input.from) === toDidAccount) {
      throw new Error('VscCreatorTokensDataSource: from and to must be different accounts');
    }
    assertPositiveTokenCount(input.tokens, 'tokens');
    // finding M-e: `to` is a genuine third-party DESTINATION distinct from
    // the signer (`from`) — same "reject a malformed destination before it
    // can strand funds" reasoning as refundHolder's holder guard above.
    if (!isWellFormedDid(toDidAccount)) {
      throw new Error('VscCreatorTokensDataSource: destination account is not well-formed');
    }
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'transfer', // the wasm export is `transfer`, not `transferTokens`
      // ★ 1000x TRAP: input.tokens is the raw integer token count —
      // op-builders' transferTokensPayload() sends it as an intStr.
      payload: transferTokensPayload(toDid(input.creator), toDidAccount, input.tokens),
      activeAuth: input.from,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
  }

  async claimTradeFees(input: ClaimTradeFeesInput): Promise<number> {
    this.assertBroadcaster();
    // tradefee.go ClaimTradeFees pulls the CALLER'S ENTIRE accrued balance —
    // the pre-broadcast read below IS the exact amount this call claims
    // (there is no partial-claim path), so no post-write reconciliation is
    // needed the way Market/HolderPosition writes require.
    const owedHbd = await this.readFeeBalance(input.account);
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'claimTradeFees',
      payload: claimTradeFeesPayload(),
      activeAuth: input.account,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
    return owedHbd;
  }

  async closeIfDrained(input: CloseIfDrainedInput): Promise<boolean> {
    this.assertBroadcaster();
    const priorMarket = await this.readMarket(input.creator);
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'closeIfDrained',
      payload: closeIfDrainedPayload(toDid(input.creator)),
      activeAuth: input.caller,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
    // refund.go CloseIfDrained: (FROZEN AND supply===0) => CLOSED, or already
    // CLOSED => true, else false — idempotent on the contract side. A
    // custom_json broadcast resolves to a Hive tx id, never the L2 call's own
    // return value, so this client cannot observe the real post-execution
    // result directly — this is the same PRE-broadcast optimistic projection
    // every other write in this file makes; re-readMarket() to confirm.
    if (!priorMarket || priorMarket.phase === 'UNKNOWN') return false;
    return priorMarket.phase === 'CLOSED' || (priorMarket.phase === 'FROZEN' && priorMarket.supplyTokens === 0);
  }

  // ---- the offerings shop. The caller IS the creator on all four writes, so
  // none of them carries a `creator` payload field; input.creator is only ever
  // used as the SIGNER (activeAuth). Prices are UNQUOTED base-units integers on
  // the wire — see op-builders.ts's shop section for why a quoted string there
  // would post a free service. ----

  async createOffering(input: CreateOfferingInput): Promise<void> {
    this.assertBroadcaster();
    if (input.title.trim() === '') throw new Error('VscCreatorTokensDataSource: offering title must not be empty');
    if (!(input.priceHbd > 0)) throw new Error('VscCreatorTokensDataSource: offering price must be > 0');
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'createOffering',
      payload: createOfferingPayload(input.title, humanToBaseUnits(input.priceHbd)),
      activeAuth: input.creator,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
  }

  async setOfferingPrice(input: SetOfferingPriceInput): Promise<void> {
    this.assertBroadcaster();
    if (!(input.newPriceHbd > 0)) throw new Error('VscCreatorTokensDataSource: offering price must be > 0');
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'setOfferingPrice',
      payload: setOfferingPricePayload(input.offeringId, humanToBaseUnits(input.newPriceHbd)),
      activeAuth: input.creator,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
  }

  async setOfferingTitle(input: SetOfferingTitleInput): Promise<void> {
    this.assertBroadcaster();
    if (input.title.trim() === '') throw new Error('VscCreatorTokensDataSource: offering title must not be empty');
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'setOfferingTitle',
      payload: setOfferingTitlePayload(input.offeringId, input.title),
      activeAuth: input.creator,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
  }

  async deleteOffering(input: DeleteOfferingInput): Promise<void> {
    this.assertBroadcaster();
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'deleteOffering',
      payload: deleteOfferingPayload(input.offeringId),
      activeAuth: input.creator,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
  }

  async withdrawTreasury(input: WithdrawTreasuryInput): Promise<number> {
    this.assertBroadcaster();
    if (!Number.isFinite(input.amountHbd) || input.amountHbd <= 0) {
      throw new Error('VscCreatorTokensDataSource: amountHbd must be positive');
    }
    const amountBaseUnits = humanToBaseUnits(input.amountHbd);
    const op = buildOp({
      netId: this.config.netId,
      contractId: this.config.contractId,
      action: 'withdrawTreasury',
      payload: withdrawTreasuryPayload(amountBaseUnits),
      activeAuth: input.caller,
      rcLimit: this.config.rcLimit
    });
    await this.broadcast(op);
    // read.go WithdrawTreasury debits EXACTLY `amount` (bounded to (0,
    // current treasury balance] — an over-withdrawal is refused outright,
    // never clamped), so a successful call withdraws exactly what was
    // requested.
    return input.amountHbd;
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
