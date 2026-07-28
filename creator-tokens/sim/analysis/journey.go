package analysis

import (
	"fmt"
	"math/big"
	"sort"
	"strings"
)

// journey.go — DEAD ENDS.
//
// At every point in the trace, for every actor, this file asks: given the
// value they hold (a credit balance, or an open ask escrow), is there a
// legal action that gets them out? THREE exit routes matter for credits:
// Sell (curve, while the market trades), Refund (flat pro-rata pull, at
// wind-down) and TransferCredits (always). One matters for an open ask:
// Reclaim (asker) or Answer (creator, on the asker's behalf).
//
// # What reading core proves before any trace is even run
//
// core/transfer.go's TransferCredits carries NO phase or pause gate at all
// (API.md rule 3: "outflows never pause"; rule 4: "the billing state must
// never gate funds") — its only guard is balance sufficiency, in every phase
// including FROZEN and CLOSED.
//
// core/refund.go's Refund is DIFFERENT (RULING A/K3, RULINGS-v2-2026-07-21/
// 22 — this file used to claim it had no phase gate either; it does now, and
// that update IS this comment): Refund/RefundHolder are gated to inWindDown
// ONLY (naturally FROZEN/CLOSED, or an irreversible Retire). While the market
// is NOT winding down, the complementary rail is open instead — core/sell.go's
// Sell, the exact curve proceeds — and refund.go/sell.go's own file headers
// prove the two rails partition every (creator, block) with NO gap and NO
// overlap. So the correct static claim is: a positive-balance holder ALWAYS
// has at least one legal exit — Sell OR Refund, whichever the CURRENT phase
// opens — in every phase, by construction. A refund refused specifically
// because the market is not winding down is EXPECTED, not a dead end, exactly
// because Sell is open in that same state; AnalyzeDeadEnds below only
// escalates a failed refund into an anomaly when the market WAS in wind-down
// (i.e. when core's own rule says it should have worked). This file both
// states the (corrected) claim and checks it dynamically against the actual
// trace (see AnomalyScan below) — a negative result here is itself a real
// finding worth reporting, not a non-event.
//
// FIXED 2026-07-28 (F4, an adversarial review — this note used to describe
// the gap this fix closes; kept, corrected, so the history stays legible).
// "Retire is never driven by this simulator's actor set" stopped being true
// the session sim/actions.go's creatorTick started calling doRetire
// (RetireOnAbandon / VoluntaryRetireBlock — engine.go's NewEngine).
// derivePhase (report.go), the small local phase replay this file and
// coverage.go both use for their OWN phase bucketing, used to be a pure
// function of (closed, paidUntil, block, graceBlocks) with no retiredAt
// input at all, so around a Retire event it UNDER-stated how frozen a
// market really was (core's real Phase() is MAX(naturalPhase, retiredPhase)
// — market.go — while derivePhase computed only the natural half) for up to
// SubscriptionPeriod+GraceBlocks (~35 days), until the natural
// paidUntil+GraceBlocks lapse independently caught up to the same FROZEN
// state Retire forces sooner. That blinded MarketDeadEnds below (one of
// four arms of Report.Critical()), which fires only on
// derivePhase(...)==PhaseFrozen — a market frozen BY RETIRE and pinned by a
// stranded PENDING escrow went unflagged by a build-failing gate.
//
// derivePhase now takes a `retiredAt uint64, retired bool` pair, and this
// file (and coverage.go) now track it via a `case "retire":` entry in the
// same OK-events switch that already tracks `closed`/`paidUntil`, reset on
// "register" exactly like `closed` is (core's registerApply clears
// kRetiredAt on re-registration — market.go). Every derivePhase call site
// below now passes `retiredAt[c], retired[c]`.
//
// ONE NARROWER GAP REMAINS, worth naming rather than silently inheriting:
// core's actual exit-rail switch is `inWindDown` (refund.go), not `Phase`
// — inWindDown is true from the INSTANT a market retires (even during the
// 5-day OVERDUE notice, RULING K3), while Phase() itself only reaches
// FROZEN once the notice expires. The "refund-blocked" anomaly check below
// still approximates "winding down" as `ph == FROZEN || ph == CLOSED`, so a
// refund correctly refused during just the retire NOTICE window (OVERDUE,
// but already inWindDown per core) can still misclassify for the length of
// that window — the same shape of gap as before, just narrower (35 days ->
// 5 days) and confined to that one anomaly check, not to MarketDeadEnds
// (which this fix does close, since it keys off FROZEN, which retire+grace
// now correctly reaches). Reimplementing inWindDown's OVERDUE-during-notice
// branch here would need the same retiredAt input this fix just added, so a
// follow-up closing it fully is a small, well-scoped next step, not a
// re-plumbing.
//
// # The one real dead end this design has: the ReclaimGrace gap
//
// core/ask.go's Answer is legal only for block <= deadline; Reclaim is legal
// only for block > deadline+ReclaimGrace (I6, ordering-immunity). Those two
// windows are disjoint BY DESIGN — which means for every ask that is not
// answered by its deadline, there is a real, structural window of exactly
// ReclaimGrace blocks (~1 hour) where NEITHER the creator nor the asker has
// any legal action on that specific escrow. Nobody's money is lost — it
// resolves automatically once the window passes — but for that hour the
// asker is, factually, holding value with zero legal actions available on
// it. This is reported as a TRANSIENT, BY-DESIGN dead end: real, worth
// naming per the brief ("a product failure even when the contract is
// behaving exactly as specified"), but not something that should fail a
// build, since it always resolves and the UI-BRIEF's countdown pattern
// (Page 3: "Reclaimable (amber, prominent 'Get your credits back')") is
// already the intended mitigation — the gap is a UX-communication problem,
// not a funds problem.
//
// # Why this file does not reimplement the TWAP
//
// Ask's credits-per-ask conversion (ceilDiv(face, rate)) depends on rate,
// which depends on the full history of RecordObs price observations and
// core/twap.go's median/weighted-average/deviation-cap machinery. This file
// deliberately does not reimplement that: it is oracle logic, not money
// bookkeeping, and an independent shadow reimplementation of an ORACLE is
// exactly the kind of thing that quietly drifts from the real one and then
// lies with confidence. Credit AMOUNTS in this file are therefore
// best-effort, sourced from Deltas when present, and explicitly marked
// approximate/unavailable when not — see resolveCreditsSpent. This never
// affects whether a dead end is detected (the ReclaimGrace gap is a pure
// function of block/deadline/ReclaimGrace, none of which touch the rate),
// only how precisely the report can describe what was being held.
type ReclaimGapWindow struct {
	Creator       string
	Seq           uint64
	Asker         string
	CommissionHbd *big.Int
	Credits       *big.Int // nil if not resolved from the trace
	CreditsApprox bool

	Deadline uint64
	GapStart uint64 // deadline+1: the first block where neither answer nor reclaim is legal
	GapEnd   uint64 // deadline+ReclaimGrace: reclaim becomes legal the block after this

	// Resolution: "reclaimed" (the asker reclaimed once the window passed) or
	// "unresolved-at-trace-end" (the trace ended while still inside the gap
	// or before reclaim was exercised).
	Resolution string
}

