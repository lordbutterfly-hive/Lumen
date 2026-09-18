package core

import (
	"math/big"
	"testing"
)

// THE SETTLEMENT LOT BOUND MUST NEVER LAUNDER, AND v5 MADE IT ORDINARY.
//
// Written 2026-09-18 after an adversarial review of the v5 bounds. Under the
// old 5%-of-supply spend cap an escrow could only ever draw a sliver of a
// holder's position, so crossing MaxSettlementLots (8) took a holder whose
// WHOLE position was under 5% of supply. v5 lets anyone spend their whole
// balance in one ask, which makes a 9+ cohort escrow an ordinary event rather
// than a pathological one. So the bound's own invariant needs a test:
//
//   - at or below MaxSettlementLots the path is byte-identical (zero delta);
//   - above it the merge may only ever RAISE the tax (mergeCheapestAdjacentLot
//     keeps the YOUNGER acq), never lower it — a lower one would be a
//     laundering rail;
//   - and the size of that rise is recorded here, because it is a real cost
//     borne by an asker whose escrow comes BACK (Decline/Reclaim), and the
//     round-trip docs in ask.go promise age-neutrality they cannot deliver
//     past 8 cohorts.
//
// ★ FRESHEST FIRST. getLots returns cohorts highest-acq-first and the merge's
// "younger acq" invariant assumes it. Building the fixture ascending inverts
// the merge and measures a tax REDUCTION the real path cannot produce — which
// is exactly what the first version of this test did.
func TestV5_SettlementLotBoundOnlyEverRaisesTax(t *testing.T) {
	block := uint64(10_000_000)
	build := func(n int) []mLot {
		lots := make([]mLot, 0, n)
		step := ExitTaxDecayBlocks / uint64(n+1)
		for i := 0; i < n; i++ {
			lots = append(lots, mLot{acq: block - step*uint64(i+1), count: big.NewInt(1000)})
		}
		return lots
	}
	taxOf := func(lots []mLot) *big.Int {
		total := big.NewInt(0)
		for _, l := range lots {
			total = new(big.Int).Add(total, ExitTaxOn(l.count, lotRateAt(l.acq, block)))
		}
		return total
	}
	for _, n := range []int{1, 8, 9, 12, 20, 40, 64} {
		lots := build(n)
		before := taxOf(lots)
		after := taxOf(boundSettlementLots(append([]mLot(nil), lots...), block))
		delta := new(big.Int).Sub(after, before)
		if n <= MaxSettlementLots {
			if delta.Sign() != 0 {
				t.Fatalf("%d cohorts: the bound must be a no-op at or below MaxSettlementLots, tax moved by %s", n, delta)
			}
			continue
		}
		if delta.Sign() < 0 {
			t.Fatalf("%d cohorts: the merge LOWERED the exit tax by %s — that is a laundering rail", n, delta.Abs(delta))
		}
		pct := float64(delta.Int64()) / float64(before.Int64()) * 100
		t.Logf("%2d cohorts: tax %s -> %s (+%s, +%.2f%%) — borne by the asker if the escrow comes back", n, before, after, delta, pct)
	}
}
