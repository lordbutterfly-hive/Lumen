// Domain types for Creator Tokens (SPEC-CREATOR-KEYS.md §1, /mnt/o/CREATOR-TOKENS/core/*.go).
// Zero logic here — mirrors the "zero logic" convention of
// features/prediction-market/types.ts. Derivation lives in
// lib/contract-math.ts so mock and vsc agree on one implementation.
//
// ★ THE BONDING-CURVE PIVOT (2026-07-21/24, RULINGS-v2): the contract moved
// from a PAR "access credit" model (1 credit === 1 HBD base unit at
// issuance, core/prepay.go — DELETED) to a bonding curve (core/curve.go):
// price(i) = BasePrice + a·i + b·i², reserve === Area(supply) with EQUALITY
// at every reachable state. This file was rewritten to match.
//
// ★★ THE 1000x UNIT TRAP — read before touching ANY numeric field below.
// Under PAR, a "credit" was a 3-decimal quantity sharing HBD's own
// granularity, so baseUnitsToHuman() (divide by 1000) applied to both money
// AND credits. Under the curve, TOKENS ARE WHOLE INTEGERS: supply, cap,
// balances and every `tokens` field on this page are plain integer counts —
// NEVER run through baseUnitsToHuman()/humanToBaseUnits(). Only HBD amounts
// (face, reserve, cost, fee, tax, net, floor/spot price) use that 3-decimal
// conversion. Fields are named *Tokens (integer) vs *Hbd (human 3-decimal)
// throughout this file specifically so a reviewer can catch a misrouted
// conversion by name alone.
//
// Money convention (HBD only): every *Hbd field below is a HUMAN number (3
// decimals, e.g. 2.5 HBD), matching features/prediction-market/lib/vsc-money.ts's
// baseUnitsToHuman output — never a raw base-unit integer.
//
// Block-height fields are raw uint64 block heights (core/params.go:
// BlocksPerDay = 28800, ~3s/block); `*At` sibling fields are epoch-ms estimates
// derived the same way vsc-market-data-source.ts's deriveClosesAt() does.

/**
 * ACTIVE|OVERDUE|FROZEN|CLOSED are the exact four values core/market.go's
 * Phase() can return (params.go StateActive/StateOverdue/StateFrozen/
 * StateClosed) — never invented, never trusted from a stored field beyond the
 * one case Phase() itself trusts (stored CLOSED).
 *
 * UNKNOWN does not exist in the contract. It is a frontend-only value assigned
 * by a data source when a chain read fails, so the UI can render "Status
 * unavailable" and disable actions (UI-BRIEF §2.2, spec §2.2: "if the contract
 * read fails, the UI must say so and disable actions rather than render a
 * stale or optimistic state").
 */
export type MarketPhase = 'ACTIVE' | 'OVERDUE' | 'FROZEN' | 'CLOSED' | 'UNKNOWN';

/**
 * The 2x/7-day anti-rug band a new SetFace call must land inside (market.go
 * SetFace). The band anchors to a rolling WINDOW (kFaceAnchor/kFaceAnchorAt),
 * not to the last change — see lib/contract-math.ts's deriveFaceBandBaseUnits
 * doc for the full mirror. windowEndsAtBlock is when the CURRENT window
 * (possibly just re-anchored) ends; a new one opens immediately after, still
 * centered on whatever face is in effect then — the band never actually
 * lifts for a registered market. Unaffected by the curve pivot.
 */
export interface FaceBand {
  minHbd: number;
  maxHbd: number;
  /** True for every registered market in practice — see deriveFaceBandBaseUnits's doc for the one (unreachable) case this is false. */
  bandActive: boolean;
  windowEndsAtBlock: number;
}

/**
 * One creator's spot price for a compact display (a feed chip, a byline pill).
 *
 * Three states on purpose. A price of 0 cannot say WHY it is 0, and the three
 * reasons need different UI: `ready` has a market and a figure, `none` has no
 * market at all (so a Buy affordance would be a dead control), and `unknown` is
 * "we have not been told" — a failed read, which must never be rendered as
 * "this creator has no token".
 */
export interface MarketPrice {
  status: 'ready' | 'none' | 'unknown';
  priceUsd: number | null;
  /**
   * Non-null only when status === 'ready'. A price with no health is exactly
   * how five surfaces came to draw "Buy" on frozen markets (2026-08-30, B4);
   * see market/market-health.ts. Required, not optional, so no producer can
   * forget it.
   */
  health: MarketHealth | null;
}

/**
 * Whether a market can take a buyer's money right now, as one word. Derived by
 * market/market-health.ts's `marketHealthOf` from phase + canBuy + wind-down;
 * defined here beside MarketPrice so types.ts does not import from market/.
 *   open      buy and ask work
 *   lapsed    OVERDUE and still buyable (the token page shows a warning banner)
 *   delisted  a natural FROZEN under the v2 rules (A1, 2026-08-30): buying is
 *             closed, the creator can pay to relist, holders are not winding
 *             down. Cannot occur under v1, where the same phase is `closed`.
 *   closed    winding down: retired or CLOSED, and under v1 a natural FROZEN
 *             too (sell.go refuses there; see ContractRules)
 *   paused    delinquent creator or the global inflow pause
 * ★ Sold-out is deliberately NOT a health (owner, 2026-08-30: "on hbd temp
 * pill says sold out. thats stupid and wrong"). Health answers "is something
 * wrong with this creator"; a sold-out market is a healthy, paid-up creator
 * whose legacy supply cap was reached. It is a fact about the BUY ACTION only
 * (market/market-health.ts soldOutOf + SOLD_OUT_WORD), never a warning.
 */
export type MarketHealth = 'open' | 'lapsed' | 'delisted' | 'closed' | 'paused';

/**
 * Which contract rules the app believes are DEPLOYED, derived from the chain
 * (market/contract-rules.ts has the whole story and the deploy order). 'v1' is
 * the contract live on both networks on 2026-08-31; 'v2' is the A1 lapse
 * change (a natural FROZEN is an inflow stop, not a wind-down; Renew admits
 * it behind a reserve check). Every default and every failed read is 'v1'.
 */
export type ContractRules = 'v1' | 'v2';

