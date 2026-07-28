package core

import "math/big"

// Register/Renew/SetFace/SetCap/Phase/RequireInflowOpen — identity, subscription,
// phase and pricing band (API.md, [AGENT 1]).
//
// ---------------------------------------------------------------------------
// Phase is the load-bearing contract of this file. Per API.md:
//
//	Phase derives ACTIVE/OVERDUE/FROZEN/CLOSED LAZILY from paid_until,
//	GraceBlocks and stored state. Never stores the phase as truth — a stored
//	CLOSED (terminal) is the only stored state that wins.
//
// "the ONLY stored state that wins" means exactly that: kState(creator) is
// consulted for ONE value only (StateClosed). Any other stored value —
// StateActive, or "" for a market whose state field was never explicitly
// written — falls through to the paid_until/GraceBlocks derivation. This is
// verified against prepay_test.go's own test harness (setupMarket), which
// writes kRegisteredAt/kPaidUntil/kCap directly and deliberately never
// touches kState, yet still expects RequireInflowOpen to see those markets as
// open — i.e. Phase must not require kState==StateActive to derive ACTIVE.
//
// The only two values market.go itself ever WRITES to kState are StateActive
// (Register) and, out of this file's scope, StateClosed (refund.go's
// CloseIfDrained, per API.md's refund.go/[AGENT 4] listing — market.go never
// writes CLOSED).
//
// ---------------------------------------------------------------------------
// Cross-file convention adopted from prepay.go (already written, not owned by
// this file, read for compatibility): "does a market exist at all" is decided
// by kRegisteredAt(creator) != 0, exactly as prepay.go's own existence guard
// does ("Market existence is checked directly rather than left to
// RequireInflowOpen, so a prepay against an account that never registered
// gets a precise ErrNotFound"). market.go's own Renew/SetFace/SetCap guards
// use the same signal, so every module in this package agrees on what
// "registered" means. Register's OWN duplicate-registration guard cannot use
// this signal (a closed market still has a nonzero historical kRegisteredAt)
// and instead reads kState directly — see Register below.
//
// KNOWN CROSS-FILE EDGE CASE (documented, not fixed here — see the report):
// registering at block == 0 writes kRegisteredAt(creator) = 0, which
// prepay.go's existence check reads identically to "never registered". This
// only matters at the literal genesis block and is out of this file's power
// to fix (prepay.go is foundation-frozen for this agent).
// RULING D (RULINGS-v2-2026-07-21) — THE 5-DAY RETIRE NOTICE.
//
//	phase = MAX(naturalPhase, retiredPhase)   on ACTIVE < OVERDUE < FROZEN < CLOSED
//	retiredPhase = block < retiredAt+GraceBlocks ? OVERDUE : FROZEN
//
// WHAT THE PREVIOUS VERSION DID AND WHY IT IS NOW WRONG: it stored the flag
// kRetired="1" and returned FROZEN the instant it was set. That is not a
// nicety we are softening — it was measured as the creator-whale's escape
// hatch around the entire exit tax. The wind-down rail (refund.go) pays flat
// pro-rata with NO exit tax and NO trade fee, while the curve rail (sell.go)
// pays marginal MINUS tax and fee. For a fresh dominant creator the untaxed
// average beat the taxed marginal — 205.53 HBD via instant Retire versus
// 180.62 HBD via a curve exit — so a creator could dump their own position at
// a better price than any fan by flipping the rail under everyone in one
// block. RULING J therefore makes this notice a HARD PREREQUISITE for
// shipping the exit tax, not a courtesy: the five OVERDUE blocks-days are
// what let fans sell on the curve rail at marginal BEFORE the market drops
// onto the average-paying wind-down rail (RULING D: worth 1.90x the
// wind-down rail at every supply tested).
//
// THE MAX IS LOAD-BEARING. Retiring may only ever make a market MORE frozen,
// never less. Every property the DEFECT-1 fix claimed is preserved BY the
// MAX, not despite it:
//
//   - retiring an already-FROZEN market cannot un-freeze it: natural FROZEN
//     (rank 2) vs retired OVERDUE (rank 1) -> MAX = FROZEN.
//   - the perpetual-subscription dodge stays closed: a creator retiring
//     while OVERDUE gets OVERDUE (not ACTIVE — the old paidUntil-poke's
//     actual bug), and the natural ladder keeps running underneath, so the
//     market reaches FROZEN on the natural schedule even if the retire
//     notice were somehow restarted. Retire is additionally once-only (see
//     Retire), so the notice cannot be re-armed at all.
//   - no height SUBTRACTION anywhere: the only arithmetic is
//     retiredAt+GraceBlocks, an addition, so no uint64 underflow exists to
//     guard for low block heights — the concrete reason the old fix refused
//     to encode the freeze as `paidUntil = block − GraceBlocks`.
//
// RULING K3 (2026-07-22) — THE NOTICE DROPS THE CURVE RAIL. During the notice
// the phase is OVERDUE, but a RETIRED market is treated as WINDING DOWN for
// both rails (inWindDown, below): all NEW inflows are refused
// (RequireInflowOpen consults marketRetired) and exits route through the flat
// pro-rata Refund, NOT the curve (sell.go's rail switch consults inWindDown).
// This reverses the part of RULING D that kept Buy/Ask/Sell open on the curve
// during the notice — that was THM-1, a first-mover race (holders racing the
// curve top, measured 1.68× first down to 0.24× last, with 9.76% of the
// reserve leaking to trade fees half of which went to the retiring creator for
// zero service). Under K3 the notice is order-fair: every holder takes the
// same taxed flat pro-rata, going later weakly HELPS (refund.go C-22/C-23),
// and the whale exit is priced (the wind-down now carries the same τ(h) tax,
// K2). Closing inflows AND flat-pro-rata exits are mutually consistent
// precisely because Retire is irreversible — no fresh buyer can ever re-enter
// to raid the stranded excess (the governing-theorem premise). The retire
// block stays public on-chain state (RetiredAt, below) so a wallet or indexer
// can surface "this market is retiring at block X". A NATURAL-lapse OVERDUE
// window is different: it is recoverable (a fan can Renew it back to ACTIVE),
// so it KEEPS the curve rail and its inflows — inWindDown fires ONLY on a
// deliberate Retire or a genuine FROZEN/CLOSED, never on a mere late payment.
func Phase(s Store, creator string, block uint64) string {
	if getStr(s, kState(creator)) == StateClosed {
		return StateClosed
	}
	natural := naturalPhase(s, creator, block)
	retiredAt, retired := retiredAtBlock(s, creator)
	if !retired {
		return natural
	}
	forced := StateFrozen
	if block < retiredAt+GraceBlocks {
		forced = StateOverdue
	}
	return maxPhase(natural, forced)
}

