package core

import "math/big"

// settlement.go — the service settlement rate and spend derivation
// (RULING C, RULINGS-v2-2026-07-21). This is what prices EVERY token-settled
// service: Ask (ask.go). RULING C3: every consumer uses the SAME derivation
// — no consumer gets a different window.
//
// WHAT THE PREVIOUS VERSION DID AND WHY IT WAS WRONG: SettlementRate lived
// in ask.go and returned "the short TWAP when its guards pass, PAR (1 base
// unit per token) otherwise", with NO error path. PAR is not a safe default:
// it is wrong by exactly the factor `spot`, ALWAYS in the asker-robbing
// direction — at the compiled curve a MinFace (0.1 HBD) service against a
// market whose token trades at ~100 base units cost ceil(100/1) = 100 tokens
// where correct pricing costs ceil(100/100) = 1, a 100x overcharge on a live
// code path — and the fallback fired on perfectly ordinary conditions (a
// market quiet for 3 days trips MaxStaleBlocks; a >20% move trips the median
// deviation guard). RULING C: settlement must be able to REFUSE, and a
// refusal is safe BY CONSTRUCTION here because every settlement consumer is
// an inflow (see "refusal gates no funds" below).
//
// THE RATE (RULING C1):
//
//	rate = min( AskRate       — the ~hours window (twap.go),
//	            askRateLong   — the 7-day window (twap.go),
//	            SpotRate(S)   — the curve's live marginal price (curve.go) )
//
// Each arm covers the others' failure mode:
//   - The SPOT arm is the no-arbitrage ceiling and it is load-bearing:
//     tokens are mintable on demand, so a service must never settle at a
//     rate ABOVE spot — c = ceil(F/rate) >= F/rate, and every token in
//     [S, S+c) costs more than spot(S) (price is strictly increasing), so
//     buyCost(S, c) >= c·spot >= F whenever rate <= spot: the c tokens the
//     creator receives can never be worth less ON THE CURVE than the face
//     the asker owed. The ruling's sweep: 36,270 combinations, 0 violations;
//     settling at R/S instead violated in 46% of cases (worst case 8,799,780
//     base units of free money). See the RULING-J note below for why R/S
//     stopped being a competing candidate at all.
//   - The SHORT TWAP arm absorbs a transient spot spike (a pump inside one
//     window cannot raise the min above the recent average).
//   - The LONG TWAP arm absorbs a sustained short-window walk: to lift it an
//     attacker must hold real supply (real curve capital, fees, exit tax)
//     across ~days of 6300-block samples — at which point the elevated rate
//     IS the market price by any honest definition.
//   - The DOWN direction (a walked-down rate inflates the token count) is
//     NOT bounded by the min — it is bounded by the asker's own signed
//     maxCredits cap and by the spend cap below (RULING C2's second half).
//
// RULING J COLLAPSES THE RATE CONTRADICTION (verified with numbers in
// TestSettlement_RulingJCollapsesRateContradiction): when the reserve can
// exceed the curve area (E = R − area(S) > 0, the pre-J state), there are
// TWO defensible settlement rates and they CONTRADICT: value-conservation
// says settle at backing R/S (a token redeems R/S at wind-down), while
// no-arbitrage says settle at or below spot (tokens are mintable at spot on
// demand) — and in a diverged market R/S >> spot (the rulings' own exhibit
// re-computed at the compiled curve: S=100, E=960,090,850 gives floor(R/S) =
// 9,602,315 against spot(100) = 1,813, a 5,296x gap; ANY rate satisfies at
// most one constraint). RULING J's
// R === area(S) equality kills the divergence: R/S = area(S)/S is the
// curve's AVERAGE price, which never exceeds the marginal spot for a
// non-decreasing price curve — so every rate <= spot now automatically
// respects value-conservation too, and the contradiction is gone. That is
// WHY min(TWAPs, spot) is a complete answer here and R/S never needs to be
// (and must not be) an input.
//
// REFUSAL GATES NO FUNDS (RULING C / RULING G): the ONLY caller of
// SettlementRate/settleSpend is Ask — a new-service INFLOW, already gated on
// RequireInflowOpen. No outflow (Sell, Refund,
// RefundHolder, Reclaim, Answer, TransferCredits, ClaimTradeFees,
// WithdrawTreasury) consults settlement: escrows resolve at their RECORDED
// credit amounts, wind-down pays pro-rata off (R, S), the curve pays exact
// area steps. So a market that cannot price services refuses NEW service
// inflows and nothing else — proven end-to-end by
// TestSettlementRefusalGatesNoOutflow, which freezes settlement (no
// observations at all) and exercises every outflow.

