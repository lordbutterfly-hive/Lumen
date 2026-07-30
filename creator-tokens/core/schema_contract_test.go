package core

import (
	"math/big"
	"os"
	"regexp"
	"sort"
	"testing"
)

// schema_contract_test.go — GAP 2 closure (mutation-testing audit,
// 2026-07-20).
//
// core/events.go BUILDS the wire JSON (twelve Ev* constructors);
// ../magi-indexer/creator_tokens_mappings.yaml PARSES it back (ParseEvent + twelve typed *Event
// structs). Nothing before this file ever piped a real core.Ev*() output
// into the indexer's decoder — the two sides agree only by a
// human-maintained comment (core/events.go's own file doc, the "Twelve
// events" table around line 45). A field rename on EITHER side breaks the
// delivery record silently: it does not panic and does not surface as an
// obvious error.
//
// THE EXACT FAILURE MODE THIS FILE GUARDS AGAINST (verified by reading both
// sides, not assumed): magi-indexer/creator_tokens_views.yaml's foldKnownEventLocked calls
// parseAmount on every money-shaped field of a known event kind and returns
// false — without applying ANY of that event's effects — if even ONE
// documented field fails to parse as a non-negative base-10 decimal
// (index.go:353-367's own comment: "deliberately not just the ones this
// fold happens to use arithmetically"). If core renamed, say, AskedEvent's
// "creditsSpent" field, magi-indexer/creator_tokens_mappings.yaml's AskedEvent.CreditsSpent
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
// magi-indexer/creator_tokens_mappings.yaml struct + line it mirrors — and checks every Ev*()
// constructor's real output against that hardcoded shape, field by field,
// with an exact field-count check so neither an added nor a removed field
// goes unnoticed. This is the strongest contract check available from this
// side of the import boundary:
//   - A core-side rename, type change, or dropped field is caught
//     IMMEDIATELY — this test lives in core and runs on every
//     `go test ./core/...`.
//   - The magi-indexer/creator_tokens_mappings.yaml file:line comment attached to every single
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
// One test per Ev*() constructor, each checking every field magi-indexer/creator_tokens_mappings.yaml
// reads for that event kind, by name, type, AND value, against the exact
// struct + line indexer declares it at (read 2026-07-20, magi-indexer/creator_tokens_mappings.yaml).
// Realistic-looking values are used throughout (real-shaped account names,
// plausible HBD/credit amounts, plausible block heights) rather than "1"/"a"
// placeholders, per the task's own instruction — a placeholder value can
// accidentally satisfy a type check that a real value (e.g. a money amount
// that must NOT collide with a block number) would not.
// ---------------------------------------------------------------------------

