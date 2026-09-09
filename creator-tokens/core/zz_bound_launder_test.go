package core

import (
	"math/big"
	"math/rand"
	"testing"
)

// zz_bound_launder_test.go — PROOF 2: the MaxLots bound does NOT re-open the
// PRICE-1 / X3 exit-tax launder.
//
// The launder is one thing only: a FRESH cohort being charged an AGED cohort's
// rate. The bound merges cohorts, so it could in principle do exactly that — if
// a merge ever adopted the OLDER of two acqs. It never does. Every merge in
// boundLots adopts the YOUNGER acq, so tokens only ever move to a HIGHER rate.
// These tests prove that three ways: the two headline repros still land at
// avoided == 0; they still land at 0 when the ledger has been FLOODED to the cap
// first; and the acq-monotonicity that makes it true is asserted directly over
// randomized ledgers.

// zbLotsRate returns the (count, rate) pairs of the RAW stored ledger, freshest
// first, as read at `block`.
func zbLotsRate(s Store, c, h string, block uint64) []struct {
	Count *big.Int
	Acq   uint64
	Bps   uint64
} {
	var out []struct {
		Count *big.Int
		Acq   uint64
		Bps   uint64
	}
	for _, l := range getLotsRaw(s, c, h) {
		out = append(out, struct {
			Count *big.Int
			Acq   uint64
			Bps   uint64
		}{l.count, l.acq, lotRateAt(l.acq, block)})
	}
	return out
}

// ---------------------------------------------------------------------------
// 2a. PRICE-1 (curve Sell rail) with the bound ACTIVE: avoided is still 0.
// ---------------------------------------------------------------------------
func TestZZBound_PRICE1_LaunderStillClosed(t *testing.T) {
	const c = "alice"
	const N, M = int64(4000), int64(400)
	t0 := uint64(2_000_000)
	t1 := t0 + ExitTaxDecayBlocks

	s := NewMemStore()
	pfMarket(t, s, c, t1)
	pfBuy(t, s, "whale", c, t0, N) // aged pile, fully matured at t1
	pfBuy(t, s, "alt", c, t1, M)   // fresh slice
	if err := TransferCredits(s, "alt", c, "alt", "whale", t1, big.NewInt(M)); err != nil {
		t.Fatalf("TransferCredits: %v", err)
	}

	supply := getMoney(s, kSupply(c))
	topM, err := SellProceeds(supply, big.NewInt(M))
	if err != nil {
		t.Fatal(err)
	}
	intended := ExitTaxOn(topM, MaxExitTaxBps) // fresh M owes FULL freight on the dear top slice

	q, err := QuoteSell(s, "whale", c, t1, big.NewInt(N+M))
	if err != nil {
		t.Fatal(err)
	}
	avoided := new(big.Int).Sub(intended, q.Tax)
	t.Logf("PRICE-1 with MaxLots=%d active: tax=%s intended=%s AVOIDED=%s", MaxLots, q.Tax, intended, avoided)
	if avoided.Sign() != 0 {
		t.Fatalf("PRICE-1 LAUNDER RE-OPENED under the bound: avoided=%s (tax=%s intended=%s)", avoided, q.Tax, intended)
	}
	// And the blend still under-charges — i.e. the repro is still a real launder
	// shape and the cohort floor is still what closes it.
	_, fm := splitDraw(s, c, "whale", big.NewInt(N+M))
	taxable, _ := SellProceeds(supply, fm)
	blend := ExitTaxOn(taxable, ExitTaxBpsAt(heldBlocksAt(s, c, "whale", t1)))
	if blend.Cmp(intended) >= 0 {
		t.Fatalf("repro degenerate: blend %s already >= intended %s", blend, intended)
	}
	t.Logf("  (blend would have charged %s — the launder is still real and still closed)", blend)
}

