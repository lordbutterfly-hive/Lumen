package core

import "math/big"

// exittax.go — the hold-time-decaying exit tax (RULINGS-v2-2026-07-21:
// RULING F for the rounding, RULING J for the destination, RULING K for the
// ONE-rule-at-every-door / no-cap form).
//
// The rate schedule (LOCKED-MECHANISM "Fees & taxes", UNCHANGED through
// every correction — the rate machinery was never broken):
//
//	tax(t) = 20% · max(0, 1 − t/6weeks)
//
// evaluated LAZILY at value-out time from the hold clock (holdclock.go) — no
// scheduler exists on this chain, and none is needed: the clock is state,
// the decay is arithmetic on `block`.
//
// RULING K (USER-RULED 2026-07-22) — ONE RULE AT EVERY VALUE-OUT DOOR, ON
// GROSS PROCEEDS, NO CAP. On any exit (curve Sell in sell.go OR wind-down
// Refund/RefundHolder in refund.go):
//
//	tax = ceil(grossProceeds · τ(h) / 10000)      to kTreasury()
//	holder receives grossProceeds − tax − fee     (fee: trade fee on Sell, 0 on Refund)
//
// with the reserve paying the FULL grossProceeds, so R === area(S) survives on
// the curve leg (the tax is carved from the payout, never a second reserve
// debit). THREE predecessor mechanisms died to get here, all refuted at exact
// integers:
//
//  1. the TOKEN BURN — only ratcheted the floor at τ >= 50% (at the ruled
//     20% the floor FELL), effectively taxed a full exit τ² = 4%, and
//     accumulated an unallocated reserve excess any fresh buyer could raid
//     at wind-down (the purchasable-weight lemma);
//  2. the HOLDER DISTRIBUTION (RULING A's pot, overturned by J) — made the
//     tax REGRESSIVE, effective rate ≈ τ·(1 − your share): a 1% fan paid
//     19.9%, a 99% whale 0.5% — it bit the fan and spared the whale;
//  3. the REALIZED-GAIN CAP (RULING J1, reversed by K1) — min(rate, gain)
//     forgave the loss-making tail tranches of a dump instead of netting them
//     against the winners, so splitting one dump into two same-block sells
//     cut the tax 45–68% (ET-1; W=10000/F=500: 177,200,625 → 57,375,816,
//     67.62% avoided). A GROSS-proceeds tax has no such seam: proceeds are
//     path-independent (curve.go L4) and ceil is superadditive (RULING F), so
//     Σ ceil(pᵢ·τ) >= ceil(Σpᵢ·τ) — two sells pay AT LEAST one, never less.
//     The cap protected only a fresh account dumping at a loss inside six
//     weeks (the anti-dump target, not a wronged fan) and cost four per-holder
//     state families (kBasis + the three episode accumulators) to do it. K1
//     deletes all of them: net machinery is strictly LESS and the tax is
//     un-splittable with ZERO per-position state. Accepted cost, disclosed: a
//     genuine fresh loss-seller now pays τ of proceeds, not of gain.
//
// Keyed on hold time — the weighted-average acquisition block, reset on any
// inflow — precisely because sybils cannot fake time: a fresh account, an
// alt, or a transferred-in position always reads maximally fresh and pays
// the full 20% (holdclock.go's zero-value convention makes even
// not-yet-clocked balances pay the max). HONEST LIMITS, disclosed, not
// engineered against (RULING J "residual truths"): a six-week holder pays 0
// by design (the patient dump is legal); OTC transfer converts the tax into
// a risk-transfer discount (the buyer inherits a fresh clock) — claim
// "un-dodgeable" ON-CHAIN only.

