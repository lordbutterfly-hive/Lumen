package core

import (
	"math/big"
	"math/rand"
	"testing"
)

// exittax_test.go — the tax schedule (C-16) and the RULING F ceil form of the
// MONEY tax (RULING A: the tax is money, not a token burn), including the
// regression that buries the floor form forever and the superadditivity
// property that proves chunking cannot evade.

func TestExitTax_Schedule_C16(t *testing.T) {
	dt := ExitTaxDecayBlocks
	cases := []struct {
		name string
		held uint64
		want uint64
	}{
		{"fresh-pays-max-exactly", 0, MaxExitTaxBps},
		{"one-block-held", 1, 2000}, // ceil(2000·(Dt−1)/Dt) = 2000 still (rounds up)
		{"quarter-decayed", dt / 4, 1500},
		{"half-decayed", dt / 2, 1000},
		{"three-quarters-decayed", 3 * (dt / 4), 500},
		{"one-block-short-of-free", dt - 1, 1}, // ceil(2000·1/Dt) = 1 — never 0 early
		{"exactly-six-weeks-free", dt, 0},
		{"beyond-six-weeks-free", dt + 1, 0},
		{"way-beyond-free", 100 * dt, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ExitTaxBpsAt(c.held); got != c.want {
				t.Fatalf("ExitTaxBpsAt(%d) = %d, want %d", c.held, got, c.want)
			}
		})
	}
}

func TestExitTax_MonotoneNonIncreasing_Property(t *testing.T) {
	r := rand.New(rand.NewSource(7))
	for i := 0; i < 20000; i++ {
		h1 := uint64(r.Int63n(int64(ExitTaxDecayBlocks) * 2))
		h2 := h1 + uint64(r.Int63n(100000))
		t1, t2 := ExitTaxBpsAt(h1), ExitTaxBpsAt(h2)
		if t2 > t1 {
			t.Fatalf("C-16 monotonicity violated: tax(%d)=%d < tax(%d)=%d", h1, t1, h2, t2)
		}
		if t1 > MaxExitTaxBps {
			t.Fatalf("tax(%d)=%d exceeds MaxExitTaxBps", h1, t1)
		}
	}
}

func TestExitTaxOn_Ceil_RulingF(t *testing.T) {
	cases := []struct {
		name string
		p    int64
		bps  uint64
		want int64
	}{
		// THE FLOOR REGRESSION, money edition: floor(4·2000/10000) == 0 —
		// dust proceeds would exit tax-free under floor. ceil == 1. If this
		// test ever fails, someone reintroduced the floor form: STOP.
		{"dust-proceeds-tax-1-not-0", 4, 2000, 1},
		{"one-unit-proceeds", 1, 2000, 1},
		{"worked-example-683", 683, 2000, 137},  // ceil(136.6) — the §worked-example tax
		{"one-token-slice-116", 116, 2000, 24},  // ceil(23.2) — the old 100%-burn wart now pays 20.7%
		{"exact-division", 10_000, 2000, 2_000}, // 20% of 10 HBD exactly
		{"midpoint-2677", 2677, 1000, 268},      // ceil(267.7)
		{"zero-proceeds-zero-tax", 0, 2000, 0},
		{"zero-bps-zero-tax", 1_000_000, 0, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ExitTaxOn(big.NewInt(c.p), c.bps)
			if got.Cmp(big.NewInt(c.want)) != 0 {
				t.Fatalf("ExitTaxOn(%d, %d) = %s, want %d", c.p, c.bps, got, c.want)
			}
		})
	}
}

