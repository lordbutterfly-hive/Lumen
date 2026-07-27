package core

import "math/big"

// refund.go — the wind-down rail: flat pro-rata refunds, now TAXED (RULING A
// money-core rewrite + RULING K2/K3, RULINGS-v2-2026-07-21/22).
//
// THE MECHANISM: once a market winds down (creator Retire — from the retire
// block, INCLUDING the notice, RULING K3; or a natural subscription lapse
// past grace to FROZEN; or a drain to CLOSED), buys are structurally dead
// (RequireInflowOpen refuses a retired or frozen market) and the reserve —
// which the trading phase kept EXACTLY equal to the curve area, R === area(S),
// curve.go — is distributed flat pro-rata, with the SAME hold-time exit tax
// the curve charges carved to the treasury (RULING K2):
//
//	gross(c) = floor(R·c/S)                         the pro-rata slice
//	tax      = ceil(gross · τ(h) / 10000)           to kTreasury() (K2)
//	R       −= gross                                 reserve pays the FULL gross
//	holder receives gross − tax                      net, no fee, no commission
//
// The tax is a pure carve from the holder's payout: the reserve is debited the
// full gross either way, so R's wind-down trajectory and every fairness
// property below (C-22/C-23/C-24) are UNCHANGED by it — a fresh whale who
// Retires to dodge the curve tax now pays the identical rate on the way out
// (THM-1's residual whale exit, closed), a six-week holder pays 0.
//
// THE GOVERNING THEOREM (RULINGS v2 — this is why flat pro-rata is safe and
// needs no weighting, no hold-time term, no cap): a fresh buyer of n tokens
// at supply S pays cost = area(S+n) − area(S) and can redeem at most
// payout = floor(area(S+n)·n/(S+n)) at wind-down. In curve units,
// cost ~ n(2S+n+1)/2 · PS/D and payout ~ n(S+n+1)/2 · PS/D — the margin is
// n·S/2·PS/D >= 0, zero only at S == 0 (buying the whole market from
// nothing and winding it down returns exactly what was paid, minus the 10%
// buy fee). Profit is ARITHMETICALLY IMPOSSIBLE for every n, every wait,
// every hold time — verified 30/30 (S,n) pairs at exact integers, and
// property-tested here. The load-bearing premise is R === area(S) WITH
// EQUALITY at the freeze: one unit of unallocated excess is one unit a
// fresh buyer can dilute into pro-rata, and any exit-side patch against
// that (hold-weights, snapshots) divides a pot by a PURCHASABLE weight and
// is drainable (v2's purchasable-weight lemma — the withdrawn v1 design
// measured 97.5% of the pot to a 5-day attacker). Keep the equality, and
// the whole drain class is closed by arithmetic, not by patches.
//
// THE PAR CAP IS DELETED (RULING A's hard gate — this deletion and the
// money-tax land in the same commit, nothing staged): the old
// refundPayout capped every payout at credits·PAR == credits, i.e. at ONE
// base unit per token. Under PAR (1:1 mint) that cap was provably dead code
// — reserve == supply made floor(R·c/S) == c exactly. Under the curve it
// was a CONFISCATION: curve backing runs ~10.5 units per token-index
// (PS=21/D=2), so a curve-priced position refunded at 1 unit/token loses
// 99.98% of its backing to a cap built for a mechanism that no longer
// exists. Not a rounding choice — a correctness deletion.
//
// ---------------------------------------------------------------------------
// THE RAIL RECONCILIATION (this file's half of C-21; sell.go holds the
// other): the old Refund was deliberately state-blind — correct under PAR,
// where a refund paid at most the PAR deposit back and could never
// interact with a curve. Under the curve an ungated pro-rata during a LIVE
// (recoverable) market is a tax-and-fee bypass (a dominant holder's pro-rata
// converges to the full curve payout as c → S) and it breaks R === area(S)
// downward-into-excess (pro-rata pays the AVERAGE while the curve stops
// backing the MARGINAL, stranding E = R − area(S') > 0 in a state where fresh
// buys could then raid it). So the exit ROUTES on inWindDown (market.go), and
// every state has exactly one open rail:
//
//	NOT winding down (ACTIVE, natural-lapse OVERDUE)
//	              → Sell (curve proceeds; tax + fee apply)         [sell.go]
//	WINDING DOWN (RETIRED at any point, or naturally FROZEN/CLOSED)
//	              → Refund (pull) + RefundHolder (push): flat pro-rata,
//	                TAXED (K2), no fee, no commission              [this file]
//
// Confining flat pro-rata to inWindDown states is what keeps the stranded
// excess UN-raidable: RETIRED is irreversible (Renew refuses on the mark) and
// FROZEN/CLOSED is terminal, so no fresh buyer can ever re-enter to dilute the
// pot. A natural-lapse OVERDUE window is NOT inWindDown — it is recoverable, so
// it keeps the curve rail (RULING K3 leaves it exactly where it was).
//
// NO STATE LEAVES A HOLDER TRAPPED, proven by cases: inWindDown is total and
// partitions every (creator, block) into exactly one rail; Sell covers
// NOT-winding-down, Refund covers winding-down; neither reads kPaused — the
// global pause gates inflows only, so OUTFLOWS NEVER PAUSE holds verbatim; a
// CLOSED market has supply == 0 by construction (CloseIfDrained), so every
// balance is already 0 (I3) and Refund degrades to "nothing left to pay", not
// to a block. Both wind-down triggers are one-way within an incarnation
// (RETIRED is irreversible; Register requires CLOSED to start fresh), so the
// two rails can never interleave: no state exists in which a holder with a
// balance has zero open rails, and none in which both rails are open at once.
// (RULING J note: ClaimTax, which this paragraph used to name beside
// ClaimTradeFees, is GONE with the holder distribution — the tax goes to
// treasury at the instant it is paid, so no holder ever holds an unclaimed tax
// share that a phase could strand.)
//
// RefundHolder (the permissionless push) keeps its H3 gate for the
// additional consent reason documented on the function: gating the PUSH,
// never the PULL, is what stops a stranger force-liquidating a live
// position; at wind-down the two coincide. It carries a SECOND consent gate
// (EXITTAX-1/NOTICE-1, 2026-07-22): the push refuses while the holder's K2
// exit tax is still nonzero, so a stranger can never crystallize a still-fresh
// holder's tax to the treasury and deny them the decay — INSIDE the first
// ExitTaxDecayBlocks of wind-down. That gate alone was a permanent close DoS
// (a griefer keeps a position fresh with cheap transfers forever), so it is
// BACKSTOPPED by a market-level clock (FIX ROUND 2, EXITTAX-DOS-1/NOTICE-1/
// OUTFLOW-K-2): once the market itself has been winding down for a full
// ExitTaxDecayBlocks (windDownOpenBlock — a clock no transfer can refresh) the
// push fires regardless, so the sweep and the CLOSE it enables are at most
// DELAYED, never blocked. See the inline gate for the full argument.
// ---------------------------------------------------------------------------
//
// THE COMPLETE kReserve WRITER TABLE (I4 — grep kReserve to verify; nothing
// else writes it, ever — there is NO admin path to any market's reserve):
//
//	Buy          +BuyCost(S,n)  == area step   R === area(S) preserved
//	Sell         −SellProceeds  == area step   R === area(S) preserved
//	Refund       −floor(R·c/S)                 wind-down only (inWindDown)
//	RefundHolder −floor(R·bal/S)               wind-down only (inWindDown)
//
// Register/Renew/SetFace/SetCap/Retire, Ask/Answer/Reclaim, Unlock/Book,
// TransferCredits, ClaimTradeFees/WithdrawTreasury, pause: ΔR = 0
// structurally (they move token balances or separate HBD legs). Both Sell's
// tax leg (RULING J) and the wind-down tax leg (RULING K2) credit kTreasury
// out of the PAYOUT — carved AFTER the reserve debit, never a second reserve
// touch, so the reserve delta is exactly the ±curve/pro-rata step in the table.

