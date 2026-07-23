package market

import "math/big"

// RecordBet credits `received` to caller's stake on `outcome`. The wasm layer
// MUST have already pulled `received` from the caller via sdk.HiveDraw before
// calling this (native assets ⇒ received == requested, no fee-on-transfer).
//
// Maintains the accounting invariant at every step:
//
//	pool           == Σ_k outcomePool[k]
//	outcomePool[k] == Σ_acct stake[acct][k]
//	stakeTotal[a]  == Σ_k stake[a][k]
//
// Betting closes strictly before lock via a DIRECT block check (F-5), so no one
// can bet after lock with near-final price information.
func RecordBet(s Store, caller string, block uint64, id uint64, outcome int, received *big.Int) error {
	if caller == "" {
		return newErr(ErrAuth, "empty caller")
	}
	if !roundExists(s, id) {
		return newErr(ErrNotFound, "no such round")
	}
	if isPaused(s) {
		return newErr(ErrPaused, "paused")
	}
	if roundState(s, id) != StateOpen {
		return newErr(ErrState, "round not open")
	}
	if block >= getU64(s, rk(id, "lock")) {
		return newErr(ErrState, "betting closed (locked)")
	}
	if outcome < 0 || outcome >= roundN(s, id) {
		return newErr(ErrInput, "outcome out of range")
	}
	minBet, err := parseMoney(MinBet)
	if err != nil {
		return err
	}
	if mLt(received, minBet) {
		return newErr(ErrInput, "stake below minimum")
	}

	addMoney(s, rkStake(id, caller, outcome), received)
	addMoney(s, rkStakeTotal(id, caller), received)
	addMoney(s, rkOutcomePool(id, outcome), received)
	addMoney(s, rk(id, "pool"), received)
	return nil
}
