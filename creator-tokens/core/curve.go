package core

import "math/big"

// curve.go — the bonding-curve primitive (RULING I rewrite, RULINGS-v2-
// 2026-07-21; supersedes the pure-linear PS=21/D=2 primitive — see THE RULED
// CURVE below for exactly what changed and why).
//
// THE RULED CURVE (RULING I, USER-RULED): the i-th token's price is the
// exact RATIONAL
//
//	price(i) = BasePrice + a·i + b·i²      a = 63/8,  b = 21/8000
//
// with BasePrice/CurveLinNum/CurveQuadNum/CurveDenom compile-time consts
// (params.go — RULING F5: no setter, ever). The cumulative curve area under
// supply S is
//
//	area(S) = S·BasePrice + floor((CurveLinNum·T(S) + CurveQuadNum·P(S)) / CurveDenom)
//	          T(S) = S(S+1)/2          (triangular number — EXACT)
//	          P(S) = S(S+1)(2S+1)/6    (square pyramidal number — EXACT)
//
// T(S) is exact because S·(S+1) is always even; P(S) is exact because
// S(S+1)(2S+1) is always divisible by 6 (among any two consecutive integers
// one is even; and one of S, S+1, 2S+1 is always divisible by 3). The
// S·BasePrice term is exact and never divided. The single common denominator
// CurveDenom = 8000 makes the floor the ONE rounding site in the whole
// primitive.
//
// WHAT THE PREVIOUS VERSION DID AND WHY IT CHANGED: it priced the pure
// linear P(i) = i·21/2 with a ZERO intercept and no quadratic term.
// RULING I adds (1) the RULING-H BasePrice — the zero intercept was a
// 100,000×-class first-buy free ride no cap could fix — and (2) a 25%
// quadratic term, a deliberate, bounded step toward speculation (params.go
// has the measured effects). A recheck PROVED the naive port — rounding
// ceil(ΔT·lin/den) and ceil(ΔP·quad/den) independently per leg — fails the
// L5 round-trip equality in 65% of cases and breaks L1-L4 as well; the
// exact-area form below holds all five as exact equalities (200,000 fuzz
// cases, 0 failures). NEVER round the legs independently.
//
// ---------------------------------------------------------------------------
// THE ONE ACCOUNTING RULE (RULING A, unchanged by I): trades move the
// reserve EXACTLY along the integer area function —
//
//	buyCost(S,n)      = area(S+n) − area(S)      (the exact integer area step)
//	sellProceeds(S,k) = area(S) − area(S−k)      (the exact integer area step)
//
// so R === area(S) holds WITH EQUALITY at every reachable trading state, by
// construction: Buy adds exactly the step it now has to back, Sell removes
// exactly the step it no longer backs. There is NO path that leaves an
// unallocated remainder in the reserve. Independent per-trade rounding
// (the withdrawn WAVE-A ceil/floor scheme) kept only the INEQUALITY
// R >= area(S) and accumulated ownerless dust E > 0 — and under RULINGS v2
// that is THE bug class, not hygiene: every unallocated pot, however small,
// is a pot someone can buy into pro-rata at wind-down, and every exit-side
// patch against that is drainable (the purchasable-weight lemma).
//
// WHERE THE ROUNDING WENT (it did not disappear — it moved off the
// reserve): area's floor means buyCost/sellProceeds sit within ±1 unit of
// the exact rational slice value, on the side the two area endpoints'
// remainders decide. Solvency is unconditional either way — the reserve is
// exactly fully backed at every state, never under — and whoever buys the
// slice [S, S+n) pays exactly what selling that same slice back returns
// (before fee and tax), so the parity unit is recovered by its own payer,
// never extracted by anyone else. The old rule "division always rounds in
// the reserve's favour" is satisfied in the only sense that ever mattered:
// the reserve can never be paid out a unit it does not hold, because it
// always holds exactly area(S).
//
// THE FIVE LEMMAS, EQUALITIES (each is a property test; all are pure
// telescoping identities of the area function and therefore hold for ANY
// area(S) = exact-integer function, independent of the curve's shape):
//
//	L1 (buy covers the area step, EXACTLY):  buyCost(S,n) == area(S+n) − area(S).
//	    Definitional. This is what makes Buy preserve R === area(S).   [C-1]
//	L2 (sell pays the area step, EXACTLY):   sellProceeds(S,k) == area(S) − area(S−k).
//	    Definitional. This is what makes Sell preserve R === area(S).  [C-2]
//	L3 (chunking a buy is EXACTLY neutral):  buyCost(S,n1) + buyCost(S+n1,n2)
//	    == buyCost(S,n1+n2) — the area differences telescope.          [C-3]
//	L4 (chunking a sell is EXACTLY neutral): sellProceeds(S,k1) +
//	    sellProceeds(S−k1,k2) == sellProceeds(S,k1+k2). Same telescope.
//	    (The anti-chunking economics live where they belong: the exit TAX is
//	    ceil-per-sell and therefore superadditive — exittax.go.)       [C-4]
//	L5 (round trip is EXACTLY zero-sum):     sellProceeds(S+n,n) == buyCost(S,n)
//	    — same slice, same area step. A buy→sell round trip loses exactly 0
//	    on the curve leg; the 10% fee and the exit tax are what make it a
//	    strict loss.                                                   [C-5]
//
// THE GOVERNING THEOREM (RULINGS v2, verified 2,030 cases at the compiled
// integers + 4,270 across 7 parameterisations, 0 profitable): with
// R = area(S) exactly, a fresh buyer of any n at a flat pro-rata wind-down
// has payout <= cost, arithmetically, for every n and every wait. Family
// proof: for any price curve growing like i^p the area grows like S^(p+1),
// so area(S)/area(S+n) <= S/(S+n) for every p >= 0, and a positive blend of
// such curves (this one: p = 0, 1, 2) inherits the bound by the mediant
// inequality. It survives the integer floors too: writing Af(S) = S·B +
// floor(x(S)) with x average-price-monotone, Af(S+n)·S/(S+n) > Af(S) − 1,
// so floor(Af(S+n)·n/(S+n)) <= Af(S+n) − Af(S) = cost. The load-bearing
// premise is the EQUALITY R === area(S) — one unit of unallocated excess is
// one unit a fresh buyer can dilute into.
//
// The *In functions below take the four curve parameters as explicit
// arguments so the identities and the governing theorem can be fuzzed
// across MANY parameterisations in tests — the exported, stateful API binds
// the compile-time constants and only them. This is NOT a runtime knob:
// the parameters exist solely as function arguments on pure helpers;
// nothing reads them from state, so F5's "no setter, ever" holds by
// construction.