// refundPayout is the single place the wind-down rounding happens, so
// RefundPrice, Refund and RefundHolder can never disagree with each other
// about what a given (reserve, credits, supply) triple is worth:
//
//	floor(reserve·credits/supply)
//
// This is the GROSS pro-rata slice — the amount the RESERVE pays out. The K2
// exit tax is carved from it by the callers (Refund/RefundHolder), never here,
// so all the reserve-trajectory properties below reason about this gross value
// and are UNAFFECTED by the tax (the tax moves the holder's NET, not R).
//
// Floor (never ceil) so a payout never exceeds the reserve's pro-rata share;
// the floor dust is not lost — it accrues to LATER claimants (C-22 below).
// supply must be > 0; every caller checks first (big.Int division by zero
// panics, and every panic on a fund-outflow path is a DoS).
//
// THE WIND-DOWN ARITHMETIC, PROVEN (all property-tested; all on the GROSS
// reserve slice, so the K2 tax does not perturb any of them):
//
//	No over-draw:   c <= S (I3) ⇒ R·c/S <= R ⇒ floor <= R. Every
//	                subMoney(kReserve, gross) below is provably safe.
//	C-22 (ratio rises): after refunding c < S, R' = R − floor(R·c/S)
//	                = ceil(R(S−c)/S) ⇒ R'·S >= R·(S−c) = R·S' — the
//	                reserve-per-token weakly RISES as wind-down proceeds:
//	                floor dust flows forward, never out. (Going later weakly
//	                HELPS on the gross slice; the tax is a flat proportional
//	                carve at the SAME rate for a same-aged holder, so the
//	                order-fairness the ruling asks for is on the gross and
//	                survives verbatim.)
//	C-23 (no bank run): gross_h >= floor(R_open·bal_h/S_open) — every
//	                holder is bounded below by the ratio at wind-down open;
//	                going later weakly HELPS. There is no race.
//	C-24 (terminal exactness): the last claim (c == S_remaining) debits the
//	                reserve floor(R·S/S) == R with zero remainder, so over any
//	                complete wind-down, in any order, mixed Refund/
//	                RefundHolder: Σ gross debits == R_open exactly, terminal
//	                state R == 0 == area(0). ZERO dust, ZERO stranded residual
//	                at CloseIfDrained (RULING B). Holders RECEIVE Σ(gross − tax)
//	                and the treasury collects Σ tax; the reserve still drains to
//	                exactly 0.
func refundPayout(reserve, credits, supply *big.Int) *big.Int {
	return mMulDiv(reserve, credits, supply) // floor(reserve·credits/supply) — GROSS, pre-tax
}

