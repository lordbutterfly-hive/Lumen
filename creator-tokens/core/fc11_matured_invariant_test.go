package core

import (
	"math/big"
	"math/rand"
	"testing"
)

// fc11_matured_invariant_test.go — F-C11 defense-in-depth.
//
// setMatured already PANICS past MaxCap (matured.go:111) — the last line of
// defense. This fuzz pins the SYSTEM invariant that no matured-write path can
// ever push the matured bucket past what it must respect:
//
//	0 ≤ MaturedOf(h) ≤ totalBalance(h)           (matured is a SUBSET of a holder's own credits)
//	Σ_h MaturedOf(h) ≤ Supply ≤ MaxCap           (the matured bucket is a subset of supply)
//
// checked after EVERY matured-write path: Buy's graduate-then-credit, an explicit
// graduate(), and TransferMatured (which writes both sides' matured buckets). It
// holds by construction today; this exists so a future change to any of those
// paths that let matured drift above supply fails here instead of silently
// overstating a holder's tradable balance on the shared magi-market tables.
func TestMatured_NeverExceedsSupplyOnAnyWritePath(t *testing.T) {
	r := rand.New(rand.NewSource(0xC11))
	const c = "hive:alice"
	holders := []string{"hive:bob", "hive:carol", "hive:dave"}

	for iter := 0; iter < 2000; iter++ {
		s := tbMarket(t, c)
		t0 := uint64(1_000_000)

		assertInv := func(when string) {
			t.Helper()
			supply := Supply(s, c)
			if supply.Sign() < 0 || supply.Cmp(big.NewInt(MaxCap)) > 0 {
				t.Fatalf("iter %d %s: supply %s outside [0, MaxCap]", iter, when, supply)
			}
			sum := big.NewInt(0)
			for _, h := range holders {
				m := MaturedOf(s, c, h)
				if m.Sign() < 0 {
					t.Fatalf("iter %d %s: %s matured %s is negative", iter, when, h, m)
				}
				if tot := totalBalance(s, c, h); m.Cmp(tot) > 0 {
					t.Fatalf("iter %d %s: %s matured %s > its totalBalance %s (matured must be a subset of the holder's own credits)", iter, when, h, m, tot)
				}
				sum.Add(sum, m)
			}
			if sum.Cmp(supply) > 0 {
				t.Fatalf("iter %d %s: Σmatured %s > supply %s (the matured bucket escaped supply)", iter, when, sum, supply)
			}
		}

		// PATH 1 — Buy (graduate-then-credit). Amounts span dust..100k: Buy prices
		// on the quadratic curve, so a MaxCap-scale quantity would overflow the
		// payable-HBD ceiling before it ever tested the matured invariant. 100k is
		// well inside the payable range and still exercises the graduate/credit
		// split; Buy is used (not creditInflow) precisely because it also moves
		// Supply, so Σmatured ≤ Supply stays a meaningful check.
		var total int64
		for _, h := range holders {
			n := r.Int63n(100_000) + 1
			if total+n >= MaxCap {
				break
			}
			if _, err := Buy(s, h, c, t0, big.NewInt(n)); err != nil {
				t.Fatalf("iter %d buy %s: %v", iter, h, err)
			}
			total += n
			assertInv("after buy")
		}

		// PATH 2 — explicit graduate() once the window has fully elapsed.
		at := t0 + tbWindow
		tbKeepPaid(t, s, c, t0, at)
		for _, h := range holders {
			graduate(s, c, h, at)
			assertInv("after graduate")
		}

		// PATH 3 — TransferMatured (writes both from's and to's matured buckets).
		from, to := holders[r.Intn(len(holders))], holders[r.Intn(len(holders))]
		if from != to {
			if bal := BalanceOf(s, c, from); bal.Sign() > 0 {
				amt := new(big.Int).Rand(r, bal) // [0, bal)
				if amt.Sign() > 0 {
					// self-spender: the owner moves their own matured tokens.
					if err := TransferMatured(s, c, from, to, from, amt); err != nil {
						t.Fatalf("iter %d TransferMatured %s->%s (%s): %v", iter, from, to, amt, err)
					}
					assertInv("after TransferMatured")
				}
			}
		}
	}
}
