package core

import (
	"math/big"
	"testing"
)

// SCENARIO 2 — MIXED THEN FULLY MATURED. An AGED cohort plus a FRESH cohort,
// advanced so BOTH clear the decay window. Assert: 0 tax on the whole position
// (every cohort rate 0), the ledger clears on graduation, no leftover cohort.
func TestZZVerifyExpiry_MixedThenFullyMatured(t *testing.T) {
	const c, h = "hive:alice", "hive:bob"
	s := tbMarket(t, c)

	b1 := uint64(1_000_000)       // aged cohort acquired here
	b2 := b1 + 100_000            // fresh cohort, still 100k blocks younger
	at := b2 + tbWindow           // BOTH cohorts are past the window here
	tbKeepPaid(t, s, c, b1, at)   // keep ACTIVE across the whole span

	if _, err := Buy(s, h, c, b1, big.NewInt(400)); err != nil {
		t.Fatalf("buy aged cohort: %v", err)
	}
	if _, err := Buy(s, h, c, b2, big.NewInt(100)); err != nil {
		t.Fatalf("buy fresh cohort: %v", err)
	}

	// TWO distinct cohorts, accounting for the whole maturing balance.
	if n := zvNumCohorts(s, c, h); n != 2 {
		t.Fatalf("expected 2 cohorts (aged+fresh), got %d: %q", n, zvLotsStr(s, c, h))
	}
	if got := zvSumLotsRaw(s, c, h); got.Cmp(big.NewInt(500)) != 0 {
		t.Fatalf("Σlots=%s want 500 (==kBal)", got)
	}
	if MaturingOf(s, c, h).Cmp(big.NewInt(500)) != 0 {
		t.Fatalf("maturing=%s want 500", MaturingOf(s, c, h))
	}

	// At `at`, EVERY cohort rate is 0 and the blended clock reads matured.
	for _, l := range getLotsRaw(s, c, h) {
		if r := lotRateAt(l.acq, at); r != 0 {
			t.Fatalf("cohort acq=%d still rate %d at block %d — not fully matured", l.acq, r, at)
		}
	}
	if !maturedNow(s, c, h, at) {
		t.Fatal("blended clock should read matured once both cohorts pass the window")
	}
	// The per-cohort tax over the WHOLE maturing position is exactly 0.
	supply := new(big.Int).Set(Supply(s, c))
	cohortTax, _, topBps, err := maturingCohortTax(s, c, h, supply, big.NewInt(500), at)
	if err != nil {
		t.Fatalf("maturingCohortTax err %v", err)
	}
	if cohortTax.Sign() != 0 {
		t.Fatalf("cohort tax on the whole matured position = %s, MUST be 0", cohortTax)
	}
	if topBps != 0 {
		t.Fatalf("freshest cohort rate = %d, MUST be 0 after maturity", topBps)
	}

	// GRADUATE: ledger clears, whole balance becomes matured, no leftover cohort.
	moved := Graduate(s, c, h, at)
	if moved.Cmp(big.NewInt(500)) != 0 {
		t.Fatalf("graduate moved %s want 500", moved)
	}
	if zvHasLots(s, c, h) {
		t.Fatalf("ORPHAN: ledger survived graduation of a mixed position: %q", zvLotsStr(s, c, h))
	}
	if MaturedOf(s, c, h).Cmp(big.NewInt(500)) != 0 {
		t.Fatalf("matured=%s want 500", MaturedOf(s, c, h))
	}

	// SELL THE WHOLE 500 — zero tax on the entire (formerly mixed) position.
	r, err := Sell(s, h, c, at, big.NewInt(500))
	if err != nil {
		t.Fatalf("full sell refused: %v", err)
	}
	if r.Tax.Sign() != 0 || r.TaxBps != 0 {
		t.Fatalf("full-exit tax=%s taxBps=%d MUST both be 0", r.Tax, r.TaxBps)
	}
	gross := zvAssertSellShape(t, r, supply, big.NewInt(500), "full mixed sell")
	t.Logf("mixed matured full sell 500: gross=%s tax=%s fee=%s net=%s", gross, r.Tax, r.Fee, r.Net)

	// Full exit: everything drains to zero, cleanly.
	if Supply(s, c).Sign() != 0 {
		t.Fatalf("supply=%s want 0 after full exit", Supply(s, c))
	}
	if Reserve(s, c).Sign() != 0 {
		t.Fatalf("reserve=%s want 0 after full exit", Reserve(s, c))
	}
	if totalBalance(s, c, h).Sign() != 0 {
		t.Fatalf("position=%s want 0 after full exit", totalBalance(s, c, h))
	}
	zvAssertNoOrphanLots(t, s, "after full mixed exit")
}
