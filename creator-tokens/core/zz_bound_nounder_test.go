package core

import (
	"math/big"
	"math/rand"
	"testing"
)

// zz_bound_nounder_test.go — PROOF 3: the merge NEVER UNDER-TAXES.
//
// Every merge adopts the YOUNGER of the two acqs. lotRateAt is non-decreasing
// in acq, so the merged cohort's rate is >= both constituents' rates at THIS
// block and at every later one; and because the pair merged is ADJACENT in
// freshest-first order, the merged cohort covers exactly the union of the two
// curve slices they occupied. Hence
//
//	rate(younger)·(sliceY + sliceO)  >=  rate(younger)·sliceY + rate(older)·sliceO
//
// — the merge can only ever RAISE the TRUE tax. These tests MEASURE that rather
// than assume it, on both rails, over randomized shapes, a full sweep of age
// pairs, and many sale sizes.
//
// ★ ONE HONEST SUBTLETY, MEASURED AND STATED, NOT PAPERED OVER. ExitTaxOn CEILs
// per cohort (RULING F). Two cohorts therefore pay ceil(a) + ceil(b), which is
// up to 1 base unit MORE than the ceil of their sum — pure rounding padding, not
// rate. Merging applies one ceil instead of two, so the bounded ledger can book
// up to 1 base unit (0.001 HBD) LESS per merged pair than the unbounded one.
// That is not an under-charge: the tests below assert the STRONG statement,
//
//	boundedTax · 10000  >=  Σ_i sliceᵢ · rateᵢ   (the EXACT, un-rounded tax owed
//	                                              by the UNMERGED position)
//
// so the merged charge is never below the true tax — it only sheds the
// per-cohort ceil padding, and it sheds at most (cohorts merged) base units.
// Both facts are asserted; neither is assumed.

// zbLedgerTax builds a throwaway store holding exactly `lots` and returns the
// curve-rail cohort tax on `fromMaturing` tokens sold from `supply` at `block`.
func zbLedgerTax(t *testing.T, lots []mLot, supply, fromMaturing *big.Int, block uint64) *big.Int {
	t.Helper()
	s := NewMemStore()
	total := mZero()
	for _, l := range lots {
		total = mAdd(total, l.count)
	}
	setMoney(s, kBal("zc", "zh"), total)
	setLots(s, "zc", "zh", lots)
	tax, _, _, err := maturingCohortTax(s, "zc", "zh", supply, fromMaturing, block)
	if err != nil {
		t.Fatalf("maturingCohortTax: %v", err)
	}
	return tax
}

// zbLedgerRefundTax is the same for the wind-down (flat pro-rata) Refund rail.
func zbLedgerRefundTax(t *testing.T, lots []mLot, base, fromMaturing *big.Int, block uint64) *big.Int {
	t.Helper()
	s := NewMemStore()
	total := mZero()
	for _, l := range lots {
		total = mAdd(total, l.count)
	}
	setMoney(s, kBal("zc", "zh"), total)
	setLots(s, "zc", "zh", lots)
	return refundMaturingCohortTax(s, "zc", "zh", base, fromMaturing, block)
}

// zbExactTaxNum returns the EXACT tax owed by `lots` on the curve rail, in
// units of 1/10000 of an HBD base unit — i.e. Σ sliceᵢ · rateᵢ with NO rounding
// at all. It mirrors maturingCohortTax's slice walk exactly (freshest-first,
// same shortfall clause) minus the per-cohort ceil. Comparing
// tax·10000 >= zbExactTaxNum is the rounding-free statement of "never
// under-charges".
func zbExactTaxNum(t *testing.T, lots []mLot, supply, fromMaturing *big.Int, block uint64) *big.Int {
	t.Helper()
	sorted := append([]mLot(nil), lots...)
	sortLotsFreshestFirst(sorted)
	num := mZero()
	remaining := new(big.Int).Set(fromMaturing)
	curTop := new(big.Int).Set(supply)
	for _, l := range sorted {
		if remaining.Sign() == 0 {
			break
		}
		take := l.count
		if take.Cmp(remaining) > 0 {
			take = remaining
		}
		slice, err := SellProceeds(curTop, take)
		if err != nil {
			t.Fatalf("SellProceeds: %v", err)
		}
		num = mAdd(num, new(big.Int).Mul(slice, new(big.Int).SetUint64(lotRateAt(l.acq, block))))
		curTop = new(big.Int).Sub(curTop, take)
		remaining = new(big.Int).Sub(remaining, take)
	}
	if remaining.Sign() > 0 {
		slice, err := SellProceeds(curTop, remaining)
		if err != nil {
			t.Fatalf("SellProceeds: %v", err)
		}
		num = mAdd(num, new(big.Int).Mul(slice, new(big.Int).SetUint64(MaxExitTaxBps)))
	}
	return num
}

