package market

import "strconv"

// State key builders. State is already namespaced per-contract by the VSC store,
// so keys need no contract-id prefix. Short keys to save write-gas (magi style).

func kOwner() string        { return "owner" }
func kPendingOwner() string { return "pending_owner" }
func kPaused() string       { return "paused" }
func kFeeBps() string       { return "fee_bps" }
func kRoundCount() string   { return "round_count" }

// fee_accrued per asset — the accrued house take, swept to the house account
// (never stakes).
func kFeeAccrued(asset string) string { return "fee|" + asset }

// house = the account that receives the house take (the fee). Default
// @lordbutterfly; owner-settable via SetHouse.
func kHouse() string { return "house" }

// active round id (stored as id+1; 0 = none) per asset. Enforces ONE open round
// per asset so consecutive weekly betting windows can never overlap and split
// liquidity, and doubles as the on-chain "current round" pointer the frontend
// reads to know which round to show.
func kActiveRound(asset string) string { return "active|" + asset }

// Per-round fields.
func rk(id uint64, field string) string {
	return "rd|" + strconv.FormatUint(id, 10) + "|" + field
}
func rkOutcomePool(id uint64, k int) string { return rk(id, "op|"+strconv.Itoa(k)) }
func rkStake(id uint64, acct string, k int) string {
	return rk(id, "st|"+acct+"|"+strconv.Itoa(k))
}
func rkStakeTotal(id uint64, acct string) string { return rk(id, "stt|"+acct) }
func rkClaimed(id uint64, acct string) string    { return rk(id, "cl|"+acct) }
