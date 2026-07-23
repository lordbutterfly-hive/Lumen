// Domain types for Creator Keys (SPEC-CREATOR-KEYS.md §1, /mnt/o/CREATOR-TOKENS/core/*.go).
// Zero logic here — mirrors the "zero logic" convention of
// features/prediction-market/types.ts. Derivation lives in
// lib/creator-tokens-data-source.ts so mock and vsc agree on one implementation.
//
// Money convention: every HBD/credit amount below is a HUMAN number (3 decimals,
// e.g. 2.5 HBD), matching features/prediction-market/lib/vsc-money.ts's
// baseUnitsToHuman output — never a raw base-unit integer. PAR (core/prepay.go):
// 1 credit === 1 HBD base unit at issuance, so credits use the same 3-decimal
// human convention as HBD (e.g. "1.8 credits", UI-BRIEF Page 1).
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
 * SetFace). REVISED 2026-07-20: the band anchors to a rolling WINDOW
 * (kFaceAnchor/kFaceAnchorAt), not to the last change — see
 * lib/contract-math.ts's deriveFaceBandBaseUnits doc for the full mirror.
 * windowEndsAtBlock is when the CURRENT window (possibly just re-anchored)
 * ends; a new one opens immediately after, still centered on whatever face is
 * in effect then — the band never actually lifts for a registered market.
 */
export interface FaceBand {
  minHbd: number;
  maxHbd: number;
  /** True for every registered market in practice — see deriveFaceBandBaseUnits's doc for the one (unreachable) case this is false. */
  bandActive: boolean;
  windowEndsAtBlock: number;
}

export interface Market {
  creator: string;
  faceHbd: number;
  faceSetAtBlock: number;
  faceBand: FaceBand;
  capCredits: number;
  supplyCredits: number;
  reserveHbd: number;
  paidUntilBlock: number;
  paidUntilAt: number;
  registeredAtBlock: number;
  phase: MarketPhase;
  /**
   * paidUntilBlock + GraceBlocks — the block OVERDUE turns into FROZEN.
   * core/keys.go declares a kFrozenAt key but no module in the read core
   * (market.go/prepay.go/ask.go/refund.go/twap.go) ever writes it, so "when did
   * this freeze" is not stored state — it is this exact arithmetic, always
   * defined, meaningful only once the market has actually lapsed.
   */
  graceExpiresAtBlock: number;
  graceExpiresAt: number;
  /** kPaused (keys.go) — global inbound pause, independent of this market's own phase. */
  globalInflowPaused: boolean;
  /** RequireInflowOpen(s, creator, block): phase in {ACTIVE, OVERDUE} AND !globalInflowPaused. Gates Prepay and Ask identically. */
  canPrepay: boolean;
  canAsk: boolean;
  /**
   * The floor figure UI-BRIEF shows beside the ask price (Page 1 point 5).
   * min(reserve/supply, PAR), computed at full precision — NOT the contract's
   * literal RefundPrice(), which floors to 0 or 1 at realistic scale (proven
   * by refund_test.go's own TestRefundPrice_NormalRatio: a real 70% ratio
   * reads back as 0). See lib/contract-math.ts's floorRatioForDisplay doc for
   * the full explanation. 0 when supply is 0.
   *
   * Checked against core/read.go's RefundRatioBps (exported 2026-07-20): same
   * quantity (coverage ratio capped at PAR, zero-guarded, floor-rounded —
   * never overstates coverage), just not discretized to basis points — this
   * field stays a full-precision JS number instead. Semantics already
   * aligned; see floorRatioForDisplay's doc for why the extra precision is
   * kept rather than switching to bps.
   */
  refundPricePerCredit: number;
  /**
   * True ONLY on the OPTIMISTIC Market a write returns before VSC-L2 execution
   * is confirmed (register/renew/setFace/setCap). A Hive broadcast resolves at
   * L1-accept — BEFORE the L2 contract runs — so an immediate re-read returns
   * PRE-execution state; presenting that as the post-write outcome is a lie.
   * A pending Market instead carries the EXPECTED post-state, flagged here, so
   * the UI can render it as "unconfirmed" until useCreatorToken's poll
   * reconciles it against real chain state (mirrors ask()'s `:pending` Ask and
   * prediction-market's optimistic placeBet position). READS never set this —
   * `undefined`/`false` means "confirmed on-chain state".
   */
  pending?: boolean;
}

