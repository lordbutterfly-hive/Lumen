package core

import (
	"math/big"
	"testing"
)

// zz_bound_expiry_test.go — PROOF 5: the MaxLots bound does not regress the
// exit-tax EXPIRY proof (VERIFY-EXIT-TAX-EXPIRY). A ledger that has actually
// been merged still matures to rate 0, still graduates cleanly, leaves no orphan
// `lots|` key, double-counts nothing, and traps nobody.

// ---------------------------------------------------------------------------
// 5a. A MERGED ledger matures to 0 and graduates cleanly.
// ---------------------------------------------------------------------------
func TestZZBound_MergedLedgerStillMaturesAndGraduates(t *testing.T) {
	const c, h = "alice", "holder"
	t0 := uint64(2_000_000)
	const N = 200
	s := NewMemStore()
	zbMarket(t, s, c, t0+N+2*ExitTaxDecayBlocks+10)

	for i := 0; i < N; i++ {
		if _, err := Buy(s, h, c, t0+uint64(i), big.NewInt(1)); err != nil {
			t.Fatalf("buy #%d: %v", i, err)
		}
	}
	cohorts := zvNumCohorts(s, c, h)
	if cohorts >= N {
		t.Fatalf("precondition: wanted a MERGED ledger, got %d cohorts for %d inflows", cohorts, N)
	}
	bal := getMoney(s, kBal(c, h))
	if bal.Cmp(big.NewInt(N)) != 0 {
		t.Fatalf("kBal=%s want %d", bal, N)
	}
	if sum := zvSumLotsRaw(s, c, h); sum.Cmp(bal) != 0 {
		t.Fatalf("Σlots=%s != kBal=%s", sum, bal)
	}

	// Advance one full window past the LAST (freshest) inflow.
	at := t0 + uint64(N-1) + ExitTaxDecayBlocks
	tbKeepPaid(t, s, c, t0, at)

	// EVERY cohort of the merged ledger reads rate 0.
	for i, l := range getLotsRaw(s, c, h) {
		if bps := lotRateAt(l.acq, at); bps != 0 {
			t.Fatalf("cohort %d (%s tokens @acq %d) still reads %d bps at the window", i, l.count, l.acq, bps)
		}
	}
	// And the whole-position cohort tax is exactly 0.
	supply := getMoney(s, kSupply(c))
	_, fm := splitDraw(s, c, h, bal)
	cohortTax, _, topBps, err := maturingCohortTax(s, c, h, supply, fm, at)
	if err != nil {
		t.Fatal(err)
	}
	if cohortTax.Sign() != 0 || topBps != 0 {
		t.Fatalf("merged ledger at the window: cohortTax=%s topBps=%d, want 0/0", cohortTax, topBps)
	}
	if bps := ExitTaxBpsAt(heldBlocksAt(s, c, h, at)); bps != 0 {
		t.Fatalf("blended rate %d bps at the window, want 0", bps)
	}

	// Graduation clears the ledger — no orphan key, nothing left behind.
	moved := Graduate(s, c, h, at)
	if moved.Cmp(bal) != 0 {
		t.Fatalf("Graduate moved %s, want %s", moved, bal)
	}
	if zvHasLots(s, c, h) {
		t.Fatalf("ORPHAN: lots| survived graduation: %q", zvLotsStr(s, c, h))
	}
	if got := MaturedOf(s, c, h); got.Cmp(bal) != 0 {
		t.Fatalf("matured=%s want %s", got, bal)
	}
	if got := MaturingOf(s, c, h); got.Sign() != 0 {
		t.Fatalf("maturing bucket not empty: %s", got)
	}
	zvAssertNoOrphanLots(t, s, "after graduation of a merged ledger")

	// Full exit at 0 tax.
	r, err := Sell(s, h, c, at, bal, nil)
	if err != nil {
		t.Fatalf("Sell: %v", err)
	}
	if r.Tax.Sign() != 0 {
		t.Fatalf("matured merged position taxed %s, want 0", r.Tax)
	}
	if r.TaxBps != 0 {
		t.Fatalf("taxBps=%d want 0", r.TaxBps)
	}
	zvAssertReserveEqualsArea(t, s, c, "after full exit of a merged ledger")
	zvAssertNoOrphanLots(t, s, "after full exit of a merged ledger")
	t.Logf("EXPIRY INTACT: %d inflows -> %d merged cohorts -> all rate 0 at the window, cohortTax=0, "+
		"Graduate moved %s and DELETED lots|, full exit gross=%s tax=0 fee=%s net=%s, R==Area(S).",
		N, cohorts, moved, r.Gross, r.Fee, r.Net)
}

