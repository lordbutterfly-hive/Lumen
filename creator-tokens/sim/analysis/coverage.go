package analysis

import (
	"fmt"
	"sort"
	"strings"
)

// coverage.go — STATE AND ACTION COVERAGE, and the FAILURE HISTOGRAM.
//
// Both are trace-wide tallies (what happened, how often), which is why they
// live in one file: coverage counts what was ATTEMPTED, the histogram counts
// what FAILED and why. Neither needs the money-replay machinery ledger.go
// and journey.go build — phase is derived from a small local paidUntil/
// closed replay (mirroring core/market.go's Phase exactly, same as
// report.go's derivePhase), and everything else is read straight off each
// Event.

// ---------------------------------------------------------------------------
// State/action coverage.

// CoverageReport says which market phases and which of the engine's known
// actions were actually exercised — and, just as importantly, names what was
// NOT reached, because an unreached state is an untested state and this
// report must not imply otherwise (per this package's brief).
type CoverageReport struct {
	ActionsKnown          int
	ActionsExercised      map[string]int // action -> total attempts (OK + failed)
	ActionsNeverExercised []string

	PhasesKnown        int
	PhasesReached      map[string]int // phase -> observations (one per event, for the creator's phase at call time)
	PhasesNeverReached []string

	ComboCounts         map[string]int // "PHASE|action" -> observations
	ComboNeverExercised []string       // every (phase, action) pair in the full knownPhases x knownActions grid with zero observations

	CreatorsRegistered     int
	CreatorsReachingFrozen int
	CreatorsReachingClosed int

	Notes []string
}

func comboKey(phase, action string) string { return phase + "|" + action }

// knownGlobalActions are the actions that are NOT scoped to any single
// market's lifecycle phase — they target a bare global key (kTreasury,
// kOwner, kPaused), never a per-market key. They are counted in the action
// tally (knownActions) but excluded from the phase x action combo grid,
// since asking "was withdrawTreasury exercised in the FROZEN phase" is a
// category error: a treasury withdrawal has no market phase at all. Added
// with "withdrawTreasury" for Upgrade 1 (C2 treasury exit).
var knownGlobalActions = map[string]bool{
	"withdrawTreasury": true,
}

// gridActionCount is the number of per-market (non-global) actions — the
// real denominator for the phase x action grid.
func gridActionCount() int { return len(knownActions) - len(knownGlobalActions) }

// AnalyzeCoverage tallies phase/action exercise across tr.
func AnalyzeCoverage(tr *Trace) CoverageReport {
	rpt := CoverageReport{
		ActionsKnown:     len(knownActions),
		ActionsExercised: map[string]int{},
		PhasesKnown:      len(knownPhases),
		PhasesReached:    map[string]int{},
		ComboCounts:      map[string]int{},
	}
	if tr == nil {
		return rpt
	}
	subPeriod := subscriptionPeriodFor(tr)
	grace := graceBlocksFor(tr)

	paidUntil := map[string]uint64{}
	closed := map[string]bool{}
	registered := map[string]bool{}
	sawFrozen := map[string]bool{}
	sawClosed := map[string]bool{}

	for _, ev := range tr.Events {
		c := ev.Creator
		rpt.ActionsExercised[ev.Action]++

		if registered[c] {
			ph := derivePhase(closed[c], paidUntil[c], ev.Block, grace)
			rpt.PhasesReached[ph]++
			rpt.ComboCounts[comboKey(ph, ev.Action)]++
			if ph == PhaseFrozen {
				sawFrozen[c] = true
			}
			if ph == PhaseClosed {
				sawClosed[c] = true
			}
		}

		if !ev.OK {
			continue
		}
		switch ev.Action {
		case "register":
			if !registered[c] {
				registered[c] = true
				rpt.CreatorsRegistered++
			}
			closed[c] = false
			paidUntil[c] = ev.Block + subPeriod
		case "renew":
			if periods, ok := argU64(ev, "periods"); ok {
				base := paidUntil[c]
				if ev.Block > base {
					base = ev.Block
				}
				paidUntil[c] = base + periods*subPeriod
			}
		case "closeIfDrained":
			// Mirrors journey.go's own inference: mark closed only when this
			// package's own replay of the close condition (checked via phase
			// alone here, since supply tracking is not this file's job) is
			// plausible. Coverage does not need supply precision — it only
			// needs "was CLOSED ever observed", and journey.go's fuller
			// replay is the authority on whether the closure was legitimate.
			if derivePhase(false, paidUntil[c], ev.Block, grace) == PhaseFrozen {
				closed[c] = true
			}
		}
	}

	for _, a := range knownActions {
		if rpt.ActionsExercised[a] == 0 {
			rpt.ActionsNeverExercised = append(rpt.ActionsNeverExercised, a)
		}
	}
	for _, p := range knownPhases {
		if rpt.PhasesReached[p] == 0 {
			rpt.PhasesNeverReached = append(rpt.PhasesNeverReached, p)
		}
	}
	for _, p := range knownPhases {
		for _, a := range knownActions {
			if knownGlobalActions[a] {
				continue // phaseless: never belongs in the phase x action grid
			}
			if rpt.ComboCounts[comboKey(p, a)] == 0 {
				rpt.ComboNeverExercised = append(rpt.ComboNeverExercised, comboKey(p, a))
			}
		}
	}
	for c := range sawFrozen {
		if sawFrozen[c] {
			rpt.CreatorsReachingFrozen++
		}
	}
	for c := range sawClosed {
		if sawClosed[c] {
			rpt.CreatorsReachingClosed++
		}
	}

	return rpt
}

