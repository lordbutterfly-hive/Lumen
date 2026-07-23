package indexer

import "encoding/json"

// events.go — typed decoders for ../core/events.go's twelve Ev* wire
// shapes. This package is a STANDALONE consumer of the LOG FORMAT (the JSON
// string), never of core's internal Store machinery — it does not import
// creator-tokens/core at all, matching the boundary discipline
// hive-price-market/indexer/events.go documents for the identical
// contract/indexer split ("this package stays a standalone consumer of the
// LOG FORMAT, not of market's internal Store machinery"). If ../core/events.go
// ever changes a field name, this file has to be updated by hand — that is
// the deliberate cost of the decoupling, not an oversight.
//
// EventKind identifies which of the twelve shapes a RawEvent decodes to.
// The string values are exactly the "ev" field core/events.go's evOpen
// writes.
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
	KindRefunded     EventKind = "refunded"
	KindRefundPushed EventKind = "refundPushed"
	KindClosed       EventKind = "closed"
)

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
	ContentHash    string `json:"contentHash"`
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
type ReclaimedEvent struct {
	Creator       string `json:"creator"`
	Actor         string `json:"actor"`
	Block         uint64 `json:"block"`
	Seq           uint64 `json:"seq"`
	Credits       string `json:"credits"`
	CommissionHbd string `json:"commissionHbd"`
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
	Refunded     *RefundedEvent
	RefundPushed *RefundPushedEvent
	Closed       *ClosedEvent
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
//     one of the twelve known kinds (e.g. a future event type added to
//     core/events.go that this package hasn't been taught yet, or "init" —
//     the contract's owner-bootstrap log, which is NOT one of the twelve
//     core-module events this package tracks) ⇒ NOT an error. Returns
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
