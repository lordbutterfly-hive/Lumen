package indexer

import "encoding/json"

// events.go — typed decoders for ../core/events.go's Ev* wire shapes. As of
// commit 572ab00, EVERY sdk.Log(...) call site in ../contract/main.go goes
// through a core.Ev* constructor — including retired/treasuryWithdrawn/
// tradeFeesClaimed (see KindRetired/KindTreasuryWithdrawn/
// KindTradeFeesClaimed's own docs below), which used to be hand-built inline
// JSON with no constructor behind them (verified: zero `sdk.Log("{` call
// sites remain in contract/main.go). Their wire shapes did NOT change
// (core/events.go's own doc on each of the six new constructors: "byte-
// identical to the line it replaces"), so every decode struct below is still
// correct — what changed is only where the JSON string comes from. This
// package is a STANDALONE consumer of the LOG FORMAT (the JSON string),
// never of core's internal Store machinery — it does not import
// creator-tokens/core at all, matching the boundary discipline
// hive-price-market/indexer/events.go documents for the identical
// contract/indexer split ("this package stays a standalone consumer of the
// LOG FORMAT, not of market's internal Store machinery"). If ../core/events.go
// ever changes a field name, this file has to be updated by hand — that is
// the deliberate cost of the decoupling, not an oversight.
//
// DELIBERATELY NOT RECOGNIZED (fall to Unknown/Stats.Unknown, named and
// justified here rather than silently dropped — see ParseEvent's own doc for
// the mechanics): "init" (../contract/main.go's `init` owner-bootstrap log,
// built via core.EvInit (core/events.go) as of commit 572ab00 — this package
// still tracks no owner/init concept, so it stays undecoded here regardless
// of which side builds the string) and "paused"/"unpaused" (the
// `pause`/`unpause` entrypoints' logs, likewise now built via
// core.EvPaused/core.EvUnpaused — the GLOBAL inbound-pause switch, kPaused(),
// is not scoped to any single creator market and no query surface in this
// package depends on it: SPEC-CREATOR-KEYS.md §2.5 routes live pause/Phase
// status through a direct chain read, exactly like Closed/LastFace/LastCap
// already are for this package's own MarketSummary — see that type's doc).
// All three DO have pinned constructors on the core side now
// (core/schema_contract_test.go's TestSchemaContract_Init/Paused/Unpaused) —
// what makes them unrecognized HERE is that this package simply assigns them
// no decode struct, a decision about what this package's own queries need,
// not a gap in core's schema coverage. If a future consumer needs replayed
// pause history, it can be added deliberately (its own scope, its own
// decision), same convention this package already applies to trading-volume
// aggregates (index.go's file doc).
//
// EventKind identifies which shape a RawEvent decodes to. The string values
// are exactly the "ev" field core/events.go's evOpen/evOpenActor (or, for
// init, its own inline literal) writes — every kind below, including
// retired/treasuryWithdrawn/tradeFeesClaimed, now originates from a
// core.Ev* constructor rather than a hand-built sdk.Log(...) call in
// ../contract/main.go.
type EventKind string

