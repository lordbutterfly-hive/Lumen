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
// debitBalance. A balance that changed outside them would carry a stale
// clock (tax-rate laundering). Call sites, the complete list (grep kBal to
// verify — nothing else writes it):
//
//	creditInflow:  Buy (buy.go),
//	               TransferCredits recipient (transfer.go),
//	               Answer creator-credit + Reclaim asker-credit (ask.go),
//	               Unlock creator-credit (unlock.go)
//	debitBalance:  Sell (sell.go), TransferCredits sender (transfer.go),
//	               Ask escrow-out (ask.go), Unlock spend (unlock.go),
//	               Book spend (session.go), Refund + RefundHolder (refund.go)
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

// hcU64 lifts a u64 block height into a fresh big.Int for exact arithmetic.
func hcU64(v uint64) *big.Int { return new(big.Int).SetUint64(v) }

// holderAcqBlock returns the STORED wacq for (c,h) — 0 meaning "never
// clocked" (see the zero-value convention above).
func holderAcqBlock(s Store, c, h string) uint64 {
	return getU64(s, kAcqBlock(c, h))
}

// heldBlocksAt returns how long (c,h)'s balance has been held as of `block`:
// block − wacq, SATURATING at 0, with unset (0) treated as maximally fresh.
//
// Saturation covers two defensive cases the same way: wacq unset (=> 0 held,
// maximum tax — the convention above) and wacq > block (a non-monotone block
// input, which real chain execution never produces; treating it as 0 held is
// the treasury-favouring direction, mirroring SetFace's own "a non-monotone
// block keeps the band ACTIVE rather than lifting it").
func heldBlocksAt(s Store, c, h string, block uint64) uint64 {
	w := holderAcqBlock(s, c, h)
	if w == 0 || w >= block {
		return 0
	}
	return block - w
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

	// Effective old clock for the AVERAGE: unset (0) => the existing balance
	// is unclocked => treat as acquired NOW (see the zero-value convention —
	// this is the anti-laundering half of it). A stored clock ahead of
	// `block` (non-monotone input, defensive) is clamped to `block` for the
	// same treasury-favouring reason heldBlocksAt saturates.
	if wOld == 0 || wOld > block {
		wOld = block
	}
	// The incoming slice's own clock, same convention and same direction.
	acqSlice := acqBlock
	if acqSlice == 0 || acqSlice > block {
		acqSlice = block
	}

	newBal := mAdd(oldBal, n)
	// wNew = ceil((oldBal·wOld + n·acqSlice) / newBal) — every intermediate
	// big.Int (oldBal·wOld ~ 1e19 > 2^64, see the file-level comment).
	num := mAdd(
		new(big.Int).Mul(oldBal, hcU64(wOld)),
		new(big.Int).Mul(n, hcU64(acqSlice)),
	)
	wNew := mMulDivCeil(num, big.NewInt(1), newBal).Uint64()

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