// ---------------------------------------------------------------------------
// 2b. X3 (wind-down Refund rail) with the bound ACTIVE: avoided is still 0.
// ---------------------------------------------------------------------------
func TestZZBound_X3_RefundLaunderStillClosed(t *testing.T) {
	const N, M = int64(4000), int64(400)
	s, c, blk := x3Build(t, N, M)
	base, blendTax, cohortTax, honestTax, blendBps := x3Terms(s, c, blk, M)
	avoidedBefore := new(big.Int).Sub(honestTax, blendTax)
	avoidedAfter := new(big.Int).Sub(honestTax, cohortTax)
	t.Logf("X3 with MaxLots=%d active: base=%s blend(%d bps)=%s cohort=%s honest=%s",
		MaxLots, base, blendBps, blendTax, cohortTax, honestTax)
	t.Logf("  AVOIDED before=%s  AVOIDED after=%s", avoidedBefore, avoidedAfter)
	if avoidedBefore.Sign() <= 0 {
		t.Fatalf("repro degenerate: blend did not under-charge (avoided=%s)", avoidedBefore)
	}
	if avoidedAfter.Sign() != 0 {
		t.Fatalf("X3 LAUNDER RE-OPENED under the bound: avoided=%s", avoidedAfter)
	}
}

// ---------------------------------------------------------------------------
// 2c. THE ADVERSARIAL VERSION. Flood the launderer's ledger to the CAP with
// dust at distinct blocks FIRST, so the fresh slice's arrival is guaranteed to
// force a merge, then run the launder. The fresh slice must still pay the FULL
// rate: the merge must not have folded it into the aged pile.
// ---------------------------------------------------------------------------
func TestZZBound_PRICE1_LaunderClosedWithFloodedLedger(t *testing.T) {
	const c = "alice"
	const N, M = int64(4000), int64(400)
	t0 := uint64(2_000_000)
	t1 := t0 + ExitTaxDecayBlocks

	s := NewMemStore()
	pfMarket(t, s, c, t1+1000)
	pfBuy(t, s, "whale", c, t0, N) // aged pile

	// Flood: fill the ledger to exactly MaxLots with 1-token cohorts at distinct
	// blocks, so the next inflow MUST trigger a merge.
	for i := 0; i < MaxLots; i++ {
		blk := t1 + uint64(i)
		pfBuy(t, s, "flood", c, blk, 1)
		if err := TransferCredits(s, "flood", c, "flood", "whale", blk, big.NewInt(1)); err != nil {
			t.Fatalf("flood #%d: %v", i, err)
		}
	}
	if got := zvNumCohorts(s, c, "whale"); got != MaxLots {
		t.Fatalf("precondition: wanted a FULL ledger (%d cohorts), got %d", MaxLots, got)
	}

	// Now the launder: the big fresh slice lands. This inflow is over the cap.
	blkM := t1 + uint64(MaxLots) + 100
	pfBuy(t, s, "alt", c, blkM, M)
	if err := TransferCredits(s, "alt", c, "alt", "whale", blkM, big.NewInt(M)); err != nil {
		t.Fatal(err)
	}
	if got := zvNumCohorts(s, c, "whale"); got > MaxLots {
		t.Fatalf("bound broken during the launder: %d cohorts", got)
	}

	// THE FRESH SLICE MUST NOT HAVE BEEN DILUTED. The freshest cohort carries at
	// least M tokens at the FULL rate.
	rows := zbLotsRate(s, c, "whale", blkM)
	if len(rows) == 0 {
		t.Fatal("no cohorts")
	}
	top := rows[0]
	if top.Bps != MaxExitTaxBps {
		t.Fatalf("LAUNDER RE-OPENED: freshest cohort (%s tokens, acq=%d) reads %d bps, want %d",
			top.Count, top.Acq, top.Bps, MaxExitTaxBps)
	}
	if top.Count.Cmp(big.NewInt(M)) < 0 {
		t.Fatalf("the fresh M was split/diluted: freshest cohort holds only %s of %d", top.Count, M)
	}
	// And the aged pile is STILL a separate, still-matured cohort — the merge did
	// not fold fresh into aged in either direction.
	aged := rows[len(rows)-1]
	if aged.Bps != 0 || aged.Count.Cmp(big.NewInt(N)) != 0 {
		t.Fatalf("aged cohort disturbed: count=%s (want %d) bps=%d (want 0)", aged.Count, N, aged.Bps)
	}

	supply := getMoney(s, kSupply(c))
	topM, _ := SellProceeds(supply, big.NewInt(M))
	intended := ExitTaxOn(topM, MaxExitTaxBps)
	total := getMoney(s, kBal(c, "whale"))
	q, err := QuoteSell(s, "whale", c, blkM, total)
	if err != nil {
		t.Fatal(err)
	}
	if q.Tax.Cmp(intended) < 0 {
		t.Fatalf("FLOODED LAUNDER: tax=%s < intended fresh-slice floor=%s (avoided=%s)",
			q.Tax, intended, new(big.Int).Sub(intended, q.Tax))
	}
	t.Logf("FLOODED LAUNDER CLOSED: ledger at cap (%d cohorts), fresh M=%d still at %d bps on the top slice; "+
		"tax=%s >= intended floor=%s; aged pile intact at 0 bps",
		zvNumCohorts(s, c, "whale"), M, top.Bps, q.Tax, intended)
}

