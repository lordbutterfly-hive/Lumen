package keeper

import (
	"fmt"
	"math"
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

// OutcomeStatus classifies what Sweep actually learned about one Op, once it
// stopped retrying it. Introduced alongside HolderBalance.RefundBlocked as
// the second half of the F9 fix (2026-08-19 audit): "no transport error" and
// "confirmed paid" used to be the same bit (Err == nil); they no longer are.
type OutcomeStatus int

const (
	// StatusUnverified: Submit returned no transport error, but nothing
	// confirmed the underlying wasm call actually executed without
	// reverting. THIS IS THE HONEST OUTCOME for every Submitter this
	// package ships today — see ExecutionVerifier's doc (submit.go) for the
	// only way to earn StatusSucceeded instead, and this file's own
	// StatusSucceeded doc for why a transport ack was never proof of
	// payment.
	StatusUnverified OutcomeStatus = iota
	// StatusSucceeded: an ExecutionVerifier confirmed this op executed
	// on-chain without reverting. Never set for a Submitter that does not
	// implement ExecutionVerifier.
	StatusSucceeded
	// StatusFailed: every attempt exhausted a transport error, OR an
	// ExecutionVerifier reported a CONFIRMED REVERT (in which case OpOutcome.Err
	// says so explicitly rather than looking like an ordinary exhausted retry).
	StatusFailed
)

func (s OutcomeStatus) String() string {
	switch s {
	case StatusSucceeded:
		return "succeeded"
	case StatusFailed:
		return "failed"
	default:
		return "unverified"
	}
}

// OpOutcome is what happened when Sweep tried to submit one Op.
type OpOutcome struct {
	Op       Op
	Attempts []Attempt
	Receipt  string        // set once Submit returns err == nil, regardless of Status
	Status   OutcomeStatus // see OutcomeStatus's doc — NOT the same axis as Err == nil
	Err      error         // non-nil for StatusFailed only (exhausted retries, or a confirmed revert)
}

// SweepReport summarizes one Sweep call. Succeeded now means "an
// ExecutionVerifier confirmed this op executed" — NEVER "Submit returned no
// transport error." A caller that only checks Failed and assumes everything
// else was paid is making exactly the F9 mistake this split exists to
// prevent: read Unverified too, and see Summary's doc for the one-line an
// operator-facing print should use instead of "N succeeded."
type SweepReport struct {
	Outcomes   []OpOutcome
	Succeeded  int
	Unverified int
	Failed     int
}

// Summary renders the honest, operator-facing one-liner: it never claims a
// payment happened unless an ExecutionVerifier actually confirmed it, and it
// says so explicitly for the (today, universal) case where nothing could.
func (r SweepReport) Summary() string {
	return fmt.Sprintf(
		"%d confirmed executed, %d unverified (transport accepted the submission — chain execution NOT confirmed), %d failed",
		r.Succeeded, r.Unverified, r.Failed,
	)
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
		switch outcome.Status {
		case StatusSucceeded:
			report.Succeeded++
		case StatusFailed:
			report.Failed++
		default:
			report.Unverified++
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
	verifier, canVerify := sub.(ExecutionVerifier)

	outcome := OpOutcome{Op: op}
	var lastErr error
	for n := 1; n <= maxAttempts; n++ {
		receipt, err := sub.Submit(op)
		outcome.Attempts = append(outcome.Attempts, Attempt{N: n, Err: err})
		if err != nil {
			lastErr = err
			if n == maxAttempts {
				break
			}
			if sleep != nil {
				sleep(delay)
			}
			delay = nextDelay(delay, policy)
			continue
		}

		// Submit reported no TRANSPORT error. That is NOT yet "succeeded" —
		// see ExecutionVerifier's doc (submit.go) for why.
		outcome.Receipt = receipt
		if !canVerify {
			outcome.Status = StatusUnverified
			return outcome
		}
		executed, ok := verifier.VerifyExecution(op, receipt)
		if !ok {
			outcome.Status = StatusUnverified
			return outcome
		}
		if executed {
			outcome.Status = StatusSucceeded
			return outcome
		}
		// CONFIRMED REVERT: the chain gave a definitive verdict, not a
		// transient transport hiccup — retrying the identical op cannot
		// change a deterministic outcome, so this is terminal rather than
		// another attempt to retry through backoff. It still surfaces
		// through the ordinary Failed bucket and a populated Err, so an
		// operator's failure-handling code needs no special case for it —
		// see cmd/keeper's own print loop.
		outcome.Status = StatusFailed
		outcome.Err = fmt.Errorf("keeper: %s: transport accepted the submission (receipt %s) but chain execution reverted — confirmed by the submitter, not a retryable transport failure", op, receipt)
		return outcome
	}
	outcome.Status = StatusFailed
	outcome.Err = fmt.Errorf("keeper: %s: giving up after %d attempt(s): %w", op, maxAttempts, lastErr)
	return outcome
}

func nextDelay(cur time.Duration, policy BackoffPolicy) time.Duration {
	mult := policy.Multiplier
	if mult <= 0 {
		mult = 2
	}
	// ★ CLAMP BEFORE THE CONVERSION (DEFECT FIX 2026-08-19, audit anomaly
	// AN-27). float64 -> time.Duration is an int64 conversion, and Go leaves
	// the result implementation-defined once the value leaves int64's range.
	// Measured: with MaxDelay <= 0 — the value this struct documents as
	// "uncapped" — attempt 34 wrapped 2,386,092h round to -2,562,047h. A
	// negative duration makes time.Sleep return INSTANTLY, so "uncapped
	// backoff" silently became a hot retry loop, hammering a node at full
	// speed at exactly the moment it was already failing. Comparing in
	// float64 first, where the overflow cannot happen, is the whole fix.
	//
	// "Uncapped" now means what it says: the wait keeps doubling up to the
	// largest duration there is (~292 years), which no operator will reach
	// but which is the honest reading of the word.
	grown := float64(cur) * mult
	if grown >= math.MaxInt64 {
		grown = math.MaxInt64
	}
	next := time.Duration(grown)
	if policy.MaxDelay > 0 && next > policy.MaxDelay {
		next = policy.MaxDelay
	}
	// A growth step must never SHRINK the wait to nothing. Anything <= 0 here
	// is arithmetic that went wrong, not a policy anyone expressed.
	if next <= 0 && cur > 0 {
		next = cur
	}
	return next
}
