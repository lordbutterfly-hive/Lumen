package indexer

import (
	"math/big"
	"testing"
)

// TestIndex_CanonicalScenario is the exact scenario the build spec calls
// for: "a round_created; 5 accounts bet; resolved; 3 of the winners claim, 2
// don't." Asserts every aggregate listed in the spec:
//   - bettors==5
//   - MyUnclaimed for the 2 non-claimers lists the round
//   - MyUnclaimed for a claimer is empty
//   - HouseTaken sums correctly
func TestIndex_CanonicalScenario(t *testing.T) {
	src := BuildCanonicalScenario()
	ix := NewIndex()
	ix.Ingest(mustDrain(t, src))

	// -- bettors==5 --
	if got := ix.Bettors(1); got != 5 {
		t.Fatalf("Bettors(1) = %d, want 5", got)
	}

	summary, ok := ix.RoundSummary(1)
	if !ok {
		t.Fatal("RoundSummary(1) not found")
	}
	if summary.Creator != "hive:lordbutterfly" {
		t.Errorf("Creator = %q, want hive:lordbutterfly", summary.Creator)
	}
	if !summary.Resolved {
		t.Error("Resolved = false, want true")
	}
	if summary.State != StateSettled {
		t.Errorf("State = %q, want %q", summary.State, StateSettled)
	}
	if !summary.WinnerValid || summary.Winner != 2 {
		t.Errorf("Winner/WinnerValid = %d/%v, want 2/true", summary.Winner, summary.WinnerValid)
	}
	if summary.Bettors != 5 {
		t.Errorf("summary.Bettors = %d, want 5", summary.Bettors)
	}
	wantTotal := big.NewInt(5000 + 3000 + 2000 + 1000 + 4000)
	if summary.TotalBets.Cmp(wantTotal) != 0 {
		t.Errorf("TotalBets = %s, want %s", summary.TotalBets, wantTotal)
	}

	// -- MyUnclaimed for the 2 non-claimers lists the round --
	for _, acct := range []string{"hive:dave", "hive:erin"} {
		got := ix.MyUnclaimed(acct)
		if len(got) != 1 || got[0] != 1 {
			t.Errorf("MyUnclaimed(%s) = %v, want [1]", acct, got)
		}
	}

	// -- MyUnclaimed for a claimer is empty --
	for _, acct := range []string{"hive:alice", "hive:bob", "hive:carol"} {
		got := ix.MyUnclaimed(acct)
		if len(got) != 0 {
			t.Errorf("MyUnclaimed(%s) = %v, want []", acct, got)
		}
	}

	// An account that never bet at all must also come back empty, not error.
	if got := ix.MyUnclaimed("hive:nobody"); len(got) != 0 {
		t.Errorf("MyUnclaimed(nobody) = %v, want []", got)
	}

	// -- HouseTaken sums correctly (300 + 50 = 350) --
	if got := ix.HouseTaken("hive"); got.Cmp(big.NewInt(350)) != 0 {
		t.Errorf("HouseTaken(hive) = %s, want 350", got)
	}
	// An asset that never appeared must read back zero, not nil / panic.
	if got := ix.HouseTaken("hbd"); got.Sign() != 0 {
		t.Errorf("HouseTaken(hbd) = %s, want 0", got)
	}

	// -- Per-account position detail, spot-checked --
	positions := ix.MyPositions("hive:alice")
	if len(positions) != 1 {
		t.Fatalf("MyPositions(alice) = %d rounds, want 1", len(positions))
	}
	p := positions[0]
	if p.TotalStaked.Cmp(big.NewInt(5000)) != 0 {
		t.Errorf("alice TotalStaked = %s, want 5000", p.TotalStaked)
	}
	if stake, ok := p.StakeByOutcome[2]; !ok || stake.Cmp(big.NewInt(5000)) != 0 {
		t.Errorf("alice StakeByOutcome[2] = %v, want 5000", p.StakeByOutcome)
	}
	if !p.Claimed || p.ClaimPayout.Cmp(big.NewInt(4900)) != 0 || p.ClaimAsset != "hive" {
		t.Errorf("alice claim = claimed=%v payout=%v asset=%s, want claimed=true payout=4900 asset=hive",
			p.Claimed, p.ClaimPayout, p.ClaimAsset)
	}

	davePositions := ix.MyPositions("hive:dave")
	if len(davePositions) != 1 || davePositions[0].Claimed {
		t.Errorf("dave positions = %+v, want 1 unclaimed position", davePositions)
	}

	stats := ix.Stats()
	if stats.Malformed != 0 || stats.Unknown != 0 {
		t.Errorf("canonical scenario should have zero malformed/unknown, got %+v", stats)
	}
	if stats.Ingested != src.Len() {
		t.Errorf("Ingested = %d, want %d (all %d canonical events are well-formed known kinds)",
			stats.Ingested, src.Len(), src.Len())
	}
}

