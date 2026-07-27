package indexer

import (
	"os"
	"regexp"
	"testing"
)

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

// The actor and the asker are DELIBERATELY different here: reclaim is
// permissionless, so the realistic case is a keeper ("bob") pushing an
// abandoned escrow whose money goes to the original asker ("carol"). A fixture
// where the two coincide cannot catch the mis-attribution this field exists to
// prevent.
func TestParseEvent_Reclaimed(t *testing.T) {
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"reclaimed","v":1,"creator":"alice","actor":"bob","block":700,"seq":8,"credits":"42","commissionHbd":"5","asker":"carol"}`})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := ReclaimedEvent{Creator: "alice", Actor: "bob", Block: 700, Seq: 8, Credits: "42", CommissionHbd: "5", Asker: "carol"}
	if ev.Reclaimed == nil || *ev.Reclaimed != want {
		t.Fatalf("got %+v want %+v", ev.Reclaimed, want)
	}
}

// TestIndex_KeeperReclaimCreditsTheAskerNotTheCaller pins the defect the Asker
// field was added for: a third party pushing someone else's abandoned escrow
// must not be credited with their tokens.
func TestIndex_KeeperReclaimCreditsTheAskerNotTheCaller(t *testing.T) {
	ix := NewIndex()
	ix.Ingest([]RawEvent{{OutputID: "o1", Data: `{"ev":"reclaimed","v":1,"creator":"alice","actor":"keeperbot","block":700,"seq":8,"credits":"500","commissionHbd":"5","asker":"carol"}`}})
	if got := ix.Position("alice", "carol"); got.String() != "500" {
		t.Fatalf("asker carol credited %s, want the 500 the chain actually paid her", got)
	}
	if got := ix.Position("alice", "keeperbot"); got.Sign() != 0 {
		t.Fatalf("keeperbot was credited %s for pushing someone else's escrow", got)
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

// TestParseEvent_Bought pins core/buy.go's EvBought wire shape: DEFECT FIX,
// this event kind did not exist in this package before — every real "bought"
// log line parsed to Unknown=true and Kind=="bought", never populating
// ev.Bought at all.
func TestParseEvent_Bought(t *testing.T) {
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"bought","v":1,"creator":"alice","actor":"bob","block":1100,"minted":"50","cost":"525","fee":"5","totalDue":"530"}`})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ev.Kind != KindBought || ev.Unknown {
		t.Fatalf("wrong kind/unknown: %+v", ev)
	}
	want := BoughtEvent{Creator: "alice", Actor: "bob", Block: 1100, Minted: "50", Cost: "525", Fee: "5", TotalDue: "530"}
	if ev.Bought == nil || *ev.Bought != want {
		t.Fatalf("got %+v want %+v", ev.Bought, want)
	}
}

// TestParseEvent_Sold pins core/sell.go's EvSold wire shape — same DEFECT FIX
// as Bought above: "sold" fell entirely into Unknown before this fix.
func TestParseEvent_Sold(t *testing.T) {
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"sold","v":1,"creator":"alice","actor":"bob","block":1200,"sold":"20","gross":"200","tax":"10","fee":"2","net":"188","taxBps":500,"heldBlocks":40320}`})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ev.Kind != KindSold || ev.Unknown {
		t.Fatalf("wrong kind/unknown: %+v", ev)
	}
	want := SoldEvent{Creator: "alice", Actor: "bob", Block: 1200, Sold: "20", Gross: "200", Tax: "10", Fee: "2", Net: "188", TaxBps: 500, HeldBlocks: 40320}
	if ev.Sold == nil || *ev.Sold != want {
		t.Fatalf("got %+v want %+v", ev.Sold, want)
	}
}

// TestParseEvent_Retired pins ../contract/main.go's hand-built `retired` log
// (verified directly against main.go's `retire` entrypoint — it really does
// emit this, with no "v" field, unlike every core/events.go Ev* constructor).
func TestParseEvent_Retired(t *testing.T) {
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"retired","creator":"alice","actor":"alice","block":1300}`})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ev.Kind != KindRetired || ev.Unknown {
		t.Fatalf("wrong kind/unknown: %+v", ev)
	}
	want := RetiredEvent{Creator: "alice", Actor: "alice", Block: 1300}
	if ev.Retired == nil || *ev.Retired != want {
		t.Fatalf("got %+v want %+v", ev.Retired, want)
	}
}