// UnclaimedEscrow is NOT a dead end — Reclaim WAS legally available — but is
// worth surfacing separately: an ask sat reclaim-eligible for the rest of
// the observed trace and nobody exercised it. Low reclaim awareness is a UX
// signal, not a stuck-funds finding.
type UnclaimedEscrow struct {
	Creator           string
	Seq               uint64
	Asker             string
	CommissionHbd     *big.Int
	ReclaimEligibleAt uint64 // deadline+ReclaimGrace+1
	TraceEndBlock     uint64
}

// InvariantAnomaly is a live, in-trace observation that contradicts what
// reading core says should be true — e.g. a refund failing while the caller
// held enough balance to cover it. Every one of these is worth investigating
// as a real bug in whatever produced the trace (core itself, or the sim
// engine's own call wrappers), not explained away.
type InvariantAnomaly struct {
	Kind       string // "refund-blocked", "transfer-blocked", "reclaim-blocked-past-window", "answer-blocked-before-deadline"
	EventIndex int
	Block      uint64
	Actor      string
	Creator    string
	Detail     string
}

// PersistentDeadEnd is the escalation of an InvariantAnomaly into "this
// actor's value had zero legal routes and nothing in the trace shows
// otherwise" — see the doc above AnalyzeDeadEnds for exactly what evidence
// promotes an anomaly into this bucket. Presence of even one of these should
// fail a build (Report.Critical()); the ReclaimGrace gap alone must not.
type PersistentDeadEnd struct {
	Actor           string
	Creator         string
	Block           uint64
	Holding         string
	AttemptedAction string
	Reason          string
	EventIndex      int
}