// naturalPhase is the subscription ladder alone — the lazy paid_until
// derivation, with no retire input. Split out of Phase so the MAX above has
// two independent, separately-testable terms.
func naturalPhase(s Store, creator string, block uint64) string {
	paidUntil := getU64(s, kPaidUntil(creator))
	if block <= paidUntil {
		return StateActive
	}
	// OVERDUE spans (paidUntil, paidUntil+GraceBlocks) — grace is fully
	// consumed only once block reaches paidUntil+GraceBlocks, matching SPEC
	// §1.7.5's ladder ("OVERDUE: lapse -> lapse+5 days" / "FROZEN: lapse+5
	// days"): FROZEN begins AT the +GraceBlocks boundary, not after it.
	if block < paidUntil+GraceBlocks {
		return StateOverdue
	}
	return StateFrozen
}

// phaseRank orders the lifecycle ACTIVE < OVERDUE < FROZEN < CLOSED (RULING
// D). "Higher" means strictly more restricted: fewer inflows open, closer to
// terminal. An unrecognised string ranks as ACTIVE (0) — it cannot occur
// (naturalPhase and the retired derivation both return one of the four
// consts) and ranking an unknown as LEAST restricted would be the wrong
// direction, so callers never construct one.
func phaseRank(p string) int {
	switch p {
	case StateOverdue:
		return 1
	case StateFrozen:
		return 2
	case StateClosed:
		return 3
	default: // StateActive
		return 0
	}
}

// maxPhase returns whichever of the two phases is MORE frozen.
func maxPhase(a, b string) string {
	if phaseRank(b) > phaseRank(a) {
		return b
	}
	return a
}

// kRetiredAt / retiredAtBlock — the RULING-D retire notice mark.
//
// kRetiredAt builds the per-market key Retire writes. It is defined HERE, in
// market.go, rather than in keys.go, because it is written and read
// exclusively by this file's retire mechanism (Retire sets it, Phase and
// Register read/clear it) — nothing outside market.go's own lifecycle logic
// ever touches it. It uses the same package-private mk() builder every other
// per-market key uses, on the previously-unused field tag "rat" (no collision
// with any existing tag: face/fsa/fan/faa/cap/sup/res/pu/st/fz/reg/seq/ret/
// up/upsa/upa/upaa/sp/spsa/spa/spaa — keys.go).
//
// THE ENCODING IS block+1, NOT block. The mark must now carry a HEIGHT (the
// notice window is measured from it), but a bare height loses the one
// property the old "1" flag had for free: 0 is indistinguishable from unset.
// A market retired at block 0 storing 0 would read back as "never retired"
// and silently un-freeze itself — a fail-OPEN on the exact mechanism whose
// whole job is to force a market down the ladder. Storing block+1 keeps 0
// reserved for "never retired" at every real height, with one addition and
// no subtraction anywhere in the derivation. The old tag "ret" held a string
// flag and is deliberately NOT reused: nothing is deployed, so there is no
// migration, but a tag whose value type changed meaning is exactly the kind
// of thing a future reader mis-parses.
func kRetiredAt(c string) string { return mk(c, "rat") }

// retiredAtBlock returns the block Retire was called at and whether the
// market is retired at all. The saturating +1 encoding is decoded here and
// nowhere else.
func retiredAtBlock(s Store, c string) (uint64, bool) {
	v := getU64(s, kRetiredAt(c))
	if v == 0 {
		return 0, false
	}
	return v - 1, true
}

// marketRetired reports whether Retire has started this market's wind-down
// notice. It does NOT mean "frozen" any more — see Phase.
func marketRetired(s Store, creator string) bool {
	_, retired := retiredAtBlock(s, creator)
	return retired
}

// inWindDown is THE single predicate the exit rails switch on (RULING K3): it
// reports whether the market's WIND-DOWN rail (flat pro-rata Refund/
// RefundHolder, refund.go) is the open exit — equivalently, whether the CURVE
// rail (Sell, sell.go) is CLOSED. True exactly when the market is in a
// TERMINAL descent from which no fresh inflow can ever re-enter:
//
//   - RETIRED (the creator's irreversible Retire) — from the retire block
//     onward, INCLUDING the OVERDUE notice window. This is the K3 change: the
//     notice used to keep the curve rail open (RULING D), which was THM-1's
//     first-mover race; K3 drops it. Retire is irreversible (Renew refuses on
//     the mark, RequireInflowOpen refuses on the mark), so flat pro-rata here
//     can never strand raidable excess — nothing will ever buy back in.
//   - naturally FROZEN or CLOSED — the subscription lapsed past its grace, or
//     the market drained (CloseIfDrained). Also terminal within an
//     incarnation (Register requires CLOSED to start fresh).
//
// A NATURAL-lapse OVERDUE window is deliberately FALSE here: it is recoverable
// (Renew lifts it back to ACTIVE), so it keeps the curve rail and its inflows.
// Routing its exits to flat pro-rata would strand excess that a subsequent
// Renew could re-expose to fresh buyers — the exact drainable-pot class the
// governing theorem forbids (sell.go's rail-switch proof). This predicate is
// therefore the complement of "curve rail open", with NO gap and NO overlap:
// every (creator, block) has exactly one open exit rail.
func inWindDown(s Store, creator string, block uint64) bool {
	if marketRetired(s, creator) {
		return true
	}
	switch Phase(s, creator, block) {
	case StateFrozen, StateClosed:
		return true
	default:
		return false
	}
}

