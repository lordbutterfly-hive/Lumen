package core

import (
	"math/big"
	"math/rand"
	"testing"
)

// curve_test.go — the curve primitive under RULING I (BasePrice + 25%
// quadratic term, single-denominator exact-area accounting): exact values at
// the compiled calibration, the five lemmas L1-L5 as EQUALITIES (curve.go:
// trade totals ARE area steps, so chunk/round-trip identities telescope
// exactly), the bounded-parity-dust property, and the GOVERNING THEOREM
// (fresh buyer never profits at a flat pro-rata wind-down) as a property
// over both the compiled constants and random parameterisations. The
// parametrized *In forms are fuzzed across many (base, lin, quad, den)
// tuples — the exported API binds the compile-time constants and is tested
// at those.

func cvB(v int64) *big.Int { return big.NewInt(v) }

// ---------------------------------------------------------------------------
// T(S) and P(S) exactness.
// ---------------------------------------------------------------------------

func TestCurve_TriangularExact(t *testing.T) {
	cases := []struct{ s, want int64 }{
		{0, 0}, {1, 1}, {2, 3}, {3, 6}, {4, 10}, {10, 55}, {11, 66},
		{14, 105}, {15, 120}, {100, 5050}, {1_000_000, 500_000_500_000},
	}
	for _, c := range cases {
		if got := curveTri(cvB(c.s)); got.Cmp(cvB(c.want)) != 0 {
			t.Errorf("T(%d) = %s, want %d", c.s, got, c.want)
		}
	}
	// Exactness at scale: T(S) for S = MaxCap (1e9) = 500000000500000000 —
	// no rounding, no overflow (big.Int).
	want, _ := new(big.Int).SetString("500000000500000000", 10)
	if got := curveTri(cvB(MaxCap)); got.Cmp(want) != 0 {
		t.Errorf("T(MaxCap) = %s, want %s", got, want)
	}
}

// P(S) = S(S+1)(2S+1)/6 must be EXACT for every S — the /6 must never round
// (RULING I: "S(S+1)(2S+1) is always divisible by 6"). Checked against known
// values AND by re-multiplying: P(S)·6 == S(S+1)(2S+1) with zero remainder,
// so a silently-flooring implementation cannot pass.
func TestCurve_PyramidalExact(t *testing.T) {
	cases := []struct{ s, want int64 }{
		{0, 0}, {1, 1}, {2, 5}, {3, 14}, {4, 30}, {5, 55}, {10, 385},
		{11, 506}, {20, 2870}, {30, 9455}, {100, 338_350}, {1000, 333_833_500},
	}
	for _, c := range cases {
		if got := curvePyr(cvB(c.s)); got.Cmp(cvB(c.want)) != 0 {
			t.Errorf("P(%d) = %s, want %d", c.s, got, c.want)
		}
	}
	// Exact-division property across a dense small range + big samples.
	r := rand.New(rand.NewSource(6))
	check := func(s *big.Int) {
		p := curvePyr(s)
		back := new(big.Int).Mul(p, big.NewInt(6))
		prod := new(big.Int).Add(s, big.NewInt(1))
		prod.Mul(prod, s)
		two := new(big.Int).Lsh(s, 1)
		two.Add(two, big.NewInt(1))
		prod.Mul(prod, two)
		if back.Cmp(prod) != 0 {
			t.Fatalf("P(%s)·6 = %s != S(S+1)(2S+1) = %s — the /6 rounded", s, back, prod)
		}
	}
	for s := int64(0); s <= 1000; s++ {
		check(cvB(s))
	}
	for i := 0; i < 200; i++ {
		check(cvB(r.Int63n(MaxCap)))
	}
}

// ---------------------------------------------------------------------------
// Exact values at the compiled RULING-I calibration.
// ---------------------------------------------------------------------------