// ---------------------------------------------------------------------------
// 3a. THE MERGE IDENTITY, swept over a RANGE OF AGES. Two cohorts at ages
// (aOld, aYoung); merged at the younger acq. The merged charge must be >= the
// two separate charges, on the curve rail, for every age pair on the grid.
// ---------------------------------------------------------------------------
func TestZZBound_MergedPaysAtLeastSeparate_AgeSweep(t *testing.T) {
	block := uint64(10_000_000)
	supply := big.NewInt(200_000)
	cases := 0
	worst := new(big.Int) // largest over-charge seen
	ceilResidue := 0      // cases that shed exactly 1 base unit of ceil padding
	var worstDesc string

	ages := []uint64{0, 1, 806, 28_800, 100_000, 302_400, 604_800, 900_000,
		ExitTaxDecayBlocks - 806, ExitTaxDecayBlocks - 1, ExitTaxDecayBlocks,
		ExitTaxDecayBlocks + 1, 2 * ExitTaxDecayBlocks}
	counts := []int64{1, 7, 1_000, 50_000}

	for _, ao := range ages {
		for _, ay := range ages {
			if ay > ao {
				continue // ay must be the YOUNGER (smaller age)
			}
			for _, co := range counts {
				for _, cy := range counts {
					acqOld, acqYoung := block-ao, block-ay
					if acqOld == acqYoung {
						continue // same acq merges by identity, nothing to prove
					}
					sep := []mLot{
						{count: big.NewInt(cy), acq: acqYoung},
						{count: big.NewInt(co), acq: acqOld},
					}
					mrg := []mLot{
						{count: big.NewInt(cy + co), acq: acqYoung}, // YOUNGER acq
					}
					fm := big.NewInt(cy + co)
					sepTax := zbLedgerTax(t, sep, supply, fm, block)
					mrgTax := zbLedgerTax(t, mrg, supply, fm, block)
					// (i) THE STRONG STATEMENT: the merged charge is never below the
					// EXACT (un-rounded) tax the two separate cohorts owed.
					exact := zbExactTaxNum(t, sep, supply, fm, block)
					if new(big.Int).Mul(mrgTax, big.NewInt(10000)).Cmp(exact) < 0 {
						t.Fatalf("UNDER-TAX vs EXACT: ages(old=%d,young=%d) counts(%d,%d): merged=%s (x1e4=%s) < exact=%s",
							ao, ay, co, cy, mrgTax, new(big.Int).Mul(mrgTax, big.NewInt(10000)), exact)
					}
					// (ii) THE CEIL RESIDUE: at most 1 base unit per merged pair.
					d := new(big.Int).Sub(mrgTax, sepTax)
					if d.Cmp(big.NewInt(-1)) < 0 {
						t.Fatalf("CEIL RESIDUE TOO LARGE: ages(old=%d,young=%d) counts(%d,%d): merged=%s separate=%s (delta=%s, limit -1)",
							ao, ay, co, cy, mrgTax, sepTax, d)
					}
					if d.Sign() < 0 {
						ceilResidue++
					}
					if d.Cmp(worst) > 0 {
						worst = d
						worstDesc = "ages(old=" + big.NewInt(int64(ao)).String() + ",young=" +
							big.NewInt(int64(ay)).String() + ")"
					}
					cases++
				}
			}
		}
	}
	t.Logf("MERGE NEVER UNDER-TAXES THE TRUE TAX on the curve rail: %d age/count combinations, "+
		"merged·10000 >= exact Σslice·rate in EVERY case; largest over-charge %s at %s; "+
		"%d cases shed exactly 1 base unit of per-cohort ceil padding (0.001 HBD, never more).",
		cases, worst, worstDesc, ceilResidue)
}

