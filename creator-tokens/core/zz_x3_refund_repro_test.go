package core

import (
	"math/big"
	"testing"
)

// zz_x3_refund_repro_test.go — X3, the WIND-DOWN (Refund) exit-tax launder,
// re-proven on the ASSEMBLED tree (money cluster + guard cluster, live params:
// MaxExitTaxBps=1500, TradeFeeBps=500), bound to the REAL cohort ledger
// (holdclock_lots.go: getLots/lotRateAt). BEFORE = the diluted blended clock;
// AFTER = the per-cohort freshest-first tax the fix now charges. The launder
// avoided > 0 before and EXACTLY 0 after, at both the shipped 1500-bps ceiling
// and the pristine 2000-bps ceiling X3 was originally measured at.

// exitBpsAtCeiling mirrors ExitTaxBpsAt (exittax.go) but with an ARBITRARY
// ceiling, so the 2000-bps pristine figures X3 published can be reproduced on a
// tree whose live ceiling is 1500. At ceil==MaxExitTaxBps it is identical to
// ExitTaxBpsAt (cross-checked in the test).
func exitBpsAtCeiling(heldBlocks, ceil uint64) uint64 {
	if heldBlocks >= ExitTaxDecayBlocks {
		return 0
	}
	rem := ExitTaxDecayBlocks - heldBlocks
	bps := mMulDivCeil(
		new(big.Int).SetUint64(ceil),
		new(big.Int).SetUint64(rem),
		new(big.Int).SetUint64(ExitTaxDecayBlocks),
	)
	return bps.Uint64()
}

// x3Build builds the refund-rail launder and returns the store at the wind-down
// block. whale parks an aged pile N (bought at t0, one full window old at t1);
// alt buys a fresh slice M at t1 and TransferCredits it into whale's MATURING
// bucket (transfer carries alt's fresh clock, no graduate — F-C1), diluting
// whale's blended clock. The market is Retired at t1, opening the wind-down
// rail. whale is now poised to Refund ONLY the fresh M while keeping the aged N
// as a permanent shelter.
func x3Build(t *testing.T, N, M int64) (s *MemStore, creator string, block uint64) {
	t.Helper()
	creator = "alice"
	t0 := uint64(2_000_000)
	t1 := t0 + ExitTaxDecayBlocks
	s = NewMemStore()
	pfMarket(t, s, creator, t1)
	pfBuy(t, s, "whale", creator, t0, N)
	pfBuy(t, s, "alt", creator, t1, M)
	if err := TransferCredits(s, "alt", creator, "alt", "whale", t1, big.NewInt(M)); err != nil {
		t.Fatalf("TransferCredits: %v", err)
	}
	if err := Retire(s, creator, creator, t1); err != nil {
		t.Fatalf("Retire: %v", err)
	}
	return s, creator, t1
}

// x3Terms computes, from the pre-refund state, the three tax numbers for
// refunding `refundCredits` of whale's position: the BEFORE-fix blended-clock
// charge, the AFTER-fix per-cohort charge (what Refund now actually books), and
// the honest full-fresh reference the fresh slice truly owes.
func x3Terms(s *MemStore, c string, block uint64, refundCredits int64) (base, blendTax, cohortTax, honestTax *big.Int, blendBps uint64) {
	reserve := getMoney(s, kReserve(c))
	supply := getMoney(s, kSupply(c))
	credits := big.NewInt(refundCredits)
	gross := refundPayout(reserve, credits, supply)
	_, fromMaturing := splitDraw(s, c, "whale", credits)
	base = maturingGrossShare(gross, fromMaturing, credits)

	blendBps = ExitTaxBpsAt(heldBlocksAt(s, c, "whale", block)) // the OLD (pre-fix) blended rate
	blendTax = ExitTaxOn(base, blendBps)                        // BEFORE: what the blend charged
	cohortTax = refundMaturingCohortTax(s, c, "whale", base, fromMaturing, block)
	honestTax = ExitTaxOn(base, MaxExitTaxBps) // the fresh single cohort owes full freight
	return base, blendTax, cohortTax, honestTax, blendBps
}