/**
 * Why `Market.canRenew` is false, in the contract's own terms, so the Studio
 * can say the true sentence instead of a generic one. `lapsed-terminal` is a
 * v1 FROZEN (the chain refuses the payment forever); `surplus` and `deficit`
 * are v2's revival check (reserve above / below the curve's area, so the
 * market cannot be revived: Retire, then re-register). Named here, worded in
 * market/lapse.ts.
 */
export type RenewRefusal = 'paused' | 'retired' | 'closed' | 'lapsed-terminal' | 'surplus' | 'deficit';

export interface Market {
  creator: string;
  faceHbd: number;
  faceSetAtBlock: number;
  faceBand: FaceBand;
  /**
   * core/keys.go kCap — the maximum number of tokens this market may ever
   * mint (market.go SetCap, launch.go/RegisterWithFirstBuy). INTEGER token
   * count — never baseUnitsToHuman'd (see the file-level 1000x-trap note).
   */
  capTokens: number;
  /**
   * core/keys.go kSupply — tokens currently outstanding (held + escrowed,
   * I3). INTEGER token count, never baseUnitsToHuman'd.
   */
  supplyTokens: number;
  /** core/keys.go kReserve — the HBD backing this market. R === Area(supplyTokens) WITH EQUALITY at every reachable trading state (curve.go's governing invariant); see reserveCoverage below for that as a ratio. */
  reserveHbd: number;
  paidUntilBlock: number;
  paidUntilAt: number;
  registeredAtBlock: number;
  phase: MarketPhase;
  /**
   * paidUntilBlock + GraceBlocks — the block OVERDUE turns into FROZEN.
   * core/keys.go declares a kFrozenAt key but no module in the read core
   * ever writes it, so "when did this freeze" is not stored state — it is
   * this exact arithmetic, always defined, meaningful only once the market
   * has actually lapsed.
   */
  graceExpiresAtBlock: number;
  graceExpiresAt: number;
  /** kPaused (keys.go) — global inbound pause, independent of this market's own phase. */
  globalInflowPaused: boolean;
  /**
   * The rule set this Market was derived under (ContractRules). Set by the
   * data source from the chain's own report of the deployed bytecode, never
   * by the UI. `windingDown`, `canRenew`, `renewRefusal` and the health word
   * all depend on it; a consumer that needs to branch on the contract should
   * branch on those derived fields, and on this only to explain them.
   */
  rules: ContractRules;
  /**
   * The chain head this Market was derived at, or null on an UNKNOWN read.
   * Added 2026-08-31 for the delisting timing (market/lapse.ts): "runs out in
   * N days" must be block arithmetic against the head the phase was computed
   * from, never the browser clock dressed as a block. Every other block field
   * on this object is compared against THIS number.
   */
  headBlock: number | null;
  /**
   * market.go RequireInflowOpen(s, creator, block): phase in {ACTIVE,
   * OVERDUE}, !globalInflowPaused, AND NOT marketRetired. Gates Buy (buy.go)
   * and Ask (ask.go) identically.
   *
   * ★ RULING K3, load-bearing: a RETIRED market refuses ALL new inflows —
   * INCLUDING during its own OVERDUE notice window, where naturalPhase alone
   * would still read ACTIVE/OVERDUE. contract-math.ts's canInflowOpen()
   * checks only {phase, globalInflowPaused} and does NOT know about
   * retiredAtBlock (it predates RULING K3's notice-closes-inflows change),
   * so both vsc-data-source.ts and mock-data-source.ts AND retiredAtBlock ===
   * null on top of canInflowOpen()'s own result when deriving this field —
   * see either file's buildMarket() for the exact expression. Do not compute
   * this as bare canInflowOpen(phase, globalInflowPaused): that silently
   * reopens the THM-1/THM-2 first-mover race RULING K3 closed.
   */
  canBuy: boolean;
  /** Same RequireInflowOpen gate as canBuy — ask.go's Ask() calls the identical chokepoint. See canBuy's own doc for the RULING K3 retired-notice caveat, which applies here too. */
  canAsk: boolean;
  /**
   * ★★★ RENEW HAS ITS OWN GATE, AND IT IS NOT canBuy (2026-08-30, adversarial review).
   *
   * `core.Renew` calls `requireMarketAcceptsMoney`, NOT `RequireInflowOpen`
   * (market.go:795-800). The difference is the DELIVERY gate: paused, retired
   * and phase only, with no delinquency term. That difference is deliberate and
   * the contract records why, at market.go's own doc for that function — a
   * defect found 2026-07-27 and called fatal there:
   *
   *   the delivery penalty runs 7 days (DelinquencyBlocks) while the
   *   subscription grace runs 5 (GraceBlocks), so a penalty landing near a
   *   renewal date outlives the grace. The market crosses into FROZEN, where
   *   Renew is illegal forever, and a self-clearing 7-day penalty becomes
   *   PERMANENT destruction of the market, taking every holder onto the flat
   *   pro-rata wind-down rail. "An attacker only had to time three junk asks."
   *
   * The contract fixed that. This client had put it back: `renewSubscription`
   * threw on `!canBuy`, and canBuy carries the delinquency term, so our own UI
   * refused to let exactly those creators pay their bill. Blocking a debtor
   * from paying you is not a penalty, it is a trap.
   *
   * So: `canRenew` is `canBuy` WITHOUT the delivery gate. Never collapse the
   * two back into one boolean, however tempting the symmetry looks.
   */
  canRenew: boolean;
  /**
   * Why canRenew is false (null when it is true). Under v2 this is what turns
   * "cannot renew" into the true sentence: a FROZEN market carrying a v1
   * pro-rata surplus is refused as `surplus`, and the road is Retire then
   * re-register, not "try again". market/contract-rules.ts renewGateUnder.
   */
  renewRefusal: RenewRefusal | null;
  /**
   * delivery.go DeliveryStanding — the block the creator's delivery penalty
   * ends, or null when their standing is clear. Non-null means canBuy/canAsk
   * are false FOR THIS REASON specifically, which the UI must say out loud: a
   * dead Buy button with no explanation reads as a broken page, and the honest
   * message ("this creator has missed too many asks; sales reopen in N days")
   * is also the one that makes the gate do its job.
   *
   * INFLOWS ONLY. Selling, refunding, reclaiming and claiming stay open the
   * whole time — never disable an exit on this field.
   */
  delinquentUntilBlock: number | null;
  /**
   * market.go RetiredAt(s, creator) / kRetiredAt — null when the market has
   * never been retired; otherwise the block Retire(...) was called at. A
   * non-null value means the market is in its irreversible 5-day OVERDUE
   * notice (RULING D) or has since gone FROZEN — the curve Sell rail is
   * CLOSED from this block on (RULING K3; refund.go's flat pro-rata is the
   * only exit) even though naturalPhase alone may still say ACTIVE/OVERDUE.
   * The UI must warn a would-be buyer/seller the instant this is non-null,
   * not wait for phase to reach FROZEN.
   */
  retiredAtBlock: number | null;
  /**
   * core/market.go inWindDown under `rules` (market/contract-rules.ts
   * windingDownUnder): retired or CLOSED, and under v1 a natural FROZEN too.
   * THE RAIL SWITCH. True: the holder's exit is refund() and sell() throws.
   * False: the exit is sell() and refund() throws. Derived ONCE here (both
   * data sources) so no consumer restates the predicate inline; the four
   * inline copies that used to exist in vsc-data-source.ts's write guards are
   * exactly how the v1 shape would have survived the v2 contract.
   */
  windingDown: boolean;
  /**
   * contract-math.ts floorPricePerTokenBaseUnits (refund.go RefundPrice,
   * PAR-cap removed): floor(reserve/supply) HBD per token — the wind-down
   * payout BEFORE the per-holder K2 exit tax. 0 when supply is 0. This is a
   * genuinely meaningful "floor" under the curve (a token is backed by ~1
   * HBD or more); under the old PAR model the equivalent field
   * (refundPricePerCredit) floored to 0 or 1 at any realistic scale and was
   * a near-useless display value.
   */
  floorPriceHbd: number;
  /**
   * The HBD price a buyer pays for the NEXT token — contract-math.ts's
   * `displayPricePerTokenBaseUnits` (= Area(S+1) − Area(S), exactly what the
   * Buy path charges).
   *
   * ★ NOT curve.go's `SpotRate` (2026-08-07). SpotRate is the TWAP/settlement
   * ORACLE feed and returns 0 at supply === 0 on purpose; this field used to be
   * wired to it, which rendered the headline price of an untraded market as
   * **$0.00** when a token really cost 1.000 HBD. The two are identical for
   * every supply >= 1 — they diverge only on an empty market. Anything needing
   * the oracle rate must call `spotRateBaseUnits` directly.
   */
  spotPriceHbd: number;
  /**
   * contract-math.ts reserveCoverageRatio (mirrors core/read.go
   * RefundRatioBps): min(reserve/Area(supply), 1) — THE R === Area(S)
   * equality invariant (curve.go), expressed as a 0..1 ratio instead of
   * basis points. Always exactly 1 during honest trading; a value below 1
   * signals corrupt state (the same condition sell.go's own solvency
   * pre-check would refuse to trade against). 0 when supply is 0.
   */
  reserveCoverage: number;
  /**
   * True ONLY on the OPTIMISTIC Market a write returns before VSC-L2 execution
   * is confirmed (register/renew/setFace/setCap/buy/sell/retire). A Hive
   * broadcast resolves at L1-accept — BEFORE the L2 contract runs — so an
   * immediate re-read returns PRE-execution state; presenting that as the
   * post-write outcome is a lie. A pending Market instead carries the
   * EXPECTED post-state, flagged here, so the UI can render it as
   * "unconfirmed" until useCreatorToken's poll reconciles it against real
   * chain state (mirrors ask()'s `:pending` Ask and prediction-market's
   * optimistic placeBet position). READS never set this — `undefined`/`false`
   * means "confirmed on-chain state".
   */
  pending?: boolean;
}

