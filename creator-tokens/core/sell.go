package core

import "math/big"

// sell.go — Sell: redeem ΔS tokens along the curve; the exit tax is MONEY,
// GROSS proceeds × τ(h) with NO cap, and goes to the TREASURY (RULING J +
// RULING K, RULINGS-v2-2026-07-21/22; RULING F for the tax rounding, RULING
// F8 for the fee, RULING G for the write discipline).
//
// THE EXACT SEQUENCE (each step's rounding direction is fixed and tested):
//
//	h    = heldBlocks(caller)                 hold clock, saturating (holdclock.go)
//	τ    = ExitTaxBpsAt(h)                    ceil, <= 1 bps seller-adverse
//	p    = SellProceeds(S, ΔS)                the FULL slice — the exact area
//	                                          step area(S) − area(S−ΔS); NO
//	                                          tokens are burned (RULING A)
//	tax  = ExitTaxOn(p, τ)                    = ceil(p·τ/1e4) — GROSS, NO cap
//	                                          (RULING K) — MONEY, to the
//	                                          TREASURY (RULING J), NEVER the
//	                                          reserve
//	fee  = floor(p·TradeFeeBps/1e4)           split 5/5, odd unit → platform
//	net  = p − tax − fee                      what the seller receives (>= 0,
//	                                          proven below)
//	bal −= ΔS  (debitBalance; wacq NOT touched)
//	S   −= ΔS
//	R   −= p                                  the curve leg ONLY (C-19): R was
//	                                          area(S) and is now area(S−ΔS),
//	                                          exactly — the equality invariant
//	                                          survives by construction
//	treasury += tax                           RULING J/K — one addMoney, no
//	                                          aggregate, no distribution
//	RecordObs(spotRate(S_before))             the pre-trade marginal
//
// Split equalities asserted in tests: p == net + tax + feeC + feeP (C-18),
// ΔR == −p exactly (C-19), the supply debit is the full ΔS.
//
// WHAT THE PREVIOUS VERSIONS DID AND WHY THEY WERE WRONG:
//
//   - the HOLDER DISTRIBUTION (RULING A's taxpot.go, deleted by J): a seller's
//     own retained balance plus their sybils recovered their share of the pot,
//     so the effective rate was ≈ τ·(1 − share of supply) — a 1% fan paid
//     19.9%, a 99% whale 0.5%. The tax bit the fan and spared the whale. The
//     whole patch family (snapshot + min-hold + seller exclusion) still left
//     whale recovery at 97.5%: an aged keeper account is indistinguishable
//     from an honest holder. Treasury destination makes the whale's effective
//     rate 20.0%, un-recoverable at any tranche or account count.
//   - the REALIZED-GAIN CAP (RULING J1, reversed by K1): min(rate, gain) was
//     defeated 45–68% by splitting one dump into two same-block sells (the
//     loss tail was forgiven instead of netted against the winner head). The
//     GROSS tax has no such seam — proceeds are path-independent (curve.go L4)
//     and ceil is superadditive (RULING F), so Σ ceil(pᵢ·τ) >= ceil(Σpᵢ·τ):
//     two sells pay AT LEAST one, never less, with ZERO per-position state.
//     kBasis and the three episode accumulators are DELETED (net machinery
//     strictly LESS). See exittax.go for the full autopsy.
//
// NET >= 0, PROVEN: tax = ceil(p·τ/1e4) with τ <= 2000, and fee =
// floor(p·1000/1e4). For p >= 2: tax + fee <= (p·2000 + 9999)/10000 + p/10 <
// 0.3p + 1 <= p. For p == 1: tax <= 1, fee == 0, net >= 0. For p == 0: all
// zero. Property-tested across the schedule.
//
// ---------------------------------------------------------------------------
// THE RAIL SWITCH — why Sell is closed once the market winds down, and why
// that is NOT a pause and NOT a funds gate (C-21; refund.go holds the other
// half):
//
// A holder ALWAYS has exactly one exit rail open, in every state — the two
// rails partition the lifecycle with NO gap and NO overlap (inWindDown,
// market.go, is the single predicate that switches them):
//
//	NOT winding down (ACTIVE, natural-lapse OVERDUE, natural-lapse FROZEN)
//	                → Sell (this file): exact curve proceeds for the slice.
//	WINDING DOWN (RETIRED at any point, or stored CLOSED)
//	                → Refund/RefundHolder (refund.go): flat pro-rata, taxed.
//
// The two rails MUST be state-disjoint, in both directions, and this is
// proven, not vibed:
//   - pro-rata WHILE BUYS ARE LIVE is a tax-and-fee bypass: pro-rata pays
//     average price, curve pays marginal, and for a dominant holder exiting
//     most of the supply the two converge (c → S makes floor(R·c/S) → R ==
//     the whole curve payout). It would also strand E = R − area(S') > 0 in
//     the reserve (pro-rata pays the average while the curve un-backs the
//     marginal), breaking the equality invariant and re-opening the
//     drainable-pot class in the one state where buying in is possible. So
//     flat pro-rata is confined to states where NO inflow can ever re-enter:
//     RETIRED is irreversible (Renew refuses on the mark) and CLOSED is
//     terminal, so the stranded excess is never raidable. (A natural FROZEN
//     is recoverable by Renew since A1, 2026-08-30 — which is exactly why it
//     must NOT open pro-rata: a revived half-refunded market would trade
//     against a reserve that no longer matches its curve.)
//   - curve-sell AT WIND-DOWN is a bank run (first-out takes the marginal
//     top, later holders strand below it); flat pro-rata is order-fair
//     (refund.go C-22/C-23: going later weakly HELPS). RULING K3 drops the
//     curve rail the instant a market retires precisely to close that race —
//     the retire notice used to keep Sell open (RULING D) and that was THM-1,
//     a first-mover race measured at 1.68× (first) down to 0.24× (last).
//
// So this gate ROUTES the exit; it never removes it. It reads inWindDown()
// ONLY — deliberately NOT RequireInflowOpen, which would also consult the
// global pause switch: OUTFLOWS NEVER PAUSE, in any state, for any reason.
// kPaused frozen at "1" forever must leave every Sell working (tested:
// TestSell_IgnoresGlobalPause). A winding-down market refusing Sell is not a
// frozen exit — Refund is open in exactly that state. Both wind-down triggers
// are one-way (RETIRED is irreversible; Register requires CLOSED to start
// fresh), so the rails can never interleave within one market incarnation.
// ---------------------------------------------------------------------------
//
// R === area(S) (C-9, THE invariant), the induction step this operation
// owns: given R == area(S) before the call, R' = R − p = area(S) −
// [area(S) − area(S−ΔS)] = area(S−ΔS) = area(S'). Equality in, equality
// out — definitional, because SellProceeds IS the exact area step
// (curve.go L2). The reserve debit is therefore provably safe: p =
// area(S) − area(S−ΔS) <= area(S) == R, and the subMoney underflow guard
// below is defense-in-depth, not a control.
//
// ---------------------------------------------------------------------------
// THE SOLVENCY PRE-CHECK (R >= area(S) before trading) — WHY IT STAYS:
//
// The equality proof above needs its hypothesis. Every writer of kReserve
// maintains R === area(S) from the S=0,R=0 genesis (Buy, Sell, and the
// wind-down pair — refund.go's writer table), and the PAR mint that used to
// violate it (prepay.go) is DELETED, so this check is unreachable dead code
// in the shipped system — asserted after every op in the fuzz harness. It is
// kept because paying exact-slice proceeds out of a reserve that does NOT
// cover the area would take the missing money from the remaining holders'
// backing: on genuinely corrupt state the honest behaviours are refuse
// loudly (here) or underflow loudly (subMoney) — never pay wrongly. This is
// a REAL-insolvency guard on real backing, not an accounting aggregate, so
// RULING G does not forbid it (the ruling bans bookkeeping reverts — the
// test-proven WA underflow — not refusal to pay money that provably is not
// there). The refusal cannot strand the holder either: the identical corrupt
// state makes Refund's pro-rata the correct (haircut) exit, and wind-down
// opens on lapse or Retire.
// ---------------------------------------------------------------------------