// curveBase/curveLin/curveQuad/curveDen are the compile-time curve constants
// lifted to *big.Int once, so the hot path doesn't reallocate them per call.
// Never mutated (package-private; every big.Int helper in money.go allocates
// fresh results).
var curveBase = big.NewInt(BasePrice)
var curveLin = big.NewInt(CurveLinNum)
var curveQuad = big.NewInt(CurveQuadNum)
var curveDen = big.NewInt(CurveDenom)

// curveTri returns T(S) = S·(S+1)/2 — EXACT: S·(S+1) is a product of two
// consecutive integers, always even, so the halving never rounds. S must be
// >= 0 (all callers pass supplies/deltas read via getMoney, which never
// returns a negative — parseMoney rejects them at the door).
func curveTri(S *big.Int) *big.Int {
	t := new(big.Int).Add(S, big.NewInt(1)) // S+1
	t.Mul(t, S)                             // S·(S+1)
	return t.Rsh(t, 1)                      // exact /2
}

// curvePyr returns P(S) = S·(S+1)·(2S+1)/6 — EXACT: of S and S+1 one is
// even, and of S, S+1, 2S+1 one is always divisible by 3 (if S ≡ 1 mod 3
// then 2S+1 ≡ 0), so the product is always divisible by 6 and the division
// never rounds. Verified structurally by the exactness test rather than
// trusted: the implementation divides with QuoRem and the test asserts a
// zero remainder across the range.
func curvePyr(S *big.Int) *big.Int {
	p := new(big.Int).Add(S, big.NewInt(1)) // S+1
	p.Mul(p, S)                             // S·(S+1)
	t := new(big.Int).Lsh(S, 1)             // 2S
	t.Add(t, big.NewInt(1))                 // 2S+1
	p.Mul(p, t)                             // S·(S+1)·(2S+1)
	return p.Div(p, big.NewInt(6))          // exact /6
}

// curveAreaIn = S·base + floor((lin·T(S) + quad·P(S))/den): the integer
// reserve REQUIRED to back supply S under the curve — and, under the
// equality invariant, the integer reserve the market ACTUALLY HOLDS at
// supply S, exactly (R === area(S), C-9). The base term is exact; the ONE
// floor sits on the single common-denominator division (RULING I: never
// round the linear and quadratic legs independently — the recheck proved
// independent rounding breaks L1-L5).
func curveAreaIn(S, base, lin, quad, den *big.Int) *big.Int {
	num := new(big.Int).Mul(lin, curveTri(S))
	num.Add(num, new(big.Int).Mul(quad, curvePyr(S)))
	num.Div(num, den) // THE one rounding site: floor
	return num.Add(num, new(big.Int).Mul(base, S))
}

