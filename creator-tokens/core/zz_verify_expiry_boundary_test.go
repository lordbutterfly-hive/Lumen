package core

import (
	"math/big"
	"testing"
)

// SCENARIO 5 — EDGE CASES.
//   - exactly AT ExitTaxDecayBlocks, one block before, one block after
//   - a position that matures, graduates, then receives a fresh transfer-in
//     (a new cohort on a cleared ledger)
//   - the cohort MERGE interacting with maturity (do merged/aged cohorts still
//     mature to 0?)

// The boundary of ExitTaxBpsAt / lotRateAt / maturedNow at the exact window.
func TestZZVerifyExpiry_Boundary_ExactAndAround(t *testing.T) {
	const c, h = "hive:alice", "hive:bob"
	s := tbMarket(t, c)
	b1 := uint64(1_000_000)
	T := b1 + tbWindow
	tbKeepPaid(t, s, c, b1, T+2)
	if _, err := Buy(s, h, c, b1, big.NewInt(500)); err != nil {
		t.Fatalf("buy: %v", err)
	}
	supply := new(big.Int).Set(Supply(s, c))
	taxable, _ := SellProceeds(supply, big.NewInt(500)) // whole maturing draw

	type row struct {
		block      uint64
		wantMatured bool
		wantBps    uint64
	}
	for _, r := range []row{
		{T - 1, false, 1},           // one block BEFORE: not matured, ceil-min 1 bps
		{T, true, 0},                // exactly AT the window: matured, 0 bps
		{T + 1, true, 0},            // one block AFTER: matured (capped), 0 bps
	} {
		if got := maturedNow(s, c, h, r.block); got != r.wantMatured {
			t.Fatalf("block %d: maturedNow=%v want %v", r.block, got, r.wantMatured)
		}
		if bps := ExitTaxBpsAt(heldBlocksAt(s, c, h, r.block)); bps != r.wantBps {
			t.Fatalf("block %d: blended taxBps=%d want %d", r.block, bps, r.wantBps)
		}
		if lr := lotRateAt(b1, r.block); lr != r.wantBps {
			t.Fatalf("block %d: cohort lotRate=%d want %d", r.block, lr, r.wantBps)
		}
		q, err := QuoteSell(s, h, c, r.block, big.NewInt(500))
		if err != nil {
			t.Fatalf("block %d: quote: %v", r.block, err)
		}
		wantTax := ExitTaxOn(taxable, r.wantBps)
		if q.Tax.Cmp(wantTax) != 0 {
			t.Fatalf("block %d: quoted tax=%s want %s", r.block, q.Tax, wantTax)
		}
		t.Logf("block %d (held=%d): matured=%v taxBps=%d tax=%s", r.block, heldBlocksAt(s, c, h, r.block), r.wantMatured, r.wantBps, q.Tax)
	}
}

// One block BEFORE the window: a real Sell pays a (tiny, nonzero) tax and does
// NOT graduate — the ledger survives, the position stays maturing.
func TestZZVerifyExpiry_Boundary_OneBefore_NoGraduation(t *testing.T) {
	const c, h = "hive:alice", "hive:bob"
	s := tbMarket(t, c)
	b1 := uint64(1_000_000)
	T := b1 + tbWindow
	tbKeepPaid(t, s, c, b1, T)
	if _, err := Buy(s, h, c, b1, big.NewInt(500)); err != nil {
		t.Fatalf("buy: %v", err)
	}
	supply := new(big.Int).Set(Supply(s, c))

	r, err := Sell(s, h, c, T-1, big.NewInt(200))
	if err != nil {
		t.Fatalf("sell one-before: %v", err)
	}
	if r.TaxBps != 1 {
		t.Fatalf("taxBps=%d want 1 (ceil-min, one block before maturity)", r.TaxBps)
	}
	wantTaxable, _ := SellProceeds(supply, big.NewInt(200))
	if r.Tax.Cmp(ExitTaxOn(wantTaxable, 1)) != 0 || r.Tax.Sign() == 0 {
		t.Fatalf("tax=%s want ceil(1bps of %s) and >0", r.Tax, wantTaxable)
	}
	if r.Graduated.Sign() != 0 {
		t.Fatalf("Graduated=%s want 0 (not matured one block before)", r.Graduated)
	}
	if !zvHasLots(s, c, h) {
		t.Fatal("ledger must survive a pre-maturity partial sell")
	}
	if got := zvSumLotsRaw(s, c, h); got.Cmp(big.NewInt(300)) != 0 {
		t.Fatalf("Σlots=%s want 300 (500-200)", got)
	}
	t.Logf("one-before sell 200: taxBps=%d tax=%s (nonzero), ledger intact Σ=300", r.TaxBps, r.Tax)
	zvAssertNoOrphanLots(t, s, "one-before sell")
}

