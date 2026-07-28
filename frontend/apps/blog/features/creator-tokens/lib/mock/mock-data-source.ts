import { getStorageItem, setStorageItem, StorageTTL } from '@ui/lib/storage-with-ttl';
import type {
  Ask,
  CreateOfferingInput,
  DeclineInput,
  DeleteOfferingInput,
  CreatorSummary,
  Offering,
  PricePoint,
  RateInput,
  SetOfferingPriceInput,
  SetOfferingTitleInput,
  AskInput,
  AnswerInput,
  BuyInput,
  BuyQuote,
  ClaimTradeFeesInput,
  CloseIfDrainedInput,
  DeliveryRecord,
  HolderPosition,
  MyAsksResult,
  WalletPositionsResult,
  Market,
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
  WithdrawTreasuryInput
} from '../../types';
import type { CreatorTokensDataSource } from '../creator-tokens-data-source';
import {
  BLOCKS_PER_DAY,
  RECLAIM_GRACE_BLOCKS,
  areaBaseUnits,
  baseUnitsToHuman,
  blockToEpochMs,
  canInflowOpen,
  creditsForAskBaseUnits,
  deriveAskStatus,
  deriveFaceBandBaseUnits,
  deriveGraceExpiresAtBlock,
  derivePhase,
  exitTaxBpsAt,
  exitTaxOnBaseUnits,
  floorPricePerTokenBaseUnits,
  humanToBaseUnits,
  quoteBuyBaseUnits,
  quoteSellBaseUnits,
  refundNetBaseUnits,
  refundPayoutBaseUnits,
  reserveCoverageRatio,
  settlementRateBaseUnits,
  spotRateBaseUnits,
  splitFaceBaseUnits,
  tradeFeeOn,
  type AskRateEstimate
} from '../contract-math';
import { unknownMarket } from '../vsc/reads';
import {
  ASK_SEEDS,
  DELIVERY_PATTERNS,
  HOLDER_SEEDS,
  MARKET_SEEDS,
  MOCK_RATE_BASE_UNITS,
  MOCK_UNKNOWN,
  buildDeliveryWindows,
  mockHeadBlock,
  type AskSeed,
  type MarketSeed
} from './fixtures';

// Behaviour half of the mock split — the creator/holder/ask/delivery FIXTURES
// themselves live in ./fixtures.ts (the pure "creator states" data), this file
// owns only how reads/writes are simulated against them. See fixtures.ts for
// the seeded scenarios (MOCK_ACTIVE/OVERDUE/FROZEN/EMPTY/CLOSED/UNKNOWN).
//
// ★ CURVE-PIVOT REWRITE (2026-07-24): see types.ts's / contract-math.ts's own
// "THE 1000x UNIT TRAP" doc. Every *tokens quantity below is a whole INTEGER;
// only HBD amounts (fees, tax, reserve, floor/spot price) go through
// baseUnitsToHuman()/humanToBaseUnits().

const walletKey = (holder: string) => `ct-mock-wallet-${holder}`;
const asksKey = (creator: string) => `ct-mock-asks-${creator}`;
const marketKey = (creator: string) => `ct-mock-market-${creator}`;
const feeBalKey = (account: string) => `ct-mock-feebal-${account}`;
const treasuryKey = () => `ct-mock-treasury`;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Per-(creator,holder) persisted wallet entry — mirrors kBal + kAcqBlock (expressed as heldBlocks rather than an absolute wacq height, since the mock's "now" is itself a moving target — see fixtures.ts's own MarketSeed.retiredAtBlock doc for the identical reasoning). */
interface WalletEntry {
  tokens: number;
  heldBlocks: number;
}

/**
 * holdclock.go creditInflow, replicated at MOCK scale: re-averages the
 * position's hold clock toward `block` (the trade's own block), weighted by
 * size, CEIL — exactly mirroring the real chokepoint's `wNew =
 * ceil((oldBal·wOld + n·block) / (oldBal+n))`, expressed here in `heldBlocks`
 * (age) rather than an absolute wacq height since the caller only has ages to
 * hand. oldTokens === 0 hits C-14 exactly: a fresh account always starts at
 * ZERO hold time (heldBlocks 0), never inheriting the incoming slice's own age.
 */
function mockCreditInflow(oldTokens: number, oldHeldBlocks: number, n: number, block: number): WalletEntry {
  const wOld = oldTokens > 0 ? block - oldHeldBlocks : block;
  const nextTokens = oldTokens + n;
  const wNew = nextTokens > 0 ? Math.ceil((oldTokens * wOld + n * block) / nextTokens) : block;
  return { tokens: nextTokens, heldBlocks: Math.max(0, block - wNew) };
}

function readWalletEntry(creator: string, holder: string): WalletEntry {
  const persisted = getStorageItem<Record<string, WalletEntry>>(walletKey(holder));
  const entry = persisted?.[creator];
  if (entry) return entry;
  const seeded = HOLDER_SEEDS[creator]?.find((h) => h.holder === holder);
  return { tokens: seeded?.tokens ?? 0, heldBlocks: seeded?.heldBlocks ?? 0 };
}

function writeWalletEntry(creator: string, holder: string, entry: WalletEntry): void {
  const wallet = getStorageItem<Record<string, WalletEntry>>(walletKey(holder)) ?? {};
  wallet[creator] = entry;
  setStorageItem(walletKey(holder), wallet, StorageTTL.SESSION);
}

