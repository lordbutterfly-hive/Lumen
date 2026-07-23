package indexer

import (
	"math/big"
	"reflect"
	"strconv"
	"testing"
)

// mustDrain pulls every event out of a MockEventSource via its EventSource
// interface (not a Len()/slice shortcut), so tests exercise the same
// Events(cursor, limit) contract Poll uses.
func mustDrain(t *testing.T, src EventSource) []RawEvent {
	t.Helper()
	events, _, err := src.Events(StartCursor, 0)
	if err != nil {
		t.Fatalf("drain failed: %v", err)
	}
	return events
}

// TestIndex_CanonicalScenario ingests buildCanonicalScenario() and asserts
// every aggregate the task spec lists: delivery record (answered/missed/
// response times), per-holder positions, per-creator holder list, and
// per-market event history.
func TestIndex_CanonicalScenario(t *testing.T) {
	src := buildCanonicalScenario()
	ix := NewIndex()
	ix.Ingest(mustDrain(t, src))

	// -- positions --
	wantBal := map[string]int64{
		"alice": 700,
		"bob":   3350,
		"carol": 2000,
		"dave":  0,
	}
	for holder, want := range wantBal {
		got := ix.Position("alice", holder)
		if got.Cmp(big.NewInt(want)) != 0 {
			t.Errorf("Position(alice,%s) = %s, want %d", holder, got, want)
		}
	}

	// -- holder list: sorted, non-zero only (dave excluded) --
	holders := ix.HolderList("alice")
	wantHolders := []string{"alice", "bob", "carol"}
	if !reflect.DeepEqual(holders, wantHolders) {
		t.Errorf("HolderList(alice) = %v, want %v", holders, wantHolders)
	}

	// -- delivery record --
	rec := ix.DeliveryRecord("alice", 0)
	if rec.AnsweredCount != 2 {
		t.Errorf("AnsweredCount = %d, want 2", rec.AnsweredCount)
	}
	if rec.MissedCount != 1 {
		t.Errorf("MissedCount = %d, want 1", rec.MissedCount)
	}
	if rec.PendingCount != 1 {
		t.Errorf("PendingCount = %d, want 1 (seq3 never resolved)", rec.PendingCount)
	}
	wantResponse := []uint64{50, 40}
	if !reflect.DeepEqual(rec.ResponseBlocks, wantResponse) {
		t.Errorf("ResponseBlocks = %v, want %v", rec.ResponseBlocks, wantResponse)
	}
	// -- M1: distinct-asker breadth, zero self-deals in this scenario --
	if rec.DistinctAskers != 3 {
		t.Errorf("DistinctAskers = %d, want 3 (bob, carol, dave)", rec.DistinctAskers)
	}
	if rec.SelfDealtExcluded != 0 {
		t.Errorf("SelfDealtExcluded = %d, want 0 (alice never asks herself in this scenario)", rec.SelfDealtExcluded)
	}

	// -- delivery history: 3 resolved asks, in resolution order --
	hist := ix.DeliveryHistory("alice")
	if len(hist) != 3 {
		t.Fatalf("DeliveryHistory length = %d, want 3", len(hist))
	}
	if hist[0].Seq != 0 || !hist[0].Answered || hist[0].ResponseBlocks != 50 {
		t.Errorf("hist[0] = %+v, want seq0 answered response=50", hist[0])
	}
	if hist[1].Seq != 1 || hist[1].Answered {
		t.Errorf("hist[1] = %+v, want seq1 missed", hist[1])
	}
	if hist[2].Seq != 2 || !hist[2].Answered || hist[2].ResponseBlocks != 40 {
		t.Errorf("hist[2] = %+v, want seq2 answered response=40", hist[2])
	}

	// -- event history: every one of the 16 pushed events, in order --
	evHist := ix.EventHistory("alice")
	if len(evHist) != 16 {
		t.Fatalf("EventHistory length = %d, want 16", len(evHist))
	}

	// -- market summary (audit/cross-check snapshot) --
	summary := ix.MarketSummary("alice")
	if !summary.Known {
		t.Fatal("MarketSummary(alice).Known = false, want true")
	}
	if summary.LastFace.Cmp(big.NewInt(1500)) != 0 {
		t.Errorf("LastFace = %s, want 1500", summary.LastFace)
	}
	if summary.LastCap.Cmp(big.NewInt(200000)) != 0 {
		t.Errorf("LastCap = %s, want 200000", summary.LastCap)
	}
	if summary.Closed {
		t.Error("Closed = true, want false")
	}

	// -- stats: every event in the canonical scenario is well-formed --
	stats := ix.Stats()
	if stats.Malformed != 0 || stats.Unknown != 0 || stats.Duplicate != 0 {
		t.Errorf("canonical scenario should have zero malformed/unknown/duplicate, got %+v", stats)
	}
	if stats.Ingested != src.Len() {
		t.Errorf("Ingested = %d, want %d", stats.Ingested, src.Len())
	}

	// -- M4: GLOBAL treasury/reclaim-outflow reconstruction --
	// treasury = feePaid(10000) + renewed paid(10000) + commissionHbd from
	// both answered outcomes (120 + 80) = 20200.
	if got := ix.TreasuryHbd(); got.Cmp(big.NewInt(20200)) != 0 {
		t.Errorf("TreasuryHbd() = %s, want 20200", got)
	}
	// reclaim outflow = commissionHbd from the one reclaimed outcome (100).
	if got := ix.ReclaimOutflowHbd(); got.Cmp(big.NewInt(100)) != 0 {
		t.Errorf("ReclaimOutflowHbd() = %s, want 100", got)
	}
	// per-market breakdown (MarketSummary) must agree with the same totals,
	// since alice is the only creator in this scenario.
	ms := ix.MarketSummary("alice")
	if ms.CommissionBookedHbd.Cmp(big.NewInt(200)) != 0 {
		t.Errorf("MarketSummary(alice).CommissionBookedHbd = %s, want 200 (120+80)", ms.CommissionBookedHbd)
	}
	if ms.CommissionReturnedHbd.Cmp(big.NewInt(100)) != 0 {
		t.Errorf("MarketSummary(alice).CommissionReturnedHbd = %s, want 100", ms.CommissionReturnedHbd)
	}
}