// SellResult carries every amount the wasm wrapper, the quote UI (RULING F:
// the split MUST be shown before signing) and the event log need.
type SellResult struct {
	Sold        *big.Int // ΔS — removed from the seller's balance and from supply
	Gross       *big.Int // p = SellProceeds(S, ΔS) — the exact reserve debit
	Tax         *big.Int // ExitTaxOn(p, τ) — gross × rate, no cap — to the TREASURY (RULING J/K)
	Fee         *big.Int // total trade fee, out of the payout
	FeeCreator  *big.Int // accrued to kFeeBal(creator) (pull, F8)
	FeePlatform *big.Int // accrued to kTreasury()
	Net         *big.Int // p − tax − fee — the wrapper's single transfer
	//                       to the seller (skipped when 0)
	TaxBps uint64 // τ actually applied (quote/UI/event)
	// TaxableGross is the MATURING share of Gross — the base the exit tax was
	// actually charged on. With two buckets the K1 identity is no longer
	// tax == ExitTaxOn(Gross, τ), because a matured token's rate is 0 by
	// definition; it is tax == ExitTaxOn(TaxableGross, τ), exactly, on every
	// sale. Carried on the result rather than recomputed by callers so the
	// quote, the charge, the event and the property tests all read one number.
	TaxableGross *big.Int
	// Graduated is how many tokens moved into the tradable bucket as a side
	// effect of this call. The wrapper emits the standard mint-shaped transfer
	// event for it — the indexer's derived balances are inflow minus outflow
	// over those events, so a graduation that emits nothing is a balance that
	// stays wrong for that holder forever.
	Graduated *big.Int
	// MaturedBurned is how much of this sale came out of the TRADABLE bucket.
	// The wrapper emits a burn-shaped standard transfer event for it so the
	// indexer's derived balances stay correct. Zero in the common case, since a
	// sale draws maturing tokens first.
	MaturedBurned *big.Int
	HeldBlocks    uint64   // h the clock read (quote/UI/event)
	RateRecorded  *big.Int // spotRate(S_before) fed to RecordObs
}