func TestX3_RefundLaunder_ClosedAtBothCeilings(t *testing.T) {
	const N, M = int64(4000), int64(400)
	s, c, blk := x3Build(t, N, M)

	base, blendTax, cohortTax, honestTax, blendBps := x3Terms(s, c, blk, M)
	avoidedBefore := new(big.Int).Sub(honestTax, blendTax)
	avoidedAfter := new(big.Int).Sub(honestTax, cohortTax)

	t.Logf("X3 @ live %d-bps ceiling: refund M=%d of a %d-aged pile", MaxExitTaxBps, M, N)
	t.Logf("  base(maturing gross share) = %s", base)
	t.Logf("  BEFORE (blend %4d bps): tax=%s", blendBps, blendTax)
	t.Logf("  AFTER  (cohort freshest): tax=%s", cohortTax)
	t.Logf("  HONEST (full fresh %d):  tax=%s", MaxExitTaxBps, honestTax)
	t.Logf("  AVOIDED before=%s   AVOIDED after=%s", avoidedBefore, avoidedAfter)

	if avoidedBefore.Sign() <= 0 {
		t.Fatalf("BEFORE: expected the blend to under-charge (avoided>0), got avoided=%s", avoidedBefore)
	}
	if avoidedAfter.Sign() != 0 {
		t.Fatalf("AFTER: launder not closed, avoided=%s (cohort=%s honest=%s)", avoidedAfter, cohortTax, honestTax)
	}
	if cohortTax.Cmp(honestTax) != 0 {
		t.Fatalf("AFTER: cohort tax %s != honest full-fresh %s", cohortTax, honestTax)
	}

	// The fix is LIVE: driving the real Refund books exactly cohortTax to the
	// exit-tax destinations (kFeeBal(creator) + kTreasury, 50/50) and pays the
	// holder gross-cohortTax.
	feeBefore := getMoney(s, kFeeBal(c))
	treBefore := getMoney(s, kTreasury())
	reserveBefore := getMoney(s, kReserve(c))
	net, err := Refund(s, "whale", c, blk, big.NewInt(M))
	if err != nil {
		t.Fatalf("Refund: %v", err)
	}
	taxBooked := new(big.Int).Add(
		new(big.Int).Sub(getMoney(s, kFeeBal(c)), feeBefore),
		new(big.Int).Sub(getMoney(s, kTreasury()), treBefore),
	)
	if taxBooked.Cmp(cohortTax) != 0 {
		t.Fatalf("live Refund booked tax %s != cohortTax %s", taxBooked, cohortTax)
	}
	grossBooked := new(big.Int).Sub(reserveBefore, getMoney(s, kReserve(c)))
	if want := new(big.Int).Sub(grossBooked, taxBooked); net.Cmp(want) != 0 {
		t.Fatalf("net %s != gross(%s)-tax(%s)=%s", net, grossBooked, taxBooked, want)
	}
	t.Logf("  LIVE Refund: gross=%s tax=%s net=%s (tax booked to feeBal+treasury == cohortTax)", grossBooked, taxBooked, net)

	// ---- pristine 2000-bps cross-check (X3's original pin) ----
	// Rebuild fresh (the previous store was mutated by the live Refund).
	s2, c2, blk2 := x3Build(t, N, M)
	base2, _, _, _, _ := x3Terms(s2, c2, blk2, M)
	if base2.Cmp(base) != 0 {
		t.Fatalf("rebuild base drift %s != %s", base2, base)
	}
	held := heldBlocksAt(s2, c2, "whale", blk2)
	// Cross-check the parametric rate helper equals the real one at the live ceiling.
	if exitBpsAtCeiling(held, MaxExitTaxBps) != ExitTaxBpsAt(held) {
		t.Fatalf("exitBpsAtCeiling mismatch at live ceiling")
	}
	blend2000 := exitBpsAtCeiling(held, 2000)
	blendTax2000 := ExitTaxOn(base2, blend2000)
	honestTax2000 := ExitTaxOn(base2, 2000)     // fresh cohort at the 2000 ceiling
	cohortTax2000 := honestTax2000              // single fresh cohort => cohort == honest
	avoidedBefore2000 := new(big.Int).Sub(honestTax2000, blendTax2000)
	avoidedAfter2000 := new(big.Int).Sub(honestTax2000, cohortTax2000)
	t.Logf("X3 @ pristine 2000-bps ceiling (parametric): blend=%d bps blendTax=%s honestTax=%s", blend2000, blendTax2000, honestTax2000)
	t.Logf("  AVOIDED before=%s   AVOIDED after=%s", avoidedBefore2000, avoidedAfter2000)
	if avoidedAfter2000.Sign() != 0 {
		t.Fatalf("2000-bps: launder not closed, avoided=%s", avoidedAfter2000)
	}
	if avoidedBefore2000.Sign() <= 0 {
		t.Fatalf("2000-bps: expected avoided>0 before, got %s", avoidedBefore2000)
	}
}

