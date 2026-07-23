import { getStorageItem, setStorageItem, StorageTTL } from '@ui/lib/storage-with-ttl';
import type {
  Ask,
  AskInput,
  AnswerInput,
  DeliveryRecord,
  HolderPosition,
  MyAsksResult,
  WalletPositionsResult,
  Market,
  PrepayInput,
  Quote,
  ReclaimInput,
  RefundHolderInput,
  RefundInput,
  RegisterMarketInput,
  RenewSubscriptionInput,
  SetCapInput,
  SetFaceInput,
  TransferCreditsInput
} from '../../types';
import type { CreatorTokensDataSource } from '../creator-tokens-data-source';
import {
  BLOCKS_PER_DAY,
  canInflowOpen,
  RECLAIM_GRACE_BLOCKS,
  baseUnitsToHuman,
  blockToEpochMs,
  commissionOwedForBaseUnits,
  creditsForAskBaseUnits,
  deriveAskStatus,
  deriveFaceBandBaseUnits,
  deriveGraceExpiresAtBlock,
  derivePhase,
  floorRatioForDisplay,
  humanToBaseUnits,
  refundPayoutBaseUnits,
  settlementRateBaseUnits,
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

const walletKey = (holder: string) => `ct-mock-wallet-${holder}`;
const asksKey = (creator: string) => `ct-mock-asks-${creator}`;
const marketKey = (creator: string) => `ct-mock-market-${creator}`;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * In-memory + SESSION-TTL-persisted mock. Reads are pure functions of the
 * seeds in ./fixtures plus whatever a prior write persisted this session;
 * writes simulate the contract's own arithmetic (via the shared
 * lib/contract-math.ts helpers every real VscCreatorTokensDataSource call
 * also uses) so the numbers a demo shows stay internally consistent.
 * Mock-only: the real source must never persist state client-side.
 */