// sellCompute runs every guard and all the math for a sell WITHOUT mutating
// state — shared verbatim by Sell and QuoteSell so the signed preview can
// never drift from execution (the same one-source-of-truth shape as
// refund.go's refundPayout).
func sellCompute(s Store, caller, creator string, block uint64, deltaS *big.Int) (*SellResult, error) {
	if !validAccount(caller) {
		// '|' key-collision guard for kBal/kAcqBlock, as everywhere.
		return nil, newErr(ErrAuth, "invalid caller account")
	}
	if !validAccount(creator) {
		return nil, newErr(ErrInput, "invalid creator account")
	}
	if deltaS == nil || deltaS.Sign() <= 0 {
		return nil, newErr(ErrInput, "token amount must be positive")
	}

	// Balance first (clearer error than the rail for the common mistake).
	// Escrowed tokens are already OUTSIDE bal (I3), so escrow structurally
	// cannot be sold — no extra check needed or possible here.
	// BOTH BUCKETS (2026-07-30). A holder's position is maturing + matured, and
	// reading only one of them refuses a seller access to tokens they provably
	// own — which is exactly how refund.go's "no state leaves a holder trapped"
	// proof breaks.
	bal := totalBalance(s, creator, caller)
	if mLt(bal, deltaS) {
		return nil, newErr(ErrBalance, "insufficient credits")
	}

	// The rail switch — inWindDown ONLY, never the pause. See the file-level
	// doc; this is a routing decision between two complementary always-open
	// exits, not a gate on the seller's funds. The curve rail is OPEN exactly
	// when the market is NOT winding down (ACTIVE, natural-lapse OVERDUE, and
	// — since A1, 2026-08-30 — natural-lapse FROZEN too: a lapse is an inflow
	// stop, never a wind-down, so the holder's exit stays here); it is DROPPED
	// the instant the market retires (RULING K3 — during a wind-down every
	// holder takes the order-fair flat pro-rata Refund, not the racy curve top).
	if inWindDown(s, creator, block) {
		return nil, newErr(ErrState, "curve sell is closed while the market winds down (retired/closed); exit via Refund, which is open in exactly those states")
	}

	supply := getMoney(s, kSupply(creator))
	// The solvency pre-check — see the file-level doc. Cheap (one compare),
	// unreachable in the shipped system, and the difference between a typed
	// refusal and paying other holders' backing out on corrupt state.
	reserve := getMoney(s, kReserve(creator))
	if mLt(reserve, Area(supply)) {
		return nil, newErr(ErrState, "reserve below curve area (equality invariant violated — state corrupt); curve trading refused, exit opens via wind-down Refund")
	}

	h := heldBlocksAt(s, creator, caller, block)
	taxBps := ExitTaxBpsAt(h)

	// ΔS <= bal <= Σ bal <= S (I3), so SellProceeds' k>S error is
	// structurally unreachable; propagated anyway (defense-in-depth, and a
	// corrupt-state I3 violation should fail loudly, not pay).
	p, err := SellProceeds(supply, deltaS)
	if err != nil {
		return nil, err
	}
	// RULING K: the exit tax is GROSS proceeds × τ(h), ceil, NO cap and no
	// per-position state. Un-splittable by ceil superadditivity + curve-leg
	// path-independence (exittax.go) — read-only, so QuoteSell computes the
	// identical number.
	//
	// TWO BUCKETS (2026-07-30): only the MATURING part of the draw owes anything
	// — a matured token's rate is exactly 0 by definition. The taxable base is
	// therefore the maturing share of the gross, apportioned PRO RATA by token
	// count, never by letting the matured tokens take the dearest price slice
	// off the top (see maturingGrossShare for the measured reason).
	fromMatured, fromMaturing := splitDraw(s, creator, caller, deltaS)
	taxableGross := maturingGrossShare(p, fromMaturing, deltaS)
	tax := ExitTaxOn(taxableGross, taxBps)
	fee, feeC, feeP := tradeFeeOn(p)

	// net = p − tax − fee, >= 0 (proof in the file header). Computed once,
	// here, so quote and execution cannot disagree.
	net := new(big.Int).Sub(p, tax)
	net.Sub(net, fee)
	if net.Sign() < 0 {
		// Unreachable by the file-header proof (τ <= 2000 + 10% fee < 100%);
		// refuse loudly rather than mint a negative payout if a future
		// parameter change ever breaks the proof's premise.
		return nil, newErr(ErrArith, "tax + fee exceed proceeds")
	}

	// NOTE (BUY-INT64, PRUNED 2026-07-22): deliberately NO int64 guard on this
	// OUTFLOW. Sell is a holder exit; RULING G forbids ever rejecting it on an
	// amount, and core is unbounded big.Int by design (cf.
	// TestRefund_LargeAmountsBeyondInt64). A Net > MaxInt64 needs a reserve
	// larger than the entire HBD supply — unreachable — and the wasm wrapper's
	// int64 narrowing + host-revert covers the (economically-impossible) tail;
	// the guard lives only on Buy (an inflow, buyCompute/launchBuyCheck).
	return &SellResult{
		Sold:          new(big.Int).Set(deltaS),
		Gross:         p,
		Tax:           tax,
		Fee:           fee,
		FeeCreator:    feeC,
		FeePlatform:   feeP,
		Net:           net,
		TaxBps:        taxBps,
		TaxableGross:  taxableGross,
		MaturedBurned: fromMatured,
		HeldBlocks:    h,
		RateRecorded:  SpotRate(supply), // S_before — the pre-trade marginal
	}, nil
}

