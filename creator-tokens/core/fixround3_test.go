package core

import (
	"math/big"
	"testing"
)

// fixround3_test.go — named regression tests for adversarial FIX ROUND 3
// (2026-07-22). One test (or cluster) per finding id.
//
//	WINDDOWN-RESET-1  windDownOpenBlock unconditionally preferred retiredAt even
//	                  when the market had ALREADY been continuously winding down
//	                  (naturally FROZEN, un-renewable) BEFORE Retire was called.
//	                  A later, ordinary, explicitly-legal Retire silently moved
//	                  the RefundHolder DoS-backstop anchor FORWARD by
//	                  (retiredAt − naturalFreeze), re-arming a full extra
//	                  ExitTaxDecayBlocks of force-push immunity for every
//	                  remaining griefer-refreshed position — removing the ~42-day
//	                  cap the liveness backstop was believed to have.
//	                  -> FIX: anchor to whichever wind-down trigger fired FIRST,
//	                     i.e. min(retiredAt, naturalFreeze) when both are past
//	                     (market.go windDownOpenBlock).
//
// GUARD: this touches only the push GATE (windDownOpenBlock), never the curve
// math or the reserve debit, so R === area(S) in the trading phase and the
// wind-down terminal exactness (C-24: a complete wind-down drains R to exactly
// 0) are unchanged — both asserted below.

// ---------------------------------------------------------------------------
// WINDDOWN-RESET-1 (anchor unit test) — the combined ordering the existing
// TestWindDownOpenBlock_Sources never paired: natural freeze FIRST, Retire
// LATER. windDownOpenBlock must stay pinned to the natural freeze block; the
// later Retire must NOT re-anchor it forward.
// ---------------------------------------------------------------------------

func TestWindDownOpenBlock_NaturalFreezeThenRetire(t *testing.T) {
	s := NewMemStore()
	const c = "windreset"
	const reg = uint64(1_000_000)
	if err := Register(s, c, c, reg, 1000, MaxCap); err != nil {
		t.Fatal(err)
	}
	// A holder so the market has live supply to wind down (windDownOpenBlock
	// itself is supply-independent, but this mirrors the real repro below).
	if _, err := Buy(s, "holder", c, reg+1, big.NewInt(10)); err != nil {
		t.Fatal(err)
	}

	paidUntil := reg + SubscriptionPeriod        // 1,864,000
	naturalFreeze := paidUntil + GraceBlocks      // 2,008,000
	if Phase(s, c, naturalFreeze) != StateFrozen {
		t.Fatalf("fixture: phase at naturalFreeze = %s, want FROZEN", Phase(s, c, naturalFreeze))
	}

	// Advance well past the freeze — a full ExitTaxDecayBlocks after the market
	// TRULY entered wind-down. The backstop is open here (measured pre-retire).
	past := naturalFreeze + ExitTaxDecayBlocks + 10 // 3,217,610

	// PRE-RETIRE: anchored to the natural freeze.
	if open, ok := windDownOpenBlock(s, c, past); !ok || open != naturalFreeze {
		t.Fatalf("pre-retire windDownOpen = (%d,%v), want (%d,true)", open, ok, naturalFreeze)
	}

	// Retire the already-FROZEN market — a single, ordinary, explicitly-legal
	// action (requireOpenCreatorMarket does not gate on phase).
	if err := Retire(s, c, c, past); err != nil {
		t.Fatalf("Retire on a naturally-FROZEN market must be legal: %v", err)
	}
	if ra, ok := retiredAtBlock(s, c); !ok || ra != past {
		t.Fatalf("fixture: retiredAt = (%d,%v), want (%d,true)", ra, ok, past)
	}

	// POST-RETIRE: the anchor MUST be unchanged. The market has been
	// continuously winding down since naturalFreeze (Renew cannot lift a FROZEN
	// market), so the later Retire cannot re-anchor the clock forward.
	if open, ok := windDownOpenBlock(s, c, past); !ok || open != naturalFreeze {
		t.Fatalf("WINDDOWN-RESET-1: post-retire windDownOpen = (%d,%v), want (%d,true) "+
			"(Retire must not re-arm the backstop anchor)", open, ok, naturalFreeze)
	}
}