// assertScenarioState re-runs every assertion TestIndex_CanonicalScenario
// makes, parameterized over an already-populated Index — the shared
// verifier the determinism/idempotency tests below use to prove two
// differently-constructed Index instances (or the same instance
// double-ingested) reach byte-for-byte identical state.
func assertScenarioState(t *testing.T, ix *Index, label string) {
	t.Helper()
	for holder, want := range map[string]int64{"alice": 700, "bob": 3350, "carol": 2000, "dave": 0} {
		got := ix.Position("alice", holder)
		if got.Cmp(big.NewInt(want)) != 0 {
			t.Errorf("[%s] Position(alice,%s) = %s, want %d", label, holder, got, want)
		}
	}
	if got, want := ix.HolderList("alice"), []string{"alice", "bob", "carol"}; !reflect.DeepEqual(got, want) {
		t.Errorf("[%s] HolderList = %v, want %v", label, got, want)
	}
	rec := ix.DeliveryRecord("alice", 0)
	if rec.AnsweredCount != 2 || rec.MissedCount != 1 || rec.PendingCount != 1 {
		t.Errorf("[%s] DeliveryRecord = %+v, want answered=2 missed=1 pending=1", label, rec)
	}
	if want := []uint64{50, 40}; !reflect.DeepEqual(rec.ResponseBlocks, want) {
		t.Errorf("[%s] ResponseBlocks = %v, want %v", label, rec.ResponseBlocks, want)
	}
	if got := len(ix.EventHistory("alice")); got != 16 {
		t.Errorf("[%s] EventHistory length = %d, want 16", label, got)
	}
	summary := ix.MarketSummary("alice")
	if summary.LastFace.Cmp(big.NewInt(1500)) != 0 || summary.LastCap.Cmp(big.NewInt(200000)) != 0 {
		t.Errorf("[%s] MarketSummary = %+v, want face=1500 cap=200000", label, summary)
	}
}

// TestIndex_DeterministicReplayFreshInstances proves property 1 of the task
// spec's correctness requirement: "replaying the same event stream twice
// yields identical state" — here, TWICE means two INDEPENDENT fresh Index
// instances each ingesting the identical full stream exactly once. No
// randomness, no map-iteration leak into any query result (HolderList is
// explicitly sorted for exactly this reason) may make them disagree.
func TestIndex_DeterministicReplayFreshInstances(t *testing.T) {
	events := mustDrain(t, buildCanonicalScenario())

	ixA := NewIndex()
	ixA.Ingest(events)

	ixB := NewIndex()
	ixB.Ingest(events)

	assertScenarioState(t, ixA, "instance A")
	assertScenarioState(t, ixB, "instance B")

	if statsA, statsB := ixA.Stats(), ixB.Stats(); statsA != statsB {
		t.Errorf("Stats diverged between fresh instances: A=%+v B=%+v", statsA, statsB)
	}
}

// TestIndex_PrefixThenRestEqualsWhole proves property 2 of the task spec's
// correctness requirement: "replaying a prefix then the rest equals
// replaying the whole" — exercised at several different split points, since
// a bug that only shows up when a split lands mid-escrow-lifecycle (e.g.
// between an ask and its answer) would not be caught by a single arbitrary
// split. This is the property that makes a real poller's batch size
// (Poll(src, limit)) irrelevant to correctness — see index.go's Ingest doc.
func TestIndex_PrefixThenRestEqualsWhole(t *testing.T) {
	events := mustDrain(t, buildCanonicalScenario())

	whole := NewIndex()
	whole.Ingest(events)

	for _, k := range []int{0, 1, 5, 6, 8, 10, 15, len(events)} {
		split := NewIndex()
		split.Ingest(events[:k])
		split.Ingest(events[k:])

		assertScenarioState(t, split, "split@"+string(rune('0'+k%10)))

		if wStats, sStats := whole.Stats(), split.Stats(); wStats != sStats {
			t.Errorf("split@%d: Stats diverged from whole: whole=%+v split=%+v", k, wStats, sStats)
		}
	}
}

// TestIndex_DoubleIngestIsIdempotent is the STRONGEST reading of "replaying
// the same event stream twice": the exact same batch fed into the SAME
// Index a second time must be a complete no-op on every query surface —
// not a double-count — because Index de-duplicates by (OutputID,Seq), the
// stable identity of "this exact on-chain log line" (see Ingest's doc).
// This is what makes a poller-restart-with-overlap safe.
func TestIndex_DoubleIngestIsIdempotent(t *testing.T) {
	events := mustDrain(t, buildCanonicalScenario())

	ix := NewIndex()
	ix.Ingest(events)
	assertScenarioState(t, ix, "after first ingest")
	statsAfterFirst := ix.Stats()

	ix.Ingest(events) // the EXACT same batch, again
	assertScenarioState(t, ix, "after duplicate ingest")

	statsAfterSecond := ix.Stats()
	if statsAfterSecond.Ingested != statsAfterFirst.Ingested {
		t.Errorf("Ingested changed on duplicate delivery: first=%d second=%d (must be identical — no double count)",
			statsAfterFirst.Ingested, statsAfterSecond.Ingested)
	}
	if statsAfterSecond.Duplicate != len(events) {
		t.Errorf("Duplicate = %d, want %d (every event in the second batch is a dup)", statsAfterSecond.Duplicate, len(events))
	}
}

// TestIndex_PollDrivesIngestion exercises the canonical scenario through
// Poll (the cursor-advancing path a real background poller uses) in small
// batches, proving Poll's pagination loop and a one-shot Ingest agree —
// this is ALSO a prefix-then-rest case, just via many small prefixes
// instead of one split point.
func TestIndex_PollDrivesIngestion(t *testing.T) {
	src := buildCanonicalScenario()
	ix := NewIndex()

	total := 0
	for {
		n, err := ix.Poll(src, 3)
		if err != nil {
			t.Fatalf("Poll error: %v", err)
		}
		if n == 0 {
			break
		}
		total += n
	}
	if total != src.Len() {
		t.Fatalf("Poll drained %d events, want %d", total, src.Len())
	}
	assertScenarioState(t, ix, "after Poll loop")

	// Polling again after fully drained must be a no-op, not re-ingest.
	n, err := ix.Poll(src, 3)
	if err != nil {
		t.Fatalf("Poll error: %v", err)
	}
	if n != 0 {
		t.Fatalf("expected 0 new events on an already-drained source, got %d", n)
	}
	if got := ix.Stats().Ingested; got != src.Len() {
		t.Fatalf("re-polling should not double-count Ingested: got %d want %d", got, src.Len())
	}
}

