package core

import "math/big"

// buy.go — Buy: mint n tokens along the curve (WAVE A, RULINGS-2026-07-21;
// exact-integer spec: MONEY-MATH CORE §1/§2, LOCKED-MECHANISM "Curve").
//
// Buy is an INFLOW — the one side of the curve that IS gated: it routes
// through RequireInflowOpen (phase ACTIVE/OVERDUE + the global pause), the
// single chokepoint every new-inflow path in this package shares. Sell is the
// outflow and is gated on NEITHER the pause nor the subscription — see
// sell.go's rail-switch doc for the asymmetry.
//
// WHAT A BUY DOES, EXACTLY (C-7/C-8/C-19 are asserted as equalities in
// tests):
//
//	cost  = BuyCost(S, n)              the EXACT area step area(S+n) − area(S)
//	                                   (RULING A / curve.go L1 — no longer an
//	                                   independently-ceiled slice; the ceil
//	                                   dust was an unallocated remainder in
//	                                   the reserve, forbidden by the equality
//	                                   invariant)
//	fee   = floor(cost·TradeFeeBps/1e4), split 5/5, odd unit → platform
//	S    += n                          minted to the caller
//	R    += cost                       the curve leg ONLY — the fee NEVER
//	                                   enters kReserve (C-19); it accrues to
//	                                   the pull pots (tradefee.go, F8)
//	bal/wacq update                    via creditInflow (holdclock.go): the
//	                                   clock averages toward `block` so
//	                                   bought tokens are fresh (maximum exit
//	                                   tax RATE). RULING K deleted the cost
//	                                   basis — the exit tax is gross proceeds
//	                                   × τ(h), no realized-gain cap, so a Buy
//	                                   no longer records what was paid
//	RecordObs(spotRate(S+n))           the curve becomes the price source
//	                                   (RULINGS "WIRING")
//
// The wasm wrapper draws TotalDue = cost + fee from the buyer in ONE
// HiveDraw, after this call mutates state (CEI, state-first; a failed draw
// reverts the whole transaction, state included). Slippage protection is the
// buyer's own signed transfer.allow on that draw — the exact role API.md
// documents transfer.allow playing for every HBD leg in this codebase. Ask
// needed a separate maxCredits parameter because its variable leg is CREDITS,
// which no HBD allowance bounds; Buy's variable leg IS the HBD draw, so the
// allowance already bounds it and a second in-core cap would be a redundant
// copy of the same guard.
//
// ZERO PREMINE (LOCKED-MECHANISM "Launch"): Buy mints only to the paying
// caller at full curve cost. There is no creator allocation, no discounted
// first slice, no primary-sale path — a creator who wants their own token
// buys it like anyone else. (Anti-snipe launch shaping is Wave D; the
// primitive here deliberately has no launch special-casing to interact with
// it.)
//
// R === area(S) (C-9, THE invariant), the induction step this operation
// owns — by L1's equality (curve.go): given R == area(S) before the call,
//
//	R' = R + buyCost(S,n) = area(S) + [area(S+n) − area(S)] = area(S+n) = area(S')
//
// Equality in, equality out — definitional, because BuyCost IS the exact
// area step. The hypothesis is established at genesis (S=0, R=0,
// area(0)=0; Register mints nothing), and every other kReserve writer
// (Sell, and refund.go's wind-down pair — which only ever runs after buys
// are structurally dead) preserves its own side; the PAR mint that used to
// violate it is DELETED (RULING A / prepay.go's removal). No unallocated
// remainder can form, which is the whole point: the governing theorem's
// "no fresh buyer ever profits at wind-down" needs the reserve to hold
// exactly what the curve owes and not a unit more.

// BuyResult carries every amount the wasm wrapper and the event log need.
// All fields are freshly-allocated big.Ints owned by the caller.
type BuyResult struct {
	Minted      *big.Int // tokens minted == n
	Cost        *big.Int // curve leg — what entered kReserve
	Fee         *big.Int // total trade fee (Cost·TradeFeeBps/1e4, floored)
	FeeCreator  *big.Int // accrued to kFeeBal(creator) (pull, F8)
	FeePlatform *big.Int // accrued to kTreasury() (pull via WithdrawTreasury)
	TotalDue    *big.Int // Cost + Fee — the wrapper's single HiveDraw amount
	// Graduated is how many tokens moved into the tradable bucket as a side
	// effect of this call (see the graduate() call in Buy for why it runs
	// BEFORE the credit). The wrapper emits the standard mint-shaped transfer
	// event for it.
	Graduated    *big.Int
	RateRecorded *big.Int // spotRate(S+n) fed to RecordObs (twap.go may ignore
	//                       a duplicate-block or non-positive rate by its own
	//                       contract; this is what was OFFERED)
}

