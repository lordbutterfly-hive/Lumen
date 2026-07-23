package analysis

import "testing"

func TestCoverage_ReportsExercisedAndNeverExercised(t *testing.T) {
	tr := &Trace{Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000),
		prepayEv(200, "bob", "alice", 5000),
	}}
	rpt := AnalyzeCoverage(tr)

	if rpt.ActionsKnown != len(knownActions) {
		t.Fatalf("ActionsKnown = %d, want %d", rpt.ActionsKnown, len(knownActions))
	}
	if rpt.ActionsExercised["register"] != 1 || rpt.ActionsExercised["prepay"] != 1 {
		t.Errorf("ActionsExercised = %+v, want register=1 prepay=1", rpt.ActionsExercised)
	}
	// Everything except register/prepay must show up as never exercised.
	if len(rpt.ActionsNeverExercised) != len(knownActions)-2 {
		t.Errorf("ActionsNeverExercised = %v, want %d entries", rpt.ActionsNeverExercised, len(knownActions)-2)
	}

	// Only ACTIVE was ever reached (both events happen while paid_until is
	// far in the future).
	if rpt.PhasesReached[PhaseActive] == 0 {
		t.Error("expected ACTIVE to be reached")
	}
	for _, p := range []string{PhaseOverdue, PhaseFrozen, PhaseClosed} {
		if rpt.PhasesReached[p] != 0 {
			t.Errorf("expected %s to be unreached, got count %d", p, rpt.PhasesReached[p])
		}
	}
	found := map[string]bool{}
	for _, p := range rpt.PhasesNeverReached {
		found[p] = true
	}
	if !found[PhaseOverdue] || !found[PhaseFrozen] || !found[PhaseClosed] {
		t.Errorf("PhasesNeverReached = %v, want OVERDUE/FROZEN/CLOSED all present", rpt.PhasesNeverReached)
	}
}

func TestCoverage_TracksFullLapseLadder(t *testing.T) {
	grace := defaultGraceBlocks
	sub := defaultSubscriptionPeriod

	tr := &Trace{Events: []Event{
		registerEv(0, "alice", 2000, 1_000_000),
		prepayEv(sub-1, "bob", "alice", 1000),  // ACTIVE
		refundEv(sub+1, "bob", "alice", 1),     // OVERDUE
		refundEv(sub+grace, "bob", "alice", 1), // FROZEN boundary — FROZEN begins AT +GraceBlocks per core/market.go
	}}
	rpt := AnalyzeCoverage(tr)

	if rpt.PhasesReached[PhaseActive] == 0 {
		t.Error("expected ACTIVE reached")
	}
	if rpt.PhasesReached[PhaseOverdue] == 0 {
		t.Error("expected OVERDUE reached")
	}
	if rpt.PhasesReached[PhaseFrozen] == 0 {
		t.Error("expected FROZEN reached")
	}
	if rpt.CreatorsReachingFrozen != 1 {
		t.Errorf("CreatorsReachingFrozen = %d, want 1", rpt.CreatorsReachingFrozen)
	}
}

func TestFailures_EmptyTraceHasNoFailures(t *testing.T) {
	tr := &Trace{Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000),
		prepayEv(200, "bob", "alice", 5000),
	}}
	rpt := AnalyzeFailures(tr)
	if rpt.TotalFailures != 0 {
		t.Errorf("TotalFailures = %d, want 0", rpt.TotalFailures)
	}
	if len(rpt.Buckets) != 0 {
		t.Errorf("expected no buckets, got %+v", rpt.Buckets)
	}
}

func TestFailures_ClassifiesCorrectVsUsability(t *testing.T) {
	tr := &Trace{Events: []Event{
		// CORRECT: the 2x/7-day anti-rug band, doing exactly its job.
		newEv(100, "alice", "setFace", "alice").argN("newFace", 100000).
			fail(ErrInputSym, "face change exceeds the 2x/7-day band (measured against the window anchor, not the last change)").build(),
		// CORRECT: the asker's own slippage guard against a face-spike sandwich.
		newEv(200, "bob", "ask", "alice").
			fail(ErrInputSym, "creditsSpent exceeds maxCredits").build(),
		// USABILITY: a stale-quote commission underpay.
		newEv(300, "bob", "ask", "alice").
			fail(ErrBalanceSym, "commission underpaid").build(),
		// USABILITY: an impatient reclaim retry inside the gap.
		newEv(400, "bob", "reclaim", "alice").
			fail(ErrStateSym, "reclaim window not open").build(),
		// UNEXPECTED: the documented-unreachable invariant guard.
		newEv(500, "bob", "refund", "alice").
			fail(ErrStateSym, "supply is zero but caller holds a balance").build(),
	}}

	rpt := AnalyzeFailures(tr)
	if rpt.TotalFailures != 5 {
		t.Fatalf("TotalFailures = %d, want 5", rpt.TotalFailures)
	}
	if rpt.ByClass[ClassCorrect] != 2 {
		t.Errorf("ByClass[CORRECT] = %d, want 2", rpt.ByClass[ClassCorrect])
	}
	if rpt.ByClass[ClassUsability] != 2 {
		t.Errorf("ByClass[USABILITY] = %d, want 2", rpt.ByClass[ClassUsability])
	}
	if rpt.ByClass[ClassUnexpected] != 1 {
		t.Errorf("ByClass[UNEXPECTED] = %d, want 1", rpt.ByClass[ClassUnexpected])
	}

	// Ranked by count: all buckets here have count=1, so just confirm the
	// unexpected one is present and correctly classified.
	foundUnexpected := false
	for _, bk := range rpt.Buckets {
		if bk.Class == ClassUnexpected {
			foundUnexpected = true
			if bk.Action != "refund" {
				t.Errorf("unexpected bucket action = %q, want refund", bk.Action)
			}
		}
	}
	if !foundUnexpected {
		t.Error("expected an UNEXPECTED bucket for the unreachable-invariant guard")
	}
}

func TestFailures_RanksMostCommonCauseFirst(t *testing.T) {
	tr := &Trace{Events: []Event{
		newEv(100, "bob", "ask", "alice").fail(ErrBalanceSym, "insufficient credits").build(),
		newEv(200, "bob", "ask", "alice").fail(ErrBalanceSym, "insufficient credits").build(),
		newEv(300, "bob", "ask", "alice").fail(ErrBalanceSym, "insufficient credits").build(),
		newEv(400, "bob", "transfer", "alice").fail(ErrInputSym, "must be different accounts").build(),
	}}
	rpt := AnalyzeFailures(tr)
	if len(rpt.Buckets) != 2 {
		t.Fatalf("expected 2 distinct buckets, got %d: %+v", len(rpt.Buckets), rpt.Buckets)
	}
	if rpt.Buckets[0].Count != 3 || rpt.Buckets[0].Action != "ask" {
		t.Errorf("top bucket = %+v, want count=3 action=ask", rpt.Buckets[0])
	}
}

func TestFailures_CrossChecksDeltasEmptyOnFailure(t *testing.T) {
	ev := newEv(100, "bob", "refund", "alice").fail(ErrBalanceSym, "insufficient credits").build()
	ev.Deltas["reserve"] = "1000 -> 500" // contradicts sim/trace.go's own documented guarantee
	tr := &Trace{Events: []Event{ev}}

	rpt := AnalyzeFailures(tr)
	if len(rpt.DeltasNonEmptyOnFailure) != 1 {
		t.Fatalf("expected 1 flagged event, got %d", len(rpt.DeltasNonEmptyOnFailure))
	}
}