// ---------------------------------------------------------------------------
// WINDDOWN-RESET-1 (RefundHolder repro) — two holders on IDENTICAL fresh
// (griefer-refreshed) clocks, at the SAME block, differing ONLY by a single
// intervening Retire() call. Before the fix, holder A (swept before Retire)
// succeeds while holder B (swept after Retire) is refused — proving Retire
// re-armed the backstop. After the fix, BOTH sweep, because the anchor stays
// pinned to the natural freeze block.
// ---------------------------------------------------------------------------

func TestRefundHolder_WINDDOWNRESET1_RetireDoesNotReArmBackstop(t *testing.T) {
	s := NewMemStore()
	const c, holderA, holderB = "windreset2", "alice", "bob"
	const reg = uint64(1_000_000)
	if err := Register(s, c, c, reg, 1000, MaxCap); err != nil {
		t.Fatal(err)
	}
	if _, err := Buy(s, holderA, c, reg+1, big.NewInt(10)); err != nil {
		t.Fatal(err)
	}
	if _, err := Buy(s, holderB, c, reg+1, big.NewInt(10)); err != nil {
		t.Fatal(err)
	}

	paidUntil := reg + SubscriptionPeriod    // 1,864,000
	naturalFreeze := paidUntil + GraceBlocks // 2,008,000
	if Phase(s, c, naturalFreeze) != StateFrozen {
		t.Fatalf("fixture: phase at naturalFreeze = %s, want FROZEN", Phase(s, c, naturalFreeze))
	}

	blockAtSweep := naturalFreeze + ExitTaxDecayBlocks + 10 // 3,217,610

	// Simulate a griefer keeping BOTH positions maximally fresh (identical
	// clocks): held 100 blocks => ExitTaxBpsAt == MaxExitTaxBps (still-taxed).
	fresh := blockAtSweep - 100 // 3,217,510
	setU64(s, kAcqBlock(c, holderA), fresh)
	setU64(s, kAcqBlock(c, holderB), fresh)
	for _, h := range []string{holderA, holderB} {
		if bps := ExitTaxBpsAt(heldBlocksAt(s, c, h, blockAtSweep)); bps != MaxExitTaxBps {
			t.Fatalf("fixture: %s tax = %d bps, want %d (still-taxed fresh clock)", h, bps, MaxExitTaxBps)
		}
	}

	// PRE-RETIRE: the backstop correctly fires against the griefer-refreshed
	// clock (the market has genuinely wound down for a full ExitTaxDecayBlocks),
	// so pushing holder A SUCCEEDS.
	if _, err := RefundHolder(s, "keeper", c, holderA, blockAtSweep); err != nil {
		t.Fatalf("pre-retire: backstop must fire against a griefer-refreshed clock "+
			"a full ExitTaxDecayBlocks into wind-down: %v", err)
	}

	// The single intervening, legal action.
	if err := Retire(s, c, c, blockAtSweep); err != nil {
		t.Fatalf("Retire on a naturally-FROZEN market must be legal: %v", err)
	}

	// POST-RETIRE: holder B is in the IDENTICAL state A was (same fresh clock,
	// same block, same market that has truly wound down since naturalFreeze).
	// After the fix the push MUST also succeed — Retire may not re-arm the
	// backstop.
	if _, err := RefundHolder(s, "keeper", c, holderB, blockAtSweep); err != nil {
		t.Fatalf("WINDDOWN-RESET-1: post-retire push of an IDENTICALLY-aged holder "+
			"must ALSO fire — Retire must not re-arm the ExitTaxDecayBlocks immunity: %v", err)
	}

	// The market drains and closes — liveness bound restored to ExitTaxDecayBlocks.
	if sup := getMoney(s, kSupply(c)); sup.Sign() != 0 {
		t.Fatalf("supply after both sweeps = %s, want 0", sup)
	}
	if res := getMoney(s, kReserve(c)); res.Sign() != 0 {
		t.Fatalf("reserve after complete wind-down = %s, want 0 (C-24)", res)
	}
	if !CloseIfDrained(s, c, blockAtSweep) {
		t.Fatal("WINDDOWN-RESET-1: market must CLOSE once drained — the DoS is bounded to ExitTaxDecayBlocks")
	}
}