// TestIndex_UnknownAndMalformedEventsDontWedgeIngestion proves a corrupt or
// forward-incompatible log line is skipped and counted (Stats), while every
// OTHER event around it still folds correctly.
func TestIndex_UnknownAndMalformedEventsDontWedgeIngestion(t *testing.T) {
	src := NewMockEventSource()
	src.Push(`{"ev":"registered","v":1,"creator":"c1","actor":"c1","block":1,"face":"100","cap":"1000","feePaid":"10000"}`)
	src.Push(`garbage, not json`) // malformed
	src.Push(`{"ev":"prepaid","v":1,"creator":"c1","actor":"alice","block":2,"hbdPaid":"100","creditsMinted":"100"}`)
	src.Push(`{"ev":"init","owner":"c1"}`)                                                                                  // well-formed JSON, unrecognized "ev" (the wasm layer's owner-bootstrap log — not one of the 12 core-module events)
	src.Push(`{"ev":"prepaid","v":1,"creator":"c1","actor":"bob","block":3,"hbdPaid":"not-a-number","creditsMinted":"50"}`) // malformed amount
	src.Push(`{"ev":"prepaid","v":1,"creator":"c1","actor":"carol","block":4,"hbdPaid":"200","creditsMinted":"200"}`)

	ix := NewIndex()
	ix.Ingest(mustDrain(t, src))

	if got := ix.Position("c1", "alice"); got.Cmp(big.NewInt(100)) != 0 {
		t.Errorf("Position(alice) = %s, want 100", got)
	}
	if got := ix.Position("c1", "bob"); got.Sign() != 0 {
		t.Errorf("Position(bob) = %s, want 0 (malformed hbdPaid must not fold)", got)
	}
	if got := ix.Position("c1", "carol"); got.Cmp(big.NewInt(200)) != 0 {
		t.Errorf("Position(carol) = %s, want 200", got)
	}

	stats := ix.Stats()
	if stats.Malformed != 2 {
		t.Errorf("Malformed = %d, want 2 (bad json line + bad hbdPaid amount)", stats.Malformed)
	}
	if stats.Unknown != 1 {
		t.Errorf("Unknown = %d, want 1 (the init event)", stats.Unknown)
	}
	if stats.Ingested != 3 { // registered, alice's prepay, carol's prepay
		t.Errorf("Ingested = %d, want 3", stats.Ingested)
	}
}

// TestIndex_DeliveryRecordWindowing proves the `window` parameter scopes
// AnsweredCount/MissedCount/ResponseBlocks to the last N resolved asks,
// while PendingCount stays a global (unwindowed) live gauge.
func TestIndex_DeliveryRecordWindowing(t *testing.T) {
	src := buildCanonicalScenario()
	ix := NewIndex()
	ix.Ingest(mustDrain(t, src))

	// window=1: only the LAST resolved outcome (seq2, answered, response 40).
	rec := ix.DeliveryRecord("alice", 1)
	if rec.AnsweredCount != 1 || rec.MissedCount != 0 {
		t.Errorf("window=1: got answered=%d missed=%d, want answered=1 missed=0", rec.AnsweredCount, rec.MissedCount)
	}
	if want := []uint64{40}; !reflect.DeepEqual(rec.ResponseBlocks, want) {
		t.Errorf("window=1: ResponseBlocks = %v, want %v", rec.ResponseBlocks, want)
	}
	// PendingCount is NOT windowed — still 1 (seq3), regardless of window.
	if rec.PendingCount != 1 {
		t.Errorf("window=1: PendingCount = %d, want 1 (unwindowed)", rec.PendingCount)
	}

	// window=2: last two resolved outcomes (seq1 missed, seq2 answered).
	rec2 := ix.DeliveryRecord("alice", 2)
	if rec2.AnsweredCount != 1 || rec2.MissedCount != 1 {
		t.Errorf("window=2: got answered=%d missed=%d, want answered=1 missed=1", rec2.AnsweredCount, rec2.MissedCount)
	}

	// window larger than history == full history (same as window<=0).
	recBig := ix.DeliveryRecord("alice", 1000)
	recAll := ix.DeliveryRecord("alice", 0)
	if recBig.AnsweredCount != recAll.AnsweredCount || recBig.MissedCount != recAll.MissedCount {
		t.Errorf("an oversized window should equal the unwindowed record: big=%+v all=%+v", recBig, recAll)
	}
}

// TestIndex_UnknownCreatorQueriesReturnZeroValuesNotPanic proves every
// query method degrades safely for a creator this Index has never observed
// any event for — never nil-pointer, never panic.
func TestIndex_UnknownCreatorQueriesReturnZeroValuesNotPanic(t *testing.T) {
	ix := NewIndex()

	if got := ix.Position("nobody", "nobody"); got.Sign() != 0 {
		t.Errorf("Position on unknown creator = %s, want 0", got)
	}
	if got := ix.HolderList("nobody"); got != nil {
		t.Errorf("HolderList on unknown creator = %v, want nil", got)
	}
	if got := ix.DeliveryHistory("nobody"); got != nil {
		t.Errorf("DeliveryHistory on unknown creator = %v, want nil", got)
	}
	rec := ix.DeliveryRecord("nobody", 0)
	if rec.AnsweredCount != 0 || rec.MissedCount != 0 || rec.PendingCount != 0 || rec.ResponseBlocks != nil ||
		rec.DistinctAskers != 0 || rec.SelfDealtExcluded != 0 {
		t.Errorf("DeliveryRecord on unknown creator = %+v, want all zero", rec)
	}
	if got := ix.EventHistory("nobody"); got != nil {
		t.Errorf("EventHistory on unknown creator = %v, want nil", got)
	}
	summary := ix.MarketSummary("nobody")
	if summary.Known {
		t.Errorf("MarketSummary(nobody).Known = true, want false")
	}
	if summary.CommissionBookedHbd != nil || summary.CommissionReturnedHbd != nil {
		t.Errorf("MarketSummary(nobody) commission fields = %v/%v, want both nil (never observed)", summary.CommissionBookedHbd, summary.CommissionReturnedHbd)
	}
	if got := ix.TreasuryHbd(); got.Sign() != 0 {
		t.Errorf("TreasuryHbd() on empty Index = %s, want 0", got)
	}
	if got := ix.ReclaimOutflowHbd(); got.Sign() != 0 {
		t.Errorf("ReclaimOutflowHbd() on empty Index = %s, want 0", got)
	}
}

// TestIndex_ClosedEventIsIdempotent proves a duplicate "closed" event
// (core.CloseIfDrained's own documented idempotent behavior: it returns
// true both on the actual transition AND on every subsequent call against
// an already-closed market, so the wasm layer may legitimately emit
// "closed" more than once for the same market) never panics and leaves
// Closed simply true, without corrupting any other state.
func TestIndex_ClosedEventIsIdempotent(t *testing.T) {
	src := NewMockEventSource()
	src.Push(`{"ev":"registered","v":1,"creator":"c1","actor":"c1","block":1,"face":"100","cap":"1000","feePaid":"10000"}`)
	src.Push(`{"ev":"closed","v":1,"creator":"c1","actor":"keeper1","block":100}`)
	src.Push(`{"ev":"closed","v":1,"creator":"c1","actor":"keeper2","block":200}`) // duplicate signal, different keeper

	ix := NewIndex()
	ix.Ingest(mustDrain(t, src))

	summary := ix.MarketSummary("c1")
	if !summary.Closed {
		t.Fatal("Closed = false, want true")
	}
	if got := len(ix.EventHistory("c1")); got != 3 {
		t.Errorf("EventHistory length = %d, want 3 (both closed events recorded for audit, even though idempotent)", got)
	}
}

