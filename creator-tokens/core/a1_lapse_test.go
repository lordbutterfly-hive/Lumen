package core

import "testing"

// a1_lapse_test.go — WHAT THIS FILE USED TO BE, AND WHY IT IS NOW ITS OWN
// INVERSE.
//
// A1 (owner ruling 2026-08-30) said: "no wind-downs, just delisting, a big
// warning to pay to reactivate, and holders are never punished for a creator's
// bill." The contract's half of that was a lapse ladder:
//
//	lapse -> OVERDUE (grace) -> FROZEN, where FROZEN meant
//	  Buy / Ask refused      (inflow stop)
//	  Sell OPEN on the curve (a lapse is not a wind-down)
//	  Refund / RefundHolder REFUSED (no wind-down, so no pro-rata rail)
//	  Renew ACCEPTED         (the payment that lifts the stop)
//
// THE OWNER RULING OF 2026-09-12 REMOVED THE BILL ENTIRELY (core/params.go's
// "THERE IS NO SubscriptionFee"). With nothing to lapse, every rung of that
// ladder is unreachable: a market is ACTIVE from registration until its creator
// RETIRES it, and Retire — already the only road into a wind-down under A1 — is
// now the only road out of ACTIVE at all.
//
// So the file keeps its subject (what a creator's non-payment does to holders)
// and inverts its answer: non-payment is not a thing that can happen. The two
// tests that pinned the ladder's internals are gone with the ladder:
//
//   - TestA1_RenewGateIsSeparateFromBuyGate pinned requireMarketAcceptsRenewal
//     admitting FROZEN while requireMarketAcceptsMoney refused it, so Buy and Ask
//     could never inherit the admission. Both Renew and that gate are deleted.
//   - TestH16_LegacySurplusMarketCannotBeRevived pinned the revival check: a
//     market frozen under the PRE-A1 rules carries R > area(S) after a partial
//     pro-rata refund, and reviving it would let a raider buy in at area prices
//     and exit into the surplus. REVIVAL NO LONGER EXISTS — Renew was the only
//     door that performed one, and Register still refuses a non-CLOSED market —
//     so the hazard has no entrance rather than a guard. market.go's
//     "THERE IS NO requireMarketAcceptsRenewal" block carries the full argument
//     and the instruction to restore the check WITH any future paid tier.

// TestNoLapse_AMarketStaysActiveUntilItsCreatorRetiresIt is the direct
// replacement, and it fails on the pre-2026-09-12 code in its very first clause
// (there, two subscription periods of silence read FROZEN).
func TestNoLapse_AMarketStaysActiveUntilItsCreatorRetiresIt(t *testing.T) {
	s := NewMemStore()
	const c, holder = "nolapsecreator", "nolapseholder"
	const reg = uint64(500_000)
	if err := Register(s, c, c, reg, 1000, MaxCap); err != nil {
		t.Fatal(err)
	}
	if _, err := Buy(s, holder, c, reg+1, tk(20)); err != nil {
		t.Fatal(err)
	}

	// A YEAR of silence. Nothing is ever paid, and nobody touches the market.
	// Under the old ladder this block was 11 lapses past FROZEN.
	silent := reg + 365*BlocksPerDay
	if got := Phase(s, c, silent); got != StateActive {
		t.Fatalf("phase after a year of silence = %s, want ACTIVE (there is no subscription to lapse)", got)
	}
	if err := RequireInflowOpen(s, c, silent); err != nil {
		t.Fatalf("inflows must stay open on a silent market: %v", err)
	}
	// ...and a real buy actually lands there, not merely a gate that says yes.
	if _, err := Buy(s, holder, c, silent, tk(5)); err != nil {
		t.Fatalf("Buy after a year of silence: %v", err)
	}

	// The curve exit is open the whole time, which is the holder-protection half
	// of A1 and the reason none of this was ever a solvency question.
	if _, err := Sell(s, holder, c, silent+1, tk(1)); err != nil {
		t.Fatalf("Sell on a silent ACTIVE market: %v", err)
	}
	// The pro-rata wind-down rail stays shut: nothing is winding down.
	if _, err := Refund(s, holder, c, silent+2, tk(1)); err == nil {
		t.Fatal("Refund must refuse outside a wind-down")
	} else if askErrSymbol(err) != ErrState {
		t.Fatalf("Refund refusal symbol = %q, want %q", askErrSymbol(err), ErrState)
	}
}

// TestNoLapse_RetireIsTheOnlyRoadOutOfActive pins the other half: the ladder
// still exists, it just has exactly one entrance now.
func TestNoLapse_RetireIsTheOnlyRoadOutOfActive(t *testing.T) {
	s := NewMemStore()
	const c, holder = "retireonly1", "retireonlyholder"
	const reg = uint64(500_000)
	if err := Register(s, c, c, reg, 1000, MaxCap); err != nil {
		t.Fatal(err)
	}
	if _, err := Buy(s, holder, c, reg+1, tk(20)); err != nil {
		t.Fatal(err)
	}

	retireAt := reg + 10*BlocksPerDay
	if err := Retire(s, c, c, retireAt); err != nil {
		t.Fatalf("Retire: %v", err)
	}
	// The notice window: OVERDUE for GraceBlocks, then FROZEN, forever.
	if got := Phase(s, c, retireAt); got != StateOverdue {
		t.Fatalf("phase at the retire mark = %s, want OVERDUE (the notice window)", got)
	}
	if got := Phase(s, c, retireAt+GraceBlocks-1); got != StateOverdue {
		t.Fatalf("phase one block before the notice expires = %s, want OVERDUE", got)
	}
	if got := Phase(s, c, retireAt+GraceBlocks); got != StateFrozen {
		t.Fatalf("phase at retire+GraceBlocks = %s, want FROZEN", got)
	}
	if got := Phase(s, c, retireAt+100*BlocksPerDay); got != StateFrozen {
		t.Fatalf("phase long after the retire = %s, want FROZEN (the wind-down is terminal)", got)
	}

	// Inflows are shut from the MARK, not from the freeze (THM-1/K3).
	if err := RequireInflowOpen(s, c, retireAt); err == nil {
		t.Fatal("inflows must be refused from the retire mark onward")
	}
	// And the exit rail has switched: the curve is closed, pro-rata is open.
	frozen := retireAt + GraceBlocks + 1
	if _, err := Sell(s, holder, c, frozen, tk(1)); err == nil {
		t.Fatal("Sell must refuse while winding down (K3: the curve rail is dropped)")
	}
	if _, err := Refund(s, holder, c, frozen, tk(1)); err != nil {
		t.Fatalf("Refund must be open while winding down: %v", err)
	}
}
