// ledger.go — WHERE THE MONEY WENT.
//
// Full HBD reconciliation for a run: what entered the system, what left it,
// and what sits where at the end. This is an INDEPENDENT reimplementation of
// core's own documented money formulas (see report.go's package doc for why
// it does not lean on the engine's own Deltas for this), replayed purely
// from each event's Args plus its OK flag.
//
// THE IDENTITY:
//
//	Entered == Left + Sits
//
//	Entered = Σ register.feePaid + Σ renew.paid + Σ prepay.hbdPaid + Σ buy.totalDue
//	          + Σ ask.commissionHbdPaid
//	Left    = Σ refund.net + Σ refundHolder.net + Σ sell.net + Σ reclaim.commissionHbd
//	          + Σ decline.commissionHbd + Σ claimTradeFees.claimed + Σ withdrawTreasury.amount
//	Sits    = final treasury + Σ final per-creator reserve + Σ final per-creator
//	          feePots (kFeeBal) + Σ commission currently HELD in a still-PENDING escrow
//
// Money enters the system at exactly the calls that bring HBD in from outside
// the contract (register/renew/prepay/buy — "prepay" is dead, RULING A, kept
// only for older synthetic fixtures). Ask's commission leg enters at ASK time
// (it leaves the asker's wallet the moment they sign, per core/ask.go: "the
// asker's signed transfer.allow intent is what actually moves this HBD"), not
// at Answer time — Answer only moves that same HBD between two INTERNAL
// accounts (the escrow hold -> the treasury), so counting it again there
// would double-count it. Money leaves the system at the two wind-down payout
// calls, a curve Sell's net proceeds, a reclaim's or a decline's full
// commission return (RULING E — Decline is money-shape-identical to Reclaim,
// tracked in its own MoneyOut bucket so the two are never conflated in the
// report), a creator's own pull of ClaimTradeFees, and the owner's
// WithdrawTreasury pull. Everything else (Answer's booking, TransferCredits,
// SetFace/SetCap, RecordObs, CloseIfDrained, Retire, and the four
// creator-shop config writers) either moves credits only, moves HBD between
// two INTERNAL accounts, or moves no money at all — neither changes Entered
// nor Left.
//
// The identity is checked after EVERY event, not just at the end, so a
// divergence is reported at its first occurrence (FirstBadEvent), not merely
// detected in aggregate once it's too late to say which call caused it.
package analysis

import (
	"fmt"
	"math/big"
	"sort"
	"strings"
)

// escrowHold is this file's own minimal escrow record — just enough to run
// the HBD reconciliation (who opened it, how much commission it holds, whose
// bucket a resolution credits). journey.go tracks the fuller record
// (deadline, lifecycle windows) independently; the two are kept separate
// deliberately (see report.go's package doc on why each analysis file runs
// its own small replay rather than sharing one generic one). credits is
// tracked here too (best-effort, via resolveCreditsSpent) purely so this
// file's own shadow balance map stays consistent across ask/answer/reclaim —
// without it, an asker's spendable balance would never reflect that some of
// it is locked in escrow, corrupting the per-actor CreditsHeldValue figure.
type escrowHold struct {
	asker         string
	commissionHbd *big.Int
	credits       *big.Int // nil if not resolved from Deltas — see resolveCreditsSpent
	creditsApprox bool
}

// MoneyIn / MoneyOut / Holdings — the three legs of the identity, broken out
// by the source line so the report reads as an itemised statement, not just
// a single closing number.
type MoneyIn struct {
	Registration   *big.Int
	Subscription   *big.Int
	Prepay         *big.Int // dead since RULING A deleted the PAR mint (core/transfer.go's file doc) — kept at 0 so a synthetic pre-RULING-A trace still replays; see Buy below for the live issuance path
	Buy            *big.Int // RULING A: cost + trade fee drawn from a buyer's wallet on core.Buy — the ONLY live issuance path now
	CommissionHeld *big.Int // paid in at ask time, whether or not later earned back or returned
	Total          *big.Int
}

type MoneyOut struct {
	Refunds             *big.Int
	ReclaimedCommission *big.Int
	// DeclinedCommission (RULING E, wired 2026-07-28): a creator's Decline is
	// money-shape-identical to Reclaim — the FULL held commission (and
	// credits) returns to the asker — but is tracked in its own bucket,
	// mirroring core's own escrowDeclined/askDeclined status being kept
	// distinct from RECLAIMED (ask.go: "so the shadow ledger can tell 'the
	// creator declined' from 'the asker was never answered' apart").
	DeclinedCommission *big.Int
	Sold               *big.Int // RULING K: net curve proceeds (gross - exit tax - trade fee) paid OUT to a seller via core.Sell
	// TradeFeesClaimed (RULING F8, wired 2026-07-28): a creator's pull of
	// their own accrued kFeeBal via core.ClaimTradeFees — money leaving the
	// Sits.FeePotsTotal bucket, mirroring TreasuryWithdrawn's identical role
	// for kTreasury (the platform's own pull-claimable pot).
	TradeFeesClaimed  *big.Int
	TreasuryWithdrawn *big.Int // Upgrade 1 (C2): protocol revenue paid OUT to the owner via WithdrawTreasury
	Total             *big.Int
}

type Holdings struct {
	Treasury            *big.Int
	ReservesByCreator   map[string]*big.Int
	ReserveTotal        *big.Int
	EscrowHeldByCreator map[string]*big.Int // commission still HELD on a PENDING escrow, by creator
	EscrowHeldTotal     *big.Int
	// FeePotsByCreator / FeePotsTotal (RULING F8): the creator halves of every
	// trade fee (Buy/Sell) and every K2 exit tax (Sell/Refund/RefundHolder),
	// pull-claimable via ClaimTradeFees (core/tradefee.go), keyed by creator —
	// neither reserve nor treasury, its own resting bucket in the identity
	// exactly like the live engine's own conservation check had to learn
	// (sim/engine.go's checkInvariants, "FIXED 2026-07-21" comment).
	FeePotsByCreator map[string]*big.Int
	FeePotsTotal     *big.Int
	Total            *big.Int
}

