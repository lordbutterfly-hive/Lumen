package analysis

import "testing"

// upgrades_test.go — deterministic proofs for the two blind spots the sim
// scrutinizer found (C2 treasury exit, H1 market dead ends), driven from
// hand-built synthetic traces so the assertions do not depend on a random
// population happening to produce the stuck state. The real engine runs
// exercise the same paths organically; these pin the analysis machinery
// itself: it must FLAG the pre-fix state and PASS the post-fix state.

// --- Upgrade 1 / C2: treasury reachable-exit check ---

// TestTreasury_FrozenWhenNoExitEverExercised is the PRE-FIX detection. A trace
// where the treasury accrues (a registration fee) but nothing ever withdraws
// it is exactly C2: 100% of protocol revenue locked. A conservation-only
// check renders it clean (entered==left+sits with the value sitting in the
// treasury bucket); the reachable-exit check must FLAG it and make the report
// Critical instead.
func TestTreasury_FrozenWhenNoExitEverExercised(t *testing.T) {
	tr := &Trace{Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000), // treasury += 10000, never withdrawn
	}}

	rpt := AnalyzeLedger(tr)
	if !rpt.Closes {
		t.Fatalf("conservation should still hold (the value just SITS): %s", rpt.FirstBadReason)
	}
	if !rpt.TreasuryFrozenFlag {
		t.Errorf("expected TreasuryFrozenFlag=true — a treasury that accrued %s and was never withdrawn is C2, must not read as clean", rpt.TreasuryFinal)
	}
	if rpt.TreasuryExitExercised {
		t.Error("TreasuryExitExercised should be false when no withdrawTreasury appears in the trace")
	}
	if rpt.TreasuryFinal.Cmp(mustBig("10000")) != 0 {
		t.Errorf("TreasuryFinal = %s, want 10000", rpt.TreasuryFinal)
	}

	report := Analyze(tr)
	if !report.Critical() {
		t.Error("a frozen-forever treasury (C2) must make the report Critical — flagged, not counted clean")
	}
}

// TestTreasury_DrainableToZeroPassesPostFix is the POST-FIX pass. The owner
// withdraws exactly the accrued treasury, so the reachable-exit check clears:
// the exit was exercised AND the treasury reached EXACTLY 0 — the drainability
// the brief asks for ("an owner CAN withdraw the accrued treasury and it
// reaches 0"), not merely conservation.
func TestTreasury_DrainableToZeroPassesPostFix(t *testing.T) {
	tr := &Trace{Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000), // treasury += 10000
		renewEv(200, "alice", "alice", 1, 10000),  // treasury += 10000 -> 20000
		withdrawTreasuryEv(300, "owner-1", 20000), // owner drains it all
	}}

	rpt := AnalyzeLedger(tr)
	if !rpt.Closes {
		t.Fatalf("identity should close: %s", rpt.FirstBadReason)
	}
	if rpt.TreasuryFrozenFlag {
		t.Error("TreasuryFrozenFlag must be false once an exit was exercised")
	}
	if !rpt.TreasuryExitExercised {
		t.Error("expected TreasuryExitExercised=true")
	}
	if !rpt.TreasuryReachedZero {
		t.Error("expected TreasuryReachedZero=true — the owner drained the accrued treasury to exactly 0")
	}
	if rpt.TreasuryFinal.Sign() != 0 {
		t.Errorf("TreasuryFinal = %s, want 0", rpt.TreasuryFinal)
	}
	if rpt.Left.TreasuryWithdrawn.Cmp(mustBig("20000")) != 0 {
		t.Errorf("Left.TreasuryWithdrawn = %s, want 20000", rpt.Left.TreasuryWithdrawn)
	}

	report := Analyze(tr)
	if report.Critical() {
		t.Error("a fully-drained treasury must not be Critical")
	}
}

