package analysis

import (
	"math/big"
	"testing"
)

func TestDeadEnds_AnsweredAskNeverEntersTheGap(t *testing.T) {
	// Answer legal only for block <= deadline; if the creator answers in
	// time, the escrow never spends any time in the ReclaimGrace gap.
	tr := &Trace{Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000),
		prepayEv(200, "bob", "alice", 5000),
		askEv(300, "bob", "alice", 240, 28800, 2000), // deadline = 300+28800 = 29100
		answerEv(310, "alice", "alice", 0),           // well before the deadline
	}}
	rpt := AnalyzeDeadEnds(tr)
	if len(rpt.ReclaimGapWindows) != 0 {
		t.Errorf("expected 0 gap windows for an answered ask, got %+v", rpt.ReclaimGapWindows)
	}
	if len(rpt.Persistent) != 0 {
		t.Errorf("expected 0 persistent dead ends, got %+v", rpt.Persistent)
	}
}

func TestDeadEnds_ReclaimedAskAlwaysSpendsTheFullGap(t *testing.T) {
	// This is the flagship finding: any ask that is NOT answered by its
	// deadline spends exactly ReclaimGrace blocks where neither answer nor
	// reclaim is legal for anyone, by construction (I6, core/ask.go).
	deadlineBlocks := uint64(28800)
	askBlock := uint64(300)
	deadline := askBlock + deadlineBlocks

	tr := &Trace{Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000),
		prepayEv(200, "bob", "alice", 5000),
		askEv(askBlock, "bob", "alice", 240, deadlineBlocks, 2000),
		reclaimEv(deadline+defaultReclaimGrace+1, "bob", "alice", 0),
	}}
	rpt := AnalyzeDeadEnds(tr)
	if len(rpt.ReclaimGapWindows) != 1 {
		t.Fatalf("expected exactly 1 gap window, got %d: %+v", len(rpt.ReclaimGapWindows), rpt.ReclaimGapWindows)
	}
	w := rpt.ReclaimGapWindows[0]
	if w.Creator != "alice" || w.Asker != "bob" || w.Seq != 0 {
		t.Errorf("gap window identity = %+v, want alice/bob/seq0", w)
	}
	if w.GapStart != deadline+1 || w.GapEnd != deadline+defaultReclaimGrace {
		t.Errorf("gap window = [%d,%d], want [%d,%d]", w.GapStart, w.GapEnd, deadline+1, deadline+defaultReclaimGrace)
	}
	if w.Resolution != "reclaimed" {
		t.Errorf("gap window resolution = %q, want %q", w.Resolution, "reclaimed")
	}
	if w.CommissionHbd.Cmp(big.NewInt(240)) != 0 {
		t.Errorf("gap window commission = %s, want 240", w.CommissionHbd)
	}
	if w.Credits == nil || w.Credits.Cmp(big.NewInt(2000)) != 0 {
		t.Errorf("gap window credits = %v, want 2000", w.Credits)
	}
	// This is TRANSIENT and resolves automatically — it must not, on its
	// own, make the report Critical (fail a build).
	report := Report{DeadEnds: rpt, Ledger: LedgerReport{Closes: true}}
	if report.Critical() {
		t.Error("a transient ReclaimGrace gap must not make the report Critical on its own")
	}
}

func TestDeadEnds_StillOpenEscrowInTheGapAtTraceEnd(t *testing.T) {
	deadlineBlocks := uint64(28800)
	askBlock := uint64(300)
	deadline := askBlock + deadlineBlocks

	tr := &Trace{Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000),
		prepayEv(200, "bob", "alice", 5000),
		askEv(askBlock, "bob", "alice", 240, deadlineBlocks, 2000),
		// no answer, no reclaim — trace simply ends while the last observed
		// block sits inside the gap.
		{Block: deadline + 500, Day: 1, Actor: "someone-else", Action: "recordObs", Creator: "alice", Args: map[string]string{"rate": "1"}, OK: true, Deltas: map[string]string{}},
	}}
	rpt := AnalyzeDeadEnds(tr)
	if len(rpt.ReclaimGapWindows) != 1 {
		t.Fatalf("expected 1 gap window, got %d", len(rpt.ReclaimGapWindows))
	}
	if rpt.ReclaimGapWindows[0].Resolution != "unresolved-at-trace-end" {
		t.Errorf("resolution = %q, want unresolved-at-trace-end", rpt.ReclaimGapWindows[0].Resolution)
	}
	if len(rpt.OngoingAtTraceEnd) != 1 {
		t.Errorf("expected 1 ongoing-at-trace-end window, got %d", len(rpt.OngoingAtTraceEnd))
	}
}

func TestDeadEnds_InProgressAskIsNotADeadEnd(t *testing.T) {
	// Trace ends while still inside the answer window — the creator still
	// has time; this must not be reported as any kind of dead end.
	tr := &Trace{Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000),
		prepayEv(200, "bob", "alice", 5000),
		askEv(300, "bob", "alice", 240, 28800, 2000),
	}}
	rpt := AnalyzeDeadEnds(tr)
	if len(rpt.ReclaimGapWindows) != 0 {
		t.Errorf("expected 0 gap windows for an ask still inside its answer window, got %+v", rpt.ReclaimGapWindows)
	}
	if len(rpt.UnclaimedEligible) != 0 {
		t.Errorf("expected 0 unclaimed-eligible, got %+v", rpt.UnclaimedEligible)
	}
}

