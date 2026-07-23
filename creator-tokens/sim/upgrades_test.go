package sim

import (
	"container/heap"
	"math/big"
	"path/filepath"
	"strings"
	"testing"

	"creator-tokens/core"
	"creator-tokens/sim/analysis"
)

// upgrades_test.go — engine-level proofs for the three sim enhancements the
// scrutinizer asked for: the C2 treasury exit is actually driven and drains to
// zero; the H1 fund fail-safes hold with NO keeper; the H2 exact-commission
// guard rejects a same-block SetFace-before-ask sandwich; and the adversarial
// intra-block order actually reorders the sandwich.

// analyzeRun runs a real engine and feeds its trace back through the analysis
// layer exactly as cmd/simreport would (round-tripping through JSON so the
// test exercises the same path the tool does, not the in-memory structs).
func analyzeRun(t *testing.T, cfg Config) analysis.Report {
	t.Helper()
	eng := NewEngine(cfg)
	if err := eng.Run(cfg.Days); err != nil {
		t.Fatalf("run hit an invariant violation: %v", err)
	}
	path := filepath.Join(t.TempDir(), "trace.json")
	if err := eng.Trace.WriteJSON(path); err != nil {
		t.Fatalf("WriteJSON: %v", err)
	}
	tr, err := analysis.LoadTrace(path)
	if err != nil {
		t.Fatalf("LoadTrace: %v", err)
	}
	return analysis.Analyze(tr)
}

// TestOwnerDrainsTreasuryToZero — Upgrade 1 (C2). The owner actor periodically
// withdraws the whole accrued treasury, so over a real run the ledger analysis
// must observe the exit exercised AND the treasury driven to EXACTLY 0. Pre-
// fix (no WithdrawTreasury) this same run would flag TreasuryFrozenFlag; the
// point is that the sim now DRIVES the exit and proves it works.
func TestOwnerDrainsTreasuryToZero(t *testing.T) {
	rpt := analyzeRun(t, Config{Seed: 1, Days: 20, NumCreators: 8, NumActors: 24})

	if !rpt.Ledger.TreasuryExitExercised {
		t.Fatal("treasury exit was never exercised — the owner actor did not drive WithdrawTreasury")
	}
	if !rpt.Ledger.TreasuryReachedZero {
		t.Fatalf("treasury was never driven to 0 by the owner (final=%s, max=%s) — drainability not proven",
			rpt.Ledger.TreasuryFinal, rpt.Ledger.TreasuryMaxObserved)
	}
	if rpt.Ledger.TreasuryFrozenFlag {
		t.Error("TreasuryFrozenFlag must be false once the exit is driven")
	}
	if rpt.Ledger.Left.TreasuryWithdrawn.Sign() <= 0 {
		t.Errorf("expected a positive amount withdrawn, got %s", rpt.Ledger.Left.TreasuryWithdrawn)
	}
	if !rpt.Ledger.Closes {
		t.Errorf("money identity must still close with the treasury exit in play: %s", rpt.Ledger.FirstBadReason)
	}

	// The whole run must remain non-critical (the exit is exercised).
	if rpt.Critical() {
		t.Error("a run where the owner drains the treasury must not be Critical on the treasury gate")
	}
}