// SettleQuote is what settleSpend derives: the rate used and the exact
// token count a face-priced service costs at it. Both freshly allocated.
type SettleQuote struct {
	Credits *big.Int // ceil(tokenLeg/rate) — RULING C keeps the ceil (floor would admit c == 0, a free service)
	Rate    *big.Int // min(TWAP_short, TWAP_long, spot)
	// CommissionHbd is the HBD leg of the SAME posted face these credits were
	// derived from (splitFace, ask.go — USER RULING 2026-07-27). It is set
	// only by settlePosted; a bare settleSpend call leaves it nil, because a
	// raw token leg has no posted face to take a commission from. Ask gates
	// on THIS value rather than recomputing the commission, so the
	// credit leg and the HBD leg can never be derived from two different faces.
	CommissionHbd *big.Int
}

// SettlementRate derives the rate (HBD base units per token) every service
// settles at, or REFUSES with a typed error (RULING C — the signature change
// from the PAR version is the ruling's point). Never returns a rate above
// the curve's live spot, never zero, never negative, never a fallback.
func SettlementRate(s Store, creator string, block uint64) (*big.Int, error) {
	supply := getMoney(s, kSupply(creator))
	if supply.Sign() == 0 {
		// No supply -> no traded token -> nothing to denominate a token
		// settlement in. SpotRate(0) is 0 by package convention (curve.go);
		// refusing here keeps "never a non-positive rate" structural.
		return nil, newErr(ErrOracle, "no supply: no token exists to settle in")
	}

	short, err := AskRate(s, creator, block)
	if err != nil {
		return nil, err
	}
	long, err := askRateLong(s, creator, block)
	if err != nil {
		return nil, err
	}
	spot := SpotRate(supply) // > 0: supply >= 1 and price(i) >= BasePrice

	rate := mMin(mMin(short, long), spot)
	if rate.Sign() <= 0 {
		// Unreachable: all three arms are positive by their own contracts.
		// Kept as the same defense-in-depth every "provably can't happen"
		// path in this package carries.
		return nil, newErr(ErrArith, "settlement rate non-positive")
	}

	// RULING C5 — the divergence circuit-breaker, kept as a TRIPWIRE: under
	// R === area(S), backing-per-token ceil(R/S) is (average curve price,
	// ceiled), which sits below spot and therefore below 4·rate whenever the
	// TWAPs track the curve at all. If this fires, either the equality
	// invariant is broken (state corrupt — refuse loudly, exactly like
	// sell.go's own solvency pre-check) or the market just moved ≳4x in
	// average-price terms inside the TWAP windows (refuse and self-heal as
	// the windows catch up). Refusing is safe: services are an inflow.
	backing := mMulDivCeil(getMoney(s, kReserve(creator)), big.NewInt(1), supply)
	limit := new(big.Int).Mul(rate, new(big.Int).SetUint64(DivergenceRateMultiple))
	if backing.Cmp(limit) > 0 {
		return nil, newErr(ErrState, "backing per token exceeds 4x the settlement rate (divergence tripwire)")
	}
	return rate, nil
}

