package core

import (
	"fmt"
	"math/big"
	"math/rand"
	"sort"
	"testing"
)

// rounding_offpeg_test.go — the wind-down rounding oracle, re-based onto
// RULING A (RULINGS-v2-2026-07-21). Originally GAP 3 closure of the
// 2026-07-20 mutation-testing audit.
//
// ============================================================================
// WHAT THIS FILE IS FOR NOW — READ BEFORE DELETING IT AS "REDUNDANT".
// ============================================================================
//
// It proves refundPayout's floor rounding (refund.go) is correct at ARBITRARY
// reserve/supply ratios, checked payout-by-payout against an INDEPENDENTLY
// WRITTEN oracle, over randomized wind-down sequences mixing pull-Refund and
// push-RefundHolder at awkward prime ratios.
//
// WHAT CHANGED UNDER RULING A, AND WHY THIS FILE SURVIVED IT:
//
//   - The old premise was the PAR PEG: Prepay minted 1:1, so reserve==supply
//     exactly and every ratio here was "unreachable through the public API".
//     The PAR mint is DELETED (transfer.go's header has the autopsy), and
//     the live invariant is now reserve === area(supply) — so reserve/supply
//     is legitimately ~10.5·(S+1)/2 units per token at the compiled
//     calibration, i.e. this file's "off-peg" ratios are no longer exotic:
//     the OVER-collateralized direction is now the NORMAL production state,
//     and it is the direction the old PAR cap silently confiscated 99.98% of.
//   - The PAR CAP IS DELETED from refundPayout (RULING A's hard gate). The
//     oracle below dropped it in lockstep — and that single change flips the
//     terminal expectation of the reserve>supply scenario from "strands
//     (reserve−supply) forever" to "drains to EXACTLY zero", which is what
//     refund.go's C-24 terminal-exactness proof predicts once nothing caps
//     the payout below the pro-rata share. Both directions now drain clean.
//   - Direct kReserve/kSupply seeding is still the right method: it reaches
//     ratios (severe under-funding, exact zero reserve) that the shipped
//     writers cannot produce, and those are exactly where floor-vs-ceil
//     bites. Under-funded ratios are unreachable in production (the
//     equality invariant, plus sell.go's solvency refusal) — proving the
//     wind-down math correct there anyway is defense against the day some
//     future change makes them reachable, instead of discovering it live
//     against real holders' money.
//
// ============================================================================
// METHOD
// ============================================================================
//
// Every scenario writes kReserve/kSupply DIRECTLY via the state key builders
// (keys.go), splits supply across `holders` holders at random (awkward,
// non-round) amounts, then drains the market via a randomized sequence of
// Refund (pull, random partial-or-full) and RefundHolder (push, always-full)
// calls in random order — asserting at EVERY SINGLE STEP that the payout
// equals a FRESHLY, SEPARATELY WRITTEN floor expression (roFloorDiv below,
// which never calls refundPayout/mMulDiv), that the reserve is never
// over-drawn, and that the reserve moved by exactly the payout and nothing
// else. Then it asserts the terminal state refund.go's own C-24 proof
// predicts: Σ payouts == the initial reserve, exactly, zero dust, in BOTH
// off-peg directions.

// ---------------------------------------------------------------------------
// Independent oracle. Written separately from refund.go's refundPayout —
// never calls it, mMulDiv, or mMin — so a bug shared between the production
// formula and this test's expectation cannot hide from either.
// ---------------------------------------------------------------------------

// roFloorDiv computes floor(a*b/c) using only big.Int primitives, written
// independently of money.go's mMulDiv. big.Int.Quo truncates toward zero;
// for non-negative operands (every amount in this package always is) that
// is identical to floor, so this is a genuinely separate implementation
// path, not a renamed call to the code under test.
func roFloorDiv(a, b, c *big.Int) *big.Int {
	num := new(big.Int).Mul(a, b)
	return new(big.Int).Quo(num, c)
}

// roIndependentPayout mirrors refundPayout's formula — floor(reserve·
// credits/supply), and NOTHING ELSE. The PAR cap (min(payout, credits)) is
// GONE, in lockstep with refund.go (RULING A): on the curve a token's
// backing is ~10.5·(S+1)/2 base units, so capping a payout at 1 unit per
// token confiscated 99.98% of a curve-priced position. If anyone
// reintroduces the cap in refund.go, this oracle — which never calls into
// refund.go at all — will disagree on the very first over-collateralized
// scenario and fail loudly.
func roIndependentPayout(reserve, credits, supply *big.Int) *big.Int {
	return roFloorDiv(reserve, credits, supply)
}