export interface HolderPosition {
  creator: string;
  holder: string;
  /**
   * The WHOLE position — core/matured.go:145 `totalBalance`, i.e. the maturing
   * (`kBal`) plus the matured (`kMatured`) bucket. INTEGER tokens; escrowed
   * tokens excluded (I3 — they leave the balance until the escrow resolves).
   * Never baseUnitsToHuman'd.
   *
   * ★ DOC CORRECTED 2026-08-27: this said "core/keys.go kBal" and had done since
   * before the F-C5 fix made `readHolderPosition` read both buckets. A reader
   * trusting the old text would conclude the matured half was missing here — it
   * is not, and `quoteSell` was fixed the same day to match.
   */
  tokensHeld: number;
  /**
   * The MATURING half of `tokensHeld` (core/matured.go's `kBal` bucket) — the
   * only half a curve sell owes exit tax on, because a matured token's rate is
   * 0 by definition (core/matured.go:6-13).
   *
   * OPTIONAL, and omitting it is the CONSERVATIVE reading: every consumer then
   * treats the whole position as maturing, which overstates the tax rather than
   * understating it. The mock data source does not model the two buckets at all,
   * so it correctly omits this.
   */
  tokensMaturing?: number;
  /**
   * The TAXED NET refund value in HBD — refund.go's refundPayout (the exact
   * pro-rata GROSS slice, floor(reserve*tokensHeld/supply)) MINUS the K2
   * hold-time-decaying exit tax (contract-math.ts refundNetBaseUnits), i.e.
   * what Refund(caller=holder, credits=tokensHeld) would actually pay out
   * TODAY if the market were winding down. Deliberately the NET, not the
   * gross: showing the untaxed gross overstates a fresh holder's payout by
   * up to MaxExitTaxBps (20%) — see exitTaxBps below for the rate that
   * produced this number.
   */
  floorValueHbd: number;
  /** holdclock.go heldBlocksAt(creator, holder, block) — how long this balance has been held as of the read's block. An UNSET clock (never clocked) reads as 0 — MAXIMALLY FRESH, i.e. maximum exit tax — never as ancient (holdclock.go's own zero-value convention; getting this backwards would show a 0% tax on a position the chain taxes at 20%). */
  heldBlocks: number;
  /** exittax.go ExitTaxBpsAt(heldBlocks) — the RATE this position would pay on either exit door (curve Sell, sell.go; or wind-down Refund, refund.go) right now. Informational for the UI; the actual tax charged is always recomputed at execution time from the live clock. */
  exitTaxBps: number;
  /**
   * Optimistic-write flag, same meaning as Market.pending: set only on the
   * expected post-state a buy/sell/refund/refundHolder returns before L2
   * execution is confirmed. READS never set it.
   */
  pending?: boolean;
}

