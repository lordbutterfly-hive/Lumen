package core

import (
	"math/big"
	"testing"
)

// HARDENING — adversarial probes of the "everything normal after expiry" claim,
// hitting paths the six scenarios don't: the migration-SYNTHESIS (legacy,
// un-ledgered) position at maturity, multi-cohort debits, double graduation, and
// a matured-but-not-graduated position receiving a transfer-in (double-count
// risk).

// A LEGACY position (kBal+kAcqBlock present, NO `lots|` ledger — a pre-fix
// holder, or any path not yet routed through the hooks) must mature and tax
// EXACTLY like the blend, then graduate cleanly with no orphan.
func TestZZVerifyExpiry_LegacySynthesizedCohortAtMaturity(t *testing.T) {
	const c, h = "hive:alice", "hive:bob"
	s := tbMarket(t, c)
	b1 := uint64(1_000_000)
	at := zvMature(t, s, c, h, 500, b1)

	// Simulate a pre-fix position: drop the ledger the Buy created, leaving only
	// kBal + kAcqBlock. getLots must SYNTHESISE a single cohort from them.
	s.Delete(kLots(c, h))
	if zvHasLots(s, c, h) {
		t.Fatal("precondition: ledger must be absent (legacy position)")
	}
	syn := getLots(s, c, h)
	if len(syn) != 1 || syn[0].count.Cmp(big.NewInt(500)) != 0 || syn[0].acq != b1 {
		t.Fatalf("synthesis = %v want one cohort {500,%d}", syn, b1)
	}

	// Backward-compat at the boundary-1: synthesized cohort tax == blend tax.
	supply := new(big.Int).Set(Supply(s, c))
	taxable, _ := SellProceeds(supply, big.NewInt(500))
	blendBefore := ExitTaxOn(taxable, ExitTaxBpsAt(heldBlocksAt(s, c, h, at-1)))
	cohortBefore, _, _, _ := maturingCohortTax(s, c, h, supply, big.NewInt(500), at-1)
	if cohortBefore.Cmp(blendBefore) != 0 {
		t.Fatalf("legacy cohort tax %s != blend %s one block before maturity (backward-compat broken)", cohortBefore, blendBefore)
	}
	// At maturity: 0.
	cohortAt, _, _, _ := maturingCohortTax(s, c, h, supply, big.NewInt(500), at)
	if cohortAt.Sign() != 0 {
		t.Fatalf("legacy synthesized cohort tax at maturity = %s, MUST be 0", cohortAt)
	}

	// A real Sell at maturity: 0 tax, graduates (lotsClear is a harmless no-op on
	// the absent key), full clean exit.
	r, err := Sell(s, h, c, at, big.NewInt(500))
	if err != nil {
		t.Fatalf("legacy sell at maturity: %v", err)
	}
	if r.Tax.Sign() != 0 || r.TaxBps != 0 {
		t.Fatalf("legacy matured tax=%s taxBps=%d MUST be 0", r.Tax, r.TaxBps)
	}
	if r.Graduated.Cmp(big.NewInt(500)) != 0 {
		t.Fatalf("legacy graduate=%s want 500", r.Graduated)
	}
	if Supply(s, c).Sign() != 0 || Reserve(s, c).Sign() != 0 {
		t.Fatalf("legacy full exit: supply=%s reserve=%s want 0/0", Supply(s, c), Reserve(s, c))
	}
	zvAssertNoOrphanLots(t, s, "legacy synthesized maturity")
	t.Logf("legacy (un-ledgered) matured: cohortTax==blend before maturity, ==0 at maturity, graduated 500 clean")
}

// A multi-cohort partial sell BEFORE maturity must keep Σlots == kBal (no
// double-count on the freshest-first debit).
func TestZZVerifyExpiry_MultiCohortPartialDebitConserves(t *testing.T) {
	const c, h = "hive:alice", "hive:bob"
	s := tbMarket(t, c)
	b1 := uint64(1_000_000)
	tbKeepPaid(t, s, c, b1, b1+50_000)
	mustBuy(t, s, c, h, b1, 300)
	mustBuy(t, s, c, h, b1+1_000, 200) // two cohorts, total 500
	if zvNumCohorts(s, c, h) != 2 {
		t.Fatalf("want 2 cohorts, got %d", zvNumCohorts(s, c, h))
	}
	// Partial sell of 120 mid-window (freshest-first consumes the b1+1000 cohort).
	if _, err := Sell(s, h, c, b1+2_000, big.NewInt(120)); err != nil {
		t.Fatalf("partial sell: %v", err)
	}
	if got := zvSumLotsRaw(s, c, h); got.Cmp(MaturingOf(s, c, h)) != 0 {
		t.Fatalf("Σlots=%s != kBal=%s after partial multi-cohort debit", got, MaturingOf(s, c, h))
	}
	if MaturingOf(s, c, h).Cmp(big.NewInt(380)) != 0 {
		t.Fatalf("maturing=%s want 380", MaturingOf(s, c, h))
	}
	zvAssertNoOrphanLots(t, s, "multi-cohort partial debit")
}