const (
	KindRegistered   EventKind = "registered"
	KindRenewed      EventKind = "renewed"
	KindFaceChanged  EventKind = "faceChanged"
	KindCapChanged   EventKind = "capChanged"
	KindPrepaid      EventKind = "prepaid"
	KindTransferred  EventKind = "transferred"
	KindAsked        EventKind = "asked"
	KindAnswered     EventKind = "answered"
	KindReclaimed    EventKind = "reclaimed"
	KindDeclined     EventKind = "declined"
	KindRefunded     EventKind = "refunded"
	KindRefundPushed EventKind = "refundPushed"
	KindClosed       EventKind = "closed"

	// Bought/Sold (WAVE D, 2026-07-27) — core/buy.go's Buy and core/sell.go's
	// Sell, the bonding-curve mint/redeem pair that is now the market's ONLY
	// issuance path (prepay.go's PAR mint is deleted). These two were MISSING
	// from this package from the moment WAVE D shipped until this fix: with no
	// KindBought/KindSold, ParseEvent's own documented graceful-degradation
	// default (indexer/events.go's own doc above) sent every "bought"/"sold"
	// log line down the Unknown path — counted in Stats.Unknown, never folded —
	// so every buy and every sell silently vanished from Position/HolderList/
	// EventHistory. No crash, no error: just balances that drift further from
	// chain truth with every trade, for as long as this went unnoticed.
	KindBought EventKind = "bought"
	KindSold   EventKind = "sold"

	// Offering catalogue (2026-07-27) — the creator's shop. These carry NO
	// money: an offering is a posted price, and the money events
	// (asked/answered/reclaimed) already cover every fund flow one can lead
	// to. `asked` now carries OfferingID so a settlement can be attributed to
	// the service that was bought without joining on anything.
	KindOfferingCreated EventKind = "offeringCreated"
	KindOfferingUpdated EventKind = "offeringUpdated"
	KindOfferingDeleted EventKind = "offeringDeleted"

	// KindRetired — Retire (core/market.go) is called from
	// ../contract/main.go's `retire` entrypoint, which as of commit 572ab00
	// builds this log via core.EvRetired (core/events.go, evOpen's shared
	// envelope — verified: same creator/actor/block shape as every event
	// above this one) rather than the hand-built inline JSON it used to
	// emit. It is grouped in this file's separate "contract-level events"
	// block below (not up with Registered..Closed above) only because that
	// is where it was introduced in core/events.go (the 2026-07-28 six,
	// alongside init/pause/unpause/withdrawTreasury/claimTradeFees) — its
	// wire shape carries nothing that structurally distinguishes it from
	// ClosedEvent's. EvRetired is pinned by core/schema_contract_test.go's
	// TestSchemaContract_Retired. Recognizing this kind here is still
	// correct and necessary regardless of which side builds the JSON:
	// Retire is a real, permanent, on-chain state transition (an
	// irreversible forced-FROZEN wind-down marker, core/market.go's
	// kRetiredAt) that was previously invisible to this package —
	// MarketSummary had no way to distinguish a retiring market from a
	// healthy one, only ever learning about a market's terminal state much
	// later, if and when it also fully drains to a "closed" event.
	KindRetired EventKind = "retired"

	// KindTreasuryWithdrawn — DEFECT FIX, 2026-07-28 (indexer side); its
	// contract-side counterpart landed separately, also 2026-07-28:
	// ../contract/main.go's `withdrawTreasury` entrypoint used to hand-build
	// its own log — `{"ev":"treasuryWithdrawn","actor":"...","amount":"...",
	// "block":N}` — and as of commit 572ab00 builds it via
	// core.EvTreasuryWithdrawn (core/events.go), byte-identical to the line
	// it replaces and pinned by core/schema_contract_test.go's
	// TestSchemaContract_TreasuryWithdrawn. This kind was entirely
	// unrecognized before the indexer-side fix below (Stats.Unknown), which
	// mattered more than a typical missing kind: index.go's own
	// TreasuryHbd() doc had FLAGGED itself as already-stale the moment this
	// entrypoint shipped ("the pure MONOTONIC sum, no debit path off
	// kTreasury today claim ... is ALREADY STALE") — without this fix,
	// TreasuryHbd() could only ever grow, so it would silently overstate the
	// real kTreasury() balance forever after the owner's first withdrawal,
	// exactly the kind of drift this package exists to avoid. NO "creator"
	// field on the wire at all (owner-only, not a per-market action) — see
	// index.go's KindTreasuryWithdrawn fold for why this is folded GLOBALLY,
	// never through ix.market(...).
	KindTreasuryWithdrawn EventKind = "treasuryWithdrawn"

	// KindTradeFeesClaimed — DEFECT FIX, 2026-07-28 (indexer side); its
	// contract-side counterpart landed separately, also 2026-07-28:
	// ../contract/main.go's `claimTradeFees` entrypoint used to hand-build
	// `{"ev":"tradeFeesClaimed","actor":"...","amount":"...","block":N}` and
	// as of commit 572ab00 builds it via core.EvTradeFeesClaimed
	// (core/events.go), byte-identical to the line it replaces and pinned by
	// core/schema_contract_test.go's TestSchemaContract_TradeFeesClaimed —
	// logged only when the claimed amount is nonzero (mirrors refundHolder's
	// own M3 zero-payout gating). No "creator" field on the wire either, but
	// unlike treasuryWithdrawn this IS per-market: core.ClaimTradeFees pays
	// out kFeeBal(caller), and every accrual into that key (core/tradefee.go's
	// accrueTradeFee, called from buy.go/sell.go) is always keyed by the
	// CREATOR whose market the trade happened on — never any other account — so
	// `actor` here doubles as the creator identifier, the same "actor always ==
	// creator" shape registered/faceChanged/capChanged/answered already use.
	// kFeeBal is a SEPARATE pull pot from kTreasury (core/read.go's
	// FeeBalanceOf: "neither reserve nor treasury"), so claiming it must never
	// touch ix.treasuryHbd — see index.go's fold for the audit-only treatment.
	KindTradeFeesClaimed EventKind = "tradeFeesClaimed"
)