// TestIndex_AnsweredWithoutMatchingAskedStillCreditsBalance covers the
// "cursor started mid-stream" edge case documented in index.go's
// foldKnownEventLocked: an ev:answered for a seq this Index never saw
// ev:asked for (e.g. a poller that began tailing after that ask already
// happened) must still apply the balance credit — it is directly stated by
// the event — but cannot contribute a response-time sample, since the ask
// block was never observed.
func TestIndex_AnsweredWithoutMatchingAskedStillCreditsBalance(t *testing.T) {
	src := NewMockEventSource()
	src.Push(`{"ev":"registered","v":1,"creator":"c1","actor":"c1","block":1,"face":"100","cap":"1000","feePaid":"10000"}`)
	// No ev:asked for seq=99 — simulates a cursor that started after it.
	src.Push(`{"ev":"answered","v":1,"creator":"c1","actor":"c1","block":500,"seq":99,"creditsToCreator":"77","commissionHbd":"9","answerHash":"h"}`)

	ix := NewIndex()
	ix.Ingest(mustDrain(t, src))

	if got := ix.Position("c1", "c1"); got.Cmp(big.NewInt(77)) != 0 {
		t.Errorf("Position(c1,c1) = %s, want 77 (balance credit applies even without a matching ask)", got)
	}
	rec := ix.DeliveryRecord("c1", 0)
	if rec.AnsweredCount != 0 {
		t.Errorf("AnsweredCount = %d, want 0 (no matching escrow to resolve into the delivery record)", rec.AnsweredCount)
	}
	// M4: the treasury credit applies even without a matching ask, for the
	// identical "directly stated by the event itself" reason the balance
	// credit above does.
	if got := ix.TreasuryHbd(); got.Cmp(big.NewInt(10009)) != 0 { // 10000 (registered feePaid) + 9 (this answer's commissionHbd)
		t.Errorf("TreasuryHbd() = %s, want 10009", got)
	}
}

// TestIndex_MalformedAuditOnlyFieldRejectsWholeEvent sweeps every one of
// the twelve event kinds with exactly ONE field corrupted that is NOT
// itself used in balance/escrow arithmetic (e.g. "rate" on an ask, "payout"
// on a refund) and proves the WHOLE event is rejected — not folded into
// state, not appended to history, counted as Malformed — rather than
// silently accepting the event because the fold logic happened not to need
// that particular field. This is the fix for a real gap this test suite
// itself caught during development (see index.go's foldKnownEventLocked
// doc): a corrupt hbdPaid on an otherwise-valid prepaid event used to fold
// successfully because only creditsMinted was checked.
func TestIndex_MalformedAuditOnlyFieldRejectsWholeEvent(t *testing.T) {
	bad := "not-a-number"
	cases := []struct {
		name string
		data string
	}{
		{"registered.feePaid", `{"ev":"registered","v":1,"creator":"c1","actor":"c1","block":1,"face":"100","cap":"1000","feePaid":"` + bad + `"}`},
		{"renewed.paid", `{"ev":"renewed","v":1,"creator":"c1","actor":"a","block":1,"periods":1,"paid":"` + bad + `"}`},
		{"faceChanged.oldFace", `{"ev":"faceChanged","v":1,"creator":"c1","actor":"c1","block":1,"oldFace":"` + bad + `","newFace":"200"}`},
		{"capChanged.oldCap", `{"ev":"capChanged","v":1,"creator":"c1","actor":"c1","block":1,"oldCap":"` + bad + `","newCap":"2000"}`},
		{"prepaid.hbdPaid", `{"ev":"prepaid","v":1,"creator":"c1","actor":"a","block":1,"hbdPaid":"` + bad + `","creditsMinted":"100"}`},
		{"asked.commissionHbd", `{"ev":"asked","v":1,"creator":"c1","actor":"a","block":1,"seq":1,"creditsSpent":"100","commissionHbd":"` + bad + `","rate":"1000","deadlineBlocks":1,"contentHash":"h"}`},
		{"asked.rate", `{"ev":"asked","v":1,"creator":"c1","actor":"a","block":1,"seq":1,"creditsSpent":"100","commissionHbd":"10","rate":"` + bad + `","deadlineBlocks":1,"contentHash":"h"}`},
		{"refunded.payout", `{"ev":"refunded","v":1,"creator":"c1","actor":"a","block":1,"credits":"100","payout":"` + bad + `"}`},
		{"refundPushed.payout", `{"ev":"refundPushed","v":1,"creator":"c1","actor":"keeper","block":1,"holder":"h","creditsBurned":"100","payout":"` + bad + `"}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ix := NewIndex()
			ix.Ingest([]RawEvent{{OutputID: "o1", Data: c.data}})

			stats := ix.Stats()
			if stats.Malformed != 1 || stats.Ingested != 0 {
				t.Errorf("%s: stats = %+v, want Malformed=1 Ingested=0", c.name, stats)
			}
			if got := len(ix.EventHistory("c1")); got != 0 {
				t.Errorf("%s: EventHistory length = %d, want 0 (rejected event must not appear in the audit log)", c.name, got)
			}
		})
	}
}

// TestIndex_MalformedPrimaryFieldRejectsWholeEvent is the mirror of
// TestIndex_MalformedAuditOnlyFieldRejectsWholeEvent for the OTHER
// direction: corrupting the field that IS used in balance/escrow
// arithmetic for each event kind must also reject the whole event, exactly
// like the audit-only fields do — same failure mode, different field.
func TestIndex_MalformedPrimaryFieldRejectsWholeEvent(t *testing.T) {
	bad := "not-a-number"
	cases := []struct {
		name string
		data string
	}{
		{"registered.face", `{"ev":"registered","v":1,"creator":"c1","actor":"c1","block":1,"face":"` + bad + `","cap":"1000","feePaid":"10000"}`},
		{"registered.cap", `{"ev":"registered","v":1,"creator":"c1","actor":"c1","block":1,"face":"100","cap":"` + bad + `","feePaid":"10000"}`},
		{"faceChanged.newFace", `{"ev":"faceChanged","v":1,"creator":"c1","actor":"c1","block":1,"oldFace":"100","newFace":"` + bad + `"}`},
		{"capChanged.newCap", `{"ev":"capChanged","v":1,"creator":"c1","actor":"c1","block":1,"oldCap":"1000","newCap":"` + bad + `"}`},
		{"prepaid.creditsMinted", `{"ev":"prepaid","v":1,"creator":"c1","actor":"a","block":1,"hbdPaid":"100","creditsMinted":"` + bad + `"}`},
		{"transferred.amount", `{"ev":"transferred","v":1,"creator":"c1","actor":"a","block":1,"to":"b","amount":"` + bad + `"}`},
		{"asked.creditsSpent", `{"ev":"asked","v":1,"creator":"c1","actor":"a","block":1,"seq":1,"creditsSpent":"` + bad + `","commissionHbd":"10","rate":"1000","deadlineBlocks":1,"contentHash":"h"}`},
		{"answered.creditsToCreator", `{"ev":"answered","v":1,"creator":"c1","actor":"c1","block":1,"seq":1,"creditsToCreator":"` + bad + `","commissionHbd":"10","answerHash":"h"}`},
		{"answered.commissionHbd", `{"ev":"answered","v":1,"creator":"c1","actor":"c1","block":1,"seq":1,"creditsToCreator":"100","commissionHbd":"` + bad + `","answerHash":"h"}`},
		{"reclaimed.credits", `{"ev":"reclaimed","v":1,"creator":"c1","actor":"a","block":1,"seq":1,"credits":"` + bad + `","commissionHbd":"10"}`},
		{"reclaimed.commissionHbd", `{"ev":"reclaimed","v":1,"creator":"c1","actor":"a","block":1,"seq":1,"credits":"100","commissionHbd":"` + bad + `"}`},
		{"refunded.credits", `{"ev":"refunded","v":1,"creator":"c1","actor":"a","block":1,"credits":"` + bad + `","payout":"10"}`},
		{"refundPushed.creditsBurned", `{"ev":"refundPushed","v":1,"creator":"c1","actor":"keeper","block":1,"holder":"h","creditsBurned":"` + bad + `","payout":"10"}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ix := NewIndex()
			ix.Ingest([]RawEvent{{OutputID: "o1", Data: c.data}})

			stats := ix.Stats()
			if stats.Malformed != 1 || stats.Ingested != 0 {
				t.Errorf("%s: stats = %+v, want Malformed=1 Ingested=0", c.name, stats)
			}
			if got := len(ix.EventHistory("c1")); got != 0 {
				t.Errorf("%s: EventHistory length = %d, want 0", c.name, got)
			}
			if got := ix.Position("c1", "a"); got.Sign() != 0 {
				t.Errorf("%s: Position(c1,a) = %s, want 0 (no partial application)", c.name, got)
			}
		})
	}
}