// RefundPrice is the CURRENT wind-down value of a single token:
// floor(reserve/supply), in HBD base units. No error return by contract — an
// unregistered or fully-drained creator simply reads supply == 0 and this
// returns 0 without dividing, the same "degrade safely, never panic on bad
// input" convention twap.go's RecordObs documents for its own no-error path.
//
// THE PAR CAP IS GONE (see the file header): under the curve, reserve/supply
// legitimately exceeds 1 by design — capping at PAR here confiscated the
// entire floor above 1 unit/token. For COMPARISONS use cross-multiplication
// (R'·S >= R·S'), never this floored value.
func RefundPrice(s Store, creator string) *big.Int {
	supply := getMoney(s, kSupply(creator))
	if mIsZero(supply) {
		return mZero()
	}
	return refundPayout(getMoney(s, kReserve(creator)), big.NewInt(1), supply)
}

// Refund burns `credits` out of the CALLER's own balance (the pull half —
// API.md rule 2) and pays them flat pro-rata out of the reserve, LESS the K2
// exit tax. Wind-down rail: inWindDown only (RETIRED including its notice, or
// naturally FROZEN/CLOSED) — the rail switch this file's header reconciles
// (while the market trades the holder's exit is Sell; the gate ROUTES, it
// never removes). Reads inWindDown() ONLY — never RequireInflowOpen, never
// kPaused: outflows never pause, and the wind-down rail must survive kPaused
// frozen at "1" forever.
//
// No commission, no FEE — but a TAX (RULING K2): the same hold-time-decaying
// exit tax the curve charges is carved to the treasury on the way out, so the
// wind-down is not a tax-free escape hatch for a fresh whale who Retires (I5
// still holds: no COMMISSION is skimmed — commission is delivered-service
// revenue, which a wind-down is not; the exit tax is a different instrument, a
// decaying redemption fee that prices impatience at every value-out door).
// Returns the NET the holder receives (gross − tax); the wrapper transfers
// exactly this. RULING K deleted the cost basis, so the debit moves only the
// balance.
//
// RULING G ordering: every guard runs first; after the guards, no step can
// fail (debitBalance's own check is a proven-redundant re-check; the
// reserve subMoney is provably in range). Nothing mutates on a rejected
// call.
//
// minNet (variadic, OPTIONAL — OUTFLOW-CLIFF-1, FIX ROUND 4): the caller's
// signed floor on the net they receive, enforced by checkMinNet (sell.go) after
// the net is computed and BEFORE any write. Same rationale as Sell's: the K2
// wind-down tax rate reads the live, transfer-refreshable hold clock, so a
// same-block forced TransferCredits can nudge a six-week 0%-tax holder to the
// ceil-minimum 1 bps on their whole pro-rata slice; a supplied floor makes that
// front-run revert cleanly. Absent/nil = no guard (the escape hatch that keeps
// this outflow always available — OUTFLOWS-NEVER-PAUSE / RULING G). This is a
// pure pre-write gate: R === area(S) and every C-22/C-23/C-24 fairness property
// are untouched (checkMinNet changes no money math). The permissionless PUSH
// (RefundHolder) takes no minNet — the pusher is not the holder and cannot sign
// their slippage; it is instead protected by its own K2 tax gate + wind-down
// backstop (below).
func Refund(s Store, caller, creator string, block uint64, credits *big.Int, minNet ...*big.Int) (*big.Int, error) {
	if !validAccount(caller) {
		// Rejects empty caller too. Closes the same key-collision class every
		// sibling closes: kBal concatenates "bal|"+creator+"|"+holder with no
		// escaping, so a caller containing '|' could alias another
		// (creator,holder) pair's balance key. validAccount structurally
		// excludes '|'.
		return nil, newErr(ErrAuth, "invalid caller")
	}
	if !validAccount(creator) {
		return nil, newErr(ErrInput, "invalid creator")
	}
	if credits == nil || credits.Sign() <= 0 {
		return nil, newErr(ErrInput, "credits must be positive")
	}

	balKey := kBal(creator, caller)
	bal := getMoney(s, balKey)
	if mLt(bal, credits) {
		return nil, newErr(ErrBalance, "insufficient credits")
	}

	// The rail switch — inWindDown ONLY, never the pause; see the file header
	// for the full reconciliation and the trapped-holder impossibility proof.
	// The wind-down rail is open exactly when the curve rail is closed: a
	// RETIRED market (including its notice, RULING K3) or a naturally
	// FROZEN/CLOSED one.
	if !inWindDown(s, creator, block) {
		return nil, newErr(ErrState, "pro-rata refund opens only at wind-down (retired/frozen/closed); while the market trades, exit via Sell — the curve rail is open in exactly those states")
	}

	supply := getMoney(s, kSupply(creator))
	if mIsZero(supply) {
		// bal >= credits > 0 was just proven above, so by I3 supply cannot
		// legitimately be 0 here. Refuse rather than divide by zero.
		return nil, newErr(ErrState, "supply is zero but caller holds a balance")
	}
	reserve := getMoney(s, kReserve(creator))
	gross := refundPayout(reserve, credits, supply)
	// K2 — THE WIND-DOWN IS TAXED. The same hold-time-decaying exit tax the
	// curve charges (τ(h) = ExitTaxBpsAt of the caller's hold clock) is carved
	// from the pro-rata payout to the treasury: a FRESH whale who Retires to
	// escape the curve tax pays the identical rate on the way out (closing
	// THM-1's residual whale exit), while a six-week holder pays 0. The reserve
	// is debited the FULL gross either way (below), so R's wind-down trajectory
	// — and every fairness property C-22/C-23/C-24 proves on it — is UNCHANGED
	// by the tax; the tax is a pure carve from the holder's payout, no
	// aggregate, RULING G-clean.
	taxBps := ExitTaxBpsAt(heldBlocksAt(s, creator, caller, block))
	tax := ExitTaxOn(gross, taxBps)
	net := new(big.Int).Sub(gross, tax) // >= 0: tax = ceil(gross·τ/1e4) <= gross for τ <= 2000

	// ECON-2 RATIFIED (PRUNED 2026-07-22, owner ruling): the wind-down rail
	// carves ONLY the exit tax — deliberately NO trade fee, unlike Sell
	// (sell.go's tradeFeeOn). Charging holders the platform's 5% while they
	// exit a dying market is holder-hostile; the foregone fee is the platform's
	// own small, self-limiting revenue. This is INTENDED POLICY, not an
	// oversight — do NOT "fix" it by adding tradeFeeOn here.

	// OUTFLOW-CLIFF-1 guard — the caller's signed floor on net, checked BEFORE
	// any write (RULING G): a tripped guard mutates nothing and leaves R ===
	// area(S) untouched. See checkMinNet (sell.go) for the full autopsy.
	if err := checkMinNet(net, minNet); err != nil {
		return nil, err
	}
	// NOTE (BUY-INT64, PRUNED 2026-07-22): deliberately NO int64 guard on this
	// OUTFLOW — RULING G forbids rejecting a holder's exit on an amount, and
	// core is unbounded by design (TestRefund_LargeAmountsBeyondInt64 asserts
	// exactly that). A payout > MaxInt64 needs a reserve larger than all HBD in
	// existence; the wrapper's narrowing + host-revert covers that tail. The
	// int64 guard lives only on Buy (an inflow).

	if err := debitBalance(s, creator, caller, credits); err != nil {
		return nil, err // unreachable: bal >= credits was just proven
	}
	if err := subMoney(s, kSupply(creator), credits); err != nil {
		return nil, err // unreachable: supply >= bal >= credits by I3
	}
	if err := subMoney(s, kReserve(creator), gross); err != nil {
		// Unreachable: gross <= reserve always (no-over-draw, file header).
		// Kept as the same defense-in-depth every subMoney call carries.
		return nil, err
	}
	accrueExitTax(s, creator, caller, tax) // 50/50 creator/platform, self-sell to treasury (exittax.go)
	return net, nil                        // the holder RECEIVES net (gross − tax); the wrapper transfers exactly this
}