// ---------------------------------------------------------------------------
// 3b. THE WHOLE BOUND, END TO END: bounded ledger vs unbounded ledger, curve
// rail, randomized shapes and sale sizes. tax(bounded) >= tax(unbounded).
// ---------------------------------------------------------------------------
func TestZZBound_BoundedLedgerNeverTaxesLessThanUnbounded_Curve(t *testing.T) {
	r := rand.New(rand.NewSource(0x5A1E))
	block := uint64(8_000_000)
	iters, merged, overcharged := 0, 0, 0
	worstResidue := big.NewInt(0)
	for iter := 0; iter < 1500; iter++ {
		n := MaxLots + 1 + r.Intn(60)
		var lots []mLot
		used := map[uint64]bool{}
		total := mZero()
		for len(lots) < n {
			acq := block - uint64(r.Int63n(int64(2*ExitTaxDecayBlocks)))
			if used[acq] {
				continue
			}
			used[acq] = true
			cnt := big.NewInt(1 + r.Int63n(20_000))
			total = mAdd(total, cnt)
			lots = append(lots, mLot{count: cnt, acq: acq})
		}
		sortLotsFreshestFirst(lots)
		bounded := boundLots(append([]mLot(nil), lots...), block)
		if len(bounded) < len(lots) {
			merged++
		}
		supply := mAdd(total, big.NewInt(r.Int63n(500_000)))
		// Several draw sizes: the full position, and random partial top slices.
		draws := []*big.Int{new(big.Int).Set(total)}
		for k := 0; k < 3; k++ {
			d := big.NewInt(1 + r.Int63n(total.Int64()))
			draws = append(draws, d)
		}
		nMerges := int64(len(lots) - len(bounded))
		for _, fm := range draws {
			un := zbLedgerTax(t, lots, supply, fm, block)
			bd := zbLedgerTax(t, bounded, supply, fm, block)
			// (i) STRONG: never below the EXACT tax the unbounded ledger owed.
			exact := zbExactTaxNum(t, lots, supply, fm, block)
			if new(big.Int).Mul(bd, big.NewInt(10000)).Cmp(exact) < 0 {
				t.Fatalf("iter %d: UNDER-TAX vs EXACT — bounded=%s (x1e4=%s) < exact=%s (draw=%s, %d->%d cohorts)",
					iter, bd, new(big.Int).Mul(bd, big.NewInt(10000)), exact, fm, len(lots), len(bounded))
			}
			// (ii) CEIL RESIDUE: at most 1 base unit per merged pair.
			d := new(big.Int).Sub(bd, un)
			if d.Cmp(big.NewInt(-nMerges)) < 0 {
				t.Fatalf("iter %d: CEIL RESIDUE TOO LARGE — bounded=%s unbounded=%s delta=%s, %d merges (limit -%d)",
					iter, bd, un, d, nMerges, nMerges)
			}
			if d.Sign() < 0 && d.Cmp(worstResidue) < 0 {
				worstResidue = d
			}
			if d.Sign() > 0 {
				overcharged++
			}
			iters++
		}
	}
	t.Logf("CURVE RAIL: %d (ledger,draw) comparisons over 1500 randomized over-cap ledgers (%d merged). "+
		"bounded·10000 >= EXACT Σslice·rate in EVERY case (never under-charges the true tax); "+
		"%d comparisons over-charged vs the unbounded ceil-sum; worst ceil-padding shed = %s base units "+
		"(<= 1 per merged pair).", iters, merged, overcharged, worstResidue)
}

