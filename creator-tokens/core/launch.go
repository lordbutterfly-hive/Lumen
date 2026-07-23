package core

import "math/big"

// launch.go — the LAUNCH: registration plus an OPTIONAL creator first buy,
// executed as ONE state transition (RULING H, RULINGS-v2-2026-07-21).
//
// ---------------------------------------------------------------------------
// WHAT THIS IS
//
// RegisterWithFirstBuy(..., firstBuy = n) does exactly two things, in one
// call and one atomic state transition:
//
//	1. everything Register does (market.go's registerCheck/registerApply), and
//	2. if n > 0, a completely ordinary Buy of n tokens by the creator, at the
//	   FULL curve cost area(n) plus the full 10% trade fee.
//
// n == 0 (or a nil firstBuy) is the plain registration and is the default:
// the buy is OPTIONAL. There is no discount, no premine, no reserved
// allocation, no separate primary-sale price. The creator pays exactly what
// the first outside buyer would have paid for the same slice — LOCKED-
// MECHANISM's "Zero free creator launch allocation" is preserved literally,
// and the reserve invariant R === area(S) is preserved because this IS
// core.Buy, not a parallel implementation of it (see THE EQUIVALENCE below).
//
// ---------------------------------------------------------------------------
// WHAT IT IS NOT — READ THIS BEFORE WRITING ANY MARKETING COPY
//
// ★ THIS IS NOT AN ANTI-SNIPE MECHANISM AND MUST NEVER BE DESCRIBED AS ONE. ★
//
// It is OPTIONAL, and an optional device cannot bound an adversary. At n == 0
// — the default, the case where a creator registers and does nothing else —
// a bot takes the bottom of the curve outright, and this file has done
// nothing about it. What actually holds the floor is BasePrice (params.go,
// RULING H/I): a nonzero intercept, in the bytecode, that no caller chooses.
// RULING I's own correction is explicit that BasePrice is a LARGER lever than
// the curve exponent and that lowering it re-opens sniping fast (0.050 HBD
// per token ⇒ a 185x first-mint snipe).
//
// THE RESIDUAL SNIPE ADVANTAGE, MEASURED AT THE RULED CURVE (BasePrice=1000,
// a=63/8, b=21/8000 — computed directly from Area, not estimated):
//
//	the very first token costs area(1) = 1,007 base units (1.007 HBD)
//	  ... and redeems for 11,500 units if the market reaches S = 1,000
//	      → 11.42x gross, 9.34x after the 10% round-trip trade fee,
//	        7.47x if the sniper also pays the full 20% exit tax
//	  ... 48,250 units at S = 3,000 → 47.91x / 39.20x / 31.36x
//	the first 100 tokens cost 140,656 units (140.656 HBD)
//	  ... → 7.72x / 6.32x / 5.05x at S = 1,000
//	  ... → 33.48x / 27.39x / 21.91x at S = 3,000
//
// So being first is still worth roughly an order of magnitude on a market
// that grows. That is the DELIBERATE, RULED level of early-buyer premium
// (RULING I chose it against friend.tech's 267x), not an accident this file
// removes.
//
// WHAT THE ATOMIC FIRST BUY DOES BUY, precisely and only: it is
// UN-FRONT-RUNNABLE STRUCTURALLY, so a creator who DOES want the bottom
// slice cannot be beaten to it by a bot watching the mempool. The argument is
// structural, not economic, and does not depend on transaction ordering —
// which matters, because intra-block order on this chain is PRODUCER-chosen
// and not consensus-enforced (RULING H: anti-snipe must be order-aware, and
// "register, then buy in the next transaction" is not):
//
//	Buy requires kRegisteredAt(creator) != 0 (buy.go's existence guard), and
//	Register requires caller == creator (the identity binding). So the market
//	does not exist as a buyable object until the creator's own transaction
//	runs, and when it does run, the creator's slice is minted inside the same
//	transition. There is NO state — not one block, not one intra-block slot —
//	in which the market is live and the creator's slice is not yet taken.
//	A producer has nothing to order in between because there is no "between".
//
// It bounds nothing else. In particular:
//
//   - a creator who passes n == 0 has bought no protection whatsoever;
//   - a creator who passes a small n still leaves the rest of the bottom of
//     the curve to whoever lands the next transaction;
//   - there are NO per-account launch caps in this codebase, and if there
//     ever are they will be per-ACCOUNT, not per-owner (RULING H, binding).
//     Hive accounts are cheap and unlimited, so a sybil ring can corner a
//     launch by splitting one buyer across many accounts. It costs them the
//     FULL curve price for every token — that is the only real deterrent, and
//     it is a price deterrent, not an access control. Never claim a launch
//     cap prevents cornering.
//
// ---------------------------------------------------------------------------
// THE EQUIVALENCE (why there is no second copy of the buy math)
//
// This file calls core.Buy. It does not re-implement the curve step, the fee
// split, the hold clock, the cost basis or the TWAP write. Consequently
//
//	RegisterWithFirstBuy(s, c, c, b, face, cap, n)
//	  ≡ Register(s, c, c, b, face, cap) ; Buy(s, c, c, b, n)
//
// as a state transition, key for key — asserted in launch_test.go by
// comparing complete store dumps. Any future change to Buy is inherited here
// automatically; drift is impossible rather than merely tested against.
//
// THE ORDERING IS THE RULING-G DISCIPLINE. Every guard for BOTH halves runs
// BEFORE the first write (registerCheck, then launchBuyCheck), so a rejected
// launch mutates nothing — not a half-registered market, not a market with a
// reserve and no supply. Only then does registerApply write, and only then
// does Buy run. Buy CANNOT fail at that point, and the proof is enumerated
// against buy.go's own guard list in launchBuyCheck's comment; the
// unreachable branch panics rather than returning, because a partially
// applied launch is the one outcome that must not be representable (a panic
// traps and reverts the whole transaction in the wasm runtime, exactly as
// util.go's setMoney negative-guard already relies on).
// ---------------------------------------------------------------------------

