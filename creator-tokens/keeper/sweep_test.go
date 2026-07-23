package keeper

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

// scriptedSubmitter fails the first FailCount attempts for every op (per-op
// counter, keyed by Op.String()) and succeeds thereafter -- lets tests drive
// exact retry/backoff/partial-failure scenarios without any real I/O.
type scriptedSubmitter struct {
	FailCount  map[string]int // op.String() -> number of leading failures before it starts succeeding
	AlwaysFail map[string]bool
	calls      map[string]int
	log        []string
}

func newScriptedSubmitter() *scriptedSubmitter {
	return &scriptedSubmitter{FailCount: map[string]int{}, AlwaysFail: map[string]bool{}, calls: map[string]int{}}
}

func (s *scriptedSubmitter) Submit(op Op) (string, error) {
	key := op.String()
	s.calls[key]++
	s.log = append(s.log, key)
	if s.AlwaysFail[key] {
		return "", fmt.Errorf("scripted permanent failure for %s (attempt %d)", key, s.calls[key])
	}
	if s.calls[key] <= s.FailCount[key] {
		return "", fmt.Errorf("scripted transient failure for %s (attempt %d)", key, s.calls[key])
	}
	return "ok-" + key, nil
}

func recordingSleep(log *[]time.Duration) func(time.Duration) {
	return func(d time.Duration) { *log = append(*log, d) }
}

func TestSweep_SucceedsFirstTryNeedsNoBackoff(t *testing.T) {
	markets := []MarketView{{Creator: "c1", Phase: "FROZEN", Holders: []HolderBalance{{Holder: "h1", Balance: bi(10)}}}}
	sub := newScriptedSubmitter()
	var sleeps []time.Duration

	report := Sweep(markets, sub, DefaultBackoffPolicy(), recordingSleep(&sleeps))

	if report.Failed != 0 || report.Succeeded != 2 { // refundHolder + closeIfDrained
		t.Fatalf("report = %+v, want 2 succeeded, 0 failed", report)
	}
	if len(sleeps) != 0 {
		t.Fatalf("sleeps = %v, want none -- nothing failed", sleeps)
	}
}

func TestSweep_RetriesWithGrowingBackoffThenSucceeds(t *testing.T) {
	markets := []MarketView{{Creator: "c1", Phase: "FROZEN", Holders: []HolderBalance{{Holder: "h1", Balance: bi(10)}}}}
	sub := newScriptedSubmitter()
	rhKey := Op{Kind: OpRefundHolder, Creator: "c1", Holder: "h1"}.String()
	sub.FailCount[rhKey] = 2 // fails twice, succeeds on the 3rd attempt

	policy := BackoffPolicy{MaxAttempts: 4, InitialDelay: time.Second, Multiplier: 2, MaxDelay: 10 * time.Second}
	var sleeps []time.Duration
	report := Sweep(markets, sub, policy, recordingSleep(&sleeps))

	if report.Failed != 0 || report.Succeeded != 2 {
		t.Fatalf("report = %+v, want both ops to eventually succeed", report)
	}
	rhOutcome := report.Outcomes[0]
	if len(rhOutcome.Attempts) != 3 {
		t.Fatalf("refundHolder attempts = %d, want 3 (2 failures + 1 success)", len(rhOutcome.Attempts))
	}
	// two sleeps: before attempt 2 and before attempt 3, doubling from InitialDelay.
	if len(sleeps) != 2 || sleeps[0] != time.Second || sleeps[1] != 2*time.Second {
		t.Fatalf("sleeps = %v, want [1s, 2s]", sleeps)
	}
}