// windDownOpenBlock returns the block at which the market's CURRENT continuous
// wind-down began, and whether the market is in wind-down at all. It is the
// MARKET-level clock RefundHolder's permissionless-push DoS backstop measures
// against — and, unlike the per-holder hold clock, NO transfer can refresh it
// (EXITTAX-DOS-1 / NOTICE-1 / OUTFLOW-K-2, FIX ROUND 2, 2026-07-22).
//
// Two sources, mirroring inWindDown's two triggers:
//   - RETIRED: retiredAt (the retire block). Retire is IRREVERSIBLE (Renew
//     refuses on the mark, RequireInflowOpen refuses on the mark), so from
//     retiredAt the market is continuously in wind-down and this value is exact
//     and stable — the anchor a transfer-refreshable clock could never be.
//   - naturally FROZEN (not retired): paidUntil + GraceBlocks, the block the
//     subscription's grace expired. A Renew (only possible while NOT retired)
//     lifts paidUntil, so this recomputes to the CURRENT freeze block — a
//     renewed-then-relapsed market correctly RESTARTS its wind-down window
//     rather than carrying stale credit for an interruption.
//
// When BOTH apply, anchor to whichever trigger fired FIRST — min(retiredAt,
// naturalFreeze) (WINDDOWN-RESET-1, FIX ROUND 3). The earlier "retiredAt always
// governs" shortcut was WRONG for the natural-freeze-then-Retire ordering: a
// market that had ALREADY been continuously winding down (naturally FROZEN,
// which Renew cannot lift) for a long time before Retire would have its anchor
// silently moved FORWARD by (retiredAt − naturalFreeze), re-arming a full extra
// ExitTaxDecayBlocks of RefundHolder force-push immunity for every remaining
// (possibly griefer-refreshed) position — the exact opposite of the "a clock no
// transfer can refresh" guarantee, since an ordinary legal Retire had the same
// refreshing effect. The retire-before-freeze ordering is unaffected (there
// retiredAt <= naturalFreeze, so the min still returns retiredAt), so no
// premature force-push is ever introduced.
//
// Returns (0, false) when the market is not in wind-down (ACTIVE, or a
// recoverable natural-lapse OVERDUE): there is no wind-down to age against, and
// the caller refuses the push.
//
// Non-underflow: for a retired market retiredAt <= block on any monotone chain
// (you cannot retire in the future); for a natural freeze inWindDown is FROZEN
// only once block >= paidUntil+GraceBlocks. The single caller still guards
// block < open explicitly, so a non-monotone test block cannot wrap the
// subtraction.
func windDownOpenBlock(s Store, creator string, block uint64) (uint64, bool) {
	if !inWindDown(s, creator, block) {
		return 0, false
	}
	// natFreeze is the natural-lapse wind-down trigger: the block the
	// subscription's grace expired, from the CURRENT paidUntil. It is a genuine
	// continuous-wind-down anchor whenever the market HAS a subscription
	// (paidUntil != 0), INDEPENDENT of retire status — a naturally FROZEN market
	// can never be lifted back out (Renew refuses on a FROZEN phase,
	// RequireInflowOpen), so from natFreeze on the wind-down is unbroken.
	paidUntil := getU64(s, kPaidUntil(creator))
	natFreeze := paidUntil + GraceBlocks
	if retiredAt, retired := retiredAtBlock(s, creator); retired {
		// A market can only continuously wind down from the EARLIER of its two
		// triggers, so anchor to whichever fired FIRST (WINDDOWN-RESET-1, FIX
		// ROUND 3):
		//   - retire-before-freeze (retiredAt <= natFreeze): the market entered
		//     wind-down at Retire; the natural freeze is later (or in the
		//     future) and never actually froze anything — min == retiredAt, the
		//     old shortcut, UNCHANGED (no premature push introduced here).
		//   - freeze-before-retire (natFreeze < retiredAt): the market was
		//     ALREADY continuously winding down (FROZEN, un-renewable) BEFORE
		//     Retire; anchoring to the later retiredAt would silently re-arm the
		//     RefundHolder DoS backstop for (retiredAt − natFreeze) blocks. Anchor
		//     to natFreeze — the block wind-down TRULY began.
		// The paidUntil != 0 guard keeps a market that never carried a real
		// subscription (natFreeze == GraceBlocks spuriously; only reachable via a
		// direct test poke — Register always sets paidUntil, market.go) from
		// mis-anchoring to that phantom freeze; it falls back to retiredAt.
		if paidUntil != 0 && natFreeze < retiredAt {
			return natFreeze, true
		}
		return retiredAt, true
	}
	// naturally FROZEN/CLOSED (not retired): the grace-expiry block.
	return natFreeze, true
}

// RetiredAt is the exported read of the retire mark for the wasm wrapper,
// the indexer and any wallet: (block the creator retired, true) or (0,
// false). This is what makes the notice a NOTICE — a market in its five-day
// window is publicly identifiable, so a UI can warn a would-be buyer that
// the curve rail closes at RetiredAt+GraceBlocks and the wind-down rail
// (flat pro-rata, refund.go) opens there. Read-only, cannot fail, missing
// reads as not-retired (util.go's convention).
func RetiredAt(s Store, creator string) (uint64, bool) {
	return retiredAtBlock(s, creator)
}

// RequireInflowOpen is the single shared chokepoint every NEW-inflow path
// (Prepay, and Renew below) must call: phase ACTIVE or OVERDUE, the global
// pause key clear, AND the market not RETIRED. Per API.md rule 3 ("Outflows
// never pause") and rule 4 ("The billing state must never gate funds"), this
// function must never be called to gate refund, reclaim, answering an
// outstanding ask, or TransferCredits — those must keep working in every
// phase, including FROZEN. prepay.go already calls this exact signature; that
// dependency is why the signature and semantics here cannot change without
// breaking a sibling file this agent does not own.
//
// THM-1/THM-2 FIX (RULING K3, 2026-07-22) — a RETIRED market refuses ALL new
// inflows for its entire wind-down, INCLUDING the OVERDUE notice, even though
// Phase() is still OVERDUE there. Retire is a public, on-chain announcement
// that this market is winding down (RetiredAt), and under K3 a retired market
// is treated as winding down for BOTH rails: inflows refused here, and exits
// routed off the curve to flat pro-rata Refund (sell.go/refund.go consult
// inWindDown). There is no honest reason to keep admitting BUYERS at the
// marginal price into a market that will settle the wind-down at the AVERAGE —
// they can only lose, and the trade fees their buys generate leave the holder
// set and half-accrue to the very creator who announced the death (THM-2).
// marketRetired() is the surgical gate: it fires ONLY on a deliberate Retire,
// never on a natural subscription lapse — a creator merely LATE on payment
// keeps a fully functional OVERDUE grace window (SPEC §1.7.5's ladder), which
// is what that window is for, WITH its curve rail intact (that window is
// recoverable via Renew, so inWindDown leaves it on the curve — see market.go).
//
// K3 RESOLVES the sell-side race the old RULING-D notice opened: with the
// curve rail dropped the instant a market retires, no holder can race the
// marginal top — every holder takes the same order-fair taxed flat pro-rata
// (going later weakly HELPS, refund.go C-22/C-23), and the whale exit is
// priced by the K2 wind-down tax. See TestZZ_NoticeWindowBankRun for the
// before/after.
func RequireInflowOpen(s Store, creator string, block uint64) error {
	if err := requireMarketAcceptsMoney(s, creator, block); err != nil {
		return err
	}
	// DELIVERY GATE (RULING E, delivery.go — built 2026-07-27). A creator who
	// has ignored paying customers past the ruled threshold stops taking new
	// PURCHASES for a fixed penalty window. This is the ONLY place delivery
	// standing is ever consulted, on purpose: every outflow — Sell, Refund,
	// RefundHolder, Answer, Decline, Reclaim, ClaimTradeFees — reaches its
	// money without passing through this function, so the standing guardrail
	// (non-payment AND non-delivery never gate funds) holds structurally
	// rather than by remembering to check for it in each rail.
	if delinquent, until := DeliveryStanding(s, creator, block); delinquent {
		// ErrDelinquent, not ErrState: this is the one refusal downstream
		// consumers must be able to identify without reading the wording.
		return newErr(ErrDelinquent, "creator is delinquent on delivery: new purchases are closed until block "+evU64(until)+" (every payout, and paying the subscription, stays open)")
	}
	return nil
}