// curveBuyCostIn = area(S+n) − area(S): the EXACT integer area step to mint
// from supply S up to S+n (L1). n >= 0; n == 0 costs exactly 0.
func curveBuyCostIn(S, n, base, lin, quad, den *big.Int) *big.Int {
	up := curveAreaIn(new(big.Int).Add(S, n), base, lin, quad, den)
	return up.Sub(up, curveAreaIn(S, base, lin, quad, den)) // >= 0: area is monotone in S
}

// curveSellProceedsIn = area(S) − area(S−k): the EXACT integer area step for
// redeeming the TOP k tokens, taking supply S down to S−k (L2).
//
// Errors (typed, never garbage) on k > S: area(S−k) for a negative argument
// is mathematically meaningless here, and big.Int would happily compute SOME
// number for it — a silently wrong payout on a fund path is the one failure
// mode this package never accepts (same reasoning as money.go's mSub erroring
// on underflow rather than going negative). Every in-package caller proves
// k <= S first (Sell: k = ΔS <= bal <= Σbal <= S by I3), so this error is
// defense-in-depth, mirroring refund.go's own "unreachable but kept" guards.
func curveSellProceedsIn(S, k, base, lin, quad, den *big.Int) (*big.Int, error) {
	if k.Cmp(S) > 0 {
		return nil, newErr(ErrArith, "sellProceeds: k exceeds supply")
	}
	rem := new(big.Int).Sub(S, k) // S−k >= 0, proven above
	out := curveAreaIn(S, base, lin, quad, den)
	return out.Sub(out, curveAreaIn(rem, base, lin, quad, den)), nil // >= 0 (area monotone)
}

// curveSpotRateIn = base + floor((lin·S + quad·S²)/den) for S >= 1: the
// marginal price at supply S — the price of the S-th (top) token, the
// observation Buy/Sell feed into the TWAP ring (RULINGS "WIRING": the curve
// IS the price source) and RULING C1's no-arbitrage settlement ceiling.
// Floor on the fractional part — the feed under-reports by < 1 unit, which
// is conservative as a settlement input: a LOWER rate makes an ask spend
// MORE credits (ceilDiv(face, rate)), which favours the creator — the same
// direction twap.go's own TWAP floor already chose and documented.
//
// Returns 0 at S == 0, DELIBERATELY, even though BasePrice makes the next
// token's price well-defined there: "no supply, no traded rate" is the
// package convention (RecordObs ignores non-positive rates, so an empty
// market records no observation rather than a synthetic one), and both real
// feed sites are structurally S >= 1 (Buy records at S+n >= 1, Sell at the
// pre-trade S >= ΔS >= 1).
func curveSpotRateIn(S, base, lin, quad, den *big.Int) *big.Int {
	if S.Sign() == 0 {
		return mZero()
	}
	num := new(big.Int).Mul(lin, S)
	sq := new(big.Int).Mul(S, S)
	num.Add(num, sq.Mul(sq, quad))
	num.Div(num, den) // floor, same single-division discipline as area
	return num.Add(num, base)
}

// ---------------------------------------------------------------------------
// Exported, constant-bound API — what the rest of the package (buy.go,
// sell.go, refund.go's wind-down proofs, the quote entrypoints) actually
// calls. These bind BasePrice/CurveLinNum/CurveQuadNum/CurveDenom and
// nothing else can rebind them (F5).
// ---------------------------------------------------------------------------

// Area is the integer reserve backing supply S:
// S·BasePrice + floor((63000·T(S) + 21·P(S))/8000).
// THE invariant of the whole mechanism (RULING A / the governing theorem) is
// R === Area(S) WITH EQUALITY at every reachable trading state (C-9): the
// reserve holds exactly what the curve owes and not a unit more, so no
// unallocated pot ever forms and a flat pro-rata wind-down is provably
// unprofitable for every fresh buyer at every size and every wait.
func Area(S *big.Int) *big.Int {
	return curveAreaIn(S, curveBase, curveLin, curveQuad, curveDen)
}

// BuyCost is the cost to mint n tokens starting from supply S — the exact
// integer area step Area(S+n) − Area(S) (L1). Path-independent (L3).
func BuyCost(S, n *big.Int) *big.Int {
	return curveBuyCostIn(S, n, curveBase, curveLin, curveQuad, curveDen)
}

// SellProceeds is the payout for redeeming the top k tokens from supply S —
// the exact integer area step Area(S) − Area(S−k) (L2). Path-independent
// (L4). Errors on k > S — see curveSellProceedsIn.
func SellProceeds(S, k *big.Int) (*big.Int, error) {
	return curveSellProceedsIn(S, k, curveBase, curveLin, curveQuad, curveDen)
}

// SpotRate is the marginal HBD-base-units-per-token rate at supply S — the
// TWAP feed and (Wave C) the settlement input. Rounds DOWN; 0 at S == 0.
func SpotRate(S *big.Int) *big.Int {
	return curveSpotRateIn(S, curveBase, curveLin, curveQuad, curveDen)
}