/** tradefee.go accrueTradeFee, at mock scale: creator half pull-claimable, platform half to the treasury pot. Zero parts skipped, matching accrueTradeFee's own no-dust-write frugality. */
function accrueFee(creator: string, feeCreatorBaseUnits: number, feePlatformBaseUnits: number): void {
  if (feeCreatorBaseUnits > 0) {
    const cur = getStorageItem<number>(feeBalKey(creator)) ?? 0;
    setStorageItem(feeBalKey(creator), cur + feeCreatorBaseUnits, StorageTTL.SESSION);
  }
  if (feePlatformBaseUnits > 0) addTreasury(feePlatformBaseUnits);
}

function addTreasury(amountBaseUnits: number): void {
  if (amountBaseUnits <= 0) return;
  const cur = getStorageItem<number>(treasuryKey()) ?? 0;
  setStorageItem(treasuryKey(), cur + amountBaseUnits, StorageTTL.SESSION);
}

/**
 * In-memory + SESSION-TTL-persisted mock. Reads are pure functions of the
 * seeds in ./fixtures plus whatever a prior write persisted this session;
 * writes simulate the contract's own arithmetic (via the shared
 * lib/contract-math.ts helpers every real VscCreatorTokensDataSource call
 * also uses) so the numbers a demo shows stay internally consistent.
 * Mock-only: the real source must never persist state client-side.
 */
// The mock shop persists to TTL storage, the same way the mock asks do, so a
// dev reload does not silently empty a catalogue the developer just built.
// Ids are allocated monotonically and never reused, mirroring offerings.go.
const offeringsKey = (creator: string) => `ct-mock-offerings-${creator}`;
const offeringsSeqKey = (creator: string) => `ct-mock-offerings-seq-${creator}`;

export class MockCreatorTokensDataSource implements CreatorTokensDataSource {
  private readOfferings(creator: string): Offering[] {
    return getStorageItem<Offering[]>(offeringsKey(creator)) ?? [];
  }

  private writeOfferings(creator: string, offerings: Offering[]): void {
    setStorageItem(offeringsKey(creator), offerings, StorageTTL.SESSION);
  }

  // The mock has no event history to rank or plot, and inventing either would
  // be exactly the fabrication this feature already shipped once. Both reject,
  // which the screens render as "not available" — the same thing a real build
  // shows when the indexer is unreachable.
  async readDiscovery(): Promise<CreatorSummary[]> {
    await delay(200);
    throw new Error('MockCreatorTokensDataSource: discovery needs a real indexer');
  }

  async readPriceHistory(): Promise<PricePoint[]> {
    await delay(200);
    throw new Error('MockCreatorTokensDataSource: price history needs a real indexer');
  }

  async listOfferings(creator: string): Promise<Offering[]> {
    await delay(150);
    return this.readOfferings(creator);
  }

  async createOffering(input: CreateOfferingInput): Promise<void> {
    await delay(400);
    const nextId = (getStorageItem<number>(offeringsSeqKey(input.creator)) ?? 0) + 1;
    setStorageItem(offeringsSeqKey(input.creator), nextId, StorageTTL.SESSION);
    const priceBaseUnits = humanToBaseUnits(input.priceHbd);
    this.writeOfferings(input.creator, [
      ...this.readOfferings(input.creator),
      { offeringId: nextId, title: input.title, priceHbd: input.priceHbd, priceBaseUnits }
    ]);
  }

  async setOfferingPrice(input: SetOfferingPriceInput): Promise<void> {
    await delay(400);
    const offerings = this.readOfferings(input.creator);
    const idx = offerings.findIndex((o) => o.offeringId === input.offeringId);
    if (idx < 0) throw new Error(`MockCreatorTokensDataSource: no such offering ${input.offeringId}`);
    const next = [...offerings];
    next[idx] = { ...next[idx], priceHbd: input.newPriceHbd, priceBaseUnits: humanToBaseUnits(input.newPriceHbd) };
    this.writeOfferings(input.creator, next);
  }

  async setOfferingTitle(input: SetOfferingTitleInput): Promise<void> {
    await delay(400);
    const offerings = this.readOfferings(input.creator);
    const idx = offerings.findIndex((o) => o.offeringId === input.offeringId);
    if (idx < 0) throw new Error(`MockCreatorTokensDataSource: no such offering ${input.offeringId}`);
    const next = [...offerings];
    next[idx] = { ...next[idx], title: input.title };
    this.writeOfferings(input.creator, next);
  }

  async deleteOffering(input: DeleteOfferingInput): Promise<void> {
    await delay(400);
    this.writeOfferings(
      input.creator,
      this.readOfferings(input.creator).filter((o) => o.offeringId !== input.offeringId)
    );
  }

  private seed(creator: string): MarketSeed | null {
    const persisted = getStorageItem<MarketSeed>(marketKey(creator));
    if (persisted) return persisted;
    return MARKET_SEEDS[creator] ?? null;
  }