/**
 * buy.go BuyResult, in human HBD numbers + an integer token count — the
 * read-only preview quoteBuy() resolves with. Mirrors contract-math.ts's
 * quoteBuyBaseUnits() one-for-one, converted at the UI/API boundary.
 */
export interface BuyQuote {
  /** n — the exact token count this quote was computed for. INTEGER, never baseUnitsToHuman'd. */
  tokens: number;
  /** BuyCost(S,n) = Area(S+n) − Area(S) — the exact integer area step (curve.go L1). */
  costHbd: number;
  /** floor(costHbd·TradeFeeBps/1e4) — the 10% trade fee, split 5/5 creator/platform (tradefee.go). */
  feeHbd: number;
  /** costHbd + feeHbd — the SINGLE HiveDraw amount the buyer signs (buy.go), and the transfer.allow cap they must approve. This is the buyer's ONLY slippage protection — see BuyInput.maxTotalHbd. */
  totalDueHbd: number;
  /** SpotRate(S+n) — the marginal price AFTER this buy, i.e. the price of the NEXT token. */
  rateAfterHbd: number;
}

/**
 * sell.go SellResult, in human HBD numbers + an integer token count — the
 * read-only preview quoteSell() resolves with. Mirrors contract-math.ts's
 * quoteSellBaseUnits() one-for-one. RULING F: this quote is MANDATORY UI —
 * the signer must see Gross/Tax/Fee/Net exactly as execution will compute
 * them before signing.
 */
export interface SellQuote {
  /** ΔS — the exact token count this quote was computed for. INTEGER, never baseUnitsToHuman'd. */
  tokens: number;
  /** SellProceeds(S,ΔS) = Area(S) − Area(S−ΔS) — the exact integer area step (curve.go L2), the FULL slice before tax/fee. */
  grossHbd: number;
  /** ceil(grossHbd·taxBps/1e4) — the K2 hold-time-decaying exit tax, to the TREASURY (sell.go), never a cap on realized gain (RULING K deleted the cost basis). */
  taxHbd: number;
  /** floor(grossHbd·TradeFeeBps/1e4) — the 10% trade fee, split 5/5 creator/platform, out of the payout (unlike Buy, where the fee is ON TOP). */
  feeHbd: number;
  /** grossHbd − taxHbd − feeHbd — what the seller actually receives; the number to feed back as SellInput.minNetHbd. */
  netHbd: number;
  /** exittax.go ExitTaxBpsAt(heldBlocks) — the rate actually applied to produce taxHbd. */
  taxBps: number;
  /** The seller's hold clock this quote was computed against (holdclock.go heldBlocksAt). */
  heldBlocks: number;
}

/**
 * awaiting|expired|answered|reclaimable|reclaimed. The contract's own escrow
 * status (ask.go askPending/askAnswered/askReclaimed) has only three; PENDING
 * splits into THREE client-only states by block height, exactly mirroring
 * the I6 disjoint-window guards: Answer requires block <= deadline (ask.go:428),
 * Reclaim requires block > deadline + ReclaimGrace (ask.go:501).
 *
 * The gap between those two windows (deadline < block <= deadline +
 * ReclaimGrace), where NEITHER action is legal, is its own `expired` status
 * — `awaiting` means "answer is actually legal right now" and `reclaimable`
 * means "reclaim is actually legal right now", both client write guards
 * (vsc-data-source.ts's answer()/reclaim()) key off this same boundary. See
 * reclaimableAtBlock on Ask for the exact block this status flips from
 * `expired` to `reclaimable`.
 *
 * Unaffected by the bonding-curve pivot — the escrowed-ask lifecycle (ask.go)
 * is unchanged; only its per-ask "credits" amount now shares the curve's
 * whole-token balance rather than a 3-decimal PAR credit (see ask.go's
 * escrowRec doc — kBal is the same balance Buy/Sell operate on).
 */
// 'declined' (added 2026-07-28) is the creator's free, honest "no" — a
// DISTINCT terminal state from 'reclaimed', deliberately: a reclaim means the
// creator went silent until the window closed, a decline means they answered
// promptly with "I can't take this". Only one of those is a black mark, and a
// UI that could not tell them apart would show a conscientious creator the same
// record as an absent one.
//
// It was missing from this union until 2026-07-28, and the escrow parser
// REJECTED the on-chain "DECLINED" status outright — so the moment Decline was
// used, that escrow read as unparseable and VANISHED from the inbox instead of
// showing as declined.
export type AskStatus = 'awaiting' | 'expired' | 'answered' | 'reclaimable' | 'reclaimed' | 'declined';

export interface Ask {
  /** `${creator}:${seq}` — mirrors the e|<creator>|<seq> state key (keys.go kEscrow), not a separate id counter. */
  id: string;
  creator: string;
  seq: number;
  asker: string;
  /** WHOLE TOKENS held in escrow — ceil(face/rate) against a per-token rate. Never a 3-decimal amount; see ParsedEscrow.tokensEscrowed. */
  tokensEscrowed: number;
  /** The asker's hold clock, carried through the escrow so a reclaim cannot launder a fresh position into an aged, untaxed one. */
  acqBlock: number;
  deadlineBlock: number;
  deadlineAt: number;
  /** deadlineBlock + ReclaimGrace — the block Reclaim becomes legal (ask.go ReclaimGrace = 1200, ~1h). */
  reclaimableAtBlock: number;
  reclaimableAt: number;
  status: AskStatus;
  contentHash: string;
  answerHash: string | null;
  /**
   * Optimistic-write flag, same meaning as Market.pending. ask() also encodes
   * "unconfirmed" structurally (seq === -1 and an id ending `:pending`);
   * answer()/reclaim() set this on their expected post-state. READS never set it.
   */
  pending?: boolean;
}