// checkMinNet enforces the caller's OPTIONAL signed floor on the net proceeds
// of an exit (shared by Sell here and Refund in refund.go) — the missing
// enforcement half of RULING F's mandatory quote, and the structural close for
// OUTFLOW-CLIFF-1 (FIX ROUND 4, 2026-07-22).
//
// THE DEFECT IT CLOSES: the exit-tax RATE is derived from the live hold clock
// (holdclock.go), read at execution time. TransferCredits is permissionless
// property (transfer.go — it MUST be, and it correctly re-ages the recipient
// toward FRESH to kill OTC age-laundering in both directions, C-13), so a third
// party can force a dust inflow onto a victim in the SAME block, AFTER the
// victim signed their quote, nudging the victim's averaged clock forward. A
// holder who patiently held to the six-week 0%-tax mark is thereby knocked to
// the ceil-minimum 1 bps (exittax.go's ceil floors the rate at 1, and
// creditInflowAt's ceil floors the clock shift at 1 block), charged on their
// ENTIRE proceeds and booked to the treasury. This is exactly the
// producer-ordered front-run that ask.go's maxCredits already defends the
// INFLOW credit leg against (a creator sandwiching a signed Ask between two
// SetFace spikes); Sell and Refund — the two least-gated OUTFLOWS — lacked the
// analogous binding between the signed quote and execution. It is NOT a
// solvency defect: R === area(S) is untouched (the tax is a carve from the
// payout, never a second reserve debit — the rate only moves the seller/
// treasury split), which is why the fix is a pure pre-write GATE, never a
// change to any money math.
//
// `opt` is VARIADIC so every existing internal, test and production call site
// that does not opt in is unchanged (there is no forced churn across the 100+
// call sites, and the two wind-down production callers keep their shapes):
//   - absent, or a single nil  => NO guard. The caller accepts any net (e.g.
//     dumping a worthless position, or a keeper sweep). This is the ESCAPE
//     HATCH that keeps OUTFLOWS-NEVER-PAUSE / RULING G intact: an exit is
//     ALWAYS available by passing nil, so the guard can never trap a holder —
//     it only lets a front-run REVERT CLEANLY instead of silently overcharging.
//   - a single non-nil value   => the exit REFUSES (ErrInput, mirroring
//     maxCredits' "creditsSpent exceeds maxCredits") when the computed net
//     falls below it, BEFORE any write, so nothing mutates (RULING G).
//   - more than one            => a programming error, refused pre-write (never
//     a panic on a fund path).
//
// The wasm entrypoints (RULING F: the quote is mandatory UI) MUST pass the
// signed quoted net here, so on-chain the guard is always armed; the `sell`
// entrypoint is still unbuilt (Wave D) and MUST wire it, and `refund`
// (contract/main.go) should thread it from the signed payload — the capability
// lives in core so the binding is atomic with the money math (no TOCTOU
// between a separate quote call and the exit).
func checkMinNet(net *big.Int, opt []*big.Int) error {
	if len(opt) > 1 {
		return newErr(ErrInput, "at most one minNet floor may be supplied")
	}
	if len(opt) == 1 && opt[0] != nil {
		if net.Cmp(opt[0]) < 0 {
			return newErr(ErrInput, "net proceeds below caller's minNet floor (front-run/slippage guard tripped; re-quote, or pass a lower/nil minNet to opt out)")
		}
	}
	return nil
}

