package core

import (
	"math/big"
	"testing"
)

// fc12_winddown_order_test.go — F-C12 verification.
//
// THE CLAIM UNDER TEST (refund.go's C-22/C-24 comments, asserted only in prose
// until now): the per-holder wind-down payout is order-fair. refundPayout is
//
//	gross(reserve, credits, supply) = floor(reserve·credits/supply)   (refund.go:164)
//
// and BOTH the pull (Refund) and the push (RefundHolder) debit the reserve by
// exactly this GROSS and the supply by exactly `credits` on every step
// (refund.go:307-313 and :517-523 — a LIVE re-read of both keys each call). So
// a full wind-down is a sequence of refundPayout calls with `reserve` and
// `supply` decremented after each, and the ORDER of holders is chosen by
// whoever calls (Refund is the holder; RefundHolder is permissionless — anyone).
// If a holder's gross depended materially on their position in that order, the
// caller would be choosing other holders' payouts.
//
// WHAT THE MEASUREMENT FINDS (and it is NOT zero): the floor discards sub-unit
// dust, and C-22 proves that dust flows FORWARD — reserve-per-token weakly
// RISES as the unwind proceeds (R' = R − floor(R·c/S) ⇒ R'/S' >= R/S). So a
// holder who withdraws LATER sees a weakly-higher ratio and a weakly-higher
// gross. The gross IS order-dependent. The question F-C12 answers is whether
// that dependence is bounded to negligible dust or is a real fairness defect.
//
// THE EXACT BOUND, DERIVED. Write gross_h = floor(r_k·c_h) where r_k = R_k/S_k
// is the reserve ratio at the moment h is processed with k holders already
// gone. One step moves the ratio by
//
//	r_{k+1} = r_k + {r_k·c_k}/S_{k+1},   {x} = x − floor(x) ∈ [0,1)
//
// so when h is processed, r_k = r_0 + Σ_{i<k} {r_i·c_i}/S_{i+1}. Every holder i
// processed BEFORE h leaves h still present, so S_{i+1} >= c_h, i.e.
// c_h/S_{i+1} <= 1. Therefore
//
//	r_k·c_h − r_0·c_h = Σ_{i<k} {r_i·c_i}·(c_h/S_{i+1}) < Σ_{i<k} 1 = k <= N−1.
//
// Flooring both sides: gross_h − floor(r_0·c_h) <= N−1. The minimum over all
// orders is floor(r_0·c_h) exactly (h FIRST — the ratio has not yet risen; this
// is C-23, the "no bank run" lower bound), and every other order lands within
// N−1 sub-units above it. Hence:
//
//	max_order gross_h − min_order gross_h <= N − 1   (N = number of holders).
//
// N−1 base units of HBD (a base unit is 0.001 HBD) spread across an ENTIRE
// market's holder set is a defensible dust bound: it is the forward-flowing
// floor dust C-22 already documents, the reserve conserves it exactly
// (Σ gross == R every time — C-24, asserted below), and it is independent of
// how large any single position is. VERDICT: BOUNDED, not a finding.
//
// This test enumerates EVERY permutation of several holder sets — including
// adversarial ones (a whale beside dust holders, reserve below supply, five
// holders) — drives the real refundPayout, and fails as an ESCALATE if any
// holder's measured spread ever exceeds N−1.

// fc12Perms returns all permutations of [0, n).
func fc12Perms(n int) [][]int {
	if n == 0 {
		return [][]int{{}}
	}
	var out [][]int
	var rec func(cur []int, rest []int)
	rec = func(cur, rest []int) {
		if len(rest) == 0 {
			cp := make([]int, len(cur))
			copy(cp, cur)
			out = append(out, cp)
			return
		}
		for i := range rest {
			nextRest := make([]int, 0, len(rest)-1)
			nextRest = append(nextRest, rest[:i]...)
			nextRest = append(nextRest, rest[i+1:]...)
			rec(append(cur, rest[i]), nextRest)
		}
	}
	all := make([]int, n)
	for i := range all {
		all[i] = i
	}
	rec(nil, all)
	return out
}

