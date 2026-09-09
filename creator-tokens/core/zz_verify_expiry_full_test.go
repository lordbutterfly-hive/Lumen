package core

import (
	"math/big"
	"testing"
)

// SCENARIO 1 — FULL MATURITY PATH. Buy, hold past ExitTaxDecayBlocks, graduate,
// then sell. The load-bearing assertions: the `lots|` key is DELETED (no
// orphan), tokens land in the matured bucket, and a subsequent Sell pays ZERO
// exit tax at the correct fee/proceeds with R==Area(S) preserved.

func TestZZVerifyExpiry_FullMaturityPath_StandaloneGraduate(t *testing.T) {
	const c, h = "hive:alice", "hive:bob"
	s := tbMarket(t, c)
	buyAt := uint64(1_000_000)

	at := zvMature(t, s, c, h, 500, buyAt)

	// BEFORE graduation: the ledger exists and accounts for the whole maturing
	// balance (one cohort, since it was one buy).
	if !zvHasLots(s, c, h) {
		t.Fatal("pre-graduation: expected a lots| ledger for the maturing position")
	}
	if got := zvSumLotsRaw(s, c, h); got.Cmp(big.NewInt(500)) != 0 {
		t.Fatalf("pre-graduation: Σlots=%s want 500", got)
	}
	if MaturingOf(s, c, h).Cmp(big.NewInt(500)) != 0 || MaturedOf(s, c, h).Sign() != 0 {
		t.Fatalf("pre-graduation: maturing=%s matured=%s want 500/0", MaturingOf(s, c, h), MaturedOf(s, c, h))
	}

	// Held exactly the window => matured, tax rate 0, cohort rate 0.
	if !maturedNow(s, c, h, at) {
		t.Fatal("at ExitTaxDecayBlocks the position must read matured")
	}
	if bps := ExitTaxBpsAt(heldBlocksAt(s, c, h, at)); bps != 0 {
		t.Fatalf("blended taxBps at maturity = %d want 0", bps)
	}
	if r := lotRateAt(holderAcqBlock(s, c, h), at); r != 0 {
		t.Fatalf("cohort rate at maturity = %d want 0", r)
	}

	// GRADUATE (standalone).
	moved := Graduate(s, c, h, at)
	if moved.Cmp(big.NewInt(500)) != 0 {
		t.Fatalf("Graduate moved %s want 500", moved)
	}

	// ORPHAN CHECK: lots| key DELETED, kBal deleted, kAcqBlock deleted.
	if zvHasLots(s, c, h) {
		t.Fatalf("ORPHAN: lots| ledger survived graduation: %q", zvLotsStr(s, c, h))
	}
	if _, ok := s.Get(kBal(c, h)); ok {
		t.Fatal("kBal key survived graduation (should be deleted)")
	}
	if _, ok := s.Get(kAcqBlock(c, h)); ok {
		t.Fatal("kAcqBlock key survived graduation (should be deleted)")
	}
	if MaturedOf(s, c, h).Cmp(big.NewInt(500)) != 0 {
		t.Fatalf("matured after graduation = %s want 500", MaturedOf(s, c, h))
	}
	zvAssertNoOrphanLots(t, s, "after standalone graduate")

	// SUBSEQUENT SELL of 200 (drawn from the matured bucket) pays ZERO tax.
	supplyBefore := new(big.Int).Set(Supply(s, c))
	r, err := Sell(s, h, c, at, big.NewInt(200))
	if err != nil {
		t.Fatalf("post-maturity Sell refused: %v", err)
	}
	if r.Tax.Sign() != 0 {
		t.Fatalf("post-maturity exit tax = %s, MUST be 0", r.Tax)
	}
	if r.TaxBps != 0 {
		t.Fatalf("post-maturity taxBps = %d, MUST be 0", r.TaxBps)
	}
	if r.Graduated.Sign() != 0 {
		t.Fatalf("already graduated, so this Sell should graduate 0, got %s", r.Graduated)
	}
	if r.MaturedBurned.Cmp(big.NewInt(200)) != 0 {
		t.Fatalf("MaturedBurned=%s want 200 (drawn from matured bucket)", r.MaturedBurned)
	}
	gross := zvAssertSellShape(t, r, supplyBefore, big.NewInt(200), "post-maturity sell")
	t.Logf("post-maturity Sell 200: gross=%s tax=%s fee=%s net=%s (taxBps=%d)", gross, r.Tax, r.Fee, r.Net, r.TaxBps)

	if MaturedOf(s, c, h).Cmp(big.NewInt(300)) != 0 {
		t.Fatalf("matured after selling 200 of 500 = %s want 300", MaturedOf(s, c, h))
	}
	zvAssertReserveEqualsArea(t, s, c, "after post-maturity sell")
	zvAssertNoOrphanLots(t, s, "after post-maturity sell")
	zvAssertPositionsSumToSupply(t, s, c, "after post-maturity sell")
}

// Graduation as a side effect of Sell (no standalone Graduate call): the same
// zero-tax outcome, ledger cleared inside the Sell.
func TestZZVerifyExpiry_FullMaturityPath_GraduateViaSell(t *testing.T) {
	const c, h = "hive:alice", "hive:bob"
	s := tbMarket(t, c)
	buyAt := uint64(1_000_000)
	at := zvMature(t, s, c, h, 500, buyAt)

	supplyBefore := new(big.Int).Set(Supply(s, c))
	r, err := Sell(s, h, c, at, big.NewInt(200))
	if err != nil {
		t.Fatalf("Sell at maturity refused: %v", err)
	}
	if r.Tax.Sign() != 0 || r.TaxBps != 0 {
		t.Fatalf("tax=%s taxBps=%d MUST both be 0 at maturity", r.Tax, r.TaxBps)
	}
	// Sell fired graduate() internally: the WHOLE maturing balance (500) moved
	// to matured, then 200 were burned from it.
	if r.Graduated.Cmp(big.NewInt(500)) != 0 {
		t.Fatalf("Graduated=%s want 500 (whole maturing balance graduated by the sell)", r.Graduated)
	}
	if r.MaturedBurned.Cmp(big.NewInt(200)) != 0 {
		t.Fatalf("MaturedBurned=%s want 200", r.MaturedBurned)
	}
	if zvHasLots(s, c, h) {
		t.Fatalf("ORPHAN: lots| survived graduate-via-sell: %q", zvLotsStr(s, c, h))
	}
	if MaturingOf(s, c, h).Sign() != 0 {
		t.Fatalf("maturing bucket = %s want 0 after graduate-via-sell", MaturingOf(s, c, h))
	}
	if MaturedOf(s, c, h).Cmp(big.NewInt(300)) != 0 {
		t.Fatalf("matured = %s want 300", MaturedOf(s, c, h))
	}
	gross := zvAssertSellShape(t, r, supplyBefore, big.NewInt(200), "graduate-via-sell")
	t.Logf("graduate-via-sell 200: gross=%s tax=%s fee=%s net=%s graduated=%s", gross, r.Tax, r.Fee, r.Net, r.Graduated)
	zvAssertReserveEqualsArea(t, s, c, "graduate-via-sell")
	zvAssertNoOrphanLots(t, s, "graduate-via-sell")
	zvAssertPositionsSumToSupply(t, s, c, "graduate-via-sell")
}