// TestTreasury_PartialDrainStillExercisedButNotZero covers the honest middle
// case: an exit was exercised but revenue kept accruing after the last
// withdrawal, so the treasury is non-zero at trace end. Not frozen (an exit
// exists and ran), but drainability-to-zero is not claimed either.
func TestTreasury_PartialDrainStillExercisedButNotZero(t *testing.T) {
	tr := &Trace{Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000), // treasury 10000
		withdrawTreasuryEv(200, "owner-1", 10000), // -> 0 (reached zero here)
		renewEv(300, "alice", "alice", 1, 10000),  // treasury 10000 again, never withdrawn
	}}
	rpt := AnalyzeLedger(tr)
	if rpt.TreasuryFrozenFlag {
		t.Error("must not be frozen: an exit WAS exercised")
	}
	if !rpt.TreasuryExitExercised {
		t.Error("expected exit exercised")
	}
	if !rpt.TreasuryReachedZero {
		t.Error("the treasury did hit 0 at the withdrawal, even if it accrued again after")
	}
	if rpt.TreasuryFinal.Cmp(mustBig("10000")) != 0 {
		t.Errorf("TreasuryFinal = %s, want 10000 (accrued after the last withdrawal)", rpt.TreasuryFinal)
	}
}

// --- Upgrade 2 / H1: market-level dead ends ---

// The block arithmetic these two tests share: register at block 0 sets
// paidUntil = SubscriptionPeriod; with no renew the market is FROZEN from
// paidUntil+GraceBlocks onward. An ask at block 200 with a 1-day deadline has
// its reclaim window open from deadline+ReclaimGrace. A trailing event far
// past both puts the trace end firmly in FROZEN with the reclaim window long
// open.
func h1EndBlock() uint64 { return defaultSubscriptionPeriod + defaultGraceBlocks + 100_000 }

// TestMarketDeadEnd_FrozenWithUnresolvedEscrowIsFlagged is the class journey.go
// was BLIND to before Upgrade 2: an abandoned PENDING escrow, never reclaimed,
// on a market that has drifted to FROZEN. Supply is pinned > 0, CloseIfDrained
// can never fire, the creator can never re-register — a permanent brick
// pre-fix. This must be flagged as a MarketDeadEnd and make the report
// Critical.
func TestMarketDeadEnd_FrozenWithUnresolvedEscrowIsFlagged(t *testing.T) {
	end := h1EndBlock()
	tr := &Trace{Events: []Event{
		registerEv(0, "alice", 2000, 1_000_000),
		prepayEv(100, "bob", "alice", 5000),
		askEv(200, "bob", "alice", 240, 28800, 2000), // deadline 29000, reclaim opens 30200
		// bob never reclaims; alice never answers, never renews -> FROZEN.
		{Block: end, Day: 40, Actor: "someone", Action: "recordObs", Creator: "alice", Args: map[string]string{"rate": "1"}, OK: true, Deltas: map[string]string{}},
	}}

	rpt := AnalyzeDeadEnds(tr)
	if len(rpt.MarketDeadEnds) != 1 {
		t.Fatalf("expected exactly 1 market dead end, got %d: %+v", len(rpt.MarketDeadEnds), rpt.MarketDeadEnds)
	}
	m := rpt.MarketDeadEnds[0]
	if m.Creator != "alice" || m.Asker != "bob" || m.Phase != PhaseFrozen {
		t.Errorf("market dead end = %+v, want alice/bob/FROZEN", m)
	}
	if rpt.PermissionlessReclaims != 0 {
		t.Errorf("PermissionlessReclaims = %d, want 0 (nobody resolved it)", rpt.PermissionlessReclaims)
	}

	report := Report{Ledger: LedgerReport{Closes: true}, DeadEnds: rpt}
	if !report.Critical() {
		t.Error("a FROZEN market bricked by an unresolved escrow (H1) must make the report Critical")
	}
}

