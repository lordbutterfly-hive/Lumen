package indexer

import "testing"

func TestParseEvent_Registered(t *testing.T) {
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"registered","v":1,"creator":"alice","actor":"alice","block":100,"face":"1000","cap":"100000","feePaid":"10000"}`})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ev.Kind != KindRegistered || ev.Unknown {
		t.Fatalf("wrong kind/unknown: %+v", ev)
	}
	if ev.Version != 1 {
		t.Fatalf("Version = %d, want 1", ev.Version)
	}
	want := RegisteredEvent{Creator: "alice", Actor: "alice", Block: 100, Face: "1000", Cap: "100000", FeePaid: "10000"}
	if ev.Registered == nil || *ev.Registered != want {
		t.Fatalf("got %+v want %+v", ev.Registered, want)
	}
}

func TestParseEvent_Renewed(t *testing.T) {
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"renewed","v":1,"creator":"alice","actor":"fan1","block":200,"periods":3,"paid":"30000"}`})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := RenewedEvent{Creator: "alice", Actor: "fan1", Block: 200, Periods: 3, Paid: "30000"}
	if ev.Renewed == nil || *ev.Renewed != want {
		t.Fatalf("got %+v want %+v", ev.Renewed, want)
	}
}

func TestParseEvent_FaceChanged(t *testing.T) {
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"faceChanged","v":1,"creator":"alice","actor":"alice","block":300,"oldFace":"1000","newFace":"1500"}`})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := FaceChangedEvent{Creator: "alice", Actor: "alice", Block: 300, OldFace: "1000", NewFace: "1500"}
	if ev.FaceChanged == nil || *ev.FaceChanged != want {
		t.Fatalf("got %+v want %+v", ev.FaceChanged, want)
	}
}

func TestParseEvent_CapChanged(t *testing.T) {
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"capChanged","v":1,"creator":"alice","actor":"alice","block":300,"oldCap":"1000","newCap":"2000"}`})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := CapChangedEvent{Creator: "alice", Actor: "alice", Block: 300, OldCap: "1000", NewCap: "2000"}
	if ev.CapChanged == nil || *ev.CapChanged != want {
		t.Fatalf("got %+v want %+v", ev.CapChanged, want)
	}
}

func TestParseEvent_Prepaid(t *testing.T) {
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"prepaid","v":1,"creator":"alice","actor":"bob","block":400,"hbdPaid":"5000","creditsMinted":"5000"}`})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := PrepaidEvent{Creator: "alice", Actor: "bob", Block: 400, HbdPaid: "5000", CreditsMinted: "5000"}
	if ev.Prepaid == nil || *ev.Prepaid != want {
		t.Fatalf("got %+v want %+v", ev.Prepaid, want)
	}
}

func TestParseEvent_Transferred(t *testing.T) {
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"transferred","v":1,"creator":"alice","actor":"bob","block":500,"to":"carol","amount":"100"}`})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := TransferredEvent{Creator: "alice", Actor: "bob", To: "carol", Block: 500, Amount: "100"}
	if ev.Transferred == nil || *ev.Transferred != want {
		t.Fatalf("got %+v want %+v", ev.Transferred, want)
	}
}

func TestParseEvent_Asked(t *testing.T) {
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"asked","v":1,"creator":"alice","actor":"bob","block":600,"seq":7,"creditsSpent":"42","commissionHbd":"12","rate":"1000000","deadlineBlocks":28800,"contentHash":"h1"}`})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := AskedEvent{
		Creator: "alice", Actor: "bob", Block: 600, Seq: 7,
		CreditsSpent: "42", CommissionHbd: "12", Rate: "1000000",
		DeadlineBlocks: 28800, ContentHash: "h1",
	}
	if ev.Asked == nil || *ev.Asked != want {
		t.Fatalf("got %+v want %+v", ev.Asked, want)
	}
}

func TestParseEvent_Answered(t *testing.T) {
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"answered","v":1,"creator":"alice","actor":"alice","block":650,"seq":7,"creditsToCreator":"42","commissionHbd":"5","answerHash":"h2"}`})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := AnsweredEvent{Creator: "alice", Actor: "alice", Block: 650, Seq: 7, CreditsToCreator: "42", CommissionHbd: "5", AnswerHash: "h2"}
	if ev.Answered == nil || *ev.Answered != want {
		t.Fatalf("got %+v want %+v", ev.Answered, want)
	}
}

