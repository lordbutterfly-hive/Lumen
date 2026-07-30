package core

import "math/big"

// doors.go — the two doors that let a MATURED token reach a counterparty.
//
// GRANT (Approve/IncreaseAllowance/DecreaseAllowance): the holder authorises a
// spender. The caller is always a human, and the wrapper keeps requireActiveAuth
// on it. This is where the active-key requirement is discharged, ONCE.
//
// SPEND (TransferMatured): the caller may be a contract — magi-market calls it
// to settle a sale. It authorises on THE ALLOWANCE AND THE IMMEDIATE CALLER
// ONLY, and never on the transaction's signers.
//
// ★ THE TRAP, written down because it is the one an implementer walks into.
// requireActiveAuth compares RequiredAuths[0] to the caller, and a nested
// contract call carries the ORIGINAL HUMAN's RequiredAuths verbatim while the
// caller becomes "contract:<id>" (go-vsc-node execution-context.go:705-712). So
// the gate refuses every contract caller — correct today, and exactly why the
// market cannot call us yet. The tempting fix is to authorise the spend door on
// RequiredAuths instead. DO NOT. It would be satisfied by the BUYER's key while
// spending the SELLER's tokens, and more generally by any contract the holder
// ever touches, since those auths propagate to arbitrary depth. A gate that
// always passes is not a gate. The allowance IS the authority here.
//
// Only MATURED tokens move through these doors. A token still inside the window
// owes tax that depends on its own age, so it is not interchangeable with
// anything and it does not leave. That is what makes "no token that owes tax can
// reach a counterparty" true by construction rather than by policing.

// kAllowance is magi_nft's per-token allowance key, in its exact layout so
// magi-market can read it as raw state: allow|<owner>|<spender>|<tokenId>, with
// the creator as the token id.
//
// ★ THE CREATOR SEGMENT IS LOAD-BEARING. The in-house single-token reference
// keys allowances (owner, spender) because it holds one token. Copying that into
// a factory would mean one approval — granted for one creator — authorises a
// spender against EVERY creator's token the holder owns. Per-creator is the
// difference between approving a marketplace for one listing and handing it the
// whole portfolio.
func kAllowance(owner, spender, c string) string {
	return "allow|" + owner + "|" + spender + "|" + c
}

func getAllowance(s Store, owner, spender, c string) *big.Int {
	v, ok := s.Get(kAllowance(owner, spender, c))
	if !ok || v == "" {
		return mZero()
	}
	n, valid := leToU64([]byte(v))
	if !valid {
		return mZero()
	}
	return new(big.Int).SetUint64(n)
}

func setAllowance(s Store, owner, spender, c string, v *big.Int) {
	if v.Sign() < 0 {
		panic("setAllowance: negative allowance")
	}
	if !v.IsUint64() || v.Uint64() > uint64(MaxCap) {
		panic("setAllowance: allowance exceeds MaxCap")
	}
	key := kAllowance(owner, spender, c)
	if v.Sign() == 0 {
		s.Delete(key)
		return
	}
	s.Set(key, string(u64ToLE(v.Uint64())))
}

// AllowanceOf is the read side (wrapper + UI + magi-market's own raw read).
func AllowanceOf(s Store, owner, spender, creator string) *big.Int {
	return getAllowance(s, owner, spender, creator)
}

// Approve sets an allowance with COMPARE-AND-SET.
//
// ★ NO BARE OVERWRITE, deliberately. The classic ERC-20 re-approve race — the
// spender front-runs a reduction, spends the old allowance, then spends the new
// one too — is CHEAPER here than on Ethereum, because intra-block transaction
// order is chosen by the block producer rather than won in a fee auction. So the
// caller must state what they believe the current allowance to be, and a
// concurrent spend makes the change fail loudly instead of stacking.
//
// Setting to zero always succeeds regardless of `expected`, so revoking is never
// blocked by a race — a holder must always be able to withdraw authority.
func Approve(s Store, owner, spender, creator string, expected, amount *big.Int) error {
	if !validAccount(owner) || !validAccount(spender) || !validAccount(creator) {
		return newErr(ErrInput, "invalid account")
	}
	if owner == spender {
		return newErr(ErrInput, "cannot approve yourself")
	}
	if amount == nil || amount.Sign() < 0 {
		return newErr(ErrInput, "amount must not be negative")
	}
	if !amount.IsUint64() || amount.Uint64() > uint64(MaxCap) {
		return newErr(ErrInput, "allowance exceeds the supply ceiling")
	}
	if amount.Sign() > 0 {
		if expected == nil {
			return newErr(ErrInput, "expected current allowance required (compare-and-set)")
		}
		if getAllowance(s, owner, spender, creator).Cmp(expected) != 0 {
			return newErr(ErrState, "allowance changed since it was read; re-read and retry")
		}
	}
	setAllowance(s, owner, spender, creator, amount)
	return nil
}