// buyCompute runs every guard and all the math for a buy WITHOUT mutating
// state — shared verbatim by Buy (which then applies the writes) and QuoteBuy
// (which returns it as a preview), so a quote can never drift from execution.
func buyCompute(s Store, creator string, block uint64, n *big.Int) (*BuyResult, error) {
	if !validAccount(creator) {
		return nil, newErr(ErrInput, "invalid creator account")
	}
	// Market existence checked directly for a precise ErrNotFound — an
	// inflow against an account that never registered should say "no such
	// market", not whatever generic phase error a zero-valued market would
	// otherwise derive to (the deleted PAR mint's existence guard, reasoning
	// preserved here).
	if getU64(s, kRegisteredAt(creator)) == 0 {
		return nil, newErr(ErrNotFound, "no such market")
	}
	// The inflow gate: phase ACTIVE/OVERDUE and the global pause both live
	// here. Buy is an inflow; this is the one curve side that gets gated.
	if err := RequireInflowOpen(s, creator, block); err != nil {
		return nil, err
	}
	if n == nil || n.Sign() <= 0 {
		return nil, newErr(ErrInput, "token amount must be positive")
	}

	supply := getMoney(s, kSupply(creator))
	newSupply := mAdd(supply, n)

	// The cap is deliberate scarcity — "the speculation switch" — and under
	// the curve it denominates TOKENS (money-math §8.5). Reject outright
	// rather than partial-fill.
	cap := getMoney(s, kCap(creator))
	if mGt(newSupply, cap) {
		return nil, newErr(ErrCap, "buy would exceed the market cap")
	}

	cost := BuyCost(supply, n) // the exact area step (L1) — R stays === area(S)
	fee, feeC, feeP := tradeFeeOn(cost)
	totalDue := mAdd(cost, fee)

	// BUY-INT64 pre-commit guard (PRUNED 2026-07-22, defense-in-depth): the
	// wasm wrapper narrows this HBD leg to int64 for sdk.HiveDraw AFTER Buy
	// commits state; reject a > MaxInt64 draw HERE, before any write, so the
	// failure is a clean typed rejection rather than a post-commit host Abort
	// whose state-atomicity is a runtime property we do not want to depend on.
	// Unreachable with real HBD (MaxInt64 base units == 9.2e15 HBD, more than
	// exists) — this only fires on a self-harm-scale firstBuy/cap.
	if !totalDue.IsInt64() {
		return nil, newErr(ErrInput, "total cost exceeds the maximum payable HBD amount; reduce the token quantity")
	}

	return &BuyResult{
		Minted:       new(big.Int).Set(n),
		Cost:         cost,
		Fee:          fee,
		FeeCreator:   feeC,
		FeePlatform:  feeP,
		TotalDue:     totalDue,
		RateRecorded: SpotRate(newSupply),
	}, nil
}

// Buy mints n tokens on `creator`'s curve to `caller`. Returns the amounts
// for the wrapper (draw TotalDue from the buyer) and the event log. Every
// guard runs before any write — a rejected call mutates nothing.
func Buy(s Store, caller, creator string, block uint64, n *big.Int) (*BuyResult, error) {
	// validAccount, not merely non-empty: caller is concatenated into
	// kBal/kAcqBlock keys with no escaping — the package-wide '|' collision
	// guard every sibling fund path applies at the door.
	if !validAccount(caller) {
		return nil, newErr(ErrAuth, "invalid caller account")
	}
	r, err := buyCompute(s, creator, block, n)
	if err != nil {
		return nil, err
	}

	// ---- writes (all guards passed; nothing below can reject — RULING G) ----
	supply := getMoney(s, kSupply(creator))
	setMoney(s, kSupply(creator), mAdd(supply, n))
	// kReserve writer #1 of the exactly-four (refund.go's writer table:
	// Buy, Sell, Refund, RefundHolder). The CURVE LEG ONLY — never
	// TotalDue: booking the fee into the reserve would break R === area(S)
	// upward and pay it back out to holders at wind-down (C-19 forbids
	// exactly that).
	addMoney(s, kReserve(creator), r.Cost)
	// ★ GRADUATE BEFORE CREDITING (2026-07-30). This one line is most of what
	// the two-bucket split buys. The hold clock is a size-weighted average over
	// the maturing balance, so a fresh purchase landing on top of an aged pile
	// drags the whole pile's clock forward — which both delays the old tokens'
	// maturity and hands the new ones a head start they did not earn. That is
	// the "accelerated maturation" residual, and it is why an aged position used
	// to be a permanent, reusable tax shield.
	//
	// Graduating first moves everything already past the window OUT of the
	// average, so the incoming purchase can only ever dilute tokens that are
	// themselves still maturing. The shield stops being reusable: to run it
	// again you must hold a large position for a full window, and it leaves the
	// moment it matures.
	//
	// Placed in the write phase, after every guard: it mutates, so it must not
	// run anywhere a call could still be rejected (RULING G).
	r.Graduated = graduate(s, creator, caller, block)
	// Balance + hold clock in one chokepoint helper — bought tokens are
	// CLOCKED fresh, which is what keeps the exit tax RATE sybil-proof.
	// Infallible (holdclock.go — RULING A4 deleted the WA aggregate, RULING J
	// deleted the accrual settle, RULING K deleted the cost basis).
	creditInflow(s, creator, caller, n, block)
	// Fee accrual — pull pots only, never a push, never the reserve (F8).
	accrueTradeFee(s, creator, r.FeeCreator, r.FeePlatform)
	// The curve IS the price source (RULINGS "WIRING"): every trade offers
	// the post-trade marginal rate — the price of the slice top — to the TWAP
	// ring. First-writer-per-block and the non-positive-rate filter are
	// RecordObs's own documented semantics; a fresh market with S+n too small
	// for a positive rate simply records nothing yet.
	RecordObs(s, creator, block, r.RateRecorded)
	return r, nil
}

// QuoteBuy is the read-only preview of Buy for the wrapper's quote path
// (Wave D wires the entrypoint): identical guards, identical math, ZERO
// writes — it shares buyCompute with Buy so the two can never disagree. The
// caller identity plays no role in buy pricing (no tax on the way in), so a
// quote needs no caller parameter.
func QuoteBuy(s Store, creator string, block uint64, n *big.Int) (*BuyResult, error) {
	return buyCompute(s, creator, block, n)
}