// TestKeeperAbsentFailSafesHold — Upgrade 3(a). With NO keeper at all, the
// fund fail-safes must still hold: holders self-refund (no persistent dead
// ends), abandoned escrows are still resolved by a third party (permissionless
// reclaims by non-keeper actors > 0), no market is bricked, and the owner's
// treasury exit is unaffected by the keeper's absence.
func TestKeeperAbsentFailSafesHold(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping the 90-day absent-keeper run in -short mode")
	}
	cfg := Config{Seed: 1, Days: 90, NumCreators: 8, NumActors: 24, KeeperProfile: KeeperAbsent}
	eng := NewEngine(cfg)
	if err := eng.Run(cfg.Days); err != nil {
		t.Fatalf("absent-keeper run hit an invariant violation: %v", err)
	}

	// Confirm the keeper genuinely never acted: RefundHolder and CloseIfDrained
	// are keeper-only in this simulator, so there must be zero of them.
	refunds := 0
	for _, ev := range eng.Trace.Events {
		switch ev.Action {
		case "refundHolder", "closeIfDrained":
			t.Fatalf("keeper acted (%s at block %d) despite KeeperProfile=absent", ev.Action, ev.Block)
		case "refund":
			if ev.OK {
				refunds++
			}
		}
	}
	if refunds == 0 {
		t.Error("expected holders to still self-refund without a keeper — the pull fail-safe")
	}

	path := filepath.Join(t.TempDir(), "trace.json")
	if err := eng.Trace.WriteJSON(path); err != nil {
		t.Fatalf("WriteJSON: %v", err)
	}
	tr, err := analysis.LoadTrace(path)
	if err != nil {
		t.Fatalf("LoadTrace: %v", err)
	}
	rpt := analysis.Analyze(tr)

	if len(rpt.DeadEnds.Persistent) != 0 {
		t.Errorf("expected no persistent per-actor dead ends without a keeper, got %+v", rpt.DeadEnds.Persistent)
	}
	if len(rpt.DeadEnds.MarketDeadEnds) != 0 {
		t.Errorf("expected no market bricked without a keeper (abandoned escrows resolvable by any third party), got %+v", rpt.DeadEnds.MarketDeadEnds)
	}
	if rpt.DeadEnds.PermissionlessReclaims == 0 {
		t.Error("expected >=1 permissionless reclaim driven by a NON-keeper third party — the H1 fail-safe with no keeper")
	}
	if !rpt.Ledger.TreasuryReachedZero {
		t.Error("owner treasury exit must still drain to 0 regardless of keeper presence")
	}
}