// RefundHolder is the permissionless push half of the same mechanism (SPEC
// §1.7.5): "refundHolder(market, holder) is permissionless and can only ever
// pay the rightful owner — never the caller." `caller` therefore plays NO
// role in any key this function reads or writes — it is checked only for
// non-emptiness (an authenticated-but-arbitrary trigger), never validated
// against the account charset the way `creator`/`holder` are, because unlike
// Refund's `caller` it never participates in constructing a storage key.
//
// H3 DEFECT FIX (2026-07-21, kept): gated to inWindDown — before the fix
// anyone could force-liquidate any holder's live position at will. Gating
// the PUSH, never the PULL, was the fix's shape; under RULING A/K the pull is
// rail-routed on the same inWindDown predicate (see the file header), and the
// two gates now coincide.
//
// EXITTAX-1 / NOTICE-1 FIX (2026-07-22, kept) + DoS BACKSTOP (FIX ROUND 2): a
// SECOND gate on top of H3 — the permissionless push refuses while the pushed
// holder's exit tax (RULING K2, on their own hold clock) is still nonzero, so a
// stranger cannot force a still-fresh holder to crystallize up to 20% of their
// backing to the treasury and be denied the decay K2 promises — UNLESS the
// market has already been winding down for a full ExitTaxDecayBlocks
// (windDownOpenBlock), at which point the push fires regardless of the holder's
// (transfer-refreshable) clock. Without that backstop the personal-clock gate
// was a permanent close/re-register DoS (a griefer bounces a wind-down position
// between two accounts to keep it perpetually fresh); with it, an abandoned
// position is sweepable at the LATER of its own decay or the market's, so a
// still-fresh holder is protected for the first six weeks yet CLOSE is at most
// delayed, never blocked. See the inline gate below for the full
// griefing-unprofitable / whale-dodge-closed / never-trapped / liveness argument.
//
// Refunds the holder's ENTIRE balance — no partial push, only partial pull
// via Refund. `caller` never appears in a state-mutating key, so there is
// structurally no way for this function to pay anyone but `holder`. If the
// keeper dies, every holder can still self-Refund; if a holder is absent,
// anyone can push their refund to them here.
//
// A holder with a zero balance is a harmless no-op: (0, nil), no state
// touched — a keeper can sweep an entire holder list without pre-filtering.
// The no-op sits behind the phase gate (the guard runs before the balance
// read), so a zero-balance push outside wind-down is rejected exactly like
// a nonzero one.
func RefundHolder(s Store, caller, creator, holder string, block uint64) (*big.Int, error) {
	if caller == "" {
		return nil, newErr(ErrAuth, "empty caller")
	}
	if !validAccount(creator) {
		return nil, newErr(ErrInput, "invalid creator")
	}
	if !validAccount(holder) {
		return nil, newErr(ErrInput, "invalid holder")
	}
	if !inWindDown(s, creator, block) {
		return nil, newErr(ErrState, "refundHolder is only available once wind-down opens (retired/frozen/closed); the holder may still exit via Sell on the live curve")
	}

	balKey := kBal(creator, holder)
	bal := getMoney(s, balKey)
	if mIsZero(bal) {
		return mZero(), nil
	}

	// EXITTAX-1 / NOTICE-1 FIX (FIX ROUND 1, 2026-07-22) — THE PERMISSIONLESS
	// PUSH MAY ONLY FIRE ONCE THE HOLDER'S OWN EXIT TAX HAS FULLY DECAYED TO 0.
	//
	// RefundHolder is permissionless (anyone may trigger it; it can only ever
	// pay `holder`) and, under RULING K2, it taxes the pushed holder's OWN hold
	// clock. Those two facts together were a real force-liquidation / exit-tax
	// vector: a third party — a griefer, the rugging creator right after a wave
	// of fresh buys (they control WHEN wind-down opens via Retire), or the
	// platform owner who ultimately banks kTreasury — could FORCE a still-fresh
	// holder's exit the instant a market wound down and crystallize up to
	// MaxExitTaxBps (20%) of that holder's pro-rata backing to the treasury
	// against their will. That defeats RULING K2's OWN stated mitigation for "a
	// genuine fresh holder caught in someone else's wind-down" — *the decay
	// clears it for anyone who has held* — because a permissionless push denies
	// the holder the chance to hold: the self-Refund pull is the only way to
	// capture the decay, and an involuntary push takes that choice away.
	//
	// The push tax is load-bearing and must NOT simply be zeroed: a tax-free
	// push would reopen the whale escape K2 exists to close (a fresh dominant
	// holder gets an ally to push their position at 0 tax, dodging the wind-down
	// tax entirely). So the resolution REFUSES the push while it would charge
	// anything, confining it to its actual purpose — sweeping ABANDONED
	// (fully-aged) positions to drain a market toward CLOSE — and never a
	// treasury-funding force-liquidation of a live, taxable holder.
	//
	// Correct on every side:
	//   - GRIEFING CLOSED: a still-taxed holder can be exited only by their OWN
	//     choice (self-Refund, taxed at their clock — the accepted K2 cost); no
	//     stranger can impose the taxed exit on them.
	//   - WHALE DODGE CLOSED: a fresh whale cannot be pushed out at 0 tax by an
	//     ally (refused while their tax > 0); their exits are the taxed
	//     self-Refund now, or waiting the full decay — which legitimately earns
	//     tau = 0 whether they then pull or are pushed. No escape.
	//   - HOLDER NEVER TRAPPED: the self-Refund pull is open in every wind-down
	//     state at all times (file header), so refusing the push removes a
	//     hostile option, never the holder's own exit.
	//   - LIVENESS PRESERVED, AND NOW BOUNDED (FIX ROUND 2, 2026-07-22): an
	//     abandoned position becomes sweepable at the LATER-of two clocks — its
	//     own decay, OR a full ExitTaxDecayBlocks after the MARKET's wind-down
	//     opened (windDownOpenBlock, market.go). See the DoS backstop below.
	//
	// ─────────────────────────────────────────────────────────────────────────
	// THE DoS BACKSTOP (EXITTAX-DOS-1 / NOTICE-1 / OUTFLOW-K-2, FIX ROUND 2):
	// gating SOLELY on the holder's OWN clock was a permanent market-close /
	// re-registration DoS. The hold clock re-averages toward `now` on EVERY
	// inflow (holdclock.go C-14), and TransferCredits is open in every phase
	// (transfer.go, correctly — credits are property), so a griefer can keep a
	// wind-down position PERPETUALLY fresh by bouncing it between two accounts
	// once per <ExitTaxDecayBlocks: taxBps never reaches 0, the push is refused
	// forever, supply never drains, CloseIfDrained (below) never fires, and the
	// identity-bound creator can NEVER re-register their market (registerCheck
	// refuses on nonzero reserve/supply, market.go). The "sweepable
	// ExitTaxDecayBlocks after its LAST inflow" liveness claim was FALSE —
	// "last inflow" is attacker-controlled and free, so the horizon was
	// unbounded (proven: a 503-day-old retired wind-down still un-closeable).
	//
	// THE ROOT CAUSE is that the eligibility clock was the transfer-refreshable
	// PERSONAL clock. The fix anchors liveness to a clock NO transfer can touch:
	// windDownOpenBlock — retiredAt for a Retire (irreversible), or the
	// paidUntil+GraceBlocks freeze block for a natural lapse. Once the MARKET
	// has been winding down for a full ExitTaxDecayBlocks, the push fires
	// REGARDLESS of the holder's refreshed clock, taxing whatever their live
	// clock reads (still carved to the treasury, RULING K2). This restores the
	// "never blocked, at most delayed" guarantee the gate promised.
	//
	// Every protection the personal-clock gate gave is KEPT inside the window:
	//   - FRESH-HOLDER PROTECTED (EXITTAX-1): during the first ExitTaxDecayBlocks
	//     of wind-down a still-taxed holder cannot be force-pushed — the backstop
	//     is not yet open and their own clock has not decayed. They keep the full
	//     decay window to exit at their earned rate via self-Refund.
	//   - WHALE DODGE CLOSED (K2): a fresh dominant holder still cannot be pushed
	//     out at 0 tax by an ally inside the window; after the window their tax is
	//     taken at the LIVE clock, so waiting earns tau=0 ONLY by genuinely
	//     holding the full six weeks — never by an ally's early push.
	//   - GRIEFING STAYS UNPROFITABLE: force-taxing an abandoned position after
	//     the full window sends a small tax to the treasury, but the griefer must
	//     GIVE the holder tokens to refresh their clock (OUTFLOW-K-1 refutation:
	//     the transfer enriches the recipient far more than the tax it triggers),
	//     so no rational actor does it, and the market still closes either way.
	// ─────────────────────────────────────────────────────────────────────────
	taxBps := ExitTaxBpsAt(heldBlocksAt(s, creator, holder, block))
	if taxBps != 0 {
		open, ok := windDownOpenBlock(s, creator, block)
		if !ok || block < open || block-open < ExitTaxDecayBlocks {
			return nil, newErr(ErrState, "permissionless refundHolder is only available once the holder's exit tax has fully decayed (held >= ExitTaxDecayBlocks) OR the market has been winding down for a full ExitTaxDecayBlocks; a still-taxed holder must choose their own exit via Refund")
		}
		// else: the market-level backstop is open — the push fires and taxes the
		// holder's LIVE clock below (a possibly-nonzero, griefer-refreshed rate).
	}

	supply := getMoney(s, kSupply(creator))
	if mIsZero(supply) {
		// Same defensive reasoning as Refund: bal > 0 with supply == 0 is an
		// I3 violation, not a reachable state under a correct system.
		return nil, newErr(ErrState, "supply is zero but holder holds a balance")
	}
	reserve := getMoney(s, kReserve(creator))
	gross := refundPayout(reserve, bal, supply)
	// K2 tax, on the pushed holder's OWN hold clock. taxBps is 0 in the common
	// case (a genuinely-aged abandoned position swept by a keeper) but MAY be
	// nonzero when the market-level DoS backstop opened the push past a
	// still-taxed (griefer-refreshed or genuinely-late-OTC) clock — see the gate
	// above. Either way the carve is exact: tax = ceil(gross·τ/1e4) to the
	// treasury (RULING K2), net = gross − tax to the holder, and the reserve is
	// debited the FULL gross so R === area(S) is untouched by the tax.
	tax := ExitTaxOn(gross, taxBps)
	net := new(big.Int).Sub(gross, tax)

	// Chokepoint debit, same as Refund: the pushed-out holder's whole balance
	// leaves (amount == bal). RULING K deleted the cost basis, so nothing but
	// the balance and supply move here.
	if err := debitBalance(s, creator, holder, bal); err != nil {
		return nil, err // unreachable: amount == bal by construction
	}
	if err := subMoney(s, kSupply(creator), bal); err != nil {
		return nil, err // unreachable: supply >= bal by I3
	}
	if err := subMoney(s, kReserve(creator), gross); err != nil {
		return nil, err // unreachable; see Refund's identical comment
	}
	accrueExitTax(s, creator, holder, tax) // the pushed-out HOLDER is the seller here, not the caller
	return net, nil
}