// RegisterResult is what the wasm wrapper needs to settle the launch.
//
// TotalDue is ALWAYS non-nil and is the single HBD amount to draw from the
// creator: 0 for a plain registration (registration is FREE — market.go), or
// the first buy's cost + trade fee. FirstBuy is nil when no launch buy was
// requested, and is otherwise the exact same *BuyResult an ordinary Buy would
// have returned, so the wrapper's event log and the indexer can treat a
// launch buy as what it is — a buy.
type RegisterResult struct {
	FirstBuy *BuyResult // nil when firstBuy was nil/zero
	TotalDue *big.Int   // HBD to draw from the creator; 0 when there is no launch buy
}

// RegisterWithFirstBuy registers `creator`'s market and, if firstBuy > 0,
// mints that many tokens to the creator at full curve cost in the same state
// transition. firstBuy may be nil or zero (the plain registration); it may
// never be negative.
//
// Creator-only, exactly like Register — the launch buy is minted to the
// caller, who registerCheck has already proven IS the creator, so there is no
// path by which this function mints a launch slice to anybody else.
func RegisterWithFirstBuy(s Store, caller, creator string, block uint64, face, cap int64, firstBuy *big.Int) (*RegisterResult, error) {
	// ---- guards for BOTH halves, before any write (RULING G) ----
	if err := registerCheck(s, caller, creator, face, cap); err != nil {
		return nil, err
	}
	n, err := launchBuyCheck(block, cap, firstBuy)
	if err != nil {
		return nil, err
	}

	// ---- writes ----
	registerApply(s, creator, block, face, cap)
	if n == nil {
		return &RegisterResult{FirstBuy: nil, TotalDue: mZero()}, nil
	}

	res, err := Buy(s, caller, creator, block, n)
	if err != nil {
		// UNREACHABLE — launchBuyCheck proved every one of Buy's guards
		// against the state registerApply has just written. Panicking rather
		// than returning is deliberate and is the safer of the two: the
		// registration writes are already applied, so returning an error here
		// would leave a market registered with no first buy while telling the
		// caller the whole call failed — a state mutation on a "rejected"
		// call, which is exactly what RULING G forbids. A panic traps in the
		// wasm runtime and reverts the entire transaction (nothing mutates),
		// and fails the test run loudly at the exact site, the same
		// discipline util.go's setMoney negative-write guard already uses.
		panic("launch: Buy rejected a pre-validated launch buy: " + err.Error())
	}
	return &RegisterResult{FirstBuy: res, TotalDue: new(big.Int).Set(res.TotalDue)}, nil
}