// TestH2SetFaceDropSandwichRejected — Upgrade 3(b). Drives the exact H2
// sandwich through the sim's own wrappers, in a single block: the asker pays
// the commission owed at the OLD face, a band-legal SetFace then DROPS the
// face, and the ask executes. The H2 exact-commission fix must reject it
// (commissionHbdPaid must EXACTLY equal commissionOwedFor(face_at_execution)),
// while the same commission paid against the UNCHANGED face succeeds — proving
// the guard rejects the sandwich specifically, not asks in general.
func TestH2SetFaceDropSandwichRejected(t *testing.T) {
	cfg := Config{Seed: 7, Days: 5, NumCreators: 4, NumActors: 8, AdversarialOrder: true}
	eng := NewEngine(cfg)
	eng.endBlock = genesisBlock + uint64(cfg.Days)*core.BlocksPerDay
	eng.Block = genesisBlock

	creator := eng.creatorNames[0]
	asker := eng.pop.HolderNames[0]

	// Pin a known face so the two commission figures provably differ, then
	// register (Register anchors the band at this face).
	eng.creators[creator].InitialFace = 4000
	eng.doRegister(creator)
	if eng.haltErr != nil {
		t.Fatalf("register halted: %v", eng.haltErr)
	}
	if core.Face(eng.Store, creator).Int64() != 4000 {
		t.Fatalf("face = %s, want 4000", core.Face(eng.Store, creator))
	}

	// Fund the asker with credits so the CONTROL ask can actually settle.
	// PORTED off the deleted PAR mint (doPrepay): Buy on the curve is the
	// only issuance path, and the argument is a TOKEN count now, not an HBD
	// amount. The asker's wallet must cover cost+fee, so this also tops the
	// wallet up first — doBuy silently refuses an unaffordable buy (it
	// models the chain's HiveDraw), which would have made the control ask
	// fail for the wrong reason.
	eng.pop.Actors[asker].HBD = addBig(eng.pop.Actors[asker].HBD, big.NewInt(1_000_000_000))
	eng.doBuy(asker, creator, big.NewInt(8000))
	if eng.haltErr != nil {
		t.Fatalf("buy halted: %v", eng.haltErr)
	}
	if got := core.BalanceOf(eng.Store, creator, asker); got.Cmp(big.NewInt(8000)) != 0 {
		t.Fatalf("asker credits = %s, want 8000 (the funding Buy did not land)", got)
	}

	oldOwed := bpsFloorBig(big.NewInt(4000), core.CommissionBps) // 480
	maxCredits := big.NewInt(80000)

	// CONTROL: correct commission at the current (unchanged) face -> succeeds.
	eng.doAskExecute(asker, creator, maxCredits, oldOwed, "cid-control", core.MinAskDeadline)
	control := eng.Trace.Events[len(eng.Trace.Events)-1]
	if control.Action != "ask" || !control.OK {
		t.Fatalf("control ask should succeed (commission %s matches owed at face 4000), got OK=%v err=%s/%s", oldOwed, control.OK, control.ErrSym, control.ErrMsg)
	}

	// SANDWICH: band-legal drop 4000 -> 3000 (within the 2x band), same block.
	eng.doSetFace(creator, 3000)
	sf := eng.Trace.Events[len(eng.Trace.Events)-1]
	if sf.Action != "setFace" || !sf.OK {
		t.Fatalf("band-legal face drop 4000->3000 should succeed, got OK=%v err=%s/%s", sf.OK, sf.ErrSym, sf.ErrMsg)
	}

	// The asker's already-signed ask still pays the OLD 480; owed at 3000 is
	// now 360. The H2 exact-commission guard must reject it.
	eng.doAskExecute(asker, creator, maxCredits, oldOwed, "cid-sandwich", core.MinAskDeadline)
	sandwich := eng.Trace.Events[len(eng.Trace.Events)-1]
	if sandwich.Action != "ask" {
		t.Fatalf("expected the last event to be the sandwich ask, got %q", sandwich.Action)
	}
	if sandwich.OK {
		t.Fatal("H2 VIOLATION: the sandwich ask (paid 480 owed at old face 4000, executes against dropped face 3000 owed 360) was ACCEPTED — the exact-commission guard did not fire")
	}
	if sandwich.ErrSym != "BALANCE" || !strings.Contains(sandwich.ErrMsg, "commission must exactly equal") {
		t.Errorf("expected the H2 exact-commission rejection, got %s: %s", sandwich.ErrSym, sandwich.ErrMsg)
	}
}

// TestAdversarialIntraBlockOrder — Upgrade 3(b) plumbing. At the same block,
// strict FIFO runs items in schedule order; the adversarial order front-runs a
// creator's own move (SetFace via creator-tick) AHEAD of a victim's ask
// execution scheduled earlier, which is what makes a same-block sandwich
// producible organically.
func TestAdversarialIntraBlockOrder(t *testing.T) {
	check := func(adversarial bool, wantFirst string) {
		t.Helper()
		eng := NewEngine(Config{Seed: 1, Days: 1, NumCreators: 1, NumActors: 1, AdversarialOrder: adversarial})
		var order []string
		// ask-execute is scheduled FIRST (smaller seq); creator-tick SECOND.
		eng.schedule(1000, "ask-execute", func(e *Engine) { order = append(order, "ask-execute") })
		eng.schedule(1000, "creator-tick", func(e *Engine) { order = append(order, "creator-tick") })
		for eng.heap.Len() > 0 {
			it := heap.Pop(&eng.heap).(*scheduledItem)
			it.fn(eng)
		}
		if len(order) != 2 || order[0] != wantFirst {
			t.Errorf("adversarial=%v: order=%v, want %q first", adversarial, order, wantFirst)
		}
	}
	check(false, "ask-execute") // FIFO: whatever was scheduled first
	check(true, "creator-tick") // adversarial: the creator front-runs the ask at the same block
}