/**
 * Answered-vs-missed history plus response-time stats (UI-BRIEF Page 1: "the
 * hero element"). NOT contract state: no module in core/*.go stores a
 * delivery-window or per-answer timestamp (SPEC §1.7.1 — the delivery-cadence
 * mechanism was killed as unbuildable/forgeable and replaced by the
 * subscription-as-liveness-proof). This can only be reconstructed by an
 * indexer walking historical Ask/Answer/Reclaim events, the same way
 * spec §2.5 routes "delivery record, holder list, trade log" through the
 * indexer rather than getStateByKeys. `source` says which happened.
 */
export interface DeliveryWindow {
  windowStartAt: number;
  windowEndAt: number;
  outcome: 'answered' | 'missed' | 'pending';
  responseMs: number | null;
}

/**
 * WIRE CONTRACT — mirrors the indexer's DeliveryRecordView field-for-field
 * (/mnt/o/CREATOR-TOKENS/indexer/api.go, DeliveryRecordView). That DTO is the
 * source of truth; this must not drift from it. It carries answered/missed/
 * pending COUNTS plus, from the M1 fix (2026-07-21), `distinctAskers` (so a
 * thin record can be down-weighted) and `selfDealtExcluded` (so the
 * self-deal exclusion is visible/auditable, not a silent drop). Surfacing
 * counts without those two reintroduces exactly the opacity M1 closed.
 *
 * `responseBlocks` are per-answer response times measured in BLOCKS (~3s/block);
 * the DTO ships them as decimal strings to avoid JS number-precision loss, and
 * they are parsed to plain numbers here (a block-count delta never approaches
 * 2^53). `source` is the frontend-only availability discriminator: 'unavailable'
 * on an indexer read failure, distinct from a genuine all-zero record — this is
 * the product's central trust signal, so "couldn't load" must never masquerade
 * as "this creator has answered nothing".
 */
export interface DeliveryRecord {
  creator: string;
  answeredCount: number;
  missedCount: number;
  pendingCount: number;
  /** Per-answer response times in blocks, parsed from the DTO's decimal-string array. */
  responseBlocks: number[];
  /** M1: distinct askers behind the counts — lets the UI down-weight a thin record. */
  distinctAskers: number;
  /** M1: asks dropped because asker === creator (self-deal), surfaced for auditability. */
  selfDealtExcluded: number;
  /** Asks the creator explicitly declined — a decline is an answer of sorts, distinct from a miss (silence). */
  declinedCount: number;
  /** Mean of submitted ratings (2dp), or null when nobody has rated yet. NEVER 0 — 0 would read as "rated badly". */
  avgRating: number | null;
  /** How many ratings back avgRating: a 5.00 from one rater is not a 5.00 from forty. */
  ratingCount: number;
  source: 'indexer' | 'unavailable';
}

/**
 * Cross-creator wallet view (readWallet). `unavailable` distinguishes an
 * indexer read FAILURE (or no indexer configured) from a genuinely-empty
 * wallet — a bare [] conflates "couldn't load" with "you hold nothing", which
 * for a balance view is a lie. RULE: unavailable ≠ empty.
 */
export interface WalletPositionsResult {
  positions: HolderPosition[];
  unavailable: boolean;
}

/** An asker's asks across every creator (readMyAsks). Same unavailable-vs-empty discriminator as WalletPositionsResult. */
export interface MyAsksResult {
  asks: Ask[];
  unavailable: boolean;
}

/**
 * A creator's own inbox read (readCreatorAsks). Returns the asks the creator
 * can still act on plus the dead-zone, ACROSS THE FULL escrow range — never a
 * newest-N page. See the data source's readCreatorAsks for the scan and the
 * bound; the point is that no answerable ask can be hidden by a flood of newer
 * asks (H12, 2026-08-31), because that is the only way a creator prevents a
 * grief-miss: an ask they cannot SEE they cannot decline, and an undeclined ask
 * becomes a miss on its reclaim (core/delivery.go recordMiss).
 */
export interface CreatorAsksResult {
  /** Every `awaiting` (still answerable/declinable) and `expired` (dead-zone) ask, soonest-deadline first. Resolved asks are omitted — the delivery record carries history. */
  asks: Ask[];
  /**
   * false ONLY when the creator has more lifetime asks than the scan cap AND
   * the scan hit that cap before it could prove no older ask is still
   * actionable. Then `olderNotScanned` older escrows were not read. Practically
   * unreachable — an `awaiting` ask was opened at most MaxAskDeadline (30d) ago
   * and seqs rise with open block, so hiding one needs thousands of asks inside
   * 30 days — but it is surfaced honestly rather than silently dropped.
   */
  scannedAll: boolean;
  /** Older escrows not read when `scannedAll` is false; 0 otherwise. */
  olderNotScanned: number;
}

/**
 * Why an ask-rate preview could not be produced — mirrors twap.go's AskRate
 * ErrOracle branches exactly, so the UI can render an honest reason rather
 * than a generic failure (spec §1.3b mitigation 1).
 */
export type QuoteOracleStatus =
  | 'ok'
  | 'insufficient_observations'
  | 'insufficient_span'
  | 'stale'
  | 'deviation_capped'
  | 'unavailable'
  // H2 (2026-08-31): the creator has posted NO price — a fact about their own
  // market, distinct from 'unavailable' (our read failing).
  | 'no_price_set'
  // H1 (2026-08-31): core/settlement.go settleSpend's guards, surfaced before
  // the signature. The posted face is outside the window that moves with supply.
  | 'market_too_small'
  | 'price_below_floor'
  | 'price_above_ceiling'
  | 'spend_cap';

