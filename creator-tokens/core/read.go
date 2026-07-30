package core

import "math/big"

// read.go — exported read-only accessors.
//
// WHY THIS EXISTS: the wasm wrapper and the frontend both needed values that
// core held privately (face, cap, supply, reserve, balances), so each of them
// re-derived core's own key format and read conventions independently. Two
// copies of a key format is a silent-drift bug waiting to happen: rename a key
// here and the duplicates keep reading the old one, returning zero rather than
// failing loudly. Everything a caller legitimately needs to display or to log
// is exported here instead, so no consumer outside this package ever needs to
// know what a state key looks like.
//
// These are reads. None of them mutates, none of them can fail, and a missing
// or malformed value reads as the zero value — the same convention every other
// accessor in this package uses (util.go).
//
// EXCEPTION: WithdrawTreasury (C2 defect fix, 2026-07-21) is a genuine
// mutator — the treasury's only exit — kept in this file anyway because it
// is a global, non-per-market accessor of the same kind as Owner/SetPaused/
// Paused (prepay.go), not a market-lifecycle or ask/refund function. See its
// own doc for why.

// Face returns the creator's posted ask price, in HBD base units.
func Face(s Store, creator string) *big.Int { return getMoney(s, kFace(creator)) }

// Cap returns the creator-set maximum outstanding credits.
func Cap(s Store, creator string) *big.Int { return getMoney(s, kCap(creator)) }

// Supply returns credits currently outstanding (held + escrowed).
func Supply(s Store, creator string) *big.Int { return getMoney(s, kSupply(creator)) }

// Reserve returns the HBD backing this market, in base units.
func Reserve(s Store, creator string) *big.Int { return getMoney(s, kReserve(creator)) }

// BalanceOf returns a holder's credit balance (escrowed credits excluded —
// those have left the balance and live in the escrow record until resolved).
func BalanceOf(s Store, creator, holder string) *big.Int {
	// BOTH BUCKETS. This is what the wrapper, the keeper and the frontend all
	// read; returning the maturing half alone would under-report every holder
	// who has ever crossed the window, and the keeper would then believe a
	// market had drained when it had not.
	return totalBalance(s, creator, holder)
}

// MaturedOf and MaturingOf split what BalanceOf totals. The UI needs the two
// apart — one number is spendable and tradable today, the other is not, and
// showing a single figure would promise liquidity that does not exist.
func MaturedOf(s Store, creator, holder string) *big.Int {
	return getMatured(s, creator, holder)
}

func MaturingOf(s Store, creator, holder string) *big.Int {
	return getMoney(s, kBal(creator, holder))
}

// MaturesAtBlock reports the block at which a holder's maturing balance
// graduates, or 0 when there is nothing maturing. Read-only; the UI renders a
// date from it, and it is derived from the same clock the tax rate uses so the
// two can never disagree.
func MaturesAtBlock(s Store, creator, holder string) uint64 {
	if getMoney(s, kBal(creator, holder)).Sign() == 0 {
		return 0
	}
	w := holderAcqBlock(s, creator, holder)
	if w == 0 {
		return 0
	}
	return w + ExitTaxDecayBlocks
}

// (RULING K deleted BasisOf: the exit tax no longer caps at realized gain, so
// there is no per-holder cost basis to read. The quote UI shows the tax
// directly — gross proceeds × τ(h) — via QuoteSell.)

// FeeBalanceOf returns an account's PULL-CLAIMABLE trade-fee balance
// (kFeeBal — the 5% creator half of every trade fee, RULING F8), in HBD base
// units. Earned but unclaimed: it is neither reserve nor treasury, so it is
// its own resting bucket in any global-solvency accounting —
//
//	ledger HBD >= Σ reserves + treasury + Σ unclaimed trade fees
//
// — and a consumer that omits it (the simulator's HBD-conservation check did,
// which is why this accessor exists) sees a market that has traded at all as
// having "lost" the creator's fee half. Read-only; ClaimTradeFees
// (tradefee.go) is the exit.
func FeeBalanceOf(s Store, account string) *big.Int {
	return getMoney(s, kFeeBal(account))
}

// PaidUntil returns the block through which the subscription is paid.
func PaidUntil(s Store, creator string) uint64 { return getU64(s, kPaidUntil(creator)) }

// RegisteredAt returns the block the market was registered, or 0 if never.
func RegisteredAt(s Store, creator string) uint64 { return getU64(s, kRegisteredAt(creator)) }

// EscrowSeq returns the next escrow sequence number for this market, which is
// also the count of asks ever opened. An indexer pages escrow records with it.
func EscrowSeq(s Store, creator string) uint64 { return getU64(s, kSeq(creator)) }

// CommissionOwedFor returns the EXACT HBD commission owed on one ask against
// `face` — floor(face * CommissionBps / 10000), the same value ask.go's
// commissionOwedFor computes.
//
// DEFECT 5 fix (2026-07-21): exported so the wasm wrapper's `ask`/`quote`
// entrypoints compute the commission from ONE formula core owns, instead of
// hand-copying core/money.go's mMulBpsDiv. This is not cosmetic drift
// prevention: core.Ask (ask.go, the H2 fix) now requires commissionHbdPaid to
// EXACTLY equal this amount at execution — not merely be >= it — so any drift
// between a wrapper-side duplicate and core's own math would reject (brick)
// EVERY ask. Delegating to ask.go's private commissionOwedFor — the single
// source of truth core.Ask itself uses — makes the exported wrapper and the
// internal Ask guard incapable of disagreeing by construction.
func CommissionOwedFor(face *big.Int) *big.Int {
	return commissionOwedFor(face)
}