// launchBuyCheck validates the optional launch buy against the market
// registerApply is ABOUT to create, and returns the token count to mint, or
// nil for "no launch buy". Pure: it reads no state and writes none, because
// the state it would need to read does not exist yet — the whole point of
// doing this before registerApply.
//
// It re-derives, from the parameters alone, every guard buy.go applies, so
// that the Buy call after registerApply is provably infallible. Against
// buyCompute's list, in its order:
//
//	validAccount(creator)        — registerCheck proved it.
//	kRegisteredAt(creator) != 0  — registerApply sets it to `block`, so this
//	                               holds iff block != 0. THAT is why block ==
//	                               0 is refused below rather than special-
//	                               cased: see its own comment.
//	RequireInflowOpen            — globalInflowPaused: registerCheck proved
//	                               it clear and registerApply never sets it.
//	                               Phase: kState is StateActive (not CLOSED),
//	                               the retire mark is cleared by
//	                               registerApply, and paidUntil is
//	                               block+SubscriptionPeriod > block, so the
//	                               phase is ACTIVE. (Even in the impossible
//	                               overflow case paidUntil < block, the phase
//	                               would be OVERDUE — still inflow-open.)
//	n != nil && n > 0            — proved below.
//	supply+n <= cap              — supply is 0 (registerCheck refused a
//	                               non-zero one and registerApply does not
//	                               write it), so this is n <= cap, proved
//	                               below against the same `cap` registerApply
//	                               is about to store.
//	validAccount(caller)         — caller == creator, proved by registerCheck.
//	totalDue.IsInt64()           — the launch cost BuyCost(0,n)+fee fits int64,
//	                               re-derived below (BUY-INT64, PRUNED 2026-07-22).
//
// Nothing else in Buy can reject.
func launchBuyCheck(block uint64, cap int64, firstBuy *big.Int) (*big.Int, error) {
	if firstBuy == nil || firstBuy.Sign() == 0 {
		return nil, nil // the OPTIONAL case: plain registration
	}
	if firstBuy.Sign() < 0 {
		return nil, newErr(ErrInput, "firstBuy must be non-negative")
	}
	// THE GENESIS REFUSAL. A market registered at block 0 stores
	// kRegisteredAt == 0, which every existence check in this package
	// (buy.go, Renew, requireOpenCreatorMarket) reads identically to "never
	// registered" — a documented, genesis-only edge market.go already carries
	// and cannot fix from here. The invariant this refusal buys is worth more
	// than the case it costs: THE LAUNCH PATH MAY NEVER CREATE STATE THE
	// ORDINARY PATH CANNOT REACH. At block 0 an ordinary Buy is impossible,
	// so a launch buy must be impossible too — otherwise block 0 would mint a
	// market holding tokens and a reserve that no subsequent Buy or Sell
	// could ever touch. Refusing costs nothing on a real chain (heights start
	// above 0) and mutates nothing.
	if block == 0 {
		return nil, newErr(ErrInput, "a launch buy is not possible at block 0 (the market would not be addressable); register first, buy after")
	}
	if firstBuy.Cmp(big.NewInt(cap)) > 0 {
		// Same rejection Buy's own cap guard would produce, with the same
		// reason: the cap is deliberate scarcity and is never partial-filled.
		return nil, newErr(ErrCap, "firstBuy exceeds the market cap")
	}
	// BUY-INT64 pre-commit guard (PRUNED 2026-07-22): re-derive buyCompute's
	// int64-fit guard so the Buy below stays provably infallible. The market is
	// fresh (S == 0), so the launch cost is exactly BuyCost(0, firstBuy) + fee;
	// reject a > MaxInt64 draw HERE rather than let Buy reject it after
	// registerApply has written (which would trip the "pre-validated launch buy
	// cannot fail" panic — the exact invariant this function upholds).
	cost := BuyCost(mZero(), firstBuy)
	fee, _, _ := tradeFeeOn(cost)
	if !mAdd(cost, fee).IsInt64() {
		return nil, newErr(ErrInput, "total cost exceeds the maximum payable HBD amount; reduce the launch buy")
	}
	return new(big.Int).Set(firstBuy), nil
}