// MarketDeadEnd is the H1 finding at the MARKET level (Upgrade 2), the class
// journey.go was previously blind to — it only tracked per-ACTOR credit dead
// ends. A market that, at trace end, is FROZEN with a still-PENDING escrow
// whose reclaim window has already opened is BRICKED: Ask debited kBal but
// not kSupply, so the escrow pins supply > 0; CloseIfDrained needs supply==0
// to flip the market CLOSED; and Register's duplicate-registration guard
// refuses a market that is not CLOSED — so the identity-bound market can
// never close and the creator can never re-register.
//
// Pre-fix (Reclaim was asker-only) an abandoned escrow made this PERMANENT
// for everyone — not the creator, not a keeper, not any third party could
// ever unstick it. Post-fix (permissionless Reclaim, H1) any third party can
// push the reclaim once the window opens, drain supply, and let the market
// close — so this set MUST be empty in a post-fix run, and Report.Critical()
// treats a non-empty set as a build failure.
type MarketDeadEnd struct {
	Creator       string
	Phase         string // the market's derived phase at trace end (FROZEN)
	Seq           uint64
	Asker         string
	Deadline      uint64
	ReclaimOpenAt uint64 // deadline+ReclaimGrace+1: reclaim has been legal since here
	TraceEndBlock uint64
	Reason        string
}

// DeadEndReport is the full result of AnalyzeDeadEnds.
type DeadEndReport struct {
	ReclaimGapWindows []ReclaimGapWindow
	OngoingAtTraceEnd []ReclaimGapWindow // subset of ReclaimGapWindows still inside the gap at the trace's last observed block
	UnclaimedEligible []UnclaimedEscrow
	Anomalies         []InvariantAnomaly
	Persistent        []PersistentDeadEnd

	// Market-level dead ends (Upgrade 2 / H1). MarketDeadEnds must be empty
	// post-fix; the two counters below PROVE the permissionless-reclaim
	// resolution path actually ran, rather than the set merely happening to be
	// empty because no market ever got near the stuck state.
	MarketDeadEnds                          []MarketDeadEnd
	PermissionlessReclaims                  int // reclaim events driven by a THIRD PARTY (caller != escrow's asker) — the H1 fix mechanism, exercised
	MarketsClosedAfterPermissionlessReclaim int // creators that had >=1 permissionless reclaim AND are CLOSED at trace end — end-to-end H1 resolution proven

	// Proven-safe counters — what was actually checked, not implied coverage.
	RefundTransferAttempts int // total OK+failed refund/transfer events scanned for the anomaly check
	FinalPositiveBalances  int // distinct (creator,holder) pairs holding credits > 0 at trace end
	ClosedMarkets          int // creators this replay independently derives as CLOSED (supply==0 while FROZEN)
	ClosedMarketResiduals  int // of those, how many still show a positive balance or open escrow — should be 0

	Notes []string
}

