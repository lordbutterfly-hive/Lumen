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
		got := derivePhase(c.closed, paidUntil, c.block, grace)
		if got != c.want {
			t.Errorf("derivePhase(closed=%v, paidUntil=%d, block=%d, grace=%d) = %s, want %s",
				c.closed, paidUntil, c.block, grace, got, c.want)
		}
	}
}

func TestRefundPayout_MirrorsCoreRefundGo(t *testing.T) {
	// floor(reserve*credits/supply), capped at credits.
	got := refundPayout(mustBig("1000"), mustBig("300"), mustBig("1000"))
	if got.Cmp(mustBig("300")) != 0 {
		t.Errorf("exact peg: got %s, want 300", got)
	}
	// Deficit case: reserve < supply, floor rounds down in the reserve's favour.
	got = refundPayout(mustBig("999"), mustBig("300"), mustBig("1000"))
	if got.Cmp(mustBig("299")) != 0 { // floor(999*300/1000) = floor(299.7) = 299
		t.Errorf("floor rounding: got %s, want 299", got)
	}
	// PAR cap: if reserve somehow exceeds supply, payout is capped at credits.
	got = refundPayout(mustBig("5000"), mustBig("300"), mustBig("1000"))
	if got.Cmp(mustBig("300")) != 0 {
		t.Errorf("PAR cap: got %s, want 300 (capped, not 1500)", got)
	}
}