func TestSchemaContract_Registered(t *testing.T) {
	const evName = "registered"
	const ref = "magi-indexer/creator_tokens_mappings.yaml (RegisteredEvent)"
	out := EvRegistered("aliceperry", "aliceperry", 12_345_678, 5000, 1_000_000, big.NewInt(10_000))
	m := scDecode(t, out)

	scWantStr(t, evName, m, "type", "registered", "magi-indexer/creator_tokens_mappings.yaml (KindRegistered) + :528-533 (ParseEvent dispatch)")
	scWantNum(t, evName, m, "v", 1, "magi-indexer/creator_tokens_mappings.yaml (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (RegisteredEvent.Creator)")
	scWantStr(t, evName, m, "actor", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (RegisteredEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_345_678, "magi-indexer/creator_tokens_mappings.yaml (RegisteredEvent.Block)")
	scWantStr(t, evName, m, "face", "5000", "magi-indexer/creator_tokens_mappings.yaml (RegisteredEvent.Face)")
	scWantStr(t, evName, m, "cap", "1000000", "magi-indexer/creator_tokens_mappings.yaml (RegisteredEvent.Cap)")
	scWantStr(t, evName, m, "feePaid", "10000", "magi-indexer/creator_tokens_mappings.yaml (RegisteredEvent.FeePaid)")
	scWantFieldCount(t, evName, m, 8, ref)
}

func TestSchemaContract_Renewed(t *testing.T) {
	const evName = "renewed"
	const ref = "magi-indexer/creator_tokens_mappings.yaml (RenewedEvent)"
	// actor deliberately != creator: Renew is permissionless (a fan pays).
	out := EvRenewed("aliceperry", "fanwriter1", 12_400_000, 3, big.NewInt(30_000))
	m := scDecode(t, out)

	scWantStr(t, evName, m, "type", "renewed", "magi-indexer/creator_tokens_mappings.yaml (KindRenewed)")
	scWantNum(t, evName, m, "v", 1, "magi-indexer/creator_tokens_mappings.yaml (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (RenewedEvent.Creator)")
	scWantStr(t, evName, m, "actor", "fanwriter1", "magi-indexer/creator_tokens_mappings.yaml (RenewedEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_400_000, "magi-indexer/creator_tokens_mappings.yaml (RenewedEvent.Block)")
	scWantNum(t, evName, m, "periods", 3, "magi-indexer/creator_tokens_mappings.yaml (RenewedEvent.Periods)")
	scWantStr(t, evName, m, "paid", "30000", "magi-indexer/creator_tokens_mappings.yaml (RenewedEvent.Paid)")
	scWantFieldCount(t, evName, m, 7, ref)
}

func TestSchemaContract_FaceChanged(t *testing.T) {
	const evName = "faceChanged"
	const ref = "magi-indexer/creator_tokens_mappings.yaml (FaceChangedEvent)"
	out := EvFaceChanged("aliceperry", "aliceperry", 12_500_000, 5000, 9000)
	m := scDecode(t, out)

	scWantStr(t, evName, m, "type", "faceChanged", "magi-indexer/creator_tokens_mappings.yaml (KindFaceChanged)")
	scWantNum(t, evName, m, "v", 1, "magi-indexer/creator_tokens_mappings.yaml (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (FaceChangedEvent.Creator)")
	scWantStr(t, evName, m, "actor", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (FaceChangedEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_500_000, "magi-indexer/creator_tokens_mappings.yaml (FaceChangedEvent.Block)")
	scWantStr(t, evName, m, "oldFace", "5000", "magi-indexer/creator_tokens_mappings.yaml (FaceChangedEvent.OldFace)")
	scWantStr(t, evName, m, "newFace", "9000", "magi-indexer/creator_tokens_mappings.yaml (FaceChangedEvent.NewFace)")
	scWantFieldCount(t, evName, m, 7, ref)
}

func TestSchemaContract_CapChanged(t *testing.T) {
	const evName = "capChanged"
	const ref = "magi-indexer/creator_tokens_mappings.yaml (CapChangedEvent)"
	out := EvCapChanged("aliceperry", "aliceperry", 12_500_100, 1_000_000, 2_000_000)
	m := scDecode(t, out)

	scWantStr(t, evName, m, "type", "capChanged", "magi-indexer/creator_tokens_mappings.yaml (KindCapChanged)")
	scWantNum(t, evName, m, "v", 1, "magi-indexer/creator_tokens_mappings.yaml (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (CapChangedEvent.Creator)")
	scWantStr(t, evName, m, "actor", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (CapChangedEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_500_100, "magi-indexer/creator_tokens_mappings.yaml (CapChangedEvent.Block)")
	scWantStr(t, evName, m, "oldCap", "1000000", "magi-indexer/creator_tokens_mappings.yaml (CapChangedEvent.OldCap)")
	scWantStr(t, evName, m, "newCap", "2000000", "magi-indexer/creator_tokens_mappings.yaml (CapChangedEvent.NewCap)")
	scWantFieldCount(t, evName, m, 7, ref)
}

func TestSchemaContract_Prepaid(t *testing.T) {
	const evName = "prepaid"
	const ref = "magi-indexer/creator_tokens_mappings.yaml (PrepaidEvent)"
	out := EvPrepaid("aliceperry", "holderone", 12_600_000, big.NewInt(250_000), big.NewInt(250_000))
	m := scDecode(t, out)

	scWantStr(t, evName, m, "type", "prepaid", "magi-indexer/creator_tokens_mappings.yaml (KindPrepaid)")
	scWantNum(t, evName, m, "v", 1, "magi-indexer/creator_tokens_mappings.yaml (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (PrepaidEvent.Creator)")
	scWantStr(t, evName, m, "actor", "holderone", "magi-indexer/creator_tokens_mappings.yaml (PrepaidEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_600_000, "magi-indexer/creator_tokens_mappings.yaml (PrepaidEvent.Block)")
	scWantStr(t, evName, m, "hbdPaid", "250000", "magi-indexer/creator_tokens_mappings.yaml (PrepaidEvent.HbdPaid)")
	scWantStr(t, evName, m, "creditsMinted", "250000", "magi-indexer/creator_tokens_mappings.yaml (PrepaidEvent.CreditsMinted)")
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
	const ref = "magi-indexer/creator_tokens_mappings.yaml (TransferredEvent)"
	out := EvTransferred("aliceperry", "holderone", "holdertwo", 12_650_000, big.NewInt(50_000))
	m := scDecode(t, out)

	scWantStr(t, evName, m, "type", "transferred", "magi-indexer/creator_tokens_mappings.yaml (KindTransferred)")
	scWantNum(t, evName, m, "v", 1, "magi-indexer/creator_tokens_mappings.yaml (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (TransferredEvent.Creator)")
	scWantStr(t, evName, m, "actor", "holderone", "magi-indexer/creator_tokens_mappings.yaml (TransferredEvent.Actor)")
	scWantStr(t, evName, m, "to", "holdertwo", "magi-indexer/creator_tokens_mappings.yaml (TransferredEvent.To)")
	scWantNum(t, evName, m, "block", 12_650_000, "magi-indexer/creator_tokens_mappings.yaml (TransferredEvent.Block)")
	scWantStr(t, evName, m, "amount", "50000", "magi-indexer/creator_tokens_mappings.yaml (TransferredEvent.Amount)")
	scWantFieldCount(t, evName, m, 7, ref)
}

func TestSchemaContract_Asked(t *testing.T) {
	const evName = "asked"
	const ref = "magi-indexer/creator_tokens_mappings.yaml (AskedEvent)"
	out := EvAsked("aliceperry", "holderone", 12_700_000, 3, big.NewInt(42), big.NewInt(120), big.NewInt(2000), 28800, "cid-realistic-hash-abc123", 3)
	m := scDecode(t, out)

	scWantStr(t, evName, m, "type", "asked", "magi-indexer/creator_tokens_mappings.yaml (KindAsked)")
	scWantNum(t, evName, m, "v", 1, "magi-indexer/creator_tokens_mappings.yaml (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (AskedEvent.Creator)")
	scWantStr(t, evName, m, "actor", "holderone", "magi-indexer/creator_tokens_mappings.yaml (AskedEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_700_000, "magi-indexer/creator_tokens_mappings.yaml (AskedEvent.Block)")
	scWantNum(t, evName, m, "seq", 3, "magi-indexer/creator_tokens_mappings.yaml (AskedEvent.Seq)")
	scWantStr(t, evName, m, "creditsSpent", "42", "magi-indexer/creator_tokens_mappings.yaml (AskedEvent.CreditsSpent)")
	scWantStr(t, evName, m, "commissionHbd", "120", "magi-indexer/creator_tokens_mappings.yaml (AskedEvent.CommissionHbd)")
	scWantStr(t, evName, m, "rate", "2000", "magi-indexer/creator_tokens_mappings.yaml (AskedEvent.Rate)")
	scWantNum(t, evName, m, "deadlineBlocks", 28800, "magi-indexer/creator_tokens_mappings.yaml (AskedEvent.DeadlineBlocks)")
	scWantStr(t, evName, m, "contentHash", "cid-realistic-hash-abc123", "magi-indexer/creator_tokens_mappings.yaml (AskedEvent.ContentHash)")
	// offeringId (2026-07-27): WHICH service this ask bought, 0 == the legacy
	// face price. The indexer's own doc claimed `asked` already carried it
	// while the field did not exist — this line is what stops that claim from
	// being a lie again.
	scWantNum(t, evName, m, "offeringId", 3, "magi-indexer/creator_tokens_mappings.yaml (AskedEvent.OfferingID)")
	scWantFieldCount(t, evName, m, 12, ref)

	// This is the event GAP 2's own example (index.go:499-502, the KindAsked
	// case's parseAmount(p.CreditsSpent) check, +:325-329 for the
	// Stats.Ingested/Stats.Malformed branch in ingestOneLocked): a rename of
	// "creditsSpent" alone would make indexer's AskedEvent.CreditsSpent
	// decode to "", parseAmount("") fail closed, and the WHOLE ask silently
	// drop out of Stats.Ingested into Stats.Malformed — no balance debit
	// recorded, no escrow entry, and it never appears in DeliveryHistory. The
	// check above (the CreditsSpent field reference) is what would catch
	// that rename here, in core, before it ever reaches indexer.
}

func TestSchemaContract_Answered(t *testing.T) {
	const evName = "answered"
	const ref = "magi-indexer/creator_tokens_mappings.yaml (AnsweredEvent)"
	// M4 fix (2026-07-21): commissionHbd added — the HBD Answer books to
	// kTreasury() in the same call, previously invisible to any replay.
	out := EvAnswered("aliceperry", "aliceperry", 12_710_000, 3, big.NewInt(42), big.NewInt(504), "ans-realistic-hash-1")
	m := scDecode(t, out)

	scWantStr(t, evName, m, "type", "answered", "magi-indexer/creator_tokens_mappings.yaml (KindAnswered)")
	scWantNum(t, evName, m, "v", 1, "magi-indexer/creator_tokens_mappings.yaml (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (AnsweredEvent.Creator)")
	scWantStr(t, evName, m, "actor", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (AnsweredEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_710_000, "magi-indexer/creator_tokens_mappings.yaml (AnsweredEvent.Block)")
	scWantNum(t, evName, m, "seq", 3, "magi-indexer/creator_tokens_mappings.yaml (AnsweredEvent.Seq)")
	scWantStr(t, evName, m, "creditsToCreator", "42", "magi-indexer/creator_tokens_mappings.yaml (AnsweredEvent.CreditsToCreator)")
	scWantStr(t, evName, m, "commissionHbd", "504", "magi-indexer/creator_tokens_mappings.yaml (AnsweredEvent.CommissionHbd)")
	scWantStr(t, evName, m, "answerHash", "ans-realistic-hash-1", "magi-indexer/creator_tokens_mappings.yaml (AnsweredEvent.AnswerHash)")
	scWantFieldCount(t, evName, m, 9, ref)
}

func TestSchemaContract_Reclaimed(t *testing.T) {
	const evName = "reclaimed"
	const ref = "magi-indexer/creator_tokens_mappings.yaml (ReclaimedEvent)"
	// M4 fix (2026-07-21): commissionHbd added — the HBD Reclaim hands back
	// to the asker in full (I5), previously invisible to any replay.
	out := EvReclaimed("aliceperry", "holderthree", 12_720_000, 4, big.NewInt(60), big.NewInt(54), big.NewInt(18), "holderthree")
	m := scDecode(t, out)

	scWantStr(t, evName, m, "type", "reclaimed", "magi-indexer/creator_tokens_mappings.yaml (KindReclaimed)")
	scWantNum(t, evName, m, "v", 1, "magi-indexer/creator_tokens_mappings.yaml (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (ReclaimedEvent.Creator)")
	scWantStr(t, evName, m, "actor", "holderthree", "magi-indexer/creator_tokens_mappings.yaml (ReclaimedEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_720_000, "magi-indexer/creator_tokens_mappings.yaml (ReclaimedEvent.Block)")
	scWantNum(t, evName, m, "seq", 4, "magi-indexer/creator_tokens_mappings.yaml (ReclaimedEvent.Seq)")
	scWantStr(t, evName, m, "credits", "60", "magi-indexer/creator_tokens_mappings.yaml (ReclaimedEvent.Credits)")
	scWantStr(t, evName, m, "commissionHbd", "54", "magi-indexer/creator_tokens_mappings.yaml (ReclaimedEvent.CommissionHbd)")
	// commissionRetainedHbd (USER RULING 1, 2026-07-28) — the miss slice the
	// protocol KEPT. It is a SEPARATE field, not a shrunken commissionHbd,
	// because the indexer folds the two in OPPOSITE directions: the returned
	// leg into reclaimOutflowHbd, this one into treasuryHbd. Drop it from the
	// wire and every miss reclaim silently under-credits the treasury by the
	// slice, forever, with no error anywhere.
	scWantStr(t, evName, m, "commissionRetainedHbd", "18", "magi-indexer/creator_tokens_mappings.yaml (ReclaimedEvent.CommissionRetainedHbd)")
	// asker (2026-07-27) — WHO WAS PAID, which is not `actor`: reclaim is
	// permissionless, so actor may be a keeper pushing an abandoned escrow. The
	// indexer folds the credits to THIS field; dropping it would silently
	// re-introduce crediting the caller.
	scWantStr(t, evName, m, "asker", "holderthree", "magi-indexer/creator_tokens_mappings.yaml (ReclaimedEvent.Asker)")
	scWantFieldCount(t, evName, m, 10, ref)
}

// TestSchemaContract_Rated pins the buyer's rating event (rating.go, USER
// RULING 2026-07-28). `score` is a BARE JSON NUMBER, like every other count on
// this wire — quoting it would make indexer's json.Unmarshal fail outright for
// RatedEvent, since Score is uint64.
func TestSchemaContract_Rated(t *testing.T) {
	const evName = "rated"
	const ref = "magi-indexer/creator_tokens_mappings.yaml (RatedEvent)"
	out := EvRated("aliceperry", "holderthree", 12_720_000, 4, 5)
	m := scDecode(t, out)

	scWantStr(t, evName, m, "type", "rated", "magi-indexer/creator_tokens_mappings.yaml (KindRated)")
	scWantNum(t, evName, m, "v", 1, "magi-indexer/creator_tokens_mappings.yaml (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (RatedEvent.Creator)")
	// actor IS the buyer here — rating.go refuses anyone else — which is why
	// this event carries no separate asker field the way reclaimed/declined do.
	scWantStr(t, evName, m, "actor", "holderthree", "magi-indexer/creator_tokens_mappings.yaml (RatedEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_720_000, "magi-indexer/creator_tokens_mappings.yaml (RatedEvent.Block)")
	scWantNum(t, evName, m, "seq", 4, "magi-indexer/creator_tokens_mappings.yaml (RatedEvent.Seq)")
	scWantNum(t, evName, m, "score", 5, "magi-indexer/creator_tokens_mappings.yaml (RatedEvent.Score)")
	scWantFieldCount(t, evName, m, 7, ref)
}

// TestSchemaContract_Declined closes a gap found 2026-07-28: `declined` was
// listed in BOTH coverage maps below (indexerKinds and pinned) but had no
// field-by-field pin of its own, so it was counted as covered while its wire
// shape was checked by nothing. That is the exact defect class this file
// exists to prevent, and the exact way `declined` shipped unpinned the first
// time.
//
// Shape is identical to `reclaimed` above, and deliberately so: both hand an
// escrow's credits AND its commission back to the asker in full, and both
// record `asker` separately from `actor`. For decline the two always coincide
// (only the creator may decline, and the payee is always the asker) — the
// field is still asserted, because the indexer folds the credits to THIS
// field, not to actor, and a consumer must not learn to conflate them.
func TestSchemaContract_Declined(t *testing.T) {
	const evName = "declined"
	const ref = "magi-indexer/creator_tokens_mappings.yaml (DeclinedEvent)"
	out := EvDeclined("aliceperry", "aliceperry", 12_725_000, 5, big.NewInt(60), big.NewInt(72), "holderthree")
	m := scDecode(t, out)

	scWantStr(t, evName, m, "type", "declined", "magi-indexer/creator_tokens_mappings.yaml (KindDeclined)")
	scWantNum(t, evName, m, "v", 1, "magi-indexer/creator_tokens_mappings.yaml (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (DeclinedEvent.Creator)")
	scWantStr(t, evName, m, "actor", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (DeclinedEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_725_000, "magi-indexer/creator_tokens_mappings.yaml (DeclinedEvent.Block)")
	scWantNum(t, evName, m, "seq", 5, "magi-indexer/creator_tokens_mappings.yaml (DeclinedEvent.Seq)")
	scWantStr(t, evName, m, "credits", "60", "magi-indexer/creator_tokens_mappings.yaml (DeclinedEvent.Credits)")
	scWantStr(t, evName, m, "commissionHbd", "72", "magi-indexer/creator_tokens_mappings.yaml (DeclinedEvent.CommissionHbd)")
	scWantStr(t, evName, m, "asker", "holderthree", "magi-indexer/creator_tokens_mappings.yaml (DeclinedEvent.Asker)")
	scWantFieldCount(t, evName, m, 9, ref)
}

// The five pins below close the rest of a gap found 2026-07-28: `bought`,
// `sold` and the three offering-catalogue events were listed in BOTH coverage
// maps yet had no field-by-field pin of their own, so they counted as covered
// while their wire shape was checked by nothing.
//
// bought/sold matter most. Post-pivot, Buy is the ONLY issuance path and Sell
// the only redemption, and these two already shipped UNRECOGNISED by the
// indexer once — every trade parsed to Unknown and was never folded, so its
// balances would have drifted from chain truth with every trade, silently and
// forever. Pinning the names was what caught that; pinning the FIELDS is what
// stops the next one.

func TestSchemaContract_Bought(t *testing.T) {
	const evName = "bought"
	const ref = "magi-indexer/creator_tokens_mappings.yaml (BoughtEvent)"
	out := EvBought("aliceperry", "holderthree", 12_730_000, big.NewInt(100), big.NewInt(5050), big.NewInt(505), big.NewInt(5555))
	m := scDecode(t, out)

	scWantStr(t, evName, m, "type", "bought", "magi-indexer/creator_tokens_mappings.yaml (KindBought)")
	scWantNum(t, evName, m, "v", 1, "magi-indexer/creator_tokens_mappings.yaml (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (BoughtEvent.Creator)")
	scWantStr(t, evName, m, "actor", "holderthree", "magi-indexer/creator_tokens_mappings.yaml (BoughtEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_730_000, "magi-indexer/creator_tokens_mappings.yaml (BoughtEvent.Block)")
	scWantStr(t, evName, m, "minted", "100", "magi-indexer/creator_tokens_mappings.yaml (BoughtEvent.Minted)")
	scWantStr(t, evName, m, "cost", "5050", "magi-indexer/creator_tokens_mappings.yaml (BoughtEvent.Cost)")
	scWantStr(t, evName, m, "fee", "505", "magi-indexer/creator_tokens_mappings.yaml (BoughtEvent.Fee)")
	scWantStr(t, evName, m, "totalDue", "5555", "magi-indexer/creator_tokens_mappings.yaml (BoughtEvent.TotalDue)")
	scWantFieldCount(t, evName, m, 9, ref)
}

func TestSchemaContract_Sold(t *testing.T) {
	const evName = "sold"
	const ref = "magi-indexer/creator_tokens_mappings.yaml (SoldEvent)"
	// taxBps and heldBlocks are BARE NUMBERS (indexer reads both as uint64);
	// every money leg is a quoted string. Getting either wrong makes the
	// indexer's json.Unmarshal fail for the whole struct, not decode wrong.
	out := EvSold("aliceperry", "holderthree", 12_740_000, big.NewInt(50), big.NewInt(2500), big.NewInt(500), big.NewInt(250), big.NewInt(1750), big.NewInt(2500), 2000, 604_800)
	m := scDecode(t, out)

	scWantStr(t, evName, m, "type", "sold", "magi-indexer/creator_tokens_mappings.yaml (KindSold)")
	scWantNum(t, evName, m, "v", 1, "magi-indexer/creator_tokens_mappings.yaml (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (SoldEvent.Creator)")
	scWantStr(t, evName, m, "actor", "holderthree", "magi-indexer/creator_tokens_mappings.yaml (SoldEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_740_000, "magi-indexer/creator_tokens_mappings.yaml (SoldEvent.Block)")
	scWantStr(t, evName, m, "sold", "50", "magi-indexer/creator_tokens_mappings.yaml (SoldEvent.Sold)")
	scWantStr(t, evName, m, "gross", "2500", "magi-indexer/creator_tokens_mappings.yaml (SoldEvent.Gross)")
	scWantStr(t, evName, m, "tax", "500", "magi-indexer/creator_tokens_mappings.yaml (SoldEvent.Tax)")
	scWantStr(t, evName, m, "fee", "250", "magi-indexer/creator_tokens_mappings.yaml (SoldEvent.Fee)")
	scWantStr(t, evName, m, "net", "1750", "magi-indexer/creator_tokens_mappings.yaml (SoldEvent.Net)")
	scWantNum(t, evName, m, "taxBps", 2000, "magi-indexer/creator_tokens_mappings.yaml (SoldEvent.TaxBps)")
	scWantNum(t, evName, m, "heldBlocks", 604_800, "magi-indexer/creator_tokens_mappings.yaml (SoldEvent.HeldBlocks)")
	// 13 since 2026-07-30: taxableGross was appended so a consumer can
	// reproduce the tax. gross × taxBps alone overstates it for any position
	// that is part-matured.
	scWantStr(t, evName, m, "taxableGross", "2500", ref)
	scWantFieldCount(t, evName, m, 13, ref)
}

func TestSchemaContract_OfferingCreated(t *testing.T) {
	const evName = "offeringCreated"
	const ref = "magi-indexer/creator_tokens_mappings.yaml (OfferingCreatedEvent)"
	out := EvOfferingCreated("aliceperry", "aliceperry", 12_750_000, 7, "15-min call", big.NewInt(2500))
	m := scDecode(t, out)

	scWantStr(t, evName, m, "type", "offeringCreated", "magi-indexer/creator_tokens_mappings.yaml (KindOfferingCreated)")
	scWantNum(t, evName, m, "v", 1, "magi-indexer/creator_tokens_mappings.yaml (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (OfferingCreatedEvent.Creator)")
	scWantStr(t, evName, m, "actor", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (OfferingCreatedEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_750_000, "magi-indexer/creator_tokens_mappings.yaml (OfferingCreatedEvent.Block)")
	// offeringId is a BARE NUMBER, and the JSON key is `offeringId` while the
	// Go field is OfferingID — a rename on either side is exactly the silent
	// drift this pin exists for.
	scWantNum(t, evName, m, "offeringId", 7, "magi-indexer/creator_tokens_mappings.yaml (OfferingCreatedEvent.OfferingID)")
	scWantStr(t, evName, m, "title", "15-min call", "magi-indexer/creator_tokens_mappings.yaml (OfferingCreatedEvent.Title)")
	scWantStr(t, evName, m, "price", "2500", "magi-indexer/creator_tokens_mappings.yaml (OfferingCreatedEvent.Price)")
	scWantFieldCount(t, evName, m, 8, ref)
}

func TestSchemaContract_OfferingUpdated(t *testing.T) {
	const evName = "offeringUpdated"
	const ref = "magi-indexer/creator_tokens_mappings.yaml (OfferingUpdatedEvent)"
	out := EvOfferingUpdated("aliceperry", "aliceperry", 12_760_000, 7, "15-min call", big.NewInt(2500), big.NewInt(3000))
	m := scDecode(t, out)

	scWantStr(t, evName, m, "type", "offeringUpdated", "magi-indexer/creator_tokens_mappings.yaml (KindOfferingUpdated)")
	scWantNum(t, evName, m, "v", 1, "magi-indexer/creator_tokens_mappings.yaml (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (OfferingUpdatedEvent.Creator)")
	scWantStr(t, evName, m, "actor", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (OfferingUpdatedEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_760_000, "magi-indexer/creator_tokens_mappings.yaml (OfferingUpdatedEvent.Block)")
	scWantNum(t, evName, m, "offeringId", 7, "magi-indexer/creator_tokens_mappings.yaml (OfferingUpdatedEvent.OfferingID)")
	scWantStr(t, evName, m, "title", "15-min call", "magi-indexer/creator_tokens_mappings.yaml (OfferingUpdatedEvent.Title)")
	scWantStr(t, evName, m, "oldPrice", "2500", "magi-indexer/creator_tokens_mappings.yaml (OfferingUpdatedEvent.OldPrice)")
	scWantStr(t, evName, m, "newPrice", "3000", "magi-indexer/creator_tokens_mappings.yaml (OfferingUpdatedEvent.NewPrice)")
	scWantFieldCount(t, evName, m, 9, ref)
}

func TestSchemaContract_OfferingDeleted(t *testing.T) {
	const evName = "offeringDeleted"
	const ref = "magi-indexer/creator_tokens_mappings.yaml (OfferingDeletedEvent)"
	out := EvOfferingDeleted("aliceperry", "aliceperry", 12_770_000, 7)
	m := scDecode(t, out)

	scWantStr(t, evName, m, "type", "offeringDeleted", "magi-indexer/creator_tokens_mappings.yaml (KindOfferingDeleted)")
	scWantNum(t, evName, m, "v", 1, "magi-indexer/creator_tokens_mappings.yaml (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (OfferingDeletedEvent.Creator)")
	scWantStr(t, evName, m, "actor", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (OfferingDeletedEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_770_000, "magi-indexer/creator_tokens_mappings.yaml (OfferingDeletedEvent.Block)")
	scWantNum(t, evName, m, "offeringId", 7, "magi-indexer/creator_tokens_mappings.yaml (OfferingDeletedEvent.OfferingID)")
	scWantFieldCount(t, evName, m, 6, ref)
}

func TestSchemaContract_Refunded(t *testing.T) {
	const evName = "refunded"
	const ref = "magi-indexer/creator_tokens_mappings.yaml (RefundedEvent)"
	out := EvRefunded("aliceperry", "holderfour", 12_800_000, big.NewInt(1000), big.NewInt(950))
	m := scDecode(t, out)

	scWantStr(t, evName, m, "type", "refunded", "magi-indexer/creator_tokens_mappings.yaml (KindRefunded)")
	scWantNum(t, evName, m, "v", 1, "magi-indexer/creator_tokens_mappings.yaml (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (RefundedEvent.Creator)")
	scWantStr(t, evName, m, "actor", "holderfour", "magi-indexer/creator_tokens_mappings.yaml (RefundedEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_800_000, "magi-indexer/creator_tokens_mappings.yaml (RefundedEvent.Block)")
	scWantStr(t, evName, m, "credits", "1000", "magi-indexer/creator_tokens_mappings.yaml (RefundedEvent.Credits)")
	scWantStr(t, evName, m, "payout", "950", "magi-indexer/creator_tokens_mappings.yaml (RefundedEvent.Payout)")
	scWantFieldCount(t, evName, m, 7, ref)
}

func TestSchemaContract_RefundPushed(t *testing.T) {
	const evName = "refundPushed"
	const ref = "magi-indexer/creator_tokens_mappings.yaml (RefundPushedEvent)"
	// actor (the permissionless pusher/keeper) deliberately != holder (the
	// only one who is ever actually paid) — see RefundHolder's own doc and
	// index.go's KindRefundPushed fold (m.subBal(p.Holder, burned), never
	// p.Actor).
	out := EvRefundPushed("aliceperry", "keeperbot1", "holderfive", 12_810_000, big.NewInt(300), big.NewInt(285))
	m := scDecode(t, out)

	scWantStr(t, evName, m, "type", "refundPushed", "magi-indexer/creator_tokens_mappings.yaml (KindRefundPushed)")
	scWantNum(t, evName, m, "v", 1, "magi-indexer/creator_tokens_mappings.yaml (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (RefundPushedEvent.Creator)")
	scWantStr(t, evName, m, "actor", "keeperbot1", "magi-indexer/creator_tokens_mappings.yaml (RefundPushedEvent.Actor)")
	scWantStr(t, evName, m, "holder", "holderfive", "magi-indexer/creator_tokens_mappings.yaml (RefundPushedEvent.Holder)")
	scWantNum(t, evName, m, "block", 12_810_000, "magi-indexer/creator_tokens_mappings.yaml (RefundPushedEvent.Block)")
	scWantStr(t, evName, m, "creditsBurned", "300", "magi-indexer/creator_tokens_mappings.yaml (RefundPushedEvent.CreditsBurned)")
	scWantStr(t, evName, m, "payout", "285", "magi-indexer/creator_tokens_mappings.yaml (RefundPushedEvent.Payout)")
	scWantFieldCount(t, evName, m, 8, ref)
}

func TestSchemaContract_Closed(t *testing.T) {
	const evName = "closed"
	const ref = "magi-indexer/creator_tokens_mappings.yaml (ClosedEvent)"
	out := EvClosed("aliceperry", "keeperbot1", 12_900_000)
	m := scDecode(t, out)

	scWantStr(t, evName, m, "type", "closed", "magi-indexer/creator_tokens_mappings.yaml (KindClosed)")
	scWantNum(t, evName, m, "v", 1, "magi-indexer/creator_tokens_mappings.yaml (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (ClosedEvent.Creator)")
	scWantStr(t, evName, m, "actor", "keeperbot1", "magi-indexer/creator_tokens_mappings.yaml (ClosedEvent.Actor)")
	scWantNum(t, evName, m, "block", 12_900_000, "magi-indexer/creator_tokens_mappings.yaml (ClosedEvent.Block)")
	scWantFieldCount(t, evName, m, 5, ref)
}

// ---------------------------------------------------------------------------
// Six more (2026-07-28, gap-hunt closure): main.go's init/pause/unpause/
// retire/withdrawTreasury/claimTradeFees entrypoints used to hand-build their
// own sdk.Log JSON with no constructor here to pin. Retired/TreasuryWithdrawn/
// TradeFeesClaimed ARE real magi-indexer/creator_tokens_mappings.yaml decode structs (verified by
// direct read); Init/Paused/Unpaused are not — pinned anyway per the task's
// own instruction, so THIS package's schema tests still catch any accidental
// future drift in their shape, even though nothing outside core consumes them
// today.
// ---------------------------------------------------------------------------

func TestSchemaContract_Retired(t *testing.T) {
	const evName = "retired"
	const ref = "magi-indexer/creator_tokens_mappings.yaml (RetiredEvent)"
	out := EvRetired("aliceperry", "aliceperry", 13_000_000)
	m := scDecode(t, out)

	scWantStr(t, evName, m, "type", "retired", "magi-indexer/creator_tokens_mappings.yaml (KindRetired)")
	scWantNum(t, evName, m, "v", 1, "magi-indexer/creator_tokens_mappings.yaml (envelope.V)")
	scWantStr(t, evName, m, "creator", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (RetiredEvent.Creator)")
	scWantStr(t, evName, m, "actor", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (RetiredEvent.Actor)")
	scWantNum(t, evName, m, "block", 13_000_000, "magi-indexer/creator_tokens_mappings.yaml (RetiredEvent.Block)")
	scWantFieldCount(t, evName, m, 5, ref)
}

func TestSchemaContract_TreasuryWithdrawn(t *testing.T) {
	const evName = "treasuryWithdrawn"
	const ref = "magi-indexer/creator_tokens_mappings.yaml (TreasuryWithdrawnEvent)"
	out := EvTreasuryWithdrawn("ownerAccount", 13_010_000, big.NewInt(75_000))
	m := scDecode(t, out)

	scWantStr(t, evName, m, "type", "treasuryWithdrawn", "magi-indexer/creator_tokens_mappings.yaml (KindTreasuryWithdrawn)")
	scWantNum(t, evName, m, "v", 1, "magi-indexer/creator_tokens_mappings.yaml (envelope.V)")
	scWantStr(t, evName, m, "actor", "ownerAccount", "magi-indexer/creator_tokens_mappings.yaml (TreasuryWithdrawnEvent.Actor)")
	scWantStr(t, evName, m, "amount", "75000", "magi-indexer/creator_tokens_mappings.yaml (TreasuryWithdrawnEvent.Amount)")
	scWantNum(t, evName, m, "block", 13_010_000, "magi-indexer/creator_tokens_mappings.yaml (TreasuryWithdrawnEvent.Block)")
	scWantFieldCount(t, evName, m, 5, ref)

	// Deliberately NO "creator" field — TreasuryWithdrawnEvent declares none,
	// and magi-indexer/creator_tokens_mappings.yaml's own doc calls the omission deliberate (a GLOBAL
	// kTreasury() debit, not scoped to any single creator's market). Pin that
	// shape assumption explicitly, same discipline TestSchemaContract_Prepaid
	// uses for its own "no to field" assertion above.
	if _, present := m["creator"]; present {
		t.Fatalf("%s: unexpected \"creator\" field — TreasuryWithdrawnEvent has none; magi-indexer/creator_tokens_mappings.yaml's own doc calls this omission deliberate (a global, not per-market, debit)", evName)
	}
}

func TestSchemaContract_TradeFeesClaimed(t *testing.T) {
	const evName = "tradeFeesClaimed"
	const ref = "magi-indexer/creator_tokens_mappings.yaml (TradeFeesClaimedEvent)"
	out := EvTradeFeesClaimed("aliceperry", 13_020_000, big.NewInt(1_250))
	m := scDecode(t, out)

	scWantStr(t, evName, m, "type", "tradeFeesClaimed", "magi-indexer/creator_tokens_mappings.yaml (KindTradeFeesClaimed)")
	scWantNum(t, evName, m, "v", 1, "magi-indexer/creator_tokens_mappings.yaml (envelope.V)")
	scWantStr(t, evName, m, "actor", "aliceperry", "magi-indexer/creator_tokens_mappings.yaml (TradeFeesClaimedEvent.Actor)")
	scWantStr(t, evName, m, "amount", "1250", "magi-indexer/creator_tokens_mappings.yaml (TradeFeesClaimedEvent.Amount)")
	scWantNum(t, evName, m, "block", 13_020_000, "magi-indexer/creator_tokens_mappings.yaml (TradeFeesClaimedEvent.Block)")
	scWantFieldCount(t, evName, m, 5, ref)

	// Deliberately NO "creator" field — same reasoning as TreasuryWithdrawn
	// above, except here "actor" itself doubles as the creator identifier
	// (kFeeBal is always keyed by the creator whose market accrued the fee),
	// per magi-indexer/creator_tokens_mappings.yaml's own KindTradeFeesClaimed doc.
	if _, present := m["creator"]; present {
		t.Fatalf("%s: unexpected \"creator\" field — TradeFeesClaimedEvent has none; actor already doubles as the creator identifier per magi-indexer/creator_tokens_mappings.yaml's own doc", evName)
	}
}

// TestSchemaContract_Init/Paused/Unpaused: NOT indexer-recognized events —
// ../magi-indexer/creator_tokens_mappings.yaml's own file doc names all three DELIBERATELY
// unrecognized (init is not a core-module event; the global pause switch has
// no per-market query surface in that package), so there is no indexer
// struct/line to cite here the way every test above does. Pinned anyway
// (task instruction: "pin all six... field-by-field, with an exact
// field-count assertion") so a future accidental change to these three still
// gets caught by this package's own tests, even with no external consumer.

func TestSchemaContract_Init(t *testing.T) {
	const evName = "init"
	const ref = "NOT an indexer-decoded event (magi-indexer/creator_tokens_mappings.yaml's file doc: \"init\" deliberately unrecognized, falls to Unknown)"
	out := EvInit("ownerAccount")
	m := scDecode(t, out)

	scWantStr(t, evName, m, "type", "init", ref)
	scWantNum(t, evName, m, "v", 1, ref)
	scWantStr(t, evName, m, "owner", "ownerAccount", ref)
	scWantFieldCount(t, evName, m, 3, ref)
}

func TestSchemaContract_Paused(t *testing.T) {
	const evName = "paused"
	const ref = "NOT an indexer-decoded event (magi-indexer/creator_tokens_mappings.yaml's file doc: \"paused\" deliberately unrecognized, falls to Unknown)"
	out := EvPaused("ownerAccount")
	m := scDecode(t, out)

	scWantStr(t, evName, m, "type", "paused", ref)
	scWantNum(t, evName, m, "v", 1, ref)
	scWantStr(t, evName, m, "actor", "ownerAccount", ref)
	scWantFieldCount(t, evName, m, 3, ref)
}

func TestSchemaContract_Unpaused(t *testing.T) {
	const evName = "unpaused"
	const ref = "NOT an indexer-decoded event (magi-indexer/creator_tokens_mappings.yaml's file doc: \"unpaused\" deliberately unrecognized, falls to Unknown)"
	out := EvUnpaused("ownerAccount")
	m := scDecode(t, out)

	scWantStr(t, evName, m, "type", "unpaused", ref)
	scWantNum(t, evName, m, "v", 1, ref)
	scWantStr(t, evName, m, "actor", "ownerAccount", ref)
	scWantFieldCount(t, evName, m, 3, ref)
}

// TestSchemaContract_KindConstantsCoverEveryEvName IS DELETED (2026-07-28).
//
// It asserted that every emitted event name appeared in a HARDCODED COPY of the
// Go indexer's Kind* constants. That Go indexer is gone — this repo now indexes
// through the Magi indexer (magi-mongo-indexer -> Hasura), configured by
// ../magi-indexer/creator_tokens_mappings.yaml — so the map it checked against
// became a hardcoded copy of nothing, still passing, still green, guarding
// exactly zero.
//
// Its real job — "every event core emits has a consumer that will actually
// store it" — is now done properly by magi_mapping_contract_test.go's
// TestMagiMapping_EveryEmittedEventIsMapped, which reads the REAL config file
// rather than a restated copy of it, and is mutation-proven. That test is
// strictly stronger: it cannot go stale the way a hand-maintained mirror can.
//
// Deleted rather than left passing, on this file's own principle: a check that
// no longer checks anything reads as protection and is not.

// TestSchemaContract_EveryConstructorIsPinned closes the hole that let the
// `declined`, `bought` and `sold` events ship with NO cross-package pin at all.
//
// The sibling test above asserts `len(cases) != N`, which sounds like a
// tripwire and is not one: it counts the literal list it is standing next to,
// so adding a constructor to core/events.go and forgetting to add it there
// leaves both numbers consistent and the test green. That is exactly what
// happened three times — and `bought`/`sold` are the bonding curve's only
// issuance path, so the indexer silently dropped every trade.
//
// This test derives the expected set from the SOURCE instead: it scans
// events.go for the event NAME in every way an event can be constructed, which
// is the one thing that cannot be forgotten, because naming one IS how you add
// an event. Add a constructor and this test fails until it is pinned above.
//
// REGRESSION 2026-07-28 — the scan must cover ALL construction styles, or it
// silently stops being a tripwire. It originally matched `evOpen("...")` only,
// and its premise sentence said so. Two more styles then appeared in the same
// commit and the scan went blind to five constructors at once:
//
//	evOpen("name", ...)       — per-market envelope (creator/actor/block)
//	evOpenActor("name", ...)  — contract-level envelope (actor only)
//	`{"type":"name",...}`       — built inline, no helper at all (EvInit)
//
// The blindness was invisible: those five were simply absent from `names`, so
// the forward check had nothing to complain about, and the exemption was then
// written into the pinned map as if it were correct. Two of the five
// (treasuryWithdrawn/tradeFeesClaimed) are real indexer-decoded MONEY events,
// and a global treasury event is the most likely kind to be added next — which
// is verbatim the `bought`/`sold` history this test exists to end. Proven by
// mutation: a probe constructor added via evOpenActor, and another added
// inline, both passed silently before this fix and both fail after it.
//
// If you add a fourth construction style, add it here too.
func TestSchemaContract_EveryConstructorIsPinned(t *testing.T) {
	src, err := os.ReadFile("events.go")
	if err != nil {
		t.Fatalf("cannot read events.go to count constructors: %v", err)
	}
	names := map[string]bool{}
	// Alternation, one group per style. The inline arm requires a letter
	// immediately after the quote, so it does NOT match evOpen/evOpenActor's
	// own bodies (`{"type":"` + name) or the `<name>` placeholder in their doc
	// comments; it DOES match the wire-shape examples in this file's header
	// comment, which is harmless — those name real, already-pinned events.
	for _, m := range regexp.MustCompile(`evOpen(?:Actor)?\("([A-Za-z0-9_]+)"|\{"type":"([A-Za-z0-9_]+)"`).FindAllStringSubmatch(string(src), -1) {
		if m[1] != "" {
			names[m[1]] = true
		} else {
			names[m[2]] = true
		}
	}
	if len(names) == 0 {
		t.Fatal("found no evOpen calls in events.go — this test's own premise is broken, fix it rather than deleting it")
	}
	// Every event core can emit must appear in the pinned kind set.
	pinned := map[string]bool{
		// The magi_nft-family events (2026-07-30) — pinned below by
		// TestSchemaContract_StandardNftFamily. Their shape is dictated by
		// magi_nft, not by us, so the pin asserts conformance to THEIR wire
		// format rather than freedom to choose ours.
		"init_magi_nft": true, "tokenCreated": true, "TransferSingle": true, "maturedMoved": true,
		"registered": true, "renewed": true, "faceChanged": true, "capChanged": true,
		"prepaid": true, "transferred": true, "asked": true, "answered": true,
		"reclaimed": true, "declined": true, "refunded": true, "refundPushed": true,
		"closed": true, "bought": true, "sold": true, "rated": true,
		"offeringCreated": true, "offeringUpdated": true, "offeringDeleted": true,
		// The six contract-level events (2026-07-28). ALL of them belong here:
		// this set means "core can emit it, and something pins its wire shape",
		// which is true regardless of which helper built it. An earlier version
		// of this comment claimed the five non-evOpen ones "must NOT be added
		// here" because the reverse-direction check would fail — that was a
		// consequence of the scan being too narrow, not a property of the
		// events, and it is fixed above. Do not re-exempt them.
		//
		// Being in THIS set does not claim the indexer decodes them. That is a
		// separate, narrower question answered by indexerKinds in the sibling
		// test, where init/paused/unpaused are correctly absent.
		"retired": true, "treasuryWithdrawn": true, "tradeFeesClaimed": true,
		"init": true, "paused": true, "unpaused": true,
	}
	for ev := range names {
		if !pinned[ev] {
			t.Fatalf("core/events.go emits \"ev\":%q but it is NOT pinned here. An unpinned event can drift from magi-indexer/creator_tokens_mappings.yaml undetected — which is how `bought`/`sold` came to be dropped silently by the indexer.\n\nTwo things to do, and they are NOT the same:\n  1. ALWAYS add %q to this test's `pinned` set, and give it a field-by-field TestSchemaContract_* pin with an exact field count.\n  2. ONLY IF the indexer is meant to decode it, ALSO add it to indexerKinds + the cases list in TestSchemaContract_KindConstantsCoverEveryEvName, and add the Kind constant, typed struct and fold on the indexer side.\n\nA contract-level event with no per-market scope (like init/paused/unpaused) is deliberately NOT decoded by the indexer — those get step 1 only. Do not add them to indexerKinds just to make a test pass.", ev, ev)
		}
	}
	for ev := range pinned {
		if !names[ev] {
			t.Fatalf("the pinned set names %q but core/events.go has no evOpen(%q) — a constructor was renamed or deleted; update this test and the indexer together.", ev, ev)
		}
	}
}

// TestSchemaContract_StandardNftFamily pins the three magi_nft-family events.
//
// These differ from every other event this contract emits: their shape is NOT
// ours to choose. The Magi indexer ships a stock mapping for them and folds
// them into shared tables, so a field renamed or a number quoted here does not
// produce a wrong row — it produces NO row, silently, for every consumer at
// once. That is why they are pinned field-by-field like the rest.
func TestSchemaContract_StandardNftFamily(t *testing.T) {
	// init_magi_nft — the discovery trigger. Absent it, there is no registry
	// row and every downstream view is empty.
	got := EvInitMagiNft("hive:lumen", "Lumen Creator Tokens", "LUMEN")
	want := `{"type":"init_magi_nft","attributes":{"owner":"hive:lumen","name":"Lumen Creator Tokens","symbol":"LUMEN","baseUri":""}}`
	if got != want {
		t.Fatalf("init_magi_nft wire shape drifted.\n got: %s\nwant: %s", got, want)
	}

	got = EvTokenCreated("hive:alice", 1000)
	want = `{"type":"tokenCreated","attributes":{"tokenId":"hive:alice","maxSupply":1000,"soulbound":false}}`
	if got != want {
		t.Fatalf("tokenCreated wire shape drifted.\n got: %s\nwant: %s", got, want)
	}

	// TransferSingle — `value` is a BARE NUMBER, matching the standard. It is a
	// token COUNT, never HBD; this is the one family where our money-is-a-string
	// rule does not apply, and quoting it here would make the indexer's numeric
	// column reject every row.
	got = EvTransferSingle("hive:market", "hive:bob", "hive:carol", "hive:alice", big.NewInt(250))
	want = `{"type":"TransferSingle","attributes":{"operator":"hive:market","from":"hive:bob","to":"hive:carol","id":"hive:alice","value":250}}`
	if got != want {
		t.Fatalf("TransferSingle wire shape drifted.\n got: %s\nwant: %s", got, want)
	}

	// Mint shape (from == "") and burn shape (to == "") are how the derived
	// balance views distinguish supply entering and leaving the tradable set.
	if mint := EvTransferSingle("hive:bob", "", "hive:bob", "hive:alice", big.NewInt(5)); !scContains(mint, `"from":""`) {
		t.Fatalf("mint shape must carry an EMPTY from: %s", mint)
	}
	if burn := EvTransferSingle("hive:bob", "hive:bob", "", "hive:alice", big.NewInt(5)); !scContains(burn, `"to":""`) {
		t.Fatalf("burn shape must carry an EMPTY to: %s", burn)
	}
}

// scContains avoids importing strings into this file just for two assertions.
func scContains(hay, needle string) bool {
	for i := 0; i+len(needle) <= len(hay); i++ {
		if hay[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