// settleSpend is the ONE spend derivation all three service paths call
// (RULING C3): rate + guards + token count. Package-private on purpose —
// call sites must not re-derive any piece of this differently.
//
// Guard order (each is independent; the order is fixed so tests can pin
// which refusal fires): rate derivation (incl. C5) -> C4 min-price -> C2
// depth ceiling -> spend cap.
func settleSpend(s Store, creator string, block uint64, face *big.Int) (*SettleQuote, error) {
	if face == nil || face.Sign() <= 0 {
		// Callers guard this with their own precise "no price set" errors;
		// kept for defense-in-depth (settleSpend must never divide by or
		// price a non-positive face).
		return nil, newErr(ErrInput, "face must be positive")
	}
	rate, err := SettlementRate(s, creator, block)
	if err != nil {
		return nil, err
	}

	supply := getMoney(s, kSupply(creator))
	lo, hi := serviceFaceBounds(rate, supply)

	// SET-2/SET-3 DIAGNOSTIC (adversarial fix round 1, 2026-07-22): when the
	// C4 floor sits ABOVE the C2 ceiling there is NO legal face at all, and
	// reporting that as either a "price too low" or a "price too high" error
	// sends the creator chasing a number that does not exist. At the compiled
	// curve this is exactly S == 1 (floor 504, ceiling 503). Say so.
	if lo.Cmp(hi) > 0 {
		return nil, newErr(ErrState, "market too small to price any service: no face satisfies both the minimum-price guard and the depth ceiling at this supply")
	}

	// RULING C4 — the minimum-price guard: face·2 >= rate, i.e.
	// face >= ceil(rate/2) (identical over the integers). A spend is a whole
	// number of tokens, so the minimum possible spend is ONE token's worth
	// (`rate`); a face below rate/2 would overcharge the asker by more than
	// 2x on the rounding alone (the ruled exhibit: a 0.1 HBD service against
	// a 50 HBD token is a 500x overcharge — at ZERO divergence, so no other
	// guard catches it).
	//
	// HONEST PRODUCT LIMIT, now surfaced rather than discovered at the
	// revenue call (SET-2): this floor is half a token, and the token price
	// grows quadratically with supply, so the cheapest service a market can
	// sell RISES as the market succeeds — 0.907 HBD at S=100, 5.750 at
	// S=1,000, 604.250 at S=20,000 — and above S ≈ 85,798 the floor exceeds
	// MaxFace and NO legal face exists at all. A creator's existing price can
	// therefore go dead purely because their own token appreciated, and the
	// 2x/7d face band throttles how fast they can chase it. The structural
	// cure is sub-token settlement granularity (credit sub-units), which is a
	// ruling-level change and is NOT in this fix; ServiceFaceRange exports
	// the live window so a wallet can show the creator their floor and
	// ceiling before it bites.
	if face.Cmp(lo) < 0 {
		return nil, newErr(ErrState, "face below half of one token's value (minimum-price guard): the smallest possible spend of 1 token would overcharge more than 2x")
	}

	// RULING C2 — the depth ceiling, measured against area(S), NEVER the
	// reserve: face·10000 <= MaxServiceFaceAreaBps·area(S). The reserve-
	// relative v1 version was backwards (divergence IS the reserve being
	// large relative to S: it read 480,048 HBD on the diverged exhibit —
	// never binding when needed — and over-bound a healthy market; the
	// area-relative form reads 2.5 HBD there and actually binds). Under
	// R === area(S) the two coincide on healthy state, and this form stays
	// correct even when the state is corrupt.
	if face.Cmp(hi) > 0 {
		return nil, newErr(ErrState, "face exceeds the market depth ceiling (50% of curve area)")
	}

	// RULING C: KEEP ceil(face/rate) for the token count — floor would admit
	// c == 0, a free service. c >= 1 is structural (face >= 1, ceil).
	credits := creditsForAsk(face, rate)
	if credits.Sign() <= 0 {
		return nil, newErr(ErrArith, "credits spent rounds to zero") // unreachable; defense-in-depth
	}

	// RULING C2's spend cap: c·10000 <= S·MaxSpendSupplyBps (5% of supply).
	// Load-bearing against DOWN-manipulation of spot: min() FOLLOWS a
	// walked-down rate, which inflates c — the asker consents via their
	// signed maxCredits, but without this cap one settlement on a
	// down-walked market could move an unbounded fraction of the supply.
	// Ships in the same commit as the spot arm, per the ruling.
	//
	// SET-3 FIX (adversarial fix round 1, 2026-07-22) — the cap is SKIPPED
	// for a one-credit spend, and that is not a weakening. `credits` is
	// ceil(face/rate) and therefore structurally >= 1, so the raw comparison
	// was UNSATISFIABLE for every supply below 10000/MaxSpendSupplyBps = 20:
	// a market with 1-19 tokens outstanding could never sell any service at
	// any price, and it reported the refusal as a 5%-of-supply violation the
	// asker had not committed (measured: S=5/10/19 all refused, S=20 priced
	// at exactly the boundary). Every newly launched market sat in that dead
	// zone between registration and its 20th token.
	//
	// WHY SKIPPING IS SAFE, precisely: the ruling's stated purpose is to stop
	// "one settlement moving an UNBOUNDED fraction of supply" under a
	// down-walked rate. Down-walking the rate can only ever INCREASE
	// ceil(face/rate); it can never push it below 1. So one credit is the
	// minimum possible spend at ANY rate, is not reachable by manipulation,
	// and admitting it grants an attacker nothing the honest path does not
	// already grant. For credits > 1 the cap is untouched and still binds —
	// that is where the down-walk lever actually lives.
	if credits.Cmp(big.NewInt(1)) > 0 {
		spendLhs := new(big.Int).Mul(credits, big.NewInt(10000))
		spendRhs := new(big.Int).Mul(supply, new(big.Int).SetUint64(MaxSpendSupplyBps))
		if spendLhs.Cmp(spendRhs) > 0 {
			return nil, newErr(ErrState, "settlement spend exceeds 5% of supply (spend cap)")
		}
	}

	return &SettleQuote{Credits: credits, Rate: rate}, nil
}

