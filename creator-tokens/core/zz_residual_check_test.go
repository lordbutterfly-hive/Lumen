package core

import (
	"math/big"
	"testing"
)

// Is the "KNOWN RESIDUAL" a real money leak, or only a stale DISPLAY rate?
func TestZZResidual_IsItMoneyOrDisplay(t *testing.T) {
	const c, whale, honest = "hive:resid2", "hive:whale2", "hive:honest2"
	const P, F = 1_000_000, 1_000
	const t0 = 1_000_000
	at := uint64(t0) + ExitTaxDecayBlocks - 1

	// Launderer: huge aged pile + fresh slice, sells the fresh slice.
	s := NewMemStore()
	rgMarket(t, s, c, t0)
	if _, err := Buy(s, whale, c, t0, big.NewInt(P)); err != nil { t.Fatal(err) }
	if _, err := Buy(s, whale, c, at, big.NewInt(F)); err != nil { t.Fatal(err) }
	q, err := QuoteSell(s, whale, c, at, big.NewInt(F))
	if err != nil { t.Fatal(err) }

	// Honest control: same market, same supply, buys the SAME fresh slice, no pile.
	s2 := NewMemStore()
	rgMarket(t, s2, c, t0)
	if _, err := Buy(s2, honest, c, t0, big.NewInt(P)); err != nil { t.Fatal(err) }
	if _, err := Buy(s2, honest, c, at, big.NewInt(F)); err != nil { t.Fatal(err) }
	// sell the fresh slice from a position whose pile is the SAME age: identical shape,
	// so any difference is the laundering effect, not a different curve position.
	q2, err := QuoteSell(s2, honest, c, at, big.NewInt(F))
	if err != nil { t.Fatal(err) }

	// The true honest charge for a 0-block-old slice: full rate on its own taxable base.
	full := ExitTaxOn(q.TaxableGross, MaxExitTaxBps)

	t.Logf("launderer: gross=%s taxableGross=%s TaxBps(display)=%d TAX=%s",
		q.Gross, q.TaxableGross, q.TaxBps, q.Tax)
	t.Logf("full-rate on the same taxable base (1500 bps) = %s", full)
	if q.Tax.Cmp(full) < 0 {
		diff := new(big.Int).Sub(full, q.Tax)
		pct := 100 * (1 - float64(q.Tax.Int64())/float64(full.Int64()))
		t.Errorf("MONEY LEAK: actual tax %s < full-rate %s (avoided %s = %.2f%%)", q.Tax, full, diff, pct)
	} else {
		t.Logf("NO MONEY LEAK: actual tax %s >= full-rate %s. The residual is a STALE DISPLAY rate only.", q.Tax, full)
	}
	_ = q2
}