// ceil never yields 0 for p >= 1 and bps >= 1, and never exceeds p for
// bps <= 10000 — so net = p − tax − fee can never be driven negative by the
// tax alone (sell.go's file-header proof leans on this).
func TestExitTaxOn_Bounds_Property(t *testing.T) {
	r := rand.New(rand.NewSource(8))
	for i := 0; i < 20000; i++ {
		p := big.NewInt(r.Int63n(1_000_000) + 1)
		bps := uint64(r.Int63n(10000) + 1)
		x := ExitTaxOn(p, bps)
		if x.Sign() < 1 {
			t.Fatalf("ExitTaxOn(%s,%d) = %s — ceil must be >= 1 here", p, bps, x)
		}
		if x.Cmp(p) > 0 {
			t.Fatalf("ExitTaxOn(%s,%d) = %s exceeds the proceeds", p, bps, x)
		}
		// single ceil: 0 <= x·10000 − p·bps < 10000.
		e := new(big.Int).Sub(new(big.Int).Mul(x, big.NewInt(10000)), new(big.Int).Mul(p, new(big.Int).SetUint64(bps)))
		if e.Sign() < 0 || e.Cmp(big.NewInt(10000)) >= 0 {
			t.Fatalf("ExitTaxOn(%s,%d) not a single ceil: residue %s", p, bps, e)
		}
	}
}

// Superadditivity — the anti-evasion theorem, REQUIRED BY THE TASK ("chunking
// still over-pays — assert it"): with the curve leg exactly path-independent
// (curve.go L4: chunked proceeds telescope to EXACTLY the whole-sell
// proceeds), splitting a sell into chunks pays weakly MORE total tax, never
// less (Σ ceil >= ceil Σ). Asserted against the REAL curve slices, not
// synthetic numbers, so the L4-equality premise is exercised too.
func TestExitTaxOn_ChunkingNeverEvades_Property(t *testing.T) {
	r := rand.New(rand.NewSource(9))
	for i := 0; i < 5000; i++ {
		S := big.NewInt(r.Int63n(100_000) + 200)
		total := r.Int63n(150) + 1
		bps := uint64(r.Int63n(int64(MaxExitTaxBps)) + 1)

		whole, err := SellProceeds(S, big.NewInt(total))
		if err != nil {
			t.Fatal(err)
		}
		wholeTax := ExitTaxOn(whole, bps)

		sumP := mZero()
		sumTax := mZero()
		cur := new(big.Int).Set(S)
		remaining := total
		for remaining > 0 {
			c := r.Int63n(remaining) + 1
			p, err := SellProceeds(cur, big.NewInt(c))
			if err != nil {
				t.Fatal(err)
			}
			sumP = mAdd(sumP, p)
			sumTax = mAdd(sumTax, ExitTaxOn(p, bps))
			cur.Sub(cur, big.NewInt(c))
			remaining -= c
		}
		// Premise: the chunked proceeds telescope exactly (L4 equality).
		if sumP.Cmp(whole) != 0 {
			t.Fatalf("L4 equality broke: Σ chunk proceeds %s != whole %s", sumP, whole)
		}
		// The theorem: chunked tax >= whole tax, always.
		if sumTax.Cmp(wholeTax) < 0 {
			t.Fatalf("chunking evaded tax: Σ chunk tax %s < whole tax %s (S=%s total=%d bps=%d)",
				sumTax, wholeTax, S, total, bps)
		}
	}
}

// ---------------------------------------------------------------------------
// RULING K1 (2026-07-22) — the realized-gain cap (RULING J1) is REVERSED.
// ExitTaxAssessed and exitTaxEpisode are DELETED with kBasis and the sell-
// episode accumulators; the tax is now EXACTLY ExitTaxOn(gross, τ) at every
// value-out door (curve Sell in sell_test.go, wind-down Refund in
// refund_test.go). The un-splittability the cap-era code chased with per-
// position episode accounting is now a free consequence of ceil
// superadditivity + curve-leg path-independence — proven, on the REAL curve,
// by TestExitTaxOn_ChunkingNeverEvades_Property above, and end-to-end through
// Sell by TestSell_ChunkingCannotEvade (sell_test.go). Nothing here replaces
// the deleted cap tests: there is no cap left to test.
// ---------------------------------------------------------------------------
