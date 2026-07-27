package core

import (
	"math/big"
	"sort"
	"testing"
)

// schema_contract_test.go — GAP 2 closure (mutation-testing audit,
// 2026-07-20).
//
// core/events.go BUILDS the wire JSON (twelve Ev* constructors);
// ../indexer/events.go PARSES it back (ParseEvent + twelve typed *Event
// structs). Nothing before this file ever piped a real core.Ev*() output
// into the indexer's decoder — the two sides agree only by a
// human-maintained comment (core/events.go's own file doc, the "Twelve
// events" table around line 45). A field rename on EITHER side breaks the
// delivery record silently: it does not panic and does not surface as an
// obvious error.
//
// THE EXACT FAILURE MODE THIS FILE GUARDS AGAINST (verified by reading both
// sides, not assumed): indexer/index.go's foldKnownEventLocked calls
// parseAmount on every money-shaped field of a known event kind and returns
// false — without applying ANY of that event's effects — if even ONE
// documented field fails to parse as a non-negative base-10 decimal
// (index.go:240-251's own comment: "deliberately not just the ones this
// fold happens to use arithmetically"). If core renamed, say, AskedEvent's
// "creditsSpent" field, indexer/events.go's AskedEvent.CreditsSpent
// (json:"creditsSpent") would silently decode to "" (Go's json package
// leaves an unmatched struct field at its zero value; it does NOT error),
// parseAmount("") fails closed (money.go's own convention), and
// foldKnownEventLocked returns false for that call — index.go's Ingest then
// counts the ENTIRE "asked" event in Stats.Malformed and discards it: no
// balance debit, no escrow entry, and the ask never appears in
// DeliveryHistory/DeliveryRecord. SPEC-CREATOR-KEYS.md §2.1.A.2 names the
// delivery record "the primary number on screen ... cannot be gamed by
// posting frequency alone" — silently dropping asks from it is exactly the
// kind of drift that must be caught in CI, not discovered live.
//
// core must not import indexer — events.go's own hard rule ("no imports
// beyond stdlib") exists precisely so this package can compile to wasm
// without pulling in indexer's dependency tree. So this file cannot call
// indexer.ParseEvent directly and get a real cross-package proof. Instead
// it hardcodes indexer's CURRENT field set — name, JSON type, and the exact
// indexer/events.go struct + line it mirrors — and checks every Ev*()
// constructor's real output against that hardcoded shape, field by field,
// with an exact field-count check so neither an added nor a removed field
// goes unnoticed. This is the strongest contract check available from this
// side of the import boundary:
//   - A core-side rename, type change, or dropped field is caught
//     IMMEDIATELY — this test lives in core and runs on every
//     `go test ./core/...`.
//   - The indexer/events.go file:line comment attached to every single
//     field check is what a maintainer changing THAT file's structs must
//     grep for and update here in lockstep — turning the "human-maintained
//     comment" this file doc criticizes into a human-maintained, but
//     test-enforced-on-one-side, cross-reference.
//
// Two JSON-type conventions enforced throughout, matching events.go's own
// documented rules (evMoney's doc, money.go's "no floats anywhere" extended
// to the wire) and indexer's own field types:
//   - MONEY fields are always a quoted JSON string, matching indexer's
//     `string`-typed struct fields. A bare JSON number here would still be
//     valid JSON but would make indexer's own json.Unmarshal FAIL for that
//     struct (Go refuses to decode a JSON number into a Go string field) —
//     this is not a style preference, it is the exact wire contract.
//   - COUNT fields (block, seq, periods, deadlineBlocks) are always a bare
//     JSON number, matching indexer's `uint64`-typed struct fields. A
//     quoted string here would identically break indexer's decode.

// scDecode parses one Ev*() constructor's output into a generic map for
// field-by-field assertions — every constructor's output MUST be valid
// JSON, full stop (mirrors events_test.go's own `decode` helper, redeclared
// here under an `sc`-prefixed name per this package's per-file naming
// convention so it cannot collide with events_test.go's `decode`... except
// it is the SAME check, so this file calls straight through to avoid a
// pointless duplicate implementation of json.Unmarshal error handling).
func scDecode(t *testing.T, out string) map[string]any {
	t.Helper()
	return decode(t, out)
}

