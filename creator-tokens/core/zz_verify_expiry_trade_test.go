package core

import (
	"math/big"
	"testing"
)

// SCENARIO 3 — TRADE NORMALLY AFTER EXPIRY. After a position matured and
// graduated (ledger empty), a fresh Buy must create a NEW `lots|` cohort
// cleanly — the ledger regenerates, is not corrupted by the prior clear, and
// its OWN maturity clock starts fresh.
func TestZZVerifyExpiry_TradeNormallyAfterExpiry(t *testing.T) {
	const c, h = "hive:alice", "hive:bob"
	s := tbMarket(t, c)

	b1 := uint64(1_000_000)
	t1 := b1 + tbWindow
	// Keep ACTIVE from b1 all the way through the SECOND window (t1 + window),
	// so the fresh buy at t1 and its own maturation are both covered.
	tbKeepPaid(t, s, c, b1, t1+tbWindow)

	if _, err := Buy(s, h, c, b1, big.NewInt(500)); err != nil {
		t.Fatalf("first buy: %v", err)
	}
	if Graduate(s, c, h, t1).Cmp(big.NewInt(500)) != 0 {
		t.Fatalf("graduate should move 500")
	}
	// Ledger cleared, 500 matured.
	if zvHasLots(s, c, h) {
		t.Fatalf("ledger not cleared before fresh buy: %q", zvLotsStr(s, c, h))
	}
	if MaturedOf(s, c, h).Cmp(big.NewInt(500)) != 0 {
		t.Fatalf("matured=%s want 500", MaturedOf(s, c, h))
	}

	// FRESH BUY of 300 on the cleared ledger.
	if _, err := Buy(s, h, c, t1, big.NewInt(300)); err != nil {
		t.Fatalf("fresh buy after expiry: %v", err)
	}

	// A NEW, single, uncorrupted cohort of exactly 300 at clock t1.
	lots := getLotsRaw(s, c, h)
	if len(lots) != 1 {
		t.Fatalf("fresh buy should yield exactly 1 new cohort, got %d: %q", len(lots), zvLotsStr(s, c, h))
	}
	if lots[0].count.Cmp(big.NewInt(300)) != 0 || lots[0].acq != t1 {
		t.Fatalf("new cohort = {%s,%d} want {300,%d}", lots[0].count, lots[0].acq, t1)
	}
	if got := zvSumLotsRaw(s, c, h); got.Cmp(big.NewInt(300)) != 0 {
		t.Fatalf("Σlots=%s want 300 (==maturing kBal)", got)
	}
	// The matured pile from the first life is untouched — no double count.
	if MaturedOf(s, c, h).Cmp(big.NewInt(500)) != 0 {
		t.Fatalf("matured=%s want 500 (fresh buy must not disturb it)", MaturedOf(s, c, h))
	}

	// The new cohort's clock is FRESH: not matured, full rate right now.
	if maturedNow(s, c, h, t1) {
		t.Fatal("freshly bought cohort must NOT read matured")
	}
	if got := heldBlocksAt(s, c, h, t1); got != 0 {
		t.Fatalf("fresh cohort held=%d want 0", got)
	}
	if bps := ExitTaxBpsAt(heldBlocksAt(s, c, h, t1)); bps != MaxExitTaxBps {
		t.Fatalf("fresh cohort taxBps=%d want MaxExitTaxBps=%d", bps, MaxExitTaxBps)
	}
	if r := lotRateAt(t1, t1); r != MaxExitTaxBps {
		t.Fatalf("fresh cohort lotRate=%d want %d", r, MaxExitTaxBps)
	}
	zvAssertNoOrphanLots(t, s, "after fresh buy on cleared ledger")

	// A sale of the fresh cohort RIGHT NOW pays the full exit tax — proof the
	// fresh maturity clock genuinely restarted (not inherited maturity).
	supplyBefore := new(big.Int).Set(Supply(s, c))
	fresh, err := QuoteSell(s, h, c, t1, big.NewInt(300))
	if err != nil {
		t.Fatalf("quote fresh sell: %v", err)
	}
	// taxableGross is the maturing top slice (the 300 fresh tokens); matured
	// tokens are not part of this draw (splitDraw takes maturing first).
	wantTaxable, _ := SellProceeds(supplyBefore, big.NewInt(300))
	wantTax := ExitTaxOn(wantTaxable, MaxExitTaxBps)
	if fresh.Tax.Cmp(wantTax) != 0 {
		t.Fatalf("fresh-cohort tax=%s want %s (full rate on its own slice)", fresh.Tax, wantTax)
	}
	t.Logf("fresh cohort quote (sold immediately): taxableGross=%s tax=%s taxBps=%d", fresh.TaxableGross, fresh.Tax, fresh.TaxBps)

	// Now let the NEW cohort mature too: advance a full window, graduate, and
	// confirm it also reaches 0 — a second, independent maturity cycle works.
	t2 := t1 + tbWindow
	if !maturedNow(s, c, h, t2) {
		t.Fatal("the fresh cohort should mature after its own window")
	}
	if r := lotRateAt(t1, t2); r != 0 {
		t.Fatalf("matured fresh cohort rate=%d want 0", r)
	}
	if Graduate(s, c, h, t2).Cmp(big.NewInt(300)) != 0 {
		t.Fatalf("second graduation should move 300")
	}
	if zvHasLots(s, c, h) {
		t.Fatalf("ORPHAN after second graduation: %q", zvLotsStr(s, c, h))
	}
	if MaturedOf(s, c, h).Cmp(big.NewInt(800)) != 0 {
		t.Fatalf("matured=%s want 800 (500 + 300)", MaturedOf(s, c, h))
	}

	// Sell out the whole 800 — zero tax, clean full exit.
	supplyBefore = new(big.Int).Set(Supply(s, c))
	r, err := Sell(s, h, c, t2, big.NewInt(800))
	if err != nil {
		t.Fatalf("final full sell: %v", err)
	}
	if r.Tax.Sign() != 0 || r.TaxBps != 0 {
		t.Fatalf("final full-exit tax=%s taxBps=%d MUST be 0", r.Tax, r.TaxBps)
	}
	zvAssertSellShape(t, r, supplyBefore, big.NewInt(800), "final full sell")
	zvAssertReserveEqualsArea(t, s, c, "after second-cycle full exit")
	zvAssertNoOrphanLots(t, s, "after second-cycle full exit")
	zvAssertPositionsSumToSupply(t, s, c, "after second-cycle full exit")
}