export interface Quote {
  creator: string;
  faceHbd: number;
  /**
   * HBD per token — the live settlement rate when oracleStatus is 'ok'.
   *
   * ★ RULING C REWRITE (2026-07-24): PAR NO LONGER EXISTS as a fallback.
   * core.SettlementRate (settlement.go) used to fall back to PAR (1 base
   * unit per credit) whenever the TWAP's guards failed; that fallback is
   * DELETED — it was wrong by exactly the factor `spot`, always in the
   * asker-robbing direction. The contract now REFUSES with a typed error
   * when no safe rate exists (min(TWAP_short, TWAP_long, SpotRate) plus the
   * C2/C4/C5 guards), and this field is null on that refusal — never a
   * PAR-flavoured invented number. Check `oracleStatus !== 'ok'` (equivalently
   * `rate === null`) before rendering an ask CTA: a refused quote means
   * `ask()` would ALSO refuse, and the UI must make the action unavailable
   * rather than let the user sign a doomed transaction.
   */
  rate: number | null;
  /** ceil(faceHbd / rate) per ask — ask.go creditsForAsk, an INTEGER token count (kBal is the same whole-token balance Buy/Sell operate on; there is no 3-decimal scaling on this leg). Same non-null rule as `rate`. For DISPLAY only. */
  creditsRequired: number | null;
  /**
   * The exact INTEGER token count core.Ask would charge right now — the ONLY
   * figure this feature's AskInput.maxCreditsBaseUnits guard may be derived
   * from. Identical value to `creditsRequired` under the curve (no unit
   * conversion between the two any more — both are the same whole-token
   * count); kept as a separate field for interface stability and because the
   * write path (op-builders.ts's askPayload) still names its parameter
   * `maxCreditsBaseUnits`. Same non-null rule as `rate`.
   */
  creditsRequiredBaseUnits: number | null;
  /** floor(faceHbd * CommissionBps / 10000) — the separate HBD leg (SPEC §1.7.3). Always computable; does not need rate. */
  commissionHbd: number;
  /**
   * Why `rate` above is null or non-'ok' — ask.go's SettlementRate/AskRate
   * refusal reasons (settlement.go/twap.go). 'ok' means a real rate was
   * derived and Ask() would settle at it right now; any other value means
   * BOTH this quote AND a real ask() call refuse — this is no longer merely
   * informational the way it was under the old PAR-fallback contract.
   */
  oracleStatus: QuoteOracleStatus;
  /**
   * Client-computed preview, not a contract read — a new observation can land
   * between this quote and the signed call, and AskRate() is the only
   * authoritative source at execution time. The UI must present this as an
   * estimate (UI-BRIEF Page 2: "no surprises"), never as a locked-in price.
   */
  asOfBlock: number;
}

// ---- write inputs / results ----

export interface RegisterMarketInput {
  creator: string;
  faceHbd: number;
  /** core/keys.go kCap — the outstanding-token ceiling. INTEGER token count (market.go SetCap/registerCheck; MinCap/MaxCap bound the raw integer, params.go). */
  capTokens: number;
  /**
   * OPTIONAL atomic creator first buy (launch.go RegisterWithFirstBuy): an
   * ORDINARY Buy at full curve cost, executed in the SAME state transition as
   * registration. Zero premine, no discount — see launch.go's own "ZERO
   * PREMINE" doc. Omit or pass 0 for a plain, free registration (registration
   * itself carries no fee at all — LOCKED-MECHANISM "Revenue").
   */
  firstBuyTokens?: number;
}

export interface RenewSubscriptionInput {
  creator: string;
  caller: string;
  periods: number;
}

export interface SetFaceInput {
  creator: string;
  newFaceHbd: number;
}

export interface SetCapInput {
  creator: string;
  /** INTEGER token count — see RegisterMarketInput.capTokens's doc. */
  newCapTokens: number;
}

/**
 * buy.go Buy — mints `tokens` new whole tokens on `creator`'s curve to
 * `buyer`, at the exact area-step cost (curve.go BuyCost). Replaces the
 * deleted PrepayInput/prepay() (core/prepay.go, the PAR mint, is GONE — Buy
 * on the curve is the ONLY issuance path now).
 */
export interface BuyInput {
  creator: string;
  buyer: string;
  /** n — INTEGER whole tokens to mint. Never a fractional/3-decimal amount. */
  tokens: number;
  /**
   * OPTIONAL client-side pre-broadcast ceiling on TotalDue (cost+fee), in
   * HBD. The buyer's REAL, on-chain slippage protection is their own signed
   * transfer.allow on the single HiveDraw (buy.go's own doc: "Slippage
   * protection is the buyer's own signed transfer.allow on that draw") — this
   * field only lets the data source fail fast, before broadcasting, when a
   * stale quote's TotalDue has since moved past what the caller is willing to
   * pay, so RC isn't spent on a call that would still succeed on-chain but at
   * a worse price than intended.
   */
  maxTotalHbd?: number;
}

/**
 * sell.go Sell — redeems `tokens` of `seller`'s balance at the exact curve
 * slice (curve.go SellProceeds), less the K2 hold-time exit tax and the 10%
 * trade fee. The curve exit rail; CLOSED once the market winds down
 * (RULING K3) — see Market.retiredAtBlock/phase for when refund() (the
 * flat pro-rata wind-down rail) becomes the only exit instead.
 */
export interface SellInput {
  creator: string;
  seller: string;
  /** ΔS — INTEGER whole tokens to redeem. */
  tokens: number;
  /**
   * OPTIONAL signed floor on Net HBD received — sell.go's checkMinNet
   * (OUTFLOW-CLIFF-1), enforced ON-CHAIN before any write. Closes a same-block
   * hold-clock front-run (a third party forcing a dust TransferCredits onto
   * the seller between quote and execution to knock their exit-tax rate up).
   * Omit to accept any net (no front-run guard, but the exit is never
   * trapped either way — see sell.go's checkMinNet doc for why the escape
   * hatch must exist).
   */
  minNetHbd?: number;
}

/** market.go Retire — the creator's own irreversible wind-down trigger (RULING D/K3). Starts the 5-day OVERDUE notice, after which the market is FROZEN regardless of any hostile Renew. Moves no funds. Once-only: a second call refuses. */
export interface RetireInput {
  creator: string;
}

/** tradefee.go ClaimTradeFees — pulls the caller's ENTIRE accrued trade-fee balance (kFeeBal(account), the 5% creator half of every trade fee). No payload fields on the wire — the caller IS the beneficiary. */
export interface ClaimTradeFeesInput {
  account: string;
}

