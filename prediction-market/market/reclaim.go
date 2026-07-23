package market

import "math/big"

// Reclaim is the fund-safety FAIL-SAFE — "funds stuck → returned to sender."
//
// If a round is still OPEN past its hard deadline (settleBlock +
// SettleWindowBlocks + grace — the SAME threshold voidStale uses, so it can
// never preempt a healthy, still-settleable round during the window), ANY staker
// can call this to, in ONE call:
//  1. force the stuck round to VOID (reason: deadline_reclaim), and
//  2. pull back their OWN full stake across all outcomes.
//
// It depends on NOTHING external: no oracle, no keeper, no owner, no scheduler.
// It is deliberately REDUNDANT with the normal voidStale()+claim() path and
// deliberately MINIMAL in logic, so that even if the ordinary resolution trigger
// were somehow unreachable or buggy, every staker still has a dead-simple button
// to get their money back. For a fully decentralized (owner-less) market this is
// the last-resort guarantee that funds can never be trapped.
//
// It is a REFUND path only. It REFUSES a SETTLED round: a real loss only exists
// on a round that settled to a winner WITHIN the window, and reclaim must never
// let a loser dodge that loss. Once the first reclaim flips a stuck round to
// VOID, every other staker may use reclaim OR the ordinary claim() — both refund
// the full stake on a VOID round, and both mark the caller claimed (no double).
//
// CEI: the round is set VOID and the caller's claimed flag is written here,
// BEFORE the wasm-side HiveTransfer of the returned amount.
//
// Returns (refund, asset). A caller with no stake yields 0 (harmless); a staker
// yields their exact stakeTotal.
func Reclaim(s Store, caller string, block uint64, id uint64) (*big.Int, string, error) {
	if caller == "" {
		return nil, "", newErr(ErrAuth, "empty caller")
	}
	if !roundExists(s, id) {
		return nil, "", newErr(ErrNotFound, "no such round")
	}
	if getStr(s, rk(id, "swept")) == "1" {
		return nil, "", newErr(ErrState, "round swept to DHF; claim window closed")
	}

	switch roundState(s, id) {
	case StateSettled:
		// Resolved to a winner within the window — NOT a stuck round. Winners
		// (and losers) use claim(); reclaim never refunds a settled loss.
		return nil, "", newErr(ErrState, "round settled; use claim")
	case StateOpen:
		// Only STRICTLY AFTER the settle window has fully elapsed plus grace —
		// identical to voidStale's gate — so a still-settleable round can never
		// be force-voided out from under a legitimate settle (no loss-dodge).
		// settleBlock (MaxRoundHorizonBlocks) and grace (MaxGraceBlocks) are
		// bounded, so this sum cannot overflow uint64 (C2).
		settleBlock := getU64(s, rk(id, "settle"))
		grace := getU64(s, rk(id, "grace"))
		if block <= settleBlock+SettleWindowBlocks+grace {
			return nil, "", newErr(ErrState, "round may still resolve normally; reclaim only past the settle deadline")
		}
		doVoid(s, id, getStr(s, rk(id, "asset")), VoidDeadlineReclaim)
		// fallthrough to the VOID refund below.
	}

	// Round is VOID (already, or just flipped) → refund the caller's full stake.
	if getStr(s, rkClaimed(id, caller)) == "1" {
		return nil, "", newErr(ErrState, "already claimed")
	}
	asset := getStr(s, rk(id, "asset"))
	setStr(s, rkClaimed(id, caller), "1") // CEI: mark claimed before transfer
	refund := getMoney(s, rkStakeTotal(id, caller))
	decOwed(s, id, refund)
	return refund, asset, nil
}