// TestSatSub_ClampsAtZeroOnUnderflow directly unit-tests the defensive
// clamp satSub uses when computing a response time — a resolvedBlock
// strictly before askedBlock should never happen on a monotone chain, but
// this proves the arithmetic degrades to 0 rather than wrapping around
// uint64's range (which a bare `a-b` would do).
func TestSatSub_ClampsAtZeroOnUnderflow(t *testing.T) {
	if got := satSub(5, 10); got != 0 {
		t.Errorf("satSub(5,10) = %d, want 0", got)
	}
	if got := satSub(10, 5); got != 5 {
		t.Errorf("satSub(10,5) = %d, want 5", got)
	}
	if got := satSub(7, 7); got != 0 {
		t.Errorf("satSub(7,7) = %d, want 0", got)
	}
}

// TestIndex_PollPropagatesSourceError proves Poll surfaces an EventSource
// error to the caller without corrupting Stats (in particular, LastCursor
// must not advance on a failed fetch).
func TestIndex_PollPropagatesSourceError(t *testing.T) {
	src := NewMockEventSource()
	src.Push(`{"ev":"registered","v":1,"creator":"c1","actor":"c1","block":1,"face":"100","cap":"1000","feePaid":"10000"}`)

	ix := NewIndex()
	n, err := ix.Poll(src, 10)
	if err != nil || n != 1 {
		t.Fatalf("initial Poll failed: n=%d err=%v", n, err)
	}
	cursorAfterFirst := ix.Stats().LastCursor

	// Corrupt the stored cursor to something the source will reject, then
	// poll again — MockEventSource.Events must return ErrInvalidCursor, and
	// Poll must propagate it without touching LastCursor.
	ix.mu.Lock()
	ix.stats.LastCursor = Cursor("not-a-valid-cursor")
	ix.mu.Unlock()

	n2, err2 := ix.Poll(src, 10)
	if err2 != ErrInvalidCursor {
		t.Fatalf("Poll error = %v, want ErrInvalidCursor", err2)
	}
	if n2 != 0 {
		t.Fatalf("Poll returned n=%d on error, want 0", n2)
	}
	if got := ix.Stats().LastCursor; got != Cursor("not-a-valid-cursor") {
		t.Fatalf("LastCursor = %q, want unchanged from the corrupted value (Poll must not silently reset it)", got)
	}
	_ = cursorAfterFirst
}

// TestIndex_MultipleCreatorsAreIsolated proves per-creator state never
// leaks across markets — a holder can appear in two different creators'
// balances independently, and querying one creator must never see the
// other's data.
func TestIndex_MultipleCreatorsAreIsolated(t *testing.T) {
	src := NewMockEventSource()
	src.Push(`{"ev":"registered","v":1,"creator":"c1","actor":"c1","block":1,"face":"100","cap":"1000","feePaid":"10000"}`)
	src.Push(`{"ev":"registered","v":1,"creator":"c2","actor":"c2","block":1,"face":"200","cap":"2000","feePaid":"10000"}`)
	src.Push(`{"ev":"prepaid","v":1,"creator":"c1","actor":"alice","block":2,"hbdPaid":"500","creditsMinted":"500"}`)
	src.Push(`{"ev":"prepaid","v":1,"creator":"c2","actor":"alice","block":2,"hbdPaid":"900","creditsMinted":"900"}`)

	ix := NewIndex()
	ix.Ingest(mustDrain(t, src))

	if got := ix.Position("c1", "alice"); got.Cmp(big.NewInt(500)) != 0 {
		t.Errorf("Position(c1,alice) = %s, want 500", got)
	}
	if got := ix.Position("c2", "alice"); got.Cmp(big.NewInt(900)) != 0 {
		t.Errorf("Position(c2,alice) = %s, want 900", got)
	}
	if got := len(ix.EventHistory("c1")); got != 2 {
		t.Errorf("EventHistory(c1) length = %d, want 2", got)
	}
	if got := len(ix.EventHistory("c2")); got != 2 {
		t.Errorf("EventHistory(c2) length = %d, want 2", got)
	}
}

// ---------------------------------------------------------------------------
// M1 — delivery record self-deal exclusion (PRUNED-ADJUDICATION-2026-07-21.md)
// ---------------------------------------------------------------------------

