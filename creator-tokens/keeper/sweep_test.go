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

	// scriptedSubmitter is a transport-only double (no ExecutionVerifier), so
	// per the F9 fix (sweep.go's StatusSucceeded/StatusUnverified split) a
	// clean transport ack is recorded Unverified, never Succeeded --
	// Succeeded is now reserved for a Submitter that actually confirms chain
	// execution, which none of this file's fixtures do on purpose.
	if report.Failed != 0 || report.Unverified != 2 || report.Succeeded != 0 { // refundHolder + closeIfDrained
		t.Fatalf("report = %+v, want 2 unverified, 0 succeeded, 0 failed", report)
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

	// See TestSweep_SucceedsFirstTryNeedsNoBackoff's comment: a transport-only
	// submitter's clean acks are Unverified, never Succeeded, post-F9-fix.
	if report.Failed != 0 || report.Unverified != 2 || report.Succeeded != 0 {
		t.Fatalf("report = %+v, want both ops to eventually transport-succeed (Unverified)", report)
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
	// scriptedSubmitter is transport-only (no ExecutionVerifier): every clean
	// ack is Unverified post-F9-fix, never Succeeded.
	if report.Unverified != 3 || report.Succeeded != 0 {
		t.Fatalf("Unverified = %d, Succeeded = %d, want 3 unverified / 0 succeeded (closeIfDrained for doomed + both ops for fine)", report.Unverified, report.Succeeded)
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

// verifyingSubmitter is a Submitter that ALSO implements ExecutionVerifier --
// it always transport-accepts (Submit never errors) but reports a scripted,
// per-op execution verdict, so tests can drive Sweep's StatusSucceeded /
// StatusFailed(confirmed revert) / StatusUnverified split independently of
// any transport failure.
type verifyingSubmitter struct {
	n int
	// verdicts[op.String()] = (executed, ok) exactly as VerifyExecution
	// returns them. A missing key means "don't implement verification for
	// this op" is NOT what's being tested here (this type always answers);
	// tests that want the "no ExecutionVerifier at all" path use
	// scriptedSubmitter/newScriptedSubmitter instead.
	verdicts map[string]struct {
		executed bool
		ok       bool
	}
}

func (v *verifyingSubmitter) Submit(op Op) (string, error) {
	v.n++
	return fmt.Sprintf("verified-tx-%d", v.n), nil
}

func (v *verifyingSubmitter) VerifyExecution(op Op, receipt string) (executed bool, ok bool) {
	r := v.verdicts[op.String()]
	return r.executed, r.ok
}

// TestSweep_ConfirmedRevertIsRecordedFailedNeverSucceeded is the F9
// regression guard for sweep.go's honesty fix: a Submitter that transport-
// accepts a call (Submit returns a receipt, err == nil) but whose
// ExecutionVerifier reports the chain CONFIRMED A REVERT must be recorded
// StatusFailed with a populated Err, and must NEVER be counted in
// report.Succeeded -- the exact mistake F9 found sweep.go making (Succeeded
// set purely from Submit's err == nil, with no way to observe a revert).
func TestSweep_ConfirmedRevertIsRecordedFailedNeverSucceeded(t *testing.T) {
	markets := []MarketView{{Creator: "c1", Phase: "FROZEN", Holders: []HolderBalance{{Holder: "h1", Balance: bi(10)}}}}
	rhKey := Op{Kind: OpRefundHolder, Creator: "c1", Holder: "h1"}.String()
	cdKey := Op{Kind: OpCloseIfDrained, Creator: "c1"}.String()

	sub := &verifyingSubmitter{verdicts: map[string]struct {
		executed bool
		ok       bool
	}{
		rhKey: {executed: false, ok: true}, // CONFIRMED REVERT
		cdKey: {executed: true, ok: true},  // confirmed executed, for contrast
	}}

	report := Sweep(markets, sub, BackoffPolicy{MaxAttempts: 3, InitialDelay: time.Millisecond}, nil)

	if report.Succeeded != 1 || report.Failed != 1 || report.Unverified != 0 {
		t.Fatalf("report = %+v, want exactly 1 succeeded (closeIfDrained) and 1 failed (the confirmed-revert refundHolder), 0 unverified", report)
	}
	rhOutcome := report.Outcomes[0]
	if rhOutcome.Op.Kind != OpRefundHolder {
		t.Fatalf("Outcomes[0] = %+v, want the refundHolder op", rhOutcome)
	}
	if rhOutcome.Status != StatusFailed {
		t.Fatalf("refundHolder Status = %v, want StatusFailed -- a confirmed revert must never read as succeeded or merely unverified", rhOutcome.Status)
	}
	if rhOutcome.Err == nil {
		t.Fatal("refundHolder Err is nil, want a populated error naming the confirmed revert")
	}
	// A confirmed revert is a definitive verdict, not a transient transport
	// failure: it must be terminal on the FIRST attempt, never retried.
	if len(rhOutcome.Attempts) != 1 {
		t.Fatalf("refundHolder Attempts = %d, want exactly 1 -- a confirmed revert must not be retried like a transport hiccup", len(rhOutcome.Attempts))
	}

	cdOutcome := report.Outcomes[1]
	if cdOutcome.Status != StatusSucceeded {
		t.Fatalf("closeIfDrained Status = %v, want StatusSucceeded (contrast case: same submitter, confirmed executed)", cdOutcome.Status)
	}
}

// TestSweep_NoExecutionVerifierIsUnverifiedNotSucceeded is the direct
// contrast case: the SAME scenario, but through a Submitter with no
// ExecutionVerifier at all (scriptedSubmitter) -- Sweep must never guess
// StatusSucceeded when nothing confirmed execution either way.
func TestSweep_NoExecutionVerifierIsUnverifiedNotSucceeded(t *testing.T) {
	markets := []MarketView{{Creator: "c1", Phase: "FROZEN", Holders: []HolderBalance{{Holder: "h1", Balance: bi(10)}}}}
	sub := newScriptedSubmitter()
	report := Sweep(markets, sub, DefaultBackoffPolicy(), nil)
	if report.Succeeded != 0 {
		t.Fatalf("Succeeded = %d, want 0 -- a bare Submitter (no ExecutionVerifier) must never earn StatusSucceeded", report.Succeeded)
	}
	if report.Unverified != 2 {
		t.Fatalf("Unverified = %d, want 2 (refundHolder + closeIfDrained)", report.Unverified)
	}
}

// TestNextDelay_UncappedNeverWrapsNegative pins the AN-27 fix: with MaxDelay
// <= 0 (the value BackoffPolicy documents as "uncapped"), repeated growth used
// to overflow the float64 -> time.Duration conversion and come back NEGATIVE —
// measured at attempt 34, 2,386,092h wrapping to -2,562,047h. time.Sleep on a
// negative duration returns instantly, so "uncapped backoff" turned into a hot
// retry loop against a node that was already failing.
func TestNextDelay_UncappedNeverWrapsNegative(t *testing.T) {
	policy := BackoffPolicy{MaxAttempts: 100, InitialDelay: 2 * time.Second, Multiplier: 2, MaxDelay: 0}
	d := policy.InitialDelay
	sawSaturation := false
	for attempt := 0; attempt < 80; attempt++ {
		next := nextDelay(d, policy)
		if next <= 0 {
			t.Fatalf("attempt %d: uncapped backoff produced %v — a non-positive delay makes "+
				"time.Sleep return instantly, which is a hot retry loop, not a backoff", attempt, next)
		}
		if next < d {
			t.Fatalf("attempt %d: backoff SHRANK from %v to %v with no MaxDelay set", attempt, d, next)
		}
		if next == d {
			sawSaturation = true // saturated at the largest representable duration
		}
		d = next
	}
	// ANTI-VACUITY: the loop must actually have driven the value into the
	// range where the old code overflowed, or it proves nothing.
	if !sawSaturation {
		t.Fatal("80 doublings never reached saturation — the loop no longer exercises the overflow range")
	}
}

// TestNextDelay_CapStillBinds is the control: the fix must not have broken the
// ordinary capped path everyone actually runs.
func TestNextDelay_CapStillBinds(t *testing.T) {
	policy := DefaultBackoffPolicy()
	d := policy.InitialDelay
	for i := 0; i < 10; i++ {
		d = nextDelay(d, policy)
		if d > policy.MaxDelay {
			t.Fatalf("delay %v exceeded MaxDelay %v", d, policy.MaxDelay)
		}
	}
	if d != policy.MaxDelay {
		t.Fatalf("delay settled at %v, want the cap %v", d, policy.MaxDelay)
	}
}
