package core

import (
	"math/big"
	"math/rand"
	"testing"
)

func u(n int64) *big.Int { return big.NewInt(n) }

// D4: the unit area equals the RULING I area at every whole boundary, and the
// TWAP feed reproduces every pre-v6 observation exactly.
func TestV6Curve_WholeBoundariesAreTheOldCurve(t *testing.T) {
	for S := int64(0); S <= 5000; S++ {
		if Area(u(S*TokenScale)).Cmp(AreaTokens(u(S))) != 0 {
			t.Fatalf("Area(%d units) != AreaTokens(%d)", S*TokenScale, S)
		}
		old := curveSpotRateIn(u(S), curveBase, curveLin, curveQuad, curveDen)
		if SpotRate(u(S * TokenScale)).Cmp(old) != 0 {
			t.Fatalf("SpotRate at boundary %d differs from the old feed", S)
		}
		if S > 0 && SpotRate(u((S-1)*TokenScale+1)).Cmp(old) != 0 {
			t.Fatalf("SpotRate inside token %d must be that token's price", S)
		}
	}
}

// Monotone, one floor per partial token, and the partial never exceeds the
// linear share of the token being filled.
func TestV6Curve_PartialTokenIsLinearAndFloored(t *testing.T) {
	for S := int64(0); S <= 300; S++ {
		base := AreaTokens(u(S))
		step := new(big.Int).Sub(AreaTokens(u(S+1)), base)
		prev := new(big.Int).Set(base)
		for r := int64(1); r <= TokenScale; r++ {
			a := Area(u(S*TokenScale + r))
			if a.Cmp(prev) < 0 {
				t.Fatalf("Area not monotone at S=%d r=%d", S, r)
			}
			exact := new(big.Int).Mul(step, u(r))
			exact.Div(exact, unitsScale)
			exact.Add(exact, base)
			if a.Cmp(exact) != 0 {
				t.Fatalf("Area(%d,%d) = %s, want %s", S, r, a, exact)
			}
			prev = a
		}
		if prev.Cmp(AreaTokens(u(S+1))) != 0 {
			t.Fatalf("the 100th unit does not land on the next whole area at S=%d", S)
		}
	}
}

// Path independence in units: any split of a buy or a sell costs the same in
// total, so slicing is never cheaper on the curve (fees are tested elsewhere).
func TestV6Curve_PathIndependentUnderRandomSplits(t *testing.T) {
	rng := rand.New(rand.NewSource(6))
	for trial := 0; trial < 2000; trial++ {
		start := u(rng.Int63n(500_000))
		total := u(1 + rng.Int63n(50_000))
		whole := BuyCost(start, total)
		sum, at := mZero(), new(big.Int).Set(start)
		left := new(big.Int).Set(total)
		for left.Sign() > 0 {
			piece := u(1 + rng.Int63n(left.Int64()))
			sum.Add(sum, BuyCost(at, piece))
			at.Add(at, piece)
			left.Sub(left, piece)
		}
		if sum.Cmp(whole) != 0 {
			t.Fatalf("buy split %s != whole %s", sum, whole)
		}
		back, err := SellProceeds(at, total)
		if err != nil || back.Cmp(whole) != 0 {
			t.Fatalf("sell back %s != buy cost %s (%v)", back, whole, err)
		}
	}
	if _, err := SellProceeds(u(50), u(51)); err == nil {
		t.Fatal("selling more units than exist must error")
	}
}

// The smallest trades on the smallest market, the numbers the dust rules are built on.
func TestV6Curve_DustNumbers(t *testing.T) {
	t.Logf("first unit on an empty market costs %s base units; first whole token %s", BuyCost(u(0), u(1)), BuyCost(u(0), u(TokenScale)))
	if BuyCost(u(0), u(TokenScale)).Cmp(u(1007)) != 0 {
		t.Fatal("first whole token must still cost 1007 (RULING H intercept)")
	}
	if BuyCost(u(0), u(1)).Cmp(u(10)) != 0 {
		t.Fatalf("first unit costs %s, want floor(1007/100) = 10", BuyCost(u(0), u(1)))
	}
	if Area(u(0)).Sign() != 0 || SpotRate(u(0)).Sign() != 0 {
		t.Fatal("empty market: area 0, rate 0")
	}
}