func TestWindDown_PayoutOrderIndependent(t *testing.T) {
	type fixture struct {
		name    string
		reserve int64
		credits []int64
	}
	// Each fixture's supply is the sum of its credits (the wind-down invariant:
	// every holder's balance sums to supply). Ratios are deliberately fractional
	// so the floor actually discards dust — a clean-dividing fixture would make
	// the test vacuously pass.
	fixtures := []fixture{
		{"three-equal-fractional", 1000, []int64{333, 333, 334}},        // R>S, near-equal
		{"whale-beside-two-dust", 1500, []int64{1, 1, 1000}},            // a whale next to dust holders
		{"reserve-below-supply", 700, []int64{300, 300, 401}},          // R<S (the general C-23 bound)
		{"four-mixed-magnitudes", 10007, []int64{1, 10, 100, 9000}},    // spread of magnitudes, R>S
		{"five-holders-fractional", 12345, []int64{7, 77, 777, 3000, 5000}},
		{"three-coprime-reserve", 101, []int64{10, 10, 11}},            // tiny, maximally fractional
	}

	var globalMaxSpread int64
	for _, fx := range fixtures {
		N := len(fx.credits)
		var supply int64
		for _, c := range fx.credits {
			supply += c
		}

		// grossByHolder[h] collects holder h's gross across every permutation.
		grossByHolder := make([][]int64, N)

		for _, perm := range fc12Perms(N) {
			R := big.NewInt(fx.reserve)
			S := big.NewInt(supply)
			got := make([]int64, N)
			for _, h := range perm {
				// The production GROSS — the exact function the pull and push both
				// debit the reserve by (refund.go:164, :313, :523).
				g := refundPayout(R, big.NewInt(fx.credits[h]), S)
				if !g.IsInt64() {
					t.Fatalf("%s: gross %s overflowed int64 — fixture too large", fx.name, g)
				}
				got[h] = g.Int64()
				// Mirror the callers exactly: reserve −= gross, supply −= credits.
				R = new(big.Int).Sub(R, g)
				S = new(big.Int).Sub(S, big.NewInt(fx.credits[h]))
			}
			// C-24 terminal exactness: a COMPLETE wind-down, in ANY order, drains
			// the reserve to exactly zero (the last holder's credits == remaining
			// supply ⇒ floor(R·S/S) == R). If this ever fails, the whole
			// order-fairness argument is moot — the reserve isn't conserved.
			if R.Sign() != 0 {
				t.Fatalf("%s perm %v: reserve drained to %s, want exactly 0 (C-24 terminal exactness)", fx.name, perm, R)
			}
			if S.Sign() != 0 {
				t.Fatalf("%s perm %v: supply drained to %s, want exactly 0", fx.name, perm, S)
			}
			for h := 0; h < N; h++ {
				grossByHolder[h] = append(grossByHolder[h], got[h])
			}
		}

		for h := 0; h < N; h++ {
			lo, hi := grossByHolder[h][0], grossByHolder[h][0]
			for _, v := range grossByHolder[h] {
				if v < lo {
					lo = v
				}
				if v > hi {
					hi = v
				}
			}
			spread := hi - lo
			if spread > globalMaxSpread {
				globalMaxSpread = spread
			}

			// C-23: the minimum over all orders is the ratio-at-open slice
			// (h withdraws FIRST, before any dust accrues) — every holder is
			// bounded BELOW by floor(R_open·c_h/S_open), so going later only ever
			// helps. This pins the lower end of the spread to a known quantity.
			wantMin := refundPayout(big.NewInt(fx.reserve), big.NewInt(fx.credits[h]), big.NewInt(supply))
			if big.NewInt(lo).Cmp(wantMin) != 0 {
				t.Fatalf("%s holder %d: min gross across orders = %d, want the ratio-at-open slice %s (C-23 lower bound violated)", fx.name, h, lo, wantMin)
			}

			// THE BOUND. spread <= N−1 (derived in the file header). Exceeding it
			// is NOT dust — it is a real order-fairness defect, and this fails as an
			// ESCALATE with the exact numbers rather than being quietly loosened.
			if spread > int64(N-1) {
				t.Fatalf("ESCALATE — F-C12 REAL FINDING: %s holder %d gross spans [%d, %d] = spread %d across permutations, EXCEEDS the derived dust bound N−1 = %d. "+
					"A holder's payout depends on wind-down order by more than forward-flowing floor dust; the caller (permissionless for the push) is choosing payouts. credits=%v reserve=%d supply=%d",
					fx.name, h, lo, hi, spread, N-1, fx.credits, fx.reserve, supply)
			}
		}
	}

	// NON-VACUOUS: the whole point is that the gross IS order-dependent (by dust)
	// and that dependence is BOUNDED — not that it is zero. If no fixture ever
	// produced a nonzero spread, the fixtures divide too cleanly and the bound
	// assertion above would be proving nothing.
	if globalMaxSpread == 0 {
		t.Fatal("no order-dependence observed in any fixture — the dust bound is untested (fixtures divide too evenly to exercise the floor)")
	}
	t.Logf("F-C12 VERDICT: BOUNDED. Max per-holder gross spread across all permutations of all fixtures = %d base unit(s) of HBD; "+
		"derived bound is N−1 (forward-flowing floor dust, C-22). No order-dependence beyond dust; reserve conserved exactly every run (C-24).", globalMaxSpread)
}

