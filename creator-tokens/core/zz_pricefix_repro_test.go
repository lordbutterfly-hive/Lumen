package core

import (
	"math/big"
	"testing"
)

// zz_pricefix_repro_test.go — CANDIDATE-FIX design harness (scratch only, never
// shipped). Establishes the BEFORE numbers for PRICE-1 (transfer launder) and
// PRICE-2 (mixed-position bundling), so the same measurements can be re-run
// after a fix to prove both doors close and path-independence holds.

func pfMarket(t *testing.T, s *MemStore, c string, activeUntil uint64) {
	t.Helper()
	if err := Register(s, c, c, 1000, 1000, MaxCap); err != nil {
		t.Fatalf("Register(%s): %v", c, err)
	}
	// Keep the market ACTIVE through activeUntil so Buy is permitted at the
	// distant blocks the maturity window forces.
	setU64(s, kPaidUntil(c), activeUntil+SubscriptionPeriod)
}

func pfBuy(t *testing.T, s *MemStore, who, c string, block uint64, n int64) {
	t.Helper()
	if _, err := Buy(s, who, c, block, big.NewInt(n)); err != nil {
		t.Fatalf("Buy(%s,%d@%d): %v", who, n, block, err)
	}
}

// ---------------------------------------------------------------------------
// PRICE-1 — the transfer launder. An aged pile that never graduated sits in the
// MATURING bucket with an old clock; fresh tokens transferred in re-average the
// clock DOWN, so the whole position sells at the diluted blended rate.
// ---------------------------------------------------------------------------
func TestPFRepro_PRICE1_TransferLaunder(t *testing.T) {
	const c = "alice"
	const N, M = int64(4000), int64(400)
	t0 := uint64(2_000_000)
	t1 := t0 + ExitTaxDecayBlocks // whale's N fully matured (rate 0) at t1

	s := NewMemStore()
	pfMarket(t, s, c, t1)

	// whale buys the aged pile at t0; alt buys the fresh slice at t1.
	pfBuy(t, s, "whale", c, t0, N)
	pfBuy(t, s, "alt", c, t1, M)

	// alt transfers the fresh M into whale's aged pile. No graduate on transfer
	// (F-C1), so the clocks blend.
	if err := TransferCredits(s, "alt", c, "alt", "whale", t1, big.NewInt(M)); err != nil {
		t.Fatalf("TransferCredits: %v", err)
	}

	// whale sells the whole blended position N+M.
	q, err := QuoteSell(s, "whale", c, t1, big.NewInt(N+M))
	if err != nil {
		t.Fatalf("QuoteSell: %v", err)
	}
	t.Logf("PRICE-1 LAUNDER: held=%d taxBps=%d gross=%s taxableGross=%s tax=%s",
		q.HeldBlocks, q.TaxBps, q.Gross, q.TaxableGross, q.Tax)

	// The INTENDED reference: the fresh M owes the full 2000 bps on the top-M
	// curve slice; the matured N owes 0. Computed directly off the curve at the
	// sell supply.
	supply := getMoney(s, kSupply(c))
	topM, err := SellProceeds(supply, big.NewInt(M))
	if err != nil {
		t.Fatal(err)
	}
	intendedTax := ExitTaxOn(topM, MaxExitTaxBps)
	t.Logf("PRICE-1 INTENDED (fresh M @1500bps on top slice): topMgross=%s intendedTax=%s", topM, intendedTax)
	t.Logf("PRICE-1 UNDER-COLLECTION: shipped tax=%s vs intended=%s (avoided=%s)",
		q.Tax, intendedTax, new(big.Int).Sub(intendedTax, q.Tax))
}

// ---------------------------------------------------------------------------
// PRICE-2 — bundling a mixed matured+maturing position. Same end state, same
// gross, different tax depending on whether the fresh slice is sold alone (the
// "split plan", dear top slice) or bundled with the matured pile (pro-rata by
// count dilutes it to the average price).
// ---------------------------------------------------------------------------
func TestPFRepro_PRICE2_Bundling(t *testing.T) {
	const N, M = int64(4000), int64(400)
	t0 := uint64(2_000_000)
	t1 := t0 + ExitTaxDecayBlocks

	// Build the mixed position: whale buys N at t0, GRADUATES it into matured at
	// t1, then buys the fresh M at t1. Zero TransferCredits anywhere.
	build := func(t *testing.T) (*MemStore, string, uint64) {
		const c = "alice"
		s := NewMemStore()
		pfMarket(t, s, c, t1)
		pfBuy(t, s, "whale", c, t0, N)
		if moved := Graduate(s, c, "whale", t1); moved.Sign() == 0 {
			t.Fatalf("Graduate moved nothing; N should be matured")
		}
		pfBuy(t, s, "whale", c, t1, M) // fresh maturing on top of matured N
		return s, c, t1
	}

	// SPLIT PLAN: sell the fresh M first (top slice, taxed), then the matured N.
	sSplit, c, blk := build(t)
	qM, err := QuoteSell(sSplit, "whale", c, blk, big.NewInt(M))
	if err != nil {
		t.Fatal(err)
	}
	rM, err := Sell(sSplit, "whale", c, blk, big.NewInt(M))
	if err != nil {
		t.Fatal(err)
	}
	rN, err := Sell(sSplit, "whale", c, blk, big.NewInt(N))
	if err != nil {
		t.Fatal(err)
	}
	splitTax := new(big.Int).Add(rM.Tax, rN.Tax)
	t.Logf("PRICE-2 SPLIT : sellM(bps=%d tax=%s taxable=%s) + sellN(bps=%d tax=%s) => total tax=%s",
		rM.TaxBps, rM.Tax, rM.TaxableGross, rN.TaxBps, rN.Tax, splitTax)
	_ = qM

	// BUNDLED PLAN: sell N+M in a single call. Identical end state, identical gross.
	sBun, c2, blk2 := build(t)
	rAll, err := Sell(sBun, "whale", c2, blk2, big.NewInt(N+M))
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("PRICE-2 BUNDLE: sell(N+M) bps=%d gross=%s taxableGross=%s tax=%s",
		rAll.TaxBps, rAll.Gross, rAll.TaxableGross, rAll.Tax)

	spread := new(big.Int).Sub(splitTax, rAll.Tax)
	t.Logf("PRICE-2 SPREAD: split tax=%s vs bundled tax=%s => under-collection=%s (%.1f%% of split)",
		splitTax, rAll.Tax, spread, 100*f2(spread)/f2(splitTax))
}

func f2(x *big.Int) float64 { f, _ := new(big.Float).SetInt(x).Float64(); return f }