func TestCurve_ExportedValues_RulingI(t *testing.T) {
	// These expectations are computed by hand at the RULING-I parameters
	// (BasePrice=1000, a=63/8, b=21/8000 — params.go). If calibration ever
	// changes again before deploy, the EXPECTATIONS here must be recomputed —
	// the lemma/property tests below are calibration-independent and must
	// keep passing untouched. Cases with NONZERO division remainder are
	// pinned deliberately (RULING H problem 2's lesson: at an effectively
	// integer slope every rounding assertion was vacuous).
	if BasePrice != 1000 || CurveLinNum != 63000 || CurveQuadNum != 21 || CurveDenom != 8000 {
		t.Fatalf("calibration changed (base=%d lin=%d quad=%d den=%d) — recompute these expectations; do NOT skip",
			BasePrice, CurveLinNum, CurveQuadNum, CurveDenom)
	}
	// area(10) = 10·1000 + floor((63000·55 + 21·385)/8000)
	//          = 10000 + floor(3,473,085/8000 = 434.135…) = 10,434.
	// The floor is LIVE (ceil would give 10,435).
	if got := Area(cvB(10)); got.Cmp(cvB(10_434)) != 0 {
		t.Errorf("Area(10) = %s, want 10434 (floor live: ceil would give 10435)", got)
	}
	// area(15) = 15000 + floor((63000·120 + 21·1240)/8000 = 948.255) = 15,948.
	if got := Area(cvB(15)); got.Cmp(cvB(15_948)) != 0 {
		t.Errorf("Area(15) = %s, want 15948", got)
	}
	// THE RULING-I ANCHOR: area(1000) = 5,817,750 base units = 5,817.750 HBD
	// — the reserve at S=1,000 the ruling verifies by name.
	if got := Area(cvB(1000)); got.Cmp(cvB(5_817_750)) != 0 {
		t.Errorf("Area(1000) = %s, want 5817750 (RULING I: 5,817.750 HBD at S=1,000)", got)
	}
	// buyCost(10,5) = area(15) − area(10) = 15948 − 10434 = 5514 — the EXACT
	// area step (L1).
	if got := BuyCost(cvB(10), cvB(5)); got.Cmp(cvB(5514)) != 0 {
		t.Errorf("BuyCost(10,5) = %s, want 5514 (= area(15) − area(10))", got)
	}
	// buyCost(0,10) = area(10) = 10434; the first token alone costs
	// area(1) = 1000 + floor(63021/8000) = 1007 — BasePrice holds the floor
	// (RULING H: no dust-priced first buy; the old zero-intercept curve
	// priced it at 11 units).
	if got := BuyCost(cvB(0), cvB(10)); got.Cmp(cvB(10_434)) != 0 {
		t.Errorf("BuyCost(0,10) = %s, want 10434 (= area(10) exactly)", got)
	}
	if got := BuyCost(cvB(0), cvB(1)); got.Cmp(cvB(1007)) != 0 {
		t.Errorf("BuyCost(0,1) = %s, want 1007 (BasePrice 1000 + floor(63021/8000) = 7)", got)
	}
	// sellProceeds(15,4) = area(15) − area(11) = 15948 − 11521 = 4427.
	p, err := SellProceeds(cvB(15), cvB(4))
	if err != nil {
		t.Fatalf("SellProceeds(15,4): %v", err)
	}
	if p.Cmp(cvB(4427)) != 0 {
		t.Errorf("SellProceeds(15,4) = %s, want 4427 (= area(15) − area(11))", p)
	}
	// sellProceeds(15,5) = area(15) − area(10) = 5514 == buyCost(10,5) — L5's
	// EQUALITY, live: the same slice costs and returns the same amount, so a
	// round trip is exactly zero-sum on the curve leg (fees/tax make it a
	// loss).
	p5, err := SellProceeds(cvB(15), cvB(5))
	if err != nil {
		t.Fatalf("SellProceeds(15,5): %v", err)
	}
	if p5.Cmp(cvB(5514)) != 0 {
		t.Errorf("SellProceeds(15,5) = %s, want 5514 (= BuyCost(10,5) — L5 equality)", p5)
	}
	// spot(10) = 1000 + floor((63000·10 + 21·100)/8000 = 79.0125) = 1079.
	if got := SpotRate(cvB(10)); got.Cmp(cvB(1079)) != 0 {
		t.Errorf("SpotRate(10) = %s, want 1079", got)
	}
	// NO ZERO OR NEGATIVE MARGINAL PRICE in the first 50 tokens (RULING I's
	// verified property) — and in fact every marginal step >= BasePrice.
	prev := Area(cvB(0))
	for i := int64(1); i <= 50; i++ {
		cur := Area(cvB(i))
		step := new(big.Int).Sub(cur, prev)
		if step.Cmp(cvB(BasePrice)) < 0 {
			t.Fatalf("marginal price of token %d = %s < BasePrice %d — RULING I's positivity check broken", i, step, BasePrice)
		}
		prev = cur
	}
	// Zero edges.
	if got := Area(cvB(0)); got.Sign() != 0 {
		t.Errorf("Area(0) = %s, want 0", got)
	}
	if got := BuyCost(cvB(7), cvB(0)); got.Sign() != 0 {
		t.Errorf("BuyCost(S,0) = %s, want 0", got)
	}
	p0, err := SellProceeds(cvB(7), cvB(0))
	if err != nil || p0.Sign() != 0 {
		t.Errorf("SellProceeds(S,0) = %s (err %v), want 0", p0, err)
	}
	if got := SpotRate(cvB(0)); got.Sign() != 0 {
		t.Errorf("SpotRate(0) = %s, want 0 (no supply, no traded rate — convention kept deliberately despite BasePrice)", got)
	}
}