func TestDeadEnds_UnclaimedEligibleIsNotADeadEnd(t *testing.T) {
	// Reclaim window is open (block well past deadline+ReclaimGrace) but
	// nobody called it. The action WAS available — this is a UX/awareness
	// signal, not a dead end, and must not appear in ReclaimGapWindows.
	deadlineBlocks := uint64(28800)
	askBlock := uint64(300)
	deadline := askBlock + deadlineBlocks
	endBlock := deadline + defaultReclaimGrace + 100_000

	tr := &Trace{Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000),
		prepayEv(200, "bob", "alice", 5000),
		askEv(askBlock, "bob", "alice", 240, deadlineBlocks, 2000),
		{Block: endBlock, Day: 40, Actor: "someone-else", Action: "recordObs", Creator: "alice", Args: map[string]string{"rate": "1"}, OK: true, Deltas: map[string]string{}},
	}}
	rpt := AnalyzeDeadEnds(tr)
	if len(rpt.ReclaimGapWindows) != 0 {
		t.Errorf("expected 0 gap windows once reclaim has been legal for a long time, got %+v", rpt.ReclaimGapWindows)
	}
	if len(rpt.UnclaimedEligible) != 1 {
		t.Fatalf("expected 1 unclaimed-eligible escrow, got %d", len(rpt.UnclaimedEligible))
	}
}

func TestDeadEnds_CreditHolderAlwaysHasAnExit(t *testing.T) {
	// The static claim this file makes: a positive-balance holder always has
	// Refund available, in every phase, because core/refund.go's Refund
	// carries no phase/pause gate. Verify the dynamic scan agrees: no
	// anomalies, no persistent dead ends, across ACTIVE, OVERDUE and FROZEN.
	grace := defaultGraceBlocks
	sub := defaultSubscriptionPeriod
	tr := &Trace{Events: []Event{
		registerEv(0, "alice", 2000, 1_000_000),
		prepayEv(100, "bob", "alice", 5000),
		refundEv(sub+1, "bob", "alice", 1000),       // OVERDUE
		refundEv(sub+grace+1, "bob", "alice", 1000), // FROZEN
		transferEv(sub+grace+2, "bob", "alice", "charlie", 1000),
	}}
	rpt := AnalyzeDeadEnds(tr)
	if len(rpt.Anomalies) != 0 {
		t.Errorf("expected 0 anomalies, got %+v", rpt.Anomalies)
	}
	if len(rpt.Persistent) != 0 {
		t.Errorf("expected 0 persistent dead ends, got %+v", rpt.Persistent)
	}
	if rpt.RefundTransferAttempts != 3 {
		t.Errorf("RefundTransferAttempts = %d, want 3", rpt.RefundTransferAttempts)
	}
}

func TestDeadEnds_AnomalyScanCatchesAWronglyBlockedRefund(t *testing.T) {
	// Inject a "bug": a refund fails despite the caller holding enough
	// balance to cover the request. Real core has no such gate — if a trace
	// ever shows this, it is a genuine regression, and this file's job is to
	// catch it, not explain it away.
	tr := &Trace{Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000),
		prepayEv(200, "bob", "alice", 5000),
		newEv(300, "bob", "refund", "alice").argN("credits", 1000).
			fail(ErrBalanceSym, "insufficient credits").build(),
	}}
	rpt := AnalyzeDeadEnds(tr)
	if len(rpt.Anomalies) != 1 {
		t.Fatalf("expected 1 anomaly, got %d: %+v", len(rpt.Anomalies), rpt.Anomalies)
	}
	if rpt.Anomalies[0].Kind != "refund-blocked" {
		t.Errorf("anomaly kind = %q, want refund-blocked", rpt.Anomalies[0].Kind)
	}
	if len(rpt.Persistent) != 1 {
		t.Fatalf("expected 1 persistent dead end, got %d: %+v", len(rpt.Persistent), rpt.Persistent)
	}

	report := Report{DeadEnds: rpt, Ledger: LedgerReport{Closes: true}}
	if !report.Critical() {
		t.Error("a persistent dead end must make the report Critical")
	}
}

func TestDeadEnds_LegitimateInsufficientBalanceIsNotAnAnomaly(t *testing.T) {
	// A refund that fails because the caller asked for MORE than they hold
	// is ordinary, expected behaviour — never an anomaly.
	tr := &Trace{Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000),
		prepayEv(200, "bob", "alice", 500),
		newEv(300, "bob", "refund", "alice").argN("credits", 1000). // requested > balance
										fail(ErrBalanceSym, "insufficient credits").build(),
	}}
	rpt := AnalyzeDeadEnds(tr)
	if len(rpt.Anomalies) != 0 {
		t.Errorf("expected 0 anomalies for a legitimate insufficient-balance refusal, got %+v", rpt.Anomalies)
	}
}

func TestDeadEnds_ClosedMarketHasNoResidual(t *testing.T) {
	// Drain a market to CLOSED (supply hits 0 while FROZEN) via RefundHolder,
	// then call closeIfDrained. By I3, a CLOSED market cannot have a residual
	// balance or an open escrow — verify the replay agrees.
	grace := defaultGraceBlocks
	sub := defaultSubscriptionPeriod
	closeBlock := sub + grace + 100

	tr := &Trace{Events: []Event{
		registerEv(0, "alice", 2000, 1_000_000),
		prepayEv(100, "bob", "alice", 5000),
		refundHolderEv(closeBlock, "keeper1", "alice", "bob"),
		newEv(closeBlock+1, "keeper1", "closeIfDrained", "alice").build(),
	}}
	rpt := AnalyzeDeadEnds(tr)
	if rpt.ClosedMarkets != 1 {
		t.Fatalf("expected 1 closed market, got %d", rpt.ClosedMarkets)
	}
	if rpt.ClosedMarketResiduals != 0 {
		t.Errorf("expected 0 residuals on a legitimately closed market, got %d", rpt.ClosedMarketResiduals)
	}
}