// TestParseEvent_TreasuryWithdrawn pins ../contract/main.go's hand-built
// `treasuryWithdrawn` log (the `withdrawTreasury` entrypoint) — DEFECT FIX,
// this event kind did not exist in this package before: every real
// "treasuryWithdrawn" log line fell to Unknown=true, and — more importantly —
// index.go's Index.TreasuryHbd() had no debit path at all, so it could only
// ever grow.
func TestParseEvent_TreasuryWithdrawn(t *testing.T) {
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"treasuryWithdrawn","actor":"ownerbot","amount":"5000","block":1400}`})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ev.Kind != KindTreasuryWithdrawn || ev.Unknown {
		t.Fatalf("wrong kind/unknown: %+v", ev)
	}
	want := TreasuryWithdrawnEvent{Actor: "ownerbot", Block: 1400, Amount: "5000"}
	if ev.TreasuryWithdrawn == nil || *ev.TreasuryWithdrawn != want {
		t.Fatalf("got %+v want %+v", ev.TreasuryWithdrawn, want)
	}
}

// TestParseEvent_TradeFeesClaimed pins ../contract/main.go's hand-built
// `tradeFeesClaimed` log (the `claimTradeFees` entrypoint) — same class of
// DEFECT FIX as TreasuryWithdrawn above.
func TestParseEvent_TradeFeesClaimed(t *testing.T) {
	ev, err := ParseEvent(RawEvent{Data: `{"ev":"tradeFeesClaimed","actor":"carol","amount":"250","block":1500}`})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ev.Kind != KindTradeFeesClaimed || ev.Unknown {
		t.Fatalf("wrong kind/unknown: %+v", ev)
	}
	want := TradeFeesClaimedEvent{Actor: "carol", Block: 1500, Amount: "250"}
	if ev.TradeFeesClaimed == nil || *ev.TradeFeesClaimed != want {
		t.Fatalf("got %+v want %+v", ev.TradeFeesClaimed, want)
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

// TestParseEvent_PausedAndUnpausedAreDeliberatelyUnknown pins the OTHER two
// contract-only hand-built logs named in events.go's own file doc as
// deliberately unrecognized (alongside "init" above): the `pause`/`unpause`
// entrypoints' global inbound-switch logs. Before this test existed, nothing
// proved these two were a DELIBERATE decision rather than an accidental gap —
// see events.go's top-of-file doc for the justification (a global, not
// per-market, switch with no query surface in this package depending on it).
func TestParseEvent_PausedAndUnpausedAreDeliberatelyUnknown(t *testing.T) {
	for _, evName := range []string{"paused", "unpaused"} {
		ev, err := ParseEvent(RawEvent{Data: `{"ev":"` + evName + `","actor":"ownerbot"}`})
		if err != nil {
			t.Fatalf("%s: unknown ev must not be an error, got: %v", evName, err)
		}
		if !ev.Unknown {
			t.Fatalf("%s: expected Unknown=true, got %+v", evName, ev)
		}
		if ev.Kind != EventKind(evName) {
			t.Fatalf("%s: expected Kind to carry the raw ev string, got %q", evName, ev.Kind)
		}
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
	// A compact sweep proving every one of the ORIGINAL twelve EventKind
	// constants parses to Unknown=false and populates exactly its own typed
	// field — a regression guard against a future rename of an EventKind
	// constant drifting silently out of sync with its switch case in
	// ParseEvent. See TestParseEvent_EveryDeclaredKindRoundTrips below for the
	// full, self-verifying sweep over EVERY kind this package recognizes
	// today (this package has grown well past twelve since this test was
	// written; kept as-is rather than renamed, so as not to disturb a passing
	// test's identity, and superseded in COVERAGE by the test below).
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
		{KindReclaimed, `{"ev":"reclaimed","v":1,"creator":"c","actor":"a","block":1,"seq":1,"credits":"1","commissionHbd":"1","asker":"a"}`},
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

// TestParseEvent_EveryDeclaredKindRoundTrips is the full-coverage,
// self-verifying sibling of the test above — it does NOT hand-copy the list
// of kinds to sweep. Instead it regex-scans THIS PACKAGE's own events.go
// source for every `Kind... EventKind = "..."` declaration (the same
// anti-drift technique core/schema_contract_test.go's
// TestSchemaContract_EveryConstructorIsPinned uses, for the identical
// reason: a hand-copied list sitting next to the real declarations can go
// stale the moment a new Kind constant is added and nobody updates the
// nearby list — see this audit's own finding that offeringCreated/Updated/
// Deleted were declared AND correctly parsed by ParseEvent for a full day
// while index.go's fold silently did nothing with them; a parse-side sweep
// like this one would not have caught THAT specific gap, but it closes the
// sibling risk of a Kind constant existing without ANY round-trip proof at
// all, which is what let `bought`/`sold`/`declined` ship unpinned before).
//
// samples below is the one place this test allows a hand-maintained
// list — pairing each declared kind with a realistic, well-formed JSON
// fixture — but the test FAILS if that list and the real declarations ever
// disagree in EITHER direction: a declared kind with no sample (coverage
// gap) or a sample naming a kind events.go no longer declares (a stale
// fixture nobody deleted).
func TestParseEvent_EveryDeclaredKindRoundTrips(t *testing.T) {
	src, err := os.ReadFile("events.go")
	if err != nil {
		t.Fatalf("cannot read events.go to enumerate Kind constants: %v", err)
	}
	declared := map[string]bool{}
	for _, m := range regexp.MustCompile(`Kind\w+\s+EventKind\s*=\s*"([a-zA-Z]+)"`).FindAllStringSubmatch(string(src), -1) {
		declared[m[1]] = true
	}
	if len(declared) == 0 {
		t.Fatal("found no EventKind constant declarations in events.go — this test's own premise is broken, fix it rather than deleting it")
	}

	samples := map[string]string{
		"registered":        `{"ev":"registered","v":1,"creator":"c","actor":"a","block":1,"face":"1","cap":"1","feePaid":"1"}`,
		"renewed":           `{"ev":"renewed","v":1,"creator":"c","actor":"a","block":1,"periods":1,"paid":"1"}`,
		"faceChanged":       `{"ev":"faceChanged","v":1,"creator":"c","actor":"a","block":1,"oldFace":"1","newFace":"2"}`,
		"capChanged":        `{"ev":"capChanged","v":1,"creator":"c","actor":"a","block":1,"oldCap":"1","newCap":"2"}`,
		"prepaid":           `{"ev":"prepaid","v":1,"creator":"c","actor":"a","block":1,"hbdPaid":"1","creditsMinted":"1"}`,
		"transferred":       `{"ev":"transferred","v":1,"creator":"c","actor":"a","block":1,"to":"b","amount":"1"}`,
		"asked":             `{"ev":"asked","v":1,"creator":"c","actor":"a","block":1,"seq":1,"creditsSpent":"1","commissionHbd":"1","rate":"1","deadlineBlocks":1,"offeringId":0,"contentHash":"h"}`,
		"answered":          `{"ev":"answered","v":1,"creator":"c","actor":"a","block":1,"seq":1,"creditsToCreator":"1","commissionHbd":"1","answerHash":"h"}`,
		"reclaimed":         `{"ev":"reclaimed","v":1,"creator":"c","actor":"a","block":1,"seq":1,"credits":"1","commissionHbd":"1","asker":"a"}`,
		"declined":          `{"ev":"declined","v":1,"creator":"c","actor":"c","block":1,"seq":1,"credits":"1","commissionHbd":"1","asker":"a"}`,
		"refunded":          `{"ev":"refunded","v":1,"creator":"c","actor":"a","block":1,"credits":"1","payout":"1"}`,
		"refundPushed":      `{"ev":"refundPushed","v":1,"creator":"c","actor":"a","block":1,"holder":"h","creditsBurned":"1","payout":"1"}`,
		"closed":            `{"ev":"closed","v":1,"creator":"c","actor":"a","block":1}`,
		"bought":            `{"ev":"bought","v":1,"creator":"c","actor":"a","block":1,"minted":"1","cost":"1","fee":"1","totalDue":"1"}`,
		"sold":              `{"ev":"sold","v":1,"creator":"c","actor":"a","block":1,"sold":"1","gross":"1","tax":"1","fee":"1","net":"1","taxBps":1,"heldBlocks":1}`,
		"offeringCreated":   `{"ev":"offeringCreated","v":1,"creator":"c","actor":"c","block":1,"offeringId":1,"title":"t","price":"1"}`,
		"offeringUpdated":   `{"ev":"offeringUpdated","v":1,"creator":"c","actor":"c","block":1,"offeringId":1,"title":"t","oldPrice":"1","newPrice":"2"}`,
		"offeringDeleted":   `{"ev":"offeringDeleted","v":1,"creator":"c","actor":"c","block":1,"offeringId":1}`,
		"retired":           `{"ev":"retired","creator":"c","actor":"c","block":1}`,
		"treasuryWithdrawn": `{"ev":"treasuryWithdrawn","actor":"owner","amount":"1","block":1}`,
		"tradeFeesClaimed":  `{"ev":"tradeFeesClaimed","actor":"c","amount":"1","block":1}`,
	}

	for kind := range declared {
		if _, ok := samples[kind]; !ok {
			t.Errorf("EventKind %q is declared in events.go but has no round-trip sample in this test's `samples` map — add one, and prove ParseEvent recognizes it (Unknown=false)", kind)
		}
	}
	for kind := range samples {
		if !declared[kind] {
			t.Errorf("this test's `samples` map has an entry for %q, but events.go declares no matching Kind constant — stale fixture, remove it", kind)
		}
	}

	for kind, data := range samples {
		ev, err := ParseEvent(RawEvent{Data: data})
		if err != nil {
			t.Errorf("%s: unexpected error: %v", kind, err)
			continue
		}
		if ev.Unknown {
			t.Errorf("%s: Unknown=true, want false — ParseEvent does not recognize this declared Kind", kind)
		}
		if string(ev.Kind) != kind {
			t.Errorf("%s: Kind = %q, want %q", kind, ev.Kind, kind)
		}
	}
}
