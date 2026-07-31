package core

import "math/big"

// holdclock.go — the per-(creator,holder) hold clock `wacq` and the TWO
// chokepoint helpers every kBal write in this package routes through
// (RULINGS-v2-2026-07-21, re-based by RULINGS J and K).
//
// wacq(c,h) is the weighted-average acquisition block of h's balance on c's
// market. It is the ONE quantity sybils cannot fake: it RESETS toward `now`
// on EVERY inflow (weighted by size), so a fresh account, an alt, or a
// just-transferred-in position always looks maximally fresh and pays the
// maximum exit tax (exittax.go). Sells and transfers OUT never touch the
// holder's clock — reducing a position does not make the remainder younger
// or older. wacq is ALL these helpers maintain now: balance + clock, nothing
// else.
//
// DELETED HERE (RULING K, 2026-07-22): the cost basis `kBasis` (and its
// basisShare helper) that RULING J1 maintained here. K1 reverses the
// realized-gain cap — the exit tax is now GROSS proceeds × τ(h) with no cap
// (exittax.go / sell.go / refund.go), so there is no basis to add on an
// inflow, none to remove on a debit, and nothing for a debit to return. A
// gross-proceeds tax is un-splittable without any per-holder state (curve.go
// L4 path-independence + RULING F ceil superadditivity), which is the whole
// reason the cap could go. creditInflow/debitBalance lose their basis
// parameter and return respectively; net machinery is strictly LESS.
//
// DELETED HERE (RULING A4): the WA = kHoldWeightSum aggregate this file used
// to maintain (Σ_h bal·wacq, for the withdrawn v1 hold-weighted wind-down).
// The weight it fed is purchasable and therefore drainable (the purchasable-
// weight lemma), and the aggregate itself caused two test-proven live
// defects RULING G now bans by name — (F-1) a holder on a healthy ACTIVE
// market locked out of selling because debitBalance's WA subtraction
// underflowed after one ordinary transfer, and (F-2) that REJECTED sell
// having already debited the balance before the underflow returned, leaving
// I3 broken by the sold amount.
//
// DELETED HERE (RULING J): the settleHolder calls both chokepoints used to
// make into taxpot.go's accrual accumulator. The holder tax distribution is
// gone WITH its mechanism (the tax now goes to treasury — sell.go; taxpot.go
// deleted; see keys.go for the measured autopsy), so a balance write no
// longer has any accumulator to settle against. What remains in each
// chokepoint is pure: balance + clock, all infallible after the one balance
// guard.
//
// THE CHOKEPOINT RULE (load-bearing — the tax RATE depends on it): EVERY
// write to a kBal key in this package goes through creditInflow or
// debitBalance — WITH ONE NAMED EXCEPTION, added 2026-07-30: graduate()
// (matured.go) DELETES kBal and kAcqBlock together when a position clears the
// window. That is not a balance mutation the clock has to survive — it empties
// the maturing family entirely and removes the clock with it, so there is no
// stale clock left for a later write to re-average against. Any OTHER direct
// write to kBal is still the defect this rule exists to prevent: a balance
// changed outside these helpers would carry a STALE clock, which is tax-rate
// laundering. Call sites, the complete list (grep kBal to verify):
//
//	creditInflow:   Buy (buy.go) — the ONLY issuance path, and the only
//	                credit that legitimately mints a fresh clock
//	creditInflowAt: TransferCredits recipient (transfer.go),
//	                Answer creator-credit + Reclaim/Decline asker-credit
//	                (ask.go) — all four carry an EXISTING clock rather than
//	                minting a fresh one (TOKEN MATURITY, 2026-07-27)
//	debitBalance:   Sell (sell.go), TransferCredits sender (transfer.go),
//	                Ask escrow-out (ask.go), Refund + RefundHolder (refund.go)
//
// big.Int IS MANDATORY on every intermediate: bal <= MaxCap = 1e9 and
// wacq ~ 1e10 blocks gives bal·wacq ~ 1e19 > 2^64. TinyGo overflows u64
// silently — an overflow here would REDUCE a computed age with no error
// anywhere. Only the final wacq (a block height, provably <= block, C-13) is
// stored as u64.
//
// ---------------------------------------------------------------------------
// THE ZERO-VALUE CONVENTION — load-bearing, do not "fix" it:
//
// wacq unset (getU64 == 0) means "this balance never went through the hold
// clock" and is treated as MAXIMALLY FRESH (heldBlocksAt returns 0 => maximum
// exit tax; creditInflow averages it as acquired NOW). The naive reading —
// wacq=0 => acquired at block 0 => ancient => ZERO tax — would be a total
// exit-tax bypass for any balance seeded outside the chokepoints (test
// fixtures; any future migration path). "Unset == fresh" errs against the
// seller instead: unclocked tokens pay the MAXIMUM tax until their holder's
// clock is genuinely established by a clocked inflow. The same rule inside
// creditInflow (an unset wacq on a nonzero old balance averages as `block`,
// not 0) closes the laundering variant: without it, buying 1 token on top of
// a large unclocked balance would average the whole position down to wacq≈0
// and mint it a fake six-week age in one transaction.
//
// (RULING K removed the basis half of this convention along with kBasis: the
// gross-proceeds tax has no basis term to default, so "unset" now concerns
// the clock alone.)
//
// Accepted edge: a genuine inflow AT block 0 stores wacq=0 and reads as
// unset-fresh afterwards. Genesis-only (the same literal-block-0 edge
// market.go documents for kRegisteredAt), and the error direction is
// treasury-favouring (the holder over-pays tax; nobody can be under-paid).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THE MATURITY CAP (TOKEN MATURITY, USER-RULED 2026-07-27) — load-bearing, and
// the reason the weighted average is sound at all.
//
// THE RULING: "TOKEN MATURITY — applies to everyone, you're allowed to trade it,
// it still fulfils its purpose." Maturity belongs to the TOKENS, travels with
// them, and can be neither MANUFACTURED nor DESTROYED by moving them.
//
// TWO PROVEN DEFECTS MADE THAT FALSE, and both are closed here plus transfer.go:
//
//	THE AGE SPONGE (manufacture). ExitTaxBpsAt clamps the RATE at 0 past the
//	window, but the STORED age had no ceiling — heldBlocksAt returned block−wacq
//	unbounded — and it is the stored age, not the rate, that goes into the
//	weighted average below. The decay window is 1,209,600 blocks; a year-old pile
//	banks 10,512,000. So a whale holding 1000 tokens aged one year (rate already
//	0) absorbing 100 fresh tokens (rate 2000 bps) averaged to
//	  (1000·10,512,000 + 100·0)/1100 = 9,556,364 blocks — still 7.9 windows past
//	the cap — and the merged 1100 paid ZERO. The fresh slice's whole 20%
//	evaporated. The banked excess is unbounded and never expires, so this was
//	permanent, unbounded laundering capacity: park a pile, age it once, and every
//	future purchase exits tax-free through it forever.
//
//	THE MIRROR IMAGE (destruction) — transfer.go: a transfer credited the
//	recipient at age `block` regardless of the sender's holding time, so an
//	honest holder moving their own tokens between their own accounts destroyed
//	the maturity and paid the maximum tax on it.
//
// THE FIX IS ONE RULE: EVERY AGE IS CAPPED AT ExitTaxDecayBlocks AT THE MOMENT
// IT IS AVERAGED OR STORED, not merely when the rate is read. With every age
// inside [0, ExitTaxDecayBlocks], ExitTaxBpsAt is the exact ceil of ONE AFFINE
// function of age (property-tested: 0 <= τ(h)·Dt − MaxExitTaxBps·(Dt−h) < Dt for
// every h in the window), and an affine map carries a size-weighted mean of AGES
// to the size-weighted mean of RATES:
//
//	bₘ·L(mean(a)) == b₁·L(a₁) + b₂·L(a₂)      L(a) = MaxExitTaxBps·(Dt−a)/Dt
//
// So the merge is EXACTLY tax-neutral — no per-lot bookkeeping, no lot list, no
// new key family, no aggregate anything can revert on (RULING G survives
// structurally). The residue is one ceil on the rate and one floor on the age:
// under 1 bps per token, and the floor on the age is the MORE-tax direction.
// THE CAP ITSELF IS ALSO THE MORE-TAX DIRECTION: it only ever moves a clock
// FORWARD (younger), so it can never reduce anyone's tax.
//
// WHY IT MUST BE RE-APPLIED AT EVERY WRITE, not once: a clock stored at block B
// is capped as of B, and then time passes. Ten windows later that same stored
// value represents ten windows of age again. Capping only at store time — or
// only on read — leaves the average's INPUT uncapped and the sponge is back at
// full strength. Every read of a clock that feeds an average therefore re-caps
// against the CURRENT block. This is why the two clamps below sit on the inputs
// and not only on the result.
// ---------------------------------------------------------------------------

