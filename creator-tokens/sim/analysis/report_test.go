package analysis

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReport_CriticalTracksBothGates(t *testing.T) {
	closing := LedgerReport{Closes: true}
	broken := LedgerReport{Closes: false}
	noDeadEnds := DeadEndReport{}
	withDeadEnd := DeadEndReport{Persistent: []PersistentDeadEnd{{Actor: "bob"}}}

	cases := []struct {
		name string
		r    Report
		want bool
	}{
		{"clean", Report{Ledger: closing, DeadEnds: noDeadEnds}, false},
		{"broken ledger only", Report{Ledger: broken, DeadEnds: noDeadEnds}, true},
		{"persistent dead end only", Report{Ledger: closing, DeadEnds: withDeadEnd}, true},
		{"both", Report{Ledger: broken, DeadEnds: withDeadEnd}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.r.Critical(); got != c.want {
				t.Errorf("Critical() = %v, want %v", got, c.want)
			}
		})
	}
}

func TestReport_TransientGapAloneIsNotCritical(t *testing.T) {
	// A ReclaimGapWindow entry alone (no Persistent entries) must not flip
	// Critical() — see journey.go's doc on why that line is drawn there.
	r := Report{
		Ledger: LedgerReport{Closes: true},
		DeadEnds: DeadEndReport{
			ReclaimGapWindows: []ReclaimGapWindow{{Creator: "alice", Seq: 0}},
		},
	}
	if r.Critical() {
		t.Error("a ReclaimGapWindow with no Persistent entries must not make the report Critical")
	}
}

func TestAnalyze_EndToEndOnASyntheticTrace(t *testing.T) {
	// register(10000) + answer-booked commission(240) = 10240 accrues to the
	// treasury; the owner then withdraws exactly that, so the C2 reachable-exit
	// check passes (treasury drained to 0) and the trace is genuinely clean.
	tr := &Trace{Seed: 42, Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000),
		prepayEv(200, "bob", "alice", 5000),
		askEv(300, "bob", "alice", 240, 28800, 2000),
		answerEv(310, "alice", "alice", 0),
		refundEv(400, "bob", "alice", 3000),
		withdrawTreasuryEv(500, "owner-1", 10240),
	}}
	report := Analyze(tr)
	if report.Critical() {
		t.Fatalf("expected a clean synthetic trace to be non-critical: ledger closes=%v reason=%q frozen=%v marketDeadEnds=%d, persistent=%v",
			report.Ledger.Closes, report.Ledger.FirstBadReason, report.Ledger.TreasuryFrozenFlag, len(report.DeadEnds.MarketDeadEnds), report.DeadEnds.Persistent)
	}
	if !report.Ledger.TreasuryExitExercised || !report.Ledger.TreasuryReachedZero {
		t.Errorf("expected treasury exit exercised and drained to 0, got exercised=%v reachedZero=%v final=%s",
			report.Ledger.TreasuryExitExercised, report.Ledger.TreasuryReachedZero, report.Ledger.TreasuryFinal)
	}
	out := report.String()
	for _, want := range []string{
		"WHERE THE MONEY WENT", "DEAD ENDS", "STATE AND ACTION COVERAGE", "FAILURE HISTOGRAM", "VERDICT",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("report output missing section %q", want)
		}
	}
}

func TestLoadTrace_RoundTrips(t *testing.T) {
	tr := &Trace{Seed: 7, Config: map[string]string{"graceBlocks": "100"}, Events: []Event{
		registerEv(1, "alice", 2000, 1_000_000),
	}}
	data, err := json.MarshalIndent(tr, "", "  ")
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	path := filepath.Join(t.TempDir(), "trace.json")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	got, err := LoadTrace(path)
	if err != nil {
		t.Fatalf("LoadTrace: %v", err)
	}
	if got.Seed != 7 || len(got.Events) != 1 || got.Events[0].Actor != "alice" {
		t.Errorf("LoadTrace round-trip mismatch: %+v", got)
	}
	if got.Config["graceBlocks"] != "100" {
		t.Errorf("Config not preserved: %+v", got.Config)
	}
}

func TestLoadTrace_MissingFile(t *testing.T) {
	if _, err := LoadTrace(filepath.Join(t.TempDir(), "does-not-exist.json")); err == nil {
		t.Error("expected an error loading a nonexistent trace file")
	}
}

func TestDerivePhase_MirrorsCoreMarketGo(t *testing.T) {
	grace := uint64(144000)
	paidUntil := uint64(1000)
	cases := []struct {
		block  uint64
		closed bool
		want   string
	}{
		{500, false, PhaseActive},
		{1000, false, PhaseActive}, // block == paidUntil is still ACTIVE (core/market.go: "block <= paidUntil")
		{1001, false, PhaseOverdue},
		{1000 + grace - 1, false, PhaseOverdue},
		{1000 + grace, false, PhaseFrozen}, // FROZEN begins AT the +GraceBlocks boundary, not after
		{1000 + grace + 1, false, PhaseFrozen},
		{1000 + grace + 1, true, PhaseClosed}, // a stored CLOSED always wins
	}
	for _, c := range cases {
		// retiredAt=0, retired=false: the pre-F4 behaviour, unchanged.
		got := derivePhase(c.closed, paidUntil, c.block, grace, 0, false)
		if got != c.want {
			t.Errorf("derivePhase(closed=%v, paidUntil=%d, block=%d, grace=%d, retired=false) = %s, want %s",
				c.closed, paidUntil, c.block, grace, got, c.want)
		}
	}
}