// roRandBigN returns a uniformly random big.Int in [0, max] inclusive.
// Every value this file ever passes to it fits comfortably in an int64 (the
// scenarios below top out around 10^6), so the fast path covers everything
// actually exercised; the byte-sampling fallback exists only so this helper
// stays correct if a future scenario pushes past int64, rather than
// silently truncating.
func roRandBigN(rng *rand.Rand, max *big.Int) *big.Int {
	if max.Sign() <= 0 {
		return big.NewInt(0)
	}
	if max.IsInt64() {
		return big.NewInt(rng.Int63n(max.Int64() + 1))
	}
	byteLen := (max.BitLen() + 7) / 8
	buf := make([]byte, byteLen)
	rng.Read(buf) // (*rand.Rand).Read never errors
	v := new(big.Int).SetBytes(buf)
	return v.Mod(v, new(big.Int).Add(max, big.NewInt(1)))
}

// roSplit deterministically splits `total` (as an int64-range value — every
// scenario below is) into `n` POSITIVE parts summing exactly to `total`, via
// n-1 random cut points (a "stars and bars" composition) rather than an
// equal split — so individual holder balances are exactly as awkward as the
// reserve/supply ratio itself, not a tidy round number that could
// accidentally make floor() behave better than a real, messy population of
// holders would.
func roSplit(rng *rand.Rand, total *big.Int, n int) []*big.Int {
	if !total.IsInt64() {
		panic("roSplit: this file's scenarios are all well within int64 range; extend this helper before using a larger total")
	}
	tot := total.Int64()
	if int64(n) > tot {
		panic(fmt.Sprintf("roSplit: cannot split %d into %d positive parts", tot, n))
	}
	cuts := map[int64]bool{}
	for len(cuts) < n-1 {
		cuts[1+rng.Int63n(tot-1)] = true
	}
	sorted := make([]int64, 0, n-1)
	for c := range cuts {
		sorted = append(sorted, c)
	}
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })

	out := make([]*big.Int, n)
	prev := int64(0)
	for i, c := range sorted {
		out[i] = big.NewInt(c - prev)
		prev = c
	}
	out[n-1] = big.NewInt(tot - prev)
	return out
}

// ---------------------------------------------------------------------------
// Scenarios.
// ---------------------------------------------------------------------------

type roScenario struct {
	name     string
	supply   *big.Int
	reserve  *big.Int
	holders  int
	seed     int64
	terminal string // "drainsToZero" (reserve<=supply) or "strandsResidual" (reserve>supply)
}

var roScenarios = []roScenario{
	// Small primes, underfunded (the "fee taken from reserve" shape): no
	// common factor between reserve and supply at all, so floor() bites on
	// nearly every individual refund.
	{"small_primes_underfunded_97_101", big.NewInt(101), big.NewInt(97), 5, 20260720101, "drainsToZero"},
	// Large primes, underfunded, roughly half-covered.
	{"large_primes_underfunded_half", mustBigStr("999983"), mustBigStr("500009"), 9, 20260720102, "drainsToZero"},
	// Near-rounding-boundary: reserve is exactly ONE base unit short of a
	// full peg — the tightest possible underfunded ratio.
	{"near_boundary_one_unit_short", big.NewInt(1_000_000), big.NewInt(999_999), 7, 20260720103, "drainsToZero"},
	// Severe underfunding: almost the entire reserve is gone (e.g. a large
	// one-off fee), leaving nearly nothing to cover a much larger supply —
	// every individual refund should floor to 0 until the very last chunk.
	{"severe_underfunding_reserve_almost_zero", big.NewInt(1_000_000), big.NewInt(1), 6, 20260720104, "drainsToZero"},
	// Total drain: reserve is exactly zero while supply is still
	// outstanding — every refund must legitimately pay 0, never negative,
	// never panic (division-by-zero guarded on supply, not reserve).
	{"reserve_completely_drained", big.NewInt(500_000), big.NewInt(0), 5, 20260720105, "drainsToZero"},
	// Another awkward-prime underfunded ratio, this time with a very large
	// holder count relative to supply, so many refunds are forced to be
	// small (and therefore individually more likely to floor to 0) — this
	// stresses TestRefund_BulkRefundNotCrippledByPerCreditRounding's
	// concern (refund.go computes its OWN floor on the full credits amount,
	// never credits*RefundPrice()) across many small, randomized amounts
	// instead of the single hand-picked case that existing test covers.
	{"many_small_holders_prime_ratio", mustBigStr("104729"), mustBigStr("7919"), 20, 20260720106, "drainsToZero"},
	// The OVER-collateralized direction — which under RULING A is the NORMAL
	// production state (reserve === area(supply) runs ~10.5·(S+1)/2 units per
	// token), not an exotic bug case. It drains to EXACTLY zero now that the
	// PAR cap is deleted; under the cap it stranded (reserve−supply) forever,
	// which on a curve-priced market was a 99.98% confiscation.
	{"over_collateralized_primes", mustBigStr("997"), mustBigStr("2003"), 4, 20260720107, "drainsToZero"},
	// A realistic curve ratio: supply 1000 against area(1000) = 5,255,250 at
	// the compiled PS=21/D=2 — the exact shape the deleted PAR cap would have
	// paid 1000 base units for instead of 5,255,250 (a 0.019% payout).
	{"curve_ratio_area_of_1000", big.NewInt(1000), mustBigStr("5255250"), 6, 20260720108, "drainsToZero"},
}