// maturityFloorBlock is the OLDEST acquisition block that still represents a
// distinguishable age at `block`: block − ExitTaxDecayBlocks, saturating at 0 so
// an early-chain block can never underflow (u64 wrap here would produce a clock
// ~1.8e19 blocks in the FUTURE, which every clamp below would then read as
// "ahead of the block" — loud, but the saturation is the correct answer, not the
// recovery).
func maturityFloorBlock(block uint64) uint64 {
	if block <= ExitTaxDecayBlocks {
		return 0
	}
	return block - ExitTaxDecayBlocks
}

// capAcqAge raises an acquisition block so that it represents AT MOST
// ExitTaxDecayBlocks of age as of `block`. Raising a clock is the seller-adverse
// / treasury-favouring direction (younger => higher rate), so this can only ever
// increase tax owed — it is safe to apply anywhere, and it is applied at every
// site that averages or stores a clock.
func capAcqAge(w, block uint64) uint64 {
	if lo := maturityFloorBlock(block); w < lo {
		return lo
	}
	return w
}

// hcU64 lifts a u64 block height into a fresh big.Int for exact arithmetic.
func hcU64(v uint64) *big.Int { return new(big.Int).SetUint64(v) }

// holderAcqBlock returns the STORED wacq for (c,h) — 0 meaning "never
// clocked" (see the zero-value convention above).
func holderAcqBlock(s Store, c, h string) uint64 {
	return getU64(s, kAcqBlock(c, h))
}