/** read.go WithdrawTreasury — owner-gated pull of platform revenue (registration/subscription/commission/trade-fee accrual) out of kTreasury(). The UI must keep this behind an owner-only surface; the contract itself also refuses a non-owner caller. */
export interface WithdrawTreasuryInput {
  caller: string;
  amountHbd: number;
}

/** refund.go CloseIfDrained — fully permissionless (core takes no caller at all); flips a FROZEN, fully-drained (supply===0) market to terminal CLOSED. Idempotent — safe to call against a healthy market (no-op) or an already-CLOSED one. `caller` here is only this wrapper's own active-auth signer, not a business-logic participant. */
export interface CloseIfDrainedInput {
  creator: string;
  caller: string;
}

export interface AskInput {
  creator: string;
  asker: string;
  contentHash: string;
  deadlineBlocks: number;
  /**
   * The asker's own cap on tokens spent (an INTEGER token count under the
   * curve — see Quote.creditsRequiredBaseUnits's doc). REQUIRED — core.Ask
   * rejects a missing or zero value rather than defaulting to unlimited.
   *
   * It exists because `face` is creator-controlled and intra-block transaction
   * order is chosen by the block producer, so without a cap a creator could
   * spike the price between the asker signing and the transaction executing and
   * drain the asker's whole balance for one question. Derive it from
   * Quote.creditsRequiredBaseUnits plus whatever tolerance the UI shows the
   * user — and show it, because it is the number they are actually
   * consenting to.
   */
  maxCreditsBaseUnits: number;
  /**
   * The named service being bought from the creator's shop, or omitted for the
   * creator's legacy single `face` price (id 0 is the reserved alias for it).
   *
   * The whole offerings catalogue was on-chain, tested, and UNREACHABLE until
   * 2026-07-28 because this field did not exist on any client payload. When it
   * IS set, the ask settles at THAT offering's own banded price — so a UI that
   * shows a list of named services must pass the id the user actually picked,
   * or every purchase silently charges the generic face price instead.
   */
  offeringId?: number;
}

/** One posted service in a creator's shop (core/offerings.go). Prices are per-offering and each sits under its own title-anchored 2x/7d anti-rug band. */
export interface Offering {
  offeringId: number;
  title: string;
  /** The POSTED price in HBD — the buyer's total. Commission is carved OUT of it, never added on top (USER RULING 2026-07-27), so a $200 service costs the buyer exactly $200. */
  priceHbd: number;
  priceBaseUnits: number;
}

/**
 * One creator in the discovery list. Ranked on DELIVERY by the indexer view —
 * never price, never market cap, never volume — and the ordering is applied in
 * SQL precisely so a client cannot quietly re-rank it on something else.
 */
/**
 * How far behind the Magi indexer is — the answer to "is what this screen is
 * showing me actually current?".
 *
 * ★★★ WHY THIS TYPE EXISTS (2026-08-25). The indexer was found ~17 hours and
 * ~20,100 blocks behind the node on a running build, and `/creators` rendered
 * its `lumen_ct_discovery` rows as if they were current — nothing anywhere in
 * this feature read `indexer_health`. The existing doctrine covered the wrong
 * case: `readDiscovery` REJECTS when the indexer is unreachable, so "we could
 * not look" is honest, and `unavailable ≠ empty` is enforced throughout. But a
 * LAGGING indexer answers successfully. It returns real, well-formed, stale
 * rows, and every honest-degradation path in this feature is built to trigger
 * on failure — so a lag is the one outage shape that renders as health.
 *
 * ★★ THE LAG IS MEASURED IN BLOCKS, NOT SECONDS, ON PURPOSE. The obvious
 * implementation compares `last_update` against `Date.now()` — and that makes
 * the claim depend on the VIEWER'S clock. A reader whose laptop clock is a day
 * out would be told the indexer is broken when it is fine, or told it is fine
 * when it is a day behind. Block heights are two numbers from the same chain
 * with no clock anywhere between them, so `blocksBehind` means the same thing
 * on every machine. `lastUpdate` is carried for DISPLAY only and must never be
 * the basis of the decision.
 */
export interface IndexerHealth {
  /**
   * false = no indexer is configured in this build, or the health read itself
   * failed. It does NOT mean "up to date" and must never render as such — the
   * same unavailable ≠ empty rule this file states for every other read.
   */
  available: boolean;
  /** `indexer_health.last_update`, verbatim, for display. Never the lag decision. */
  lastUpdate: string | null;
  /** Highest block the indexer has ingested (`indexer_health.latest_block_height`). */
  indexerBlock: number | null;
  /** The Magi node's own head at the same moment (`localNodeInfo.last_processed_block`). */
  nodeBlock: number | null;
  /**
   * `nodeBlock - indexerBlock`, clamped at 0. null when either side is
   * unreadable — null is "we don't know how far behind", never "not behind".
   */
  blocksBehind: number | null;
}

export interface CreatorSummary {
  creator: string;
  /** null when nothing has resolved yet. NOT 0 — a creator nobody has asked has no completion rate, and 0% reads as "fails everything". */
  completionPct: number | null;
  /** null when UNRATED. Never render or rank this as equivalent to a good score. */
  avgRating: number | null;
  ratingCount: number;
  answeredCount: number;
  missedCount: number;
  medianResponseBlocks: number | null;
  /** Live curve price, from a batched chain read — the indexer stores no price. */
  priceHbd: number;
  marketCapHbd: number;
  /** The creator's default posted ask price. NOT the "from" price — see `fromPriceHbd`. */
  faceHbd: number;
  /**
   * The cheapest thing a customer can actually buy: `min(faceHbd, cheapest live offering)`.
   *
   * ★ THE GRID USED TO RENDER `faceHbd` AS "From $X" AND IT OVERSTATED EVERY TIME (2026-08-23).
   * `kFace` is the REGISTRATION anchor — the "ask a question" default — while a creator's real
   * entry price is whatever their cheapest custom offering costs. Measured live on 5 of 5
   * customized creators, the card was always dearer than the truth (aria $25 vs $15, gray $15
   * vs $12, dana $40 vs $35, beat $18 vs $12, wallet $25 vs $15). Overstating an entry price is
   * the direction that costs a creator the customer.
   *
   * Falls back to `faceHbd` for a creator with no offerings, where the ask price genuinely IS
   * the only task. Offerings priced 0 are deleted/unset (`reads.ts`) and are skipped.
   */
  fromPriceHbd: number;
  /**
   * Market phase, derived from chain state the same way `readMarket` derives it.
   *
   * ★ THE DIRECTORY LISTED FROZEN AND CLOSED MARKETS AS IF THEY WERE HEALTHY (2026-08-23).
   * `readDiscovery` read supply/face/registeredAt and no state at all, so a wound-down market
   * sat in the grid with a live-looking price and nothing saying it could not be bought. The
   * token page has disclosed this for months (`token-market-view.tsx` wind-down and OVERDUE
   * banners); the grid a visitor sees FIRST disclosed nothing.
   *
   * `UNKNOWN` is reserved for a failed read and must render as "status unavailable", never as
   * healthy — the rule this type's own doc states at `MarketPhase`.
   */
  phase: MarketPhase;
  /**
   * TRUE when this market is winding down (permanent), derived under the live
   * contract rules the same way `readMarket` does: retired, CLOSED, or (v1) a
   * natural FROZEN. FALSE for a v2 natural FROZEN, which is a RECOVERABLE pause.
   * Lets the grid tell a reversible "paused" from an irreversible wind-down
   * instead of labelling every FROZEN market with the v2-only word "Delisted".
   */
  windingDown: boolean;
  /** Registered within the last ~30 days, by the LATEST registration (a re-registered market is a new incarnation). */
  isNew: boolean;
}