func (r CoverageReport) render(b *strings.Builder) {
	fmt.Fprintf(b, "--- 3. STATE AND ACTION COVERAGE ---\n")
	fmt.Fprintf(b, "Actions: %d/%d known actions exercised at least once.\n", len(knownActions)-len(r.ActionsNeverExercised), r.ActionsKnown)
	if len(r.ActionsNeverExercised) > 0 {
		fmt.Fprintf(b, "  NEVER exercised: %s\n", strings.Join(r.ActionsNeverExercised, ", "))
	}
	names := make([]string, 0, len(r.ActionsExercised))
	for a := range r.ActionsExercised {
		names = append(names, a)
	}
	sort.Slice(names, func(i, j int) bool { return r.ActionsExercised[names[i]] > r.ActionsExercised[names[j]] })
	for _, a := range names {
		fmt.Fprintf(b, "  %-16s %d\n", a, r.ActionsExercised[a])
	}

	fmt.Fprintf(b, "\nPhases: %d/%d known phases reached.\n", len(knownPhases)-len(r.PhasesNeverReached), r.PhasesKnown)
	if len(r.PhasesNeverReached) > 0 {
		fmt.Fprintf(b, "  NEVER reached: %s — every finding scoped to these phases is UNTESTED, not clean.\n", strings.Join(r.PhasesNeverReached, ", "))
	}
	for _, p := range knownPhases {
		if n, ok := r.PhasesReached[p]; ok && n > 0 {
			fmt.Fprintf(b, "  %-8s %d\n", p, n)
		}
	}
	fmt.Fprintf(b, "  creators registered=%d, ever reached FROZEN=%d, ever reached CLOSED=%d\n",
		r.CreatorsRegistered, r.CreatorsReachingFrozen, r.CreatorsReachingClosed)

	total := len(knownPhases) * gridActionCount()
	fmt.Fprintf(b, "\nPhase x Action combinations (per-market actions only; %d global action(s) excluded): %d/%d exercised at least once.\n",
		len(knownGlobalActions), total-len(r.ComboNeverExercised), total)
	if len(r.ComboNeverExercised) > 0 {
		fmt.Fprintf(b, "  NEVER exercised (%d): %s\n", len(r.ComboNeverExercised), strings.Join(r.ComboNeverExercised, ", "))
	}
}

// ---------------------------------------------------------------------------
// Failure histogram.

// FailureClass is this package's judgment call on WHY a call failed — the
// deliverable the brief asks for explicitly: "a high refusal count is not
// automatically bad, and reporting it as such would be misleading."
type FailureClass string

const (
	// ClassCorrect: the contract properly refusing something illegitimate —
	// malformed input, wrong authority, a terminal or duplicate state, an
	// intended anti-manipulation guard.
	ClassCorrect FailureClass = "CORRECT"
	// ClassUsability: a well-intentioned, non-adversarial actor doing a
	// normal thing was refused for a reason better client-side UX (live
	// limits, fresh quotes, balance checks before signing) could plausibly
	// have prevented.
	ClassUsability FailureClass = "USABILITY"
	// ClassUnexpected: core documents this path as unreachable under correct
	// behaviour. A non-zero count here is a bug signal, not routine friction.
	ClassUnexpected FailureClass = "UNEXPECTED"
)