// serviceFaceBounds returns the INCLUSIVE [lo, hi] window of posted faces a
// market can actually settle at a given rate and supply — the exact same two
// inequalities settleSpend enforces, rearranged so both ends are readable as
// numbers instead of only as refusals:
//
//	lo = ceil(rate/2)                                (RULING C4, exact over Z)
//	hi = floor(area(S)·MaxServiceFaceAreaBps/10000)  (RULING C2, exact over Z)
//
// ONE source of truth: settleSpend calls this, ServiceFaceRange exports it,
// so the quote UI and the enforcement can never disagree. lo > hi is legal
// output and means "no face works at this supply" (S == 1 at the compiled
// curve).
func serviceFaceBounds(rate, supply *big.Int) (lo, hi *big.Int) {
	lo = mMulDivCeil(rate, big.NewInt(1), big.NewInt(2))
	hi = mMulDiv(Area(supply), new(big.Int).SetUint64(MaxServiceFaceAreaBps), big.NewInt(10000))
	return lo, hi
}

// ServiceFaceRange is the read-only "what may I charge?" query behind the
// SET-2 fix: it returns the live [min, max] posted-face window for this
// market, or the same typed refusal SettlementRate would give. A creator UI
// MUST show this — the minimum rises with the token price (half a token,
// quadratic in supply), so a price that settles today can stop settling
// after the market appreciates, and the 2x/7d face band limits how fast the
// creator can follow it. Zero writes.
func ServiceFaceRange(s Store, creator string, block uint64) (minFace, maxFace *big.Int, err error) {
	rate, err := SettlementRate(s, creator, block)
	if err != nil {
		return nil, nil, err
	}
	lo, hi := serviceFaceBounds(rate, getMoney(s, kSupply(creator)))
	if lo.Cmp(hi) > 0 {
		return nil, nil, newErr(ErrState, "market too small to price any service: no face satisfies both the minimum-price guard and the depth ceiling at this supply")
	}
	// serviceFaceBounds bounds the TOKEN LEG (what settleSpend prices). A
	// creator posts a GROSS price, of which only 100%-CommissionBps reaches
	// the token leg (splitFace, USER RULING 2026-07-27), so the window shown
	// to a creator must be grossed up — otherwise a creator posts a price this
	// function called legal and the settlement refuses it.
	minPosted := minPostedForTokenLeg(lo)
	maxPosted := maxPostedForTokenLeg(hi)
	if minPosted.Cmp(maxPosted) > 0 {
		// The gross-up is monotone, so this can only fire where lo and hi were
		// already within one base unit of each other — report it as the same
		// honest "no legal price exists" state rather than an inverted range.
		return nil, nil, newErr(ErrState, "market too small to price any service: no face satisfies both the minimum-price guard and the depth ceiling at this supply")
	}
	return minPosted, maxPosted, nil
}