/** One point of a token's price history. `priceHbd` is derived from supply via the ported curve math, not stored. */
export interface PricePoint {
  block: number;
  priceHbd: number;
  /**
   * TRUE only for the market's OPENING state — the supply it held immediately
   * before the oldest trade in the series, recovered from that row's signed
   * `delta` (see `HasuraPricePoint.delta`). It is a real recorded state at a
   * real moment, and it is a real price on the same curve; it is NOT a trade.
   *
   * ★ THE FLAG EXISTS SO NOTHING COUNTS IT AS ONE. `priceChangeOf` and the
   * chart caption both state a BASIS ("over 8 trades"), and both used to take
   * that basis from the array's length. With an opening point in the array
   * that basis is off by one, and a page that says "2 trades" about a market
   * that traded once is exactly the kind of small false claim the rest of this
   * feature is written to avoid. Consumers filter on this to count trades.
   */
  opening?: boolean;
}

export interface CreateOfferingInput {
  creator: string;
  title: string;
  priceHbd: number;
}

export interface SetOfferingPriceInput {
  creator: string;
  offeringId: number;
  newPriceHbd: number;
}

export interface SetOfferingTitleInput {
  creator: string;
  offeringId: number;
  title: string;
}

export interface DeleteOfferingInput {
  creator: string;
  offeringId: number;
}

/**
 * The creator's free, honest "no" (ask.go Decline, RULING E). Same window an
 * Answer is legal in; returns the asker's tokens AND the whole commission, and
 * is explicitly NOT a miss against the delivery record.
 *
 * deadlineBlock is carried for the same reason AnswerInput carries it: the
 * write path enforces the window client-side from what the caller already has,
 * without a second chain read.
 */
/**
 * The buyer's 1-5 score for a DELIVERED job (rating.go). Reputation only — the
 * contract refuses to let a rating gate any payout, refund or sale, and no UI
 * should imply otherwise.
 *
 * Only the account that actually paid can rate, once, and only a job the creator
 * marked delivered. A reclaim (creator went silent) and a decline (creator said
 * no) are already recorded objectively and are deliberately not rateable.
 */
export interface RateInput {
  creator: string;
  /** The buyer — the account that paid for this job, and the ONLY one the contract will accept a rating from. */
  rater: string;
  seq: number;
  score: number;
}

export interface DeclineInput {
  creator: string;
  seq: number;
  deadlineBlock: number;
}

export interface AnswerInput {
  creator: string;
  seq: number;
  answerHash: string;
  /**
   * The escrow's own deadlineBlock (ask.go Answer's bound), extended onto this
   * input so the write path can enforce the answer window (block <=
   * deadlineBlock) client-side without a second chain read: the caller
   * already has this from the Ask they are acting on (readCreatorAsks
   * already returns it). See vsc-data-source.ts's answer() for the guard.
   */
  deadlineBlock: number;
}

export interface ReclaimInput {
  creator: string;
  seq: number;
  asker: string;
  /**
   * The escrow's own deadlineBlock (ask.go Reclaim's bound: deadline+ReclaimGrace),
   * extended onto this input for the same reason as AnswerInput.deadlineBlock —
   * see that field's doc.
   */
  deadlineBlock: number;
}

/**
 * refund.go Refund — the WIND-DOWN exit (open only once the market is
 * winding down: Market.windingDown, which is retired or CLOSED, plus a natural
 * FROZEN under the v1 rules only). While the market trades, the exit is
 * SellInput/sell() instead — the two rails are state-disjoint (sell.go's
 * rail-switch doc). Flat pro-rata, TAXED (K2), no trade fee.
 */
export interface RefundInput {
  creator: string;
  holder: string;
  /** INTEGER whole tokens to redeem via the pro-rata rail. The wire field is still named `credits` (main.go's payload shape), but it is a token count under the curve — op-builders.ts's refundPayload() handles the rename at the wire boundary. */
  tokens: number;
  /** OPTIONAL signed floor on the NET HBD received, same OUTFLOW-CLIFF-1 guard as SellInput.minNetHbd — see that field's doc. */
  minNetHbd?: number;
}

export interface RefundHolderInput {
  creator: string;
  holder: string;
  /** The account submitting the (permissionless) push — never the payee (refund.go RefundHolder: "can only ever pay the rightful owner, never the caller"). */
  caller: string;
}

/**
 * main.go Transfer (`transfer` entrypoint) — moves TOKENS between holders.
 * Renamed from TransferCreditsInput with the pivot: there are no "credits"
 * any more, and the amount is a whole-token count rather than a 3-decimal
 * base-units value.
 */
export interface TransferTokensInput {
  creator: string;
  from: string;
  to: string;
  /** INTEGER whole tokens. Never a fractional/3-decimal amount. */
  tokens: number;
}
