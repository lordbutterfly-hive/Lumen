package indexer

import "testing"

func TestParseEvent_RoundCreated(t *testing.T) {
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"round_created","roundId":7,"by":"hive:lordbutterfly"}`})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ev.Kind != KindRoundCreated || ev.Unknown {
		t.Fatalf("wrong kind/unknown: %+v", ev)
	}
	if ev.RoundCreated == nil {
		t.Fatal("RoundCreated field not populated")
	}
	if ev.RoundCreated.RoundID != 7 || ev.RoundCreated.By != "hive:lordbutterfly" {
		t.Fatalf("wrong fields: %+v", ev.RoundCreated)
	}
}

func TestParseEvent_Bet(t *testing.T) {
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"bet","roundId":7,"outcome":3,"acct":"hive:alice","amount":"5000"}`})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ev.Kind != KindBet || ev.Bet == nil {
		t.Fatalf("wrong parse: %+v", ev)
	}
	want := BetEvent{RoundID: 7, Outcome: 3, Acct: "hive:alice", Amount: "5000"}
	if *ev.Bet != want {
		t.Fatalf("got %+v want %+v", *ev.Bet, want)
	}
}

func TestParseEvent_ResolvedSettled(t *testing.T) {
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"resolved","roundId":7,"state":"settled","winner":2,"reason":""}`})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ev.Resolved == nil {
		t.Fatal("Resolved not populated")
	}
	want := ResolvedEvent{RoundID: 7, State: StateSettled, Winner: 2, Reason: ""}
	if *ev.Resolved != want {
		t.Fatalf("got %+v want %+v", *ev.Resolved, want)
	}
}

func TestParseEvent_ResolvedVoid(t *testing.T) {
	// Settle's own VOID path logs via "ev":"resolved" too (main.go's Settle
	// handler always emits "resolved", not "voided" — "voided" is exclusively
	// VoidStale's entrypoint). Winner reads back 0 here (doVoid never sets
	// it) — ambiguous by itself, which is exactly why index.go tracks
	// WinnerValid separately instead of trusting Winner==0.
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"resolved","roundId":7,"state":"void","winner":0,"reason":"zero_winner"}`})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ev.Resolved.State != StateVoid || ev.Resolved.Reason != "zero_winner" {
		t.Fatalf("got %+v", ev.Resolved)
	}
}

func TestParseEvent_Voided(t *testing.T) {
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"voided","roundId":7,"reason":"stale_feed"}`})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ev.Voided == nil || ev.Voided.RoundID != 7 || ev.Voided.Reason != "stale_feed" {
		t.Fatalf("got %+v", ev.Voided)
	}
}

func TestParseEvent_Claim(t *testing.T) {
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"claim","roundId":7,"acct":"hive:alice","payout":"4900","asset":"hive"}`})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := ClaimEvent{RoundID: 7, Acct: "hive:alice", Payout: "4900", Asset: "hive"}
	if *ev.Claim != want {
		t.Fatalf("got %+v want %+v", *ev.Claim, want)
	}
}

func TestParseEvent_ClaimZeroPayout(t *testing.T) {
	// claim.go: "A zero payout is still a successful claim" — a loser's
	// claim log looks exactly like this; must parse cleanly, not be treated
	// as malformed.
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"claim","roundId":7,"acct":"hive:loser","payout":"0","asset":"hive"}`})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ev.Claim.Payout != "0" {
		t.Fatalf("got %+v", ev.Claim)
	}
}

func TestParseEvent_HousePaid(t *testing.T) {
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"house_paid","asset":"hive","amount":"300","house":"hive:lordbutterfly"}`})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := HousePaidEvent{Asset: "hive", Amount: "300", House: "hive:lordbutterfly"}
	if *ev.HousePaid != want {
		t.Fatalf("got %+v want %+v", *ev.HousePaid, want)
	}
}

func TestParseEvent_UnknownEvIsGraceful(t *testing.T) {
	// Task spec: "Handle unknown ev gracefully." A future contract version
	// might add a new ev kind; an old indexer binary must not error or panic
	// on it.
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"some_future_event","foo":"bar","n":42}`})
	if err != nil {
		t.Fatalf("unknown ev must not be an error, got: %v", err)
	}
	if !ev.Unknown {
		t.Fatalf("expected Unknown=true, got %+v", ev)
	}
	if ev.Kind != "some_future_event" {
		t.Fatalf("expected Kind to carry the raw ev string, got %q", ev.Kind)
	}
	// None of the typed pointers should be populated.
	if ev.RoundCreated != nil || ev.Bet != nil || ev.Resolved != nil ||
		ev.Voided != nil || ev.Claim != nil || ev.HousePaid != nil {
		t.Fatalf("unknown event should populate no typed fields: %+v", ev)
	}
}

func TestParseEvent_MalformedJSONIsError(t *testing.T) {
	_, err := ParseEvent(RawEvent{Data: `not json at all`, OutputID: "out-1"})
	if err == nil {
		t.Fatal("expected an error for non-JSON input")
	}
	pe, ok := err.(*ParseError)
	if !ok {
		t.Fatalf("expected *ParseError, got %T: %v", err, err)
	}
	if pe.Raw.OutputID != "out-1" {
		t.Fatalf("ParseError should carry the offending RawEvent, got %+v", pe.Raw)
	}
	if pe.Unwrap() == nil {
		t.Fatal("ParseError.Unwrap() should return the underlying cause")
	}
}

func TestParseEvent_MissingEvFieldIsError(t *testing.T) {
	_, err := ParseEvent(RawEvent{Data: `{"roundId":7,"by":"hive:alice"}`})
	if err == nil {
		t.Fatal("expected an error for a log line with no ev field")
	}
}

func TestParseEvent_EmptyStringIsError(t *testing.T) {
	_, err := ParseEvent(RawEvent{Data: ``})
	if err == nil {
		t.Fatal("expected an error for an empty log line")
	}
}

func TestParseEvent_TypeMismatchIsError(t *testing.T) {
	// roundId as a JSON string instead of a number must fail to decode into
	// the uint64 field rather than silently defaulting to 0 — a real
	// contract log NEVER quotes roundId (main.go's u64s() writes an
	// unquoted decimal token), so this represents genuine upstream
	// corruption, not a shape this package should tolerate.
	_, err := ParseEvent(RawEvent{Data: `{"ev":"bet","roundId":"7","outcome":1,"acct":"hive:a","amount":"1"}`})
	if err == nil {
		t.Fatal("expected an error for roundId typed as a JSON string")
	}
}