func TestSweep_ExhaustsRetriesThenContinuesToNextOp(t *testing.T) {
	// Two FROZEN markets. The first market's refundHolder op fails forever;
	// the second market's ops must still be attempted and succeed -- one
	// op's permanent failure must never abort the rest of the sweep.
	markets := []MarketView{
		{Creator: "doomed", Phase: "FROZEN", Holders: []HolderBalance{{Holder: "h1", Balance: bi(10)}}},
		{Creator: "fine", Phase: "FROZEN", Holders: []HolderBalance{{Holder: "h2", Balance: bi(20)}}},
	}
	sub := newScriptedSubmitter()
	doomedKey := Op{Kind: OpRefundHolder, Creator: "doomed", Holder: "h1"}.String()
	sub.AlwaysFail[doomedKey] = true

	policy := BackoffPolicy{MaxAttempts: 3, InitialDelay: time.Millisecond, Multiplier: 2, MaxDelay: time.Second}
	var sleeps []time.Duration
	report := Sweep(markets, sub, policy, recordingSleep(&sleeps))

	// doomed -> refundHolder fails (3 attempts), closeIfDrained still
	// gets attempted and succeeds (it is a SEPARATE, independent op).
	// fine -> refundHolder + closeIfDrained both succeed.
	if len(report.Outcomes) != 4 {
		t.Fatalf("len(Outcomes) = %d, want 4 (2 ops x 2 markets), got %+v", len(report.Outcomes), report.Outcomes)
	}
	if report.Failed != 1 {
		t.Fatalf("Failed = %d, want exactly 1 (only the doomed refundHolder)", report.Failed)
	}
	if report.Succeeded != 3 {
		t.Fatalf("Succeeded = %d, want 3 (closeIfDrained for doomed + both ops for fine)", report.Succeeded)
	}

	doomedOutcome := report.Outcomes[0]
	if doomedOutcome.Op.Creator != "doomed" || doomedOutcome.Op.Kind != OpRefundHolder {
		t.Fatalf("Outcomes[0] = %+v, want the doomed refundHolder op", doomedOutcome)
	}
	if doomedOutcome.Err == nil {
		t.Fatal("expected the doomed op to be recorded as failed")
	}
	if len(doomedOutcome.Attempts) != 3 {
		t.Fatalf("doomed op attempts = %d, want 3 (MaxAttempts)", len(doomedOutcome.Attempts))
	}

	// The very next outcome (closeIfDrained for the SAME doomed market) must
	// still have been attempted, proving the sweep did not abort.
	if report.Outcomes[1].Op.Creator != "doomed" || report.Outcomes[1].Op.Kind != OpCloseIfDrained || report.Outcomes[1].Err != nil {
		t.Fatalf("Outcomes[1] = %+v, want a SUCCEEDED closeIfDrained for doomed", report.Outcomes[1])
	}
	// And the second market's ops must have run too.
	if report.Outcomes[2].Op.Creator != "fine" || report.Outcomes[3].Op.Creator != "fine" {
		t.Fatalf("Outcomes[2:] = %+v, want both ops for fine", report.Outcomes[2:])
	}
	if report.Outcomes[2].Err != nil || report.Outcomes[3].Err != nil {
		t.Fatalf("fine's ops must both succeed: %+v / %+v", report.Outcomes[2], report.Outcomes[3])
	}
}

func TestSweep_MaxAttemptsLessThanOneTreatedAsOne(t *testing.T) {
	markets := []MarketView{{Creator: "c1", Phase: "FROZEN", Holders: nil}} // just closeIfDrained
	sub := newScriptedSubmitter()
	key := Op{Kind: OpCloseIfDrained, Creator: "c1"}.String()
	sub.AlwaysFail[key] = true

	report := Sweep(markets, sub, BackoffPolicy{MaxAttempts: 0}, nil)
	if len(report.Outcomes) != 1 || len(report.Outcomes[0].Attempts) != 1 {
		t.Fatalf("outcomes = %+v, want exactly 1 attempt", report.Outcomes)
	}
}

func TestSweep_NilSleepNeverPanics(t *testing.T) {
	markets := []MarketView{{Creator: "c1", Phase: "FROZEN", Holders: []HolderBalance{{Holder: "h1", Balance: bi(1)}}}}
	sub := newScriptedSubmitter()
	rhKey := Op{Kind: OpRefundHolder, Creator: "c1", Holder: "h1"}.String()
	sub.FailCount[rhKey] = 2

	report := Sweep(markets, sub, DefaultBackoffPolicy(), nil) // no sleep func at all
	if report.Failed != 0 {
		t.Fatalf("report = %+v, want the op to still eventually succeed with nil sleep", report)
	}
}

func TestOutcome_ErrWrapsUnderlyingError(t *testing.T) {
	sentinel := errors.New("boom")
	sub := &scriptedSubmitter{FailCount: map[string]int{}, AlwaysFail: map[string]bool{}, calls: map[string]int{}}
	op := Op{Kind: OpCloseIfDrained, Creator: "c1"}
	sub.AlwaysFail[op.String()] = true
	// override Submit's error text via a thin wrapper so we can assert %w wrapping end to end.
	outcome := submitWithBackoff(op, submitterFunc(func(Op) (string, error) { return "", sentinel }), BackoffPolicy{MaxAttempts: 2, InitialDelay: time.Millisecond}, nil)
	if !errors.Is(outcome.Err, sentinel) {
		t.Fatalf("outcome.Err = %v, want it to wrap %v", outcome.Err, sentinel)
	}
}

type submitterFunc func(Op) (string, error)

func (f submitterFunc) Submit(op Op) (string, error) { return f(op) }
