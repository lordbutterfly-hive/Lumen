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

// ---------------------------------------------------------------------------
// WHERE THE EXIT TAX LANDS — 50/50 creator/platform (USER RULING, 2026-07-27).
//
// This SUPERSEDES RULING J's "all to treasury" destination. J chose treasury by
// elimination and its reasoning still holds against what it was compared to —
// leaving the tax in the reserve breaks R === area(S) and re-opens the drain
// (SA-1, measured 1,322x), and paying it to remaining holders let a whale
// recover 97.5% of their own tax through their retained balance and alts while
// a 1%-of-supply fan paid the full 19.9%. Neither of those is reopened here.
//
// What J never weighed is that treasury made the exit tax a PLATFORM TRADING
// FEE of up to 20% — a fourth revenue line that appears nowhere in the locked
// revenue model (10 HBD/month subscription + 12% service commission + the 5%
// platform trade fee), arrived as a side effect of a security fix, and is the
// single worst fact for the securities question, since transaction-based
// compensation to the platform is exactly what the zero-trading-fee ruling
// existed to avoid. Splitting it in half moves the larger share of the skim
// onto the creator, where it reads as funding the person doing the work rather
// than as a toll we collect.
//
// It rides the trade fee's EXISTING rail, deliberately: creator half accrues to
// kFeeBal (pull-claimable, never pushed — our own friend.tech teardown found a
// creator who cannot receive a pushed fee bricks every buy and sell forever),
// platform half to kTreasury. No new key family, no new claim path, no new
// aggregate anything can revert on (RULING G holds structurally).
//
// THE SPLIT IS EXACT, NOT ROUNDED TWICE: creatorHalf = floor(tax/2) and the
// platform takes the REMAINDER, so the two always re-sum to tax with zero dust
// created or destroyed. This is what keeps the C-18 split equality
// (p == net + tax + feeC + feeP) true as written — `tax` is unchanged in size,
// only in destination, so every existing money-conservation test still holds.
//
// THERE IS NO CREATOR EXIT TAX (USER-RULED 2026-07-28). One rule, for every
// token: the rate comes from MATURITY and nothing else, and the destination is
// the same 50/50 split no matter whose hand the tokens are in. The creator's
// own tokens are subject to exactly the same maturity as anyone else's.
//
// WHAT WAS HERE AND WHY IT IS GONE — a SELF-SELL GUARD that routed 100% of the
// tax to treasury when `seller == creator`, on the reasoning that otherwise a
// creator refunds half their own exit tax to themselves. The reasoning was
// sound; the mechanism never worked, and TOKEN MATURITY made that decisive:
//
//   - It was a NAME CHECK facing an adversary with unbounded identities. A
//     creator moves tokens to a second account they control and sells there;
//     the guard sees a different string and the 50% rebate lands anyway.
//   - Before maturity travelled, walking around it COST something real: the
//     alt re-aged to fresh and paid the full 20%, so for a matured creator the
//     bypass was self-defeating. That accidental friction was the only thing
//     the guard ever had. Maturity now travels with the tokens (holdclock.go,
//     transfer.go), so the alt sells at the creator's own rate and THE BYPASS
//     IS FREE — one extra transaction, no cost, same rebate.
//   - It is not detectable, even in principle. Whether an account is "the
//     creator's alt" is a fact about the off-chain identity graph; contract
//     state contains no term that ranges over it, and the alt is identical to
//     an unrelated holder in every observable. No test and no future guard can
//     separate them. (Same purchasable-weight indistinguishability RULING A and
//     RULING J already paid to learn twice.)
//   - So all it did was charge MORE to creators who sell under their own name
//     than to creators who know about second accounts — pushing exits into
//     unlabeled alts, which is worse for transparency and worse for the
//     securities posture the 50/50 split was introduced to improve.
//
// A dead safety parameter is worse than none: it invites reliance on a
// protection that is not there. This is the same call params.go made when it
// DELETED RegistrationFee rather than keeping it at zero.
//
// THE HONEST NUMBER, stated so nobody has to rediscover it: because the
// creator receives the creator half of every exit tax on their own market, a
// creator selling their own tokens gets half of their own tax back — an
// effective ~10% at the maximum rate, not 20%. That was ALREADY the true
// outcome via an alt; deleting the guard makes the on-chain numbers mean what
// they say. If 10% is ever judged too weak a deterrent, the lever is the SPLIT
// (or routing 100% to treasury for everyone), never an identity check.
//
// The pre-existing 5% creator trade fee has the identical shape and the
// identical bypass, and is likewise NOT identity-checked (ruled design, F8).
func accrueExitTax(s Store, creator, seller string, tax *big.Int) {
	if tax == nil || tax.Sign() <= 0 {
		return
	}
	creatorHalf := new(big.Int).Div(tax, big.NewInt(2))
	platformHalf := new(big.Int).Sub(tax, creatorHalf)
	if creatorHalf.Sign() > 0 {
		addMoney(s, kFeeBal(creator), creatorHalf)
	}
	if platformHalf.Sign() > 0 {
		addMoney(s, kTreasury(), platformHalf)
	}
}