// heldBlocksAt returns how long (c,h)'s balance has been held as of `block`:
// block − wacq, SATURATING at 0 below and CAPPED at ExitTaxDecayBlocks above,
// with unset (0) treated as maximally fresh.
//
// Saturation covers two defensive cases the same way: wacq unset (=> 0 held,
// maximum tax — the convention above) and wacq > block (a non-monotone block
// input, which real chain execution never produces; treating it as 0 held is
// the treasury-favouring direction, mirroring SetFace's own "a non-monotone
// block keeps the band ACTIVE rather than lifting it").
//
// THE UPPER CAP (TOKEN MATURITY, 2026-07-27) changes no rate anywhere —
// ExitTaxBpsAt already returns 0 for every held >= ExitTaxDecayBlocks, so
// min(held, Dt) and held are the same input to it — but it makes the ONE
// statement this function is allowed to make honest: held time means "maturity",
// maturity saturates at the window, and there is no such thing as more. It also
// bounds SellResult.HeldBlocks, which is emitted to the event log and the quote
// UI, so nothing downstream ever renders "held 8.7 years" as if the extra years
// bought something. The load-bearing cap is NOT this one — it is the pair inside
// creditInflowAt, on the values that actually enter the average; a read-side cap
// alone leaves the sponge fully intact and is exactly the fix that looks right
// and is not.
func heldBlocksAt(s Store, c, h string, block uint64) uint64 {
	w := holderAcqBlock(s, c, h)
	if w == 0 || w >= block {
		// ★ A GRADUATED POSITION HAS NO CLOCK, AND ZERO WOULD BE A LIE
		// (2026-07-30). graduate() deletes kAcqBlock when it empties the
		// maturing bucket, and the zero-value convention below reads an unset
		// clock as MAXIMALLY FRESH — so without this branch a holder who held
		// for the full window and graduated reads back as owing the FULL rate.
		// That inverted the truth for every consumer at once: the tax gate, the
		// permissionless-push consent gate, the emitted event, and the quote UI
		// that RULING F makes mandatory before signing.
		//
		// If nothing is maturing but a matured balance exists, the honest answer
		// is the full window — that is precisely what "matured" means. Fixing it
		// here rather than at each reader is deliberate: the alternative is a
		// shortcut at every call site, and the one that gets forgotten reports
		// the maximum tax on a holder who owes nothing.
		if getMoney(s, kBal(c, h)).Sign() == 0 && getMatured(s, c, h).Sign() > 0 {
			return ExitTaxDecayBlocks
		}
		return 0
	}
	held := block - w
	if held > ExitTaxDecayBlocks {
		return ExitTaxDecayBlocks
	}
	return held
}

