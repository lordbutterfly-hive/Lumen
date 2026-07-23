package market

import "math/big"

// DefaultFeeBps is the fee a freshly-initialized contract starts with: ZERO.
// The market takes no operator rake — winners split the entire pool. A house cut
// to a named beneficiary is both a legality problem and a centralization vector,
// so the shipped contract charges nothing. The fee mechanism is retained (bounded
// by MaxFeeBps) only for optionality/test coverage; the deployed default is 0.
const DefaultFeeBps = 0 // no protocol fee — zero-rake parimutuel

// DefaultHouseAccount would receive the house take if a fee were ever enabled.
// With DefaultFeeBps = 0 nothing ever accrues, so it is intentionally empty — no
// named beneficiary is hardcoded into the contract.
const DefaultHouseAccount = ""

// Init sets the deployer as owner and the default fee, once. The wasm layer
// gates this on contract.owner == msg.caller at deploy.
func Init(s Store, deployer string) error {
	if getStr(s, kOwner()) != "" {
		return newErr(ErrState, "already initialized")
	}
	if deployer == "" {
		return newErr(ErrInput, "empty deployer")
	}
	setStr(s, kOwner(), deployer)
	setU64(s, kFeeBps(), DefaultFeeBps)
	setStr(s, kPaused(), "0")
	setStr(s, kHouse(), DefaultHouseAccount) // house take → @lordbutterfly
	setStr(s, "p|house", DefaultHouseAccount)
	// Snapshot the compile-time protocol params to state so a user/UI can read
	// and verify them trustlessly (transparency), rather than trust a hardcoded
	// off-chain copy.
	setStr(s, "p|min_bet", MinBet)
	setU64(s, "p|max_fee_bps", MaxFeeBps)
	setU64(s, "p|max_outcomes", MaxOutcomes)
	setU64(s, "p|settle_window", SettleWindowBlocks)
	setU64(s, "p|min_gap", MinSettleGapBlocks)
	setStr(s, "p|settle_bounty", SettleBounty)
	setStr(s, "p|unit", SettleUnit)
	return nil
}

// SetFeeBps updates the live fee (bounded). It never affects a round already
// created — each round settles against its snapshotted fee (F-1).
func SetFeeBps(s Store, caller string, bps uint64) error {
	if !isOwner(s, caller) {
		return newErr(ErrAuth, "owner only")
	}
	if bps > MaxFeeBps {
		return newErr(ErrInput, "fee exceeds MaxFeeBps")
	}
	setU64(s, kFeeBps(), bps)
	return nil
}

func Pause(s Store, caller string) error {
	if !isOwner(s, caller) {
		return newErr(ErrAuth, "owner only")
	}
	setStr(s, kPaused(), "1")
	return nil
}

func Unpause(s Store, caller string) error {
	if !isOwner(s, caller) {
		return newErr(ErrAuth, "owner only")
	}
	setStr(s, kPaused(), "0")
	return nil
}

// SetHouse redirects WHERE the house take goes (owner-only). It never changes who
// can withdraw or how much the take is — only the destination account.
func SetHouse(s Store, caller, account string) error {
	if !isOwner(s, caller) {
		return newErr(ErrAuth, "owner only")
	}
	if account == "" {
		return newErr(ErrInput, "empty house account")
	}
	setStr(s, kHouse(), account)
	return nil
}

// WithdrawFees sweeps the accrued house take for `asset` to the stored HOUSE
// account (default @lordbutterfly) — never staker funds (F-1, no emergencyWithdraw).
// Owner-gated to trigger, but the destination is fixed to the house account in
// state, so it can only ever pay the house. Returns (amount, houseAccount) for the
// wasm layer to HiveTransfer.
func WithdrawFees(s Store, caller string, asset string) (*big.Int, string, error) {
	if !isOwner(s, caller) {
		return nil, "", newErr(ErrAuth, "owner only")
	}
	if !isNativeAsset(asset) {
		return nil, "", newErr(ErrInput, "bad asset")
	}
	amt := getMoney(s, kFeeAccrued(asset))
	if mIsZero(amt) {
		return nil, "", newErr(ErrBalance, "no accrued fees")
	}
	setMoney(s, kFeeAccrued(asset), mZero()) // CEI: zero before transfer
	return amt, getStr(s, kHouse()), nil
}

// Two-step ownership transfer (prevents bricking admin via a typo'd address).

func ChangeOwner(s Store, caller, newOwner string) error {
	if !isOwner(s, caller) {
		return newErr(ErrAuth, "owner only")
	}
	if newOwner == "" {
		return newErr(ErrInput, "empty new owner")
	}
	setStr(s, kPendingOwner(), newOwner)
	return nil
}

func AcceptOwnership(s Store, caller string) error {
	pending := getStr(s, kPendingOwner())
	if pending == "" || caller != pending {
		return newErr(ErrAuth, "not pending owner")
	}
	setStr(s, kOwner(), caller)
	s.Delete(kPendingOwner())
	return nil
}

func CancelOwnershipTransfer(s Store, caller string) error {
	if !isOwner(s, caller) {
		return newErr(ErrAuth, "owner only")
	}
	s.Delete(kPendingOwner())
	return nil
}