type OfferingCreatedEvent struct {
	Creator    string `json:"creator"`
	Actor      string `json:"actor"`
	Block      uint64 `json:"block"`
	OfferingID uint64 `json:"offeringId"`
	Title      string `json:"title"`
	Price      string `json:"price"`
}

// OfferingUpdatedEvent covers both a reprice and a relabel: an indexer folds
// one shape and diffs Old/New to see which moved. A relabel emits equal
// prices; a reprice emits the title unchanged.
type OfferingUpdatedEvent struct {
	Creator    string `json:"creator"`
	Actor      string `json:"actor"`
	Block      uint64 `json:"block"`
	OfferingID uint64 `json:"offeringId"`
	Title      string `json:"title"`
	OldPrice   string `json:"oldPrice"`
	NewPrice   string `json:"newPrice"`
}

type OfferingDeletedEvent struct {
	Creator    string `json:"creator"`
	Actor      string `json:"actor"`
	Block      uint64 `json:"block"`
	OfferingID uint64 `json:"offeringId"`
}

// envelope is decoded first, from every raw log line, purely to sniff "ev"
// (and "v", captured but not yet branched on — see Event.Version) before
// committing to a specific typed shape.
type envelope struct {
	Ev string `json:"ev"`
	V  int    `json:"v"`
}

// Every money-shaped field below is kept as a decimal STRING, never
// *big.Int and never a bare JSON number — core/events.go emits every amount
// quoted for exactly this reason (money.go's "no floats anywhere" extended
// to the wire: a JS `number` silently loses precision above 2^53). Convert
// to *big.Int only where arithmetic is actually needed (index.go's folding
// logic), exactly mirroring hive-price-market/indexer/events.go's BetEvent
// convention.

type RegisteredEvent struct {
	Creator string `json:"creator"`
	Actor   string `json:"actor"`
	Block   uint64 `json:"block"`
	Face    string `json:"face"`
	Cap     string `json:"cap"`
	FeePaid string `json:"feePaid"`
}

type RenewedEvent struct {
	Creator string `json:"creator"`
	Actor   string `json:"actor"`
	Block   uint64 `json:"block"`
	Periods uint64 `json:"periods"`
	Paid    string `json:"paid"`
}

type FaceChangedEvent struct {
	Creator string `json:"creator"`
	Actor   string `json:"actor"`
	Block   uint64 `json:"block"`
	OldFace string `json:"oldFace"`
	NewFace string `json:"newFace"`
}

type CapChangedEvent struct {
	Creator string `json:"creator"`
	Actor   string `json:"actor"`
	Block   uint64 `json:"block"`
	OldCap  string `json:"oldCap"`
	NewCap  string `json:"newCap"`
}

type PrepaidEvent struct {
	Creator       string `json:"creator"`
	Actor         string `json:"actor"`
	Block         uint64 `json:"block"`
	HbdPaid       string `json:"hbdPaid"`
	CreditsMinted string `json:"creditsMinted"`
}