// TestIndex_PollDrivesIngestion exercises the same scenario through Poll
// (the cursor-advancing path a real background poller uses) instead of a
// one-shot Ingest, in small batches, proving Poll's pagination loop and
// Ingest's direct path agree.
func TestIndex_PollDrivesIngestion(t *testing.T) {
	src := BuildCanonicalScenario()
	ix := NewIndex()

	total := 0
	for {
		n, err := ix.Poll(src, 2)
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
	if got := ix.Bettors(1); got != 5 {
		t.Fatalf("Bettors(1) after Poll = %d, want 5", got)
	}
	if got := ix.HouseTaken("hive"); got.Cmp(big.NewInt(350)) != 0 {
		t.Fatalf("HouseTaken after Poll = %s, want 350", got)
	}

	// Polling again after fully drained must be a no-op, not re-ingest.
	n, err := ix.Poll(src, 2)
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

// TestIndexDistinctBettorCount proves Bettors() counts DISTINCT accounts,
// not bet events — a single account betting twice in the same round (adding
// to their stake) must still count as ONE bettor, per the task spec's
// explicit "distinct acct count from ev:bet".
func TestIndexDistinctBettorCount(t *testing.T) {
	src := NewMockEventSource()
	src.Push(`{"ev":"round_created","roundId":9,"by":"hive:owner"}`)
	src.Push(`{"ev":"bet","roundId":9,"outcome":0,"acct":"hive:alice","amount":"100"}`)
	src.Push(`{"ev":"bet","roundId":9,"outcome":1,"acct":"hive:alice","amount":"50"}`) // alice bets AGAIN, different outcome
	src.Push(`{"ev":"bet","roundId":9,"outcome":0,"acct":"hive:bob","amount":"200"}`)

	ix := NewIndex()
	ix.Ingest(mustDrain(t, src))

	if got := ix.Bettors(9); got != 2 {
		t.Fatalf("Bettors(9) = %d, want 2 (alice counted once despite 2 bets)", got)
	}
	positions := ix.MyPositions("hive:alice")
	if len(positions) != 1 {
		t.Fatalf("expected alice to have 1 round entry (not 2), got %d", len(positions))
	}
	p := positions[0]
	if p.TotalStaked.Cmp(big.NewInt(150)) != 0 {
		t.Fatalf("alice TotalStaked = %s, want 150 (100+50 across two bets)", p.TotalStaked)
	}
	if s0, ok := p.StakeByOutcome[0]; !ok || s0.Cmp(big.NewInt(100)) != 0 {
		t.Fatalf("alice StakeByOutcome[0] = %v, want 100", p.StakeByOutcome)
	}
	if s1, ok := p.StakeByOutcome[1]; !ok || s1.Cmp(big.NewInt(50)) != 0 {
		t.Fatalf("alice StakeByOutcome[1] = %v, want 50", p.StakeByOutcome)
	}

	summary, _ := ix.RoundSummary(9)
	if summary.TotalBets.Cmp(big.NewInt(350)) != 0 { // 100+50+200
		t.Fatalf("TotalBets = %s, want 350", summary.TotalBets)
	}
}

// TestIndex_UnknownAndMalformedEventsDontWedgeIngestion proves a corrupt or
// forward-incompatible log line is skipped and counted (Stats), while every
// OTHER event around it still folds correctly — the graceful-degradation
// contract from events.go, exercised at the Index layer.
func TestIndex_UnknownAndMalformedEventsDontWedgeIngestion(t *testing.T) {
	src := NewMockEventSource()
	src.Push(`{"ev":"round_created","roundId":1,"by":"hive:owner"}`)
	src.Push(`garbage, not json`)                                                           // malformed
	src.Push(`{"ev":"bet","roundId":1,"outcome":0,"acct":"hive:alice","amount":"100"}`)     // valid, after the garbage
	src.Push(`{"ev":"future_kind","roundId":1,"whatever":true}`)                            // unknown ev, well-formed JSON
	src.Push(`{"ev":"bet","roundId":1,"outcome":0,"acct":"hive:bob","amount":"not-a-num"}`) // malformed amount
	src.Push(`{"ev":"bet","roundId":1,"outcome":0,"acct":"hive:carol","amount":"200"}`)     // valid, after the bad amount

	ix := NewIndex()
	ix.Ingest(mustDrain(t, src))

	if got := ix.Bettors(1); got != 2 {
		t.Fatalf("Bettors(1) = %d, want 2 (alice, carol — bob's malformed-amount bet must not count)", got)
	}
	stats := ix.Stats()
	if stats.Malformed != 2 {
		t.Errorf("Malformed = %d, want 2 (bad json line + bad amount)", stats.Malformed)
	}
	if stats.Unknown != 1 {
		t.Errorf("Unknown = %d, want 1", stats.Unknown)
	}
	if stats.Ingested != 3 { // round_created, alice's bet, carol's bet
		t.Errorf("Ingested = %d, want 3", stats.Ingested)
	}
}

// TestIndex_VoidStaleEventPath exercises the OTHER resolution path
// (VoidStale's "ev":"voided", distinct from Settle's "ev":"resolved") to
// make sure Index treats it as a full terminal/resolved state — including
// making bettors show up in MyUnclaimed once voided, exactly like a settled
// round.
func TestIndex_VoidStaleEventPath(t *testing.T) {
	src := NewMockEventSource()
	src.Push(`{"ev":"round_created","roundId":2,"by":"hive:owner"}`)
	src.Push(`{"ev":"bet","roundId":2,"outcome":0,"acct":"hive:alice","amount":"1000"}`)
	src.Push(`{"ev":"voided","roundId":2,"reason":"stale_feed"}`)

	ix := NewIndex()
	ix.Ingest(mustDrain(t, src))

	summary, ok := ix.RoundSummary(2)
	if !ok {
		t.Fatal("round 2 missing")
	}
	if !summary.Resolved || summary.State != StateVoid {
		t.Fatalf("summary = %+v, want Resolved=true State=void", summary)
	}
	if summary.WinnerValid {
		t.Fatal("WinnerValid should be false for a void round")
	}
	if summary.VoidReason != "stale_feed" {
		t.Fatalf("VoidReason = %q, want stale_feed", summary.VoidReason)
	}
	got := ix.MyUnclaimed("hive:alice")
	if len(got) != 1 || got[0] != 2 {
		t.Fatalf("MyUnclaimed(alice) = %v, want [2] (voided round, never claimed refund)", got)
	}

	// Now alice claims her void refund; MyUnclaimed must clear.
	claimSrc := NewMockEventSource()
	claimSrc.Push(`{"ev":"claim","roundId":2,"acct":"hive:alice","payout":"1000","asset":"hive"}`)
	ix.Ingest(mustDrain(t, claimSrc))
	if got := ix.MyUnclaimed("hive:alice"); len(got) != 0 {
		t.Fatalf("MyUnclaimed(alice) after claim = %v, want []", got)
	}
}

// TestIndex_UnresolvedRoundExcludedFromUnclaimed proves an OPEN (not yet
// resolved) round a user bet in does NOT show up in MyUnclaimed — that
// surface is specifically for resolved-but-unclaimed rounds (task spec),
// not "every round you've ever bet in."
func TestIndex_UnresolvedRoundExcludedFromUnclaimed(t *testing.T) {
	src := NewMockEventSource()
	src.Push(`{"ev":"round_created","roundId":3,"by":"hive:owner"}`)
	src.Push(`{"ev":"bet","roundId":3,"outcome":0,"acct":"hive:alice","amount":"1000"}`)

	ix := NewIndex()
	ix.Ingest(mustDrain(t, src))

	if got := ix.MyUnclaimed("hive:alice"); len(got) != 0 {
		t.Fatalf("MyUnclaimed(alice) on an OPEN round = %v, want [] (not resolved yet)", got)
	}
	summary, _ := ix.RoundSummary(3)
	if summary.State != stateOpen || summary.Resolved {
		t.Fatalf("summary = %+v, want open/unresolved", summary)
	}
}

func TestIndex_RoundSummaryUnknownRound(t *testing.T) {
	ix := NewIndex()
	_, ok := ix.RoundSummary(999)
	if ok {
		t.Fatal("expected ok=false for a round with no observed events")
	}
	if got := ix.Bettors(999); got != 0 {
		t.Fatalf("Bettors(999) = %d, want 0", got)
	}
}

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