// TestIndex_DeliveryRecord_PureSelfDealsReportZeroAndAreVisible proves the
// exact M1 exploit this fix closes: a creator who only ever asks (and
// answers/reclaims) themself must show AnsweredCount=0 and MissedCount=0 —
// not the flawless (or sabotaged) record self-dealing would otherwise
// manufacture — while SelfDealtExcluded makes the exclusion itself visible
// rather than a silent drop, and DeliveryHistory (the raw, unfiltered
// primitive) still shows every one of them, since the exclusion is scoped
// to the display-grade aggregate only.
func TestIndex_DeliveryRecord_PureSelfDealsReportZeroAndAreVisible(t *testing.T) {
	src := NewMockEventSource()
	src.Push(`{"ev":"registered","v":1,"creator":"selfdealer","actor":"selfdealer","block":1,"face":"100","cap":"1000000","feePaid":"10000"}`)
	src.Push(`{"ev":"prepaid","v":1,"creator":"selfdealer","actor":"selfdealer","block":2,"hbdPaid":"1000","creditsMinted":"1000"}`)
	// Three self-asks: two self-answered ("flawless record" manufacture),
	// one self-reclaimed (proving exclusion isn't one-sided toward only
	// hiding the flattering outcome).
	src.Push(`{"ev":"asked","v":1,"creator":"selfdealer","actor":"selfdealer","block":10,"seq":0,"creditsSpent":"100","commissionHbd":"12","rate":"1000000","deadlineBlocks":28800,"contentHash":"q0"}`)
	src.Push(`{"ev":"answered","v":1,"creator":"selfdealer","actor":"selfdealer","block":15,"seq":0,"creditsToCreator":"100","commissionHbd":"12","answerHash":"a0"}`)
	src.Push(`{"ev":"asked","v":1,"creator":"selfdealer","actor":"selfdealer","block":20,"seq":1,"creditsSpent":"100","commissionHbd":"12","rate":"1000000","deadlineBlocks":28800,"contentHash":"q1"}`)
	src.Push(`{"ev":"answered","v":1,"creator":"selfdealer","actor":"selfdealer","block":25,"seq":1,"creditsToCreator":"100","commissionHbd":"12","answerHash":"a1"}`)
	src.Push(`{"ev":"asked","v":1,"creator":"selfdealer","actor":"selfdealer","block":30,"seq":2,"creditsSpent":"100","commissionHbd":"12","rate":"1000000","deadlineBlocks":28800,"contentHash":"q2"}`)
	src.Push(`{"ev":"reclaimed","v":1,"creator":"selfdealer","actor":"selfdealer","block":40000,"seq":2,"credits":"100","commissionHbd":"12"}`)

	ix := NewIndex()
	ix.Ingest(mustDrain(t, src))

	rec := ix.DeliveryRecord("selfdealer", 0)
	if rec.AnsweredCount != 0 {
		t.Errorf("AnsweredCount = %d, want 0 (self-deals must not count as delivery)", rec.AnsweredCount)
	}
	if rec.MissedCount != 0 {
		t.Errorf("MissedCount = %d, want 0 (self-deals must not count as a miss either)", rec.MissedCount)
	}
	if rec.DistinctAskers != 0 {
		t.Errorf("DistinctAskers = %d, want 0 (no third-party asker exists in this scenario)", rec.DistinctAskers)
	}
	if rec.SelfDealtExcluded != 3 {
		t.Errorf("SelfDealtExcluded = %d, want 3 (all three resolved asks were self-deals, and the exclusion must be visible, not silently dropped)", rec.SelfDealtExcluded)
	}
	if len(rec.ResponseBlocks) != 0 {
		t.Errorf("ResponseBlocks = %v, want empty (no non-self-dealt answer exists)", rec.ResponseBlocks)
	}

	// The raw primitive is UNFILTERED — an auditor must still be able to see
	// that these self-deals happened at all.
	hist := ix.DeliveryHistory("selfdealer")
	if len(hist) != 3 {
		t.Fatalf("DeliveryHistory length = %d, want 3 (self-deals still appear in the raw, unfiltered history)", len(hist))
	}
	for _, d := range hist {
		if d.Asker != "selfdealer" {
			t.Errorf("DeliveryHistory entry asker = %q, want selfdealer (test setup bug)", d.Asker)
		}
	}
}

// TestIndex_DeliveryRecord_DistinctAskersCountsUniqueThirdPartyAskers
// proves DistinctAskers reports exactly N for a record built from N
// distinct third-party askers — the "funder breadth" signal M1 adds so a
// UI can down-weight a record built from very few distinct askers, even
// when none of them are self-deals.
func TestIndex_DeliveryRecord_DistinctAskersCountsUniqueThirdPartyAskers(t *testing.T) {
	src := NewMockEventSource()
	src.Push(`{"ev":"registered","v":1,"creator":"popular","actor":"popular","block":1,"face":"100","cap":"1000000","feePaid":"10000"}`)

	// 4 distinct askers (fan1..fan4), one of whom (fan1) asks TWICE — proves
	// DistinctAskers counts UNIQUE askers, not resolved-ask count (5 asks,
	// 4 distinct askers).
	askers := []string{"fan1", "fan2", "fan3", "fan4", "fan1"}
	seq := uint64(0)
	block := uint64(10)
	for _, asker := range askers {
		src.Push(`{"ev":"asked","v":1,"creator":"popular","actor":"` + asker + `","block":` + itoa(block) + `,"seq":` + itoa(seq) + `,"creditsSpent":"100","commissionHbd":"12","rate":"1000000","deadlineBlocks":28800,"contentHash":"q"}`)
		src.Push(`{"ev":"answered","v":1,"creator":"popular","actor":"popular","block":` + itoa(block+5) + `,"seq":` + itoa(seq) + `,"creditsToCreator":"100","commissionHbd":"12","answerHash":"a"}`)
		seq++
		block += 10
	}

	ix := NewIndex()
	ix.Ingest(mustDrain(t, src))

	rec := ix.DeliveryRecord("popular", 0)
	if rec.AnsweredCount != 5 {
		t.Errorf("AnsweredCount = %d, want 5", rec.AnsweredCount)
	}
	if rec.DistinctAskers != 4 {
		t.Errorf("DistinctAskers = %d, want 4 (fan1 asked twice but counts once)", rec.DistinctAskers)
	}
	if rec.SelfDealtExcluded != 0 {
		t.Errorf("SelfDealtExcluded = %d, want 0 (no self-deals in this scenario)", rec.SelfDealtExcluded)
	}
}

// itoa is a tiny local helper so the distinct-askers test above can build
// event JSON without importing strconv just for this — mirrors the file's
// own existing hand-written-JSON convention (scenario_test.go).
func itoa(n uint64) string { return strconv.FormatUint(n, 10) }

// ---------------------------------------------------------------------------
// M4 — event stream reconstructs the HBD money model
// (PRUNED-ADJUDICATION-2026-07-21.md)
// ---------------------------------------------------------------------------