// TransferredEvent — Actor is the SENDER (core.TransferCredits' `from`); To
// is the receiving holder.
type TransferredEvent struct {
	Creator string `json:"creator"`
	Actor   string `json:"actor"`
	To      string `json:"to"`
	Block   uint64 `json:"block"`
	Amount  string `json:"amount"`
}

type AskedEvent struct {
	Creator        string `json:"creator"`
	Actor          string `json:"actor"`
	Block          uint64 `json:"block"`
	Seq            uint64 `json:"seq"`
	CreditsSpent   string `json:"creditsSpent"`
	CommissionHbd  string `json:"commissionHbd"`
	Rate           string `json:"rate"`
	DeadlineBlocks uint64 `json:"deadlineBlocks"`
	// OfferingID is which service was bought (0 == the legacy face price).
	// Wired 2026-07-27 — the comment above this block promised it long before
	// ../core/events.go actually emitted it.
	OfferingID  uint64 `json:"offeringId"`
	ContentHash string `json:"contentHash"`
}

// AnsweredEvent — CommissionHbd (M4 fix, 2026-07-21) is the HBD commission
// Answer books to the contract's global treasury in the same call that
// resolves this escrow (../core/events.go's EvAnswered doc has the full
// rationale). Folded into Index.TreasuryHbd's running total (index.go).
type AnsweredEvent struct {
	Creator          string `json:"creator"`
	Actor            string `json:"actor"`
	Block            uint64 `json:"block"`
	Seq              uint64 `json:"seq"`
	CreditsToCreator string `json:"creditsToCreator"`
	CommissionHbd    string `json:"commissionHbd"`
	AnswerHash       string `json:"answerHash"`
}

// ReclaimedEvent — CommissionHbd (M4 fix, 2026-07-21) is the HBD commission
// that was HELD against this escrow (Ask) and is handed back to the asker
// in full here, never having reached the treasury (../core/events.go's
// EvReclaimed doc has the full rationale). Folded into
// Index.ReclaimOutflowHbd's running total (index.go).
//
// Actor vs Asker (2026-07-27): Actor is whoever SUBMITTED the reclaim —
// permissionless (H1), so possibly a keeper or an unrelated third party —
// while Asker is who was actually PAID. Fold the credits to Asker, never to
// Actor: the previous handler credited Actor and silently mis-attributed every
// keeper-pushed reclaim, and it could not have recovered the right account from
// its own escrow map either, since an index that started mid-stream never saw
// the Ask.
type ReclaimedEvent struct {
	Creator       string `json:"creator"`
	Actor         string `json:"actor"`
	Block         uint64 `json:"block"`
	Seq           uint64 `json:"seq"`
	Credits       string `json:"credits"`
	CommissionHbd string `json:"commissionHbd"`
	Asker         string `json:"asker"`
}

// DeclinedEvent — the creator turned a job down inside the answer window and
// handed back credits AND the whole commission (core/ask.go Decline, RULING
// E's delivery gate). Money shape is identical to a reclaim; the distinction is
// the RECORD: a reclaim means the creator went silent until the window closed,
// a decline means they answered promptly with "no". Only the first is a black
// mark, so these must never be folded into the same bucket. Actor is always the
// creator (Decline is creator-only); Asker is who was paid.
type DeclinedEvent struct {
	Creator       string `json:"creator"`
	Actor         string `json:"actor"`
	Block         uint64 `json:"block"`
	Seq           uint64 `json:"seq"`
	Credits       string `json:"credits"`
	CommissionHbd string `json:"commissionHbd"`
	Asker         string `json:"asker"`
}

type RefundedEvent struct {
	Creator string `json:"creator"`
	Actor   string `json:"actor"`
	Block   uint64 `json:"block"`
	Credits string `json:"credits"`
	Payout  string `json:"payout"`
}