  private buildMarket(creator: string, seed: MarketSeed): Market {
    const head = mockHeadBlock();
    const paidUntilBlock = head + seed.paidUntilDeltaBlocks;
    const registeredAtBlock = head + seed.registeredAtDeltaBlocks;
    const faceSetAtBlock = head + seed.faceSetAtDeltaBlocks;
    // market.go Phase(): MAX(naturalPhase, retiredPhase). seed.retiredAtBlock
    // is an ABSOLUTE block (fixtures.ts's own doc explains why, unlike the
    // *DeltaBlocks fields above), passed straight through as derivePhase's
    // 4th arg.
    const phase = derivePhase(seed.closedStored, paidUntilBlock, head, seed.retiredAtBlock);
    const graceExpiresAtBlock = deriveGraceExpiresAtBlock(paidUntilBlock);
    // deriveFaceBandBaseUnits' anchor pair (kFaceAnchor/kFaceAnchorAt) has no
    // fixture field (none of the seeded scenarios exercise a second SetFace
    // call inside the same 7-day window), so 0/0 is passed, which makes the
    // function bootstrap the anchor from the current face/faceSetAtBlock every
    // time — a deliberate simplification, unrelated to the curve pivot.
    const faceBandRaw = deriveFaceBandBaseUnits(seed.faceBaseUnits, faceSetAtBlock, 0, 0, head);
    const globalInflowPaused = seed.globalInflowPaused;
    // market.go RequireInflowOpen: canInflowOpen() alone predates RULING K3
    // (a retired market refuses ALL new inflows, even during its still-OVERDUE
    // notice window) — the retiredAtBlock null-check ANDs the missing half
    // back in, mirroring vsc-data-source.ts's identical buildMarket() note.
    // The mock has no delivery-gate seed, so it never simulates delinquency —
    // stated here rather than left implicit, because "the mock can't reach this
    // state" is the reason a delinquency bug would never show up in demo mode.
    const canFlow = canInflowOpen(phase, globalInflowPaused) && seed.retiredAtBlock === null;
    return {
      creator,
      delinquentUntilBlock: null,
      faceHbd: baseUnitsToHuman(seed.faceBaseUnits),
      faceSetAtBlock,
      faceBand: {
        minHbd: baseUnitsToHuman(faceBandRaw.minHbd),
        maxHbd: baseUnitsToHuman(faceBandRaw.maxHbd),
        bandActive: faceBandRaw.bandActive,
        windowEndsAtBlock: faceBandRaw.windowEndsAtBlock
      },
      // ★ 1000x TRAP: raw integer token counts, never baseUnitsToHuman'd.
      capTokens: seed.capTokens,
      supplyTokens: seed.supplyTokens,
      reserveHbd: baseUnitsToHuman(seed.reserveBaseUnits),
      paidUntilBlock,
      paidUntilAt: blockToEpochMs(paidUntilBlock, head),
      registeredAtBlock,
      phase,
      graceExpiresAtBlock,
      graceExpiresAt: blockToEpochMs(graceExpiresAtBlock, head),
      globalInflowPaused,
      canBuy: canFlow,
      canAsk: canFlow,
      retiredAtBlock: seed.retiredAtBlock,
      floorPriceHbd: baseUnitsToHuman(floorPricePerTokenBaseUnits(seed.reserveBaseUnits, seed.supplyTokens)),
      spotPriceHbd: baseUnitsToHuman(spotRateBaseUnits(seed.supplyTokens)),
      reserveCoverage: reserveCoverageRatio(seed.reserveBaseUnits, seed.supplyTokens)
    };
  }

  async readMarket(creator: string): Promise<Market | null> {
    await delay(120);
    if (creator === MOCK_UNKNOWN) {
      // Simulates a contract read that failed: resolve with UNKNOWN rather
      // than reject, exactly as VscCreatorTokensDataSource.readMarket must
      // (see the interface doc). Reuses the SAME builder the real data
      // source uses (reads.ts's unknownMarket) instead of a hand-duplicated
      // shape.
      return unknownMarket(creator);
    }
    const seed = this.seed(creator);
    if (!seed) return null;
    return this.buildMarket(creator, seed);
  }

  async readHolderPosition(creator: string, holder: string): Promise<HolderPosition | null> {
    await delay(100);
    if (creator === MOCK_UNKNOWN) {
      throw new Error('MockCreatorTokensDataSource: simulated read failure');
    }
    const seed = this.seed(creator);
    if (!seed) return null;
    const { tokens, heldBlocks } = readWalletEntry(creator, holder);
    // refund.go refundPayout + the K2 exit tax carve (contract-math.ts
    // refundNetBaseUnits) — the TAXED NET, matching
    // VscCreatorTokensDataSource.readHolderPosition exactly.
    const { netBaseUnits, taxBps } = refundNetBaseUnits(seed.reserveBaseUnits, tokens, seed.supplyTokens, heldBlocks);
    return {
      creator,
      holder,
      tokensHeld: tokens,
      floorValueHbd: baseUnitsToHuman(netBaseUnits),
      heldBlocks,
      exitTaxBps: taxBps
    };
  }

  async readWallet(holder: string): Promise<WalletPositionsResult> {
    await delay(150);
    const persisted = getStorageItem<Record<string, WalletEntry>>(walletKey(holder)) ?? {};
    const creators = new Set<string>(Object.keys(persisted));
    for (const [creator, holders] of Object.entries(HOLDER_SEEDS)) {
      if (holders.some((h) => h.holder === holder)) creators.add(creator);
    }
    const positions = await Promise.all(Array.from(creators).map((creator) => this.readHolderPosition(creator, holder)));
    // The mock always has data available, so unavailable is false; the field
    // exists so a consumer can distinguish "loaded, you hold nothing" (this)
    // from "the indexer read failed" (the VSC source's unavailable:true).
    return { positions: positions.filter((p): p is HolderPosition => p !== null && p.tokensHeld > 0), unavailable: false };
  }

  private buildAsk(creator: string, s: AskSeed, head: number): Ask {
    const deadlineBlock = head + s.deadlineDeltaBlocks;
    const reclaimableAtBlock = deadlineBlock + RECLAIM_GRACE_BLOCKS;
    return {
      id: `${creator}:${s.seq}`,
      creator,
      seq: s.seq,
      asker: s.asker,
      // Whole tokens — no baseUnitsToHuman divide (see ParsedEscrow.tokensEscrowed).
      tokensEscrowed: s.creditsBaseUnits,
      acqBlock: s.acqBlock ?? 0,
      deadlineBlock,
      deadlineAt: blockToEpochMs(deadlineBlock, head),
      reclaimableAtBlock,
      reclaimableAt: blockToEpochMs(reclaimableAtBlock, head),
      status: deriveAskStatus(s.rawStatus, deadlineBlock, head),
      contentHash: s.contentHash,
      answerHash: s.answerHash
    };
  }

