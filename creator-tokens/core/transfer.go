package core

import "math/big"

// transfer.go — TransferCredits, relocated from the deleted prepay.go
// (RULING A money-core rewrite, RULINGS-v2-2026-07-21).
//
// THE PAR MINT IS DELETED, state why in full: Prepay minted tokens 1:1
// against HBD ("1 credit == 1 HBD base unit") while Sell redeems along the
// curve at ~10.5 units per token-index (PS=21/D=2) — an instant, unbounded
// mint-cheap/redeem-dear loop (pay 1,000, redeem 504,360 at the measured
// point), and every PAR-minted token broke the R === area(S) equality the
// whole RULING-A mechanism rests on. Buy (buy.go) is the ONLY issuance path
// now: every token that exists was paid for at the exact curve area step, so
// the reserve backs the curve with equality at every reachable state.
// Prepay's tests died with it; TransferCredits and the Owner/Paused
// accessors survive — TransferCredits here, the accessors in read.go (the
// file prepay.go's own scope note always said they belonged in).

// TransferCredits moves already-minted tokens between two holders of the same
// creator's market. It does NOT consult Phase or RequireInflowOpen, by design:
// API.md rule 4 — "The billing state must never gate funds. Phase may block
// new asks and new [buys]. It may not block ... transfer of already-owned
// credits" — and this must hold in EVERY phase, including FROZEN. Credits
// already owned are the holder's property; there is no billing-state check for
// this function to fail on, structurally, not just by omission.
//
// ROUTED THROUGH THE CHOKEPOINTS (RULING A — this closes two proven
// defects the old direct-kBal version carried; RULING K removed the cost-
// basis leg J1 had added, since the exit tax no longer caps at realized gain):
//
//	sender    → debitBalance:  removes the tokens. The sender's own clock is
//	           NOT touched (their remainder is as old as it was).
//	recipient → creditInflow:  the recipient's hold clock RE-AVERAGES TOWARD
//	           `block` — a transfer-in re-ages the recipient toward FRESH, the
//	           maximum-tax direction.
//
// The clock leg is the LOCKED-MECHANISM's own rule ("reset on any
// inflow/transfer — so alts and fresh accounts always pay the max") and
// kills a test-proven exit-tax bypass: the old version moved kBal without
// touching kAcqBlock, so 100 fresh tokens routed through an account holding
// 1 six-week-old token inherited its 0% tax wholesale — one transfer
// converted a 20% exit tax into 0%. Now the average runs the other way: the
// aged dust is swamped by the fresh size and the position pays ~max tax.
// The re-average can only ever move a clock FORWARD (C-13), so no transfer
// pattern can ever fake age — it can only donate it.
//
// `block` is in the signature since RULING A precisely because the clock leg
// needs "now"; the wasm wrapper passes the same chain block every other
// entrypoint gets.
func TransferCredits(s Store, creator, from, to string, block uint64, amount *big.Int) error {
	// validAccount on ALL THREE — each is concatenated into kBal/kAcqBlock/
	// kBasis keys with no escaping, so a '|' in any of them is a
	// key-collision vector (the package-wide rule, applied at the door).
	if !validAccount(creator) {
		return newErr(ErrInput, "invalid creator account")
	}
	if !validAccount(from) {
		return newErr(ErrInput, "invalid from account")
	}
	if !validAccount(to) {
		return newErr(ErrInput, "invalid to account")
	}
	if from == to {
		return newErr(ErrInput, "from and to must be different accounts")
	}
	if amount == nil || amount.Sign() <= 0 {
		return newErr(ErrInput, "amount must be positive")
	}

	// RULING G ordering: the ONE fallible step runs first, against the
	// sender's balance, before any write lands anywhere. debitBalance
	// re-checks internally, but the explicit pre-check keeps the error
	// message and the nothing-mutates guarantee readable at this level.
	bal := getMoney(s, kBal(creator, from))
	if mLt(bal, amount) {
		return newErr(ErrBalance, "insufficient balance")
	}

	if err := debitBalance(s, creator, from, amount); err != nil {
		return err // unreachable given the check above; defense-in-depth
	}
	// The recipient's balance grows and their hold clock re-averages toward
	// `block` — a transfer-in is an inflow, so it re-ages the recipient to
	// FRESH (maximum exit tax RATE), which is what makes OTC laundering a
	// risk-transfer discount rather than a tax escape (RULING J residual truth
	// #3). RULING K deleted the cost basis, so nothing else moves with the
	// tokens. Infallible (holdclock.go).
	creditInflow(s, creator, to, amount, block)
	return nil
}