// TransferMatured moves matured tokens. `spender` is the IMMEDIATE caller —
// msg.caller in the wrapper, which for a market settlement is the market
// contract itself, never the buyer.
//
// Authorisation: the owner moving their own tokens (spender == from, the wrapper
// having already proven active auth), or an allowance, which is decremented.
func TransferMatured(s Store, creator, from, to, spender string, amount *big.Int) error {
	if !validAccount(creator) || !validAccount(from) || !validAccount(to) || !validAccount(spender) {
		return newErr(ErrInput, "invalid account")
	}
	// A self-transfer would read both sides and write both — DOUBLING the
	// balance, an unpriced mint that breaks R == area(S). The reference contract
	// refuses it explicitly and so must we.
	if from == to {
		return newErr(ErrInput, "from and to must be different accounts")
	}
	if amount == nil || amount.Sign() <= 0 {
		return newErr(ErrInput, "amount must be positive")
	}

	// ★ REFUSE CONTRACT RECIPIENTS. magi-market's auctions and rentals escrow
	// the token INTO the market contract. A contract holding our tokens can
	// never be refunded (it holds no keys and cannot call), so supply could
	// never reach zero, the market could never close, and the creator could
	// never re-register — with the backing of those tokens locked forever. The
	// plain listing, offer, bundle and swap paths escrow nothing and are
	// unaffected by this refusal.
	if !isPayableDestination(to) {
		return newErr(ErrInput, "matured tokens can only be sent to a user account (not a contract or system address)")
	}

	// The balance guard comes BEFORE any write, and it is explicit rather than
	// implied by a subtraction: the store speaks in unsigned integers at the
	// wire, so an unchecked debit could wrap to an astronomical balance instead
	// of failing.
	bal := getMatured(s, creator, from)
	if mLt(bal, amount) {
		return newErr(ErrBalance, "insufficient matured balance")
	}

	if spender != from {
		allowed := getAllowance(s, from, spender, creator)
		if mLt(allowed, amount) {
			return newErr(ErrAuth, "insufficient allowance")
		}
		next, err := mSub(allowed, amount)
		if err != nil {
			return err // unreachable: allowed >= amount just proven
		}
		setAllowance(s, from, spender, creator, next)
	}

	// ---- writes (all guards passed) ----
	rest, err := mSub(bal, amount)
	if err != nil {
		return err // unreachable
	}
	setMatured(s, creator, from, rest)
	setMatured(s, creator, to, mAdd(getMatured(s, creator, to), amount))
	return nil
}

// isPayableDestination reports whether an account can actually RECEIVE and
// later be paid out — i.e. whether it is a real user account.
//
// ★ IT REFUSES `system:` AS WELL AS `contract:` (2026-07-30, scrutiny F1). The
// first version tested only the contract prefix, and that left a permanent,
// one-token, unrecoverable griefing vector: go-vsc's ledger refuses every
// transfer whose destination begins with `system:` (ledger_session.go), but our
// own address classifier treats such a string as VALID. So an attacker could
// send one matured token to a system address; at wind-down the permissionless
// push would burn that balance, then fail on the ledger payout and revert the
// whole transaction — leaving supply permanently above zero, the market unable
// to close, the creator unable to re-register, and the HBD backing that slice
// locked forever.
//
// Stated as an allow-list on purpose. A refusal written as "not these two
// prefixes" silently opens the day a third address form appears; a rule written
// as "must be a user account" stays closed by default.
func isPayableDestination(a string) bool {
	return !hasPrefix(a, "contract:") && !hasPrefix(a, "system:")
}

func hasPrefix(s, p string) bool { return len(s) >= len(p) && s[:len(p)] == p }
