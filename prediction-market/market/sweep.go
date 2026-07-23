package market

import "math/big"

// SweepUnclaimed sends a resolved round's ABANDONED staker funds — winnings a
// winner never claimed, or a refund a staker never took (including because their
// account can no longer receive) — to the Hive DHF (@hive.fund) instead of
// burning them or leaving them stranded forever.
//
// It is callable only well past resolution (block > settleBlock +
// ClaimWindowBlocks, ~90 days), so a legitimate late claimer is never cut off,
// and it is permissionless. It returns (amount, dhfAccount) for the wasm layer
// to HiveWithdraw — an L2→L1 UNMAP, because the DHF is an L1 institution and the
// funds must land on L1, not sit as an L2 balance.
//
// The amount is the round's remaining `owed` escrow. Every claim/refund/reclaim
// decrements `owed`, so this sweeps EXACTLY what no one collected — never a cent
// of already-paid funds, and never anything still claimable within the window.
// Sweeping sets the `swept` flag (so claim/reclaim are then rejected — the funds
// are gone to the DHF, nothing can double-spend) and zeroes `owed`, so a round
// can be swept at most once.
func SweepUnclaimed(s Store, block uint64, id uint64) (*big.Int, string, error) {
	if !roundExists(s, id) {
		return nil, "", newErr(ErrNotFound, "no such round")
	}
	if st := roundState(s, id); st != StateSettled && st != StateVoid {
		return nil, "", newErr(ErrState, "round not resolved")
	}
	if getStr(s, rk(id, "swept")) == "1" {
		return nil, "", newErr(ErrState, "already swept")
	}
	settleBlock := getU64(s, rk(id, "settle"))
	if block <= settleBlock+ClaimWindowBlocks {
		return nil, "", newErr(ErrState, "claim window still open; stakers may still claim")
	}
	owed := getMoney(s, rk(id, "owed"))
	if mIsZero(owed) {
		return nil, "", newErr(ErrBalance, "nothing unclaimed to sweep")
	}
	// CEI: lock and zero before the withdraw. `swept` blocks any further
	// claim/reclaim; `owed`→0 makes a re-sweep a no-op.
	setStr(s, rk(id, "swept"), "1")
	setMoney(s, rk(id, "owed"), mZero())
	return owed, DHFAccount, nil
}