func (r DeadEndReport) render(b *strings.Builder) {
	fmt.Fprintf(b, "--- 2. DEAD ENDS ---\n")

	fmt.Fprintf(b, "STATIC (from reading core/refund.go, core/sell.go, core/transfer.go): TransferCredits\n")
	fmt.Fprintf(b, "carries no phase/pause gate; Refund/RefundHolder open only at wind-down and Sell is\n")
	fmt.Fprintf(b, "the complementary open rail everywhere else (the two partition every phase with no\n")
	fmt.Fprintf(b, "gap) — so a positive-balance credit holder always has >=1 legal exit, by construction.\n")
	fmt.Fprintf(b, "DYNAMIC: %d refund/transfer attempts scanned, %d final positive credit balances,\n",
		r.RefundTransferAttempts, r.FinalPositiveBalances)
	fmt.Fprintf(b, "         %d credit-holder dead end(s) found (see PERSISTENT below).\n", len(r.Persistent))
	fmt.Fprintf(b, "CLOSED markets: %d derived, %d with a residual balance or open escrow (should be 0).\n",
		r.ClosedMarkets, r.ClosedMarketResiduals)

	fmt.Fprintf(b, "\nTRANSIENT, BY-DESIGN dead end (the ReclaimGrace gap — see file doc): %d ask(s) spent\n", len(r.ReclaimGapWindows))
	fmt.Fprintf(b, "time where neither answer nor reclaim was legal for anyone.\n")
	if len(r.ReclaimGapWindows) > 0 {
		shown := 0
		for _, w := range r.ReclaimGapWindows {
			if shown >= 10 {
				fmt.Fprintf(b, "  ... and %d more\n", len(r.ReclaimGapWindows)-shown)
				break
			}
			credits := "unknown (approx.)"
			if w.Credits != nil {
				credits = w.Credits.String()
				if w.CreditsApprox {
					credits += " (approx.)"
				}
			}
			fmt.Fprintf(b, "  %s seq=%d asker=%-12s commission=%s credits=%s gap=[%d,%d] resolution=%s\n",
				w.Creator, w.Seq, w.Asker, w.CommissionHbd, credits, w.GapStart, w.GapEnd, w.Resolution)
			shown++
		}
	}
	if len(r.OngoingAtTraceEnd) > 0 {
		fmt.Fprintf(b, "  %d of the above are STILL inside the gap at the trace's last observed block.\n", len(r.OngoingAtTraceEnd))
	}

	fmt.Fprintf(b, "\nUnclaimed-but-eligible (Reclaim was legal, nobody called it by trace end): %d\n", len(r.UnclaimedEligible))
	shown := 0
	for _, u := range r.UnclaimedEligible {
		if shown >= 5 {
			fmt.Fprintf(b, "  ... and %d more\n", len(r.UnclaimedEligible)-shown)
			break
		}
		fmt.Fprintf(b, "  %s seq=%d asker=%-12s eligible since block %d, trace ends at %d\n",
			u.Creator, u.Seq, u.Asker, u.ReclaimEligibleAt, u.TraceEndBlock)
		shown++
	}

	if len(r.Anomalies) == 0 {
		fmt.Fprintf(b, "\nNo invariant anomalies observed.\n")
	} else {
		fmt.Fprintf(b, "\n%d invariant anomalies observed (a value-holder's expected route failed):\n", len(r.Anomalies))
		for _, a := range r.Anomalies {
			fmt.Fprintf(b, "  [%s] event %d block %d actor=%s creator=%s: %s\n", a.Kind, a.EventIndex, a.Block, a.Actor, a.Creator, a.Detail)
		}
	}

	if len(r.Persistent) == 0 {
		fmt.Fprintf(b, "\nNo PERSISTENT dead ends found.\n")
	} else {
		fmt.Fprintf(b, "\n%d PERSISTENT dead end(s) — value held, zero legal route observed:\n", len(r.Persistent))
		for _, p := range r.Persistent {
			fmt.Fprintf(b, "  actor=%-12s creator=%-12s block=%d holding=%s tried=%s reason=%s (event %d)\n",
				p.Actor, p.Creator, p.Block, p.Holding, p.AttemptedAction, p.Reason, p.EventIndex)
		}
	}

	// Market-level dead ends (Upgrade 2 / H1).
	fmt.Fprintf(b, "\nMARKET dead ends (H1 — FROZEN market bricked by an unresolved escrow): %d.\n", len(r.MarketDeadEnds))
	fmt.Fprintf(b, "Permissionless (third-party) reclaims driven this run: %d; markets closed AFTER a permissionless reclaim: %d.\n",
		r.PermissionlessReclaims, r.MarketsClosedAfterPermissionlessReclaim)
	if len(r.MarketDeadEnds) == 0 {
		fmt.Fprintf(b, "  Every FROZEN market can reach CLOSED — no market is pinned by an unresolved PENDING escrow at trace end.\n")
	} else {
		fmt.Fprintf(b, "  *** %d FROZEN market(s) STILL bricked by an unresolved escrow at trace end (H1 not resolved): ***\n", len(r.MarketDeadEnds))
		for _, m := range r.MarketDeadEnds {
			fmt.Fprintf(b, "  creator=%-16s phase=%s seq=%d asker=%-12s reclaim-open-since=%d traceEnd=%d\n    -> %s\n",
				m.Creator, m.Phase, m.Seq, m.Asker, m.ReclaimOpenAt, m.TraceEndBlock, m.Reason)
		}
	}

	if len(r.Notes) > 0 {
		fmt.Fprintf(b, "\nData-quality notes (%d):\n", len(r.Notes))
		for _, n := range r.Notes {
			fmt.Fprintf(b, "  - %s\n", n)
		}
	}
}

type journeyEscrow struct {
	asker         string
	commissionHbd *big.Int
	credits       *big.Int
	creditsApprox bool
	deadline      uint64
	status        string // "PENDING" | "ANSWERED" | "RECLAIMED" | "DECLINED"
}

// resolveCreditsSpent lives in report.go — shared with ledger.go, which needs
// the identical best-effort conversion to keep its own shadow balances
// consistent across ask/answer/reclaim.