// cvExactNum returns the exact rational area numerator over `den`:
// base·den·S + lin·T(S) + quad·P(S) — area(S) == floor(cvExactNum/den) with
// the base term exactly divisible, so this is the reference every dust bound
// measures against.
func cvExactNum(S, base, lin, quad, den *big.Int) *big.Int {
	num := new(big.Int).Mul(base, den)
	num.Mul(num, S)
	num.Add(num, new(big.Int).Mul(lin, curveTri(S)))
	return num.Add(num, new(big.Int).Mul(quad, curvePyr(S)))
}

// TestCurve_RoundingIsExercised_CompiledCalibration — RULING H problem 2's
// regression guard, carried onto RULING I. The live rounding site is the
// single floor over CurveDenom, and its footprint on trade totals is the
// PARITY dust: buyCost/sellProceeds sit within ±1 unit of the exact rational
// slice value, on the side the two area endpoints' remainders decide. This
// test walks a deterministic tape through the EXPORTED (constant-bound) API
// and requires:
//   - the dust is bounded: |total·den − Δnum| < den always;
//   - BOTH signs actually occur, each on a nontrivial fraction of trades
//     (an always-ceil implementation has zero below-exact cases, an
//     always-floor has zero above-exact, and a numerator always divisible
//     by den — the mutation-invisibility bug — has zero of either and fails
//     the same floors);
//   - L5's equality holds on every trade: the same slice sells for exactly
//     what it cost — the sharpest single discriminator between exact-area
//     and any independent-rounding scheme (the recheck: independent per-leg
//     rounding fails L5 in 65% of cases).
func TestCurve_RoundingIsExercised_CompiledCalibration(t *testing.T) {
	r := rand.New(rand.NewSource(2026_07_21))
	base, lin, quad, den := cvB(BasePrice), cvB(CurveLinNum), cvB(CurveQuadNum), cvB(CurveDenom)
	trades, below, above, exact := 0, 0, 0, 0
	for i := 0; i < 2000; i++ {
		S := big.NewInt(r.Int63n(5000))
		n := big.NewInt(r.Int63n(200) + 1)
		exactNum := new(big.Int).Sub(
			cvExactNum(mAdd(S, n), base, lin, quad, den),
			cvExactNum(S, base, lin, quad, den),
		)
		bc := BuyCost(S, n)
		sp, err := SellProceeds(mAdd(S, n), n)
		if err != nil {
			t.Fatal(err)
		}
		// L5 equality — same slice, same amount, every trade.
		if sp.Cmp(bc) != 0 {
			t.Fatalf("L5 EQUALITY violated: sellProceeds(S+n,n)=%s != buyCost(S,n)=%s (S=%s n=%s)", sp, bc, S, n)
		}
		// Parity dust: bc·den − Δnum ∈ (−den, den).
		dust := new(big.Int).Sub(new(big.Int).Mul(bc, den), exactNum)
		if a := new(big.Int).Abs(dust); a.Cmp(den) >= 0 {
			t.Fatalf("parity dust out of range: bc·den − Δnum = %s, |dust| must be < den=%s (S=%s n=%s)", dust, den, S, n)
		}
		trades++
		switch dust.Sign() {
		case -1:
			below++ // buyer paid below-exact (the endpoint remainders gifted the fraction)
		case 1:
			above++ // buyer paid above-exact
		default:
			exact++
		}
	}
	// The numerator mod 8000 is nonzero on nearly every endpoint, so both
	// parities must occur on a substantial share. Floor of one eighth leaves
	// margin while staying unsatisfiable by always-ceil (below==0),
	// always-floor (above==0), or an exactly-divisible numerator (both 0).
	if below*8 < trades || above*8 < trades {
		t.Fatalf("ROUNDING UNEXERCISED at compiled calibration: below-exact %d, above-exact %d, exact %d of %d — "+
			"both parities must occur; zero on either side means the trade totals are not exact area steps",
			below, above, exact, trades)
	}
	t.Logf("parity dust exercised: %d/%d below-exact, %d/%d above-exact; L5 equality held on every trade",
		below, trades, above, trades)
}

