package indexer

import "encoding/json"

// EventKind identifies which of the contract's six sdk.Log shapes a RawEvent
// decodes to. The string values are exactly the "ev" field the contract
// writes (see ../contract/main.go's six sdk.Log call sites).
type EventKind string

const (
	KindRoundCreated EventKind = "round_created"
	KindBet          EventKind = "bet"
	KindResolved     EventKind = "resolved"
	KindVoided       EventKind = "voided"
	KindClaim        EventKind = "claim"
	KindHousePaid    EventKind = "house_paid"
)

// Round state values as they appear in an ev:resolved "state" field. These
// are string-identical to market.StateSettled / market.StateVoid
// (../market/params.go) — the wasm layer writes result.State straight into
// the log (main.go's Settle handler: `"state":"`+result.State+`"`), and
// result.State always comes from one of those two market constants. Declared
// locally (not imported from the market package) so this package stays a
// standalone consumer of the LOG FORMAT, not of market's internal Store
// machinery — same boundary discipline main.go itself uses for round state
// (main.go's roundAsset() duplicates market's key format with an explicit
// "COUPLING WARNING" comment; this is the same tradeoff).
const (
	StateSettled = "settled"
	StateVoid    = "void"
)

// envelope is decoded first, from every raw log line, purely to sniff "ev"
// before committing to a specific typed shape.
type envelope struct {
	Ev string `json:"ev"`
}

// RoundCreatedEvent — CreateRound's log (main.go:408). Notably: no "asset"
// field. A round's asset (rd|<id>|asset) is NOT observable from the event
// stream at all — only from a getStateByKeys read (DUMB-QUESTIONS E2). This
// package never fabricates it.
type RoundCreatedEvent struct {
	RoundID uint64 `json:"roundId"`
	By      string `json:"by"`
}

// BetEvent — Bet's log (main.go:459). Also carries no "asset" (the round's
// asset is immutable and enforced against the payload inside Bet(), but
// never re-logged). Amount is the exact base-unit decimal string
// (big.Int.String(), see main.go's parseBigDecimal) — kept as a string
// end-to-end in this package to avoid float precision loss; convert to a
// display value only at the UI edge.
type BetEvent struct {
	RoundID uint64 `json:"roundId"`
	Outcome int    `json:"outcome"`
	Acct    string `json:"acct"`
	Amount  string `json:"amount"`
}

// ResolvedEvent — Settle's log (main.go:496), emitted for BOTH terminal
// outcomes: State is "settled" or "void" (market.StateSettled/StateVoid).
// Winner is only meaningful when State=="settled": doVoid (../market/settle.go)
// never sets SettleResult.Winner, so on a void resolution this field reads
// back as its zero value (0) — which collides with a genuine winning outcome
// index of 0. Index.RoundSummary tracks a separate WinnerValid bool instead
// of trusting Winner==0 as "no winner" (see index.go).
type ResolvedEvent struct {
	RoundID uint64 `json:"roundId"`
	State   string `json:"state"`
	Winner  int    `json:"winner"`
	Reason  string `json:"reason"`
}

// VoidedEvent — VoidStale's log (main.go:537). Always implies void (this
// entrypoint has no other outcome); unlike ResolvedEvent it carries no
// "state" field at all, only "reason".
type VoidedEvent struct {
	RoundID uint64 `json:"roundId"`
	Reason  string `json:"reason"`
}

// ClaimEvent — Claim's log (main.go:562). A zero-payout claim (loser, or an
// account with no stake) is still logged — claim.go's doc comment: "still a
// successful claim". Asset IS present here (unlike bet/round_created), since
// Claim reads it straight out of state at claim time.
type ClaimEvent struct {
	RoundID uint64 `json:"roundId"`
	Acct    string `json:"acct"`
	Payout  string `json:"payout"`
	Asset   string `json:"asset"`
}

// HousePaidEvent — WithdrawFees's log (main.go:614). Round-independent: this
// is a sweep of accrued fees across potentially many rounds, keyed only by
// asset.
type HousePaidEvent struct {
	Asset  string `json:"asset"`
	Amount string `json:"amount"`
	House  string `json:"house"`
}

// Event is the parsed result of one RawEvent. Exactly one of the typed
// pointer fields is non-nil, selected by Kind — EXCEPT when Unknown is true,
// in which case none are populated and Kind holds whatever the source log's
// "ev" field literally said. Callers should switch on Kind, not on which
// pointer is non-nil, so a future added event kind fails closed (falls into
// Unknown-shaped handling) rather than panicking on a nil pointer.
type Event struct {
	Kind    EventKind
	Unknown bool // true if Kind was not one of the six known values
	Raw     RawEvent

	RoundCreated *RoundCreatedEvent
	Bet          *BetEvent
	Resolved     *ResolvedEvent
	Voided       *VoidedEvent
	Claim        *ClaimEvent
	HousePaid    *HousePaidEvent
}

// ParseEvent decodes one RawEvent's Data into a typed Event.
//
// Contract per the task spec: "Handle unknown ev gracefully." Two distinct
// failure modes are handled differently, on purpose:
//
//  1. Data is not valid JSON at all, or has no "ev" field of type string ⇒
//     this IS an error (something upstream is broken — a real log line from
//     this contract is always well-formed flat JSON with an "ev" key). The
//     caller (Index.Ingest) counts and skips it; ParseEvent itself never
//     panics.
//  2. Data is valid JSON with a recognized "ev" field, but the value isn't
//     one of the six known kinds (e.g. a future event type added to the
//     contract that this package hasn't been taught yet) ⇒ NOT an error.
//     Returns Event{Kind: <that string>, Unknown: true, Raw: raw}, nil. This
//     is the graceful-degradation path: an old indexer binary must keep
//     processing every OTHER event correctly forever, never crash or wedge,
//     when the contract adds a new log shape.
func ParseEvent(raw RawEvent) (Event, error) {
	var env envelope
	if err := json.Unmarshal([]byte(raw.Data), &env); err != nil {
		return Event{}, &ParseError{Raw: raw, Cause: err}
	}
	if env.Ev == "" {
		return Event{}, &ParseError{Raw: raw, Cause: errNoEvField}
	}

	kind := EventKind(env.Ev)
	ev := Event{Kind: kind, Raw: raw}

	switch kind {
	case KindRoundCreated:
		var p RoundCreatedEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.RoundCreated = &p
	case KindBet:
		var p BetEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.Bet = &p
	case KindResolved:
		var p ResolvedEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.Resolved = &p
	case KindVoided:
		var p VoidedEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.Voided = &p
	case KindClaim:
		var p ClaimEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.Claim = &p
	case KindHousePaid:
		var p HousePaidEvent
		if err := json.Unmarshal([]byte(raw.Data), &p); err != nil {
			return Event{}, &ParseError{Raw: raw, Cause: err}
		}
		ev.HousePaid = &p
	default:
		ev.Unknown = true
	}
	return ev, nil
}

// ParseError wraps a decode failure with the offending RawEvent, so a caller
// logging/counting parse failures can report WHICH log line broke without
// re-threading raw+err separately.
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