// ---------------------------------------------------------------------------
// 3c. Same end-to-end comparison on the wind-down REFUND rail (flat pro-rata
// base rather than curve slices). Reported honestly: the refund rail allocates
// each cohort ceil(base·take/fromMaturing) and caps the sum at `base`, so
// merging two cohorts can return up to one CEIL RESIDUE fewer base units. That
// residue is a rounding artefact of the per-cohort ceil, not a rate dilution —
// it is measured here and bounded, and the test fails on anything larger.
// ---------------------------------------------------------------------------
func TestZZBound_BoundedLedgerRefundRail_NoRateDilution(t *testing.T) {
	r := rand.New(rand.NewSource(0x5A1F))
	block := uint64(8_000_000)
	cmp := 0
	worstShort := big.NewInt(0) // most negative (bounded − unbounded)
	for iter := 0; iter < 1500; iter++ {
		n := MaxLots + 1 + r.Intn(60)
		var lots []mLot
		used := map[uint64]bool{}
		total := mZero()
		for len(lots) < n {
			acq := block - uint64(r.Int63n(int64(2*ExitTaxDecayBlocks)))
			if used[acq] {
				continue
			}
			used[acq] = true
			cnt := big.NewInt(1 + r.Int63n(20_000))
			total = mAdd(total, cnt)
			lots = append(lots, mLot{count: cnt, acq: acq})
		}
		sortLotsFreshestFirst(lots)
		bounded := boundLots(append([]mLot(nil), lots...), block)
		base := big.NewInt(1_000 + r.Int63n(50_000_000))
		nMerges := int64(len(lots) - len(bounded))
		for k := 0; k < 3; k++ {
			fm := big.NewInt(1 + r.Int63n(total.Int64()))
			un := zbLedgerRefundTax(t, lots, base, fm, block)
			bd := zbLedgerRefundTax(t, bounded, base, fm, block)
			d := new(big.Int).Sub(bd, un)
			if d.Cmp(big.NewInt(-nMerges)) < 0 {
				t.Fatalf("iter %d: REFUND RAIL under-charged by %s base units with only %d merges — "+
					"beyond the per-cohort ceil residue, that would be a rate dilution", iter, d, nMerges)
			}
			if d.Sign() < 0 && d.Cmp(worstShort) < 0 {
				worstShort = d
			}
			cmp++
		}
	}
	t.Logf("REFUND RAIL: %d comparisons, per-iteration limit of 1 base unit per merged pair ENFORCED; "+
		"worst (bounded − unbounded) = %s base units (0.001 HBD each) — per-cohort ceil-allocation "+
		"residue only, no rate dilution.", cmp, worstShort)
}

// ---------------------------------------------------------------------------
// 3d. THE FREE HALF: collapsing already-matured cohorts is EXACTLY tax-neutral,
// now and at every later block. Not "favourable" — identical, to the unit.
// ---------------------------------------------------------------------------
func TestZZBound_MaturedCollapseIsExactlyNeutral(t *testing.T) {
	r := rand.New(rand.NewSource(0xC0FFEE))
	block := uint64(9_000_000)
	supply := big.NewInt(5_000_000)
	checks := 0
	for iter := 0; iter < 500; iter++ {
		var lots []mLot
		used := map[uint64]bool{}
		total := mZero()
		// A mix: some matured (acq <= block−Dt), some live.
		for len(lots) < 20+r.Intn(60) {
			var acq uint64
			if r.Intn(2) == 0 {
				acq = block - ExitTaxDecayBlocks - uint64(1+r.Int63n(2_000_000)) // matured
			} else {
				acq = block - uint64(r.Int63n(int64(ExitTaxDecayBlocks))) // live
			}
			if used[acq] || acq == 0 {
				continue
			}
			used[acq] = true
			cnt := big.NewInt(1 + r.Int63n(100_000))
			total = mAdd(total, cnt)
			lots = append(lots, mLot{count: cnt, acq: acq})
		}
		sortLotsFreshestFirst(lots)
		collapsed := collapseMaturedLots(append([]mLot(nil), lots...), block)

		// Identical tax at `block` and at three later blocks (matured stays matured).
		for _, at := range []uint64{block, block + 1, block + ExitTaxDecayBlocks, block + 10*ExitTaxDecayBlocks} {
			a := zbLedgerTax(t, lots, supply, total, at)
			b := zbLedgerTax(t, collapsed, supply, total, at)
			if a.Cmp(b) != 0 {
				t.Fatalf("iter %d: matured collapse NOT neutral at block %d: %s vs %s", iter, at, a, b)
			}
			checks++
		}
	}
	t.Logf("MATURED COLLAPSE IS EXACTLY NEUTRAL: %d (ledger,block) checks across 500 mixed ledgers, "+
		"identical tax to the base unit now and at +1 / +1 window / +10 windows.", checks)
}