func TestCurve_SellProceeds_KExceedsSupplyRejected(t *testing.T) {
	if _, err := SellProceeds(cvB(5), cvB(6)); errSymbol(err) != ErrArith {
		t.Fatalf("SellProceeds(5,6): err = %v, want %s (never garbage on k>S)", err, ErrArith)
	}
}

// ---------------------------------------------------------------------------
// The lemmas as properties — EQUALITIES under exact-area accounting — fuzzed
// across (base, lin, quad, den, S, n, k). Deterministic seed so a failure is
// reproducible.
// ---------------------------------------------------------------------------

// cvRandBig returns a random value mixing small and large magnitudes so both
// dust and beyond-2^64 regions are exercised.
func cvRandBig(r *rand.Rand) *big.Int {
	v := new(big.Int)
	switch r.Intn(3) {
	case 0: // small — the rounding-edge-rich region
		v.SetInt64(r.Int63n(20))
	case 1: // medium
		v.SetInt64(r.Int63n(1_000_000))
	default: // large — force multi-word big.Int paths
		v.SetInt64(r.Int63())
		v.Mul(v, big.NewInt(int64(r.Int63n(1_000)+1)))
	}
	return v
}

// cvRandCalib draws a random curve parameterisation: base >= 0, lin >= 0,
// quad >= 0 (not all zero), den >= 1 — the whole nonneg-blend family the
// governing theorem covers (price ~ i^p for p in {0,1,2} and positive
// blends).
func cvRandCalib(r *rand.Rand) (base, lin, quad, den *big.Int) {
	base = cvRandBig(r)
	lin = cvRandBig(r)
	quad = cvRandBig(r)
	if base.Sign() == 0 && lin.Sign() == 0 && quad.Sign() == 0 {
		lin = big.NewInt(1)
	}
	den = new(big.Int).Add(cvRandBig(r), big.NewInt(1)) // >= 1
	return
}