// RefundPushedEvent — Actor is the permissionless PUSHER/keeper, never the
// payout recipient; Holder is who is actually paid. These are deliberately
// separate fields (API.md rule 2's one exception: RefundHolder "may be
// pushed by anyone but only ever pays the holder").
type RefundPushedEvent struct {
	Creator       string `json:"creator"`
	Actor         string `json:"actor"`
	Holder        string `json:"holder"`
	Block         uint64 `json:"block"`
	CreditsBurned string `json:"creditsBurned"`
	Payout        string `json:"payout"`
}

type ClosedEvent struct {
	Creator string `json:"creator"`
	Actor   string `json:"actor"`
	Block   uint64 `json:"block"`
}

// BoughtEvent — Buy (core/buy.go), WAVE D. Actor is the buyer. Minted is the
// exact token amount minted straight into the buyer's OWN balance (the SAME
// kBal ledger Ask/Transfer/Refund all share — buy.go: "bal/wacq update via
// creditInflow"), so index.go's fold credits it with the ordinary addBal, not
// a new balance map. Cost is the curve leg that entered kReserve (audit-only
// here — live reserve is a direct chain read, never this package's job, see
// index.go's file doc); Fee is the TOTAL trade fee (core's BuyResult splits
// it FeeCreator/FeePlatform internally, but core.EvBought's own signature
// only takes the combined total, so this package cannot attribute any
// portion of it to the treasury or a creator's pull-claimable balance — see
// index.go's KindBought fold comment); TotalDue == Cost+Fee, the wrapper's
// single HiveDraw amount from the buyer (audit-only, not a credits amount).
type BoughtEvent struct {
	Creator  string `json:"creator"`
	Actor    string `json:"actor"`
	Block    uint64 `json:"block"`
	Minted   string `json:"minted"`
	Cost     string `json:"cost"`
	Fee      string `json:"fee"`
	TotalDue string `json:"totalDue"`
}

// SoldEvent — Sell (core/sell.go), WAVE D. Actor is the seller. Sold is the
// exact token amount debited from the seller's balance (the same kBal ledger
// — index.go's fold uses the ordinary subBal); Gross is the curve leg debited
// from kReserve (audit-only, chain-read-only concern, same reasoning as
// BoughtEvent.Cost); Tax is the exit tax — the WHOLE amount, unsplit, added
// straight to the GLOBAL treasury (sell.go, RULING J/K: "one addMoney, no
// aggregate, no distribution") — this is the one field here index.go DOES
// fold into a running total (Index.TreasuryHbd), because unlike Fee below it
// is never partial; Fee is the TOTAL trade fee, same combined-total
// limitation as BoughtEvent.Fee (core.SellResult splits FeeCreator/
// FeePlatform, but EvSold's own signature only carries the sum); Net is the
// seller's HBD payout (sdk.HiveTransfer) — audit-only, NEVER folded into any
// credits/token balance (mirrors RefundedEvent.Payout's identical treatment:
// this is money paid to a wallet, not a ledger balance this package tracks).
// TaxBps/HeldBlocks are the exit-tax rate actually applied and the hold clock
// it was read from — bare numbers, audit-only, no running total.
type SoldEvent struct {
	Creator    string `json:"creator"`
	Actor      string `json:"actor"`
	Block      uint64 `json:"block"`
	Sold       string `json:"sold"`
	Gross      string `json:"gross"`
	Tax        string `json:"tax"`
	Fee        string `json:"fee"`
	Net        string `json:"net"`
	TaxBps     uint64 `json:"taxBps"`
	HeldBlocks uint64 `json:"heldBlocks"`
}