// scFieldNames returns m's keys, sorted, for a readable failure message.
func scFieldNames(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// scWantStr asserts field is present, decodes as a JSON STRING (the shape
// indexer's string-typed struct field with a json:"..." tag requires — see
// indexerRef), and equals want exactly. A bare-number encoding here is exactly the
// defect class this file exists to catch: it would make indexer's own
// json.Unmarshal fail outright for the containing struct.
func scWantStr(t *testing.T, evName string, m map[string]any, field, want, indexerRef string) {
	t.Helper()
	v, ok := m[field]
	if !ok {
		t.Fatalf("%s: field %q is MISSING from core's JSON output (got fields %v). indexer's %s reads this field as a string — either core/events.go dropped/renamed it, or %s is stale. Fix whichever side is wrong.",
			evName, field, scFieldNames(m), indexerRef, indexerRef)
	}
	gs, ok := v.(string)
	if !ok {
		t.Fatalf("%s: field %q = %v (%T) — want a QUOTED JSON STRING to match indexer's %s (`%s string`). A bare number here would make indexer's json.Unmarshal FAIL for this event's struct, not just decode wrong. Fix core/events.go's constructor.",
			evName, field, v, v, indexerRef, field)
	}
	if gs != want {
		t.Fatalf("%s: field %q = %q, want %q", evName, field, gs, want)
	}
}

// scWantNum asserts field is present, decodes as a bare JSON NUMBER (the
// shape indexer's uint64-typed struct field with a json:"..." tag
// requires), and equals want exactly.
func scWantNum(t *testing.T, evName string, m map[string]any, field string, want float64, indexerRef string) {
	t.Helper()
	v, ok := m[field]
	if !ok {
		t.Fatalf("%s: field %q is MISSING from core's JSON output (got fields %v). indexer's %s reads this field as uint64 — either core/events.go dropped/renamed it, or %s is stale. Fix whichever side is wrong.",
			evName, field, scFieldNames(m), indexerRef, indexerRef)
	}
	gn, ok := v.(float64) // encoding/json decodes a bare JSON number as float64
	if !ok {
		t.Fatalf("%s: field %q = %v (%T) — want a BARE JSON NUMBER to match indexer's %s (`%s uint64`). A quoted string here would make indexer's json.Unmarshal FAIL for this event's struct, not just decode wrong. Fix core/events.go's constructor.",
			evName, field, v, v, indexerRef, field)
	}
	if gn != want {
		t.Fatalf("%s: field %q = %v, want %v", evName, field, gn, want)
	}
}

// scWantFieldCount asserts the decoded object has EXACTLY `want` top-level
// keys — the closed-field-set half of "contains exactly the fields the
// indexer reads": every field checked above accounts for one key, plus the
// shared four-field envelope minus overlap (ev/v/creator/actor/block are
// asserted individually by each test, so `want` is simply the total number
// of scWantStr/scWantNum calls made for that event). Catches an ADDED field
// neither side's contract mentions, which the individual field checks above
// cannot catch on their own (they only look for absence/wrong-type of
// fields they were told to expect).
func scWantFieldCount(t *testing.T, evName string, m map[string]any, want int, indexerRef string) {
	t.Helper()
	if len(m) != want {
		t.Fatalf("%s: core emits %d top-level JSON fields %v, want exactly %d to match indexer's %s field set (plus \"ev\"/\"v\" for dispatch) — an extra or missing field means core/events.go and %s have drifted apart. Fix whichever side is wrong.",
			evName, len(m), scFieldNames(m), want, indexerRef, indexerRef)
	}
}

// ---------------------------------------------------------------------------
// One test per Ev*() constructor, each checking every field indexer/events.go
// reads for that event kind, by name, type, AND value, against the exact
// struct + line indexer declares it at (read 2026-07-20, indexer/events.go).
// Realistic-looking values are used throughout (real-shaped account names,
// plausible HBD/credit amounts, plausible block heights) rather than "1"/"a"
// placeholders, per the task's own instruction — a placeholder value can
// accidentally satisfy a type check that a real value (e.g. a money amount
// that must NOT collide with a block number) would not.
// ---------------------------------------------------------------------------

func TestSchemaContract_Registered(t *testing.T) {
	const evName = "registered"
	const ref = "indexer/events.go:51-58 (RegisteredEvent)"
	out := EvRegistered("aliceperry", "aliceperry", 12_345_678, 5000, 1_000_000, big.NewInt(10_000))
	m := scDecode(t, out)

	scWantStr(t, evName, m, "ev", "registered", "indexer/events.go:21 (KindRegistered) + :215-221 (ParseEvent dispatch)")
	scWantNum(t, evName, m, "v", 1, "indexer/events.go:40-41 (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "indexer/events.go:52 (RegisteredEvent.Creator)")
	scWantStr(t, evName, m, "actor", "aliceperry", "indexer/events.go:53 (RegisteredEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_345_678, "indexer/events.go:54 (RegisteredEvent.Block)")
	scWantStr(t, evName, m, "face", "5000", "indexer/events.go:55 (RegisteredEvent.Face)")
	scWantStr(t, evName, m, "cap", "1000000", "indexer/events.go:56 (RegisteredEvent.Cap)")
	scWantStr(t, evName, m, "feePaid", "10000", "indexer/events.go:57 (RegisteredEvent.FeePaid)")
	scWantFieldCount(t, evName, m, 8, ref)
}

func TestSchemaContract_Renewed(t *testing.T) {
	const evName = "renewed"
	const ref = "indexer/events.go:60-66 (RenewedEvent)"
	// actor deliberately != creator: Renew is permissionless (a fan pays).
	out := EvRenewed("aliceperry", "fanwriter1", 12_400_000, 3, big.NewInt(30_000))
	m := scDecode(t, out)

	scWantStr(t, evName, m, "ev", "renewed", "indexer/events.go:22 (KindRenewed)")
	scWantNum(t, evName, m, "v", 1, "indexer/events.go:40-41 (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "indexer/events.go:61 (RenewedEvent.Creator)")
	scWantStr(t, evName, m, "actor", "fanwriter1", "indexer/events.go:62 (RenewedEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_400_000, "indexer/events.go:63 (RenewedEvent.Block)")
	scWantNum(t, evName, m, "periods", 3, "indexer/events.go:64 (RenewedEvent.Periods)")
	scWantStr(t, evName, m, "paid", "30000", "indexer/events.go:65 (RenewedEvent.Paid)")
	scWantFieldCount(t, evName, m, 7, ref)
}

func TestSchemaContract_FaceChanged(t *testing.T) {
	const evName = "faceChanged"
	const ref = "indexer/events.go:68-74 (FaceChangedEvent)"
	out := EvFaceChanged("aliceperry", "aliceperry", 12_500_000, 5000, 9000)
	m := scDecode(t, out)

	scWantStr(t, evName, m, "ev", "faceChanged", "indexer/events.go:23 (KindFaceChanged)")
	scWantNum(t, evName, m, "v", 1, "indexer/events.go:40-41 (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "indexer/events.go:69 (FaceChangedEvent.Creator)")
	scWantStr(t, evName, m, "actor", "aliceperry", "indexer/events.go:70 (FaceChangedEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_500_000, "indexer/events.go:71 (FaceChangedEvent.Block)")
	scWantStr(t, evName, m, "oldFace", "5000", "indexer/events.go:72 (FaceChangedEvent.OldFace)")
	scWantStr(t, evName, m, "newFace", "9000", "indexer/events.go:73 (FaceChangedEvent.NewFace)")
	scWantFieldCount(t, evName, m, 7, ref)
}

func TestSchemaContract_CapChanged(t *testing.T) {
	const evName = "capChanged"
	const ref = "indexer/events.go:76-82 (CapChangedEvent)"
	out := EvCapChanged("aliceperry", "aliceperry", 12_500_100, 1_000_000, 2_000_000)
	m := scDecode(t, out)

	scWantStr(t, evName, m, "ev", "capChanged", "indexer/events.go:24 (KindCapChanged)")
	scWantNum(t, evName, m, "v", 1, "indexer/events.go:40-41 (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "indexer/events.go:77 (CapChangedEvent.Creator)")
	scWantStr(t, evName, m, "actor", "aliceperry", "indexer/events.go:78 (CapChangedEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_500_100, "indexer/events.go:79 (CapChangedEvent.Block)")
	scWantStr(t, evName, m, "oldCap", "1000000", "indexer/events.go:80 (CapChangedEvent.OldCap)")
	scWantStr(t, evName, m, "newCap", "2000000", "indexer/events.go:81 (CapChangedEvent.NewCap)")
	scWantFieldCount(t, evName, m, 7, ref)
}

func TestSchemaContract_Prepaid(t *testing.T) {
	const evName = "prepaid"
	const ref = "indexer/events.go:84-90 (PrepaidEvent)"
	out := EvPrepaid("aliceperry", "holderone", 12_600_000, big.NewInt(250_000), big.NewInt(250_000))
	m := scDecode(t, out)

	scWantStr(t, evName, m, "ev", "prepaid", "indexer/events.go:25 (KindPrepaid)")
	scWantNum(t, evName, m, "v", 1, "indexer/events.go:40-41 (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "indexer/events.go:85 (PrepaidEvent.Creator)")
	scWantStr(t, evName, m, "actor", "holderone", "indexer/events.go:86 (PrepaidEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_600_000, "indexer/events.go:87 (PrepaidEvent.Block)")
	scWantStr(t, evName, m, "hbdPaid", "250000", "indexer/events.go:88 (PrepaidEvent.HbdPaid)")
	scWantStr(t, evName, m, "creditsMinted", "250000", "indexer/events.go:89 (PrepaidEvent.CreditsMinted)")
	scWantFieldCount(t, evName, m, 7, ref)

	// index.go's own fold (KindPrepaid case) does m.addBal(p.Actor, credits)
	// — it credits the RECEIVER (the caller, per Prepay's own "mints to
	// caller, never creator" rule), never a separate "to" field this event
	// doesn't have. Pin that shape assumption explicitly: this event has NO
	// "to"/"holder" field, unlike Transferred/RefundPushed below.
	if _, present := m["to"]; present {
		t.Fatalf("%s: unexpected \"to\" field — index.go's KindPrepaid fold credits p.Actor directly, there is no separate recipient field for this event", evName)
	}
}

func TestSchemaContract_Transferred(t *testing.T) {
	const evName = "transferred"
	const ref = "indexer/events.go:94-100 (TransferredEvent)"
	out := EvTransferred("aliceperry", "holderone", "holdertwo", 12_650_000, big.NewInt(50_000))
	m := scDecode(t, out)

	scWantStr(t, evName, m, "ev", "transferred", "indexer/events.go:26 (KindTransferred)")
	scWantNum(t, evName, m, "v", 1, "indexer/events.go:40-41 (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "indexer/events.go:95 (TransferredEvent.Creator)")
	scWantStr(t, evName, m, "actor", "holderone", "indexer/events.go:96 (TransferredEvent.Actor)")
	scWantStr(t, evName, m, "to", "holdertwo", "indexer/events.go:97 (TransferredEvent.To)")
	scWantNum(t, evName, m, "block", 12_650_000, "indexer/events.go:98 (TransferredEvent.Block)")
	scWantStr(t, evName, m, "amount", "50000", "indexer/events.go:99 (TransferredEvent.Amount)")
	scWantFieldCount(t, evName, m, 7, ref)
}

func TestSchemaContract_Asked(t *testing.T) {
	const evName = "asked"
	const ref = "indexer/events.go:102-112 (AskedEvent)"
	out := EvAsked("aliceperry", "holderone", 12_700_000, 3, big.NewInt(42), big.NewInt(120), big.NewInt(2000), 28800, "cid-realistic-hash-abc123")
	m := scDecode(t, out)

	scWantStr(t, evName, m, "ev", "asked", "indexer/events.go:27 (KindAsked)")
	scWantNum(t, evName, m, "v", 1, "indexer/events.go:40-41 (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "indexer/events.go:103 (AskedEvent.Creator)")
	scWantStr(t, evName, m, "actor", "holderone", "indexer/events.go:104 (AskedEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_700_000, "indexer/events.go:105 (AskedEvent.Block)")
	scWantNum(t, evName, m, "seq", 3, "indexer/events.go:106 (AskedEvent.Seq)")
	scWantStr(t, evName, m, "creditsSpent", "42", "indexer/events.go:107 (AskedEvent.CreditsSpent)")
	scWantStr(t, evName, m, "commissionHbd", "120", "indexer/events.go:108 (AskedEvent.CommissionHbd)")
	scWantStr(t, evName, m, "rate", "2000", "indexer/events.go:109 (AskedEvent.Rate)")
	scWantNum(t, evName, m, "deadlineBlocks", 28800, "indexer/events.go:110 (AskedEvent.DeadlineBlocks)")
	scWantStr(t, evName, m, "contentHash", "cid-realistic-hash-abc123", "indexer/events.go:111 (AskedEvent.ContentHash)")
	scWantFieldCount(t, evName, m, 11, ref)

	// This is the event GAP 2's own example (index.go:325-340): a rename of
	// "creditsSpent" alone would make indexer's AskedEvent.CreditsSpent
	// decode to "", parseAmount("") fail closed, and the WHOLE ask silently
	// drop out of Stats.Ingested into Stats.Malformed — no balance debit
	// recorded, no escrow entry, and it never appears in DeliveryHistory. The
	// check above (line 107 reference) is what would catch that rename here,
	// in core, before it ever reaches indexer.
}

func TestSchemaContract_Answered(t *testing.T) {
	const evName = "answered"
	const ref = "indexer/events.go:118-126 (AnsweredEvent)"
	// M4 fix (2026-07-21): commissionHbd added — the HBD Answer books to
	// kTreasury() in the same call, previously invisible to any replay.
	out := EvAnswered("aliceperry", "aliceperry", 12_710_000, 3, big.NewInt(42), big.NewInt(504), "ans-realistic-hash-1")
	m := scDecode(t, out)

	scWantStr(t, evName, m, "ev", "answered", "indexer/events.go:28 (KindAnswered)")
	scWantNum(t, evName, m, "v", 1, "indexer/events.go:40-41 (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "indexer/events.go:119 (AnsweredEvent.Creator)")
	scWantStr(t, evName, m, "actor", "aliceperry", "indexer/events.go:120 (AnsweredEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_710_000, "indexer/events.go:121 (AnsweredEvent.Block)")
	scWantNum(t, evName, m, "seq", 3, "indexer/events.go:122 (AnsweredEvent.Seq)")
	scWantStr(t, evName, m, "creditsToCreator", "42", "indexer/events.go:123 (AnsweredEvent.CreditsToCreator)")
	scWantStr(t, evName, m, "commissionHbd", "504", "indexer/events.go:124 (AnsweredEvent.CommissionHbd)")
	scWantStr(t, evName, m, "answerHash", "ans-realistic-hash-1", "indexer/events.go:125 (AnsweredEvent.AnswerHash)")
	scWantFieldCount(t, evName, m, 9, ref)
}

func TestSchemaContract_Reclaimed(t *testing.T) {
	const evName = "reclaimed"
	const ref = "indexer/events.go:133-140 (ReclaimedEvent)"
	// M4 fix (2026-07-21): commissionHbd added — the HBD Reclaim hands back
	// to the asker in full (I5), previously invisible to any replay.
	out := EvReclaimed("aliceperry", "holderthree", 12_720_000, 4, big.NewInt(60), big.NewInt(72))
	m := scDecode(t, out)

	scWantStr(t, evName, m, "ev", "reclaimed", "indexer/events.go:29 (KindReclaimed)")
	scWantNum(t, evName, m, "v", 1, "indexer/events.go:40-41 (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "indexer/events.go:134 (ReclaimedEvent.Creator)")
	scWantStr(t, evName, m, "actor", "holderthree", "indexer/events.go:135 (ReclaimedEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_720_000, "indexer/events.go:136 (ReclaimedEvent.Block)")
	scWantNum(t, evName, m, "seq", 4, "indexer/events.go:137 (ReclaimedEvent.Seq)")
	scWantStr(t, evName, m, "credits", "60", "indexer/events.go:138 (ReclaimedEvent.Credits)")
	scWantStr(t, evName, m, "commissionHbd", "72", "indexer/events.go:139 (ReclaimedEvent.CommissionHbd)")
	scWantFieldCount(t, evName, m, 8, ref)
}

func TestSchemaContract_Refunded(t *testing.T) {
	const evName = "refunded"
	const ref = "indexer/events.go:131-137 (RefundedEvent)"
	out := EvRefunded("aliceperry", "holderfour", 12_800_000, big.NewInt(1000), big.NewInt(950))
	m := scDecode(t, out)

	scWantStr(t, evName, m, "ev", "refunded", "indexer/events.go:30 (KindRefunded)")
	scWantNum(t, evName, m, "v", 1, "indexer/events.go:40-41 (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "indexer/events.go:132 (RefundedEvent.Creator)")
	scWantStr(t, evName, m, "actor", "holderfour", "indexer/events.go:133 (RefundedEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_800_000, "indexer/events.go:134 (RefundedEvent.Block)")
	scWantStr(t, evName, m, "credits", "1000", "indexer/events.go:135 (RefundedEvent.Credits)")
	scWantStr(t, evName, m, "payout", "950", "indexer/events.go:136 (RefundedEvent.Payout)")
	scWantFieldCount(t, evName, m, 7, ref)
}

func TestSchemaContract_RefundPushed(t *testing.T) {
	const evName = "refundPushed"
	const ref = "indexer/events.go:143-150 (RefundPushedEvent)"
	// actor (the permissionless pusher/keeper) deliberately != holder (the
	// only one who is ever actually paid) — see RefundHolder's own doc and
	// index.go's KindRefundPushed fold (m.subBal(p.Holder, burned), never
	// p.Actor).
	out := EvRefundPushed("aliceperry", "keeperbot1", "holderfive", 12_810_000, big.NewInt(300), big.NewInt(285))
	m := scDecode(t, out)

	scWantStr(t, evName, m, "ev", "refundPushed", "indexer/events.go:31 (KindRefundPushed)")
	scWantNum(t, evName, m, "v", 1, "indexer/events.go:40-41 (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "indexer/events.go:144 (RefundPushedEvent.Creator)")
	scWantStr(t, evName, m, "actor", "keeperbot1", "indexer/events.go:145 (RefundPushedEvent.Actor)")
	scWantStr(t, evName, m, "holder", "holderfive", "indexer/events.go:146 (RefundPushedEvent.Holder)")
	scWantNum(t, evName, m, "block", 12_810_000, "indexer/events.go:147 (RefundPushedEvent.Block)")
	scWantStr(t, evName, m, "creditsBurned", "300", "indexer/events.go:148 (RefundPushedEvent.CreditsBurned)")
	scWantStr(t, evName, m, "payout", "285", "indexer/events.go:149 (RefundPushedEvent.Payout)")
	scWantFieldCount(t, evName, m, 8, ref)
}

func TestSchemaContract_Closed(t *testing.T) {
	const evName = "closed"
	const ref = "indexer/events.go:152-156 (ClosedEvent)"
	out := EvClosed("aliceperry", "keeperbot1", 12_900_000)
	m := scDecode(t, out)

	scWantStr(t, evName, m, "ev", "closed", "indexer/events.go:32 (KindClosed)")
	scWantNum(t, evName, m, "v", 1, "indexer/events.go:40-41 (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "indexer/events.go:153 (ClosedEvent.Creator)")
	scWantStr(t, evName, m, "actor", "keeperbot1", "indexer/events.go:154 (ClosedEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_900_000, "indexer/events.go:155 (ClosedEvent.Block)")
	scWantFieldCount(t, evName, m, 5, ref)
}

// TestSchemaContract_KindConstantsCoverEveryEvName sweeps every one of the
// twelve constructors' "ev" values against indexer's own Kind* constants
// (indexer/events.go:20-33), so a constructor whose emitted name doesn't
// match ANY of indexer's twelve recognized kinds is caught here, in core,
// rather than surfacing as a silent Stats.Unknown increment in production
// (ParseEvent's own documented "graceful degradation" path — see
// indexer/events.go:196-202 — is explicitly designed to NOT error on an
// unrecognized kind, which is correct for a genuinely NEW event a future
// core version adds, but wrong for an accidental typo in an EXISTING one).
func TestSchemaContract_KindConstantsCoverEveryEvName(t *testing.T) {
	// Mirrors indexer/events.go:20-33's twelve EventKind constants exactly —
	// this is the one place in this file the indexer-side string literals
	// are restated directly rather than only referenced, because this test's
	// whole point is to prove core's twelve emitted "ev" values are drawn
	// from exactly that set.
	indexerKinds := map[string]bool{
		"registered": true, "renewed": true, "faceChanged": true, "capChanged": true,
		"prepaid": true, "transferred": true, "asked": true, "answered": true,
		"reclaimed": true, "refunded": true, "refundPushed": true, "closed": true,
		// Offering catalogue (2026-07-27) — three more, taking twelve to fifteen.
		"offeringCreated": true, "offeringUpdated": true, "offeringDeleted": true,
	}

	cases := []struct {
		name string
		out  string
	}{
		{"registered", EvRegistered("c", "a", 1, MinFace, MinCap, big.NewInt(1))},
		{"renewed", EvRenewed("c", "a", 1, 1, big.NewInt(1))},
		{"faceChanged", EvFaceChanged("c", "a", 1, 1, 2)},
		{"capChanged", EvCapChanged("c", "a", 1, 1, 2)},
		{"prepaid", EvPrepaid("c", "a", 1, big.NewInt(1), big.NewInt(1))},
		{"transferred", EvTransferred("c", "a", "b", 1, big.NewInt(1))},
		{"asked", EvAsked("c", "a", 1, 1, big.NewInt(1), big.NewInt(1), big.NewInt(1), 1, "h")},
		{"answered", EvAnswered("c", "a", 1, 1, big.NewInt(1), big.NewInt(1), "h")},
		{"reclaimed", EvReclaimed("c", "a", 1, 1, big.NewInt(1), big.NewInt(1))},
		{"refunded", EvRefunded("c", "a", 1, big.NewInt(1), big.NewInt(1))},
		{"refundPushed", EvRefundPushed("c", "a", "h", 1, big.NewInt(1), big.NewInt(1))},
		{"closed", EvClosed("c", "a", 1)},
		{"offeringCreated", EvOfferingCreated("c", "a", 1, 1, "15-min call", big.NewInt(2500))},
		{"offeringUpdated", EvOfferingUpdated("c", "a", 1, 1, "15-min call", big.NewInt(2500), big.NewInt(3000))},
		{"offeringDeleted", EvOfferingDeleted("c", "a", 1, 1)},
	}
	if len(cases) != 15 {
		t.Fatalf("test setup bug: expected exactly 15 constructors (twelve money/state events plus the three offering-catalogue events), got %d", len(cases))
	}
	for _, c := range cases {
		m := scDecode(t, c.out)
		ev, _ := m["ev"].(string)
		if ev != c.name {
			t.Fatalf("%s constructor emitted ev=%q, want %q", c.name, ev, c.name)
		}
		if !indexerKinds[ev] {
			t.Fatalf("core emits \"ev\":%q but indexer/events.go:20-33 has NO matching Kind* constant — ParseEvent would silently classify this as Unknown (indexer/events.go:288-289) and it would never fold into any query. Add the Kind constant to indexer/events.go, or fix core's constructor name.", ev)
		}
	}
}