export interface HolderPosition {
  creator: string;
  holder: string;
  creditsHeld: number;
  /**
   * The EXACT amount Refund(caller=holder, credits=creditsHeld) would pay
   * today: floor(reserve*creditsHeld/supply), capped at creditsHeld*PAR
   * (refund.go refundPayout, I2). Deliberately NOT
   * creditsHeld * market.refundPricePerCredit — that would compound two
   * separate roundings and understate the payout (see
   * lib/creator-tokens-data-source.ts's refundPayoutBaseUnits doc).
   */
  floorValueHbd: number;
  /**
   * Optimistic-write flag, same meaning as Market.pending: set only on the
   * expected post-state a prepay/refund/refundHolder returns before L2
   * execution is confirmed. READS never set it.
   */
  pending?: boolean;
}

/**
 * awaiting|expired|answered|reclaimable|reclaimed. The contract's own escrow
 * status (ask.go askPending/askAnswered/askReclaimed) has only three; PENDING
 * splits into THREE client-only states by block height, exactly mirroring
 * the I6 disjoint-window guards: Answer requires block <= deadline (ask.go:368),
 * Reclaim requires block > deadline + ReclaimGrace (ask.go:414).
 *
 * REVISED 2026-07-20 (guard-wiring pass): the gap between those two windows
 * (deadline < block <= deadline + ReclaimGrace), where NEITHER action is
 * legal, used to be folded into `awaiting` — which meant a creator could see
 * "awaiting", attempt to answer, and get a guaranteed on-chain revert (the
 * UI showed a state the chain would refuse). It is now its own `expired`
 * status, so `awaiting` means "answer is actually legal right now" and
 * `reclaimable` means "reclaim is actually legal right now" — both client
 * write guards (vsc-data-source.ts's answer()/reclaim()) key off this same
 * boundary. See reclaimableAtBlock on Ask for the exact block this status
 * flips from `expired` to `reclaimable`.
 */
export type AskStatus = 'awaiting' | 'expired' | 'answered' | 'reclaimable' | 'reclaimed';

