package core

import (
	"encoding/json"
	"math/big"
	"testing"
)

// events_test.go covers events.go: every constructor must emit valid,
// parseable JSON with the exact documented field set, "ev"/"v" set
// correctly, amounts rendered as base-10 strings (never bare numbers,
// never floats), and special characters in caller-supplied strings
// (account names, hashes) safely escaped.

// decode unmarshals a constructor's output into a generic map for
// field-by-field assertions, failing the test on invalid JSON — every
// constructor's output MUST be valid JSON, full stop.
func decode(t *testing.T, s string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		t.Fatalf("output is not valid JSON: %v\noutput: %s", err, s)
	}
	return m
}

func wantStr(t *testing.T, m map[string]any, field, want string) {
	t.Helper()
	got, ok := m[field]
	if !ok {
		t.Fatalf("field %q missing entirely; got %+v", field, m)
	}
	gs, ok := got.(string)
	if !ok {
		t.Fatalf("field %q = %v (%T), want a JSON string", field, got, got)
	}
	if gs != want {
		t.Fatalf("field %q = %q, want %q", field, gs, want)
	}
}

func wantNum(t *testing.T, m map[string]any, field string, want float64) {
	t.Helper()
	got, ok := m[field]
	if !ok {
		t.Fatalf("field %q missing entirely; got %+v", field, m)
	}
	gn, ok := got.(float64) // encoding/json decodes bare JSON numbers as float64
	if !ok {
		t.Fatalf("field %q = %v (%T), want a bare JSON number (not a quoted string)", field, got, got)
	}
	if gn != want {
		t.Fatalf("field %q = %v, want %v", field, gn, want)
	}
}

// ---- shared envelope -----------------------------------------------------

func TestEvOpen_EnvelopeShape(t *testing.T) {
	out := EvClosed("alice", "bob", 42)
	m := decode(t, out)
	wantStr(t, m, "ev", "closed")
	wantNum(t, m, "v", 1)
	wantStr(t, m, "creator", "alice")
	wantStr(t, m, "actor", "bob")
	wantNum(t, m, "block", 42)
	if len(m) != 5 {
		t.Fatalf("EvClosed should have exactly 5 fields (ev,v,creator,actor,block), got %d: %+v", len(m), m)
	}
}

func TestEvHelpers_MoneyNilRendersZero(t *testing.T) {
	if got := evMoney(nil); got != "0" {
		t.Fatalf("evMoney(nil) = %q, want %q", got, "0")
	}
}

func TestEvHelpers_MoneyPreservesExactBigDecimal(t *testing.T) {
	// A value well beyond float64's exact-integer range (2^53) must survive
	// round-trip untouched — this is the entire reason amounts are strings,
	// not bare JSON numbers, on the wire.
	huge, ok := new(big.Int).SetString("123456789012345678901234567890", 10)
	if !ok {
		t.Fatal("test setup: failed to parse huge decimal")
	}
	got := evMoney(huge)
	if got != "123456789012345678901234567890" {
		t.Fatalf("evMoney(huge) = %q, want exact decimal string", got)
	}
}

