package core

import "math/big"

// tradefee.go — the 10% trade fee: 5% creator + 5% platform, PULL-claimable
// (WAVE A, RULINGS-2026-07-21, RULING F8; exact-integer spec: MONEY-MATH CORE
// §3.3 step 6 and the C-17..C-19 split equalities).
//
// WHERE THE FEE SITS RELATIVE TO THE CURVE — the two directions are not
// symmetric, and both keep the reserve exactly fee-free (C-19):
//
//	Buy:  fee ON TOP.     buyer pays cost + fee; ONLY cost enters kReserve.
//	Sell: fee OUT OF the payout. reserve is debited the FULL curve proceeds
//	      p; the seller receives p − fee; the fee is split and accrued.
//
// Either way ΔkReserve == ±(curve leg) EXACTLY — the fee never inflates the
// reserve (which would fake over-collateralization into E and eventually pay
// it back out at wind-down) and never drains it (which would break I1').
//
// RULING F8 — WHY PULL, IN FULL (this is a teardown-bought lesson, not
// hygiene): friend.tech pushed the creator's fee inside every trade with
// require(success). A creator whose address could not receive the push — a
// contract without a fallback there; here, any future transfer-leg failure —
// bricked EVERY buy and sell on their market FOREVER, holders locked in with
// no exit. Accruing to a pull-claimable balance makes that failure
// structurally impossible: the trade mutates two integers and completes; the
// beneficiary fetches their money on their own schedule. There is exactly ONE
// HiveTransfer per trade at the wasm layer (net → the seller, on sells;
// none besides the buyer's draw on buys), never a second pushed fee leg.
//
// WHO ACCRUES WHERE (one pull-claimable pot per beneficiary):
//
//	creator half  → kFeeBal(creator), claimed via ClaimTradeFees below.
//	platform half → kTreasury(), the pot Register/Renew/Answer already
//	                credit, whose existing pull-exit is WithdrawTreasury
//	                (read.go, owner-gated). Reused deliberately — one
//	                platform-revenue pot, one audited exit, matching
//	                Register's own "the two fee lines share one accrual key".
//
// ROUNDING (money-math §7's "trade fee floor + odd-unit→platform" row): the
// total fee floors (mMulBpsDiv) — the rounding unit stays with the payer's
// side of the trade, and since the fee never touches the reserve, C-19 is
// unaffected by its direction; it costs REVENUE <= 1 unit/trade, accepted and
// documented. The creator/platform split floors the creator's half and gives
// the remainder — the odd unit, when the fee is odd — to the platform:
// deterministic, documented, and never re-split (feeC + feeP == fee is the
// C-18 equality, asserted in tests as an equality, not an approximation).

// tradeFeeOn computes (fee, feeCreator, feePlatform) on a curve leg `amount`:
// fee = floor(amount·TradeFeeBps/10000), feeCreator = floor(fee/2),
// feePlatform = fee − feeCreator. Pure — the caller books the parts.
func tradeFeeOn(amount *big.Int) (fee, feeCreator, feePlatform *big.Int) {
	fee = mMulBpsDiv(amount, TradeFeeBps)
	feeCreator = new(big.Int).Rsh(fee, 1)           // floor(fee/2)
	feePlatform = new(big.Int).Sub(fee, feeCreator) // remainder — odd unit → platform
	return fee, feeCreator, feePlatform
}

// accrueTradeFee books an already-split trade fee to the two pull pots.
// Zero parts are skipped (no state write for a dust-trade zero fee — same
// no-op-write frugality as the rest of the package, and addMoney(0) would
// still create the key).
func accrueTradeFee(s Store, creator string, feeCreator, feePlatform *big.Int) {
	if feeCreator.Sign() > 0 {
		addMoney(s, kFeeBal(creator), feeCreator)
	}
	if feePlatform.Sign() > 0 {
		addMoney(s, kTreasury(), feePlatform)
	}
}

// ClaimTradeFees pays out the caller's ENTIRE accrued trade-fee balance —
// the pull half of RULING F8. Returns the amount claimed; the core never
// moves HBD (package rule), so the wasm wrapper transfers exactly the
// returned amount to the caller AFTER this call mutates state (CEI,
// state-first), and skips the transfer entirely on a zero return.
//
// This is an OUTFLOW of money already earned, so — deliberately, and load-
// bearing — it consults NOTHING: no kPaused read, no Phase, no
// RequireInflowOpen, no market-existence gate (the same reasoning as
// refund.go's file-level rule: the moment a billing state or an admin switch
// can freeze someone's earned money, this contract is the proximate cause of
// their loss). A caller with nothing accrued gets (0, nil) — a harmless
// no-op, mirroring RefundHolder's zero-balance convention, so a keeper can
// sweep claim calls without pre-filtering.
//
// validAccount on the caller for the usual reason (kFeeBal concatenates the
// caller into a state key; '|' would forge another account's pot), which on
// the wasm layer is unreachable — the chain-verified signer is always valid —
// but the package validates every key participant at the door, no exceptions.
func ClaimTradeFees(s Store, caller string) (*big.Int, error) {
	if !validAccount(caller) {
		return nil, newErr(ErrAuth, "invalid caller account")
	}
	key := kFeeBal(caller)
	owed := getMoney(s, key)
	if mIsZero(owed) {
		return mZero(), nil
	}
	setMoney(s, key, mZero())
	return owed, nil
}