// TestWindDown_RefundGrossMatchesSimulation ties the pure-math pin above to the
// PRODUCTION outflow: the reserve delta a real Refund() debits must equal the
// refundPayout GROSS the simulation uses, in every order. This is what makes the
// enumeration test's decrement model ("reserve −= gross, supply −= credits")
// faithful to refund.go rather than a re-implementation that could drift from it.
func TestWindDown_RefundGrossMatchesSimulation(t *testing.T) {
	const reserve0 = int64(1000)
	credits := []int64{333, 333, 334} // sums to supply 1000
	holders := []string{"holderaa", "holderbb", "holdercc"}
	var supply int64
	for _, c := range credits {
		supply += c
	}

	orders := [][]int{{0, 1, 2}, {2, 1, 0}, {1, 2, 0}}
	for _, order := range orders {
		const creator = "fc12crea"
		s := NewMemStore()
		setMoney(s, kSupply(creator), big.NewInt(supply))
		setMoney(s, kReserve(creator), big.NewInt(reserve0))
		for i, h := range holders {
			setMoney(s, kBal(creator, h), big.NewInt(credits[i]))
		}
		// FROZEN ⇒ inWindDown ⇒ the Refund (pull) rail is open. The wind-down
		// exit tax is carved from the holder's NET only; the reserve is debited
		// the full GROSS either way, so the reserve delta is tax-independent and
		// equals refundPayout exactly (refund.go:313).
		forceFrozen(s, creator)
		const wdBlock = 50 + GraceBlocks + 1

		// Simulate the SAME order with the pure function.
		R := big.NewInt(reserve0)
		S := big.NewInt(supply)
		for _, h := range order {
			wantGross := refundPayout(R, big.NewInt(credits[h]), S)

			rb := getMoney(s, kReserve(creator))
			if _, err := Refund(s, holders[h], creator, wdBlock, big.NewInt(credits[h])); err != nil {
				t.Fatalf("order %v: Refund(%s): %v", order, holders[h], err)
			}
			gotGross := new(big.Int).Sub(rb, getMoney(s, kReserve(creator)))

			if gotGross.Cmp(wantGross) != 0 {
				t.Fatalf("order %v holder %s: production reserve delta %s != refundPayout gross %s — the simulation's decrement model has drifted from refund.go",
					order, holders[h], gotGross, wantGross)
			}
			R = new(big.Int).Sub(R, wantGross)
			S = new(big.Int).Sub(S, big.NewInt(credits[h]))
		}
		// Real path also drains the reserve to exactly 0 (C-24).
		if got := getMoney(s, kReserve(creator)); got.Sign() != 0 {
			t.Fatalf("order %v: production reserve left at %s after full unwind, want 0", order, got)
		}
	}
}