  async readCreatorAsks(creator: string, opts?: { limit?: number }): Promise<Ask[]> {
    await delay(150);
    if (creator === MOCK_UNKNOWN) {
      throw new Error('MockCreatorTokensDataSource: simulated read failure');
    }
    const head = mockHeadBlock();
    const persisted = getStorageItem<AskSeed[]>(asksKey(creator));
    const seeds = persisted ?? ASK_SEEDS[creator] ?? [];
    const asks = seeds.map((s) => this.buildAsk(creator, s, head)).sort((a, b) => a.deadlineBlock - b.deadlineBlock);
    return opts?.limit ? asks.slice(0, opts.limit) : asks;
  }

  async readMyAsks(asker: string): Promise<MyAsksResult> {
    await delay(150);
    const head = mockHeadBlock();
    const out: Ask[] = [];
    for (const creator of Object.keys(MARKET_SEEDS)) {
      const persisted = getStorageItem<AskSeed[]>(asksKey(creator));
      const seeds = persisted ?? ASK_SEEDS[creator] ?? [];
      seeds.filter((s) => s.asker === asker).forEach((s) => out.push(this.buildAsk(creator, s, head)));
    }
    return { asks: out.sort((a, b) => b.deadlineBlock - a.deadlineBlock), unavailable: false };
  }

  async readDeliveryRecord(creator: string): Promise<DeliveryRecord> {
    await delay(150);
    const pattern = DELIVERY_PATTERNS[creator];
    if (!pattern) {
      // Mirror the VSC source's `unavailable` empty record shape exactly (M1
      // fields included) so the two implementations stay interchangeable.
      return {
        creator,
        answeredCount: 0,
        missedCount: 0,
        pendingCount: 0,
        responseBlocks: [],
        distinctAskers: 0,
        selfDealtExcluded: 0,
        source: 'unavailable'
      };
    }
    const windows = buildDeliveryWindows(Date.now(), pattern);
    const answeredCount = windows.filter((w) => w.outcome === 'answered').length;
    const missedCount = windows.filter((w) => w.outcome === 'missed').length;
    const pendingCount = windows.filter((w) => w.outcome === 'pending').length;
    // The indexer serves response times in BLOCKS; the mock models them in ms,
    // so convert at ~3s/block (BLOCKS_PER_DAY basis) for a faithful shape.
    const responseBlocks = windows
      .map((w) => w.responseMs)
      .filter((v): v is number => v !== null)
      .map((ms) => Math.max(1, Math.round(ms / 3000)));
    return {
      creator,
      answeredCount,
      missedCount,
      pendingCount,
      responseBlocks,
      // Mock proxy: each resolved window stands in for one distinct third-party
      // asker; no self-deals are modelled, so selfDealtExcluded is 0.
      distinctAskers: answeredCount + missedCount,
      selfDealtExcluded: 0,
      source: 'indexer'
    };
  }

  async readQuote(creator: string): Promise<Quote> {
    await delay(100);
    if (creator === MOCK_UNKNOWN) {
      throw new Error('MockCreatorTokensDataSource: simulated read failure');
    }
    const seed = this.seed(creator);
    const head = mockHeadBlock();
    const faceBaseUnits = seed?.faceBaseUnits ?? 0;
    // ask.go splitFace (USER RULING 2026-07-27), mirrors
    // VscCreatorTokensDataSource.readQuote()'s identical fix: the posted face
    // is the buyer's TOTAL, so the token leg (tokenLegBaseUnits) — never the
    // raw face — is what creditsForAsk must price below.
    const { tokenLegBaseUnits, commissionBaseUnits } = splitFaceBaseUnits(faceBaseUnits);
    const commissionHbd = baseUnitsToHuman(commissionBaseUnits);
    const unpriced = (oracleStatus: Quote['oracleStatus']): Quote => ({
      creator,
      faceHbd: baseUnitsToHuman(faceBaseUnits),
      rate: null,
      creditsRequired: null,
      creditsRequiredBaseUnits: null,
      commissionHbd,
      oracleStatus,
      asOfBlock: head
    });
    if (!seed || faceBaseUnits <= 0) {
      // No face price set at all — mirrors core.Ask's own "creator has no
      // face price set" guard (ask.go), checked BEFORE any settlement rate.
      return unpriced('unavailable');
    }

    // ★ RULING C: settlementRateBaseUnits(estimate, supplyTokens) now REFUSES
    // (rateBaseUnits: null) instead of falling back to PAR — mirrors
    // VscCreatorTokensDataSource.readQuote()'s identical rewrite.
    const estimate: AskRateEstimate =
      seed.supplyTokens === 0
        ? // No trading history yet (mock-empty) — matches AskRate's own
          // 'insufficient_observations' branch for a market nobody has touched.
          { rateBaseUnits: null, status: 'insufficient_observations' }
        : // Simulates a market with enough live trading history for AskRate to
          // produce a real TWAP ('ok').
          { rateBaseUnits: MOCK_RATE_BASE_UNITS, status: 'ok' };
    const settlement = settlementRateBaseUnits(estimate, seed.supplyTokens);
    if (settlement.rateBaseUnits === null) {
      return unpriced(settlement.status);
    }
    const creditsRequiredBaseUnits = creditsForAskBaseUnits(tokenLegBaseUnits, settlement.rateBaseUnits);
    return {
      creator,
      faceHbd: baseUnitsToHuman(faceBaseUnits),
      rate: baseUnitsToHuman(settlement.rateBaseUnits),
      // ask.go's escrowed "credits" spend the SAME whole-token balance
      // Buy/Sell operate on — creditsRequired is the same raw integer as
      // creditsRequiredBaseUnits, never baseUnitsToHuman'd.
      creditsRequired: creditsRequiredBaseUnits,
      creditsRequiredBaseUnits,
      commissionHbd,
      oracleStatus: settlement.status,
      asOfBlock: head
    };
  }