// classifyRule is one entry in the ordered classification table below.
// Action/ErrSym/MsgContains empty means "match any". First match wins.
type classifyRule struct {
	Action, ErrSym, MsgContains string
	Class                       FailureClass
	Rationale                   string
}

// classifyTable encodes this package's read of every guard in core/*.go
// (ask.go, refund.go, market.go, prepay.go, twap.go) — see the individual
// rationale strings for the reasoning behind each call. Ordered
// most-specific-first; classify() falls back to a per-ErrSym default when
// nothing here matches.
var classifyTable = []classifyRule{
	{Action: "", ErrSym: ErrStateSym, MsgContains: "supply is zero but", Class: ClassUnexpected,
		Rationale: "core/refund.go documents this as unreachable given I3 (supply == balances + escrowed); firing means the invariant has already been violated upstream"},
	{Action: "ask", ErrSym: ErrInputSym, MsgContains: "creditsSpent exceeds maxCredits", Class: ClassCorrect,
		Rationale: "the asker's own signed slippage cap against a creator face-spike sandwich (2026-07-20 fix, core/ask.go) — a necessary security guard, not a bug; if this fires often, loosen the WALLET's default tolerance and re-quote before signing, never loosen the guard itself"},
	{Action: "ask", ErrSym: ErrBalanceSym, MsgContains: "commission must exactly equal", Class: ClassCorrect,
		Rationale: "H2 exact-commission anti-sandwich guard (2026-07-21 fix, core/ask.go): commissionHbdPaid must EXACTLY equal commissionOwedFor(face) AT EXECUTION. A band-legal SetFace between the asker's quote and the ask's execution (producer-chosen intra-block order) now reverts the ask cleanly instead of letting the surplus be HELD and booked to a treasury that used to have no exit (C2). This is the HBD-leg mirror of the maxCredits credit-leg cap — a necessary security guard; if it fires often the WALLET should re-quote commission against a fresh face before signing, never loosen the guard"},
	{Action: "ask", ErrSym: ErrBalanceSym, MsgContains: "commission underpaid", Class: ClassUsability,
		Rationale: "the client likely computed commission against a face value that legitimately changed (within the 2x/7d band) between quote and submit"},
	{Action: "ask", ErrSym: ErrBalanceSym, MsgContains: "insufficient credits", Class: ClassUsability,
		Rationale: "balance moved between quote and execution — ordinary wallet-state race, not malice"},
	{Action: "setFace", ErrSym: ErrInputSym, MsgContains: "band", Class: ClassCorrect,
		Rationale: "the 2x/7-day anti-rug guard — the entire point of SPEC §1.3b; UI-BRIEF's helper-text pattern (\"you can set between X and Y this week\") is the intended mitigation, not loosening this guard"},
	{Action: "setCap", ErrSym: ErrCapSym, Class: ClassCorrect,
		Rationale: "protects I3 (cap may never retroactively invalidate issued supply); the dashboard should show current supply as the field's live minimum, mirroring the face band's helper text"},
	{Action: "register", ErrSym: ErrStateSym, MsgContains: "already registered", Class: ClassCorrect,
		Rationale: "duplicate-registration guard"},
	{Action: "answer", ErrSym: ErrStateSym, MsgContains: "not pending", Class: ClassUsability,
		Rationale: "most plausibly a double-submit/retry after a network hiccup, not malice"},
	{Action: "reclaim", ErrSym: ErrStateSym, MsgContains: "not pending", Class: ClassUsability,
		Rationale: "an impatient asker retrying reclaim on an ask that was already answered or reclaimed"},
	{Action: "reclaim", ErrSym: ErrStateSym, MsgContains: "reclaim window not open", Class: ClassUsability,
		Rationale: "an impatient asker retrying inside the ReclaimGrace gap — see the DEAD ENDS report's transient window finding for the same mechanism"},
	{Action: "answer", ErrSym: ErrStateSym, MsgContains: "answer window closed", Class: ClassCorrect,
		Rationale: "the deadline exists to protect the asker; letting a late answer through would defeat it — but every occurrence is a real missed-income event for the creator, worth surfacing prominently in their inbox (UI-BRIEF page 6)"},
	{Action: "renew", ErrSym: ErrStateSym, MsgContains: "not open", Class: ClassCorrect,
		Rationale: "SPEC §1.7.5: wind-down is terminal by design; a returning creator re-registers rather than reviving a frozen/closed market"},
	{Action: "renew", ErrSym: ErrInputSym, MsgContains: "MaxPrepaidPeriods", Class: ClassUsability,
		Rationale: "a generous fan or creator trying to prepay further ahead than the 12-period cap allows — well-intentioned, non-obvious limit"},
	{Action: "transfer", ErrSym: ErrInputSym, MsgContains: "must be different accounts", Class: ClassUsability,
		Rationale: "a wallet UI should not let a user select themselves as the transfer recipient in the first place"},
	{Action: "withdrawTreasury", ErrSym: ErrAuthSym, Class: ClassCorrect,
		Rationale: "WithdrawTreasury is owner-gated (C2 fix, core/read.go); a non-owner caller is correctly refused — this is the only party allowed to move protocol revenue out"},
	{Action: "withdrawTreasury", ErrSym: ErrBalanceSym, Class: ClassCorrect,
		Rationale: "an over-withdrawal beyond the current treasury balance is correctly refused rather than silently clamped (core/read.go), mirroring Renew's reject-never-short-change convention; there is no path to any market reserve (I4)"},
	{Action: "withdrawTreasury", ErrSym: ErrInputSym, Class: ClassCorrect,
		Rationale: "a non-positive withdrawal amount is correctly refused (core/read.go)"},
}