export class MockCreatorTokensDataSource implements CreatorTokensDataSource {
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
    const phase = derivePhase(seed.closedStored, paidUntilBlock, head);
    const graceExpiresAtBlock = deriveGraceExpiresAtBlock(paidUntilBlock);
    // deriveFaceBandBaseUnits gained an anchor pair (kFaceAnchor/kFaceAnchorAt)
    // 2026-07-20 (see contract-math.ts's doc) — MarketSeed has no fixture field
    // for it (none of the seeded scenarios exercise a second SetFace call
    // inside the same 7-day window), so 0/0 is passed, which makes the
    // function bootstrap the anchor from the current face/faceSetAtBlock every
    // time, exactly matching this mock's pre-existing (single-change) fixture
    // behaviour. A multi-call-within-window fixture is out of scope for this
    // pass — see the report.
    const faceBandRaw = deriveFaceBandBaseUnits(seed.faceBaseUnits, faceSetAtBlock, 0, 0, head);
    const globalInflowPaused = seed.globalInflowPaused;
    const canFlow = canInflowOpen(phase, globalInflowPaused);
    return {
      creator,
      faceHbd: baseUnitsToHuman(seed.faceBaseUnits),
      faceSetAtBlock,
      faceBand: {
        minHbd: baseUnitsToHuman(faceBandRaw.minHbd),
        maxHbd: baseUnitsToHuman(faceBandRaw.maxHbd),
        bandActive: faceBandRaw.bandActive,
        windowEndsAtBlock: faceBandRaw.windowEndsAtBlock
      },
      capCredits: baseUnitsToHuman(seed.capBaseUnits),
      supplyCredits: baseUnitsToHuman(seed.supplyBaseUnits),
      reserveHbd: baseUnitsToHuman(seed.reserveBaseUnits),
      paidUntilBlock,
      paidUntilAt: blockToEpochMs(paidUntilBlock, head),
      registeredAtBlock,
      phase,
      graceExpiresAtBlock,
      graceExpiresAt: blockToEpochMs(graceExpiresAtBlock, head),
      globalInflowPaused,
      canPrepay: canFlow,
      canAsk: canFlow,
      // A dimensionless ratio (reserve/supply, both in the same base-unit
      // scale) is identical whether computed from base units or from human
      // units — no baseUnitsToHuman conversion applies here, unlike every
      // other money field on this object.
      refundPricePerCredit: floorRatioForDisplay(seed.reserveBaseUnits, seed.supplyBaseUnits)
    };
  }

  async readMarket(creator: string): Promise<Market | null> {
    await delay(120);
    if (creator === MOCK_UNKNOWN) {
      // Simulates a contract read that failed: resolve with UNKNOWN rather
      // than reject, exactly as VscCreatorTokensDataSource.readMarket must
      // (see the interface doc — this is the one method with that contract).
      // Reuses the SAME builder the real data source uses (reads.ts's
      // unknownMarket) instead of a hand-duplicated shape (cleanup item):
      // the inline version had drifted — it used
      // blockToEpochMs(0, mockHeadBlock()) for paidUntilAt/graceExpiresAt,
      // which (mockHeadBlock() being ~400,000,000) computed a timestamp
      // hundreds of millions of blocks in the PAST, instead of the "now"
      // fallback unknownMarket() actually returns for an unusable read.
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
    const persisted = getStorageItem<Record<string, number>>(walletKey(holder));
    const persistedCredits = persisted?.[creator];
    const seededCredits = HOLDER_SEEDS[creator]?.find((h) => h.holder === holder)?.creditsBaseUnits ?? 0;
    const creditsBaseUnits = persistedCredits ?? seededCredits;
    const floorBaseUnits = seed.supplyBaseUnits > 0 ? refundPayoutBaseUnits(seed.reserveBaseUnits, creditsBaseUnits, seed.supplyBaseUnits) : 0;
    return {
      creator,
      holder,
      creditsHeld: baseUnitsToHuman(creditsBaseUnits),
      floorValueHbd: baseUnitsToHuman(floorBaseUnits)
    };
  }

  async readWallet(holder: string): Promise<WalletPositionsResult> {
    await delay(150);
    const persisted = getStorageItem<Record<string, number>>(walletKey(holder)) ?? {};
    const creators = new Set<string>(Object.keys(persisted));
    for (const [creator, holders] of Object.entries(HOLDER_SEEDS)) {
      if (holders.some((h) => h.holder === holder)) creators.add(creator);
    }
    const positions = await Promise.all(Array.from(creators).map((creator) => this.readHolderPosition(creator, holder)));
    // The mock always has data available, so unavailable is false; the field
    // exists so a consumer can distinguish "loaded, you hold nothing" (this)
    // from "the indexer read failed" (the VSC source's unavailable:true).
    return { positions: positions.filter((p): p is HolderPosition => p !== null && p.creditsHeld > 0), unavailable: false };
  }

  private buildAsk(creator: string, s: AskSeed, head: number): Ask {
    const deadlineBlock = head + s.deadlineDeltaBlocks;
    const reclaimableAtBlock = deadlineBlock + RECLAIM_GRACE_BLOCKS;
    return {
      id: `${creator}:${s.seq}`,
      creator,
      seq: s.seq,
      asker: s.asker,
      creditsEscrowed: baseUnitsToHuman(s.creditsBaseUnits),
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
    const commissionHbd = baseUnitsToHuman(commissionOwedForBaseUnits(faceBaseUnits));
    if (!seed || faceBaseUnits <= 0) {
      // No face price set at all — mirrors core.Ask's own "creator has no
      // face price set" guard (ask.go), checked BEFORE any settlement rate
      // (TWAP or PAR). Unlike a missing TWAP, there is no PAR fallback for
      // this: creditsForAsk(0, PAR) is meaningless.
      return { creator, faceHbd: baseUnitsToHuman(faceBaseUnits), rate: null, creditsRequired: null, creditsRequiredBaseUnits: null, commissionHbd, oracleStatus: 'unavailable', asOfBlock: head };
    }
    if (seed.supplyBaseUnits === 0) {
      // No trading history yet (mock-empty) — matches AskRate's own
      // 'insufficient_observations' branch for a market nobody has touched.
      // C-C fix: still prices at PAR, never null — core.SettlementRate
      // (ask.go) falls back to PAR whenever AskRate can't produce a TWAP,
      // which is the DEFAULT state for a live deployment today (no DEX pool
      // is wired to ever feed the ring). A pre-fix version of this mock (and
      // of the real vsc-data-source.ts) returned rate:null/
      // creditsRequired:null here and let ask() hard-throw on it.
      const estimate: AskRateEstimate = { rateBaseUnits: null, status: 'insufficient_observations' };
      const settlement = settlementRateBaseUnits(estimate);
      const creditsRequiredBaseUnits = creditsForAskBaseUnits(faceBaseUnits, settlement.rateBaseUnits);
      return {
        creator,
        faceHbd: baseUnitsToHuman(faceBaseUnits),
        rate: baseUnitsToHuman(settlement.rateBaseUnits),
        creditsRequired: baseUnitsToHuman(creditsRequiredBaseUnits),
        creditsRequiredBaseUnits,
        commissionHbd,
        oracleStatus: 'insufficient_observations',
        asOfBlock: head
      };
    }
    // Simulates a market with enough live trading history for AskRate to
    // produce a real TWAP ('ok') — see fixtures.ts's own doc on
    // MOCK_RATE_BASE_UNITS for why it must stay a small, exactly-divide-
    // friendly integer (core's rate scale has PAR itself as the literal
    // integer 1, params.go ParBaseUnitsPerCredit — NOT a 3-decimal-scaled
    // ratio the way HBD/credit AMOUNTS are).
    const rate = MOCK_RATE_BASE_UNITS;
    const creditsRequiredBaseUnits = creditsForAskBaseUnits(faceBaseUnits, rate);
    return {
      creator,
      faceHbd: baseUnitsToHuman(faceBaseUnits),
      rate: baseUnitsToHuman(rate),
      creditsRequired: baseUnitsToHuman(creditsRequiredBaseUnits),
      creditsRequiredBaseUnits,
      commissionHbd,
      oracleStatus: 'ok',
      asOfBlock: head
    };
  }

  // ---- writes: simulate the contract's own arithmetic against the mutable
  // seed, then persist so a page reload during a demo keeps the change. ----

  async registerMarket(input: RegisterMarketInput): Promise<Market> {
    await delay(400);
    const seed: MarketSeed = {
      faceBaseUnits: humanToBaseUnits(input.faceHbd),
      capBaseUnits: humanToBaseUnits(input.capCredits),
      supplyBaseUnits: 0,
      reserveBaseUnits: 0,
      paidUntilDeltaBlocks: 30 * BLOCKS_PER_DAY,
      registeredAtDeltaBlocks: 0,
      faceSetAtDeltaBlocks: 0,
      closedStored: false,
      globalInflowPaused: false
    };
    setStorageItem(marketKey(input.creator), seed, StorageTTL.SESSION);
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
    const newCapBaseUnits = humanToBaseUnits(input.newCapCredits);
    if (newCapBaseUnits < seed.supplyBaseUnits) {
      throw new Error('MockCreatorTokensDataSource: cap cannot be set below current supply');
    }
    const next: MarketSeed = { ...seed, capBaseUnits: newCapBaseUnits };
    setStorageItem(marketKey(input.creator), next, StorageTTL.SESSION);
    return this.buildMarket(input.creator, next);
  }

  async prepay(input: PrepayInput): Promise<HolderPosition> {
    await delay(400);
    const seed = this.seed(input.creator);
    if (!seed) throw new Error(`MockCreatorTokensDataSource: no such market ${input.creator}`);
    const hbdBaseUnits = humanToBaseUnits(input.hbdAmount);
    const nextSupply = seed.supplyBaseUnits + hbdBaseUnits; // PAR: exact copy, matching prepay.go
    if (nextSupply > seed.capBaseUnits) throw new Error('MockCreatorTokensDataSource: prepay would exceed the market cap');
    const next: MarketSeed = { ...seed, supplyBaseUnits: nextSupply, reserveBaseUnits: seed.reserveBaseUnits + hbdBaseUnits };
    setStorageItem(marketKey(input.creator), next, StorageTTL.SESSION);

    const wallet = getStorageItem<Record<string, number>>(walletKey(input.holder)) ?? {};
    const seededCredits = HOLDER_SEEDS[input.creator]?.find((h) => h.holder === input.holder)?.creditsBaseUnits ?? 0;
    const priorCredits = wallet[input.creator] ?? seededCredits;
    const nextCredits = priorCredits + hbdBaseUnits;
    wallet[input.creator] = nextCredits;
    setStorageItem(walletKey(input.holder), wallet, StorageTTL.SESSION);

    const floorBaseUnits = refundPayoutBaseUnits(next.reserveBaseUnits, nextCredits, next.supplyBaseUnits);
    return { creator: input.creator, holder: input.holder, creditsHeld: baseUnitsToHuman(nextCredits), floorValueHbd: baseUnitsToHuman(floorBaseUnits) };
  }

  async ask(input: AskInput): Promise<Ask> {
    await delay(400);
    // C-C fix, mirrored from vsc-data-source.ts's identical fix: gate on
    // creditsRequiredBaseUnits being priceable, NOT on oracleStatus === 'ok'
    // — core.SettlementRate (ask.go) never fails, it settles at PAR whenever
    // the TWAP's own guards don't pass, so a non-'ok' oracleStatus alone
    // must not block an ask. The only genuine block is a market with no
    // face price at all (creditsRequiredBaseUnits === null — see
    // readQuote() above).
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
    const creditsBaseUnits = humanToBaseUnits(input.credits);
    const wallet = getStorageItem<Record<string, number>>(walletKey(input.holder)) ?? {};
    const seededCredits = HOLDER_SEEDS[input.creator]?.find((h) => h.holder === input.holder)?.creditsBaseUnits ?? 0;
    const priorCredits = wallet[input.creator] ?? seededCredits;
    if (creditsBaseUnits > priorCredits) throw new Error('MockCreatorTokensDataSource: insufficient credits');

    const payoutBaseUnits = refundPayoutBaseUnits(seed.reserveBaseUnits, creditsBaseUnits, seed.supplyBaseUnits);
    const nextMarket: MarketSeed = {
      ...seed,
      supplyBaseUnits: seed.supplyBaseUnits - creditsBaseUnits,
      reserveBaseUnits: seed.reserveBaseUnits - payoutBaseUnits
    };
    setStorageItem(marketKey(input.creator), nextMarket, StorageTTL.SESSION);

    const nextCredits = priorCredits - creditsBaseUnits;
    wallet[input.creator] = nextCredits;
    setStorageItem(walletKey(input.holder), wallet, StorageTTL.SESSION);

    const floorBaseUnits = nextMarket.supplyBaseUnits > 0 ? refundPayoutBaseUnits(nextMarket.reserveBaseUnits, nextCredits, nextMarket.supplyBaseUnits) : 0;
    return { creator: input.creator, holder: input.holder, creditsHeld: baseUnitsToHuman(nextCredits), floorValueHbd: baseUnitsToHuman(floorBaseUnits) };
  }

  async refundHolder(input: RefundHolderInput): Promise<HolderPosition> {
    // Permissionless push: pays `holder` regardless of who called it — same
    // simulated arithmetic as refund(), just keyed on the payee.
    const position = await this.readHolderPosition(input.creator, input.holder);
    if (!position || position.creditsHeld <= 0) {
      return { creator: input.creator, holder: input.holder, creditsHeld: 0, floorValueHbd: 0 };
    }
    return this.refund({ creator: input.creator, holder: input.holder, credits: position.creditsHeld });
  }

  async transferCredits(input: TransferCreditsInput): Promise<void> {
    await delay(400);
    const amountBaseUnits = humanToBaseUnits(input.amount);
    const fromWallet = getStorageItem<Record<string, number>>(walletKey(input.from)) ?? {};
    const seededFrom = HOLDER_SEEDS[input.creator]?.find((h) => h.holder === input.from)?.creditsBaseUnits ?? 0;
    const fromCredits = fromWallet[input.creator] ?? seededFrom;
    if (amountBaseUnits > fromCredits) throw new Error('MockCreatorTokensDataSource: insufficient balance');
    fromWallet[input.creator] = fromCredits - amountBaseUnits;
    setStorageItem(walletKey(input.from), fromWallet, StorageTTL.SESSION);

    const toWallet = getStorageItem<Record<string, number>>(walletKey(input.to)) ?? {};
    const seededTo = HOLDER_SEEDS[input.creator]?.find((h) => h.holder === input.to)?.creditsBaseUnits ?? 0;
    const toCredits = toWallet[input.creator] ?? seededTo;
    toWallet[input.creator] = toCredits + amountBaseUnits;
    setStorageItem(walletKey(input.to), toWallet, StorageTTL.SESSION);
  }
}