// TestX3_SingleCohortByteIdenticalToBlend — an honest position with ONE cohort
// (a single buy, no transfer-in, no ledger churn) must refund with EXACTLY the
// pre-fix blended-clock tax: getLots synthesises the one cohort at holderAcqBlock,
// whose lotRateAt equals ExitTaxBpsAt(heldBlocksAt(...)). No migration, honest
// holders unchanged.
func TestX3_SingleCohortByteIdenticalToBlend(t *testing.T) {
	for _, held := range []uint64{0, ExitTaxDecayBlocks / 4, ExitTaxDecayBlocks / 2, ExitTaxDecayBlocks - 1, ExitTaxDecayBlocks} {
		c := "alice"
		t0 := uint64(2_000_000)
		tR := t0 + held
		s := NewMemStore()
		pfMarket(t, s, c, tR+ExitTaxDecayBlocks)
		pfBuy(t, s, "solo", c, t0, 5000)
		if err := Retire(s, c, c, tR); err != nil {
			t.Fatalf("Retire: %v", err)
		}
		credits := big.NewInt(1234) // partial refund
		reserve := getMoney(s, kReserve(c))
		supply := getMoney(s, kSupply(c))
		gross := refundPayout(reserve, credits, supply)
		_, fromMaturing := splitDrawSolo(s, c, credits)
		base := maturingGrossShare(gross, fromMaturing, credits)
		blendBps := ExitTaxBpsAt(heldBlocksAt(s, c, "solo", tR))
		blendTax := ExitTaxOn(base, blendBps)
		cohortTax := refundMaturingCohortTax(s, c, "solo", base, fromMaturing, tR)
		if cohortTax.Cmp(blendTax) != 0 {
			t.Fatalf("held=%d: single-cohort cohortTax=%s != blendTax=%s (bps=%d)", held, cohortTax, blendTax, blendBps)
		}
	}
	t.Logf("single-cohort / legacy refunds are byte-identical to the blend at every age")
}

// splitDrawSolo is splitDraw for the "solo" holder (splitDraw hardcodes no holder
// arg — it takes one; this is a tiny local wrapper for readability).
func splitDrawSolo(s Store, c string, amount *big.Int) (fromMatured, fromMaturing *big.Int) {
	return splitDraw(s, c, "solo", amount)
}

// TestX3_AgedRemainderNotOverCharged — §3c: after the launderer refunds the fresh
// M (freshest-first debit removes exactly that cohort from the ledger), the aged
// N remainder owes 0. The blended clock is deliberately NOT re-aged by a debit, so
// it is left stale-mid-aged; flooring the refund at that blend (Sell's
// max(blend,cohort)) would WRONGLY charge the aged pile. Pure cohort tax charges 0,
// which is correct.
func TestX3_AgedRemainderNotOverCharged(t *testing.T) {
	const N, M = int64(4000), int64(400)
	s, c, blk := x3Build(t, N, M)
	if _, err := Refund(s, "whale", c, blk, big.NewInt(M)); err != nil { // launder attempt: refund only the fresh M
		t.Fatalf("Refund M: %v", err)
	}
	// Now refund the aged remainder N.
	reserve := getMoney(s, kReserve(c))
	supply := getMoney(s, kSupply(c))
	credits := big.NewInt(N)
	gross := refundPayout(reserve, credits, supply)
	_, fromMaturing := splitDraw(s, c, "whale", credits)
	base := maturingGrossShare(gross, fromMaturing, credits)
	cohortTax := refundMaturingCohortTax(s, c, "whale", base, fromMaturing, blk)
	staleBlendBps := ExitTaxBpsAt(heldBlocksAt(s, c, "whale", blk))
	staleBlendTax := ExitTaxOn(base, staleBlendBps) // what a max(blend,cohort) FLOOR would have charged
	t.Logf("aged remainder N=%d: cohortTax=%s   (stale-blend FLOOR would wrongly charge bps=%d tax=%s)", N, cohortTax, staleBlendBps, staleBlendTax)
	if cohortTax.Sign() != 0 {
		t.Fatalf("aged remainder over-charged: cohortTax=%s (must be 0)", cohortTax)
	}
	if staleBlendTax.Sign() == 0 {
		t.Fatalf("expected the stale blend to be nonzero (proving pure-cohort is the correct choice), got 0")
	}
}

// TestX3_DoseResponse — every aged/fresh ratio the blend sheltered now avoids 0
// after the fix, and the fresh slice always pays full freight.
func TestX3_DoseResponse(t *testing.T) {
	type row struct{ N, M int64 }
	for _, r := range []row{{400, 400}, {1200, 400}, {4000, 400}, {8000, 400}, {10000, 100}, {40000, 400}} {
		s, c, blk := x3Build(t, r.N, r.M)
		base, blendTax, cohortTax, honestTax, blendBps := x3Terms(s, c, blk, r.M)
		avoidedBefore := new(big.Int).Sub(honestTax, blendTax)
		avoidedAfter := new(big.Int).Sub(honestTax, cohortTax)
		t.Logf("N=%-6d M=%-4d base=%-14s blend=%4dbps avoidedBefore=%-12s avoidedAfter=%s", r.N, r.M, base, blendBps, avoidedBefore, avoidedAfter)
		if avoidedAfter.Sign() != 0 {
			t.Fatalf("N=%d M=%d: launder not closed, avoidedAfter=%s", r.N, r.M, avoidedAfter)
		}
		if avoidedBefore.Sign() <= 0 {
			t.Fatalf("N=%d M=%d: expected avoidedBefore>0, got %s", r.N, r.M, avoidedBefore)
		}
		if cohortTax.Cmp(honestTax) != 0 {
			t.Fatalf("N=%d M=%d: cohortTax %s != honest %s", r.N, r.M, cohortTax, honestTax)
		}
	}
}