// ActorLedger is one actor's personal HBD statement: what they put in, what
// they got out, and — the point of this whole breakdown — whether the gap
// between those two numbers is fully explained by something the design
// intends (value still held, a service they actually received, a fee they
// deliberately chose to pay) or not.
type ActorLedger struct {
	Actor string

	PaidIn      *big.Int // registration + subscription + prepay + ask-commission this actor personally sent
	ReceivedOut *big.Int // refunds + reclaimed commission this actor personally received

	CreditsHeldValue       *big.Int // floor value of this actor's SPENDABLE credit balance (excludes anything currently escrowed in a pending ask — see PendingEscrowCreditsValue)
	CreditsHeldApproximate bool     // true if any component below depended on an unresolved (approximate) credits-per-ask conversion — see report.go's resolveCreditsSpent

	// PendingEscrowCreditsValue / CreditsConsumedOnAnsweredAsks /
	// TransferredAway are credit AMOUNTS converted to an HBD VALUE via
	// refundPayout(reserve, credits, supply) — the SAME reserve-backed
	// pricing CreditsHeldValue below uses — so they can be summed into
	// PaidIn's HBD units without a unit mismatch.
	//
	// FIXED 2026-07-28 (F1, an adversarial review — read this before ever
	// touching these three fields again). Until this fix they held the raw
	// CREDIT COUNT itself, on the premise that PaidIn was booked at PAR
	// (Prepay: "PAR performs NO division," 1 credit == 1 HBD base unit), so
	// credits and HBD were numerically interchangeable and no conversion was
	// needed. RULING A deleted Prepay/PAR entirely — core/prepay.go does not
	// exist — and PaidIn's live issuance leg (buy.totalDue) is real curve
	// HBD, routinely orders of magnitude away from a 1:1 credit peg. Summing
	// a raw credit count into an HBD total therefore silently misvalued
	// every actor who consumed, received, or gave away credits through any
	// of these three paths: a real run (seed=2, 180 days, 2 creators, 40
	// actors) showed an actor's 22-TOKEN transfer, worth ~55,000 base units
	// at that market's end-state backing, counted as "22" — a >99.9%
	// understatement that alone accounted for the bulk of a 2,482,815-unit,
	// 29-actor "Unexplained" false alarm.
	//
	// PendingEscrowCreditsValue is priced at TRACE END (the last known
	// reserve/supply for that creator in this replay) — the escrow is still
	// open, so there is no single resolving block to price it at, and trace
	// end is this replay's own most-current knowledge, the same point
	// CreditsHeldValue below is priced at. CreditsConsumedOnAnsweredAsks and
	// TransferredAway are priced AT THE BLOCK OF THEIR OWN EVENT, using this
	// replay's own reserve[c]/supply[c] AS OF THAT POINT in the loop — never
	// an end-state price, which would silently import LATER market movement
	// into an EARLIER event's value and make the ledger's per-event replay
	// no longer reflect what was actually known at that block.
	PendingEscrowCommission       *big.Int // commission HBD still held in this actor's own PENDING asks — not lost, not yet resolved
	PendingEscrowCreditsValue     *big.Int // reserve-backed HBD value (at trace end) of credits still locked in this actor's own PENDING asks — not lost, not yet resolved (goes to the creator on answer, back to this actor on reclaim)
	CommissionOnAnsweredAsks      *big.Int // commission consumed because an ask THIS actor opened was actually answered — an intended cost, paid for delivered service
	CreditsConsumedOnAnsweredAsks *big.Int // reserve-backed HBD value (at the answer event's own block) of credits released to the creator because THIS actor's ask was answered — an intended cost, paid for delivered service, same logic as commission
	RegistrationFeesPaid          *big.Int // fees this actor personally paid to register a market (as a creator)
	SubscriptionFeesPaid          *big.Int // fees this actor personally paid to renew ANY creator's subscription (self or as a fan — API.md: "a fan can keep a creator alive")
	TransferredAway               *big.Int // reserve-backed HBD value (at the transfer event's own block) of credits this actor voluntarily gave away via TransferCredits — a deliberate gift/sale, not a loss the design failed to anticipate
	TradeFeesPaid                 *big.Int // the 10% trade fee this actor personally paid on curve Buys — an intended cost (RULING A/F8), not a loss; the matching cost basis (the reserve leg) is what CreditsHeldValue prices

	// Unexplained = PaidIn - (ReceivedOut + CreditsHeldValue + PendingEscrowCommission
	//               + PendingEscrowCreditsValue + CommissionOnAnsweredAsks
	//               + CreditsConsumedOnAnsweredAsks + RegistrationFeesPaid
	//               + SubscriptionFeesPaid + TransferredAway + TradeFeesPaid)
	// A positive Unexplained means this actor is worse off by an amount the
	// design does not account for — see AnalyzeLedger's doc below for what
	// this does and does not include.
	Unexplained *big.Int
}

// Overpayment flags an ask whose commissionHbdPaid exceeded what was
// actually owed at the face price in effect when the ask was opened (tracked
// by this file's own replay of register/setFace events — no extra field is
// needed from the engine for this, see the doc on faceKnown below). Per
// core/ask.go, whatever was HELD is exactly what gets booked to treasury on
// Answer — the excess is not refunded on answer, only on reclaim. A
// legitimate cause: the asker's client computed commission against a face
// value that changed (within the legal 2x/7d band) between quote and
// execution.
type Overpayment struct {
	Creator    string
	Seq        uint64
	Asker      string
	Owed       *big.Int
	Paid       *big.Int
	Excess     *big.Int
	Resolution string // "answered" (excess permanently lost to treasury), "reclaimed" or "declined" (excess returned in full, no loss — Decline is RULING E's full round-trip, money-shape-identical to Reclaim), "pending" (outcome not yet known — end of trace)
}

// LedgerReport is the full result of AnalyzeLedger.
type LedgerReport struct {
	Closes         bool
	Divergence     *big.Int // nil when Closes; otherwise Entered-(Left+Sits) at the end, base units
	FirstBadEvent  int      // index into Trace.Events; -1 if the identity held after every event
	FirstBadReason string

	Entered MoneyIn
	Left    MoneyOut
	Sits    Holdings

	// Treasury exit (Upgrade 1 / C2). The pre-fix contract credited kTreasury
	// at Register/Renew/Answer and had NO exit anywhere — 100% of protocol
	// revenue permanently locked. A conservation-only check could not see
	// this: a frozen treasury passed Entered==Left+Sits and rendered
	// identically to an idle reserve. These fields make "sits WITH a legal
	// exit" distinct from "sits, frozen forever," so the sim now FLAGS C2
	// pre-fix and passes it post-fix (owner drives WithdrawTreasury).
	TreasuryExitExercised bool     // any successful withdrawTreasury seen in the whole trace
	TreasuryReachedZero   bool     // a withdrawTreasury drove the treasury to EXACTLY 0 — proves full drainability, not just "some exit"
	TreasuryFinal         *big.Int // treasury balance at end of replay
	TreasuryMaxObserved   *big.Int // high-water mark, for context
	TreasuryFrozenFlag    bool     // C2 DETECTION: value accrued to the treasury but at trace end it still sits there AND no exit was ever exercised

	PerActor       map[string]*ActorLedger
	UnintendedLoss []*ActorLedger // actors with Unexplained > 0, sorted by actor name

	Overpayments        []Overpayment
	OverpaymentsSkipped []string // creators for whom the overpay check could not run (face never observed — see faceKnown)

	Notes []string // data-availability caveats surfaced instead of silently assumed away
}

func newActorLedger(actor string) *ActorLedger {
	return &ActorLedger{
		Actor:                         actor,
		PaidIn:                        zeroBig(),
		ReceivedOut:                   zeroBig(),
		CreditsHeldValue:              zeroBig(),
		PendingEscrowCommission:       zeroBig(),
		PendingEscrowCreditsValue:     zeroBig(),
		CommissionOnAnsweredAsks:      zeroBig(),
		CreditsConsumedOnAnsweredAsks: zeroBig(),
		RegistrationFeesPaid:          zeroBig(),
		SubscriptionFeesPaid:          zeroBig(),
		TransferredAway:               zeroBig(),
		TradeFeesPaid:                 zeroBig(),
		Unexplained:                   zeroBig(),
	}
}