// requireMarketAcceptsMoney is RequireInflowOpen WITHOUT the delivery gate:
// paused, retired and phase only. It is the gate for money that is not a
// PURCHASE — today that is exactly Renew.
//
// WHY RENEW MUST NOT SEE THE DELIVERY GATE (defect found by code review,
// 2026-07-27, and it was fatal). Renew was calling RequireInflowOpen, so a
// delivery penalty blocked the creator from paying their subscription. The
// penalty runs DelinquencyBlocks (7 days); the subscription's OVERDUE grace is
// GraceBlocks (5 days). So a penalty landing anywhere near a renewal date ran
// PAST the grace, the market crossed into FROZEN — where Renew is illegal
// forever, because wind-down is terminal — and a self-clearing 7-day penalty
// became permanent destruction of the market, taking every holder onto the
// flat pro-rata wind-down rail with it. An attacker only had to time three
// junk asks. Renew is permissionless, so not even a fan could rescue it.
//
// It is also wrong on principle. A subscription payment is not new money
// entering the MARKET: it buys no tokens, touches no reserve, and goes to the
// platform treasury. It is the creator paying their bill — the one act that
// keeps them alive and lets them work off the penalty. Blocking a debtor from
// paying you is not a penalty, it is a trap. The gate exists to stop a
// non-delivering creator taking MORE customer money, and a renewal takes none.
func requireMarketAcceptsMoney(s Store, creator string, block uint64) error {
	if globalInflowPaused(s) {
		return newErr(ErrPaused, "inflows are globally paused")
	}
	if marketRetired(s, creator) {
		// A retired market is winding down: exits route through the flat
		// pro-rata Refund (inWindDown; Refund/RefundHolder never call this),
		// but no NEW money may enter — the curve rail is dropped. THM-1/THM-2.
		return newErr(ErrState, "market is retiring: new inflows are closed (exits remain open via flat pro-rata Refund)")
	}
	switch Phase(s, creator, block) {
	case StateActive, StateOverdue:
		return nil
	default:
		return newErr(ErrState, "market inflow is not open (frozen or closed)")
	}
}

// globalInflowPaused reads the single global inbound-pause switch (kPaused,
// keys.go: "global inbound pause"). "1" = paused, anything else (including
// unset) = not paused, matching the convention of the sibling hive-price-
// market codebase this project imitates. No admin.go exists yet in this
// package to toggle it; RequireInflowOpen is written to honour it regardless
// of who ends up flipping it.
func globalInflowPaused(s Store) bool {
	return getStr(s, kPaused()) == "1"
}

// Register binds a brand-new market to the creator's own Hive account. The
// caller MUST be the creator — SPEC §1.4's identity binding — so
// impersonation is structurally impossible: nobody can register a market
// "for" someone else.
//
// REGISTRATION IS FREE (LOCKED-MECHANISM "Revenue", USER-RULED 2026-07-21).
// This function used to require `feePaid >= RegistrationFee` (10 HBD) and
// book it to the treasury; that directly contradicted the binding ruling and
// is DELETED, constant and all (params.go no longer defines
// RegistrationFee). The spam filter is the Hive account-creation cost
// (~3 HIVE + RC) plus the one-market-per-account identity binding this
// function already enforces, which is strictly stronger than a $10 bond
// because it does not disappear when the bond is waived. Revenue is the
// 10 HBD/month subscription (Renew), the 12% service commission, and the 5%
// platform trade fee — the first month is free, so CREATING is genuinely
// free.
//
// A market may be (re-)registered when it has never existed, or when its
// last incarnation reached the terminal CLOSED state (SPEC §1.7.5: "a
// creator returning later re-registers and starts fresh"). It is rejected
// while a prior registration is still live (ACTIVE, and lazily
// OVERDUE/FROZEN under the hood — those never touch kState, so the raw
// stored value is still StateActive; see the Phase doc above).
//
// The optional atomic first buy lives in launch.go (RegisterWithFirstBuy);
// this signature is the n == 0 case and returns only an error, so every
// call site that does not want a launch buy stays a one-liner.
func Register(s Store, caller, creator string, block uint64, face, cap int64) error {
	_, err := RegisterWithFirstBuy(s, caller, creator, block, face, cap, nil)
	return err
}