// ---- contract-level events (money- or state-relevant half of core/events.go's
// SIX "contract-level events", 2026-07-28 gap-hunt closure) -----------------
//
// These three are grouped separately from Registered..SoldEvent above only
// for provenance/history, not because their wire shapes are structurally
// different: RetiredEvent below matches evOpen's shared four-field envelope
// exactly, same as ClosedEvent above (verified: core/events.go's EvRetired
// calls evOpen, not evOpenActor). init/paused/unpaused are the other half of
// that same six-constructor batch — this file's own top doc explains why
// those three get no decode struct at all (no per-market or fund-relevant
// state this package's queries need), which is the real thing distinguishing
// the two halves, not "hand-built vs constructor": all six now go through a
// core.Ev* constructor as of commit 572ab00 (see KindRetired's own doc).
//
// RetiredEvent decodes ../contract/main.go's `retired` log (the `retire`
// entrypoint, built via core.EvRetired as of commit 572ab00 — see
// KindRetired's own doc). No money. This struct declares no "v" field at
// all, so the "v":1 that log now genuinely carries (evOpen writes it
// unconditionally) is simply ignored by json.Unmarshal rather than read into
// Version — envelope.V / Event.Version still capture it separately (see
// Event's own doc below). Nothing in this package has ever needed to branch
// on "v" for this event, the same as every other typed struct in this file
// — not because the value was ever unstable: EvRetired shares evOpen's fixed
// envelope with every other Ev*-constructed event, so "v" is exactly as
// stable here as it is for RegisteredEvent or ClosedEvent.
type RetiredEvent struct {
	Creator string `json:"creator"`
	Actor   string `json:"actor"`
	Block   uint64 `json:"block"`
}

// TreasuryWithdrawnEvent decodes ../contract/main.go's `treasuryWithdrawn`
// log (the `withdrawTreasury` entrypoint, built via core.EvTreasuryWithdrawn
// as of commit 572ab00 — see KindTreasuryWithdrawn's own doc). Deliberately
// no "creator" field: this is a GLOBAL kTreasury() debit, not scoped to any
// single creator's market — see index.go's fold for why that means this
// event is never routed through ix.market(...) or any per-creator history.
type TreasuryWithdrawnEvent struct {
	Actor  string `json:"actor"`
	Block  uint64 `json:"block"`
	Amount string `json:"amount"`
}

// TradeFeesClaimedEvent decodes ../contract/main.go's `tradeFeesClaimed` log
// (the `claimTradeFees` entrypoint, built via core.EvTradeFeesClaimed as of
// commit 572ab00) — see KindTradeFeesClaimed's own doc for why Actor doubles
// as the creator identifier here (kFeeBal is always keyed by the creator
// whose market accrued the fee), even though the wire has no separate
// "creator" field.
type TradeFeesClaimedEvent struct {
	Actor  string `json:"actor"`
	Block  uint64 `json:"block"`
	Amount string `json:"amount"`
}

// Event is the parsed result of one RawEvent. Exactly one of the typed
// pointer fields is non-nil, selected by Kind — EXCEPT when Unknown is
// true, in which case none are populated and Kind holds whatever the source
// log's "ev" field literally said. Callers should switch on Kind, not on
// which pointer is non-nil, so a future added event kind fails closed
// (falls into Unknown-shaped handling) rather than panicking on a nil
// pointer.
type Event struct {
	Kind    EventKind
	Version int // the source log's "v" field; captured, not yet branched on — see ParseEvent's doc
	Unknown bool
	Raw     RawEvent

	Registered   *RegisteredEvent
	Renewed      *RenewedEvent
	FaceChanged  *FaceChangedEvent
	CapChanged   *CapChangedEvent
	Prepaid      *PrepaidEvent
	Transferred  *TransferredEvent
	Asked        *AskedEvent
	Answered     *AnsweredEvent
	Reclaimed    *ReclaimedEvent
	Declined     *DeclinedEvent
	Refunded     *RefundedEvent
	RefundPushed *RefundPushedEvent
	Closed       *ClosedEvent
	Bought       *BoughtEvent
	Sold         *SoldEvent

	OfferingCreated *OfferingCreatedEvent
	OfferingUpdated *OfferingUpdatedEvent
	OfferingDeleted *OfferingDeletedEvent

	// Retired/TreasuryWithdrawn/TradeFeesClaimed — see each Kind's own doc:
	// the money-or-state-relevant half of core/events.go's six contract-level
	// events (commit 572ab00), now built via core.EvRetired/
	// EvTreasuryWithdrawn/EvTradeFeesClaimed like everything else in this file.
	Retired           *RetiredEvent
	TreasuryWithdrawn *TreasuryWithdrawnEvent
	TradeFeesClaimed  *TradeFeesClaimedEvent
}