  async readFeeBalance(account: string): Promise<number> {
    await delay(80);
    return baseUnitsToHuman(getStorageItem<number>(feeBalKey(account)) ?? 0);
  }

  async quoteBuy(creator: string, tokens: number): Promise<BuyQuote> {
    await delay(80);
    const seed = this.seed(creator);
    if (!seed) throw new Error(`MockCreatorTokensDataSource: no such market ${creator}`);
    if (!Number.isInteger(tokens) || tokens <= 0) {
      throw new Error('MockCreatorTokensDataSource: tokens must be a positive whole number');
    }
    const market = this.buildMarket(creator, seed);
    if (!market.canBuy) {
      throw new Error('MockCreatorTokensDataSource: market inflow is not open (frozen, closed, retiring, or globally paused)');
    }
    if (seed.supplyTokens + tokens > seed.capTokens) {
      throw new Error('MockCreatorTokensDataSource: buy would exceed the market cap');
    }
    const q = quoteBuyBaseUnits(seed.supplyTokens, tokens);
    return {
      tokens: q.tokens,
      costHbd: baseUnitsToHuman(q.costBaseUnits),
      feeHbd: baseUnitsToHuman(q.feeBaseUnits),
      totalDueHbd: baseUnitsToHuman(q.totalDueBaseUnits),
      rateAfterHbd: baseUnitsToHuman(q.rateAfterBaseUnits)
    };
  }