// Sell redeems ΔS of the caller's tokens at the exact curve slice: the
// reserve pays the full slice p, the exit tax (money, hold-time-decaying,
// gross proceeds, no cap — RULING K) goes to the treasury, the fee to the
// pull pots, and the seller receives the remainder. Returns the amounts for
// the wrapper (transfer Net to the seller — ONE transfer, no fee push, F8)
// and the event log. Every guard runs before any write; nothing mutates on a
// rejected call (RULING G — after sellCompute's guards, no remaining step
// can fail).
//
// minNet (variadic, OPTIONAL — OUTFLOW-CLIFF-1, FIX ROUND 4): the caller's
// signed floor on Net, enforced by checkMinNet after the read-only sellCompute
// and BEFORE any write. Absent/nil = no guard (see checkMinNet for why that
// escape hatch keeps OUTFLOWS-NEVER-PAUSE / RULING G intact); a supplied value
// makes a same-block hold-clock front-run REVERT this call cleanly instead of
// silently overcharging the tax. QuoteSell deliberately takes NO minNet — it is
// the read-only preview that PRODUCES the number a caller then passes here.
func Sell(s Store, caller, creator string, block uint64, deltaS *big.Int, minNet ...*big.Int) (*SellResult, error) {
	r, err := sellCompute(s, caller, creator, block, deltaS)
	if err != nil {
		return nil, err
	}

	// OUTFLOW-CLIFF-1 guard — the signed floor on Net, checked BEFORE any write
	// (RULING G): a tripped guard mutates nothing and leaves R === area(S)
	// untouched (it gates whether the already-computed transfer happens; it
	// changes no money math). See checkMinNet for the full autopsy.
	if err := checkMinNet(r.Net, minNet); err != nil {
		return nil, err
	}

	// ---- writes (all guards passed; nothing below can reject) ----
	// The chokepoint debit removes the balance. The seller's wacq is
	// deliberately NOT touched — selling does not re-age the remainder
	// (holdclock.go). RULING K deleted the cost basis, so a Sell no longer
	// removes or persists any per-position accounting.
	// Graduate first: a position that has cleared the window belongs in the
	// matured bucket whether or not its owner has bought since. This is one of
	// the touch points that keeps the market-visible balance honest — without
	// them the ONLY way into the matured bucket is spending money on another
	// purchase (scrutiny MEDIUM-1). Infallible, and every guard has passed.
	r.Graduated = graduate(s, creator, caller, block)
	// ★ RE-SPLIT AFTER GRADUATION (Phase-0 model P-09). sellCompute priced the
	// bucket split against the PRE-graduation state; graduate() then empties the
	// maturing family into the matured one, so the tokens this sale actually
	// draws from the matured bucket are not the ones the quote computed. The
	// money is unaffected — graduation only fires when the rate is already zero,
	// so tax, gross, supply and reserve are identical either way — but
	// MaturedBurned drives the burn EVENT, and reporting the pre-graduation
	// figure leaves the derived balances over-stating that holder's tradable
	// position by exactly the maturing part of the draw, permanently.
	if actualFromMatured, _ := splitDraw(s, creator, caller, r.Sold); actualFromMatured != nil {
		r.MaturedBurned = actualFromMatured
	}
	// Maturing first, then matured — the same fixed order sellCompute priced
	// against, so the charge can never disagree with the quote. See splitDraw
	// for why the order is what makes the tax un-splittable.
	if err := debitPosition(s, creator, caller, r.Sold); err != nil {
		return nil, err // unreachable: totalBalance >= ΔS was just proven
	}
	// The full slice leaves supply — no burn, no withheld tokens.
	if err := subMoney(s, kSupply(creator), r.Sold); err != nil {
		return nil, err // unreachable: supply >= bal >= ΔS by I3
	}
	// kReserve writer #2 of the exactly-four (refund.go's writer table). The
	// FULL exact area step p — tax and fee are carved out of the PAYOUT on
	// their way to the treasury and the fee pots, never a second reserve
	// debit (C-19). R was area(S); it is now area(S−ΔS), exactly.
	if err := subMoney(s, kReserve(creator), r.Gross); err != nil {
		return nil, err // unreachable under the equality invariant; loud if corrupt
	}
	// The tax leg (RULING J/K): one deterministic addMoney to the treasury.
	// No pot, no index, no per-holder state, no aggregate that could ever
	// gate an outflow (RULING G satisfied structurally). THE PREVIOUS
	// VERSION distributed this to the holders of record via taxpot.go's
	// accumulator — deleted; see the file header for the measured autopsy.
	accrueExitTax(s, creator, caller, r.Tax)
	accrueTradeFee(s, creator, r.FeeCreator, r.FeePlatform)
	// The curve IS the price source (RULINGS "WIRING"). S_BEFORE: both trade
	// directions record the marginal rate at the TOP of the traded slice
	// (buys: post-trade S+n; sells: pre-trade S), so one buy+sell round trip
	// at the same supply offers the SAME honest rate twice rather than
	// sawtoothing the feed. First-writer-per-block (RecordObs's own
	// contract) keeps a same-block round trip to one observation.
	RecordObs(s, creator, block, r.RateRecorded)
	return r, nil
}

// QuoteSell is the read-only preview of Sell for the wrapper's quote path
// (Wave D wires the entrypoint). RULING F makes this quote MANDATORY UI
// before signing: the signer must see Sold/Gross/Tax/Fee/Net exactly as
// execution will compute them, which is guaranteed by sharing sellCompute.
// Identical guards, zero writes.
func QuoteSell(s Store, caller, creator string, block uint64, deltaS *big.Int) (*SellResult, error) {
	return sellCompute(s, caller, creator, block, deltaS)
}