// Default classification by bare ErrSym, applied when no classifyTable rule
// matches. ErrArith has no default rule of its own here because every
// ErrArith path this package found reading core (ask.go's "settlement rate
// non-positive", "credits spent rounds to zero") is documented in-source as
// unreachable given the guards ahead of it — same bucket as the ErrState
// invariant check above.
var classifyDefaults = map[string]FailureClass{
	ErrAuthSym:     ClassCorrect,
	ErrNotFoundSym: ClassCorrect,
	ErrStateSym:    ClassCorrect,
	ErrCapSym:      ClassCorrect,
	ErrPausedSym:   ClassCorrect,
	ErrOracleSym:   ClassCorrect, // twap.go: "refusing to price is always safe; pricing wrongly is not"
	ErrArithSym:    ClassUnexpected,
	ErrInputSym:    ClassUsability,
	ErrBalanceSym:  ClassUsability,
}

// Mirror core/errors.go's symbol constants without importing core (see
// report.go's package doc on why this package never imports sim OR core).
const (
	ErrAuthSym     = "AUTH"
	ErrInputSym    = "INPUT"
	ErrStateSym    = "STATE"
	ErrArithSym    = "ARITH"
	ErrBalanceSym  = "BALANCE"
	ErrPausedSym   = "PAUSED"
	ErrNotFoundSym = "NOT_FOUND"
	ErrOracleSym   = "ORACLE"
	ErrCapSym      = "CAP"
)

func classify(action, errSym, errMsg string) (FailureClass, string) {
	for _, rule := range classifyTable {
		if rule.Action != "" && rule.Action != action {
			continue
		}
		if rule.ErrSym != "" && rule.ErrSym != errSym {
			continue
		}
		if rule.MsgContains != "" && !strings.Contains(errMsg, rule.MsgContains) {
			continue
		}
		return rule.Class, rule.Rationale
	}
	if c, ok := classifyDefaults[errSym]; ok {
		return c, "no specific rule matched; defaulted by error symbol"
	}
	return ClassUnexpected, "unrecognized error symbol " + errSym + " — not in core/errors.go's known set"
}

// FailureBucket is one distinct guard: the same (action, errSym, errMsg)
// triple always comes from the same newErr() call site in core, since every
// message there is a literal string constant — so this grouping is exactly
// "one row per guard", not an arbitrary text bucket.
type FailureBucket struct {
	Action    string
	ErrSym    string
	ErrMsg    string
	Class     FailureClass
	Count     int
	Rationale string
}