// creditInflow is THE single balance-increasing write for this package: it
// adds n to bal(c,h) and re-averages wacq toward `block`. Call sites: see the
// chokepoint list in the file header. INFALLIBLE — with the WA aggregate
// deleted (RULING A4), the accrual settle deleted (RULING J) and the cost
// basis deleted (RULING K) nothing in here can reject, which is exactly
// RULING G's requirement for a helper that sits on every fund path. Callers
// MUST have finished ALL their own guards before calling (nothing may mutate
// on a rejected call); every caller in this package does.
//
// The new clock is the size-weighted average, rounded UP (ceil — toward the
// NEWER block, i.e. toward more tax):
//
//	wNew = ceil( (oldBal·wOld + n·block) / (oldBal+n) )
//
// Why ceil: block >= wOld always (below), so rounding up rounds toward
// `block`, meaning hold time is never over-credited and tax is never
// under-charged. Error <= 1 block ≈ 0.0017 bps of tax — immaterial, but the
// direction is principled (C-13's proof needs it too: the ceil of an average
// of integers <= block is itself <= block).
//
// Guaranteed (property-tested as C-13/C-14/C-15):
//
//	C-13: wOld <= wNew <= block   (monotone: an inflow never makes a position
//	      older; bounded: never newer than now)
//	C-14: oldBal == 0  =>  wNew == block exactly (ceil(n·block/n) == block) —
//	      a fresh account ALWAYS starts at zero hold time
//	C-15: no operation sequence can fake age — heldBlocks never exceeds
//	      block − firstInflowBlock (debits never touch the clock; every
//	      inflow only moves it FORWARD)
func creditInflow(s Store, c, h string, n *big.Int, block uint64) {
	creditInflowAt(s, c, h, n, block, block)
}