export interface Ask {
  /** `${creator}:${seq}` — mirrors the e|<creator>|<seq> state key (keys.go kEscrow), not a separate id counter. */
  id: string;
  creator: string;
  seq: number;
  asker: string;
  creditsEscrowed: number;
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
 * Why an ask-rate preview could not be produced — mirrors twap.go's AskRate
 * ErrOracle branches exactly, so the UI can render an honest reason rather
 * than a generic failure (spec §1.3b mitigation 1).
 */
export type QuoteOracleStatus = 'ok' | 'insufficient_observations' | 'insufficient_span' | 'stale' | 'deviation_capped' | 'unavailable';

export interface Quote {
  creator: string;
  faceHbd: number;
  /**
   * HBD per credit — the live TWAP when oracleStatus is 'ok', or PAR
   * (1.000) otherwise. Never spot (spec §1.3b mitigation 1).
   *
   * REVISED 2026-07-20 (finding C-C): this is core.Ask's own SettlementRate
   * (ask.go), not bare AskRate — PAR is the safe, EXPLICIT default
   * SettlementRate falls back to whenever AskRate's guards don't pass,
   * which is the DEFAULT state on a live deployment today (no DEX pool
   * feeds the TWAP yet). `rate`/`creditsRequired`/`creditsRequiredBaseUnits`
   * are therefore non-null whenever faceHbd > 0 and the read itself
   * succeeded — null only on a genuine read failure or before any face
   * price has been set. Check `oracleStatus` to know whether the number
   * shown is a live TWAP or the PAR fallback; it never gates whether
   * pricing (or ask()) succeeds anymore.
   */
  rate: number | null;
  /** ceil(faceHbd / rate) per ask, PAR-scaled like ask.go creditsForAsk, in HUMAN units (3dp) — for DISPLAY only. Same non-null rule as `rate`. */
  creditsRequired: number | null;
  /**
   * The exact BASE-UNIT integer core.Ask would charge right now — the ONLY
   * figure this feature's AskInput.maxCreditsBaseUnits guard may be derived
   * from (finding C-D: a previous version of this type had no base-unit
   * credits field at all, and the doc on AskInput.maxCreditsBaseUnits told
   * the UI to read a `Quote.creditsPerAsk` field that never existed on this
   * interface — a UI naively passing the HUMAN `creditsRequired` number
   * where core.Ask expects base units would be off by ASSET_DECIMALS'
   * factor of 1000, so the maxCredits guard would revert almost every real
   * ask). Same non-null rule as `rate`.
   */
  creditsRequiredBaseUnits: number | null;
  /** floor(faceHbd * CommissionBps / 10000) — the separate HBD leg (SPEC §1.7.3). Always computable; does not need rate. */
  commissionHbd: number;
  /**
   * Whether `rate` above is a live TWAP ('ok') or the PAR fallback
   * core.SettlementRate uses when AskRate's own guards fail (ask.go) — any
   * other value here. Purely informational for the UI to explain WHY the
   * price shown is PAR rather than a live rate (spec §1.3b mitigation 1);
   * it no longer blocks pricing or ask() the way it did before the C-C fix.
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
  capCredits: number;
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
  newCapCredits: number;
}

export interface PrepayInput {
  creator: string;
  holder: string;
  hbdAmount: number;
}

export interface AskInput {
  creator: string;
  asker: string;
  contentHash: string;
  deadlineBlocks: number;
  /**
   * The asker's own cap on credits spent, in base units. REQUIRED — core.Ask
   * rejects a missing or zero value rather than defaulting to unlimited.
   *
   * It exists because `face` is creator-controlled and intra-block transaction
   * order is chosen by the block producer, so without a cap a creator could
   * spike the price between the asker signing and the transaction executing and
   * drain the asker's whole balance for one question. Derive it from
   * Quote.creditsRequiredBaseUnits (finding C-D — NOT the human-scaled
   * Quote.creditsRequired, and NOT a `Quote.creditsPerAsk` field, which never
   * existed on this interface) plus whatever tolerance the UI shows the
   * user — and show it, because it is the number they are actually
   * consenting to.
   */
  maxCreditsBaseUnits: number;
}

export interface AnswerInput {
  creator: string;
  seq: number;
  answerHash: string;
  /**
   * The escrow's own deadlineBlock (ask.go:368's bound), extended onto this
   * input 2026-07-20 so the write path can enforce the answer window
   * (block <= deadlineBlock) client-side without a second chain read: the
   * caller already has this from the Ask they are acting on (readCreatorAsks
   * already returns it). See vsc-data-source.ts's answer() for the guard.
   */
  deadlineBlock: number;
}

export interface ReclaimInput {
  creator: string;
  seq: number;
  asker: string;
  /**
   * The escrow's own deadlineBlock (ask.go:414's bound: deadline+ReclaimGrace),
   * extended onto this input 2026-07-20 for the same reason as
   * AnswerInput.deadlineBlock — see that field's doc.
   */
  deadlineBlock: number;
}

export interface RefundInput {
  creator: string;
  holder: string;
  credits: number;
}

export interface RefundHolderInput {
  creator: string;
  holder: string;
  /** The account submitting the (permissionless) push — never the payee (refund.go RefundHolder: "can only ever pay the rightful owner, never the caller"). */
  caller: string;
}

export interface TransferCreditsInput {
  creator: string;
  from: string;
  to: string;
  amount: number;
}