// ExitTaxBpsAt returns the tax rate in basis points for a position held
// `heldBlocks` blocks:
//
//	0                                              heldBlocks >= ExitTaxDecayBlocks
//	ceil(MaxExitTaxBps·(Dt−heldBlocks)/Dt)         otherwise (Dt = ExitTaxDecayBlocks)
//
// CEIL — seller-adverse by <= 1 bps. Floor would under-charge by <= 1 bps:
// immaterial in size but the WRONG direction (money.go's package rule:
// division rounds against the payer; the seller is the payer here). Exact
// endpoints, property-tested as C-16:
//
//	ExitTaxBpsAt(0) == MaxExitTaxBps exactly    (ceil(2000·Dt/Dt) == 2000)
//	ExitTaxBpsAt(h >= Dt) == 0 exactly
//	monotone non-increasing in heldBlocks       (numerator shrinks; ceil is monotone)
//
// The arithmetic runs in big.Int even though 2000·1,209,600 ≈ 2.4e9 fits u64
// comfortably — the codebase rule is no uint64 arithmetic anywhere near money
// math, with zero exceptions to reason about. Exported (with ExitTaxOn) so the
// quote entrypoint can show the exact split before signing (RULING F/6: the
// quote is mandatory UI).
func ExitTaxBpsAt(heldBlocks uint64) uint64 {
	if heldBlocks >= ExitTaxDecayBlocks {
		return 0
	}
	rem := ExitTaxDecayBlocks - heldBlocks // >= 1 here
	bps := mMulDivCeil(
		new(big.Int).SetUint64(MaxExitTaxBps),
		new(big.Int).SetUint64(rem),
		new(big.Int).SetUint64(ExitTaxDecayBlocks),
	)
	return bps.Uint64() // <= MaxExitTaxBps (rem <= Dt), so u64 is exact
}

// ExitTaxOn returns THE exit tax, IN HBD BASE UNITS, on gross proceeds p at
// rate taxBps (RULING K: gross, no cap — this is now the whole tax at every
// value-out door, curve Sell and wind-down Refund alike):
//
//	tax = ceil(p·taxBps/10000)               — RULING F: ceil, NEVER floor.
//
// THE HISTORY, IN FULL (this formula's ancestor was the single most-
// corrected formula of the whole council loop, so the record stays with it):
// the burn-era version taxed TOKENS — taxedTokens = ceil(ΔS·taxBps/10000) —
// where a floor would have burned ZERO on any <= 4-token sell at the maximum
// 20% (floor(4·2000/10000) == 0): unbounded, total evasion 4 tokens per
// transaction. RULING 6 adjudicated ceil there; RULING F carries the same
// ceil onto the money form, where floor has the same shape of hole one scale
// down (any sell grossing <= 4 base units would pay zero; dust-sized, but
// the wrong direction and the same class). Ceil's superadditivity is the
// proof chunking cannot come back through the side door: with the curve leg
// exactly path-independent (curve.go L4: chunked proceeds sum EXACTLY to the
// single-sell proceeds), Σ ceil(p_i·bps/1e4) >= ceil(Σp_i·bps/1e4) ==
// ceil(p·bps/1e4) — splitting a sell over-pays rate tax, never under-pays.
// Property-tested.
//
// THE OLD WART IS GONE, state it plainly (RULING F): under the burn, ΔS == 1
// at any positive tax burned the seller's single token and paid ZERO — a
// 100% effective tax, accepted then as the price of ceil. Under money-tax a
// 1-token sell redeems its full slice and pays taxBps of the PROCEEDS. The
// only ceil residue left is <= 1 base unit (0.001 HBD) of over-charge per
// sell, seller-adverse, treasury-favouring — the package's standard
// direction.
//
// taxBps == 0 (a position held the full six weeks) owes exactly 0.
// tax <= p always: taxBps <= MaxExitTaxBps = 2000 <= 10000, so
// ceil(p·τ/1e4) <= p for every p >= 0.
func ExitTaxOn(p *big.Int, taxBps uint64) *big.Int {
	if taxBps == 0 || p.Sign() == 0 {
		return mZero()
	}
	return mMulDivCeil(p, new(big.Int).SetUint64(taxBps), big.NewInt(10000))
}