// creditInflowAt is creditInflow with the credited slice's OWN acquisition
// block made explicit. Every genuine INFLOW passes acqBlock == block (that is
// creditInflow above, and it is the only form any new-money path may use).
// The ONE caller that passes anything else is Reclaim (ask.go), returning an
// escrow that delivered nothing — the ET-2 fix, 2026-07-22.
//
// WHY THE EXCEPTION IS SOUND, and why "reset on ANY inflow, zero exceptions"
// was the wrong rule for this one path (the old comment in Reclaim asserted
// it; it is false here):
//
//   - A reclaim is not an acquisition. The tokens were the asker's before
//     escrow, were locked (unsellable, untradeable) throughout, and come back
//     to rec.asker and to nobody else. The restored clock is a value the
//     asker's own state carried at escrow-out; it is not chosen at reclaim
//     time and cannot be shopped for.
//   - It is exactly WEIGHT-CONSERVING, not merely "close". With a position
//     (bal, w) that escrows c and then takes an inflow of n at block B:
//     escrowing leaves ((bal−c)·w + n·B)/(bal−c+n); returning c at w gives
//     ((bal−c)·w + n·B + c·w)/(bal+n) = (bal·w + n·B)/(bal+n) — identical to
//     never having escrowed. So no sequence of escrow round trips can buy a
//     holder a single block of age they did not already hold.
//   - The clamps below make the unsafe directions unreachable anyway:
//     acqBlock == 0 (unset / a pre-fix record) and acqBlock > block both
//     degrade to `block`, i.e. maximally fresh, the treasury-favouring
//     direction and precisely the old behaviour.
//
// C-13 (wOld <= wNew <= block) still holds for every caller because acqSlice
// is clamped into [1, block] before it is averaged. C-14 (oldBal == 0 =>
// wNew == block) holds for every INFLOW caller, since they all pass
// acqBlock == block; for the reclaim path the analogous exact statement is
// wNew == acqBlock, which is the property the conservation identity needs.
func creditInflowAt(s Store, c, h string, n *big.Int, acqBlock, block uint64) {
	balKey := kBal(c, h)
	oldBal := getMoney(s, balKey)
	wOld := getU64(s, kAcqBlock(c, h))

	// RULING G HARDENING (2026-07-27, adversarial review): if the resulting
	// balance would be zero — n == 0 onto an empty position — the weighted
	// average below divides by zero and PANICS. A panic here is not a bad
	// number, it is a whole-transaction revert on a function that sits on
	// EVERY fund path, which is precisely the failure RULING G forbids: an
	// outflow must never revert on an accounting aggregate. No caller reaches
	// this today (every one guards its own amount first), so this is a guard
	// against a future caller, not a fix for a live defect. Returning early is
	// correct as well as safe: crediting nothing must change nothing, and in
	// particular must not touch the hold clock.
	if newBal := mAdd(oldBal, n); newBal.Sign() <= 0 {
		return
	}

	// Effective old clock for the AVERAGE: unset (0) => the existing balance
	// is unclocked => treat as acquired NOW (see the zero-value convention —
	// this is the anti-laundering half of it). A stored clock ahead of
	// `block` (non-monotone input, defensive) is clamped to `block` for the
	// same treasury-favouring reason heldBlocksAt saturates.
	if wOld == 0 || wOld > block {
		wOld = block
	}
	// THE MATURITY CAP, INPUT SIDE #1 (TOKEN MATURITY, 2026-07-27) — THE AGE
	// SPONGE CLOSES HERE. The existing position enters the average carrying at
	// most ExitTaxDecayBlocks of age, so a pile that has banked years of excess
	// can no longer swallow the incoming slice's rate. Re-applied on every call
	// because the stored value ages between writes (see the file header): the
	// cap is a property of the AVERAGE'S INPUT at `block`, not a property the
	// stored value can retain.
	wOld = capAcqAge(wOld, block)

	// The incoming slice's own clock, same convention and same direction.
	acqSlice := acqBlock
	if acqSlice == 0 || acqSlice > block {
		acqSlice = block
	}
	// THE MATURITY CAP, INPUT SIDE #2. Symmetric, and it is what makes the
	// transfer leg (transfer.go passes the SENDER's clock) safe: a sender with
	// years of banked excess donates at most one window of maturity, exactly the
	// most their own tokens could have been worth in rate terms. Without this,
	// carrying the sender's clock would re-open the sponge through the transfer
	// door instead of the buy door.
	acqSlice = capAcqAge(acqSlice, block)

	newBal := mAdd(oldBal, n)
	// wNew = ceil((oldBal·wOld + n·acqSlice) / newBal) — every intermediate
	// big.Int (oldBal·wOld ~ 1e19 > 2^64, see the file-level comment).
	//
	// CEIL on the clock == FLOOR on the age == MORE tax: the merged position is
	// rounded toward YOUNGER, never older, so the <= 1-block residue of the
	// average is always in the treasury's favour (and, with the affine schedule,
	// is worth under 0.002 bps).
	num := mAdd(
		new(big.Int).Mul(oldBal, hcU64(wOld)),
		new(big.Int).Mul(n, hcU64(acqSlice)),
	)
	wNew := mMulDivCeil(num, big.NewInt(1), newBal).Uint64()
	// THE MATURITY CAP, STORE SIDE. Provably redundant TODAY — wNew is a ceil'd
	// mean of two values that are both already >= maturityFloorBlock(block), so
	// it cannot fall below it — and kept anyway, deliberately, because this is
	// the SINGLE point at which a clock enters state. Keeping the invariant
	// enforced at the write means no future change to how wOld or acqSlice are
	// derived can bypass it; the alternative is an invariant that holds only by
	// an argument about two other code paths. Property-tested at the write (P6),
	// not merely reasoned about.
	wNew = capAcqAge(wNew, block)

	addMoney(s, balKey, n)
	setU64(s, kAcqBlock(c, h), wNew)
}

// debitBalance is THE single balance-decreasing write for this package: it
// checks the balance (the ONLY thing that can reject — BEFORE any write,
// RULING G) and removes `amount` from bal(c,h). Returns only an error now
// (RULING K deleted the cost basis it used to also remove and return).
//
// The holder's wacq is deliberately NOT touched — selling or sending part
// of a position does not change when the REMAINDER was acquired. When the
// balance reaches zero the stale wacq key is harmless: the next inflow hits
// C-14's oldBal==0 branch and overwrites it with `block` exactly.
//
// THE ORDERING IS THE RULING-G FIX, state it plainly: the burn-era version
// debited the balance FIRST and then subtracted from the WA aggregate, so
// when the aggregate underflowed (reachable via one ordinary transfer) the
// error returned with the balance already gone — a REJECTED Sell that had
// destroyed the seller's tokens (I3 broken), survivable only because the
// wasm layer happens to revert wholesale. Now: guard, then debit — nothing
// after the guard can fail, so an error return and a state mutation are
// mutually exclusive IN THIS PACKAGE, not just at the wasm boundary.
func debitBalance(s Store, c, h string, amount *big.Int) error {
	balKey := kBal(c, h)
	bal := getMoney(s, balKey)
	if mLt(bal, amount) {
		return newErr(ErrBalance, "insufficient credits")
	}
	if err := subMoney(s, balKey, amount); err != nil {
		return err // unreachable given the check above; money.go convention
	}
	return nil
}
