package market

import "math/big"

// Claim computes a caller's payout and marks them claimed. The wasm layer then
// transfers the returned amount to the caller. CEI: the claimed flag (and, for
// SETTLED, the running remainders) are written here, BEFORE the wasm-side
// HiveTransfer, so a re-entrant transfer (none exist for native assets, but
// defense-in-depth) sees an already-claimed state.
//
//   - VOID:    refund the caller's full stake across all outcomes (stakeTotal, O(1)).
//   - SETTLED: pay only the caller's stake on the WINNING outcome (F-4). A stake
//     on a losing outcome is forfeited, never refunded, never double-counted.
//     Zero-dust: payout = floor(stake * distRemaining / winRemaining), then both
//     remainders decrement — the last winning claimant receives exactly the
//     remainder, so Σ claims == distributable (F-2).
//
// Returns (payout, asset). A non-winner (or already-empty stake) yields 0 and is
// still marked claimed. Double-claim is rejected.
func Claim(s Store, caller string, id uint64) (*big.Int, string, error) {
	if caller == "" {
		return nil, "", newErr(ErrAuth, "empty caller")
	}
	if !roundExists(s, id) {
		return nil, "", newErr(ErrNotFound, "no such round")
	}
	st := roundState(s, id)
	if st != StateSettled && st != StateVoid {
		return nil, "", newErr(ErrState, "round not resolved")
	}
	if getStr(s, rk(id, "swept")) == "1" {
		return nil, "", newErr(ErrState, "round swept to DHF; claim window closed")
	}
	if getStr(s, rkClaimed(id, caller)) == "1" {
		return nil, "", newErr(ErrState, "already claimed")
	}
	asset := getStr(s, rk(id, "asset"))
	// CEI: mark claimed first, BEFORE the wasm-side HiveTransfer. Exit-safe: a
	// failed transfer traps the whole contract call and the CallSession is rolled
	// back (state + ledger are one atomic rollback unit) — so the claimed flag and
	// the remainder writes below can never persist without the payout leaving. See
	// the verified go-vsc host-atomicity note in sweep.go (F-P4).
	setStr(s, rkClaimed(id, caller), "1")

	if st == StateVoid {
		refund := getMoney(s, rkStakeTotal(id, caller))
		decOwed(s, id, refund)
		return refund, asset, nil
	}

	// SETTLED.
	win := int(getU64(s, rk(id, "win")))
	stake := getMoney(s, rkStake(id, caller, win))
	if mIsZero(stake) {
		return mZero(), asset, nil // loser / no winning stake
	}
	wrem := getMoney(s, rk(id, "wrem"))
	drem := getMoney(s, rk(id, "drem"))
	payout := mMulDiv(stake, drem, wrem) // floor(stake*drem/wrem)
	newWrem, err := mSub(wrem, stake)
	if err != nil {
		return nil, "", err
	}
	newDrem, err := mSub(drem, payout)
	if err != nil {
		return nil, "", err
	}
	setMoney(s, rk(id, "wrem"), newWrem)
	setMoney(s, rk(id, "drem"), newDrem)
	decOwed(s, id, payout)
	return payout, asset, nil
}