// AnalyzeLedger reconciles every HBD base unit moved by tr.
//
// SCOPE NOTE on "worse off in a way the design did not intend": this
// function's Unexplained figure deliberately does NOT flag two categories
// the spec explicitly discloses as acceptable, non-bug outcomes, because
// this contract's TransferCredits carries no HBD consideration at all (it is
// a bare balance move, not a sale) and so this ledger — which only sees HBD
// — cannot see a secondary-market trade price in the first place:
//
//  1. a holder who bought credits above face on a secondary market and is
//     later refunded at the (lower) reserve floor (SPEC §1.7.5's disclosed
//     risk) — invisible to this ledger by construction, not merely unflagged;
//
//  2. a holder who received credits for free via TransferCredits and later
//     refunds them for a "profit" — not a bug, a gift. TransferCredits moves
//     no HBD, so it never appears in PaidIn/ReceivedOut on either side; the
//     giving side's reserve-backed value is tracked separately (ActorLedger.
//     TransferredAway, an explained bucket) precisely so giving credits away
//     is never mistaken for an unintended loss on the sender's ledger.
//
//  3. A THIRD, real and worth naming (added 2026-07-28): CreditsHeldValue
//     prices a held balance at the WIND-DOWN pro-rata FLOOR — refundPayout,
//     reserve*credits/supply (net of the K2 exit tax, F8), the worst case if
//     the market froze this instant — never at what those tokens are
//     actually worth on the OPEN curve rail (Sell) while the market is still
//     trading. Under R===area(S) and an increasing marginal price, the
//     curve/Sell value of a holding is always >= its pro-rata floor value
//     (the whole point of the governing theorem this contract is built on —
//     see core/refund.go), so this is a DELIBERATELY conservative,
//     one-directional gap: it can make a healthy, fully-solvent holder's
//     Unexplained read positive, but it can never hide a REAL loss the
//     other way.
//
//     CORRECTED 2026-07-28 (F1, an adversarial review caught this). An
//     earlier version of this note went further and told the reader to
//     treat Unexplained as benign for any STILL-HOLDING actor and to
//     "reserve suspicion" only for one who had ALREADY exited — stated as a
//     rule, never actually checked against a real run's own output. It was
//     false: the same real run cited above had 29 flagged actors, 11 of
//     them ALREADY EXITED (CreditsHeldValue==0, PendingEscrowCommission==0,
//     PendingEscrowCreditsValue==0 — nothing left that this appreciation gap
//     could explain) yet still showing a large positive Unexplained. That
//     was never evidence those 11 were secretly fine; it was a SEPARATE bug
//     (the PAR-era unit error fixed above, on PendingEscrowCreditsValue/
//     CreditsConsumedOnAnsweredAsks/TransferredAway) silently summing raw
//     credit COUNTS into an HBD total for actors on every side of this
//     ledger, exited or not.
//
//  4. A FOURTH, discovered while re-verifying the F1 fix against real runs
//     (2026-07-28) rather than assumed away: even a FULLY EXITED actor
//     (CreditsHeldValue==0, PendingEscrowCommission==0,
//     PendingEscrowCreditsValue==0) can show a genuine, real positive
//     Unexplained with NO bug anywhere — POOL DILUTION by OTHER holders'
//     round-trip trading. Flat pro-rata pricing (refundPayout, this file
//     and core/refund.go both use it) is POSITION-BLIND: it pays out of the
//     CURRENT shared (reserve, supply) average for the whole creator, not a
//     per-buyer slice. Area(x)/x is non-decreasing in x (a property of the
//     convex, increasing curve — core/curve.go), so supply GROWING only
//     ever raises or holds the shared average — but supply SHRINKING (a
//     Sell removes the TOP, priciest tokens; a Refund/RefundHolder removes
//     a pro-rata slice) can only ever lower or hold it. An actor who buys
//     early and simply holds is never touched directly by someone ELSE's
//     later Sell — but if that other holder buys in on top and then sells
//     part of it back out, the shared pool's average can end up BELOW what
//     the first actor originally paid, purely from the second actor's own
//     round trip, with the aggregate identity (R===Area(S)) never once
//     violated. PROVEN, not theorized: a minimal 3-event synthetic trace
//     (bob buys 100 for cost=50000 alone; charlie buys 900 more, then
//     sells 500 of it back) drives the shared average from 500/credit down
//     to 400/credit — bob, who did nothing but hold, shows Unexplained=
//     18000 with zero held or pending value, and the identity still Closes.
//     This is not a defect in this file's replay (it correctly mirrors what
//     core.Refund/RefundHolder would ACTUALLY pay bob if he exited at that
//     moment) — it is a genuine, previously-invisible consequence of core's
//     own flat pro-rata design that the PRE-F1 unit bug's raw-credit-count
//     accounting could never have surfaced, because it was not doing real
//     economic valuation at all. Whether this fairness property (an
//     uninvolved early holder's exit value can be diluted by a LATER
//     holder's unrelated round-trip trade) is acceptable is a product/
//     ruling question for core's own owners, not something this analysis
//     layer can or should paper over by discounting it back out.
//
//     Do not assume which bucket an Unexplained figure belongs to without
//     reading the actor's own breakdown: a positive Unexplained is excused
//     as non-fund-safety ONLY when it is fully accounted for by (3) the
//     appreciation gap on a CURRENTLY-holding actor (CreditsHeldValue > 0)
//     or (4) the pool-dilution pattern above on a fully-exited actor with a
//     verifiable OTHER-holder round trip in the same trace — a residual
//     that fits NEITHER shape (in particular, any residual larger than what
//     (3)/(4) can plausibly account for, or one arising with no round-trip
//     activity from anyone else at all) is worth investigating as a real
//     bug, exited or not.
//
// What IS in scope and caught: an escrow whose held commission is not
// returned in full on reclaim, or not booked in full on answer (an I5
// violation); a refund or renewal that silently pays out less than the
// documented formula says it should; any actor whose money simply
// disappears with no held value and no intended-cost bucket to explain it.
func AnalyzeLedger(tr *Trace) LedgerReport {
	rpt := LedgerReport{
		FirstBadEvent: -1,
		Entered:       MoneyIn{Registration: zeroBig(), Subscription: zeroBig(), Prepay: zeroBig(), Buy: zeroBig(), CommissionHeld: zeroBig(), Total: zeroBig()},
		Left: MoneyOut{
			Refunds: zeroBig(), ReclaimedCommission: zeroBig(), DeclinedCommission: zeroBig(),
			Sold: zeroBig(), TradeFeesClaimed: zeroBig(), TreasuryWithdrawn: zeroBig(), Total: zeroBig(),
		},
		Sits: Holdings{
			Treasury: zeroBig(), ReservesByCreator: map[string]*big.Int{}, ReserveTotal: zeroBig(),
			EscrowHeldByCreator: map[string]*big.Int{}, EscrowHeldTotal: zeroBig(),
			FeePotsByCreator: map[string]*big.Int{}, FeePotsTotal: zeroBig(), Total: zeroBig(),
		},
		TreasuryFinal:       zeroBig(),
		TreasuryMaxObserved: zeroBig(),
		PerActor:            map[string]*ActorLedger{},
	}
	if tr == nil {
		rpt.Closes = true
		return rpt
	}

	commissionBps := commissionBpsFor(tr)
	subPeriod := subscriptionPeriodFor(tr)

	reserve := map[string]*big.Int{}
	supply := map[string]*big.Int{}
	face := map[string]*big.Int{}
	faceKnown := map[string]bool{}
	paidUntil := map[string]uint64{}
	bal := map[string]map[string]*big.Int{} // creator -> holder -> balance
	feePots := map[string]*big.Int{}        // creator -> pull-claimable trade-fee/exit-tax creator half (kFeeBal, RULING F8)
	nextSeq := map[string]uint64{}
	escrows := map[string]map[uint64]*escrowHold{} // creator -> seq -> hold (present only while PENDING)
	treasury := zeroBig()

	// Treasury exit tracking (Upgrade 1 / C2).
	treasuryMax := zeroBig()
	treasuryExitExercised := false
	treasuryReachedZero := false

	entered := zeroBig()
	left := zeroBig()
	sits := zeroBig() // treasury + Σreserve + Σescrow-held, maintained incrementally

	// markBad records the FIRST divergence only — a later one is downstream
	// noise once the identity has already broken. Used both by the
	// aggregate entered==left+sits check at the bottom of the loop and by
	// the per-creator negative-reserve check below: the aggregate check
	// alone cannot catch a single creator's reserve going negative if
	// another creator's surplus happens to mask it in the global total, so
	// I1 (reserve must never go negative) is checked directly, per creator,
	// every time a payout is subtracted from one.
	// divergence is captured AT THE MOMENT markBad fires, not recomputed from
	// final aggregate totals afterwards: the two check kinds mean different
	// things by "divergence" (an aggregate entered/left/sits mismatch vs. one
	// creator's reserve going negative), and the aggregate figure can be
	// exactly zero even while a per-creator violation is real — recomputing
	// it post-hoc would print a misleading "Divergence: 0" right next to
	// "DOES NOT CLOSE".
	markBad := func(i int, reason string, divergence *big.Int) {
		if rpt.FirstBadEvent == -1 {
			rpt.FirstBadEvent = i
			rpt.FirstBadReason = reason
			rpt.Divergence = divergence
		}
	}

	getActor := func(name string) *ActorLedger {
		a, ok := rpt.PerActor[name]
		if !ok {
			a = newActorLedger(name)
			rpt.PerActor[name] = a
		}
		return a
	}
	getBal := func(creator, holder string) *big.Int {
		m, ok := bal[creator]
		if !ok {
			return zeroBig()
		}
		v, ok := m[holder]
		if !ok {
			return zeroBig()
		}
		return v
	}
	setBal := func(creator, holder string, v *big.Int) {
		if bal[creator] == nil {
			bal[creator] = map[string]*big.Int{}
		}
		bal[creator][holder] = v
	}
	addBal := func(creator, holder string, delta *big.Int) {
		setBal(creator, holder, new(big.Int).Add(getBal(creator, holder), delta))
	}
	get := func(m map[string]*big.Int, k string) *big.Int {
		v, ok := m[k]
		if !ok {
			return zeroBig()
		}
		return v
	}

	overpaymentIdx := map[string]int{} // "creator|seq" -> index into rpt.Overpayments, while pending

	for i, ev := range tr.Events {
		if !ev.OK {
			continue // failed calls move nothing — see AnalyzeFailures for the cross-check that this holds
		}
		c := ev.Creator

		switch ev.Action {
		case "register":
			fee, ok := argBig(ev, "feePaid")
			if !ok {
				rpt.Notes = append(rpt.Notes, fmt.Sprintf("event %d (register by %s): missing Args.feePaid, skipped in ledger", i, ev.Actor))
				continue
			}
			treasury = new(big.Int).Add(treasury, fee)
			entered = new(big.Int).Add(entered, fee)
			sits = new(big.Int).Add(sits, fee)
			rpt.Entered.Registration = new(big.Int).Add(rpt.Entered.Registration, fee)
			a := getActor(ev.Actor)
			a.PaidIn = new(big.Int).Add(a.PaidIn, fee)
			a.RegistrationFeesPaid = new(big.Int).Add(a.RegistrationFeesPaid, fee)
			paidUntil[c] = ev.Block + subPeriod
			if f, ok := argBig(ev, "face"); ok {
				face[c] = f
				faceKnown[c] = true
			}
			nextSeq[c] = 0

		case "renew":
			paid, ok := argBig(ev, "paid")
			periods, okP := argU64(ev, "periods")
			if !ok || !okP {
				rpt.Notes = append(rpt.Notes, fmt.Sprintf("event %d (renew by %s): missing Args.paid/periods, skipped in ledger", i, ev.Actor))
				continue
			}
			treasury = new(big.Int).Add(treasury, paid)
			entered = new(big.Int).Add(entered, paid)
			sits = new(big.Int).Add(sits, paid)
			rpt.Entered.Subscription = new(big.Int).Add(rpt.Entered.Subscription, paid)
			a := getActor(ev.Actor)
			a.PaidIn = new(big.Int).Add(a.PaidIn, paid)
			a.SubscriptionFeesPaid = new(big.Int).Add(a.SubscriptionFeesPaid, paid)
			base := paidUntil[c]
			if ev.Block > base {
				base = ev.Block
			}
			paidUntil[c] = base + periods*subPeriod

		case "setFace":
			if f, ok := argBig(ev, "newFace"); ok {
				face[c] = f
				faceKnown[c] = true
			}

		case "prepay":
			hbdPaid, ok := argBig(ev, "hbdPaid")
			if !ok {
				rpt.Notes = append(rpt.Notes, fmt.Sprintf("event %d (prepay by %s): missing Args.hbdPaid, skipped in ledger", i, ev.Actor))
				continue
			}
			reserve[c] = new(big.Int).Add(get(reserve, c), hbdPaid)
			supply[c] = new(big.Int).Add(get(supply, c), hbdPaid) // PAR: credits == hbdPaid exactly
			addBal(c, ev.Actor, hbdPaid)
			entered = new(big.Int).Add(entered, hbdPaid)
			sits = new(big.Int).Add(sits, hbdPaid)
			rpt.Entered.Prepay = new(big.Int).Add(rpt.Entered.Prepay, hbdPaid)
			a := getActor(ev.Actor)
			a.PaidIn = new(big.Int).Add(a.PaidIn, hbdPaid)

		case "buy":
			// RULING A: the ONLY live issuance path (prepay's PAR mint is
			// dead). Mirrors core/buy.go exactly: cost enters kReserve in
			// full, the 10% trade fee splits 5/5 to kFeeBal(creator) (pull,
			// F8) and kTreasury, and the buyer's wallet is drawn cost+fee
			// (totalDue) — sim/actions.go's doBuy records exactly these three
			// numbers.
			tokens, okT := argBig(ev, "tokens")
			cost, okC := argBig(ev, "cost")
			fee, okF := argBig(ev, "fee")
			totalDue, okD := argBig(ev, "totalDue")
			if !okT || !okC || !okF || !okD {
				rpt.Notes = append(rpt.Notes, fmt.Sprintf("event %d (buy by %s): missing Args.tokens/cost/fee/totalDue, skipped in ledger", i, ev.Actor))
				continue
			}
			feeCreator, feePlatform := splitHalf(fee)
			reserve[c] = new(big.Int).Add(get(reserve, c), cost)
			supply[c] = new(big.Int).Add(get(supply, c), tokens)
			addBal(c, ev.Actor, tokens)
			treasury = new(big.Int).Add(treasury, feePlatform)
			feePots[c] = new(big.Int).Add(get(feePots, c), feeCreator)
			entered = new(big.Int).Add(entered, totalDue)
			sits = new(big.Int).Add(sits, totalDue) // == cost + feeCreator + feePlatform
			rpt.Entered.Buy = new(big.Int).Add(rpt.Entered.Buy, totalDue)
			a := getActor(ev.Actor)
			a.PaidIn = new(big.Int).Add(a.PaidIn, totalDue)
			a.TradeFeesPaid = new(big.Int).Add(a.TradeFeesPaid, fee)

		case "sell":
			// RULING K: the complementary curve exit. Mirrors core/sell.go
			// exactly: the reserve pays the FULL gross slice; the K2 exit tax
			// and the 10% trade fee both split 5/5 creator/platform
			// (exittax.go/tradefee.go); the seller receives net = gross - tax
			// - fee. sim/actions.go's doSell records sold/gross/tax/fee/net.
			sold, okS := argBig(ev, "sold")
			gross, okG := argBig(ev, "gross")
			tax, okX := argBig(ev, "tax")
			fee, okF := argBig(ev, "fee")
			net, okN := argBig(ev, "net")
			if !okS || !okG || !okX || !okF || !okN {
				rpt.Notes = append(rpt.Notes, fmt.Sprintf("event %d (sell by %s): missing Args.sold/gross/tax/fee/net, skipped in ledger", i, ev.Actor))
				continue
			}
			taxCreator, taxPlatform := splitHalf(tax)
			feeCreator, feePlatform := splitHalf(fee)
			reserve[c] = new(big.Int).Sub(get(reserve, c), gross)
			if reserve[c].Sign() < 0 {
				markBad(i, fmt.Sprintf("event %d (sell by %s on %s): reserve went NEGATIVE (%s) — I1 solvency violated; the sold slice's gross (%s) exceeded this creator's replayed reserve",
					i, ev.Actor, c, reserve[c], gross), new(big.Int).Set(reserve[c]))
			}
			supply[c] = new(big.Int).Sub(get(supply, c), sold)
			addBal(c, ev.Actor, new(big.Int).Neg(sold))
			treasury = new(big.Int).Add(treasury, new(big.Int).Add(taxPlatform, feePlatform))
			feePots[c] = new(big.Int).Add(get(feePots, c), new(big.Int).Add(taxCreator, feeCreator))
			left = new(big.Int).Add(left, net)
			sits = new(big.Int).Sub(sits, net) // reserve -gross, treasury/feePots +tax+fee, net == gross-tax-fee
			rpt.Left.Sold = new(big.Int).Add(rpt.Left.Sold, net)
			a := getActor(ev.Actor)
			a.ReceivedOut = new(big.Int).Add(a.ReceivedOut, net)

		case "ask":
			commissionPaid, ok := argBig(ev, "commissionHbdPaid")
			if !ok {
				rpt.Notes = append(rpt.Notes, fmt.Sprintf("event %d (ask by %s): missing Args.commissionHbdPaid, skipped in ledger", i, ev.Actor))
				continue
			}
			seq := nextSeq[c]
			nextSeq[c] = seq + 1
			credits, okCred := resolveCreditsSpent(ev)
			if escrows[c] == nil {
				escrows[c] = map[uint64]*escrowHold{}
			}
			escrows[c][seq] = &escrowHold{asker: ev.Actor, commissionHbd: commissionPaid, credits: credits, creditsApprox: !okCred}
			if okCred {
				addBal(c, ev.Actor, new(big.Int).Neg(credits))
			}

			entered = new(big.Int).Add(entered, commissionPaid)
			sits = new(big.Int).Add(sits, commissionPaid)
			rpt.Entered.CommissionHeld = new(big.Int).Add(rpt.Entered.CommissionHeld, commissionPaid)
			a := getActor(ev.Actor)
			a.PaidIn = new(big.Int).Add(a.PaidIn, commissionPaid)

			if faceKnown[c] {
				owed := bpsFloor(face[c], commissionBps)
				if commissionPaid.Cmp(owed) > 0 {
					op := Overpayment{
						Creator: c, Seq: seq, Asker: ev.Actor,
						Owed: owed, Paid: commissionPaid,
						Excess:     new(big.Int).Sub(commissionPaid, owed),
						Resolution: "pending",
					}
					rpt.Overpayments = append(rpt.Overpayments, op)
					overpaymentIdx[key2(c, seq)] = len(rpt.Overpayments) - 1
				}
			} else {
				found := false
				for _, cc := range rpt.OverpaymentsSkipped {
					if cc == c {
						found = true
						break
					}
				}
				if !found {
					rpt.OverpaymentsSkipped = append(rpt.OverpaymentsSkipped, c)
				}
			}

		case "answer":
			seq, okSeq := argU64(ev, "seq")
			if !okSeq {
				rpt.Notes = append(rpt.Notes, fmt.Sprintf("event %d (answer by %s): missing Args.seq, skipped in ledger", i, ev.Actor))
				continue
			}
			hold := escrowLookup(escrows, c, seq)
			if hold == nil {
				rpt.Notes = append(rpt.Notes, fmt.Sprintf("event %d (answer by %s on %s seq %d): no matching PENDING escrow in replay — trace may start mid-market or seq numbering diverges from this package's own counter", i, ev.Actor, c, seq))
				continue
			}
			treasury = new(big.Int).Add(treasury, hold.commissionHbd)
			// internal move only (escrow-hold -> treasury): sits total unchanged.
			if hold.credits != nil {
				addBal(c, c, hold.credits) // credits release to the creator's own balance
			}
			delete(escrows[c], seq)
			asker := getActor(hold.asker)
			asker.CommissionOnAnsweredAsks = new(big.Int).Add(asker.CommissionOnAnsweredAsks, hold.commissionHbd)
			if hold.credits != nil {
				// F1: reserve-backed HBD value at THIS event's own block —
				// reserve[c]/supply[c] are this replay's running shadow state,
				// already as-of the current point in the loop (answer moves no
				// reserve/supply itself, so this is exactly the pair core.Answer
				// would have seen too). See the field's own doc for why this is
				// a credit COUNT no longer, and why "at this block" not
				// "at trace end."
				value := refundPayout(get(reserve, c), hold.credits, get(supply, c))
				asker.CreditsConsumedOnAnsweredAsks = new(big.Int).Add(asker.CreditsConsumedOnAnsweredAsks, value)
			} else {
				asker.CreditsHeldApproximate = true
			}
			if idx, ok := overpaymentIdx[key2(c, seq)]; ok {
				rpt.Overpayments[idx].Resolution = "answered"
			}

		case "decline":
			// RULING E (ask.go's Decline, wired into the engine 2026-07-28):
			// money-shape-identical to "reclaim" below (the FULL held
			// commission and credits return to the asker), tracked in its own
			// DeclinedCommission bucket so the report can tell "the creator
			// declined" from "the asker was never answered" apart. Without
			// this case, Decline would silently fall through to the
			// catch-all `default` below, which logs a Note but moves NO
			// money in the replay — leaving `sits` permanently overstated by
			// every declined commission and breaking the Entered==Left+Sits
			// identity from the very first decline onward.
			seq, okSeq := argU64(ev, "seq")
			if !okSeq {
				rpt.Notes = append(rpt.Notes, fmt.Sprintf("event %d (decline by %s on %s): missing Args.seq, skipped in ledger", i, ev.Actor, c))
				continue
			}
			hold := escrowLookup(escrows, c, seq)
			if hold == nil {
				rpt.Notes = append(rpt.Notes, fmt.Sprintf("event %d (decline by %s on %s seq %d): no matching PENDING escrow in replay", i, ev.Actor, c, seq))
				continue
			}
			left = new(big.Int).Add(left, hold.commissionHbd)
			sits = new(big.Int).Sub(sits, hold.commissionHbd)
			rpt.Left.DeclinedCommission = new(big.Int).Add(rpt.Left.DeclinedCommission, hold.commissionHbd)
			if hold.credits != nil {
				addBal(c, hold.asker, hold.credits)
			}
			delete(escrows[c], seq)
			// core.Decline is creator-only to CALL, but the payout target is
			// fixed by the escrow — the asker, never ev.Actor — same shape as
			// Reclaim's identical payee rule (ask.go).
			a := getActor(hold.asker)
			a.ReceivedOut = new(big.Int).Add(a.ReceivedOut, hold.commissionHbd)
			if idx, ok := overpaymentIdx[key2(c, seq)]; ok {
				rpt.Overpayments[idx].Resolution = "declined"
			}

		case "reclaim":
			seq, okSeq := argU64(ev, "seq")
			if !okSeq {
				rpt.Notes = append(rpt.Notes, fmt.Sprintf("event %d (reclaim by %s on %s): missing Args.seq, skipped in ledger", i, ev.Actor, c))
				continue
			}
			hold := escrowLookup(escrows, c, seq)
			if hold == nil {
				rpt.Notes = append(rpt.Notes, fmt.Sprintf("event %d (reclaim by %s on %s seq %d): no matching PENDING escrow in replay", i, ev.Actor, c, seq))
				continue
			}
			left = new(big.Int).Add(left, hold.commissionHbd)
			sits = new(big.Int).Sub(sits, hold.commissionHbd)
			rpt.Left.ReclaimedCommission = new(big.Int).Add(rpt.Left.ReclaimedCommission, hold.commissionHbd)
			if hold.credits != nil {
				addBal(c, hold.asker, hold.credits)
			}
			delete(escrows[c], seq)
			// core.Reclaim ALWAYS pays rec.asker, NEVER the caller (H1
			// permissionless-reclaim fix, API.md rule 2) — so the payee is the
			// escrow's own asker, even when a third party (keeper/samaritan)
			// pushed this reclaim on their behalf (ev.Actor != hold.asker).
			// Attributing ReceivedOut to hold.asker, not ev.Actor, keeps this
			// correct for both self- and permissionless reclaims.
			a := getActor(hold.asker)
			a.ReceivedOut = new(big.Int).Add(a.ReceivedOut, hold.commissionHbd)
			if idx, ok := overpaymentIdx[key2(c, seq)]; ok {
				rpt.Overpayments[idx].Resolution = "reclaimed"
			}

		case "refund":
			credits, ok := argBig(ev, "credits")
			if !ok {
				rpt.Notes = append(rpt.Notes, fmt.Sprintf("event %d (refund by %s): missing Args.credits, skipped in ledger", i, ev.Actor))
				continue
			}
			s := get(supply, c)
			r := get(reserve, c)
			if s.Sign() <= 0 {
				rpt.Notes = append(rpt.Notes, fmt.Sprintf("event %d (refund by %s on %s): OK refund with replayed supply<=0 — this package's shadow supply has diverged from the real contract's, ledger entry skipped", i, ev.Actor, c))
				continue
			}
			gross := refundPayout(r, credits, s)
			reserve[c] = new(big.Int).Sub(r, gross)
			if reserve[c].Sign() < 0 {
				markBad(i, fmt.Sprintf("event %d (refund by %s on %s): reserve went NEGATIVE (%s) — I1 solvency violated; the requested credits (%s) exceeded what this creator's replayed supply (%s) could support",
					i, ev.Actor, c, reserve[c], credits, s), new(big.Int).Set(reserve[c]))
			}
			supply[c] = new(big.Int).Sub(s, credits)
			addBal(c, ev.Actor, new(big.Int).Neg(credits))
			// K2: the same hold-time exit tax the curve charges is carved from
			// the gross pro-rata slice, 50/50 creator/platform (exittax.go).
			// The tax RATE depends on the caller's hold clock, which this
			// package deliberately does not reimplement independently (same
			// reasoning journey.go gives for not reimplementing the TWAP: an
			// independent shadow of a clock this subtle risks silently
			// drifting and then lying with confidence) — so the tax amount is
			// sourced from the trace's own "exitTax" Arg (present only when
			// nonzero — sim/actions.go's doRefund), and the reserve debit
			// above stays an INDEPENDENT reimplementation via refundPayout.
			tax, _ := argBig(ev, "exitTax") // absent/zero => a fully-matured caller, taxBps==0
			if tax == nil {
				tax = zeroBig()
			}
			net := new(big.Int).Sub(gross, tax)
			if net.Sign() < 0 {
				net = zeroBig() // unreachable given tax<=gross always; defensive floor, never a negative payout
			}
			// F1 MECHANICAL GUARD (an adversarial review's ask): the trace's
			// own recorded "payout" Arg (sim/actions.go's doRefund:
			// `payout, err := core.Refund(...)`) is the REAL net core.Refund
			// returned. `net` above is this replay's OWN independent
			// derivation — refundPayout on this replay's own shadow
			// (reserve, credits, supply), minus a tax sourced from the SAME
			// trace. If the two disagree, either this replay's shadow state
			// has drifted from the real contract's, or core itself
			// mis-computed — either way this is exactly the class of defect
			// that used to be caught only "by eye" (report.go's refundPayout
			// doc: the PAR-era clamp bug), not by an assertion that runs on
			// every single refund automatically.
			if payoutArg, ok := argBig(ev, "payout"); ok && net.Cmp(payoutArg) != 0 {
				markBad(i, fmt.Sprintf("event %d (refund by %s on %s): replayed net (%s) != trace's own recorded payout (%s) — this replay's independent refundPayout/tax derivation and core.Refund's real return value disagree",
					i, ev.Actor, c, net, payoutArg), new(big.Int).Sub(net, payoutArg))
			}
			taxCreator, taxPlatform := splitHalf(tax)
			treasury = new(big.Int).Add(treasury, taxPlatform)
			feePots[c] = new(big.Int).Add(get(feePots, c), taxCreator)
			left = new(big.Int).Add(left, net)
			sits = new(big.Int).Sub(sits, net) // reserve -gross, treasury/feePots +tax, net == gross-tax
			rpt.Left.Refunds = new(big.Int).Add(rpt.Left.Refunds, net)
			a := getActor(ev.Actor)
			a.ReceivedOut = new(big.Int).Add(a.ReceivedOut, net)

		case "refundHolder":
			holder, okH := argStr(ev, "holder")
			if !okH {
				rpt.Notes = append(rpt.Notes, fmt.Sprintf("event %d (refundHolder by %s on %s): missing Args.holder, skipped in ledger", i, ev.Actor, c))
				continue
			}
			credits := getBal(c, holder)
			if credits.Sign() <= 0 {
				continue // legitimate no-op: RefundHolder on a zero balance pays nothing (core/refund.go)
			}
			s := get(supply, c)
			r := get(reserve, c)
			if s.Sign() <= 0 {
				rpt.Notes = append(rpt.Notes, fmt.Sprintf("event %d (refundHolder by %s targeting %s on %s): OK with replayed supply<=0, skipped", i, ev.Actor, holder, c))
				continue
			}
			gross := refundPayout(r, credits, s)
			reserve[c] = new(big.Int).Sub(r, gross)
			if reserve[c].Sign() < 0 {
				markBad(i, fmt.Sprintf("event %d (refundHolder by %s targeting %s on %s): reserve went NEGATIVE (%s) — I1 solvency violated",
					i, ev.Actor, holder, c, reserve[c]), new(big.Int).Set(reserve[c]))
			}
			supply[c] = new(big.Int).Sub(s, credits)
			setBal(c, holder, zeroBig())
			// K2 tax, on the pushed HOLDER's clock — same reasoning and same
			// Args-sourced amount as the "refund" case above.
			tax, _ := argBig(ev, "exitTax")
			if tax == nil {
				tax = zeroBig()
			}
			net := new(big.Int).Sub(gross, tax)
			if net.Sign() < 0 {
				net = zeroBig()
			}
			// F1 MECHANICAL GUARD — identical reasoning to the "refund" case
			// above: cross-check this replay's independently-derived net
			// against the trace's own recorded "payout" Arg (sim/actions.go's
			// doRefundHolder).
			if payoutArg, ok := argBig(ev, "payout"); ok && net.Cmp(payoutArg) != 0 {
				markBad(i, fmt.Sprintf("event %d (refundHolder by %s targeting %s on %s): replayed net (%s) != trace's own recorded payout (%s) — this replay's independent refundPayout/tax derivation and core.RefundHolder's real return value disagree",
					i, ev.Actor, holder, c, net, payoutArg), new(big.Int).Sub(net, payoutArg))
			}
			taxCreator, taxPlatform := splitHalf(tax)
			treasury = new(big.Int).Add(treasury, taxPlatform)
			feePots[c] = new(big.Int).Add(get(feePots, c), taxCreator)
			left = new(big.Int).Add(left, net)
			sits = new(big.Int).Sub(sits, net)
			rpt.Left.Refunds = new(big.Int).Add(rpt.Left.Refunds, net)
			a := getActor(holder) // API.md rule 2: RefundHolder pays the HOLDER, never the caller
			a.ReceivedOut = new(big.Int).Add(a.ReceivedOut, net)

		case "transfer":
			to, okTo := argStr(ev, "to")
			amount, okAmt := argBig(ev, "amount")
			if okTo && okAmt {
				addBal(c, ev.Actor, new(big.Int).Neg(amount))
				addBal(c, to, amount)
				// A transfer is a voluntary, permissionless gift/sale — API.md
				// rule 4, "transfer of already-owned credits" is never gated.
				// The sender chose to give this value away; that must count as
				// EXPLAINED, not as an unintended loss (see the doc on
				// AnalyzeLedger's SCOPE NOTE for the symmetric reasoning on
				// why the RECEIVING side is never counted as PaidIn either —
				// so a gift never manufactures a false "loss" on one side or a
				// false "unexplained gain" flag on the other).
				sender := getActor(ev.Actor)
				// F1: reserve-backed HBD value at THIS event's own block — a
				// transfer moves no reserve/supply itself, so reserve[c]/
				// supply[c] here are exactly what they were the instant this
				// transfer executed. See the field's own doc for why this is a
				// credit COUNT no longer.
				value := refundPayout(get(reserve, c), amount, get(supply, c))
				sender.TransferredAway = new(big.Int).Add(sender.TransferredAway, value)
			}
			// no HBD leg — nothing to add to entered/left/sits.

		case "withdrawTreasury":
			// Upgrade 1 (C2): the treasury's ONLY exit. Owner-gated and bounded
			// by core to (0, treasury] — a well-formed trace never over-draws.
			// This moves HBD from the treasury "sits" bucket OUT to the owner:
			// treasury and the running sits total both drop by amount, left
			// rises by amount, so Entered==Left+Sits is preserved exactly.
			amount, ok := argBig(ev, "amount")
			if !ok {
				rpt.Notes = append(rpt.Notes, fmt.Sprintf("event %d (withdrawTreasury by %s): missing Args.amount, skipped in ledger", i, ev.Actor))
				continue
			}
			if amount.Cmp(treasury) > 0 {
				// Should be unreachable given core's bound; if a trace shows it,
				// note it and clamp so the replay stays well-defined rather than
				// driving the treasury negative on bad data.
				rpt.Notes = append(rpt.Notes, fmt.Sprintf("event %d (withdrawTreasury by %s): amount %s exceeds replayed treasury %s — core bounds this to (0, treasury]; clamping the replay",
					i, ev.Actor, amount, treasury))
				amount = new(big.Int).Set(treasury)
			}
			treasury = new(big.Int).Sub(treasury, amount)
			left = new(big.Int).Add(left, amount)
			sits = new(big.Int).Sub(sits, amount)
			rpt.Left.TreasuryWithdrawn = new(big.Int).Add(rpt.Left.TreasuryWithdrawn, amount)
			treasuryExitExercised = true
			if treasury.Sign() == 0 {
				treasuryReachedZero = true // the owner drained the accrued treasury to EXACTLY 0
			}
			a := getActor(ev.Actor) // the owner receives this HBD out
			a.ReceivedOut = new(big.Int).Add(a.ReceivedOut, amount)

		case "claimTradeFees":
			// RULING F8 (tradefee.go's pull half, wired into the engine
			// 2026-07-28): pays the caller's ENTIRE accrued kFeeBal — money
			// leaving the Sits.FeePotsTotal bucket, the identical role
			// "withdrawTreasury" above plays for kTreasury. Without this
			// case, ClaimTradeFees would fall through to `default` (a Note,
			// no money moved in the replay) while core REALLY drained the
			// creator's feePot — sits would stay overstated by every claimed
			// amount and the identity would diverge from the first claim on.
			claimed, ok := argBig(ev, "claimed")
			if !ok {
				rpt.Notes = append(rpt.Notes, fmt.Sprintf("event %d (claimTradeFees by %s): missing Args.claimed, skipped in ledger", i, ev.Actor))
				continue
			}
			if claimed.Sign() == 0 {
				continue // legitimate no-op: ClaimTradeFees on an empty pot pays nothing (core/tradefee.go)
			}
			pot := get(feePots, c) // c == ev.Creator == ev.Actor here (sim/actions.go's doClaimTradeFees: newEvent("claimTradeFees", caller, caller))
			if claimed.Cmp(pot) > 0 {
				// Should be unreachable given core's own exact-balance payout
				// (ClaimTradeFees pays getMoney(kFeeBal) exactly, then zeros
				// it); if a trace shows it, note it and clamp so the replay
				// stays well-defined rather than driving feePots negative.
				rpt.Notes = append(rpt.Notes, fmt.Sprintf("event %d (claimTradeFees by %s): claimed %s exceeds replayed feePot %s — clamping the replay",
					i, ev.Actor, claimed, pot))
				claimed = new(big.Int).Set(pot)
			}
			feePots[c] = new(big.Int).Sub(pot, claimed)
			left = new(big.Int).Add(left, claimed)
			sits = new(big.Int).Sub(sits, claimed)
			rpt.Left.TradeFeesClaimed = new(big.Int).Add(rpt.Left.TradeFeesClaimed, claimed)
			a := getActor(ev.Actor)
			a.ReceivedOut = new(big.Int).Add(a.ReceivedOut, claimed)

		case "closeIfDrained", "setCap", "recordObs",
			"retire", "createOffering", "setOfferingPrice", "setOfferingTitle", "deleteOffering":
			// no HBD movement. The four shop-catalogue writers and Retire all
			// move no funds (offerings.go/market.go's own file docs — pure
			// config/state writes), explicitly recognized here rather than
			// falling through to `default` so a real run's Notes list isn't
			// cluttered with "unrecognized action" noise for actions this
			// package's author has actually read and confirmed are moneyless.

		default:
			rpt.Notes = append(rpt.Notes, fmt.Sprintf("event %d: unrecognized action %q, ignored by ledger replay", i, ev.Action))
		}

		if treasury.Cmp(treasuryMax) > 0 {
			treasuryMax = new(big.Int).Set(treasury)
		}

		// Running identity check, after every successfully-applied event.
		rhs := new(big.Int).Add(left, sits)
		if entered.Cmp(rhs) != 0 {
			diff := new(big.Int).Sub(entered, rhs)
			markBad(i, fmt.Sprintf(
				"after event %d (%s by %s on creator %q, block %d): entered=%s left+sits=%s diverge by %s",
				i, ev.Action, ev.Actor, c, ev.Block, entered.String(), rhs.String(), diff.String(),
			), diff)
		}
	}

	// Finalize Sits from the replayed state.
	rpt.Sits.Treasury = treasury
	for c, r := range reserve {
		if r.Sign() != 0 {
			rpt.Sits.ReservesByCreator[c] = r
		}
		rpt.Sits.ReserveTotal = new(big.Int).Add(rpt.Sits.ReserveTotal, r)
	}
	for c, m := range escrows {
		for _, h := range m {
			if rpt.Sits.EscrowHeldByCreator[c] == nil {
				rpt.Sits.EscrowHeldByCreator[c] = zeroBig()
			}
			rpt.Sits.EscrowHeldByCreator[c] = new(big.Int).Add(rpt.Sits.EscrowHeldByCreator[c], h.commissionHbd)
			rpt.Sits.EscrowHeldTotal = new(big.Int).Add(rpt.Sits.EscrowHeldTotal, h.commissionHbd)
		}
	}
	for c, p := range feePots {
		if p.Sign() != 0 {
			rpt.Sits.FeePotsByCreator[c] = p
		}
		rpt.Sits.FeePotsTotal = new(big.Int).Add(rpt.Sits.FeePotsTotal, p)
	}
	rpt.Sits.Total = new(big.Int).Add(rpt.Sits.Treasury, new(big.Int).Add(rpt.Sits.ReserveTotal,
		new(big.Int).Add(rpt.Sits.EscrowHeldTotal, rpt.Sits.FeePotsTotal)))
	rpt.Entered.Total = new(big.Int).Add(rpt.Entered.Registration, new(big.Int).Add(rpt.Entered.Subscription,
		new(big.Int).Add(rpt.Entered.Prepay, new(big.Int).Add(rpt.Entered.Buy, rpt.Entered.CommissionHeld))))
	rpt.Left.Total = new(big.Int).Add(rpt.Left.Refunds, new(big.Int).Add(rpt.Left.ReclaimedCommission,
		new(big.Int).Add(rpt.Left.DeclinedCommission, new(big.Int).Add(rpt.Left.Sold,
			new(big.Int).Add(rpt.Left.TradeFeesClaimed, rpt.Left.TreasuryWithdrawn)))))

	// Finalize the treasury-exit verdict (Upgrade 1 / C2).
	rpt.TreasuryFinal = new(big.Int).Set(treasury)
	rpt.TreasuryMaxObserved = treasuryMax
	rpt.TreasuryExitExercised = treasuryExitExercised
	rpt.TreasuryReachedZero = treasuryReachedZero
	// Frozen-forever detection: value did accrue to the treasury (max > 0) but
	// at trace end it still sits there AND no exit was ever exercised. This is
	// precisely the C2 state a conservation-only check rendered clean.
	rpt.TreasuryFrozenFlag = treasury.Sign() > 0 && !treasuryExitExercised && treasuryMax.Sign() > 0

	// rpt.Divergence was already captured by markBad, at the moment (and in
	// the terms) the FIRST violation actually occurred — see markBad's doc.
	rpt.Closes = rpt.FirstBadEvent == -1

	// Credits-held value per actor, floor-priced from final reserve/supply,
	// NET of the maximum possible K2 exit tax (F8, an adversarial review).
	//
	// core/refund.go's Refund/RefundHolder return GROSS minus a hold-time-
	// decaying exit tax (up to MaxExitTaxBps, exittax.go: "tax(t) = 20% *
	// max(0, 1 - t/6weeks)") — the holder never actually receives the raw
	// refundPayout figure. This field's own doc calls it "the WIND-DOWN
	// pro-rata FLOOR... the worst case," but until this fix it priced the
	// PRE-TAX gross, overstating the realizable floor by up to 20% — in the
	// MASKING direction (a larger explained CreditsHeldValue shrinks
	// Unexplained, hiding a real problem rather than manufacturing a false
	// one; see AnalyzeLedger's SCOPE NOTE, item 3, on why this package
	// otherwise treats "the floor never overstates" as load-bearing).
	//
	// This replay does not track each holder's own hold-clock
	// (holdclock.go's C-14 weighted-average-toward-block rule, refreshed on
	// every inflow) — reimplementing it independently here risks the same
	// silent-drift class journey.go's own doc warns against for the TWAP.
	// Rather than compute the EXACT tax, this applies the MAXIMUM possible
	// tax (MaxExitTaxBps, the freshest-hold worst case) as a conservative
	// haircut. Because ExitTaxOn(gross, τ) = ceil(gross·τ/10000) is
	// non-decreasing in τ, ceil(gross·MaxExitTaxBps/10000) upper-bounds the
	// REAL tax at any actual τ <= MaxExitTaxBps, so
	// gross - thatCeiling <= gross - realTax = the holder's true net for
	// EVERY possible hold time: a genuine floor, never an overstatement,
	// regardless of whether the exit would actually route through Sell or
	// Refund/RefundHolder — RULING K put the identical τ(h) formula behind
	// both doors. The cost, disclosed: a MATURE (long-held, near-0% tax)
	// holder's true net is now UNDERSTATED here by up to 20%, which reads as
	// a correspondingly larger Unexplained for them — never a fund-safety
	// concern (the same one-directional, appreciation-style bias this
	// package's SCOPE NOTE already documents and accepts elsewhere), and it
	// is the price of never again overstating what a fresh holder could
	// actually realize.
	for c, holders := range bal {
		s := get(supply, c)
		r := get(reserve, c)
		if s.Sign() <= 0 {
			continue
		}
		for holder, amount := range holders {
			if amount.Sign() <= 0 {
				continue
			}
			gross := refundPayout(r, amount, s)
			maxTax := bpsCeil(gross, maxExitTaxBpsFor(tr))
			net := new(big.Int).Sub(gross, maxTax)
			if net.Sign() < 0 {
				net = zeroBig() // unreachable: maxTax <= gross always (MaxExitTaxBps <= 10000), defensive floor
			}
			a := getActor(holder)
			a.CreditsHeldValue = new(big.Int).Add(a.CreditsHeldValue, net)
		}
	}
	// Commission still held on this actor's own PENDING asks. (Any escrow
	// still present here is, by construction, still PENDING — answer/reclaim
	// both delete their entry above — so its Overpayment record, if any, is
	// already correctly left at its default "pending" Resolution.)
	for c, m := range escrows {
		for _, h := range m {
			a := getActor(h.asker)
			a.PendingEscrowCommission = new(big.Int).Add(a.PendingEscrowCommission, h.commissionHbd)
			if h.credits != nil {
				// F1: reserve-backed HBD value at TRACE END — this escrow is
				// still open, so there is no single resolving block to price
				// it at; trace end is this replay's own most-current
				// knowledge, the same point CreditsHeldValue above prices at.
				value := refundPayout(get(reserve, c), h.credits, get(supply, c))
				a.PendingEscrowCreditsValue = new(big.Int).Add(a.PendingEscrowCreditsValue, value)
			} else {
				a.CreditsHeldApproximate = true
			}
		}
	}

	// Unexplained loss per actor.
	names := make([]string, 0, len(rpt.PerActor))
	for name := range rpt.PerActor {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		a := rpt.PerActor[name]
		explained := new(big.Int).Add(a.ReceivedOut, a.CreditsHeldValue)
		explained.Add(explained, a.PendingEscrowCommission)
		explained.Add(explained, a.PendingEscrowCreditsValue)
		explained.Add(explained, a.CommissionOnAnsweredAsks)
		explained.Add(explained, a.CreditsConsumedOnAnsweredAsks)
		explained.Add(explained, a.RegistrationFeesPaid)
		explained.Add(explained, a.SubscriptionFeesPaid)
		explained.Add(explained, a.TransferredAway)
		explained.Add(explained, a.TradeFeesPaid)
		a.Unexplained = new(big.Int).Sub(a.PaidIn, explained)
		if a.Unexplained.Sign() > 0 {
			rpt.UnintendedLoss = append(rpt.UnintendedLoss, a)
		}
	}

	return rpt
}