// ---------------------------------------------------------------------------
// 2d. THE STRUCTURAL REASON, asserted directly: boundLots is ACQ-MONOTONE — no
// token's acq ever DECREASES. Since lotRateAt is non-decreasing in acq, no
// token's rate can ever fall, at this block or any later one, so a fresh cohort
// can never be pulled onto an aged cohort's rate. Randomized over 4,000 ledgers.
// ---------------------------------------------------------------------------
func TestZZBound_MergeNeverLowersAnyTokensAcq(t *testing.T) {
	r := rand.New(rand.NewSource(0xB0DEC0))
	block := uint64(5_000_000)
	merges := 0
	for iter := 0; iter < 4000; iter++ {
		n := MaxLots + 1 + r.Intn(80)
		lots := make([]mLot, 0, n)
		used := map[uint64]bool{}
		for len(lots) < n {
			// Spread acqs over 3 windows so some cohorts are matured, some fresh,
			// some in between (and some above `block` — the block-fresh convention).
			acq := block - uint64(r.Int63n(int64(3*ExitTaxDecayBlocks)))
			if used[acq] {
				continue
			}
			used[acq] = true
			lots = append(lots, mLot{count: big.NewInt(1 + r.Int63n(1_000_000)), acq: acq})
		}
		sortLotsFreshestFirst(lots)
		in := append([]mLot(nil), lots...)

		out := boundLots(append([]mLot(nil), lots...), block)
		merges++

		if len(out) > MaxLots {
			t.Fatalf("iter %d: boundLots left %d cohorts > MaxLots", iter, len(out))
		}
		// Conservation: Σ counts unchanged.
		sumIn, sumOut := mZero(), mZero()
		for _, l := range in {
			sumIn = mAdd(sumIn, l.count)
		}
		for _, l := range out {
			sumOut = mAdd(sumOut, l.count)
		}
		if sumIn.Cmp(sumOut) != 0 {
			t.Fatalf("iter %d: Σ counts changed %s -> %s", iter, sumIn, sumOut)
		}
		// ACQ MONOTONICITY, stated as first-order stochastic dominance in acq:
		// for EVERY threshold a, the output holds AT LEAST as many tokens with
		// acq >= a as the input did. Equivalent to "no token moved to an older
		// acq" (merges only ever pull tokens UP).
		thresholds := make([]uint64, 0, len(in)+len(out))
		for _, l := range in {
			thresholds = append(thresholds, l.acq)
		}
		for _, l := range out {
			thresholds = append(thresholds, l.acq)
		}
		for _, a := range thresholds {
			ci, co := mZero(), mZero()
			for _, l := range in {
				if l.acq >= a {
					ci = mAdd(ci, l.count)
				}
			}
			for _, l := range out {
				if l.acq >= a {
					co = mAdd(co, l.count)
				}
			}
			if co.Cmp(ci) < 0 {
				t.Fatalf("iter %d: ACQ REGRESSION at threshold %d — tokens at acq>=%d fell %s -> %s "+
					"(a merge adopted an OLDER acq; that is the launder)", iter, a, a, ci, co)
			}
		}
		// Sorted output (freshest-first) is required by every reader.
		for i := 1; i < len(out); i++ {
			if out[i].acq > out[i-1].acq {
				t.Fatalf("iter %d: boundLots output not freshest-first at %d", iter, i)
			}
		}
	}
	t.Logf("ACQ-MONOTONE over %d randomized over-cap ledgers: no token's acq ever decreased, "+
		"Σ counts preserved, output always <= MaxLots=%d and freshest-first. "+
		"No merge can lower a rate => the launder cannot re-open through the bound.", merges, MaxLots)
}