// TestIndex_TreasuryAndReclaimOutflow_AskAnswerAskReclaim is the exact M4
// "prove" scenario: replaying an Ask->Answer stream and an Ask->Reclaim
// stream lets the indexer reconstruct the treasury credit and the reclaim
// HBD outflow exactly, including the registration/renewal legs that also
// land in the same global kTreasury() key.
func TestIndex_TreasuryAndReclaimOutflow_AskAnswerAskReclaim(t *testing.T) {
	src := NewMockEventSource()
	src.Push(`{"ev":"registered","v":1,"creator":"writer1","actor":"writer1","block":1,"face":"1000","cap":"1000000","feePaid":"10000"}`)
	src.Push(`{"ev":"renewed","v":1,"creator":"writer1","actor":"fan9","block":2,"periods":1,"paid":"10000"}`)

	// Ask -> Answer: commission books to treasury.
	src.Push(`{"ev":"asked","v":1,"creator":"writer1","actor":"reader1","block":10,"seq":0,"creditsSpent":"1000","commissionHbd":"120","rate":"1000000","deadlineBlocks":28800,"contentHash":"q0"}`)
	src.Push(`{"ev":"answered","v":1,"creator":"writer1","actor":"writer1","block":15,"seq":0,"creditsToCreator":"1000","commissionHbd":"120","answerHash":"a0"}`)

	// Ask -> Reclaim: commission returns to the asker, never reaching treasury.
	src.Push(`{"ev":"prepaid","v":1,"creator":"writer1","actor":"reader2","block":19,"hbdPaid":"500","creditsMinted":"500"}`)
	src.Push(`{"ev":"asked","v":1,"creator":"writer1","actor":"reader2","block":20,"seq":1,"creditsSpent":"500","commissionHbd":"60","rate":"1000000","deadlineBlocks":28800,"contentHash":"q1"}`)
	src.Push(`{"ev":"reclaimed","v":1,"creator":"writer1","actor":"reader2","block":40000,"seq":1,"credits":"500","commissionHbd":"60"}`)

	ix := NewIndex()
	ix.Ingest(mustDrain(t, src))

	// treasury = feePaid(10000) + renewed paid(10000) + answered commission(120) = 20120
	wantTreasury := big.NewInt(20120)
	if got := ix.TreasuryHbd(); got.Cmp(wantTreasury) != 0 {
		t.Errorf("TreasuryHbd() = %s, want %s", got, wantTreasury)
	}
	// reclaim outflow = reclaimed commission(60) only — the reclaimed leg
	// never touched treasury at all.
	wantOutflow := big.NewInt(60)
	if got := ix.ReclaimOutflowHbd(); got.Cmp(wantOutflow) != 0 {
		t.Errorf("ReclaimOutflowHbd() = %s, want %s", got, wantOutflow)
	}
	// Per-market breakdown must agree.
	ms := ix.MarketSummary("writer1")
	if ms.CommissionBookedHbd.Cmp(big.NewInt(120)) != 0 {
		t.Errorf("CommissionBookedHbd = %s, want 120", ms.CommissionBookedHbd)
	}
	if ms.CommissionReturnedHbd.Cmp(big.NewInt(60)) != 0 {
		t.Errorf("CommissionReturnedHbd = %s, want 60", ms.CommissionReturnedHbd)
	}
	// Credits-side sanity: writer1 was paid 1000 credits on the answer;
	// reader2 got their 500 credits back on the reclaim.
	if got := ix.Position("writer1", "writer1"); got.Cmp(big.NewInt(1000)) != 0 {
		t.Errorf("Position(writer1,writer1) = %s, want 1000", got)
	}
	if got := ix.Position("writer1", "reader2"); got.Cmp(big.NewInt(500)) != 0 {
		t.Errorf("Position(writer1,reader2) = %s, want 500", got)
	}
}

// TestIndex_MalformedCommissionHbdRejectsWholeEventNoPartialUpdate covers
// the M4 fix's own failure mode: a corrupt commissionHbd on an otherwise-
// valid answered/reclaimed event must reject the WHOLE event — no credit
// balance change AND no treasury/reclaim-outflow total change — exactly
// like every other documented field in this file (foldKnownEventLocked's
// own doc: "deliberately not just the ones this fold happens to use
// arithmetically"). The generic table tests
// (TestIndex_Malformed*FieldRejectsWholeEvent) already cover the
// stats/EventHistory half of this for these two new cases; this test adds
// the treasury/reclaim-outflow half those tables' shared assertions don't
// check.
func TestIndex_MalformedCommissionHbdRejectsWholeEventNoPartialUpdate(t *testing.T) {
	bad := "not-a-number"

	t.Run("answered.commissionHbd", func(t *testing.T) {
		ix := NewIndex()
		ix.Ingest([]RawEvent{{OutputID: "o1", Data: `{"ev":"answered","v":1,"creator":"c1","actor":"c1","block":1,"seq":1,"creditsToCreator":"100","commissionHbd":"` + bad + `","answerHash":"h"}`}})

		if got := ix.Position("c1", "c1"); got.Sign() != 0 {
			t.Errorf("Position(c1,c1) = %s, want 0 (no partial credit application)", got)
		}
		if got := ix.TreasuryHbd(); got.Sign() != 0 {
			t.Errorf("TreasuryHbd() = %s, want 0 (no partial treasury update)", got)
		}
	})

	t.Run("reclaimed.commissionHbd", func(t *testing.T) {
		ix := NewIndex()
		ix.Ingest([]RawEvent{{OutputID: "o1", Data: `{"ev":"reclaimed","v":1,"creator":"c1","actor":"bob","block":1,"seq":1,"credits":"100","commissionHbd":"` + bad + `"}`}})

		if got := ix.Position("c1", "bob"); got.Sign() != 0 {
			t.Errorf("Position(c1,bob) = %s, want 0 (no partial credit application)", got)
		}
		if got := ix.ReclaimOutflowHbd(); got.Sign() != 0 {
			t.Errorf("ReclaimOutflowHbd() = %s, want 0 (no partial reclaim-outflow update)", got)
		}
	})
}

// ---------------------------------------------------------------------------
// M5 — re-registration clears the closed latch and the delivery record
// (PRUNED-ADJUDICATION-2026-07-21.md)
// ---------------------------------------------------------------------------