func TestParseEvent_Reclaimed(t *testing.T) {
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"reclaimed","v":1,"creator":"alice","actor":"bob","block":700,"seq":8,"credits":"42","commissionHbd":"5"}`})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := ReclaimedEvent{Creator: "alice", Actor: "bob", Block: 700, Seq: 8, Credits: "42", CommissionHbd: "5"}
	if ev.Reclaimed == nil || *ev.Reclaimed != want {
		t.Fatalf("got %+v want %+v", ev.Reclaimed, want)
	}
}

func TestParseEvent_Refunded(t *testing.T) {
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"refunded","v":1,"creator":"alice","actor":"bob","block":800,"credits":"100","payout":"95"}`})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := RefundedEvent{Creator: "alice", Actor: "bob", Block: 800, Credits: "100", Payout: "95"}
	if ev.Refunded == nil || *ev.Refunded != want {
		t.Fatalf("got %+v want %+v", ev.Refunded, want)
	}
}

func TestParseEvent_RefundPushed(t *testing.T) {
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"refundPushed","v":1,"creator":"alice","actor":"keeper1","block":900,"holder":"bob","creditsBurned":"300","payout":"285"}`})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := RefundPushedEvent{Creator: "alice", Actor: "keeper1", Holder: "bob", Block: 900, CreditsBurned: "300", Payout: "285"}
	if ev.RefundPushed == nil || *ev.RefundPushed != want {
		t.Fatalf("got %+v want %+v", ev.RefundPushed, want)
	}
}

func TestParseEvent_Closed(t *testing.T) {
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"closed","v":1,"creator":"alice","actor":"keeper1","block":1000}`})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := ClosedEvent{Creator: "alice", Actor: "keeper1", Block: 1000}
	if ev.Closed == nil || *ev.Closed != want {
		t.Fatalf("got %+v want %+v", ev.Closed, want)
	}
}