// ---------------------------------------------------------------------------
// 5b. THE FREE COLLAPSE ON A LIVE POSITION. It matters exactly where the BLENDED
// clock has NOT matured (so graduate() does not fire and empty the ledger) while
// individual old cohorts HAVE passed the window — a heterogeneous position that
// keeps taking inflows. Those matured cohorts are reclaimed for nothing and the
// live cohorts keep their exact clocks.
// ---------------------------------------------------------------------------
func TestZZBound_MaturedTailCollapsesOnLivePosition(t *testing.T) {
	const c, h = "alice", "holder"
	t0 := uint64(3_000_000)
	s := NewMemStore()
	zbMarket(t, s, c, t0+3*ExitTaxDecayBlocks+10)
	tbKeepPaid(t, s, c, t0, t0+2*ExitTaxDecayBlocks+500)

	// Phase 1 — 40 cohorts of 10 tokens at distinct early blocks (400 tokens).
	for i := 0; i < 40; i++ {
		if _, err := Buy(s, h, c, t0+uint64(i), big.NewInt(10)); err != nil {
			t.Fatal(err)
		}
	}
	// Phase 2 — a big mid-window buy that keeps the BLEND well short of maturity,
	// so nothing graduates when the old cohorts individually pass the window.
	mid := t0 + ExitTaxDecayBlocks/2
	if _, err := Buy(s, h, c, mid, big.NewInt(400)); err != nil {
		t.Fatal(err)
	}
	before := zvNumCohorts(s, c, h)

	// Phase 3 — 40 more distinct-block inflows, past the window for phase 1 but
	// not for the blend. This crosses MaxLots and triggers the bound.
	liveStart := t0 + ExitTaxDecayBlocks + 100
	for i := 0; i < 40; i++ {
		if _, err := Buy(s, h, c, liveStart+uint64(i), big.NewInt(10)); err != nil {
			t.Fatalf("phase-3 buy #%d: %v", i, err)
		}
	}
	at := liveStart + 39
	if maturedNow(s, c, h, at) {
		t.Fatalf("precondition: the BLEND matured, so graduate() emptied the ledger — this test needs a live blend")
	}
	if got := MaturedOf(s, c, h); got.Sign() != 0 {
		t.Fatalf("precondition: nothing should have graduated, matured=%s", got)
	}

	lots := getLotsRaw(s, c, h)
	after := len(lots)
	if after > MaxLots {
		t.Fatalf("bound broken: %d cohorts", after)
	}
	// The whole phase-1 tail is now ONE cohort of 400 tokens at 0 bps.
	matured, maturedTokens := 0, mZero()
	for _, l := range lots {
		if lotRateAt(l.acq, at) == 0 {
			matured++
			maturedTokens = mAdd(maturedTokens, l.count)
		}
	}
	if matured != 1 {
		t.Fatalf("expected exactly 1 matured cohort after the free collapse, got %d", matured)
	}
	if maturedTokens.Cmp(big.NewInt(400)) != 0 {
		t.Fatalf("matured tail holds %s, want the 400 phase-1 tokens", maturedTokens)
	}
	// The 41 LIVE cohorts (phase 2 + phase 3) survive individually and keep their
	// own clocks — the collapse only ever touches rate-0 cohorts.
	if live := after - matured; live != 41 {
		t.Fatalf("expected 41 live cohorts preserved, got %d", live)
	}
	if lots[0].acq != at {
		t.Fatalf("freshest cohort acq=%d, want the last inflow block %d", lots[0].acq, at)
	}
	if sum, bal := zvSumLotsRaw(s, c, h), getMoney(s, kBal(c, h)); sum.Cmp(bal) != 0 {
		t.Fatalf("Σlots=%s != kBal=%s", sum, bal)
	}
	zvAssertNoOrphanLots(t, s, "after the free collapse")
	t.Logf("FREE COLLAPSE ON A LIVE POSITION: %d cohorts before phase 3 -> %d after 40 more inflows "+
		"(41 live cohorts with their own clocks + 1 matured cohort holding all %s phase-1 tokens at 0 bps); "+
		"blend NOT matured (nothing graduated), Sigmalots==kBal.",
		before, after, maturedTokens)
}