// registerCheck runs EVERY registration guard and mutates NOTHING. Split out
// of Register so launch.go can validate the registration and the launch buy
// together, BEFORE either writes a single key — RULING G's "nothing mutates
// on a rejected call", applied across a two-part state transition.
func registerCheck(s Store, caller, creator string, face, cap int64) error {
	if caller != creator {
		return newErr(ErrAuth, "caller must be the creator (identity binding)")
	}
	if !validAccount(creator) {
		return newErr(ErrInput, "invalid creator account")
	}
	if globalInflowPaused(s) {
		return newErr(ErrPaused, "registration is globally paused")
	}

	// Duplicate-registration guard. kState only ever holds "" (never
	// registered), StateActive (live), or StateClosed (terminal wind-down).
	// Anything other than "" or StateClosed means a market is currently live
	// and this is a duplicate.
	if raw := getStr(s, kState(creator)); raw != "" && raw != StateClosed {
		return newErr(ErrState, "market already registered")
	}

	if face < MinFace || face > MaxFace {
		return newErr(ErrInput, "face out of range [MinFace, MaxFace]")
	}
	if cap < MinCap || cap > MaxCap {
		return newErr(ErrInput, "cap out of range [MinCap, MaxCap]")
	}

	// ---- THE RE-INCARNATION MONEY GUARD (2026-07-21) --------------------
	//
	// MEASURED DEFECT: Register admitted a CLOSED market back to ACTIVE
	// without ever looking at its money. On the old design a market whose
	// state read CLOSED with kReserve = 4,950 and kSupply = 0 was
	// re-registered, and the FIRST buyer of ONE token in the new incarnation
	// owned 100% of a supply backed by the DEAD incarnation's 4,950 —
	// floor(R*c/S) handed them the entire inherited reserve at wind-down.
	// That is precisely the "unallocated pot" the governing theorem forbids:
	// R === area(S) is the premise of the whole security argument, and a
	// fresh market that starts at S = 0 with R > 0 violates it at its first
	// block, before any transaction.
	//
	// THE FIX IS TO REFUSE, NOT TO CLEAR. Zeroing kReserve here would be an
	// ADMIN PATH TO A MARKET'S RESERVE — exactly what I4 forbids "in any
	// state" — and would silently destroy real HBD that the ledger still
	// holds, converting a solvency bug into a quiet loss. Register therefore
	// still never WRITES kReserve or kSupply (refund.go's four-writer table
	// and buy/sell's supply writers stay complete); it refuses to build a new
	// market on top of a non-empty old one and leaves the money exactly where
	// it is, visible, for the wind-down rail (Refund/RefundHolder, open in
	// FROZEN and CLOSED forever) to pay out. A creator whose old market still
	// holds a reserve gets a precise error instead of a poisoned new market.
	//
	// Both halves are checked, not just the reserve: supply > 0 with reserve
	// == 0 would mean tokens outstanding with nothing behind them, and the
	// new incarnation would dilute its own buyers against those ghosts.
	if r := getMoney(s, kReserve(creator)); r.Sign() != 0 {
		return newErr(ErrState, "previous incarnation still holds a reserve; wind it down first (Refund/RefundHolder) — a new market may never inherit money")
	}
	if sup := getMoney(s, kSupply(creator)); sup.Sign() != 0 {
		return newErr(ErrState, "previous incarnation still has supply outstanding; wind it down first — a new market may never inherit credits")
	}
	return nil
}

// registerApply performs every registration WRITE. INFALLIBLE by
// construction: it is only ever reached once registerCheck has passed, and
// nothing in it can reject. Callers (Register via RegisterWithFirstBuy, and
// the launch path) must have finished ALL their guards first.
func registerApply(s Store, creator string, block uint64, face, cap int64) {
	setStr(s, kState(creator), StateActive)
	setU64(s, kRegisteredAt(creator), block)

	// Reset the price-observation ring. SPEC §1.7.5 says a creator returning
	// after a wind-down "re-registers and starts fresh" — but neither Register
	// nor CloseIfDrained used to clear the TWAP state, so a re-registered
	// market could price its very first ask entirely off its PREVIOUS
	// incarnation's observations (proven end-to-end by the cross-module
	// harness: a brand-new market's first ask settled at a marker rate written
	// only in the old life). That silently reinstates the manipulation surface
	// twap.go exists to close, and it hurts whichever creator answers that ask.
	//
	// Zeroing the write counter is sufficient and costs one write: AskRate
	// derives its live set from this counter alone, so a fresh market reads
	// zero observations, refuses to price until MinObsCount new ones arrive,
	// and every slot it can subsequently reach has been overwritten.
	setU64(s, kObsIdx(creator), 0)

	// H4 DEFECT FIX (2026-07-21): clear the face anti-rug anchor too, right
	// beside the observation-counter reset above — same bug class, same fix
	// shape. Register used to reset kFace/kFaceSetAt/kObsIdx/kPaidUntil/
	// kState but NOT kFaceAnchor/kFaceAnchorAt, so a creator who moved their
	// face at least once in a PRIOR incarnation left a surviving, non-zero
	// anchor behind. SetFace's own band logic (below) opens a fresh window
	// only when the stored anchor reads exactly zero — otherwise it measures
	// the new incarnation's face changes against that OLD, unrelated anchor.
	// If re-registration happens within FaceBandWindow of that stale
	// anchor's block (a realistic case: a creator winds down and
	// immediately re-registers), the 2x/7d band silently measures against
	// the WRONG reference price, letting a face jump that is wildly outside
	// 2x of the freshly-registered face slip through as long as it still
	// falls within 2x of the old, defunct one — defeating the anti-rug
	// guarantee for exactly the returning creator SPEC §1.7.5 says should
	// "start fresh". Re-anchoring here (to zero, so SetFace opens a brand
	// new window at the newly-registered face on its very next call) closes
	// it the same way the kObsIdx reset closes the identical-shaped TWAP
	// leak above.
	setMoney(s, kFaceAnchor(creator), mZero()) // kFaceAnchor is money-typed, matching SetFace's own getMoney/setMoney convention
	setU64(s, kFaceAnchorAt(creator), 0)

	// DEFECT 1 FIX (2026-07-21): clear the retire mark too — same
	// stale-per-incarnation-state bug class as the kObsIdx/kFaceAnchor resets
	// above. A prior incarnation that reached CLOSED via Retire -> FROZEN ->
	// CloseIfDrained leaves the mark behind; without this clear, the
	// re-registered market (SPEC §1.7.5, "start fresh") would be dragged
	// straight back down the ladder by Phase's MAX even though its paidUntil
	// was just set fresh below. Clearing it here lets the returning creator's
	// new market start ACTIVE, exactly as the duplicate-registration path
	// intends. (Under RULING D the mark carries a HEIGHT, so a surviving mark
	// would be worse than before, not better: it would compute a notice
	// window from a defunct incarnation's block.)
	setU64(s, kRetiredAt(creator), 0)

	// PER-INCARNATION OFFERING CATALOGUE (2026-07-27): the same per-incarnation
	// reset as the eight keys above and for the identical reason — a returning
	// creator must never inherit a dead incarnation's posted price, band anchor
	// or service list (the H4 bug class). It is ONE write rather than a
	// key-by-key clear because offering ids are monotone and therefore sparse,
	// so enumerating them would be an unbounded loop inside registration; the
	// epoch bump makes the whole dead catalogue unreachable at once. See
	// keys.go for the full argument and the live-escrow-cannot-straddle proof.
	bumpOfferEpoch(s, creator)

	// DELIVERY STANDING IS PER-INCARNATION (defect found by code review,
	// 2026-07-27). The three delivery keys are plain per-market keys, so
	// without this a re-registered market inherits the DEAD incarnation's miss
	// counter and, worse, its unexpired delinquency — a brand-new market with
	// no customers and no history would open with its inflows already refused,
	// for a penalty earned by a market that no longer exists. Exactly the
	// stale-per-incarnation-state bug class as the kObsIdx/kFaceAnchor resets
	// above, and it also restores the premise launch.go's launchBuyCheck
	// relies on: immediately after registerApply a market cannot be delinquent,
	// so the first Buy is still infallible.
	setU64(s, kMissCount(creator), 0)
	setU64(s, kDeliveredCount(creator), 0)
	setU64(s, kDelinquentUntil(creator), 0)

	setU64(s, kPaidUntil(creator), block+SubscriptionPeriod)
	setMoney(s, kFace(creator), big.NewInt(face)) // kFace is money-typed, see SetFace
	setU64(s, kFaceSetAt(creator), block)         // the posted face counts as the first "set", starting the anti-rug clock immediately
	setMoney(s, kCap(creator), big.NewInt(cap))   // kCap is money-typed — prepay.go reads it via getMoney
}