// TestIndex_ReRegistrationClearsClosedLatchAndDeliveryRecord is the exact
// M5 "prove" scenario: incarnation 1 closes with a missed mark; incarnation
// 2 re-registers and shows ACTIVE with a clean record, not the old missed
// mark. The full audit trail (EventHistory) must still show every event
// across BOTH incarnations — only the delivery record / closed flag /
// live-position tracking reset, never the permanent log.
func TestIndex_ReRegistrationClearsClosedLatchAndDeliveryRecord(t *testing.T) {
	// ONE shared MockEventSource for the whole stream (both incarnations),
	// ingested in two batches by slicing — NOT two separate
	// NewMockEventSource() instances: MockEventSource.Push assigns
	// synthetic OutputIDs starting at "mock-0" PER INSTANCE (mock_source.go
	// doc), so two independent sources would collide on identical
	// (OutputID,Seq) pairs and Index's own de-dup (Ingest's documented
	// (OutputID,Seq) contract) would silently treat incarnation 2's
	// "registered" event as a redelivery of incarnation 1's, never folding
	// it at all. One source with a prefix/rest split (mirrors
	// TestIndex_PrefixThenRestEqualsWhole's own convention) sidesteps that
	// entirely and is also the more realistic shape: a real poller feeds
	// one continuous stream, not two independent sources.
	src := NewMockEventSource()
	// -- incarnation 1: register, ask+reclaim (a MISSED mark), then close --
	src.Push(`{"ev":"registered","v":1,"creator":"comeback","actor":"comeback","block":1,"face":"100","cap":"1000000","feePaid":"10000"}`)
	src.Push(`{"ev":"asked","v":1,"creator":"comeback","actor":"bob","block":10,"seq":0,"creditsSpent":"50","commissionHbd":"12","rate":"1000000","deadlineBlocks":28800,"contentHash":"q0"}`)
	src.Push(`{"ev":"reclaimed","v":1,"creator":"comeback","actor":"bob","block":40000,"seq":0,"credits":"50","commissionHbd":"12"}`)
	src.Push(`{"ev":"closed","v":1,"creator":"comeback","actor":"","block":40001}`)
	// -- incarnation 2: re-register --
	src.Push(`{"ev":"registered","v":1,"creator":"comeback","actor":"comeback","block":50000,"face":"200","cap":"2000000","feePaid":"10000"}`)

	events := mustDrain(t, src)
	if len(events) != 5 {
		t.Fatalf("test setup bug: pushed 5 events, drained %d", len(events))
	}

	ix := NewIndex()
	ix.Ingest(events[:4]) // incarnation 1 only

	// Sanity-check incarnation 1's state before the fix even applies.
	rec1 := ix.DeliveryRecord("comeback", 0)
	if rec1.MissedCount != 1 {
		t.Fatalf("incarnation 1: MissedCount = %d, want 1 (setup bug)", rec1.MissedCount)
	}
	if !ix.MarketSummary("comeback").Closed {
		t.Fatalf("incarnation 1: Closed = false, want true (setup bug)")
	}
	if got := ix.HolderList("comeback"); len(got) != 0 {
		t.Fatalf("incarnation 1: HolderList = %v, want empty (bob reclaimed everything back)", got)
	}

	ix.Ingest(events[4:]) // incarnation 2's re-registration

	summary := ix.MarketSummary("comeback")
	if summary.Closed {
		t.Error("incarnation 2: Closed = true, want false (M5: re-registration must clear the closed latch)")
	}
	if summary.LastFace.Cmp(big.NewInt(200)) != 0 {
		t.Errorf("incarnation 2: LastFace = %s, want 200 (the new incarnation's own posted face)", summary.LastFace)
	}

	rec2 := ix.DeliveryRecord("comeback", 0)
	if rec2.MissedCount != 0 {
		t.Errorf("incarnation 2: MissedCount = %d, want 0 (M5: must not inherit incarnation 1's missed mark)", rec2.MissedCount)
	}
	if rec2.AnsweredCount != 0 {
		t.Errorf("incarnation 2: AnsweredCount = %d, want 0 (clean record)", rec2.AnsweredCount)
	}
	if rec2.PendingCount != 0 {
		t.Errorf("incarnation 2: PendingCount = %d, want 0 (no stale PENDING entries carried over)", rec2.PendingCount)
	}
	if got := len(ix.DeliveryHistory("comeback")); got != 0 {
		t.Errorf("incarnation 2: DeliveryHistory length = %d, want 0 (delivery record starts fresh)", got)
	}

	// The permanent audit trail is NEVER reset — every event from BOTH
	// incarnations must still be visible.
	if got := len(ix.EventHistory("comeback")); got != 5 {
		t.Errorf("EventHistory length = %d, want 5 (4 from incarnation 1 + 1 from incarnation 2 — history is never reset)", got)
	}

	// commissionBookedHbd/commissionReturnedHbd are LIFETIME totals, not a
	// reputation signal — must NOT reset (money already in the global
	// treasury doesn't stop existing because a creator re-registered).
	if summary.CommissionReturnedHbd.Cmp(big.NewInt(12)) != 0 {
		t.Errorf("incarnation 2: CommissionReturnedHbd = %s, want 12 (lifetime total, never reset by re-registration)", summary.CommissionReturnedHbd)
	}
}

// TestIndex_ReRegistrationOfNeverClosedMarketIsANoOp proves the M5 fix's
// guard is scoped correctly: a `registered` event for a market this Index
// has NEVER seen `closed` must NOT wipe anything — the reset path is keyed
// specifically on `m.closed == true`, not on "creator already known."
// (Register's own on-chain duplicate guard would reject a genuine
// double-register of a still-ACTIVE market anyway, but this Index must not
// itself go destructive on an unexpected/out-of-order stream.)
func TestIndex_ReRegistrationOfNeverClosedMarketIsANoOp(t *testing.T) {
	src := NewMockEventSource()
	src.Push(`{"ev":"registered","v":1,"creator":"c1","actor":"c1","block":1,"face":"100","cap":"1000","feePaid":"10000"}`)
	src.Push(`{"ev":"prepaid","v":1,"creator":"c1","actor":"alice","block":2,"hbdPaid":"500","creditsMinted":"500"}`)
	src.Push(`{"ev":"asked","v":1,"creator":"c1","actor":"alice","block":10,"seq":0,"creditsSpent":"100","commissionHbd":"12","rate":"1000000","deadlineBlocks":28800,"contentHash":"q0"}`)
	src.Push(`{"ev":"answered","v":1,"creator":"c1","actor":"c1","block":15,"seq":0,"creditsToCreator":"100","commissionHbd":"12","answerHash":"a0"}`)
	// A SECOND "registered" event, but the market was never closed — should
	// never happen on a real chain (Register's duplicate guard), but this
	// Index must still not destroy prior state if it somehow does.
	src.Push(`{"ev":"registered","v":1,"creator":"c1","actor":"c1","block":20,"face":"150","cap":"1500","feePaid":"10000"}`)

	ix := NewIndex()
	ix.Ingest(mustDrain(t, src))

	if ix.MarketSummary("c1").Closed {
		t.Fatal("Closed = true, want false (never closed in this stream)")
	}
	rec := ix.DeliveryRecord("c1", 0)
	if rec.AnsweredCount != 1 {
		t.Errorf("AnsweredCount = %d, want 1 (a second registered event with closed==false must not wipe the delivery record)", rec.AnsweredCount)
	}
	if got := ix.Position("c1", "alice"); got.Cmp(big.NewInt(400)) != 0 {
		t.Errorf("Position(c1,alice) = %s, want 400 (500 prepaid - 100 spent on the ask; must not be wiped)", got)
	}
}
