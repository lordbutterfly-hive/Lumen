package sim

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"creator-tokens/core"
)

// TestSmokeRunNoInvariantViolation runs a small, short simulation and
// asserts it completes with no invariant violation and produces a
// non-trivial trace. This is the baseline "does the simulator itself work"
// check — the actual money-contract findings come from the real week/quarter
// runs (see the task report), not from this unit test.
func TestSmokeRunNoInvariantViolation(t *testing.T) {
	cfg := Config{Seed: 1, Days: 2, NumCreators: 4, NumActors: 12}
	eng := NewEngine(cfg)
	if err := eng.Run(cfg.Days); err != nil {
		t.Fatalf("smoke run hit an invariant violation: %v", err)
	}
	if len(eng.Trace.Events) == 0 {
		t.Fatal("expected at least one event from a 2-day run with 16 actors")
	}
}

// TestDeterministicReplay proves the core claim actors.go/engine.go both
// document: the same seed (and same config) replays byte-for-byte
// identically -- same event count, same field-by-field content, same order.
func TestDeterministicReplay(t *testing.T) {
	cfg := Config{Seed: 42, Days: 3, NumCreators: 6, NumActors: 16}

	eng1 := NewEngine(cfg)
	if err := eng1.Run(cfg.Days); err != nil {
		t.Fatalf("run 1 hit an invariant violation: %v", err)
	}
	eng2 := NewEngine(cfg)
	if err := eng2.Run(cfg.Days); err != nil {
		t.Fatalf("run 2 hit an invariant violation: %v", err)
	}

	e1, e2 := eng1.Trace.Events, eng2.Trace.Events
	if len(e1) != len(e2) {
		t.Fatalf("event count differs between replays: %d vs %d", len(e1), len(e2))
	}
	for i := range e1 {
		a, b := e1[i], e2[i]
		if a.Block != b.Block || a.Actor != b.Actor || a.Role != b.Role || a.Action != b.Action ||
			a.Creator != b.Creator || a.OK != b.OK || a.ErrSym != b.ErrSym {
			t.Fatalf("replay diverged at event %d:\n  run1=%+v\n  run2=%+v", i, a, b)
		}
	}
}

// TestDifferentSeedsDiverge is a sanity check the other direction: two
// different seeds should (overwhelmingly likely, given the population sizes
// here) NOT produce an identical trace -- guards against a bug where the RNG
// wiring accidentally ignores the seed.
func TestDifferentSeedsDiverge(t *testing.T) {
	cfg1 := Config{Seed: 1, Days: 3, NumCreators: 6, NumActors: 16}
	cfg2 := Config{Seed: 2, Days: 3, NumCreators: 6, NumActors: 16}

	eng1 := NewEngine(cfg1)
	if err := eng1.Run(cfg1.Days); err != nil {
		t.Fatalf("seed 1 run hit an invariant violation: %v", err)
	}
	eng2 := NewEngine(cfg2)
	if err := eng2.Run(cfg2.Days); err != nil {
		t.Fatalf("seed 2 run hit an invariant violation: %v", err)
	}

	if len(eng1.Trace.Events) == len(eng2.Trace.Events) {
		same := true
		for i := range eng1.Trace.Events {
			if eng1.Trace.Events[i].Block != eng2.Trace.Events[i].Block {
				same = false
				break
			}
		}
		if same {
			t.Fatal("two different seeds produced an identical event schedule -- RNG seeding looks broken")
		}
	}
}