func TestParseEvent_UnknownEvIsGraceful(t *testing.T) {
	// A future contract version might add a new ev kind, or (today) the
	// wasm layer's own "init" owner-bootstrap log, which is not one of the
	// 12 core-module events this package tracks — an old indexer binary
	// must not error or panic on it.
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"init","owner":"alice"}`})
	if err != nil {
		t.Fatalf("unknown ev must not be an error, got: %v", err)
	}
	if !ev.Unknown {
		t.Fatalf("expected Unknown=true, got %+v", ev)
	}
	if ev.Kind != "init" {
		t.Fatalf("expected Kind to carry the raw ev string, got %q", ev.Kind)
	}
	if ev.Registered != nil || ev.Renewed != nil || ev.FaceChanged != nil || ev.CapChanged != nil ||
		ev.Prepaid != nil || ev.Transferred != nil || ev.Asked != nil || ev.Answered != nil ||
		ev.Reclaimed != nil || ev.Refunded != nil || ev.RefundPushed != nil || ev.Closed != nil {
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
	_, err := ParseEvent(RawEvent{Data: `{"creator":"alice"}`})
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
	// block as a JSON string instead of a number must fail to decode into
	// the uint64 field rather than silently defaulting to 0 — a real log
	// line from core/events.go NEVER quotes block (evU64 writes an
	// unquoted decimal token), so this represents genuine upstream
	// corruption, not a shape this package should tolerate.
	_, err := ParseEvent(RawEvent{Data: `{"ev":"asked","v":1,"creator":"c","actor":"a","block":"600","seq":1,"creditsSpent":"1","commissionHbd":"1","rate":"1","deadlineBlocks":1,"contentHash":"h"}`})
	if err == nil {
		t.Fatal("expected an error for block typed as a JSON string")
	}
}

func TestParseError_ErrorMessageIncludesOutputIDAndCause(t *testing.T) {
	_, err := ParseEvent(RawEvent{Data: `not json`, OutputID: "out-42"})
	pe, ok := err.(*ParseError)
	if !ok {
		t.Fatalf("expected *ParseError, got %T", err)
	}
	msg := pe.Error()
	if msg == "" {
		t.Fatal("Error() returned empty string")
	}
	if !contains(msg, "out-42") {
		t.Errorf("Error() = %q, want it to mention the OutputID", msg)
	}
}

func TestSimpleErr_ErrorMessage(t *testing.T) {
	if errNoEvField.Error() == "" {
		t.Fatal("errNoEvField.Error() returned empty string")
	}
}

func contains(s, substr string) bool {
	for i := 0; i+len(substr) <= len(s); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func TestParseEvent_AllTwelveKindsRoundTrip(t *testing.T) {
	// A compact sweep proving every one of the twelve EventKind constants
	// parses to Unknown=false and populates exactly its own typed field —
	// a regression guard against a future rename of an EventKind constant
	// drifting silently out of sync with its switch case in ParseEvent.
	cases := []struct {
		kind EventKind
		data string
	}{
		{KindRegistered, `{"ev":"registered","v":1,"creator":"c","actor":"a","block":1,"face":"1","cap":"1","feePaid":"1"}`},
		{KindRenewed, `{"ev":"renewed","v":1,"creator":"c","actor":"a","block":1,"periods":1,"paid":"1"}`},
		{KindFaceChanged, `{"ev":"faceChanged","v":1,"creator":"c","actor":"a","block":1,"oldFace":"1","newFace":"2"}`},
		{KindCapChanged, `{"ev":"capChanged","v":1,"creator":"c","actor":"a","block":1,"oldCap":"1","newCap":"2"}`},
		{KindPrepaid, `{"ev":"prepaid","v":1,"creator":"c","actor":"a","block":1,"hbdPaid":"1","creditsMinted":"1"}`},
		{KindTransferred, `{"ev":"transferred","v":1,"creator":"c","actor":"a","block":1,"to":"b","amount":"1"}`},
		{KindAsked, `{"ev":"asked","v":1,"creator":"c","actor":"a","block":1,"seq":1,"creditsSpent":"1","commissionHbd":"1","rate":"1","deadlineBlocks":1,"contentHash":"h"}`},
		{KindAnswered, `{"ev":"answered","v":1,"creator":"c","actor":"a","block":1,"seq":1,"creditsToCreator":"1","commissionHbd":"1","answerHash":"h"}`},
		{KindReclaimed, `{"ev":"reclaimed","v":1,"creator":"c","actor":"a","block":1,"seq":1,"credits":"1","commissionHbd":"1"}`},
		{KindRefunded, `{"ev":"refunded","v":1,"creator":"c","actor":"a","block":1,"credits":"1","payout":"1"}`},
		{KindRefundPushed, `{"ev":"refundPushed","v":1,"creator":"c","actor":"a","block":1,"holder":"h","creditsBurned":"1","payout":"1"}`},
		{KindClosed, `{"ev":"closed","v":1,"creator":"c","actor":"a","block":1}`},
	}
	for _, c := range cases {
		ev, err := ParseEvent(RawEvent{Data: c.data})
		if err != nil {
			t.Errorf("%s: unexpected error: %v", c.kind, err)
			continue
		}
		if ev.Unknown {
			t.Errorf("%s: Unknown=true, want false", c.kind)
		}
		if ev.Kind != c.kind {
			t.Errorf("Kind = %q, want %q", ev.Kind, c.kind)
		}
	}
}