// TestDerivePhase_RetireTermMirrorsCorePhaseMax — F4, an adversarial review.
// derivePhase used to take no retiredAt input at all (see the fix's own doc
// on derivePhase and journey.go's file doc for what that blinded). This
// pins the retire half against core/market.go's own Phase()/maxPhase table
// (RULING D): phase = MAX(naturalPhase, retiredPhase), retiredPhase =
// block<retiredAt+GraceBlocks ? OVERDUE : FROZEN — including the
// load-bearing MAX property that retiring can only ever push a market DOWN
// the ladder, never up (a market ALREADY naturally FROZEN stays FROZEN
// through a fresh retire notice, which alone would only read OVERDUE).
func TestDerivePhase_RetireTermMirrorsCorePhaseMax(t *testing.T) {
	grace := uint64(144000)
	paidUntil := uint64(1_000_000) // far in the future: natural phase is ACTIVE throughout every case below
	retiredAt := uint64(1000)

	cases := []struct {
		name  string
		block uint64
		want  string
	}{
		{"retire notice open", retiredAt + 1, PhaseOverdue},
		{"retire notice, boundary-1", retiredAt + grace - 1, PhaseOverdue},
		{"retire notice fully expired (boundary)", retiredAt + grace, PhaseFrozen}, // FROZEN begins AT the +GraceBlocks boundary, same convention as the natural ladder
		{"long after retire", retiredAt + grace + 999, PhaseFrozen},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := derivePhase(false, paidUntil, c.block, grace, retiredAt, true)
			if got != c.want {
				t.Errorf("derivePhase(paidUntil=%d(far future), block=%d, retiredAt=%d, retired=true) = %s, want %s",
					paidUntil, c.block, retiredAt, got, c.want)
			}
		})
	}

	// THE MAX IS LOAD-BEARING (core/market.go's own emphasis on Phase's
	// doc): a market that is ALREADY naturally FROZEN (paidUntil long past,
	// well past its own grace) must STAY FROZEN through a brand-new retire
	// notice, which in isolation would only read OVERDUE. Retiring may only
	// ever make a market MORE frozen, never less.
	alreadyFrozenPaidUntil := uint64(100)
	block := alreadyFrozenPaidUntil + grace // exactly the natural FROZEN boundary (derivePhase's own convention: FROZEN begins AT +GraceBlocks)
	freshRetireAt := block - 1000           // retired 1000 blocks before this query — notice alone (block < freshRetireAt+grace) reads OVERDUE
	got := derivePhase(false, alreadyFrozenPaidUntil, block, grace, freshRetireAt, true)
	if got != PhaseFrozen {
		t.Errorf("MAX violated: a naturally-FROZEN market (paidUntil=%d, block=%d) retiring at %d (notice alone would be OVERDUE) read %s, want FROZEN",
			alreadyFrozenPaidUntil, block, freshRetireAt, got)
	}

	// A stored CLOSED always wins, retire notwithstanding.
	if got := derivePhase(true, paidUntil, retiredAt+1, grace, retiredAt, true); got != PhaseClosed {
		t.Errorf("derivePhase(closed=true, ..., retired=true) = %s, want PhaseClosed (closed always wins)", got)
	}
}

func TestRefundPayout_MirrorsCoreRefundGo(t *testing.T) {
	// floor(reserve*credits/supply). NO cap — see refundPayout's own doc
	// (defect fix, 2026-07-28): a stale PAR-era clamp at `credits` used to
	// sit here, and this third sub-test used to assert THAT clamp fired
	// ("capped, not 1500") as if it were correct behaviour. It was not:
	// core/refund.go's own file header names deleting that exact clamp as
	// RULING A's fix ("THE PAR CAP IS DELETED... a CONFISCATION"), and this
	// package's copy of the formula had silently drifted back to the
	// deleted, incorrect behaviour. Once real markets carry a curve-priced
	// reserve (BasePrice=1000 alone guarantees reserve > supply for any
	// non-trivial market), the OLD assertion here actively verified a bug.
	got := refundPayout(mustBig("1000"), mustBig("300"), mustBig("1000"))
	if got.Cmp(mustBig("300")) != 0 {
		t.Errorf("exact peg: got %s, want 300", got)
	}
	// Deficit case: reserve < supply, floor rounds down in the reserve's favour.
	got = refundPayout(mustBig("999"), mustBig("300"), mustBig("1000"))
	if got.Cmp(mustBig("299")) != 0 { // floor(999*300/1000) = floor(299.7) = 299
		t.Errorf("floor rounding: got %s, want 299", got)
	}
	// A curve-appreciated reserve (reserve > supply, the ORDINARY case once
	// BasePrice > 1 — every real market): the payout scales with the
	// reserve, uncapped. floor(5000*300/1000) = 1500 exactly, not clamped
	// down to the raw credit count.
	got = refundPayout(mustBig("5000"), mustBig("300"), mustBig("1000"))
	if got.Cmp(mustBig("1500")) != 0 {
		t.Errorf("curve-appreciated reserve: got %s, want 1500 (uncapped — the exact amount RULING A's fix restores)", got)
	}
}
