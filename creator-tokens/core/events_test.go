package core

import (
	"encoding/json"
	"math/big"
	"os"
	"strings"
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
	out := EvAsked("creator1", evil, 10, 1, big.NewInt(5), big.NewInt(1), big.NewInt(1000), 28800, "hash1", 0)
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
	out := EvAsked("alice", "bob", 600, 7, big.NewInt(42), big.NewInt(1200), big.NewInt(1_000_000), 28800, "abc123hash", 3)
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
	out := EvReclaimed("alice", "bob", 800, 7, big.NewInt(42), big.NewInt(504), "carol")
	m := decode(t, out)
	wantStr(t, m, "ev", "reclaimed")
	wantStr(t, m, "actor", "bob")
	wantNum(t, m, "seq", 7)
	wantStr(t, m, "credits", "42")
	wantStr(t, m, "commissionHbd", "504")
}

func TestEvReclaimed_NilCommissionRendersZero(t *testing.T) {
	out := EvReclaimed("alice", "bob", 800, 7, big.NewInt(42), nil, "carol")
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
		{"asked", EvAsked("c", "a", 1, 1, big.NewInt(1), big.NewInt(1), big.NewInt(1), 1, "h", 0), []string{"creditsSpent", "commissionHbd", "rate"}},
		{"answered", EvAnswered("c", "a", 1, 1, big.NewInt(1), big.NewInt(1), "h"), []string{"creditsToCreator", "commissionHbd"}},
		{"reclaimed", EvReclaimed("c", "a", 1, 1, big.NewInt(1), big.NewInt(1), "k"), []string{"credits", "commissionHbd"}},
		{"refunded", EvRefunded("c", "a", 1, big.NewInt(1), big.NewInt(1)), []string{"credits", "payout"}},
		{"refundPushed", EvRefundPushed("c", "a", "h", 1, big.NewInt(1), big.NewInt(1)), []string{"creditsBurned", "payout"}},
		// Added 2026-07-28: this table covered 11 of the 24 constructors, and
		// every event added since (declined, the bought/sold curve pair, the
		// offering catalogue, the two treasury/fee payouts) carries money it
		// was not checking. bought/sold matter most — they are the curve's
		// only issuance and redemption path, and they already shipped
		// unrecognised by the indexer once.
		{"declined", EvDeclined("c", "a", 1, 1, big.NewInt(1), big.NewInt(1), "k"), []string{"credits", "commissionHbd"}},
		{"bought", EvBought("c", "a", 1, big.NewInt(1), big.NewInt(1), big.NewInt(1), big.NewInt(1)), []string{"minted", "cost", "fee", "totalDue"}},
		{"sold", EvSold("c", "a", 1, big.NewInt(1), big.NewInt(1), big.NewInt(1), big.NewInt(1), big.NewInt(1), 1, 1), []string{"sold", "gross", "tax", "fee", "net"}},
		{"offeringCreated", EvOfferingCreated("c", "a", 1, 1, "t", big.NewInt(1)), []string{"price"}},
		{"offeringUpdated", EvOfferingUpdated("c", "a", 1, 1, "t", big.NewInt(1), big.NewInt(2)), []string{"oldPrice", "newPrice"}},
		{"treasuryWithdrawn", EvTreasuryWithdrawn("a", 1, big.NewInt(1)), []string{"amount"}},
		{"tradeFeesClaimed", EvTradeFeesClaimed("a", 1, big.NewInt(1)), []string{"amount"}},
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
	out := EvAsked("c", "a", 42, 7, big.NewInt(1), big.NewInt(1), big.NewInt(1), 28800, "h", 0)
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

// ---------------------------------------------------------------------------
// GAP 2 closure (2026-07-28): Register's atomic first buy must also log a
// `bought` event, not just `registered`.
//
// contract/main.go's `register` entrypoint supports an atomic first buy
// (RegisterWithFirstBuy, result field res.FirstBuy). Real money and real
// tokens move on that path — RegisterWithFirstBuy calls Buy internally,
// which mutates kReserve, kFeeBal(creator) and kBal(creator,creator)
// (buy.go) — but before this fix only EvRegistered was ever logged for it,
// so a creator's own initial holding was invisible to any indexer forever,
// and the indexer's balance for that creator was wrong from the first block.
//
// NON-VACUOUSNESS / WHAT THIS TEST CAN AND CANNOT PROVE: contract/main.go
// cannot be compiled or executed by plain `go test` under any configuration
// (verified directly — see that file's own TESTING NOTE: it unconditionally
// imports creator-tokens/sdk, which requires TinyGo-only compiler
// intrinsics), so no test anywhere in this repo can invoke Register's actual
// wasm entrypoint body and observe its real sdk.Log calls. What CAN be tested
// from here — and what these two tests do — is every piece of DATA that
// entrypoint's fix depends on: that RegisterWithFirstBuy's own res.FirstBuy
// is non-nil exactly when a first buy actually happened (nil for a plain
// registration, nil for firstBuy==0, non-nil and holding the CORRECT amounts
// for a real one), and that mapping those fields into EvBought — the exact
// mapping contract/main.go's Register now performs — produces the
// mathematically correct wire values. A bug in either of those (the
// firstBuy-happened signal, or the field mapping) would fail one of the two
// tests below; the wasm wrapper's actual `if res.FirstBuy != nil { ... }`
// gate around the second sdk.Log call was verified separately by direct
// source read (contract/main.go's Register, immediately after the
// EvRegistered log) to mirror this exactly, field for field, in this order:
// creator, actor, block, res.FirstBuy.Minted, res.FirstBuy.Cost,
// res.FirstBuy.Fee, res.FirstBuy.TotalDue.
// ---------------------------------------------------------------------------

func TestRegisterWithFirstBuy_FirstBuyResultDrivesBothEvents(t *testing.T) {
	s := NewMemStore()
	res, err := RegisterWithFirstBuy(s, "aliceperry", "aliceperry", 100, 5000, 1_000_000, big.NewInt(100))
	if err != nil {
		t.Fatalf("RegisterWithFirstBuy: %v", err)
	}
	if res.FirstBuy == nil {
		t.Fatal("res.FirstBuy is nil for a registration with firstBuy=100 — the wrapper's `if res.FirstBuy != nil` gate would then wrongly skip EvBought entirely")
	}

	// The registered event: feePaid is always zero, first buy or not
	// (registration is free — market.go).
	regOut := EvRegistered("aliceperry", "aliceperry", 100, 5000, 1_000_000, big.NewInt(0))
	regM := decode(t, regOut)
	wantStr(t, regM, "ev", "registered")
	wantStr(t, regM, "feePaid", "0")

	// The bought event the wrapper's fix now also logs, built the exact way
	// contract/main.go's Register does: straight off res.FirstBuy's fields,
	// never re-derived.
	boughtOut := EvBought("aliceperry", "aliceperry", 100, res.FirstBuy.Minted, res.FirstBuy.Cost, res.FirstBuy.Fee, res.FirstBuy.TotalDue)
	boughtM := decode(t, boughtOut)
	wantStr(t, boughtM, "ev", "bought")
	wantStr(t, boughtM, "creator", "aliceperry")
	wantStr(t, boughtM, "actor", "aliceperry") // the creator buys their own first slice
	wantNum(t, boughtM, "block", 100)
	wantStr(t, boughtM, "minted", "100") // == the firstBuy argument, exactly

	// Cross-check res.FirstBuy's amounts against the SAME curve math buy.go's
	// buyCompute uses for an ordinary Buy of 100 tokens from a fresh (S=0)
	// market — proving cost/fee/totalDue are not just "present" but the
	// numerically correct values a real Buy of this size would have produced
	// (do not guess which field is cost vs fee vs totalDue — read buy.go).
	wantCost := BuyCost(mZero(), big.NewInt(100))
	wantFee, _, _ := tradeFeeOn(wantCost)
	wantTotalDue := mAdd(wantCost, wantFee)
	wantStr(t, boughtM, "cost", wantCost.String())
	wantStr(t, boughtM, "fee", wantFee.String())
	wantStr(t, boughtM, "totalDue", wantTotalDue.String())
	if res.TotalDue.Cmp(wantTotalDue) != 0 {
		t.Fatalf("RegisterResult.TotalDue = %s, want %s (the single HiveDraw amount the wrapper draws)", res.TotalDue, wantTotalDue)
	}
}

func TestRegisterWithFirstBuy_PlainRegistration_FirstBuyResultIsNil(t *testing.T) {
	// firstBuy nil: the OPTIONAL, default case — a plain registration. The
	// wrapper's `if res.FirstBuy != nil` gate must stay CLOSED here, so only
	// EvRegistered would ever be logged.
	s := NewMemStore()
	res, err := RegisterWithFirstBuy(s, "bobcreator", "bobcreator", 100, 5000, 1_000_000, nil)
	if err != nil {
		t.Fatalf("RegisterWithFirstBuy: %v", err)
	}
	if res.FirstBuy != nil {
		t.Fatalf("res.FirstBuy = %+v, want nil for firstBuy=nil (a plain registration must never emit a bought event)", res.FirstBuy)
	}
	if res.TotalDue == nil || res.TotalDue.Sign() != 0 {
		t.Fatalf("res.TotalDue = %v, want exactly 0 for a plain registration (nothing to draw)", res.TotalDue)
	}

	// Same assertion with firstBuy explicitly zero rather than nil —
	// RegisterWithFirstBuy's own doc (launchBuyCheck: "firstBuy == nil ||
	// firstBuy.Sign() == 0") treats the two as the identical plain-
	// registration case, so the gate must stay closed for zero too, not just
	// for nil.
	s2 := NewMemStore()
	res2, err := RegisterWithFirstBuy(s2, "carolcreator", "carolcreator", 100, 5000, 1_000_000, big.NewInt(0))
	if err != nil {
		t.Fatalf("RegisterWithFirstBuy(firstBuy=0): %v", err)
	}
	if res2.FirstBuy != nil {
		t.Fatalf("res.FirstBuy = %+v, want nil for firstBuy=0 (must be treated identically to nil, not as a 0-token buy)", res2.FirstBuy)
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
		EvAsked("c", "a", 1, 1, big.NewInt(1), big.NewInt(1), big.NewInt(1), 1, "h", 0),
		EvAnswered("c", "a", 1, 1, big.NewInt(1), big.NewInt(1), "h"),
		EvReclaimed("c", "a", 1, 1, big.NewInt(1), big.NewInt(1), "k"),
		EvRefunded("c", "a", 1, big.NewInt(1), big.NewInt(1)),
		EvRefundPushed("c", "a", "h", 1, big.NewInt(1), big.NewInt(1)),
		EvClosed("c", "a", 1),
		// Added 2026-07-28 — the sweep named itself "AcrossAllEvents" while
		// covering 12 of 24. The envelope is shared by three different
		// builders now (evOpen, evOpenActor, and EvInit's inline literal), so
		// "all events carry v:1" is a claim about all three, not just evOpen.
		EvDeclined("c", "a", 1, 1, big.NewInt(1), big.NewInt(1), "k"),
		EvBought("c", "a", 1, big.NewInt(1), big.NewInt(1), big.NewInt(1), big.NewInt(1)),
		EvSold("c", "a", 1, big.NewInt(1), big.NewInt(1), big.NewInt(1), big.NewInt(1), big.NewInt(1), 1, 1),
		EvOfferingCreated("c", "a", 1, 1, "t", big.NewInt(1)),
		EvOfferingUpdated("c", "a", 1, 1, "t", big.NewInt(1), big.NewInt(2)),
		EvOfferingDeleted("c", "a", 1, 1),
		EvRetired("c", "a", 1),
		EvTreasuryWithdrawn("a", 1, big.NewInt(1)),
		EvTradeFeesClaimed("a", 1, big.NewInt(1)),
		EvInit("owner"),
		EvPaused("a"),
		EvUnpaused("a"),
	}
	if len(outs) != 24 {
		t.Fatalf("this sweep must cover EVERY constructor in events.go; it has %d and there are 24. Add the missing one rather than leaving the name a lie.", len(outs))
	}
	for _, out := range outs {
		m := decode(t, out)
		wantNum(t, m, "v", 1)
	}
}

// TestRegisterWithFirstBuy_BoughtEventIsActuallyWiredInTheWrapper closes the
// gap an adversarial review found in the two tests above: they call
// EvRegistered/EvBought DIRECTLY, so deleting the sdk.Log(core.EvBought(...))
// line from ../contract/main.go's `register` entrypoint leaves every test in
// this repo green while re-opening the exact defect they were written for —
// a creator's own launch holding invisible to the indexer forever.
//
// ../contract/ cannot be compiled by the native toolchain (it imports the
// TinyGo-only sdk), so a source-presence check is the only guard available.
// Same idiom as fixround1_test.go's TestContract_OUTFLOW1_* .
func TestRegisterWithFirstBuy_BoughtEventIsActuallyWiredInTheWrapper(t *testing.T) {
	src, err := os.ReadFile("../contract/main.go")
	if err != nil {
		t.Fatalf("read contract/main.go: %v", err)
	}
	text := string(src)

	ri := strings.Index(text, "//go:wasmexport register")
	if ri < 0 {
		t.Fatal("contract/main.go has no //go:wasmexport register — this test's premise is broken, fix it rather than deleting it")
	}
	region := text[ri:]
	if end := strings.Index(region[1:], "//go:wasmexport"); end >= 0 {
		region = region[:end+1]
	}

	if !strings.Contains(region, "res.FirstBuy != nil") {
		t.Fatal("GAP-2 REGRESSION: register no longer gates on res.FirstBuy != nil — a plain registration would emit a bogus `bought` event, or the first buy is no longer detected at all")
	}
	if !strings.Contains(region, "core.EvBought(caller, caller, block, res.FirstBuy.Minted,") {
		t.Fatal("GAP-2 REGRESSION: register's atomic first buy no longer logs core.EvBought from res.FirstBuy — real money and real tokens move (kReserve, kFeeBal, kBal all mutate in buy.go) but no `bought` event is emitted, so the creator's own launch holding is invisible to the indexer from the first block and its balance for that creator is wrong forever")
	}
	// Ordering: the registration event must precede the buy event, so a
	// consumer folding them in log order sees the market exist before tokens
	// are minted into it.
	regAt := strings.Index(region, "core.EvRegistered(")
	buyAt := strings.Index(region, "core.EvBought(")
	if regAt < 0 || buyAt < 0 || regAt > buyAt {
		t.Fatal("GAP-2 REGRESSION: register must log EvRegistered BEFORE EvBought — an indexer folding in order would otherwise mint into a market it has not seen created")
	}
}