func TestCurve_Lemmas_Property(t *testing.T) {
	r := rand.New(rand.NewSource(42))
	for i := 0; i < 5000; i++ {
		base, lin, quad, den := cvRandCalib(r)
		S := cvRandBig(r)
		n := cvRandBig(r)
		n1 := new(big.Int).Rsh(n, 1) // floor(n/2)
		n2 := new(big.Int).Sub(n, n1)

		Sn := mAdd(S, n)

		// C-1 / L1 (EQUALITY): buyCost(S,n) == area(S+n) − area(S).
		bc := curveBuyCostIn(S, n, base, lin, quad, den)
		areaStep := new(big.Int).Sub(curveAreaIn(Sn, base, lin, quad, den), curveAreaIn(S, base, lin, quad, den))
		if bc.Cmp(areaStep) != 0 {
			t.Fatalf("C-1/L1 violated: buyCost(%s,%s)=%s != areaStep=%s (b=%s l=%s q=%s d=%s)", S, n, bc, areaStep, base, lin, quad, den)
		}

		// C-3 / L3 (EQUALITY): splitting a buy telescopes exactly.
		split := mAdd(curveBuyCostIn(S, n1, base, lin, quad, den), curveBuyCostIn(mAdd(S, n1), n2, base, lin, quad, den))
		if split.Cmp(bc) != 0 {
			t.Fatalf("C-3/L3 violated: split buy %s != whole buy %s", split, bc)
		}

		// Sells: draw k <= S+n from the post-buy supply.
		k := new(big.Int).Mod(cvRandBig(r), mAdd(Sn, big.NewInt(1))) // in [0, S+n]
		k1 := new(big.Int).Rsh(k, 1)
		k2 := new(big.Int).Sub(k, k1)

		// C-2 / L2 (EQUALITY): sellProceeds(S+n,k) == area(S+n) − area(S+n−k).
		sp, err := curveSellProceedsIn(Sn, k, base, lin, quad, den)
		if err != nil {
			t.Fatalf("sellProceeds(%s,%s): %v", Sn, k, err)
		}
		rem := new(big.Int).Sub(Sn, k)
		areaDrop := new(big.Int).Sub(curveAreaIn(Sn, base, lin, quad, den), curveAreaIn(rem, base, lin, quad, den))
		if sp.Cmp(areaDrop) != 0 {
			t.Fatalf("C-2/L2 violated: sellProceeds(%s,%s)=%s != areaDrop=%s", Sn, k, sp, areaDrop)
		}

		// C-4 / L4 (EQUALITY): splitting a sell telescopes exactly.
		sp1, err1 := curveSellProceedsIn(Sn, k1, base, lin, quad, den)
		sp2, err2 := curveSellProceedsIn(new(big.Int).Sub(Sn, k1), k2, base, lin, quad, den)
		if err1 != nil || err2 != nil {
			t.Fatalf("split sell errored: %v %v", err1, err2)
		}
		if mAdd(sp1, sp2).Cmp(sp) != 0 {
			t.Fatalf("C-4/L4 violated: split sell %s != whole sell %s", mAdd(sp1, sp2), sp)
		}

		// C-5 / L5 (EQUALITY): sellProceeds(S+n,n) == buyCost(S,n) — a round
		// trip is exactly zero-sum on the curve leg.
		spn, err := curveSellProceedsIn(Sn, n, base, lin, quad, den)
		if err != nil {
			t.Fatalf("sellProceeds(%s,%s): %v", Sn, n, err)
		}
		if spn.Cmp(bc) != 0 {
			t.Fatalf("C-5/L5 violated: sell %s != buy %s for the same slice", spn, bc)
		}

		// C-6 (parity-dust bound): |buyCost·den − Δnum| < den — the trade
		// total is within one unit of the exact rational, never further.
		exactStep := new(big.Int).Sub(cvExactNum(Sn, base, lin, quad, den), cvExactNum(S, base, lin, quad, den))
		diff := new(big.Int).Sub(new(big.Int).Mul(bc, den), exactStep)
		if a := new(big.Int).Abs(diff); a.Cmp(den) >= 0 {
			t.Fatalf("C-6 violated on buyCost: |buyCost·den − Δnum| = %s not < %s", a, den)
		}
		// area itself is still a one-sided floor against its own numerator.
		areaErr := new(big.Int).Sub(cvExactNum(S, base, lin, quad, den), new(big.Int).Mul(curveAreaIn(S, base, lin, quad, den), den))
		if areaErr.Sign() < 0 || areaErr.Cmp(den) >= 0 {
			t.Fatalf("area rounding violated: num − area·den = %s not in [0,%s)", areaErr, den)
		}
	}
}