// A matured, graduated holder receives a FRESH transfer-in — a new cohort must
// form on the cleared ledger, with the sender's (fresh) clock, matured pile
// untouched.
func TestZZVerifyExpiry_TransferInOnClearedLedger(t *testing.T) {
	const c, h, h2 = "hive:alice", "hive:bob", "hive:dave"
	s := tbMarket(t, c)
	b1 := uint64(1_000_000)
	at := zvMature(t, s, c, h, 500, b1) // h fully matures
	if Graduate(s, c, h, at).Cmp(big.NewInt(500)) != 0 {
		t.Fatal("graduate h")
	}
	// h now: matured=500, ledger cleared.
	if zvHasLots(s, c, h) {
		t.Fatal("precondition: h ledger must be clear")
	}

	// A second holder acquires a FRESH maturing position at `at`, then sends
	// part of it to h.
	if _, err := Buy(s, h2, c, at, big.NewInt(300)); err != nil {
		t.Fatalf("h2 buy: %v", err)
	}
	if err := TransferCredits(s, h2, c, h2, h, at, big.NewInt(120)); err != nil {
		t.Fatalf("transfer-in to matured holder: %v", err)
	}

	// A new, single, fresh cohort landed on h's cleared ledger.
	lots := getLotsRaw(s, c, h)
	if len(lots) != 1 || lots[0].count.Cmp(big.NewInt(120)) != 0 {
		t.Fatalf("expected one fresh cohort of 120 on h, got %v (%q)", lots, zvLotsStr(s, c, h))
	}
	if got := zvSumLotsRaw(s, c, h); got.Cmp(MaturingOf(s, c, h)) != 0 {
		t.Fatalf("Σlots=%s != maturing kBal=%s", got, MaturingOf(s, c, h))
	}
	if MaturingOf(s, c, h).Cmp(big.NewInt(120)) != 0 {
		t.Fatalf("h maturing=%s want 120", MaturingOf(s, c, h))
	}
	if MaturedOf(s, c, h).Cmp(big.NewInt(500)) != 0 {
		t.Fatalf("h matured=%s want 500 (transfer-in must not disturb it)", MaturedOf(s, c, h))
	}
	// The transferred-in cohort is FRESH (carries the sender's just-minted clock).
	if maturedNow(s, c, h, at) {
		t.Fatal("transferred-in fresh cohort must NOT read matured")
	}
	if lr := lotRateAt(lots[0].acq, at); lr != MaxExitTaxBps {
		t.Fatalf("transferred-in cohort rate=%d want full %d", lr, MaxExitTaxBps)
	}
	t.Logf("transfer-in on cleared ledger: new cohort {120,%d} fresh (rate %d), matured pile 500 intact", lots[0].acq, MaxExitTaxBps)
	zvAssertNoOrphanLots(t, s, "transfer-in on cleared ledger")
	zvAssertPositionsSumToSupply(t, s, c, "transfer-in on cleared ledger")
}

// The cohort MERGE and maturity together: same-block buys MERGE into one
// cohort; distinct-block buys stay separate; ALL of them mature to rate 0 and
// graduate cleanly. (NOTE: this tree has NO MaxLots=64 bound — cohorts merge
// only on identical acq; see the report. Maturity is correct at any count.)
func TestZZVerifyExpiry_MergeAndMaturity(t *testing.T) {
	const c, h = "hive:alice", "hive:bob"
	s := tbMarket(t, c)
	b1 := uint64(1_000_000)
	last := b1 + 5 // spread of distinct acquisition blocks
	T := last + tbWindow
	tbKeepPaid(t, s, c, b1, T)

	// Three buys at the SAME block b1 (must merge to one cohort of 300)...
	for i := 0; i < 3; i++ {
		if _, err := Buy(s, h, c, b1, big.NewInt(100)); err != nil {
			t.Fatalf("same-block buy %d: %v", i, err)
		}
	}
	// ...then one buy at each of b1+1..b1+5 (five more distinct cohorts).
	for blk := b1 + 1; blk <= last; blk++ {
		if _, err := Buy(s, h, c, blk, big.NewInt(50)); err != nil {
			t.Fatalf("distinct buy at %d: %v", blk, err)
		}
	}

	lots := getLotsRaw(s, c, h)
	if len(lots) != 6 {
		t.Fatalf("expected 6 cohorts (1 merged + 5 distinct), got %d: %q", len(lots), zvLotsStr(s, c, h))
	}
	wantTotal := big.NewInt(300 + 5*50) // 550
	if got := zvSumLotsRaw(s, c, h); got.Cmp(wantTotal) != 0 {
		t.Fatalf("Σlots=%s want %s", got, wantTotal)
	}
	if got := MaturingOf(s, c, h); got.Cmp(wantTotal) != 0 {
		t.Fatalf("maturing kBal=%s want %s (Σlots must equal it)", got, wantTotal)
	}

	// Past the window, EVERY cohort (merged and distinct) is rate 0.
	for _, l := range lots {
		if lr := lotRateAt(l.acq, T); lr != 0 {
			t.Fatalf("cohort acq=%d count=%s still rate %d at T", l.acq, l.count, lr)
		}
	}
	tax, _, topBps, err := maturingCohortTax(s, c, h, Supply(s, c), wantTotal, T)
	if err != nil {
		t.Fatalf("cohort tax: %v", err)
	}
	if tax.Sign() != 0 || topBps != 0 {
		t.Fatalf("cohort tax over all 6 cohorts = %s (topBps %d), MUST be 0", tax, topBps)
	}

	// Graduate: every cohort clears, matured == the whole 550, no leftover.
	if Graduate(s, c, h, T).Cmp(wantTotal) != 0 {
		t.Fatalf("graduate should move %s", wantTotal)
	}
	if zvHasLots(s, c, h) {
		t.Fatalf("ORPHAN: cohorts survived graduation: %q", zvLotsStr(s, c, h))
	}
	if MaturedOf(s, c, h).Cmp(wantTotal) != 0 {
		t.Fatalf("matured=%s want %s", MaturedOf(s, c, h), wantTotal)
	}
	t.Logf("merge+maturity: 3 same-block merged to 300, +5 distinct = 6 cohorts / %s tokens, all matured to 0, graduated clean", wantTotal)
	zvAssertNoOrphanLots(t, s, "after merge+maturity graduation")
	zvAssertPositionsSumToSupply(t, s, c, "after merge+maturity graduation")
}
