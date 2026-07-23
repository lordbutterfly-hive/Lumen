package keeper

import (
	"fmt"
	"time"
)

// BackoffPolicy configures per-op retry behaviour for Sweep. Every field is
// explicit — no hidden magic numbers — so a caller can see, and override,
// the policy this package actually runs under.
type BackoffPolicy struct {
	MaxAttempts  int           // total tries per op, including the first (<1 is treated as 1)
	InitialDelay time.Duration // wait before the 2nd attempt
	Multiplier   float64       // delay growth per subsequent retry (<=0 is treated as 2)
	MaxDelay     time.Duration // cap on any single wait (<=0 means uncapped)
}

// DefaultBackoffPolicy is a conservative default: 1 try + 3 retries,
// doubling from 2s, capped at 30s — long enough to ride out a transient RPC
// hiccup or a momentary RC shortfall, short enough that one stuck op cannot
// stall a sweep of many markets for minutes. Tune per deployment; there is
// nothing sacred about these particular numbers.
func DefaultBackoffPolicy() BackoffPolicy {
	return BackoffPolicy{MaxAttempts: 4, InitialDelay: 2 * time.Second, Multiplier: 2, MaxDelay: 30 * time.Second}
}

// Attempt is one try at submitting a single Op.
type Attempt struct {
	N   int
	Err error
}

// OpOutcome is what happened when Sweep tried to submit one Op.
type OpOutcome struct {
	Op       Op
	Attempts []Attempt
	Receipt  string // set only when Err == nil
	Err      error  // non-nil only once every attempt for this op has failed
}

// SweepReport summarizes one Sweep call.
type SweepReport struct {
	Outcomes  []OpOutcome
	Succeeded int
	Failed    int
}

// Sweep plans (via Plan) and then submits every resulting op, one at a time,
// in Plan's own order, retrying each individually per policy.
//
// THIS IS THE PARTIAL-FAILURE ANSWER: an op that exhausts every retry is
// recorded as failed and Sweep MOVES ON to the next op — it never aborts the
// rest of the sweep because one holder's call kept failing. That is a direct
// consequence of the governing rule (package doc): every op here is
// independent, and every skipped/failed op is self-healing two different
// ways — (1) the holder it would have paid can always self-refund, or ask
// any other third party to push it, regardless of what this run of Sweep
// did or didn't manage, and (2) the NEXT scheduled Sweep call, given a
// freshly re-fetched []MarketView, will simply re-derive and retry it, with
// no local queue, checkpoint, or "have I done this holder yet" state to keep
// in sync. Sweep itself carries no memory between calls — crash-resume is
// nothing more than calling Sweep again with a fresh snapshot. See
// keeper_integration_test.go for a proof of that claim against the real core
// package (both a double-submit and a simulated crash-mid-sweep resume).
//
// sleep is injected (rather than a bare time.Sleep) so tests can run a full
// multi-attempt backoff sequence instantly and deterministically; production
// callers should pass time.Sleep. A nil sleep skips waiting entirely, which
// is what a --dry-run CLI wants when it chooses to PRINT what it would have
// waited rather than actually pause.
func Sweep(markets []MarketView, sub Submitter, policy BackoffPolicy, sleep func(time.Duration)) SweepReport {
	ops := Plan(markets)
	report := SweepReport{Outcomes: make([]OpOutcome, 0, len(ops))}
	for _, op := range ops {
		outcome := submitWithBackoff(op, sub, policy, sleep)
		report.Outcomes = append(report.Outcomes, outcome)
		if outcome.Err == nil {
			report.Succeeded++
		} else {
			report.Failed++
		}
	}
	return report
}

func submitWithBackoff(op Op, sub Submitter, policy BackoffPolicy, sleep func(time.Duration)) OpOutcome {
	maxAttempts := policy.MaxAttempts
	if maxAttempts < 1 {
		maxAttempts = 1
	}
	delay := policy.InitialDelay

	outcome := OpOutcome{Op: op}
	var lastErr error
	for n := 1; n <= maxAttempts; n++ {
		receipt, err := sub.Submit(op)
		outcome.Attempts = append(outcome.Attempts, Attempt{N: n, Err: err})
		if err == nil {
			outcome.Receipt = receipt
			return outcome
		}
		lastErr = err
		if n == maxAttempts {
			break
		}
		if sleep != nil {
			sleep(delay)
		}
		delay = nextDelay(delay, policy)
	}
	outcome.Err = fmt.Errorf("keeper: %s: giving up after %d attempt(s): %w", op, maxAttempts, lastErr)
	return outcome
}

func nextDelay(cur time.Duration, policy BackoffPolicy) time.Duration {
	mult := policy.Multiplier
	if mult <= 0 {
		mult = 2
	}
	next := time.Duration(float64(cur) * mult)
	if policy.MaxDelay > 0 && next > policy.MaxDelay {
		next = policy.MaxDelay
	}
	return next
}