// TestTraceJSONRoundTrip proves the trace this simulator writes is exactly
// what the task requires: valid JSON, readable without importing this
// package, and round-trippable.
func TestTraceJSONRoundTrip(t *testing.T) {
	cfg := Config{Seed: 7, Days: 2, NumCreators: 4, NumActors: 10}
	eng := NewEngine(cfg)
	if err := eng.Run(cfg.Days); err != nil {
		t.Fatalf("run hit an invariant violation: %v", err)
	}

	path := filepath.Join(t.TempDir(), "trace.json")
	if err := eng.Trace.WriteJSON(path); err != nil {
		t.Fatalf("WriteJSON: %v", err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var decoded Trace
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}
	if decoded.Seed != cfg.Seed {
		t.Fatalf("round-tripped seed = %d, want %d", decoded.Seed, cfg.Seed)
	}
	if len(decoded.Events) != len(eng.Trace.Events) {
		t.Fatalf("round-tripped event count = %d, want %d", len(decoded.Events), len(eng.Trace.Events))
	}
	for _, ev := range decoded.Events {
		if ev.Action == "" {
			t.Fatal("round-tripped event has empty Action")
		}
		if ev.Args == nil || ev.Deltas == nil {
			t.Fatalf("round-tripped event %+v has a nil Args or Deltas map (should always be {} at worst)", ev)
		}
	}
}

// TestPopulationRoleMix confirms NewPopulation actually produces every
// documented profile at least once for a population large enough to cover
// all of them, and that creator/oracle wiring matches (exactly the
// price_mover creators get an oracle feed, one each).
func TestPopulationRoleMix(t *testing.T) {
	pop := NewPopulation(99, 8, 24)

	wantCreatorRoles := map[Role]bool{
		RoleCreatorReliable: false, RoleCreatorFlaky: false,
		RoleCreatorAbandoner: false, RoleCreatorPriceMover: false,
	}
	priceMovers := 0
	for _, name := range pop.CreatorNames {
		r := pop.Actors[name].Role
		if _, ok := wantCreatorRoles[r]; !ok {
			t.Fatalf("creator %s has unexpected role %s", name, r)
		}
		wantCreatorRoles[r] = true
		if r == RoleCreatorPriceMover {
			priceMovers++
		}
	}
	for r, seen := range wantCreatorRoles {
		if !seen {
			t.Errorf("creator role %s never appeared with 8 creators", r)
		}
	}
	if len(pop.OracleForCreator) != priceMovers {
		t.Fatalf("expected exactly one oracle per price_mover creator: %d price movers, %d oracles",
			priceMovers, len(pop.OracleForCreator))
	}

	wantHolderRoles := map[Role]bool{
		RoleFan: false, RoleOneShot: false, RoleSpeculator: false, RoleTrader: false,
	}
	for _, name := range pop.HolderNames {
		r := pop.Actors[name].Role
		if _, ok := wantHolderRoles[r]; !ok {
			t.Fatalf("actor %s has unexpected role %s", name, r)
		}
		wantHolderRoles[r] = true
	}
	for r, seen := range wantHolderRoles {
		if !seen {
			t.Errorf("holder role %s never appeared with 24 actors", r)
		}
	}

	if pop.Actors[pop.KeeperName] == nil || pop.Actors[pop.KeeperName].Role != RoleKeeper {
		t.Fatal("keeper actor missing or has the wrong role")
	}
}

// TestQuarterRunHasFullLapseLadder is a slower, larger run whose purpose is
// specifically to prove the abandoner creators' markets actually complete the
// FULL ladder within a quarter and that the keeper's real keeper.Plan
// decisions fire refundHolder/closeIfDrained against them -- not just that
// the simulator runs without crashing.
//
// ★ A1 (owner ruling 2026-08-30) split the ladder in two, and this test now
// proves BOTH halves:
//   - a creator who abandons AND retires (RetireOnAbandon): ACTIVE -> OVERDUE
//     -> FROZEN -> Retire -> CLOSED, swept by the keeper (the three positive
//     assertions below, unchanged);
//   - a creator who simply goes dark (abandons, never retires): ACTIVE ->
//     OVERDUE -> FROZEN and STAYS there, never CLOSED, never swept, its
//     holders exiting on the curve. Before A1 the keeper closed these too;
//     now that would be a bug (a lapse is an inflow stop the creator can lift
//     by renewing). The negative assertion below is what fails on the
//     pre-A1 ladder.
func TestQuarterRunHasFullLapseLadder(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping quarter-length run in -short mode")
	}
	cfg := Config{Seed: 123, Days: 90, NumCreators: 8, NumActors: 24}
	eng := NewEngine(cfg)
	if err := eng.Run(cfg.Days); err != nil {
		t.Fatalf("quarter run hit an invariant violation: %v", err)
	}

	sawClosed := false
	sawRefundHolderOK := false
	sawCloseIfDrainedOK := false
	for _, ev := range eng.Trace.Events {
		if ev.Action == "refundHolder" && ev.OK {
			sawRefundHolderOK = true
		}
		if ev.Action == "closeIfDrained" && ev.OK && ev.Args["closed"] == "true" {
			sawCloseIfDrainedOK = true
		}
	}
	// At least one market must have actually closed for this test to mean
	// anything; if not, the population/timing tuning has drifted and this
	// should fail loudly rather than silently pass.
	for _, name := range eng.creatorNames {
		if core.Phase(eng.Store, name, eng.Block) == core.StateClosed {
			sawClosed = true
		}
	}
	if !sawClosed {
		t.Error("expected at least one creator market to reach CLOSED within a 90-day run")
	}
	if !sawRefundHolderOK {
		t.Error("expected at least one successful refundHolder over a 90-day run with an abandoning creator")
	}
	if !sawCloseIfDrainedOK {
		t.Error("expected at least one successful closeIfDrained over a 90-day run")
	}
}