// The chunked forms of L3/L4 across MANY pieces, not just two — chunking is
// EXACTLY NEUTRAL on the curve leg (telescoping), which is what pushes all
// anti-chunking economics onto the tax's ceil (exittax.go) where they are
// provably superadditive.
func TestCurve_ChunkedSplit_Property(t *testing.T) {
	r := rand.New(rand.NewSource(43))
	for i := 0; i < 500; i++ {
		base := big.NewInt(r.Int63n(2000))
		lin := big.NewInt(r.Int63n(100_000))
		quad := big.NewInt(r.Int63n(100))
		den := big.NewInt(r.Int63n(10_000) + 1)
		S := big.NewInt(r.Int63n(100000))
		total := r.Int63n(200) + 1

		// Buy `total` in random chunks vs at once — EXACTLY equal.
		whole := curveBuyCostIn(S, cvB(total), base, lin, quad, den)
		sum := mZero()
		cur := new(big.Int).Set(S)
		remaining := total
		for remaining > 0 {
			c := r.Int63n(remaining) + 1
			sum = mAdd(sum, curveBuyCostIn(cur, cvB(c), base, lin, quad, den))
			cur = mAdd(cur, cvB(c))
			remaining -= c
		}
		if sum.Cmp(whole) != 0 {
			t.Fatalf("chunked buy != whole: %s vs %s (S=%s total=%d) — the area telescope broke", sum, whole, S, total)
		}

		// Sell `total` back in random chunks vs at once — EXACTLY equal.
		top := mAdd(S, cvB(total))
		wholeSell, _ := curveSellProceedsIn(top, cvB(total), base, lin, quad, den)
		sumSell := mZero()
		cur = new(big.Int).Set(top)
		remaining = total
		for remaining > 0 {
			c := r.Int63n(remaining) + 1
			p, err := curveSellProceedsIn(cur, cvB(c), base, lin, quad, den)
			if err != nil {
				t.Fatal(err)
			}
			sumSell = mAdd(sumSell, p)
			cur = new(big.Int).Sub(cur, cvB(c))
			remaining -= c
		}
		if sumSell.Cmp(wholeSell) != 0 {
			t.Fatalf("chunked sell != whole: %s vs %s (S=%s total=%d) — the area telescope broke", sumSell, wholeSell, S, total)
		}
	}
}

// ---------------------------------------------------------------------------
// THE GOVERNING THEOREM as a direct property of the primitive (RULINGS v2 /
// RULING I): with R = area(S) exactly, a fresh buyer of any n at supply S
// pays cost = area(S+n) − area(S) and can redeem AT MOST
// payout = floor(area(S+n)·n/(S+n)) at a flat pro-rata wind-down — and
// payout <= cost, ALWAYS, for every parameterisation in the nonneg-blend
// family (price ~ i^p, p >= 0, positive blends by the mediant inequality;
// integer floors survive by the Af(S+n)·S/(S+n) > Af(S) − 1 argument in
// curve.go's header). This is the arithmetic that closes the entire SA-1
// drain class; sell_test.go asserts it end-to-end through Buy/Retire/Refund,
// this test pins it on the pure math at scale.
// ---------------------------------------------------------------------------

func TestCurve_GoverningTheorem_FreshBuyerNeverProfits(t *testing.T) {
	base, lin, quad, den := cvB(BasePrice), cvB(CurveLinNum), cvB(CurveQuadNum), cvB(CurveDenom)
	cases := 0
	check := func(S, n, b, l, q, d *big.Int, label string) {
		if n.Sign() <= 0 {
			return
		}
		Sn := mAdd(S, n)
		cost := curveBuyCostIn(S, n, b, l, q, d)
		payout := mMulDiv(curveAreaIn(Sn, b, l, q, d), n, Sn) // floor(area(S+n)·n/(S+n))
		if payout.Cmp(cost) > 0 {
			t.Fatalf("GOVERNING THEOREM VIOLATED [%s]: S=%s n=%s cost=%s < payout=%s (b=%s l=%s q=%s d=%s)",
				label, S, n, cost, payout, b, l, q, d)
		}
		cases++
	}

	// Exhaustive grid at the COMPILED calibration (the shipped integers).
	for S := int64(0); S <= 40; S++ {
		for n := int64(1); n <= 40; n++ {
			check(cvB(S), cvB(n), base, lin, quad, den, "compiled-grid")
		}
	}
	// Randomized wide sweep at the compiled calibration.
	r := rand.New(rand.NewSource(20260721))
	for i := 0; i < 2000; i++ {
		check(cvB(r.Int63n(MaxCap)), cvB(r.Int63n(1_000_000)+1), base, lin, quad, den, "compiled-random")
	}
	// Random parameterisations across the whole family.
	for i := 0; i < 3000; i++ {
		b, l, q, d := cvRandCalib(r)
		check(cvRandBig(r), new(big.Int).Add(cvRandBig(r), cvB(1)), b, l, q, d, "family-random")
	}
	t.Logf("governing theorem held on %d (S,n,calibration) cases, 0 profitable", cases)
}
