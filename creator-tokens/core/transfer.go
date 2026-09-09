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
//	sender    → debitBalance:    removes the tokens. The sender's own clock is
//	             NOT touched (their remainder is as old as it was).
//	recipient → creditInflowAt:  the moved tokens arrive carrying the SENDER's
//	             own hold clock, capped at one decay window, and re-average into
//	             whatever the recipient already holds.
//
// ---------------------------------------------------------------------------
// TOKEN MATURITY (USER-RULED 2026-07-27) — THE INCOMING SLICE CARRIES THE
// SENDER'S CLOCK, NOT `block`. This REVERSES the "a transfer-in is always
// maximally fresh" rule that stood here, and the reversal is the ruling:
// "TOKEN MATURITY — applies to everyone, you're allowed to trade it, it still
// fulfils its purpose." Maturity belongs to the TOKENS and travels with them.
//
// WHAT THE OLD RULE ACTUALLY DID, stated plainly because it read as the safe
// direction and was not: crediting the recipient at age `block` DESTROYED
// maturity on every move. An honest holder who had held for the full six weeks
// and moved their own position between their own two accounts — cold wallet to
// hot, a custody rotation, a split for accounting — was reset to age 0 and paid
// the FULL 20% on tokens the protocol had already agreed owed nothing. That is
// not a conservative rounding; it is a confiscation triggered by an operation
// the system explicitly permits in every phase, and it fell on exactly the
// long-term holder the decay exists to reward. Property P3 measures it: under
// the old rule a self-custody move of 265 of 312 six-week-old tokens turned a
// 0-tax exit into a 111,786-unit one.
//
// WHY CARRYING THE CLOCK CANNOT LAUNDER, which is what the old rule was
// defending against. The clock arrives CAPPED at ExitTaxDecayBlocks of age
// (creditInflowAt's acqSlice cap) and merges by SIZE-WEIGHTED AVERAGE, so the
// market-wide age-weight ledger Σ balance·min(age, window) is CONSERVED by a
// transfer and STRICTLY REDUCED by the average's floor — never increased. A
// sender cannot give away age they do not have, cannot give away more than one
// window of it, and cannot keep what they gave: their remainder holds the same
// clock over fewer tokens. So maturity can be MOVED but not MINTED, which is
// precisely the ruling. Property P2 asserts that ledger after every operation.
//
// THE OTC CASE, disclosed rather than engineered against (the same honest-limit
// discipline exittax.go's header uses): an aged holder can now sell their
// maturity along with their tokens, and the buyer inherits the decayed rate.
// Under the old rule they could not — but they could always achieve the same
// system-wide result by selling ON the curve at their own 0% and letting the
// buyer re-buy, so the tax collected is unchanged; what moves is who does the
// selling. This is the ruled "you're allowed to trade it", and it is bounded:
// the seller's maturity is finite, conserved, and gone once sold.
//
// The re-average still can only ever move a clock FORWARD (C-13) relative to
// the capped inputs, so no transfer pattern can fake age — it can only relocate
// it.
// ---------------------------------------------------------------------------
//
// `block` is in the signature since RULING A precisely because the clock leg
// needs "now"; the wasm wrapper passes the same chain block every other
// entrypoint gets. It is still load-bearing: `block` is what the maturity cap
// is measured against on BOTH legs of the average.
//
// `caller` — F12 DEFECT FIX (2026-08-19). Before this parameter existed, this
// function took `from` as a bare, unauthenticated account name and validated
// it for ACCOUNT-STRING FORMAT ONLY — nothing here proved `from` was the
// transaction's actual signer. The entire "you can only move your own
// credits" guarantee lived in exactly one line at the wasm wrapper
// (contract/main.go's Transfer, which always passed the env caller as
// `from`), and nothing in this package's own test suite could catch a
// regression there: mutating that single call-site argument to read an
// attacker-controlled payload field instead of the verified caller produced
// live theft — a funded holder's entire balance moved to an account that had
// never touched the market — while every existing test in the repository
// still passed (core/fuzz_test.go's
// TransferCreditsHasNoCallerAuthorization_DOCUMENTED_FINDING proved it
// end-to-end, including a live Sell of the stolen tokens for real HBD).
//
// Every other value-moving function in this package (Buy/Ask/Refund/Sell/
// Register/Graduate, ...) takes an explicit `caller` and acts only on that
// caller's own balance/position by construction — see e.g. Refund's
// `totalBalance(s, creator, caller)`. TransferCredits now follows the same
// shape: the caller is a first-class parameter, and `caller == from` is
// enforced HERE, structurally, rather than resting on the wrapper never
// getting that one line wrong. The wasm wrapper still computes `caller` from
// the verified active-auth signer (requireActiveAuth) and passes it as BOTH
// `caller` and `from` on its one legitimate call shape; this function no
// longer trusts that wiring blindly.
func TransferCredits(s Store, caller, creator, from, to string, block uint64, amount *big.Int) error {
	// The auth gate comes first, matching this package's own convention for
	// every other caller-bound function (e.g. registerCheck, market.go:
	// "if caller != creator { ErrAuth }" runs before any format validation).
	if caller != from {
		return newErr(ErrAuth, "caller must equal from: cannot move another account's credits")
	}
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
	// CT-STATE-04 / CT-EXEC-02 FIX (2026-09-08): the destination must be an
	// account that can actually RECEIVE and later be paid out. A credit balance
	// that lands on a `contract:` or `system:` address can never be moved or
	// paid again (the holder holds no keys and go-vsc's ledger refuses
	// `system:` payouts), so supply can never reach zero, the market can never
	// close, and the creator can never re-register — the HBD backing that slice
	// locked forever. TransferMatured (doors.go) already refuses these; the
	// core credit path did not, resting entirely on the wasm wrapper's one
	// `isPayableAddress(to)` line. This closes the core-side gap so the
	// guarantee no longer depends on the wrapper never getting that line wrong.
	if !isPayableDestination(to) {
		return newErr(ErrInput, "credits can only be sent to a user account (not a contract or system address)")
	}
	if amount == nil || amount.Sign() <= 0 {
		return newErr(ErrInput, "amount must be positive")
	}

	// RULING G ordering: the ONE fallible step runs first, against the
	// sender's balance, before any write lands anywhere. debitBalance
	// re-checks internally, but the explicit pre-check keeps the error
	// message and the nothing-mutates guarantee readable at this level.
	// BOTH BUCKETS (2026-07-30, scrutiny F6). BalanceOf reports maturing +
	// matured, so a maturing-only guard here refuses a wholly-matured holder
	// their own tokens and tells them they have an "insufficient balance" that
	// the same contract reports as ample — the send button shows 1000 and the
	// call reverts.
	bal := totalBalance(s, creator, from)
	if mLt(bal, amount) {
		return newErr(ErrBalance, "insufficient balance")
	}

	// ★ THE DEBIT MUST COVER BOTH BUCKETS TOO (2026-07-30, Phase-0 model INV-9).
	// The guard above was widened to totalBalance while this line still drew
	// from the maturing family alone — so the comment "unreachable given the
	// check above" became FALSE the moment a holder had any matured tokens: the
	// guard admitted the call and the debit then failed underneath it. A guard
	// and a debit that disagree about what a balance IS is the shape that ends
	// in a partial write, and it is what every sibling path (Sell, Refund,
	// RefundHolder, Ask) already avoids by using debitPosition.
	//
	// Maturing first, then matured — the same fixed order every other exit uses
	// (splitDraw). The split is read BEFORE the debit so the credit legs below
	// can place each part in the right bucket.
	_, fromMaturing := splitDraw(s, creator, from, amount)
	fromMatured, err := mSub(amount, fromMaturing)
	if err != nil {
		return err // unreachable: fromMaturing <= amount by construction
	}
	// ★ THE MATURITY THE MOVED TOKENS CARRY — THEIR OWN COHORTS, read BEFORE
	// anything moves (2026-09-08, the transfer-hop launder fix).
	//
	// WHAT THIS REPLACED, and why it was the whole PRICE-1 / X3 hole: this used
	// to read `holderAcqBlock(s, creator, from)` — the sender's SINGLE BLENDED
	// clock — and hand that one number to creditInflowAt, which stamped it as
	// the recipient's new cohort. A sender holding an aged pile plus a fresh
	// slice therefore EXPORTED THE BLEND: the fresh tokens arrived at the
	// recipient carrying the aged pile's diluted rate, in ONE hop, in the same
	// block, and the sale-side cohort floor could not detect it because at the
	// recipient the blend and the cohort now agreed. Measured on the pre-fix
	// tree: 90.87% of the exit tax avoided on a 4,000-token pile and 99.93% on a
	// 4,000,000-token pile, on BOTH the curve-Sell and the wind-down-Refund
	// rail, reusable daily against a pile that is never consumed.
	//
	// lotsDrawFreshest returns exactly the cohorts the debit below removes
	// (lotsDebit consumes freshest-first), so the tokens the sender loses and
	// the tokens the recipient gains are the SAME tokens with the SAME clocks.
	// A legacy un-ledgered sender synthesises one cohort at their stored clock,
	// which is byte-for-byte the old behaviour — no migration, no flag day.
	drawn := lotsDrawFreshest(s, creator, from, fromMaturing)
	if err := debitPosition(s, creator, from, amount); err != nil {
		return err // unreachable given the total-balance check above
	}
	// A matured token stays matured for whoever receives it — that is what makes
	// matured tokens interchangeable, and crediting them into the recipient's
	// MATURING bucket would silently restart a 42-day clock on tokens that had
	// already served it.
	if fromMatured.Sign() > 0 {
		setMatured(s, creator, to, mAdd(getMatured(s, creator, to), fromMatured))
	}
	if fromMaturing.Sign() == 0 {
		return nil // nothing maturing moved; the clock legs below have no work
	}
	// The recipient's balance grows and the moved tokens' own maturity —
	// capped at ExitTaxDecayBlocks inside creditInflowAt — re-averages into
	// whatever they already hold, COHORT BY COHORT. Maturity travels with the
	// tokens and is neither created nor destroyed by the move (see the file
	// header; properties P2/P3). RULING K deleted the cost basis, so nothing
	// else moves with them. Infallible (holdclock.go).
	//
	// F-C1 DELIBERATELY DOES NOT graduate the recipient here (2026-07-31, USER
	// RULING).
	//
	// ★ THE LINE BETWEEN THIS AND THE ESCROW LEGS, spelled out 2026-08-19 after
	// PRUNED finding F18 read the two rules as contradicting each other. Reclaim
	// is permissionless, so a STRANGER can push someone's abandoned escrow and
	// that push graduates the asker — which looks like the very act this ruling
	// refuses. It is not the same act. Here a third party's OWN tokens arrive as
	// an inflow the recipient never asked for; there, the asker's OWN tokens come
	// back from an escrow the asker opened, and the graduate protects them
	// (banking their cleared pile BEFORE the return re-averages into it, F-C8).
	// The test that pins it is TestReclaim_OutcomeIsIdenticalWhoeverPushesIt:
	// a stranger's push must leave the asker in exactly the state their own push
	// would have. What a third party must never do is CHOOSE something for you;
	// pressing a button that returns your own property on your own terms is not
	// that.
	//
	// Unlike the escrow-return legs (Answer/Reclaim/Decline), a transfer's
	// inflow is chosen by a THIRD PARTY, and graduating the recipient's aged pile
	// would segregate it into MATURED while leaving the sender's fresh gift alone in
	// the maturing bucket. A maturing-first Sell would then force the recipient to
	// sell that gift FIRST at max tax on the EXPENSIVE upper curve slice, relegating
	// their own tokens to the cheap lower slice — a "poisoned gift" that makes the
	// recipient worse off on immediate liquidation (verified against
	// TestSell_OUTFLOWK1 / the OUTFLOWCLIFF1 / P4 grief suite). So no graduate()
	// call is added here, and F-C8's matured-split (moved MATURED tokens stay
	// matured) is separate and unaffected.
	//
	// ★★ WHAT F-C1's PREMISE ASSUMED, AND WHY CARRYING THE COHORTS DOES NOT
	// BREAK IT (2026-09-08). The ruling weighed "graduate the recipient" against
	// "blend the recipient", and chose the blend because its grief is BOUNDED: a
	// gift can raise the recipient's rate by at most the donated fraction. Both
	// options were about ONE clock for the whole position. The cohort ledger is a
	// third option the ruling did not have: the gift arrives as ITS OWN cohort
	// and therefore CANNOT move the rate of any cohort the recipient already
	// holds — structurally, not by a bound. The recipient's aged tokens stay
	// aged, in the maturing bucket, and still owe 0.
	//
	// The gift itself is still taxed at its own (fresh) rate on the dear top
	// slice — that part of the poisoned gift is real, and it is unchanged by THIS
	// leg: it was already true before this change, because lotsCreditInflow
	// already stamped the gift as a separate cohort. What this leg changes is
	// only WHICH clock the gift arrives with, and it can only ever move that
	// clock toward the already-reachable worst case (an attacker who buys in the
	// front-run block gifts at MaxExitTaxBps today, at no extra cost). So the
	// F-C1 grief CEILING is untouched, while the launder that rode the same
	// blend is closed. Measured both ways in FIX-TRANSFER-LAUNDER.md.
	creditInflowCohorts(s, creator, to, drawn, block)
	return nil
}