// TestHalfYearRunGhostsStayFrozenUnderA1 is the second half of the A1 ladder
// (see TestQuarterRunHasFullLapseLadder's doc): a creator who abandons and
// never retires lapses to FROZEN and STAYS there — never CLOSED, never swept
// by the keeper — with holders exiting on the curve.
//
// A separate, longer run on purpose. Measured on seed 123 at 90 days: the
// non-retiring abandoner (creator-abandoner-1) goes dark at block 1,130,946
// but has renewed ahead to paidUntil 2,629,163, past the quarter's end block
// 2,600,466, so at 90 days no ghost has even lapsed and a "ghost is FROZEN"
// assertion would pass vacuously. Half a year (5.18M blocks) is well past its
// grace (2,773,163). The count of ghosts past grace is REQUIRED to be >= 1:
// if the population tuning ever drifts so that none exists, this fails loudly
// rather than testing nothing.
func TestHalfYearRunGhostsStayFrozenUnderA1(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping half-year run in -short mode")
	}
	cfg := Config{Seed: 123, Days: 180, NumCreators: 8, NumActors: 24}
	eng := NewEngine(cfg)
	if err := eng.Run(cfg.Days); err != nil {
		t.Fatalf("half-year run hit an invariant violation: %v", err)
	}
	ghosts := 0
	for _, name := range eng.creatorNames {
		cs := eng.creators[name]
		if cs.AbandonBlock == 0 || cs.RetireOnAbandon || cs.VoluntaryRetireBlock != 0 {
			continue
		}
		if _, retired := core.RetiredAt(eng.Store, name); retired {
			continue
		}
		if eng.Block < core.PaidUntil(eng.Store, name)+core.GraceBlocks {
			continue // not past grace yet; says nothing either way
		}
		ghosts++
		if got := core.Phase(eng.Store, name, eng.Block); got != core.StateFrozen {
			t.Errorf("A1: ghost creator %s ended the run %s, want FROZEN (a lapse must never close a market)", name, got)
		}
		sells := 0
		for _, ev := range eng.Trace.Events {
			if ev.Creator != name {
				continue
			}
			if ev.OK && (ev.Action == "refundHolder" || ev.Action == "refund" || (ev.Action == "closeIfDrained" && ev.Args["closed"] == "true")) {
				t.Errorf("A1: %s succeeded on ghost %s at block %d — a lapsed market has no pro-rata rail", ev.Action, name, ev.Block)
			}
			if ev.OK && ev.Action == "sell" && ev.Args["phase"] == core.StateFrozen {
				sells++
			}
		}
		t.Logf("ghost %s: FROZEN at run end, %d curve sells while FROZEN, never swept", name, sells)
	}
	if ghosts == 0 {
		t.Fatal("expected at least one abandoned-but-never-retired creator past its grace by run end (population tuning drifted; the A1 half of the ladder went untested)")
	}
}