// TestMarketDeadEnd_ResolvedByPermissionlessReclaim is the POST-FIX resolution:
// a THIRD PARTY (a keeper, but any account works) pushes the now-permissionless
// Reclaim once the window opens, which returns the escrowed credits to the
// asker's balance; RefundHolder then drains that balance and CloseIfDrained
// winds the market down. No market dead end remains, and the end-to-end
// permissionless path is counted.
func TestMarketDeadEnd_ResolvedByPermissionlessReclaim(t *testing.T) {
	closeBlock := defaultSubscriptionPeriod + defaultGraceBlocks + 2000 // FROZEN
	tr := &Trace{Events: []Event{
		registerEv(0, "alice", 2000, 1_000_000),
		prepayEv(100, "bob", "alice", 5000),
		askEv(200, "bob", "alice", 240, 28800, 2000),
		// A third party (keeper1 != bob) pushes the permissionless reclaim; it
		// always pays bob, never keeper1.
		reclaimEv(closeBlock, "keeper1", "alice", 0),
		refundHolderEv(closeBlock+1, "keeper1", "alice", "bob"),
		newEv(closeBlock+2, "keeper1", "closeIfDrained", "alice").build(),
	}}

	rpt := AnalyzeDeadEnds(tr)
	if len(rpt.MarketDeadEnds) != 0 {
		t.Fatalf("expected 0 market dead ends after a permissionless reclaim resolved it, got %+v", rpt.MarketDeadEnds)
	}
	if rpt.PermissionlessReclaims != 1 {
		t.Errorf("PermissionlessReclaims = %d, want 1 (keeper1 pushed it, not the asker bob)", rpt.PermissionlessReclaims)
	}
	if rpt.MarketsClosedAfterPermissionlessReclaim != 1 {
		t.Errorf("MarketsClosedAfterPermissionlessReclaim = %d, want 1 (alice reached CLOSED after the third-party reclaim)", rpt.MarketsClosedAfterPermissionlessReclaim)
	}
	if rpt.ClosedMarkets != 1 {
		t.Errorf("ClosedMarkets = %d, want 1", rpt.ClosedMarkets)
	}

	report := Report{Ledger: LedgerReport{Closes: true}, DeadEnds: rpt}
	if report.Critical() {
		t.Error("a market resolved to CLOSED via permissionless reclaim must not be Critical")
	}
}

// TestMarketDeadEnd_SelfReclaimIsNotCountedPermissionless guards the counter:
// an ordinary self-reclaim (caller == asker) must NOT be counted as a
// third-party push.
func TestMarketDeadEnd_SelfReclaimIsNotCountedPermissionless(t *testing.T) {
	tr := &Trace{Events: []Event{
		registerEv(0, "alice", 2000, 1_000_000),
		prepayEv(100, "bob", "alice", 5000),
		askEv(200, "bob", "alice", 240, 28800, 2000),
		reclaimEv(200+28800+defaultReclaimGrace+1, "bob", "alice", 0), // bob reclaims their own
	}}
	rpt := AnalyzeDeadEnds(tr)
	if rpt.PermissionlessReclaims != 0 {
		t.Errorf("PermissionlessReclaims = %d, want 0 for a self-reclaim", rpt.PermissionlessReclaims)
	}
}

// TestCoverage_WithdrawTreasuryIsAKnownGlobalAction confirms the new action is
// counted in the tally but excluded from the phase x action grid.
func TestCoverage_WithdrawTreasuryIsAKnownGlobalAction(t *testing.T) {
	tr := &Trace{Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000),
		withdrawTreasuryEv(200, "owner-1", 10000),
	}}
	rpt := AnalyzeCoverage(tr)
	if rpt.ActionsExercised["withdrawTreasury"] != 1 {
		t.Errorf("withdrawTreasury exercise count = %d, want 1", rpt.ActionsExercised["withdrawTreasury"])
	}
	for _, c := range rpt.ComboNeverExercised {
		if c == comboKey(PhaseActive, "withdrawTreasury") || c == comboKey(PhaseFrozen, "withdrawTreasury") {
			t.Errorf("withdrawTreasury must be excluded from the phase x action grid, found %q", c)
		}
	}
	// grid denominator excludes the one global action.
	if gridActionCount() != len(knownActions)-1 {
		t.Errorf("gridActionCount() = %d, want %d", gridActionCount(), len(knownActions)-1)
	}
}