// ParseEvent decodes one RawEvent's Data into a typed Event.
//
// Two distinct failure modes are handled differently, on purpose:
//
//  1. Data is not valid JSON at all, or has no "ev" field of type string ⇒
//     this IS an error (something upstream is broken — a real log line
//     from core/events.go is always well-formed flat JSON with an "ev"
//     key). The caller (Index.Ingest) counts and skips it; ParseEvent
//     itself never panics.
//  2. Data is valid JSON with a recognized "ev" field, but the value isn't
//     one of the known kinds (e.g. a future event type added to
//     core/events.go that this package hasn't been taught yet, or one of
//     the three DELIBERATELY-ignored logs named at this file's own top doc
//     — "init", "paused", "unpaused" — which do have core.Ev* constructors
//     now, just no decode struct in this package: none of them carry
//     per-market or fund-relevant state any query here needs) ⇒ NOT an
//     error. Returns
//     Event{Kind: <that string>, Unknown: true, Raw: raw}, nil. This is the
//     graceful-degradation path: an old indexer binary must keep
//     processing every OTHER event correctly forever, never crash or
//     wedge, when the contract adds a new log shape.
func ParseEvent(raw RawEvent) (Event, error) {
	var env envelope
	if err := json.Unmarshal([]byte(raw.Data), &env); err != nil {
		return Event{}, &ParseError{Raw: raw, Cause: err}
	}
	if env.Ev == "" {
		return Event{}, &ParseError{Raw: raw, Cause: errNoEvField}
	}

	kind := EventKind(env.Ev)
	ev := Event{Kind: kind, Version: env.V, Raw: raw}

	switch kind {
	case KindRegistered:
		var p RegisteredEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.Registered = &p
	case KindRenewed:
		var p RenewedEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.Renewed = &p
	case KindFaceChanged:
		var p FaceChangedEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.FaceChanged = &p
	case KindCapChanged:
		var p CapChangedEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.CapChanged = &p
	case KindPrepaid:
		var p PrepaidEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.Prepaid = &p
	case KindTransferred:
		var p TransferredEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.Transferred = &p
	case KindAsked:
		var p AskedEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.Asked = &p
	case KindAnswered:
		var p AnsweredEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.Answered = &p
	case KindReclaimed:
		var p ReclaimedEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.Reclaimed = &p
	case KindDeclined:
		var p DeclinedEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.Declined = &p
	case KindRefunded:
		var p RefundedEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.Refunded = &p
	case KindRefundPushed:
		var p RefundPushedEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.RefundPushed = &p
	case KindClosed:
		var p ClosedEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.Closed = &p
	case KindBought:
		var p BoughtEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.Bought = &p
	case KindSold:
		var p SoldEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.Sold = &p
	case KindRetired:
		var p RetiredEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.Retired = &p
	case KindTreasuryWithdrawn:
		var p TreasuryWithdrawnEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.TreasuryWithdrawn = &p
	case KindTradeFeesClaimed:
		var p TradeFeesClaimedEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.TradeFeesClaimed = &p
	case KindOfferingCreated:
		var p OfferingCreatedEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.OfferingCreated = &p
	case KindOfferingUpdated:
		var p OfferingUpdatedEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.OfferingUpdated = &p
	case KindOfferingDeleted:
		var p OfferingDeletedEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.OfferingDeleted = &p
	default:
		ev.Unknown = true
	}
	return ev, nil
}

// ParseError wraps a decode failure with the offending RawEvent, so a
// caller logging/counting parse failures can report WHICH log line broke
// without re-threading raw+err separately.
type ParseError struct {
	Raw   RawEvent
	Cause error
}

func (e *ParseError) Error() string {
	return "indexer: parse event (outputID=" + e.Raw.OutputID + "): " + e.Cause.Error()
}
func (e *ParseError) Unwrap() error { return e.Cause }

type simpleErr string

func (e simpleErr) Error() string { return string(e) }

const errNoEvField = simpleErr(`log line has no non-empty "ev" field`)