// minPostedForTokenLeg / maxPostedForTokenLeg invert splitFace's token leg:
// given a bound on the token leg they return the tightest POSTED face that
// satisfies it. splitFace's token leg is monotone non-decreasing in the posted
// face (each step of +1 adds 0 or 1 to the leg), so both searches start from
// the exact rational estimate and can only ever be off by the single base unit
// the floor division discards — the correction loops below therefore run at
// most a couple of iterations, never a scan.
func minPostedForTokenLeg(lo *big.Int) *big.Int {
	den := big.NewInt(10000 - int64(CommissionBps))
	p := mMulDivCeil(lo, big.NewInt(10000), den)
	if p.Sign() <= 0 {
		p = big.NewInt(1)
	}
	one := big.NewInt(1)
	for {
		leg, _ := splitFace(p)
		if leg.Cmp(lo) >= 0 {
			break
		}
		p = new(big.Int).Add(p, one)
	}
	for p.Cmp(one) > 0 {
		prev := new(big.Int).Sub(p, one)
		leg, _ := splitFace(prev)
		if leg.Cmp(lo) < 0 {
			break
		}
		p = prev
	}
	return p
}

func maxPostedForTokenLeg(hi *big.Int) *big.Int {
	den := big.NewInt(10000 - int64(CommissionBps))
	p := mMulDiv(hi, big.NewInt(10000), den)
	one := big.NewInt(1)
	for p.Sign() > 0 {
		leg, _ := splitFace(p)
		if leg.Cmp(hi) <= 0 {
			break
		}
		p = new(big.Int).Sub(p, one)
	}
	for {
		next := new(big.Int).Add(p, one)
		leg, _ := splitFace(next)
		if leg.Cmp(hi) > 0 {
			break
		}
		p = next
	}
	return p
}

// SettleSpend is the exported preview of settleSpend for the wasm wrapper's
// `quote` entrypoint: identical guards, identical math, ZERO writes, so the
// preview can never drift from what Ask will actually derive —
// the same one-source-of-truth shape QuoteBuy/QuoteSell already have.
func SettleSpend(s Store, creator string, block uint64, face *big.Int) (*SettleQuote, error) {
	return settlePosted(s, creator, block, face)
}

// settlePosted is the ONE door between a creator's POSTED price and a
// settlement. It splits the posted face into its token leg and its HBD
// commission leg (splitFace, ask.go — USER RULING 2026-07-27: the price on the
// screen is the price the buyer pays), prices ONLY the token leg through
// settleSpend, and carries the commission back out on the quote so the caller
// gates on the same number the same face produced.
//
// WHY THE SPLIT LIVES HERE AND NOT IN THE CALLERS. Ask and the
// wasm `quote` preview all funnel through this function, so there is exactly
// one place where a posted face becomes two legs. A caller that split its own
// face could drift from the preview by a base unit — or, far worse, forget to
// split at all and silently re-open the 12% surcharge this ruling closed. The
// same argument settleSpend's own doc makes for the rate, one level up.
//
// EVERY C-GUARD STILL BINDS, and binds on the leg that actually moves tokens:
// the C4 minimum-price floor, the C2 depth ceiling and the spend cap all
// measure the token leg, which is what the reserve actually pays out against.
// ServiceFaceRange grosses those same bounds back up into posted-face terms so
// a creator is never shown a price window their posted price cannot sit in.
func settlePosted(s Store, creator string, block uint64, postedFace *big.Int) (*SettleQuote, error) {
	if postedFace == nil || postedFace.Sign() <= 0 {
		return nil, newErr(ErrInput, "face must be positive")
	}
	tokenLeg, commission := splitFace(postedFace)
	if tokenLeg.Sign() <= 0 {
		// Unreachable at any face >= MinFace (the commission is 12%, so the
		// token leg is ~88% of a face floored well above zero); defense in
		// depth so a future commission ruling cannot silently price a service
		// at zero tokens.
		return nil, newErr(ErrInput, "posted face too small to carry its commission")
	}
	q, err := settleSpend(s, creator, block, tokenLeg)
	if err != nil {
		return nil, err
	}
	q.CommissionHbd = commission
	return q, nil
}