// WHAT REGISTER DELIBERATELY DOES **NOT** CLEAR, and why each one is safe.
// This list is part of the fix: "clear every per-incarnation key" is only a
// true claim if the exceptions are enumerated and justified, not forgotten.
//
//   - kReserve, kSupply — REFUSED instead of cleared (registerCheck). Writing
//     them here would be an admin path to a market's reserve (I4) and would
//     destroy real HBD. See the guard's own comment.
//
//   - kAcqBlock(c,h) — per-HOLDER, an unbounded key set that no O(1)
//     registration can enumerate. It needs no clearing: the supply == 0
//     refusal above means every balance on this market is zero (I3: supply ==
//     Σ balances + escrowed), and the next inflow onto a zero balance
//     overwrites wacq with `block` exactly (C-14). So a fresh holder in the
//     new incarnation starts at hold time 0 — maximum exit tax, the
//     treasury-favouring direction — and can never inherit a dead
//     incarnation's age. (RULING K deleted kBasis, so there is no longer a
//     per-holder cost basis to reason about here at all.)
//
//   - kSeq — DELIBERATELY MONOTONE ACROSS INCARNATIONS. Resetting it to 0
//     would be actively unsafe: escrow records at kEscrow(c, seq) are never
//     deleted (ask.go flips status to ANSWERED/RECLAIMED and leaves the
//     record), so a reset counter makes the new incarnation's first Ask
//     OVERWRITE the old incarnation's record at seq 0 — silently destroying
//     the settlement history an indexer and any dispute rely on. A monotone
//     counter is the safe direction and costs nothing; kSeq is neither money,
//     nor a clock, nor a price, so it carries no value into the new life.
//     (A live PENDING escrow cannot survive into a new incarnation anyway:
//     escrowed credits keep kSupply > 0, which CloseIfDrained refuses to
//     close on and registerCheck refuses to register over.)
//
//   - kFeeBal(creator) — EARNED MONEY, pull-claimable (tradefee.go), not
//     market state. Clearing it would confiscate fees the creator already
//     earned in the old incarnation.
//
//   - kObs(c, i) ring SLOTS — the write counter kObsIdx is reset above, which
//     is sufficient and is what twap.go's AskRate derives its live set from;
//     the stale slot VALUES are unreachable until overwritten.

// Renew pays to extend paid_until. ANYONE may call it ("a fan can keep a
// creator alive") — there is no creator-only gate here, deliberately.
//
// paid_until is extended from max(now, current paid_until): a market that
// has already lapsed resumes counting from `block`, not from its stale
// paid_until, so a lapsed renewal doesn't "waste" the gap and doesn't let a
// creator stack periods on top of a paid_until that's already in the past.
//
// CRITICAL (SPEC §1.7.5): renewal is legal in ACTIVE and OVERDUE, and illegal
// in FROZEN/CLOSED — wind-down is terminal, a returning creator re-registers
// instead of renewing a frozen/closed market back to life. This is enforced
// by routing through RequireInflowOpen, the same phase+pause gate Prepay
// uses, so a renewal and a prepay are gated identically by construction.
func Renew(s Store, caller, creator string, block uint64, periods uint64, paid *big.Int) error {
	if caller == "" {
		return newErr(ErrAuth, "empty caller")
	}
	if !validAccount(caller) {
		return newErr(ErrInput, "invalid caller account")
	}
	if getU64(s, kRegisteredAt(creator)) == 0 {
		return newErr(ErrNotFound, "no such market")
	}
	// RULING D consequence, and the ONE inflow this file closes during the
	// retire notice. The notice phase is genuinely OVERDUE, so
	// RequireInflowOpen below would admit a renewal — but Phase takes the MAX
	// of the natural and retired ladders, so no amount of subscription can
	// lift a retired market back above OVERDUE, and at retiredAt+GraceBlocks
	// it is FROZEN whatever paidUntil says. Accepting the payment would
	// therefore be taking 10 HBD for something the mechanism structurally
	// cannot deliver — from the creator (who would gain nothing) or, worse,
	// from a well-meaning fan renewing a market they did not notice was
	// retiring. Refuse before RequireInflowOpen so the error names the actual
	// reason instead of a generic phase error. This also keeps the property
	// the instant-freeze version had: a retired wind-down is TERMINAL, and a
	// returning creator re-registers rather than renewing back to life.
	if marketRetired(s, creator) {
		return newErr(ErrState, "market is retiring; the wind-down is terminal and cannot be renewed back to life (re-register after it closes)")
	}
	// requireMarketAcceptsMoney, NOT RequireInflowOpen: a delivery penalty must
	// never stop a creator paying their subscription (see that function's doc —
	// doing so ran a 7-day penalty past the 5-day grace and destroyed the market
	// permanently).
	if err := requireMarketAcceptsMoney(s, creator, block); err != nil {
		return err
	}

	// periods is bounded at MaxPrepaidPeriods before any arithmetic runs, both
	// because SPEC caps prepayment there ("a lapsed market can never be
	// resurrected from an ancient prepayment") and, just as importantly, as
	// defense-in-depth against a uint64 overflow in periods*SubscriptionPeriod
	// below (mirrors hive-price-market's create.go, which bounds every input
	// BEFORE summing it into a block-height arithmetic expression).
	if periods < 1 || periods > MaxPrepaidPeriods {
		return newErr(ErrInput, "periods out of range [1, MaxPrepaidPeriods]")
	}
	if paid == nil {
		return newErr(ErrInput, "nil paid")
	}
	required := new(big.Int).Mul(new(big.Int).SetUint64(periods), big.NewInt(SubscriptionFee))
	if mLt(paid, required) {
		return newErr(ErrBalance, "paid below periods*SubscriptionFee")
	}

	cur := getU64(s, kPaidUntil(creator))
	base := cur
	if block > base {
		base = block
	}
	newPaidUntil := base + periods*SubscriptionPeriod

	// Reject (never silently clamp) an extension that would land further than
	// MaxPrepaidPeriods ahead of now — a payer who overshoots gets their whole
	// call refused rather than quietly short-changed on what their HBD bought.
	// This must be the LAST check before any state write: every guard above
	// this point is pure validation, so a rejected call here mutates nothing —
	// in particular the treasury booking below must never fire on a call that
	// is about to be refused.
	maxAllowed := block + MaxPrepaidPeriods*SubscriptionPeriod
	if newPaidUntil > maxAllowed {
		return newErr(ErrInput, "extension exceeds MaxPrepaidPeriods ahead of now")
	}

	// Subscription fee lands at treasury only once every guard has passed —
	// same accrual key and full-amount-booked convention as Register's
	// registration fee and Ask's commission leg (see the comment in Register).
	addMoney(s, kTreasury(), paid)
	setU64(s, kPaidUntil(creator), newPaidUntil)
	return nil
}