// FailureReport is the full result of AnalyzeFailures.
type FailureReport struct {
	TotalCalls    int
	TotalFailures int
	Buckets       []FailureBucket // sorted by Count desc — "most common causes, ranked"
	ByClass       map[FailureClass]int

	// DeltasNonEmptyOnFailure cross-checks sim/trace.go's own documented
	// guarantee ("Empty (never nil) when a call failed... this simulator
	// actively verifies that claim") against the actual trace, rather than
	// assuming it holds.
	DeltasNonEmptyOnFailure []string

	Notes []string
}

// AnalyzeFailures builds the failure histogram and correct-vs-usability
// split for tr.
func AnalyzeFailures(tr *Trace) FailureReport {
	rpt := FailureReport{ByClass: map[FailureClass]int{}}
	if tr == nil {
		return rpt
	}
	rpt.TotalCalls = len(tr.Events)

	type key struct{ action, errSym, errMsg string }
	counts := map[key]int{}

	for i, ev := range tr.Events {
		if ev.OK {
			continue
		}
		rpt.TotalFailures++
		if len(ev.Deltas) != 0 {
			rpt.DeltasNonEmptyOnFailure = append(rpt.DeltasNonEmptyOnFailure,
				fmt.Sprintf("event %d (%s by %s): OK=false but Deltas has %d entr(ies)", i, ev.Action, ev.Actor, len(ev.Deltas)))
		}
		counts[key{ev.Action, ev.ErrSym, ev.ErrMsg}]++
	}

	for k, n := range counts {
		class, rationale := classify(k.action, k.errSym, k.errMsg)
		rpt.Buckets = append(rpt.Buckets, FailureBucket{
			Action: k.action, ErrSym: k.errSym, ErrMsg: k.errMsg,
			Class: class, Count: n, Rationale: rationale,
		})
		rpt.ByClass[class] += n
	}
	sort.Slice(rpt.Buckets, func(i, j int) bool {
		if rpt.Buckets[i].Count != rpt.Buckets[j].Count {
			return rpt.Buckets[i].Count > rpt.Buckets[j].Count
		}
		if rpt.Buckets[i].Action != rpt.Buckets[j].Action {
			return rpt.Buckets[i].Action < rpt.Buckets[j].Action
		}
		return rpt.Buckets[i].ErrMsg < rpt.Buckets[j].ErrMsg
	})

	return rpt
}

func (r FailureReport) render(b *strings.Builder) {
	fmt.Fprintf(b, "--- 4. FAILURE HISTOGRAM ---\n")
	fmt.Fprintf(b, "%d/%d calls failed.\n", r.TotalFailures, r.TotalCalls)
	if r.TotalFailures > 0 {
		fmt.Fprintf(b, "By class: CORRECT=%d (%.0f%%) USABILITY=%d (%.0f%%) UNEXPECTED=%d (%.0f%%)\n",
			r.ByClass[ClassCorrect], pct(r.ByClass[ClassCorrect], r.TotalFailures),
			r.ByClass[ClassUsability], pct(r.ByClass[ClassUsability], r.TotalFailures),
			r.ByClass[ClassUnexpected], pct(r.ByClass[ClassUnexpected], r.TotalFailures))
		fmt.Fprintf(b, "A high refusal count is not automatically bad — CORRECT means the contract\n")
		fmt.Fprintf(b, "properly refused something illegitimate. USABILITY means a reasonable actor\n")
		fmt.Fprintf(b, "hit a preventable wall. Only UNEXPECTED should ever be non-zero as a bug alarm.\n")
	}

	if len(r.Buckets) > 0 {
		fmt.Fprintf(b, "\nTop causes, ranked:\n")
		for _, bk := range r.Buckets {
			fmt.Fprintf(b, "  [%-10s] %-14s %-9s x%-4d %s\n      -> %s\n",
				bk.Class, bk.Action, bk.ErrSym, bk.Count, bk.ErrMsg, bk.Rationale)
		}
	}

	if len(r.DeltasNonEmptyOnFailure) > 0 {
		fmt.Fprintf(b, "\n%d failed call(s) had a NON-EMPTY Deltas map, contradicting sim/trace.go's own\n", len(r.DeltasNonEmptyOnFailure))
		fmt.Fprintf(b, "documented guarantee that a failed call never mutates state:\n")
		for _, n := range r.DeltasNonEmptyOnFailure {
			fmt.Fprintf(b, "  - %s\n", n)
		}
	}
}

func pct(n, total int) float64 {
	if total == 0 {
		return 0
	}
	return 100 * float64(n) / float64(total)
}