// ---------------------------------------------------------------------------
// 5c. BOUNDARY, on a merged ledger: 1 block before the window the tax is
// non-zero, exactly at the window it is 0 — the bound does not shift maturity.
// ---------------------------------------------------------------------------
func TestZZBound_MergedLedgerMaturityBoundaryUnshifted(t *testing.T) {
	const c, h = "alice", "holder"
	t0 := uint64(4_000_000)
	const N = 120
	s := NewMemStore()
	zbMarket(t, s, c, t0+N+2*ExitTaxDecayBlocks+10)
	for i := 0; i < N; i++ {
		if _, err := Buy(s, h, c, t0+uint64(i), big.NewInt(5)); err != nil {
			t.Fatal(err)
		}
	}
	freshest := t0 + uint64(N-1)
	tbKeepPaid(t, s, c, t0, freshest+ExitTaxDecayBlocks+10)
	bal := getMoney(s, kBal(c, h))
	supply := getMoney(s, kSupply(c))
	_, fm := splitDraw(s, c, h, bal)

	// The FRESHEST cohort's acq must be exactly the last buy block: no merge may
	// have pushed a cohort's clock forward or backward.
	lots := getLotsRaw(s, c, h)
	if lots[0].acq != freshest {
		t.Fatalf("freshest cohort acq=%d, want the last inflow block %d (the bound moved a clock)", lots[0].acq, freshest)
	}

	one := freshest + ExitTaxDecayBlocks - 1
	exact := freshest + ExitTaxDecayBlocks
	taxOne, _, bpsOne, err := maturingCohortTax(s, c, h, supply, fm, one)
	if err != nil {
		t.Fatal(err)
	}
	taxExact, _, bpsExact, err := maturingCohortTax(s, c, h, supply, fm, exact)
	if err != nil {
		t.Fatal(err)
	}
	taxAfter, _, bpsAfter, err := maturingCohortTax(s, c, h, supply, fm, exact+100_000)
	if err != nil {
		t.Fatal(err)
	}
	if taxOne.Sign() == 0 || bpsOne == 0 {
		t.Fatalf("one block BEFORE the window: tax=%s bps=%d, want non-zero", taxOne, bpsOne)
	}
	if taxExact.Sign() != 0 || bpsExact != 0 {
		t.Fatalf("EXACTLY at the window: tax=%s bps=%d, want 0/0 (the bound shifted maturity)", taxExact, bpsExact)
	}
	if taxAfter.Sign() != 0 || bpsAfter != 0 {
		t.Fatalf("past the window: tax=%s bps=%d, want 0/0", taxAfter, bpsAfter)
	}
	t.Logf("BOUNDARY UNSHIFTED on a merged ledger (%d cohorts): window−1 -> tax=%s (%d bps); "+
		"window -> tax=0 (0 bps); window+100000 -> tax=0 (0 bps).",
		zvNumCohorts(s, c, h), taxOne, bpsOne)
}