// Double graduation is a clean no-op: the second call moves 0, creates no key.
func TestZZVerifyExpiry_DoubleGraduationIsNoop(t *testing.T) {
	const c, h = "hive:alice", "hive:bob"
	s := tbMarket(t, c)
	b1 := uint64(1_000_000)
	at := zvMature(t, s, c, h, 500, b1)
	if Graduate(s, c, h, at).Cmp(big.NewInt(500)) != 0 {
		t.Fatal("first graduate")
	}
	if second := Graduate(s, c, h, at); second.Sign() != 0 {
		t.Fatalf("second graduate moved %s want 0 (no-op)", second)
	}
	if zvHasLots(s, c, h) {
		t.Fatalf("double graduate created/kept a ledger: %q", zvLotsStr(s, c, h))
	}
	if MaturedOf(s, c, h).Cmp(big.NewInt(500)) != 0 {
		t.Fatalf("matured=%s want 500 after double graduate", MaturedOf(s, c, h))
	}
	zvAssertNoOrphanLots(t, s, "double graduation")
}

// A matured-BUT-NOT-graduated position receiving a fresh transfer-in: the aged
// cohort and the fresh gift coexist in the ledger (Σlots==kBal, no double
// count), the blended clock correctly UN-matures (the gift defers graduation),
// and once BOTH clear the window everything graduates to 0.
func TestZZVerifyExpiry_TransferInOntoMaturedNotGraduated(t *testing.T) {
	const c, h, h2 = "hive:alice", "hive:bob", "hive:carol"
	s := tbMarket(t, c)
	b1 := uint64(1_000_000)
	t1 := b1 + tbWindow
	tbKeepPaid(t, s, c, b1, t1+tbWindow)
	mustBuy(t, s, c, h, b1, 500) // h matures at t1 but we do NOT graduate

	if !maturedNow(s, c, h, t1) {
		t.Fatal("h should be matured-by-time at t1")
	}
	// h2 buys fresh and gifts 100 maturing tokens to h at t1.
	mustBuy(t, s, c, h2, t1, 200)
	if err := TransferCredits(s, h2, c, h2, h, t1, big.NewInt(100)); err != nil {
		t.Fatalf("gift transfer: %v", err)
	}

	// No double count: aged 500 + fresh 100 both in the ledger, Σ==kBal==600.
	if got := zvSumLotsRaw(s, c, h); got.Cmp(big.NewInt(600)) != 0 {
		t.Fatalf("Σlots=%s want 600 (aged 500 + gift 100)", got)
	}
	if MaturingOf(s, c, h).Cmp(big.NewInt(600)) != 0 {
		t.Fatalf("maturing=%s want 600", MaturingOf(s, c, h))
	}
	// The gift DEFERS maturity (blended clock pulled fresh) — h is no longer
	// matured, so the aged pile can't graduate-and-shield.
	if maturedNow(s, c, h, t1) {
		t.Fatal("a fresh gift must un-mature the blended position (anti-shield)")
	}
	// The fresh gift is taxed at a high rate on a sale — the aged pile does NOT
	// dilute it down (PRICE-1 defense intact after expiry-adjacent state).
	q, err := QuoteSell(s, h, c, t1, big.NewInt(100))
	if err != nil {
		t.Fatalf("quote: %v", err)
	}
	if q.Tax.Sign() == 0 {
		t.Fatal("fresh gift slice must owe nonzero tax (not diluted by the aged pile)")
	}
	t.Logf("matured+gift: Σlots=600==kBal, un-matured (deferred), fresh-slice tax=%s (non-diluted)", q.Tax)

	// Advance so BOTH cohorts clear the window; then it all graduates to 0.
	t2 := t1 + tbWindow
	for _, l := range getLotsRaw(s, c, h) {
		if lr := lotRateAt(l.acq, t2); lr != 0 {
			t.Fatalf("cohort acq=%d still rate %d at t2", l.acq, lr)
		}
	}
	if !maturedNow(s, c, h, t2) {
		t.Fatal("both cohorts past the window: must be matured at t2")
	}
	if Graduate(s, c, h, t2).Cmp(big.NewInt(600)) != 0 {
		t.Fatal("graduate 600 at t2")
	}
	if zvHasLots(s, c, h) {
		t.Fatalf("ORPHAN after final graduation: %q", zvLotsStr(s, c, h))
	}
	if MaturedOf(s, c, h).Cmp(big.NewInt(600)) != 0 {
		t.Fatalf("matured=%s want 600", MaturedOf(s, c, h))
	}
	zvAssertNoOrphanLots(t, s, "transfer-in onto matured-not-graduated")
	zvAssertPositionsSumToSupply(t, s, c, "transfer-in onto matured-not-graduated")
}