func key2(creator string, seq uint64) string { return fmt.Sprintf("%s|%d", creator, seq) }

func escrowLookup(escrows map[string]map[uint64]*escrowHold, creator string, seq uint64) *escrowHold {
	m, ok := escrows[creator]
	if !ok {
		return nil
	}
	return m[seq]
}

func (r LedgerReport) render(b *strings.Builder) {
	fmt.Fprintf(b, "--- 1. WHERE THE MONEY WENT ---\n")
	if r.Closes {
		fmt.Fprintf(b, "Identity CLOSES: entered(%s) == left(%s) + sits(%s)\n",
			r.Entered.Total, r.Left.Total, r.Sits.Total)
	} else {
		fmt.Fprintf(b, "Identity DOES NOT CLOSE. Divergence at first violation: %s base units.\n", r.Divergence)
		fmt.Fprintf(b, "First bad event: %s\n", r.FirstBadReason)
	}
	fmt.Fprintf(b, "\nEntered: registration=%s subscription=%s prepay=%s buy=%s commission-held-at-ask=%s TOTAL=%s\n",
		r.Entered.Registration, r.Entered.Subscription, r.Entered.Prepay, r.Entered.Buy, r.Entered.CommissionHeld, r.Entered.Total)
	fmt.Fprintf(b, "Left:    refunds=%s reclaimed-commission=%s sold=%s treasury-withdrawn=%s TOTAL=%s\n",
		r.Left.Refunds, r.Left.ReclaimedCommission, r.Left.Sold, r.Left.TreasuryWithdrawn, r.Left.Total)
	fmt.Fprintf(b, "Sits:    treasury=%s reserves(%d creators)=%s escrow-held(%d creators)=%s fee-pots(%d creators)=%s TOTAL=%s\n",
		r.Sits.Treasury, len(r.Sits.ReservesByCreator), r.Sits.ReserveTotal,
		len(r.Sits.EscrowHeldByCreator), r.Sits.EscrowHeldTotal,
		len(r.Sits.FeePotsByCreator), r.Sits.FeePotsTotal, r.Sits.Total)

	// Treasury exit (Upgrade 1 / C2) — the reachable-exit check that
	// distinguishes "sits with a legal exit" from "sits, frozen forever."
	switch {
	case r.TreasuryFrozenFlag:
		fmt.Fprintf(b, "\nTreasury exit (C2): *** FROZEN FOREVER *** — %s sits in the treasury (max observed %s) with NO withdrawTreasury EVER exercised in this trace.\n",
			r.TreasuryFinal, r.TreasuryMaxObserved)
		fmt.Fprintf(b, "                    This is C2: 100%% of protocol revenue permanently locked. A conservation-only check\n")
		fmt.Fprintf(b, "                    would have rendered this identically to an idle reserve — it is FLAGGED here, not counted clean.\n")
	case r.TreasuryExitExercised:
		fmt.Fprintf(b, "\nTreasury exit (C2): EXERCISED — owner withdrew %s total; treasury reached EXACTLY 0 at least once: %v; final treasury=%s (max observed %s).\n",
			r.Left.TreasuryWithdrawn, r.TreasuryReachedZero, r.TreasuryFinal, r.TreasuryMaxObserved)
		if r.TreasuryReachedZero {
			fmt.Fprintf(b, "                    PROVEN: an owner CAN withdraw the accrued treasury and it reaches 0 (not merely that treasury conserves).\n")
		} else {
			fmt.Fprintf(b, "                    NOTE: an exit was exercised but the treasury was never driven fully to 0 in this trace — revenue kept accruing after the last withdrawal.\n")
		}
	default:
		fmt.Fprintf(b, "\nTreasury exit (C2): no treasury value ever accrued in this trace (nothing to withdraw).\n")
	}

	if len(r.UnintendedLoss) == 0 {
		fmt.Fprintf(b, "\nNo actor shows an unexplained HBD loss.\n")
	} else {
		fmt.Fprintf(b, "\n%d actor(s) with UNEXPLAINED loss (paid in > everything accounted for):\n", len(r.UnintendedLoss))
		for _, a := range r.UnintendedLoss {
			fmt.Fprintf(b, "  %-16s unexplained=%s (paidIn=%s receivedOut=%s heldValue=%s pendingEscrow=%s)\n",
				a.Actor, a.Unexplained, a.PaidIn, a.ReceivedOut, a.CreditsHeldValue, a.PendingEscrowCommission)
		}
	}

	if len(r.Overpayments) > 0 {
		fmt.Fprintf(b, "\nCommission overpayments (paid more than owed at the face price when the ask opened):\n")
		for _, op := range r.Overpayments {
			fmt.Fprintf(b, "  %s seq=%d asker=%-12s owed=%s paid=%s excess=%s resolution=%s\n",
				op.Creator, op.Seq, op.Asker, op.Owed, op.Paid, op.Excess, op.Resolution)
		}
	}
	if len(r.OverpaymentsSkipped) > 0 {
		fmt.Fprintf(b, "\nOverpayment check skipped for %d creator(s) (face never observed via register/setFace before their first ask): %s\n",
			len(r.OverpaymentsSkipped), strings.Join(r.OverpaymentsSkipped, ", "))
	}

	if len(r.Notes) > 0 {
		fmt.Fprintf(b, "\nData-quality notes (%d):\n", len(r.Notes))
		for _, n := range r.Notes {
			fmt.Fprintf(b, "  - %s\n", n)
		}
	}
}