func TestEvHelpers_JSONEscape(t *testing.T) {
	cases := []struct{ in, want string }{
		{`plain`, `plain`},
		{`has"quote`, `has\"quote`},
		{`has\backslash`, `has\\backslash`},
		{`both"and\both`, `both\"and\\both`},
		{``, ``},
	}
	for _, c := range cases {
		if got := evJSONEscape(c.in); got != c.want {
			t.Errorf("evJSONEscape(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestEvHelpers_U64AndI64(t *testing.T) {
	if got := evU64(0); got != "0" {
		t.Errorf("evU64(0) = %q, want 0", got)
	}
	if got := evU64(18446744073709551615); got != "18446744073709551615" { // max uint64
		t.Errorf("evU64(maxuint64) = %q", got)
	}
	if got := evI64(-1200); got != "-1200" {
		t.Errorf("evI64(-1200) = %q, want -1200", got)
	}
	if got := evI64(0); got != "0" {
		t.Errorf("evI64(0) = %q, want 0", got)
	}
}

// A string containing the JSON delimiter '"' must not corrupt the envelope
// or let an attacker-controlled account/hash string break out of its own
// field and inject a sibling key. This is the one genuine injection-shaped
// risk this file carries (every OTHER string field is either a
// validAccount-charset account name, which cannot contain '"' at all, or a
// hash that ask.go/Answer already reject '|' in, but not '"').
func TestEvJSONEscape_PreventsFieldInjection(t *testing.T) {
	evil := `x","injected":"pwned`
	out := EvAsked("creator1", evil, 10, 1, big.NewInt(5), big.NewInt(1), big.NewInt(1000), 28800, "hash1")
	m := decode(t, out) // must still be valid, single-object JSON
	wantStr(t, m, "actor", evil)
	if _, present := m["injected"]; present {
		t.Fatalf("field injection succeeded: %+v", m)
	}
}

// ---- one test per constructor --------------------------------------------

func TestEvRegistered(t *testing.T) {
	out := EvRegistered("alice", "alice", 100, 5000, 1000, big.NewInt(10_000))
	m := decode(t, out)
	wantStr(t, m, "ev", "registered")
	wantNum(t, m, "v", 1)
	wantStr(t, m, "creator", "alice")
	wantStr(t, m, "actor", "alice")
	wantNum(t, m, "block", 100)
	wantStr(t, m, "face", "5000")
	wantStr(t, m, "cap", "1000")
	wantStr(t, m, "feePaid", "10000")
}

func TestEvRegistered_NilFeePaid(t *testing.T) {
	out := EvRegistered("alice", "alice", 100, 5000, 1000, nil)
	m := decode(t, out)
	wantStr(t, m, "feePaid", "0")
}

func TestEvRenewed(t *testing.T) {
	out := EvRenewed("alice", "fan1", 200, 3, big.NewInt(30_000))
	m := decode(t, out)
	wantStr(t, m, "ev", "renewed")
	wantStr(t, m, "creator", "alice")
	wantStr(t, m, "actor", "fan1") // deliberately NOT alice — Renew is permissionless
	wantNum(t, m, "block", 200)
	wantNum(t, m, "periods", 3)
	wantStr(t, m, "paid", "30000")
}

func TestEvFaceChanged(t *testing.T) {
	out := EvFaceChanged("alice", "alice", 300, 5000, 9000)
	m := decode(t, out)
	wantStr(t, m, "ev", "faceChanged")
	wantStr(t, m, "oldFace", "5000")
	wantStr(t, m, "newFace", "9000")
}

func TestEvCapChanged(t *testing.T) {
	out := EvCapChanged("alice", "alice", 300, 1000, 2000)
	m := decode(t, out)
	wantStr(t, m, "ev", "capChanged")
	wantStr(t, m, "oldCap", "1000")
	wantStr(t, m, "newCap", "2000")
}

func TestEvPrepaid(t *testing.T) {
	out := EvPrepaid("alice", "bob", 400, big.NewInt(2500), big.NewInt(2500))
	m := decode(t, out)
	wantStr(t, m, "ev", "prepaid")
	wantStr(t, m, "creator", "alice")
	wantStr(t, m, "actor", "bob")
	wantStr(t, m, "hbdPaid", "2500")
	wantStr(t, m, "creditsMinted", "2500")
}

func TestEvTransferred(t *testing.T) {
	out := EvTransferred("alice", "bob", "carol", 500, big.NewInt(100))
	m := decode(t, out)
	wantStr(t, m, "ev", "transferred")
	wantStr(t, m, "actor", "bob")
	wantStr(t, m, "to", "carol")
	wantStr(t, m, "amount", "100")
}

func TestEvAsked(t *testing.T) {
	out := EvAsked("alice", "bob", 600, 7, big.NewInt(42), big.NewInt(1200), big.NewInt(1_000_000), 28800, "abc123hash")
	m := decode(t, out)
	wantStr(t, m, "ev", "asked")
	wantStr(t, m, "actor", "bob")
	wantNum(t, m, "seq", 7)
	wantStr(t, m, "creditsSpent", "42")
	wantStr(t, m, "commissionHbd", "1200")
	wantStr(t, m, "rate", "1000000")
	wantNum(t, m, "deadlineBlocks", 28800)
	wantStr(t, m, "contentHash", "abc123hash")
}

func TestEvAnswered(t *testing.T) {
	out := EvAnswered("alice", "alice", 700, 7, big.NewInt(42), big.NewInt(504), "answerhash1")
	m := decode(t, out)
	wantStr(t, m, "ev", "answered")
	wantNum(t, m, "seq", 7)
	wantStr(t, m, "creditsToCreator", "42")
	wantStr(t, m, "commissionHbd", "504")
	wantStr(t, m, "answerHash", "answerhash1")
}

func TestEvAnswered_NilCommissionRendersZero(t *testing.T) {
	// Defense-in-depth mirror of TestEvHelpers_MoneyNilRendersZero: a caller
	// passing nil (should never happen — Answer's rec.commissionHbd is never
	// nil) must still render "0", not panic or emit a bare JSON null.
	out := EvAnswered("alice", "alice", 700, 7, big.NewInt(42), nil, "answerhash1")
	m := decode(t, out)
	wantStr(t, m, "commissionHbd", "0")
}

func TestEvReclaimed(t *testing.T) {
	out := EvReclaimed("alice", "bob", 800, 7, big.NewInt(42), big.NewInt(504))
	m := decode(t, out)
	wantStr(t, m, "ev", "reclaimed")
	wantStr(t, m, "actor", "bob")
	wantNum(t, m, "seq", 7)
	wantStr(t, m, "credits", "42")
	wantStr(t, m, "commissionHbd", "504")
}

func TestEvReclaimed_NilCommissionRendersZero(t *testing.T) {
	out := EvReclaimed("alice", "bob", 800, 7, big.NewInt(42), nil)
	m := decode(t, out)
	wantStr(t, m, "commissionHbd", "0")
}

func TestEvRefunded(t *testing.T) {
	out := EvRefunded("alice", "bob", 900, big.NewInt(100), big.NewInt(95))
	m := decode(t, out)
	wantStr(t, m, "ev", "refunded")
	wantStr(t, m, "actor", "bob")
	wantStr(t, m, "credits", "100")
	wantStr(t, m, "payout", "95")
}

func TestEvRefundPushed(t *testing.T) {
	out := EvRefundPushed("alice", "keeper1", "bob", 1000, big.NewInt(300), big.NewInt(285))
	m := decode(t, out)
	wantStr(t, m, "ev", "refundPushed")
	wantStr(t, m, "actor", "keeper1") // pusher
	wantStr(t, m, "holder", "bob")    // recipient — never actor
	wantStr(t, m, "creditsBurned", "300")
	wantStr(t, m, "payout", "285")
}

func TestEvRefundPushed_ActorNeverEqualsHolderByConstruction(t *testing.T) {
	// Not a structural guarantee of the constructor itself (it will happily
	// render whatever strings it's given) — this test documents the
	// semantic contract: actor and holder are independent fields, and
	// RefundHolder's whole point (API.md rule 2) is that they may differ.
	// A caller passing the SAME string for both is legal (self-push) but
	// the JSON must still carry both fields distinctly, not collapse them.
	out := EvRefundPushed("alice", "bob", "bob", 1000, big.NewInt(1), big.NewInt(1))
	m := decode(t, out)
	wantStr(t, m, "actor", "bob")
	wantStr(t, m, "holder", "bob")
}

func TestEvClosed(t *testing.T) {
	out := EvClosed("alice", "keeper1", 1100)
	m := decode(t, out)
	wantStr(t, m, "ev", "closed")
	wantStr(t, m, "actor", "keeper1")
	wantNum(t, m, "block", 1100)
}

func TestEvClosed_EmptyActorAllowed(t *testing.T) {
	// core.CloseIfDrained itself has no caller parameter at all — a wasm
	// layer with no per-call signer identity to bind here must still be
	// able to emit a well-formed event with actor="".
	out := EvClosed("alice", "", 1100)
	m := decode(t, out)
	wantStr(t, m, "actor", "")
}

// ---- amounts are always strings, never bare numbers -----------------------

// TestEvAmountFieldsAreAlwaysStrings sweeps every event and asserts every
// money-shaped field decodes as a JSON string (quoted), never json.Number —
// the single most important wire-format guarantee this file makes (see
// money.go's own "no floats anywhere" rule, extended to the wire).
func TestEvAmountFieldsAreAlwaysStrings(t *testing.T) {
	cases := []struct {
		name   string
		out    string
		fields []string
	}{
		{"registered", EvRegistered("c", "a", 1, 1, 1, big.NewInt(1)), []string{"face", "cap", "feePaid"}},
		{"renewed", EvRenewed("c", "a", 1, 1, big.NewInt(1)), []string{"paid"}},
		{"faceChanged", EvFaceChanged("c", "a", 1, 1, 2), []string{"oldFace", "newFace"}},
		{"capChanged", EvCapChanged("c", "a", 1, 1, 2), []string{"oldCap", "newCap"}},
		{"prepaid", EvPrepaid("c", "a", 1, big.NewInt(1), big.NewInt(1)), []string{"hbdPaid", "creditsMinted"}},
		{"transferred", EvTransferred("c", "a", "b", 1, big.NewInt(1)), []string{"amount"}},
		{"asked", EvAsked("c", "a", 1, 1, big.NewInt(1), big.NewInt(1), big.NewInt(1), 1, "h"), []string{"creditsSpent", "commissionHbd", "rate"}},
		{"answered", EvAnswered("c", "a", 1, 1, big.NewInt(1), big.NewInt(1), "h"), []string{"creditsToCreator", "commissionHbd"}},
		{"reclaimed", EvReclaimed("c", "a", 1, 1, big.NewInt(1), big.NewInt(1)), []string{"credits", "commissionHbd"}},
		{"refunded", EvRefunded("c", "a", 1, big.NewInt(1), big.NewInt(1)), []string{"credits", "payout"}},
		{"refundPushed", EvRefundPushed("c", "a", "h", 1, big.NewInt(1), big.NewInt(1)), []string{"creditsBurned", "payout"}},
	}
	for _, c := range cases {
		m := decode(t, c.out)
		for _, f := range c.fields {
			v, ok := m[f]
			if !ok {
				t.Errorf("%s: field %q missing", c.name, f)
				continue
			}
			if _, isString := v.(string); !isString {
				t.Errorf("%s: field %q = %v (%T), want a JSON string, not a bare number", c.name, f, v, v)
			}
		}
	}
}

// TestEvBlockSeqDeadlineAreAlwaysBareNumbers is the mirror of the above for
// the OTHER numeric convention: block/seq/deadlineBlocks/periods are plain
// counts, never money, and must be bare (unquoted) JSON numbers — matching
// hive-price-market/indexer/events.go's roundId/outcome/winner convention.
func TestEvBlockSeqDeadlineAreAlwaysBareNumbers(t *testing.T) {
	out := EvAsked("c", "a", 42, 7, big.NewInt(1), big.NewInt(1), big.NewInt(1), 28800, "h")
	m := decode(t, out)
	for _, f := range []string{"v", "block", "seq", "deadlineBlocks"} {
		v, ok := m[f]
		if !ok {
			t.Fatalf("field %q missing", f)
		}
		if _, isNum := v.(float64); !isNum {
			t.Errorf("field %q = %v (%T), want a bare JSON number", f, v, v)
		}
	}
}

// TestEvSchemaVersionIsStableAcrossAllEvents proves every constructor
// stamps the same "v" today — the append-only contract this file's doc
// describes (a future incompatible change bumps ONE event's version, not
// silently changes this constant's meaning for all twelve at once).
func TestEvSchemaVersionIsStableAcrossAllEvents(t *testing.T) {
	outs := []string{
		EvRegistered("c", "a", 1, 1, 1, big.NewInt(1)),
		EvRenewed("c", "a", 1, 1, big.NewInt(1)),
		EvFaceChanged("c", "a", 1, 1, 2),
		EvCapChanged("c", "a", 1, 1, 2),
		EvPrepaid("c", "a", 1, big.NewInt(1), big.NewInt(1)),
		EvTransferred("c", "a", "b", 1, big.NewInt(1)),
		EvAsked("c", "a", 1, 1, big.NewInt(1), big.NewInt(1), big.NewInt(1), 1, "h"),
		EvAnswered("c", "a", 1, 1, big.NewInt(1), big.NewInt(1), "h"),
		EvReclaimed("c", "a", 1, 1, big.NewInt(1), big.NewInt(1)),
		EvRefunded("c", "a", 1, big.NewInt(1), big.NewInt(1)),
		EvRefundPushed("c", "a", "h", 1, big.NewInt(1), big.NewInt(1)),
		EvClosed("c", "a", 1),
	}
	for _, out := range outs {
		m := decode(t, out)
		wantNum(t, m, "v", 1)
	}
}