// Retire is M2's fix for permissionless-renew griefing: Renew is
// deliberately open to ANYONE ("a fan can keep a creator alive" — see
// Renew's own doc), which means a hostile stranger can renew a victim
// creator's market indefinitely far into the future, blocking the
// creator's own wind-down forever — the returning-creator path (SPEC
// §1.7.5, Register's duplicate-registration guard) requires reaching
// CLOSED first, and CLOSED requires FROZEN, and FROZEN requires the market
// to actually lapse. Without Retire, the creator has no way to escape a
// griefer's prepayment: they did not ask for that renewal, do not want it,
// and cannot undo it.
//
// Retire is the creator's own override: it starts an irreversible wind-down
// by stamping kRetiredAt with the current block, which Phase() then folds
// into the ladder as MAX(natural, retired). From this block on, Phase() is
// at least OVERDUE and — from retiredAt+GraceBlocks onward — at least
// FROZEN, regardless of how far into the future a hostile Renew had pushed
// paidUntil.
//
// RULING D — THE FIVE-DAY NOTICE IS THE POINT, NOT A COURTESY. See Phase's
// doc for the measurement (untaxed wind-down 205.53 HBD vs taxed curve exit
// 180.62 HBD for a fresh dominant creator) and for why the MAX preserves
// every property the instant-freeze version claimed. Read that before
// touching either function.
//
// DEFECT 1 FIX (2026-07-21): the first implementation of this M2 fix set
// kPaidUntil = block "unconditionally, to enter the OVERDUE ladder." That
// was WRONG in two ways, and is the exact bug this rewrite closes:
//
//   - For a market that has ALREADY lapsed (currently OVERDUE or FROZEN,
//     i.e. block >= old paidUntil), setting paidUntil = block RAISES it, so
//     Phase's `block <= paidUntil` check flips the market straight back to
//     ACTIVE — the OPPOSITE of retire. Concretely: (a) a creator retiring
//     their own FROZEN market un-froze it, breaking the intended wind-down;
//     and (b) a creator could dodge the subscription FOREVER by retiring
//     each time they approached FROZEN while OVERDUE, snapping paidUntil to
//     `now`, resetting the grace ladder, and getting back to ACTIVE = free
//     perpetual service.
//   - It also does not compose with a NORMAL lapse: retire must FROZEN a
//     market whatever its current phase, not "restart the ladder from now."
//
// A mark folded in with MAX, not a paidUntil poke, is the honest mechanism:
// the only arithmetic is retiredAt+GraceBlocks (an addition — no uint
// underflow to guard for low block heights, unlike setting paidUntil =
// block - GraceBlocks), and it cannot ever EXTEND a market's life — MAX can
// only push it DOWN the ladder. paidUntil is left untouched (the stranger's
// prepayment was real and is not refunded here — Retire is a pure
// billing-state override, moving no funds in either direction, crediting
// neither treasury nor reserve).
//
// ONCE-ONLY (new with RULING D, and load-bearing). Under the old instant
// freeze a second Retire was a harmless idempotent re-write of "1". Now the
// mark carries a HEIGHT, so re-arming it would MOVE THE NOTICE WINDOW
// FORWARD — and on a market a fan had renewed (natural phase ACTIVE) that
// re-arm would take an already-FROZEN market back to OVERDUE, i.e. Retire
// would have made a market LESS frozen. That is precisely what RULING D
// forbids and what the MAX exists to prevent, so the second call is refused
// outright rather than silently ignored: an "already retiring" error tells
// the creator the truth, and nothing mutates.
//
// TERMINAL: a retired market can never be renewed back to life — Renew
// refuses on the mark itself (see Renew), and once the notice expires
// RequireInflowOpen sees FROZEN and refuses every remaining inflow. A
// returning creator re-registers (once the market drains to CLOSED via
// CloseIfDrained); Register clears the mark so the fresh incarnation starts
// ACTIVE.
//
// Creator-only, market-must-exist, not-already-CLOSED — the identical guard
// SetFace/SetCap already share via requireOpenCreatorMarket, since like
// them, Retire changes billing STATE, not funds, and is deliberately NOT
// gated on the global pause or on the current phase itself (a creator
// mid-OVERDUE, or mid-hostile-renewal ACTIVE, must still be able to retire).
func Retire(s Store, caller, creator string, block uint64) error {
	if err := requireOpenCreatorMarket(s, caller, creator); err != nil {
		return err
	}
	if marketRetired(s, creator) {
		return newErr(ErrState, "market is already retiring; the notice window cannot be restarted")
	}
	// block+1 is the "0 means never retired" encoding (kRetiredAt's doc).
	// The saturation is unreachable on any real chain — a uint64 height at
	// 3s blocks is ~1.7e12 years away — but a silent wrap to 0 would read
	// back as "not retired" and un-freeze the market, so it is pinned rather
	// than assumed: at the ceiling the mark saturates, which keeps the market
	// retired (fail-closed) instead of quietly un-retiring it.
	mark := block + 1
	if mark == 0 {
		mark = ^uint64(0)
	}
	setU64(s, kRetiredAt(creator), mark)
	return nil
}