// WithdrawTreasury is the ONE mutator in this otherwise read-only file — C2's
// fix for a CRITICAL: kTreasury (keys.go) is credited by Register's
// registration fee, Renew's subscription fee, and Ask/Answer's commission
// leg, and before this function existed had NO exit anywhere in the package
// — no accessor, no subtract, no entrypoint. 100% of protocol revenue was
// permanently locked from the moment it was collected. It lives here,
// rather than in market.go or ask.go, because it is not a per-market
// function at all: kTreasury is a bare GLOBAL key (keys.go: "treasury",
// never concatenated with a creator name), the same category as kOwner/
// kPaused, whose own accessors (Owner, SetPaused, Paused) already live
// beside Prepay/TransferCredits in prepay.go for the historical reason that
// file's own comment documents — this file is where that style of global,
// non-per-market accessor actually belongs.
//
// Owner-gated (Owner(s), prepay.go — bound once at Init and never touched
// by this package again) and bounded to (0, current treasury balance]: a
// non-owner caller is refused outright, and an over-withdrawal is refused
// rather than silently clamped, mirroring Renew's own "reject, never
// silently short-change" convention for its own bound. Debits kTreasury by
// exactly `amount` and returns it; core itself never moves HBD — the wasm
// wrapper is responsible for actually paying it out to the owner via
// sdk.HiveTransfer, mutating state first (this call) and transferring
// second — the same CEI ordering Refund/RefundHolder/Reclaim's own HBD-out
// paths already use.
//
// No path to any market's reserve exists here or anywhere else in this
// function: it touches kTreasury alone, exactly as I4 ("no admin path
// exists to [a market's reserve], in any state") requires.
func WithdrawTreasury(s Store, caller string, amount *big.Int) (*big.Int, error) {
	if caller == "" || caller != Owner(s) {
		return nil, newErr(ErrAuth, "owner only")
	}
	if amount == nil || amount.Sign() <= 0 {
		return nil, newErr(ErrInput, "amount must be positive")
	}
	balance := getMoney(s, kTreasury())
	if mLt(balance, amount) {
		return nil, newErr(ErrBalance, "amount exceeds treasury balance")
	}
	if err := subMoney(s, kTreasury(), amount); err != nil {
		// Unreachable given the balance check above; kept as the same
		// defense-in-depth every subMoney call in this package applies.
		return nil, err
	}
	return amount, nil
}

// RefundRatioBps returns the reserve's coverage of the CURVE AREA in basis
// points — 10000 means R == area(S) (the RULING-A equality invariant,
// curve.go), below 10000 means the reserve is under the curve (corrupt
// state; sell.go's solvency pre-check would refuse to trade).
//
// HISTORY: this used to report coverage of PAR (reserve vs supply·1),
// because under the deleted PAR mint a credit's issue price was one base
// unit and RefundPrice floored to zero below full coverage. Under the curve
// PAR means nothing — the honest denominator is area(S), the exact backing
// the mechanism promises — and the expected reading is ALWAYS exactly 10000
// during trading (asserted in the fuzz harness). Capped at 10000 on the way
// up for display stability: during wind-down the ratio can exceed area
// coverage as pro-rata floor dust accrues forward (refund.go C-22), which
// is the healthy direction and not worth a misleading ">100%" readout.
func RefundRatioBps(s Store, creator string) uint64 {
	supply := Supply(s, creator)
	if supply.Sign() <= 0 {
		return 0
	}
	area := Area(supply)
	if area.Sign() <= 0 {
		return 0
	}
	bps := mMulDiv(Reserve(s, creator), big.NewInt(10000), area)
	if bps.Cmp(big.NewInt(10000)) > 0 {
		return 10000
	}
	return bps.Uint64()
}

// ---------------------------------------------------------------------------
// Owner / global-pause accessors — relocated here from the deleted prepay.go
// (whose own scope note said this file is where they always belonged: pure,
// typed accessors of GLOBAL keys, right next to WithdrawTreasury).
// ---------------------------------------------------------------------------

// Owner returns the platform owner bound at Init (kOwner(), keys.go), or ""
// if the contract has never been initialized. Read-only, same "missing means
// the zero value, never a panic" convention every other accessor in this
// package follows (util.go).
func Owner(s Store) string { return getStr(s, kOwner()) }

// SetPaused sets or clears the global inbound-pause switch (kPaused(),
// keys.go) that market.go's globalInflowPaused/RequireInflowOpen reads and
// enforces. Owner-gated at the wasm layer (the pause/unpause entrypoints,
// the only intended callers, check Owner above).
//
// Deliberately has no effect on any outflow path: Sell, Refund,
// RefundHolder, Reclaim, Answer, TransferCredits, ClaimTradeFees never read
// kPaused() at all (see refund.go's and sell.go's file-level comments), so
// flipping this switch can never freeze a holder's exit, a beneficiary's
// earned fees, or a creator's ability to finish delivering — only the
// RequireInflowOpen paths (Register/Renew/Buy/Ask) are
// affected. (ClaimTax, once in this list, is gone with the RULING-J holder
// distribution — no holder tax share exists to freeze.)
func SetPaused(s Store, paused bool) {
	if paused {
		setStr(s, kPaused(), "1")
	} else {
		setStr(s, kPaused(), "0")
	}
}

// Paused reports the current global inbound-pause switch state — the exact
// same read globalInflowPaused (market.go) performs internally, exposed so a
// caller can report it without duplicating kPaused()'s literal.
func Paused(s Store) bool { return globalInflowPaused(s) }