// AnalyzeDeadEnds scans tr for stuck-value states. See the file doc for the
// two things this deliberately does and does not claim.
func AnalyzeDeadEnds(tr *Trace) DeadEndReport {
	rpt := DeadEndReport{}
	if tr == nil || len(tr.Events) == 0 {
		return rpt
	}

	reclaimGrace := reclaimGraceFor(tr)
	subPeriod := subscriptionPeriodFor(tr)
	grace := graceBlocksFor(tr)

	bal := map[string]map[string]*big.Int{} // creator -> holder -> balance
	supply := map[string]*big.Int{}
	paidUntil := map[string]uint64{}
	closed := map[string]bool{}
	retiredAt := map[string]uint64{} // F4: block Retire was called at, per creator
	retired := map[string]bool{}     // F4: whether Retire has ever fired for this creator (reset on "register")
	nextSeq := map[string]uint64{}
	escrows := map[string]map[uint64]*journeyEscrow{}
	permissionlessByCreator := map[string]bool{} // creator -> saw >=1 third-party (permissionless) reclaim

	getBal := func(c, h string) *big.Int {
		m, ok := bal[c]
		if !ok {
			return zeroBig()
		}
		v, ok := m[h]
		if !ok {
			return zeroBig()
		}
		return v
	}
	setBal := func(c, h string, v *big.Int) {
		if bal[c] == nil {
			bal[c] = map[string]*big.Int{}
		}
		bal[c][h] = v
	}
	addBal := func(c, h string, delta *big.Int) { setBal(c, h, new(big.Int).Add(getBal(c, h), delta)) }
	getSupply := func(c string) *big.Int {
		v, ok := supply[c]
		if !ok {
			return zeroBig()
		}
		return v
	}

	traceEndBlock := uint64(0)
	for _, ev := range tr.Events {
		if ev.Block > traceEndBlock {
			traceEndBlock = ev.Block
		}
	}

	for i, ev := range tr.Events {
		c := ev.Creator
		if ev.Action == "refund" || ev.Action == "transfer" {
			rpt.RefundTransferAttempts++
		}

		if !ev.OK {
			// Anomaly scan on FAILED events: did a value-holder's expected
			// route refuse them despite reading core's guards as satisfied?
			switch ev.Action {
			case "refund":
				credits, ok := argBig(ev, "credits")
				if ok && getBal(c, ev.Actor).Cmp(credits) >= 0 && getBal(c, ev.Actor).Sign() > 0 {
					// RULING A/K3's two-rail switch (core/refund.go, core/
					// sell.go): Refund opens ONLY at wind-down (FROZEN/CLOSED
					// here — see the file doc's "ONE NARROWER GAP REMAINS"
					// note: this check still approximates wind-down as
					// FROZEN/CLOSED, not core's own inWindDown, so a retire
					// NOTICE window is not yet covered here). While
					// the market is still trading, refusing Refund with
					// EXACTLY that rail-switch reason is BY DESIGN — Sell is
					// the open rail in that same state, proven gap-free
					// against Refund by the two files' own headers. So this
					// is expected, NOT an anomaly, ONLY when both hold: the
					// market is NOT winding down, AND the refusal is that
					// specific rail-switch guard (core/refund.go's exact
					// message). Any other reason for refusing a
					// sufficient-balance refund — including this same
					// "insufficient credits"-flavoured message a stale
					// balance-tracking bug could produce, wind-down or not —
					// is still a genuine anomaly.
					ph := derivePhase(closed[c], paidUntil[c], ev.Block, grace, retiredAt[c], retired[c])
					windingDown := ph == PhaseFrozen || ph == PhaseClosed
					isExpectedRailSwitch := !windingDown && ev.ErrSym == ErrStateSym && strings.Contains(ev.ErrMsg, "opens only at wind-down")
					if !isExpectedRailSwitch {
						rpt.Anomalies = append(rpt.Anomalies, InvariantAnomaly{
							Kind: "refund-blocked", EventIndex: i, Block: ev.Block, Actor: ev.Actor, Creator: c,
							Detail: fmt.Sprintf("requested %s credits, held >= that many (phase=%s), still refused: %s: %s", credits, ph, ev.ErrSym, ev.ErrMsg),
						})
						rpt.Persistent = append(rpt.Persistent, PersistentDeadEnd{
							Actor: ev.Actor, Creator: c, Block: ev.Block,
							Holding: fmt.Sprintf("%s credits", credits), AttemptedAction: "refund",
							Reason: ev.ErrSym + ": " + ev.ErrMsg, EventIndex: i,
						})
					}
					// else: NOT winding down, and refused for exactly the
					// rail-switch reason — Sell (the curve rail) is the
					// actor's open exit here, so this refusal is expected,
					// not a dead end.
				}
			case "transfer":
				amount, ok := argBig(ev, "amount")
				to, okTo := argStr(ev, "to")
				if ok && okTo && to != ev.Actor && getBal(c, ev.Actor).Cmp(amount) >= 0 && getBal(c, ev.Actor).Sign() > 0 {
					rpt.Anomalies = append(rpt.Anomalies, InvariantAnomaly{
						Kind: "transfer-blocked", EventIndex: i, Block: ev.Block, Actor: ev.Actor, Creator: c,
						Detail: fmt.Sprintf("requested transfer of %s credits to %s, held >= that many, still refused: %s: %s", amount, to, ev.ErrSym, ev.ErrMsg),
					})
					rpt.Persistent = append(rpt.Persistent, PersistentDeadEnd{
						Actor: ev.Actor, Creator: c, Block: ev.Block,
						Holding: fmt.Sprintf("%s credits", amount), AttemptedAction: "transfer",
						Reason: ev.ErrSym + ": " + ev.ErrMsg, EventIndex: i,
					})
				}
			case "reclaim":
				if seq, ok := argU64(ev, "seq"); ok {
					if esc := journeyLookup(escrows, c, seq); esc != nil && esc.status == "PENDING" {
						if ev.Block > esc.deadline+reclaimGrace {
							rpt.Anomalies = append(rpt.Anomalies, InvariantAnomaly{
								Kind: "reclaim-blocked-past-window", EventIndex: i, Block: ev.Block, Actor: ev.Actor, Creator: c,
								Detail: fmt.Sprintf("block %d is past deadline(%d)+ReclaimGrace(%d), still refused: %s: %s", ev.Block, esc.deadline, reclaimGrace, ev.ErrSym, ev.ErrMsg),
							})
							rpt.Persistent = append(rpt.Persistent, PersistentDeadEnd{
								Actor: ev.Actor, Creator: c, Block: ev.Block,
								Holding: fmt.Sprintf("escrow seq %d (%s commission)", seq, esc.commissionHbd), AttemptedAction: "reclaim",
								Reason: ev.ErrSym + ": " + ev.ErrMsg, EventIndex: i,
							})
						}
					}
				}
			case "answer":
				if seq, ok := argU64(ev, "seq"); ok {
					if esc := journeyLookup(escrows, c, seq); esc != nil && esc.status == "PENDING" {
						if ev.Block <= esc.deadline {
							rpt.Anomalies = append(rpt.Anomalies, InvariantAnomaly{
								Kind: "answer-blocked-before-deadline", EventIndex: i, Block: ev.Block, Actor: ev.Actor, Creator: c,
								Detail: fmt.Sprintf("block %d is at/before deadline(%d), creator's answer still refused: %s: %s", ev.Block, esc.deadline, ev.ErrSym, ev.ErrMsg),
							})
						}
					}
				}
			}
			continue
		}

		switch ev.Action {
		case "register":
			paidUntil[c] = ev.Block + subPeriod
			nextSeq[c] = 0
			closed[c] = false  // a re-registration (legal CLOSED->ACTIVE) clears the closed latch
			retired[c] = false // F4: registerApply clears kRetiredAt on re-registration (market.go) — same reset shape as closed above
		case "retire":
			// F4: core.Retire stamps kRetiredAt with the current block
			// (market.go — internally block+1, "0 means never retired," but
			// that encoding is core's own storage detail; this replay only
			// needs the raw block Retire fired at, exactly what
			// core.RetiredAt's exported (block, bool) pair returns).
			retiredAt[c] = ev.Block
			retired[c] = true
		case "renew":
			periods, ok := argU64(ev, "periods")
			if ok {
				base := paidUntil[c]
				if ev.Block > base {
					base = ev.Block
				}
				paidUntil[c] = base + periods*subPeriod
			}
		case "prepay":
			if hbdPaid, ok := argBig(ev, "hbdPaid"); ok {
				supply[c] = new(big.Int).Add(getSupply(c), hbdPaid)
				addBal(c, ev.Actor, hbdPaid)
			}
		case "transfer":
			to, okTo := argStr(ev, "to")
			amount, okAmt := argBig(ev, "amount")
			if okTo && okAmt {
				addBal(c, ev.Actor, new(big.Int).Neg(amount))
				addBal(c, to, amount)
			}
		case "ask":
			deadlineBlocks, okD := argU64(ev, "deadlineBlocks")
			commissionPaid, okC := argBig(ev, "commissionHbdPaid")
			if !okD || !okC {
				rpt.Notes = append(rpt.Notes, fmt.Sprintf("event %d (ask by %s): missing Args.deadlineBlocks/commissionHbdPaid, escrow not tracked", i, ev.Actor))
				continue
			}
			seq := nextSeq[c]
			nextSeq[c] = seq + 1
			credits, okCred := resolveCreditsSpent(ev)
			if escrows[c] == nil {
				escrows[c] = map[uint64]*journeyEscrow{}
			}
			escrows[c][seq] = &journeyEscrow{
				asker: ev.Actor, commissionHbd: commissionPaid,
				credits: credits, creditsApprox: !okCred,
				deadline: ev.Block + deadlineBlocks, status: "PENDING",
			}
			if okCred {
				addBal(c, ev.Actor, new(big.Int).Neg(credits))
			}
		case "answer":
			seq, ok := argU64(ev, "seq")
			if !ok {
				continue
			}
			esc := journeyLookup(escrows, c, seq)
			if esc == nil {
				continue
			}
			esc.status = "ANSWERED"
			if esc.credits != nil {
				addBal(c, c, esc.credits) // credits release to the creator's own balance
			}
		case "decline":
			// RULING E (ask.go's Decline, wired into the engine 2026-07-28):
			// a full round-trip refund — credits AND commission both go back
			// to the asker — inside the SAME window an Answer would be legal
			// in, so unlike "reclaim" below this never enters the
			// ReclaimGrace gap and is not a ReclaimGapWindow entry. Without
			// this case the escrow would stay "PENDING" in this file's OWN
			// replay forever (core resolved it, this replay wouldn't know),
			// which would both under-count the asker's balance from here on
			// AND risk the trace-end PENDING scan below misclassifying an
			// honestly-declined escrow as an H1 MarketDeadEnd/UnclaimedEscrow
			// finding that never actually happened.
			seq, ok := argU64(ev, "seq")
			if !ok {
				continue
			}
			esc := journeyLookup(escrows, c, seq)
			if esc == nil {
				continue
			}
			esc.status = "DECLINED"
			if esc.credits != nil {
				addBal(c, esc.asker, esc.credits)
			}

		case "reclaim":
			seq, ok := argU64(ev, "seq")
			if !ok {
				continue
			}
			esc := journeyLookup(escrows, c, seq)
			if esc == nil {
				continue
			}
			esc.status = "RECLAIMED"
			// H1 (Upgrade 2): core.Reclaim always pays the escrow's own asker,
			// never the caller. A reclaim whose event actor is NOT the asker is
			// therefore a permissionless, third-party push — the exact new
			// mechanism the H1 fix added, resolving an escrow the asker
			// abandoned. Counting these proves the resolution path actually ran.
			if ev.Actor != esc.asker {
				rpt.PermissionlessReclaims++
				permissionlessByCreator[c] = true
			}
			gap := ReclaimGapWindow{
				Creator: c, Seq: seq, Asker: esc.asker, CommissionHbd: esc.commissionHbd,
				Credits: esc.credits, CreditsApprox: esc.creditsApprox,
				Deadline: esc.deadline, GapStart: esc.deadline + 1, GapEnd: esc.deadline + reclaimGrace,
				Resolution: "reclaimed",
			}
			rpt.ReclaimGapWindows = append(rpt.ReclaimGapWindows, gap)
			if esc.credits != nil {
				addBal(c, esc.asker, esc.credits)
			}
		case "refund":
			if credits, ok := argBig(ev, "credits"); ok {
				addBal(c, ev.Actor, new(big.Int).Neg(credits))
				supply[c] = new(big.Int).Sub(getSupply(c), credits)
			}
		case "refundHolder":
			if holder, ok := argStr(ev, "holder"); ok {
				h := getBal(c, holder)
				if h.Sign() > 0 {
					setBal(c, holder, zeroBig())
					supply[c] = new(big.Int).Sub(getSupply(c), h)
				}
			}
		case "closeIfDrained":
			ph := derivePhase(false, paidUntil[c], ev.Block, grace, retiredAt[c], retired[c])
			if getSupply(c).Sign() == 0 && ph == PhaseFrozen {
				closed[c] = true
			}
		}
	}

	// Escrows still PENDING at trace end.
	for c, m := range escrows {
		for seq, esc := range m {
			if esc.status != "PENDING" {
				continue
			}
			reclaimAt := esc.deadline + reclaimGrace
			switch {
			case traceEndBlock <= esc.deadline:
				// still within the answer window — in progress, not a dead end.
			case traceEndBlock <= reclaimAt:
				gap := ReclaimGapWindow{
					Creator: c, Seq: seq, Asker: esc.asker, CommissionHbd: esc.commissionHbd,
					Credits: esc.credits, CreditsApprox: esc.creditsApprox,
					Deadline: esc.deadline, GapStart: esc.deadline + 1, GapEnd: reclaimAt,
					Resolution: "unresolved-at-trace-end",
				}
				rpt.ReclaimGapWindows = append(rpt.ReclaimGapWindows, gap)
				rpt.OngoingAtTraceEnd = append(rpt.OngoingAtTraceEnd, gap)
			default:
				// Window fully open (traceEndBlock > deadline+ReclaimGrace),
				// escrow still PENDING, nobody resolved it. Per ACTOR this is
				// only a UX/awareness signal — Reclaim was legally available.
				rpt.UnclaimedEligible = append(rpt.UnclaimedEligible, UnclaimedEscrow{
					Creator: c, Seq: seq, Asker: esc.asker, CommissionHbd: esc.commissionHbd,
					ReclaimEligibleAt: reclaimAt + 1, TraceEndBlock: traceEndBlock,
				})
				// Per MARKET, though, if that market is FROZEN this same escrow
				// pins supply > 0 and bricks the market forever (H1). Post-fix
				// the permissionless reclaim should have cleared it before the
				// trace ended, so a non-empty MarketDeadEnds set is a real
				// failure of the fix (or of whoever should have pushed it).
				finalPhase := derivePhase(closed[c], paidUntil[c], traceEndBlock, grace, retiredAt[c], retired[c])
				if finalPhase == PhaseFrozen {
					rpt.MarketDeadEnds = append(rpt.MarketDeadEnds, MarketDeadEnd{
						Creator: c, Phase: finalPhase, Seq: seq, Asker: esc.asker,
						Deadline: esc.deadline, ReclaimOpenAt: reclaimAt + 1, TraceEndBlock: traceEndBlock,
						Reason: "FROZEN market pinned by an unresolved PENDING escrow past its reclaim window: supply > 0, CloseIfDrained blocked, creator cannot re-register (H1). Resolvable post-fix by ANY third party via permissionless Reclaim — nobody did before trace end.",
					})
				}
			}
		}
	}

	// End-to-end H1 resolution: a creator that had a permissionless reclaim AND
	// is CLOSED at trace end is one whose stuck escrow was cleared by a third
	// party and then wound all the way down — the post-fix path working fully.
	for c := range permissionlessByCreator {
		if closed[c] {
			rpt.MarketsClosedAfterPermissionlessReclaim++
		}
	}

	// Stable output: the trace-end escrow scan above appends in Go's
	// randomized map-iteration order, so sort the market dead ends by
	// (creator, seq) to keep the rendered report reproducible run to run.
	sort.Slice(rpt.MarketDeadEnds, func(i, j int) bool {
		if rpt.MarketDeadEnds[i].Creator != rpt.MarketDeadEnds[j].Creator {
			return rpt.MarketDeadEnds[i].Creator < rpt.MarketDeadEnds[j].Creator
		}
		return rpt.MarketDeadEnds[i].Seq < rpt.MarketDeadEnds[j].Seq
	})

	// Final positive-balance count + CLOSED-market residual check.
	for c, holders := range bal {
		anyResidual := false
		for _, amount := range holders {
			if amount.Sign() > 0 {
				rpt.FinalPositiveBalances++
				anyResidual = true
			}
		}
		if closed[c] {
			rpt.ClosedMarkets++
			openEscrow := false
			for _, esc := range escrows[c] {
				if esc.status == "PENDING" {
					openEscrow = true
				}
			}
			if anyResidual || openEscrow {
				rpt.ClosedMarketResiduals++
			}
		}
	}

	return rpt
}

func journeyLookup(escrows map[string]map[uint64]*journeyEscrow, creator string, seq uint64) *journeyEscrow {
	m, ok := escrows[creator]
	if !ok {
		return nil
	}
	return m[seq]
}