// requireOpenCreatorMarket is the shared creator-only + market-exists +
// not-terminally-closed guard for the two config setters below (SetFace,
// SetCap). Unlike Renew/Prepay, these do not move funds, so — deliberately —
// they are NOT gated on OVERDUE/FROZEN or on the global pause: API.md's rule
// is that billing state gates FUNDS, and a creator adjusting their posted
// price or cap while catching up on a lapsed subscription (arguably exactly
// when they most need to) is not a fund flow. A CLOSED market is different:
// it is terminal and has no live config left to change — SPEC §1.7.5 routes
// that case through Register, not through these setters.
func requireOpenCreatorMarket(s Store, caller, creator string) error {
	if caller != creator {
		return newErr(ErrAuth, "creator only")
	}
	if getU64(s, kRegisteredAt(creator)) == 0 {
		return newErr(ErrNotFound, "no such market")
	}
	if getStr(s, kState(creator)) == StateClosed {
		return newErr(ErrState, "market closed; re-register instead")
	}
	return nil
}

// requireShopEditable is requireOpenCreatorMarket plus "and this market is not
// already dying" — the guard the offering catalogue writers use (offerings.go).
//
// WHY THE SHOP IS STRICTER THAN SetFace/SetCap (2026-07-27). Retire is
// irreversible and closes inflows immediately (RequireInflowOpen consults
// marketRetired), so an offering created or repriced after Retire can NEVER be
// bought: every Ask against it is refused for as long as the market exists.
// Listing a service at a price nobody can ever pay is not a harmless no-op —
// listOfferings is the buyer-facing shop, and a freshly posted, freshly priced
// item there reads as available. SetFace and SetCap deliberately keep the
// looser guard: they mutate a single scalar that the wind-down rails ignore
// entirely, and tightening them would change behaviour their own tests pin.
func requireShopEditable(s Store, caller, creator string) error {
	if err := requireOpenCreatorMarket(s, caller, creator); err != nil {
		return err
	}
	if marketRetired(s, creator) {
		return newErr(ErrState, "market is retiring: the shop is closed (existing escrows still resolve normally)")
	}
	return nil
}

// SetFace changes the creator's posted HBD ask price, enforcing the 2x/7d
// anti-rug band (SPEC §1.1/§1.3b) in BOTH directions: a face change is
// bounded to [old/FaceBandNumerator, old*FaceBandNumerator] whenever the
// PREVIOUS change landed inside the FaceBandWindow. Outside the window (or on
// the very first change after Register, whose faceSetAt starts the clock at
// registration time) the only remaining bound is the fixed [MinFace, MaxFace]
// protocol range.
//
// kFace is money-typed (*big.Int via getMoney/setMoney), matching prepay.go's
// convention for kCap — this file follows the same convention for kFace for
// internal consistency, even though the wire signature takes a plain int64.
func SetFace(s Store, caller, creator string, block uint64, newFace int64) error {
	if err := requireOpenCreatorMarket(s, caller, creator); err != nil {
		return err
	}
	if newFace < MinFace || newFace > MaxFace {
		return newErr(ErrInput, "face out of range [MinFace, MaxFace]")
	}

	// THE BAND ANCHORS TO A WINDOW, NOT TO THE LAST CHANGE.
	//
	// The first implementation compared each new face against the PREVIOUS face
	// and reset the clock on every call, so the limit compounded with no
	// required spacing: 1000 -> 2000 -> 4000 -> 8000 in three consecutive
	// blocks, and ~100,000x inside seventeen back-to-back calls. That is not
	// "2x per 7 days" (the ruling in SPEC §1.3b); it is 2x per transaction.
	//
	// An exploiter scrutinizer showed why it matters beyond rug-pull speed:
	// creditsForAsk reads `face` live at execution time, and intra-block
	// transaction order is producer-chosen and NOT consensus-enforced on this
	// chain, so a creator could stack SetFace calls ahead of a victim's pending
	// ask, have it settle at the inflated price, and restore the face after.
	//
	// So: an anchor face and an anchor block are pinned when a window opens,
	// and every change inside that window is measured against the ANCHOR. The
	// total excursion over 7 days is 2x no matter how many calls are made.
	anchorFace := getMoney(s, kFaceAnchor(creator))
	anchorAt := getU64(s, kFaceAnchorAt(creator))
	if anchorFace.Sign() == 0 { // first change since registration: open a window at the current face
		anchorFace = getMoney(s, kFace(creator))
		anchorAt = getU64(s, kFaceSetAt(creator))
	}

	var elapsed uint64
	if block > anchorAt { // defensive: a non-monotone block keeps the band ACTIVE rather than lifting it
		elapsed = block - anchorAt
	}
	if elapsed >= FaceBandWindow {
		// The window has expired: a NEW one opens, anchored at the face in
		// effect right now. The band still applies against that fresh anchor —
		// waiting out the window earns another 2x of headroom, not a licence to
		// jump anywhere. (The first version of this fix skipped the check on
		// this branch, which meant seven days of patience bought an unbounded
		// move — the same defect as the compounding one, just slower.)
		anchorFace = getMoney(s, kFace(creator))
		anchorAt = block
	}
	if anchorFace.Sign() > 0 {
		newFaceBig := big.NewInt(newFace)
		lower := new(big.Int).Div(anchorFace, big.NewInt(int64(FaceBandNumerator)))
		upper := new(big.Int).Mul(anchorFace, big.NewInt(int64(FaceBandNumerator)))
		if mLt(newFaceBig, lower) || mGt(newFaceBig, upper) {
			return newErr(ErrInput, "face change exceeds the 2x/7-day band (measured against the window anchor, not the last change)")
		}
	}
	setMoney(s, kFaceAnchor(creator), anchorFace)
	setU64(s, kFaceAnchorAt(creator), anchorAt)

	setMoney(s, kFace(creator), big.NewInt(newFace))
	setU64(s, kFaceSetAt(creator), block)
	return nil
}

// SetCap changes the creator's outstanding-credit ceiling. It may never be
// set below the CURRENT supply — doing so would strand already-issued
// credits against a cap that claims they shouldn't exist (I3 depends on the
// cap only ever bounding future issuance, never retroactively invalidating
// past issuance). kCap is money-typed to match prepay.go's own
// `getMoney(s, kCap(creator))` read.
func SetCap(s Store, caller, creator string, block uint64, newCap int64) error {
	if err := requireOpenCreatorMarket(s, caller, creator); err != nil {
		return err
	}
	if newCap < MinCap || newCap > MaxCap {
		return newErr(ErrInput, "cap out of range [MinCap, MaxCap]")
	}

	supply := getMoney(s, kSupply(creator))
	if mLt(big.NewInt(newCap), supply) {
		return newErr(ErrCap, "cap cannot be set below current supply")
	}

	setMoney(s, kCap(creator), big.NewInt(newCap))
	return nil
}