// CloseIfDrained marks a FROZEN market CLOSED once its supply has reached
// zero — SPEC §1.7.5's WIND-DOWN stage completing. CLOSED is terminal: "a
// creator returning later re-registers and starts fresh." Nothing in this
// codebase ever moves a market OUT of CLOSED.
//
// RULING B NOTE — the stranded residual is structurally gone: C-24 proves a
// complete wind-down drains the reserve to exactly 0, and a full Sell during
// ACTIVE leaves R = area(0) = 0 exactly (the money-tax redeems the whole
// slice; the burn that used to strand `R > 0 at S == 0` no longer exists).
// So when this flips CLOSED, R == 0 — asserted in the fuzz harness, never
// swept: a sweep that fires only on an accounting bug would convert the bug
// into revenue and hide it. The deliberate treasury credits in the exit
// mechanism are the two exit-tax legs (Sell, RULING J; wind-down Refund/
// RefundHolder, RULING K2), each carved from the holder's PAYOUT after the
// reserve debit — they move tax, never reserve.
//
// Unlike Refund/RefundHolder above, this function's whole job IS to consult
// billing-adjacent state — it needs to know whether the market is currently
// FROZEN — so it calls Phase() (market.go) rather than re-deriving lapse
// timing locally: API.md rule 1 names Phase as the single lazy source, and a
// second copy of the lapse arithmetic could silently drift from it.
//
// Idempotent: returns true whenever the market ends up CLOSED as a result of
// calling this, whether it was closed just now or already was — a keeper can
// call this against every market on every block without tracking which ones
// it already flipped.
//
// Guarded on kRegisteredAt so a Hive account string that never registered a
// market can never be stamped CLOSED by an incidental call — CLOSED is a
// market lifecycle state, not a default for an arbitrary string whose phase,
// derived from a zero paidUntil, would otherwise eventually compute to
// FROZEN by simple passage of block height.
func CloseIfDrained(s Store, creator string, block uint64) bool {
	if getU64(s, kRegisteredAt(creator)) == 0 {
		return false
	}
	switch Phase(s, creator, block) {
	case StateClosed:
		return true
	case StateFrozen:
		// fall through to the supply check below
	default:
		return false
	}
	if !mIsZero(getMoney(s, kSupply(creator))) {
		return false
	}
	setStr(s, kState(creator), StateClosed)
	return true
}