// TestOffPegRefundRounding is GAP 3's closure: for every scenario above, it
// writes reserve/supply directly at the stated off-peg ratio, splits supply
// across `holders` holders at random (awkward, non-round) amounts, then
// drains the market via a randomized sequence of Refund (pull, random
// partial-or-full amounts) and RefundHolder (push, always-full-balance)
// calls in random order — asserting, at EVERY SINGLE STEP:
//  1. the actual payout equals the independently-computed floor exactly;
//  2. the payout never exceeds the reserve balance the call started with
//     (never over-drawn); and
//  3. the store's reserve moved by exactly (and only) that payout.
//
// Then, once the market is fully drained (every balance and supply at 0),
// it asserts the terminal state refund.go's own solvency proof predicts for
// that scenario's direction — exact zero-dust drain for reserve<=supply, or
// the precise stranded residual for reserve>supply.
func TestOffPegRefundRounding(t *testing.T) {
	for _, sc := range roScenarios {
		sc := sc
		t.Run(sc.name, func(t *testing.T) {
			if sc.reserve.Cmp(sc.supply) == 0 {
				t.Fatalf("test setup bug: scenario %q is exactly pegged (reserve==supply) — this file exists specifically to cover OFF-peg ratios; an exactly-pegged scenario belongs in fuzz_test.go/refund_test.go instead", sc.name)
			}

			s := NewMemStore()
			creator := "offpeg_" + sc.name
			rng := rand.New(rand.NewSource(sc.seed))

			balances := roSplit(rng, sc.supply, sc.holders)
			holderNames := make([]string, sc.holders)
			for i := range holderNames {
				holderNames[i] = fmt.Sprintf("h%02d", i)
				setMoney(s, kBal(creator, holderNames[i]), balances[i])
				// EXITTAX-1/NOTICE-1 (2026-07-22): the permissionless push refuses
				// a still-taxed holder, so clock every holder at block 1 and drain
				// a full ExitTaxDecayBlocks later (block below) — every push is a
				// 0-tax sweep. The rounding property under test is on the GROSS
				// floor(R·c/S) (tax-independent), so this does not weaken it.
				setU64(s, kAcqBlock(creator, holderNames[i]), 1)
			}
			// Direct writes, bypassing Prepay entirely — this exact ratio is
			// unreachable through the public API today; see the file-header
			// proof above for why.
			setMoney(s, kSupply(creator), sc.supply)
			setMoney(s, kReserve(creator), sc.reserve)

			totalPaid := big.NewInt(0)
			// H3 defect fix (2026-07-21): RefundHolder requires
			// Phase==FROZEN/CLOSED. This creator is never Registered, so
			// kPaidUntil defaults to 0 and any block >= GraceBlocks reads as
			// FROZEN for the whole loop below (block only ever increases) —
			// which also happens to be the thematically correct phase for a
			// scenario that is, start to finish, a wind-down drain. A full
			// ExitTaxDecayBlocks is added so every holder (clocked at block 1
			// above) is fully decayed to τ = 0 and every push is allowed
			// (EXITTAX-1 gate) as a 0-tax sweep.
			forceWindDown(s, creator) // A1: wind-down is reached by Retire, not by lapse (refund_test.go)
			block := ExitTaxDecayBlocks + GraceBlocks
			live := append([]string{}, holderNames...)

			for len(live) > 0 {
				idx := rng.Intn(len(live))
				h := live[idx]
				// BOTH buckets. At this block every holder has cleared the
				// window, so Refund graduates them on first touch and their
				// maturing key empties while the tokens are still outstanding.
				// A maturing-only read drops them from the drain and the supply
				// never reaches zero.
				bal := totalBalance(s, creator, h)
				if mIsZero(bal) {
					live = append(live[:idx], live[idx+1:]...)
					continue
				}

				usePush := rng.Intn(2) == 0
				var amt *big.Int
				switch {
				case usePush:
					amt = new(big.Int).Set(bal) // RefundHolder always drains the FULL balance
				case bal.Cmp(big.NewInt(1)) == 0:
					amt = big.NewInt(1) // only one unit to pull; forced full
				case rng.Intn(3) == 0:
					amt = new(big.Int).Set(bal) // sometimes pull the full balance too
				default:
					// A genuine PARTIAL pull — this is what actually exercises
					// floor-vs-ceil per call, since each partial pull re-reads
					// the CURRENT (already-drifted-by-prior-refunds)
					// reserve/supply ratio rather than the scenario's initial
					// one.
					amt = new(big.Int).Add(big.NewInt(1), roRandBigN(rng, new(big.Int).Sub(bal, big.NewInt(1))))
				}

				reserveBefore := getMoney(s, kReserve(creator))
				supplyBefore := getMoney(s, kSupply(creator))
				// RULING K2: the RESERVE is debited the GROSS pro-rata slice; the
				// holder receives net = gross − τ(h)·gross (tax to treasury). So
				// the rounding property under test (independent floor(R·c/S)) is
				// on the GROSS, and the reserve trajectory / terminal drain track
				// gross too.
				wantGross := roIndependentPayout(reserveBefore, amt, supplyBefore)
				wantNet := new(big.Int).Sub(wantGross, ExitTaxOn(wantGross, ExitTaxBpsAt(heldBlocksAt(s, creator, h, block))))

				var payout *big.Int
				var err error
				if usePush {
					pusher := holderNames[rng.Intn(len(holderNames))]
					payout, err = RefundHolder(s, pusher, creator, h, block)
				} else {
					payout, err = Refund(s, h, creator, block, amt)
				}
				if err != nil {
					t.Fatalf("%s: unexpected error refunding %s credits from %s (reserve=%s supply=%s, push=%v): %v",
						sc.name, amt, h, reserveBefore, supplyBefore, usePush, err)
				}

				if payout.Cmp(wantNet) != 0 {
					t.Fatalf("%s: payout=%s, want net %s — gross floor(reserve=%s * credits=%s / supply=%s) minus K2 tax",
						sc.name, payout, wantNet, reserveBefore, amt, supplyBefore)
				}
				if wantGross.Cmp(reserveBefore) > 0 {
					t.Fatalf("%s: RESERVE OVER-DRAWN: gross %s > reserve-before-call %s", sc.name, wantGross, reserveBefore)
				}
				reserveAfter := getMoney(s, kReserve(creator))
				if new(big.Int).Sub(reserveBefore, wantGross).Cmp(reserveAfter) != 0 {
					t.Fatalf("%s: reserve moved by something other than exactly the GROSS: before=%s gross=%s after=%s",
						sc.name, reserveBefore, wantGross, reserveAfter)
				}
				if reserveAfter.Sign() < 0 {
					t.Fatalf("%s: reserve went NEGATIVE: %s", sc.name, reserveAfter)
				}

				totalPaid.Add(totalPaid, wantGross)
				block++

				// BOTH buckets: a holder whose position graduated has no
				// maturing key, and dropping them here would leave their
				// tokens outstanding forever — the supply would never drain.
				if mIsZero(totalBalance(s, creator, h)) {
					live = append(live[:idx], live[idx+1:]...)
				}
			}

			finalSupply := getMoney(s, kSupply(creator))
			if !mIsZero(finalSupply) {
				t.Fatalf("%s: supply not fully drained: %s", sc.name, finalSupply)
			}
			finalReserve := getMoney(s, kReserve(creator))

			switch sc.terminal {
			case "drainsToZero":
				// refund.go's C-24 terminal exactness, now unconditional in
				// BOTH off-peg directions because nothing caps a payout below
				// its pro-rata share any more: the final claim pays
				// floor(R·S/S) == R with zero remainder, so Σ payouts == the
				// initial reserve exactly, however awkward the ratio was along
				// the way. (Under the deleted PAR cap the over-collateralized
				// direction stranded reserve−supply here instead — on a
				// curve-priced market, essentially the whole reserve.)
				if !mIsZero(finalReserve) {
					t.Fatalf("%s: expected EXACT drain to 0, got dust %s", sc.name, finalReserve)
				}
				if totalPaid.Cmp(sc.reserve) != 0 {
					t.Fatalf("%s: total paid %s != initial reserve %s", sc.name, totalPaid, sc.reserve)
				}
			default:
				t.Fatalf("test setup bug: unknown terminal mode %q", sc.terminal)
			}

			t.Logf("%s OK: %d holders, initial reserve=%s supply=%s, Σpaid=%s, final reserve=%s (supply=0)",
				sc.name, sc.holders, sc.reserve, sc.supply, totalPaid, finalReserve)
		})
	}
}