  async quoteSell(creator: string, seller: string, tokens: number): Promise<SellQuote> {
    await delay(80);
    const seed = this.seed(creator);
    if (!seed) throw new Error(`MockCreatorTokensDataSource: no such market ${creator}`);
    if (!Number.isInteger(tokens) || tokens <= 0) {
      throw new Error('MockCreatorTokensDataSource: tokens must be a positive whole number');
    }
    const market = this.buildMarket(creator, seed);
    if (market.retiredAtBlock !== null || market.phase === 'FROZEN' || market.phase === 'CLOSED') {
      throw new Error('MockCreatorTokensDataSource: curve sell is closed while the market winds down (retired/frozen/closed); exit via refund() instead');
    }
    const { tokens: tokensHeld, heldBlocks } = readWalletEntry(creator, seller);
    if (tokens > tokensHeld) {
      throw new Error('MockCreatorTokensDataSource: insufficient tokens');
    }
    const q = quoteSellBaseUnits(seed.supplyTokens, tokens, heldBlocks);
    if (q === null) {
      throw new Error('MockCreatorTokensDataSource: sell exceeds supply');
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

  // ---- writes: simulate the contract's own arithmetic against the mutable
  // seed, then persist so a page reload during a demo keeps the change. ----

  async registerMarket(input: RegisterMarketInput): Promise<Market> {
    await delay(400);
    const firstBuyTokens = input.firstBuyTokens ?? 0;
    // launch.go RegisterWithFirstBuy: an ORDINARY Buy at supply === 0 (a
    // brand-new market) — same curve math as Area(0 + n) − Area(0) = Area(n).
    const reserveBaseUnits = firstBuyTokens > 0 ? areaBaseUnits(firstBuyTokens) : 0;
    const seed: MarketSeed = {
      faceBaseUnits: humanToBaseUnits(input.faceHbd),
      capTokens: input.capTokens,
      supplyTokens: firstBuyTokens,
      reserveBaseUnits,
      paidUntilDeltaBlocks: 30 * BLOCKS_PER_DAY,
      registeredAtDeltaBlocks: 0,
      faceSetAtDeltaBlocks: 0,
      closedStored: false,
      globalInflowPaused: false,
      retiredAtBlock: null
    };
    setStorageItem(marketKey(input.creator), seed, StorageTTL.SESSION);
    if (firstBuyTokens > 0) {
      // buy.go: "Buy mints only to the paying caller" — the creator IS the
      // buyer for the optional atomic first buy (launch.go's ZERO PREMINE
      // doc: no discount, ordinary curve cost).
      const head = mockHeadBlock();
      writeWalletEntry(input.creator, input.creator, mockCreditInflow(0, 0, firstBuyTokens, head));
      const { feeCreatorBaseUnits, feePlatformBaseUnits } = tradeFeeOn(reserveBaseUnits);
      accrueFee(input.creator, feeCreatorBaseUnits, feePlatformBaseUnits);
    }
    return this.buildMarket(input.creator, seed);
  }

  async renewSubscription(input: RenewSubscriptionInput): Promise<Market> {
    await delay(400);
    const seed = this.seed(input.creator);
    if (!seed) throw new Error(`MockCreatorTokensDataSource: no such market ${input.creator}`);
    const head = mockHeadBlock();
    const currentPaidUntil = head + seed.paidUntilDeltaBlocks;
    const base = Math.max(currentPaidUntil, head);
    const newPaidUntil = base + input.periods * 30 * BLOCKS_PER_DAY;
    const next: MarketSeed = { ...seed, paidUntilDeltaBlocks: newPaidUntil - head };
    setStorageItem(marketKey(input.creator), next, StorageTTL.SESSION);
    return this.buildMarket(input.creator, next);
  }

  async setFace(input: SetFaceInput): Promise<Market> {
    await delay(300);
    const seed = this.seed(input.creator);
    if (!seed) throw new Error(`MockCreatorTokensDataSource: no such market ${input.creator}`);
    const next: MarketSeed = { ...seed, faceBaseUnits: humanToBaseUnits(input.newFaceHbd), faceSetAtDeltaBlocks: 0 };
    setStorageItem(marketKey(input.creator), next, StorageTTL.SESSION);
    return this.buildMarket(input.creator, next);
  }

  async setCap(input: SetCapInput): Promise<Market> {
    await delay(300);
    const seed = this.seed(input.creator);
    if (!seed) throw new Error(`MockCreatorTokensDataSource: no such market ${input.creator}`);
    const newCapTokens = input.newCapTokens;
    if (!Number.isInteger(newCapTokens) || newCapTokens < seed.supplyTokens) {
      throw new Error('MockCreatorTokensDataSource: cap cannot be set below current supply');
    }
    const next: MarketSeed = { ...seed, capTokens: newCapTokens };
    setStorageItem(marketKey(input.creator), next, StorageTTL.SESSION);
    return this.buildMarket(input.creator, next);
  }

  async buy(input: BuyInput): Promise<HolderPosition> {
    await delay(400);
    const seed = this.seed(input.creator);
    if (!seed) throw new Error(`MockCreatorTokensDataSource: no such market ${input.creator}`);
    if (!Number.isInteger(input.tokens) || input.tokens <= 0) {
      throw new Error('MockCreatorTokensDataSource: tokens must be a positive whole number');
    }
    const head = mockHeadBlock();
    const market = this.buildMarket(input.creator, seed);
    if (!market.canBuy) {
      throw new Error('MockCreatorTokensDataSource: market inflow is not open (frozen, closed, retiring, or globally paused)');
    }
    const nextSupply = seed.supplyTokens + input.tokens;
    if (nextSupply > seed.capTokens) {
      throw new Error('MockCreatorTokensDataSource: buy would exceed the market cap');
    }
    // curve.go BuyCost: cost = Area(S+n) − Area(S), the exact area step. The
    // fee NEVER enters the reserve (buy.go) — only `cost` does.
    const cost = areaBaseUnits(nextSupply) - areaBaseUnits(seed.supplyTokens);
    const { feeCreatorBaseUnits, feePlatformBaseUnits } = tradeFeeOn(cost);

    const nextSeed: MarketSeed = { ...seed, supplyTokens: nextSupply, reserveBaseUnits: seed.reserveBaseUnits + cost };
    setStorageItem(marketKey(input.creator), nextSeed, StorageTTL.SESSION);

    const prior = readWalletEntry(input.creator, input.buyer);
    const next = mockCreditInflow(prior.tokens, prior.heldBlocks, input.tokens, head);
    writeWalletEntry(input.creator, input.buyer, next);

    accrueFee(input.creator, feeCreatorBaseUnits, feePlatformBaseUnits);

    const { netBaseUnits, taxBps } = refundNetBaseUnits(nextSeed.reserveBaseUnits, next.tokens, nextSeed.supplyTokens, next.heldBlocks);
    return {
      creator: input.creator,
      holder: input.buyer,
      tokensHeld: next.tokens,
      floorValueHbd: baseUnitsToHuman(netBaseUnits),
      heldBlocks: next.heldBlocks,
      exitTaxBps: taxBps
    };
  }

  async sell(input: SellInput): Promise<HolderPosition> {
    await delay(400);
    const seed = this.seed(input.creator);
    if (!seed) throw new Error(`MockCreatorTokensDataSource: no such market ${input.creator}`);
    if (!Number.isInteger(input.tokens) || input.tokens <= 0) {
      throw new Error('MockCreatorTokensDataSource: tokens must be a positive whole number');
    }
    const market = this.buildMarket(input.creator, seed);
    // sell.go's rail switch: the curve rail is CLOSED while the market winds
    // down (retired, or naturally FROZEN/CLOSED).
    if (market.retiredAtBlock !== null || market.phase === 'FROZEN' || market.phase === 'CLOSED') {
      throw new Error('MockCreatorTokensDataSource: curve sell is closed while the market winds down (retired/frozen/closed); exit via refund() instead');
    }
    const prior = readWalletEntry(input.creator, input.seller);
    if (input.tokens > prior.tokens) {
      throw new Error('MockCreatorTokensDataSource: insufficient tokens');
    }
    // curve.go SellProceeds: p = Area(S) − Area(S−ΔS), the exact area step —
    // the FULL slice, before the K2 tax and the trade fee.
    const nextSupply = seed.supplyTokens - input.tokens;
    const gross = areaBaseUnits(seed.supplyTokens) - areaBaseUnits(nextSupply);
    const taxBps = exitTaxBpsAt(prior.heldBlocks);
    const tax = exitTaxOnBaseUnits(gross, taxBps);
    const { feeCreatorBaseUnits, feePlatformBaseUnits } = tradeFeeOn(gross);

    const nextSeed: MarketSeed = { ...seed, supplyTokens: nextSupply, reserveBaseUnits: seed.reserveBaseUnits - gross };
    setStorageItem(marketKey(input.creator), nextSeed, StorageTTL.SESSION);

    // Selling never re-ages the remainder (holdclock.go debitBalance: wacq is
    // untouched by a debit).
    const nextEntry: WalletEntry = { tokens: prior.tokens - input.tokens, heldBlocks: prior.heldBlocks };
    writeWalletEntry(input.creator, input.seller, nextEntry);

    addTreasury(tax); // sell.go RULING J/K: the exit tax goes to the treasury, never the holder pot
    accrueFee(input.creator, feeCreatorBaseUnits, feePlatformBaseUnits);

    const { netBaseUnits, taxBps: nextTaxBps } =
      nextSeed.supplyTokens > 0
        ? refundNetBaseUnits(nextSeed.reserveBaseUnits, nextEntry.tokens, nextSeed.supplyTokens, nextEntry.heldBlocks)
        : { netBaseUnits: 0, taxBps: exitTaxBpsAt(nextEntry.heldBlocks) };
    return {
      creator: input.creator,
      holder: input.seller,
      tokensHeld: nextEntry.tokens,
      floorValueHbd: baseUnitsToHuman(netBaseUnits),
      heldBlocks: nextEntry.heldBlocks,
      exitTaxBps: nextTaxBps
    };
  }

  async retire(input: RetireInput): Promise<Market> {
    await delay(300);
    const seed = this.seed(input.creator);
    if (!seed) throw new Error(`MockCreatorTokensDataSource: no such market ${input.creator}`);
    // market.go Retire: ONCE-ONLY — a second call cannot restart the notice
    // window (RULING D: retiring may only ever make a market MORE frozen).
    if (seed.retiredAtBlock !== null) {
      throw new Error('MockCreatorTokensDataSource: market is already retiring; the notice window cannot be restarted');
    }
    const next: MarketSeed = { ...seed, retiredAtBlock: mockHeadBlock() };
    setStorageItem(marketKey(input.creator), next, StorageTTL.SESSION);
    return this.buildMarket(input.creator, next);
  }

  async ask(input: AskInput): Promise<Ask> {
    await delay(400);
    // Gate on creditsRequiredBaseUnits being priceable, NOT on
    // oracleStatus === 'ok' — RULING C's settlement REFUSES rather than
    // falling back to PAR, and creditsRequiredBaseUnits === null is the exact
    // signal that a real ask() would ALSO refuse right now.
    const quote = await this.readQuote(input.creator);
    if (quote.creditsRequiredBaseUnits === null) {
      throw new Error(`MockCreatorTokensDataSource: unable to price this ask (${quote.oracleStatus})`);
    }
    const seeds = getStorageItem<AskSeed[]>(asksKey(input.creator)) ?? ASK_SEEDS[input.creator] ?? [];
    const seq = seeds.reduce((max, s) => Math.max(max, s.seq), -1) + 1;
    const head = mockHeadBlock();
    const newSeed: AskSeed = {
      seq,
      asker: input.asker,
      creditsBaseUnits: quote.creditsRequiredBaseUnits,
      deadlineDeltaBlocks: input.deadlineBlocks,
      rawStatus: 'PENDING',
      contentHash: input.contentHash,
      answerHash: null
    };
    setStorageItem(asksKey(input.creator), [...seeds, newSeed], StorageTTL.SESSION);
    return this.buildAsk(input.creator, newSeed, head);
  }

  async answer(input: AnswerInput): Promise<Ask> {
    await delay(400);
    const seeds = getStorageItem<AskSeed[]>(asksKey(input.creator)) ?? ASK_SEEDS[input.creator] ?? [];
    const idx = seeds.findIndex((s) => s.seq === input.seq);
    if (idx < 0) throw new Error(`MockCreatorTokensDataSource: no such escrow ${input.creator}:${input.seq}`);
    const updated: AskSeed = { ...seeds[idx], rawStatus: 'ANSWERED', answerHash: input.answerHash };
    const next = [...seeds];
    next[idx] = updated;
    setStorageItem(asksKey(input.creator), next, StorageTTL.SESSION);
    return this.buildAsk(input.creator, updated, mockHeadBlock());
  }

  async rate(_input: RateInput): Promise<void> {
    await delay(300);
  }

  async decline(input: DeclineInput): Promise<Ask> {
    await delay(400);
    const seeds = getStorageItem<AskSeed[]>(asksKey(input.creator)) ?? ASK_SEEDS[input.creator] ?? [];
    const idx = seeds.findIndex((s) => s.seq === input.seq);
    if (idx < 0) throw new Error(`MockCreatorTokensDataSource: no such escrow ${input.creator}:${input.seq}`);
    const updated: AskSeed = { ...seeds[idx], rawStatus: 'DECLINED' };
    const next = [...seeds];
    next[idx] = updated;
    setStorageItem(asksKey(input.creator), next, StorageTTL.SESSION);
    return this.buildAsk(input.creator, updated, mockHeadBlock());
  }

  async reclaim(input: ReclaimInput): Promise<Ask> {
    await delay(400);
    const seeds = getStorageItem<AskSeed[]>(asksKey(input.creator)) ?? ASK_SEEDS[input.creator] ?? [];
    const idx = seeds.findIndex((s) => s.seq === input.seq);
    if (idx < 0) throw new Error(`MockCreatorTokensDataSource: no such escrow ${input.creator}:${input.seq}`);
    const updated: AskSeed = { ...seeds[idx], rawStatus: 'RECLAIMED' };
    const next = [...seeds];
    next[idx] = updated;
    setStorageItem(asksKey(input.creator), next, StorageTTL.SESSION);
    return this.buildAsk(input.creator, updated, mockHeadBlock());
  }

  async refund(input: RefundInput): Promise<HolderPosition> {
    await delay(400);
    const seed = this.seed(input.creator);
    if (!seed) throw new Error(`MockCreatorTokensDataSource: no such market ${input.creator}`);
    if (!Number.isInteger(input.tokens) || input.tokens <= 0) {
      throw new Error('MockCreatorTokensDataSource: tokens must be a positive whole number');
    }
    const market = this.buildMarket(input.creator, seed);
    // refund.go Refund: the WIND-DOWN rail — inWindDown ONLY (retired, or
    // naturally FROZEN/CLOSED). While the market trades, the exit is sell().
    if (!(market.retiredAtBlock !== null || market.phase === 'FROZEN' || market.phase === 'CLOSED')) {
      throw new Error('MockCreatorTokensDataSource: pro-rata refund opens only at wind-down (retired/frozen/closed); while the market trades, exit via sell() instead');
    }
    const prior = readWalletEntry(input.creator, input.holder);
    if (input.tokens > prior.tokens) {
      throw new Error('MockCreatorTokensDataSource: insufficient tokens');
    }
    // refund.go refundPayout: floor(reserve*tokens/supply) — the GROSS
    // pro-rata slice. Deliberately NOT an area step — see
    // fixtures.ts's MarketSeed.reserveBaseUnits doc for why the reserve
    // legitimately drifts from Area(remaining supply) on this rail.
    const gross = refundPayoutBaseUnits(seed.reserveBaseUnits, input.tokens, seed.supplyTokens);
    const taxBps = exitTaxBpsAt(prior.heldBlocks);
    const tax = exitTaxOnBaseUnits(gross, taxBps);
    // ECON-2 (RULING, intended policy): NO trade fee on the wind-down rail —
    // only the K2 exit tax is carved from the payout.

    const nextSeed: MarketSeed = { ...seed, supplyTokens: seed.supplyTokens - input.tokens, reserveBaseUnits: seed.reserveBaseUnits - gross };
    setStorageItem(marketKey(input.creator), nextSeed, StorageTTL.SESSION);

    const nextEntry: WalletEntry = { tokens: prior.tokens - input.tokens, heldBlocks: prior.heldBlocks };
    writeWalletEntry(input.creator, input.holder, nextEntry);

    addTreasury(tax);

    const { netBaseUnits, taxBps: nextTaxBps } =
      nextSeed.supplyTokens > 0
        ? refundNetBaseUnits(nextSeed.reserveBaseUnits, nextEntry.tokens, nextSeed.supplyTokens, nextEntry.heldBlocks)
        : { netBaseUnits: 0, taxBps: exitTaxBpsAt(nextEntry.heldBlocks) };
    return {
      creator: input.creator,
      holder: input.holder,
      tokensHeld: nextEntry.tokens,
      floorValueHbd: baseUnitsToHuman(netBaseUnits),
      heldBlocks: nextEntry.heldBlocks,
      exitTaxBps: nextTaxBps
    };
  }

  async refundHolder(input: RefundHolderInput): Promise<HolderPosition> {
    // Permissionless push: pays `holder` regardless of who called it — same
    // simulated arithmetic as refund(), just keyed on the payee, and always
    // for the holder's WHOLE balance (refund.go RefundHolder).
    const position = await this.readHolderPosition(input.creator, input.holder);
    if (!position || position.tokensHeld <= 0) {
      return { creator: input.creator, holder: input.holder, tokensHeld: 0, floorValueHbd: 0, heldBlocks: position?.heldBlocks ?? 0, exitTaxBps: 0 };
    }
    return this.refund({ creator: input.creator, holder: input.holder, tokens: position.tokensHeld });
  }

  async transferTokens(input: TransferTokensInput): Promise<void> {
    await delay(400);
    if (!Number.isInteger(input.tokens) || input.tokens <= 0) {
      throw new Error('MockCreatorTokensDataSource: tokens must be a positive whole number');
    }
    const head = mockHeadBlock();
    const from = readWalletEntry(input.creator, input.from);
    if (input.tokens > from.tokens) {
      throw new Error('MockCreatorTokensDataSource: insufficient balance');
    }
    writeWalletEntry(input.creator, input.from, { tokens: from.tokens - input.tokens, heldBlocks: from.heldBlocks });

    // core.TransferCredits re-averages the RECIPIENT's hold clock toward now
    // (LOCKED-MECHANISM: "reset on any inflow/transfer" — kills OTC age
    // laundering), mirroring the same creditInflow chokepoint Buy uses.
    const to = readWalletEntry(input.creator, input.to);
    writeWalletEntry(input.creator, input.to, mockCreditInflow(to.tokens, to.heldBlocks, input.tokens, head));
  }

  async claimTradeFees(input: ClaimTradeFeesInput): Promise<number> {
    await delay(300);
    const owedBaseUnits = getStorageItem<number>(feeBalKey(input.account)) ?? 0;
    if (owedBaseUnits > 0) setStorageItem(feeBalKey(input.account), 0, StorageTTL.SESSION);
    return baseUnitsToHuman(owedBaseUnits);
  }

  async closeIfDrained(input: CloseIfDrainedInput): Promise<boolean> {
    await delay(200);
    const seed = this.seed(input.creator);
    if (!seed) return false;
    const market = this.buildMarket(input.creator, seed);
    if (market.phase === 'CLOSED') return true;
    if (market.phase === 'FROZEN' && seed.supplyTokens === 0) {
      const next: MarketSeed = { ...seed, closedStored: true };
      setStorageItem(marketKey(input.creator), next, StorageTTL.SESSION);
      return true;
    }
    return false;
  }

  async withdrawTreasury(input: WithdrawTreasuryInput): Promise<number> {
    await delay(300);
    if (!Number.isFinite(input.amountHbd) || input.amountHbd <= 0) {
      throw new Error('MockCreatorTokensDataSource: amountHbd must be positive');
    }
    const amountBaseUnits = humanToBaseUnits(input.amountHbd);
    const balance = getStorageItem<number>(treasuryKey()) ?? 0;
    if (amountBaseUnits > balance) {
      throw new Error('MockCreatorTokensDataSource: amount exceeds treasury balance');
    }
    setStorageItem(treasuryKey(), balance - amountBaseUnits, StorageTTL.SESSION);
    return input.amountHbd;
  }
}
