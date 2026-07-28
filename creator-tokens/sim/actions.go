package sim

import (
	"fmt"
	"math/big"
	"math/rand"

	"creator-tokens/core"
	"creator-tokens/keeper"
)

// ---------------------------------------------------------------------------
// Tick cadences, in blocks (core.BlocksPerDay == 28800, ~3s/block). These are
// BASE cadences: engine.nextInterval stretches/compresses the actual gap by
// the current activityMultiplier and a uniform jitter, so real inter-arrival
// times vary a lot around these numbers — see engine.go's doc.
const (
	creatorTickCadence    uint64 = 4_800  // ~4h: a creator checks renewal/price/cap
	fanTickCadence        uint64 = 20_000 // ~17h: a fan's own cadence
	speculatorTickCadence uint64 = 30_000 // ~30h
	traderTickCadence     uint64 = 12_000 // ~10h
	keeperTickCadence     uint64 = core.BlocksPerDay
	oracleTickCadence     uint64 = 900                   // ~45min between price observations
	ownerTickCadence      uint64 = 3 * core.BlocksPerDay // ~3d: owner sweeps the accrued treasury (Upgrade 1 / C2)
)

// escrowAbandonProb is the chance an asker WALKS AWAY from a fresh escrow —
// never scheduling their own self-reclaim (Upgrade 2 / H1). Combined with a
// creator that never answers (abandoner/flaky), this is what organically
// produces the H1 stuck state: a PENDING escrow left open past its window on
// a market heading to FROZEN, which pins supply > 0 and used to brick the
// market forever. Post-fix it is resolvable by ANY third party (the keeper,
// or the good-samaritan sweep in speculatorTick) via the now-permissionless
// Reclaim — which is exactly what the journey analysis then asserts happened.
const escrowAbandonProb = 0.18

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

// ceilDivBig / bpsFloorBig mirror contract/main.go's own ceilDiv/bpsFloor —
// themselves documented duplicates of ask.go's PRIVATE creditsForAsk/
// commissionOwedFor helpers. Every real caller (a wallet, this simulator)
// has to independently compute a preview/commission BEFORE calling
// core.Ask, since core.Ask takes maxCredits and commissionHbdPaid as
// caller-supplied inputs, not something it derives for the caller. As
// contract/main.go's own comment states: a drift here can only make a
// PREVIEW stale, never move a wrong amount of money — core.Ask recomputes
// the real, binding numbers internally regardless of what this simulator
// guessed.
func ceilDivBig(a, b *big.Int) *big.Int {
	num := new(big.Int).Add(a, subBig(b, big.NewInt(1)))
	return num.Div(num, b)
}

func bpsFloorBig(total *big.Int, bps uint64) *big.Int {
	p := new(big.Int).Mul(total, new(big.Int).SetUint64(bps))
	return p.Div(p, big.NewInt(10000))
}

// tokenLegOf mirrors ask.go's splitFace's token leg exactly (USER RULING
// 2026-07-27, the commission carve-out): tokenLeg = face - commission,
// commission = floor(face*CommissionBps/10000) via the exported
// core.CommissionOwedFor. This is the amount settlement.go's settleSpend
// actually prices in credits (ceil(tokenLeg/rate)) — the commission leg is
// billed separately in HBD, never in credits. Every credits-needed ESTIMATE
// in this file (askIntent/ensureCreditsForAsk/oneShotSequence) must divide
// THIS by rate, never the bare posted face: dividing the full face was the
// PRE-CARVE-OUT model (the token leg used to be the full face, with the
// commission drawn on top) and now systematically over-estimates the
// credits a real ask will actually spend by ~CommissionBps, understating how
// many actors this simulator lets attempt an ask they could genuinely
// afford — core.Ask itself is unaffected (it derives the real, binding
// number from settlePosted internally regardless of what this simulator
// estimates), but a stale estimate here still means the sim proves a
// population behaviour ("X% of asks were skipped as unaffordable") that
// does not match what would actually happen on-chain.
func tokenLegOf(face *big.Int) *big.Int {
	return subBig(face, core.CommissionOwedFor(face))
}

// mulDivFloorBig mirrors core/money.go's private mMulDiv exactly —
// floor(a*b/c) — for the ONE place this simulator needs to recompute a core
// money formula rather than read a result core already returned: refund.go's
// documented refundPayout, gross(c) = floor(R·c/S) (refund.go's file header).
// core exports no QuoteRefund and Refund/RefundHolder return only the NET
// (gross − tax) they pay out, so doRefund/doRefundHolder below recover the
// exact tax core carved as gross − net, using this to recompute gross from
// the SAME (reserve, credits, supply) triple core used, captured before the
// call. All operands here are non-negative money quantities, so big.Int's
// Div (Euclidean division) coincides with floor division, exactly as
// mMulDiv's own p.Div(p, c) does.
func mulDivFloorBig(a, b, c *big.Int) *big.Int {
	if c == nil || c.Sign() == 0 {
		// Unreachable given the callers below (a refund only ever succeeds
		// against a nonzero supply — refund.go's own I3 argument) — kept as
		// the same defense-in-depth every "provably can't happen" divide in
		// this codebase carries.
		return zeroBig()
	}
	p := new(big.Int).Mul(a, b)
	return p.Div(p, c)
}

// captureDelinquent snapshots creator's delivery standing (core.
// DeliveryStanding) at THIS block, BEFORE core is actually called, into
// ev.Args["creatorDelinquent"] — exactly what engine.go's
// checkDelinquencyGuardrail reads to prove delivery.go's standing guardrail
// live: "delinquency refuses purchases... but never a payout, a subscription
// payment, or a shop-config change." It reads the same (e.Store, e.Block)
// RequireInflowOpen itself consults a moment later in the same wrapper, so
// the snapshot can never be stale or racy relative to what core actually
// decides. Every wrapper the guardrail cares about (the two purchase paths,
// every exempt payout/config path) calls this immediately after building ev.
func (e *Engine) captureDelinquent(ev *Event, creator string) {
	delinquent, _ := core.DeliveryStanding(e.Store, creator, e.Block)
	ev.Args["creatorDelinquent"] = boolStr(delinquent)
}

// ===========================================================================
// core.* call wrappers. Every one of these calls exactly one real core.*
// mutator against e.Store, updates this simulator's own shadow ledgers ONLY
// on success (a rejected core call — enforced by e.coreCall's own snapshot
// diff — never moves a simulated wallet, never touches treasuryShadow/
// heldCommissionTotal/totalHbdIn/totalHbdOut/PaidInTotal), and records one
// Event. This mirrors, action for action, what contract/main.go's wasm
// wrapper does around the same core calls (pull HBD first for an inflow,
// mutate-then-pay for an outflow) — see each function's comment for the
// specific correspondence.
// ===========================================================================

// REGISTRATION IS FREE (LOCKED-MECHANISM "Revenue", USER-RULED 2026-07-21 —
// core/params.go). This used to charge core.RegistrationFee (10 HBD), skip
// creators too poor to pay it, and book the fee to treasuryShadow. All three
// are gone with the constant: no HBD moves at registration, so no wallet, no
// totalHbdIn and no treasury shadow changes here. The event still carries a
// "feePaid" arg because the ledger analyser reads that key (sim/analysis/
// ledger.go) — it is now always "0", which the analyser sums correctly.
func (e *Engine) doRegister(name string) {
	cs := e.creators[name]

	ev := e.newEvent("register", name, name)
	ev.Args["face"] = fmt.Sprintf("%d", cs.InitialFace)
	ev.Args["cap"] = fmt.Sprintf("%d", cs.InitialCap)
	ev.Args["feePaid"] = bigStr(big.NewInt(0))

	e.coreCall("register", ev, func() error {
		return core.Register(e.Store, name, name, e.Block, cs.InitialFace, cs.InitialCap)
	})
	e.recordEvent(ev)
}

// doRenew: SPEC §1.7.5 / core/market.go — permissionless, so `caller` need
// not be `creator` (a fan keeping a favourite creator alive routes through
// here exactly like the creator renewing themselves).
func (e *Engine) doRenew(caller, creator string, periods uint64) {
	actor := e.pop.Actors[caller]
	cost := new(big.Int).Mul(big.NewInt(int64(periods)), big.NewInt(core.SubscriptionFee))
	if cmpBig(actor.HBD, cost) < 0 {
		return
	}

	ev := e.newEvent("renew", caller, creator)
	ev.Args["periods"] = fmt.Sprintf("%d", periods)
	ev.Args["paid"] = bigStr(cost)
	e.captureDelinquent(ev, creator) // standing guardrail: Renew must never be blocked by delinquency (requireMarketAcceptsMoney deliberately skips the delivery gate)

	beforePaidUntil := core.PaidUntil(e.Store, creator)
	e.coreCall("renew", ev, func() error {
		return core.Renew(e.Store, caller, creator, e.Block, periods, cost)
	})
	if ev.OK {
		actor.HBD = subBig(actor.HBD, cost)
		e.totalHbdIn = addBig(e.totalHbdIn, cost)
		e.treasuryShadow = addBig(e.treasuryShadow, cost)
		afterPaidUntil := core.PaidUntil(e.Store, creator)
		ev.Deltas["wallet:"+caller] = "-" + bigStr(cost)
		ev.Deltas["treasuryShadow"] = "+" + bigStr(cost)
		ev.Deltas["paidUntil"] = fmt.Sprintf("%d -> %d", beforePaidUntil, afterPaidUntil)
	}
	e.recordEvent(ev)
}

func (e *Engine) doSetFace(creator string, newFace int64) {
	ev := e.newEvent("setFace", creator, creator)
	ev.Args["newFace"] = fmt.Sprintf("%d", newFace)
	before := core.Face(e.Store, creator)

	e.coreCall("setFace", ev, func() error {
		return core.SetFace(e.Store, creator, creator, e.Block, newFace)
	})
	if ev.OK {
		ev.Deltas["face"] = deltaStr(before, core.Face(e.Store, creator))
	}
	e.recordEvent(ev)
}

func (e *Engine) doSetCap(creator string, newCap int64) {
	ev := e.newEvent("setCap", creator, creator)
	ev.Args["newCap"] = fmt.Sprintf("%d", newCap)
	before := core.Cap(e.Store, creator)

	e.coreCall("setCap", ev, func() error {
		return core.SetCap(e.Store, creator, creator, e.Block, newCap)
	})
	if ev.OK {
		ev.Deltas["cap"] = deltaStr(before, core.Cap(e.Store, creator))
	}
	e.recordEvent(ev)
}

// doBuy mints `n` tokens on `creator`'s curve for `caller` — the RULING-A
// replacement for the deleted doPrepay (the PAR mint is gone from core; Buy
// is the only issuance path). Mirrors contract-side economics exactly: the
// buyer's wallet is drawn TotalDue = curve cost + 10% trade fee; the cost
// enters the reserve, the fee accrues to the pull pots (creator half to
// kFeeBal, platform half to kTreasury — mirrored into treasuryShadow).
// Skips silently when the wallet cannot cover the quoted TotalDue — a
// transaction that would never reach the chain, same convention as
// doRegister's own affordability skip.
func (e *Engine) doBuy(caller, creator string, n *big.Int) {
	actor := e.pop.Actors[caller]
	if n == nil || n.Sign() <= 0 {
		return
	}
	// Affordability pre-check BEFORE the state-mutating call: core.Buy has no
	// wallet concept, so the simulator must refuse for the buyer exactly the
	// way the chain's HiveDraw would.
	if quote, err := core.QuoteBuy(e.Store, creator, e.Block, n); err == nil {
		if cmpBig(actor.HBD, quote.TotalDue) < 0 {
			return
		}
	}

	ev := e.newEvent("buy", caller, creator)
	ev.Args["tokens"] = bigStr(n)
	e.captureDelinquent(ev, creator) // Buy IS gated by RequireInflowOpen (buy.go) — a purchase, must be refused while delinquent

	beforeReserve := core.Reserve(e.Store, creator)
	beforeSupply := core.Supply(e.Store, creator)
	beforeBal := core.BalanceOf(e.Store, creator, caller)

	var res *core.BuyResult
	e.coreCall("buy", ev, func() error {
		var err error
		res, err = core.Buy(e.Store, caller, creator, e.Block, n)
		return err
	})
	if ev.OK {
		actor.HBD = subBig(actor.HBD, res.TotalDue)
		e.totalHbdIn = addBig(e.totalHbdIn, res.TotalDue)
		e.treasuryShadow = addBig(e.treasuryShadow, res.FeePlatform)
		if cs, ok := e.creators[creator]; ok {
			cs.PaidInTotal = addBig(cs.PaidInTotal, res.TotalDue)
		}
		e.addHolder(creator, caller)

		ev.Args["cost"] = bigStr(res.Cost)
		ev.Args["fee"] = bigStr(res.Fee)
		ev.Args["totalDue"] = bigStr(res.TotalDue)
		ev.Deltas["wallet:"+caller] = "-" + bigStr(res.TotalDue)
		ev.Deltas["treasuryShadow"] = "+" + bigStr(res.FeePlatform)
		ev.Deltas["reserve"] = deltaStr(beforeReserve, core.Reserve(e.Store, creator))
		ev.Deltas["supply"] = deltaStr(beforeSupply, core.Supply(e.Store, creator))
		ev.Deltas["balance:"+caller] = deltaStr(beforeBal, core.BalanceOf(e.Store, creator, caller))
	}
	e.recordEvent(ev)
}

// maxAffordableTokens returns the largest whole-token count `budget` can buy
// on `creator`'s curve right now, INCLUDING the 10% trade fee, capped by the
// market's remaining cap headroom. 0 when even one token is out of reach.
// Binary search over the monotone TotalDue(n) — exact big.Int, no floats.
func (e *Engine) maxAffordableTokens(creator string, budget *big.Int) *big.Int {
	if budget == nil || budget.Sign() <= 0 {
		return big.NewInt(0)
	}
	supply := core.Supply(e.Store, creator)
	head := subBig(core.Cap(e.Store, creator), supply)
	if head.Sign() <= 0 {
		return big.NewInt(0)
	}
	totalDue := func(n *big.Int) *big.Int {
		cost := core.BuyCost(supply, n)
		return addBig(cost, bpsFloorBig(cost, core.TradeFeeBps))
	}
	lo := big.NewInt(0)
	hi := new(big.Int).Set(head)
	for lo.Cmp(hi) < 0 {
		mid := new(big.Int).Add(lo, hi)
		mid.Add(mid, big.NewInt(1))
		mid.Rsh(mid, 1) // ceil((lo+hi)/2) so the search terminates
		if cmpBig(totalDue(mid), budget) <= 0 {
			lo = mid
		} else {
			hi = new(big.Int).Sub(mid, big.NewInt(1))
		}
	}
	return lo
}

// doBuyBudget spends up to `budget` HBD on `creator`'s curve — the shape the
// old HBD-denominated doPrepay call sites want: "put roughly this much money
// in", translated to whole tokens at the live curve price.
func (e *Engine) doBuyBudget(caller, creator string, budget *big.Int) {
	n := e.maxAffordableTokens(creator, budget)
	if n.Sign() <= 0 {
		return
	}
	e.doBuy(caller, creator, n)
}

func (e *Engine) doTransfer(creator, from, to string, amount *big.Int) {
	if amount == nil || amount.Sign() <= 0 {
		return
	}

	ev := e.newEvent("transfer", from, creator)
	ev.Args["to"] = to
	ev.Args["amount"] = bigStr(amount)

	beforeFrom := core.BalanceOf(e.Store, creator, from)
	beforeTo := core.BalanceOf(e.Store, creator, to)

	e.coreCall("transfer", ev, func() error {
		return core.TransferCredits(e.Store, creator, from, to, e.Block, amount)
	})
	if ev.OK {
		e.addHolder(creator, to)
		ev.Deltas["balance:"+from] = deltaStr(beforeFrom, core.BalanceOf(e.Store, creator, from))
		ev.Deltas["balance:"+to] = deltaStr(beforeTo, core.BalanceOf(e.Store, creator, to))
	}
	e.recordEvent(ev)
}

// askIntent is where an asker DECIDES to open an ask: it reads the current
// face/rate to build a quote, sets maxCredits as that quote plus the
// asker's own slippage buffer (holderSlippageBps), pays the commission owed
// against THAT quote, and schedules the actual Ask call a short, random
// number of blocks later — sign-then-broadcast latency. Any face/rate
// movement in that gap (a price_mover's SetFace, an oracle RecordObs) is
// exactly the drift ask.go's own maxCredits guard exists to bound; see
// doAskExecute for what happens when the drift is big enough to trip it.
func (e *Engine) askIntent(asker, creator string) {
	actor := e.pop.Actors[asker]
	face := core.Face(e.Store, creator)
	if face.Sign() <= 0 {
		return
	}
	// RULING C: SettlementRate now REFUSES (returns an error) when no safe
	// rate exists — the PAR fallback is deleted. An asker whose quote is
	// refused simply doesn't sign; that is exactly what a real frontend
	// does with a reverted `quote` call.
	rate, err := core.SettlementRate(e.Store, creator, e.Block)
	if err != nil {
		return
	}
	// tokenLegOf, not the bare face: settlement prices only the token leg
	// (face - commission) in credits — see tokenLegOf's doc.
	creditsEstimate := ceilDivBig(tokenLegOf(face), rate)
	if creditsEstimate.Sign() <= 0 {
		return
	}

	bal := core.BalanceOf(e.Store, creator, asker)
	if cmpBig(bal, creditsEstimate) < 0 {
		return // not enough credits on hand for even the quoted amount; skip rather than force a doomed call
	}

	bufferBps := e.holderSlippageBps[asker]
	if bufferBps <= 0 {
		bufferBps = 500
	}
	buffer := new(big.Int).Div(new(big.Int).Mul(creditsEstimate, big.NewInt(bufferBps)), big.NewInt(10000))
	maxCredits := addBig(creditsEstimate, buffer)

	commission := bpsFloorBig(face, core.CommissionBps)
	if cmpBig(actor.HBD, commission) < 0 {
		return
	}

	deadline := core.MinAskDeadline + uint64(actor.RNG.Int63n(int64(4*core.MinAskDeadline))) // ~1-5 days
	contentHash := fmt.Sprintf("cid-%s-%d", asker, actor.RNG.Int63())

	delay := uint64(1 + actor.RNG.Intn(40)) // sign-to-broadcast latency
	execBlock := e.Block + delay

	e.schedule(execBlock, "ask-execute", func(eng *Engine) {
		eng.doAskExecute(asker, creator, maxCredits, commission, contentHash, deadline)
	})
}

func (e *Engine) doAskExecute(asker, creator string, maxCredits, commission *big.Int, contentHash string, deadlineBlocks uint64, offeringID uint64) {
	actor := e.pop.Actors[asker]
	if cmpBig(actor.HBD, commission) < 0 {
		return // wallet drained by something else in the gap; a real wallet would refuse to even sign
	}

	ev := e.newEvent("ask", asker, creator)
	ev.Args["maxCredits"] = bigStr(maxCredits)
	ev.Args["commissionHbdPaid"] = bigStr(commission)
	ev.Args["deadlineBlocks"] = fmt.Sprintf("%d", deadlineBlocks)
	ev.Args["contentHash"] = contentHash
	ev.Args["offeringID"] = fmt.Sprintf("%d", offeringID)
	e.captureDelinquent(ev, creator) // Ask IS gated by RequireInflowOpen (ask.go) — a purchase, must be refused while delinquent

	beforeBal := core.BalanceOf(e.Store, creator, asker)

	var res *core.AskResult
	e.coreCall("ask", ev, func() error {
		var err error
		res, err = core.Ask(e.Store, asker, creator, e.Block, maxCredits, commission, contentHash, deadlineBlocks, offeringID)
		return err
	})
	if ev.OK {
		actor.HBD = subBig(actor.HBD, commission)
		e.totalHbdIn = addBig(e.totalHbdIn, commission)

		deadline := e.Block + deadlineBlocks
		e.addEscrow(&EscrowShadow{
			Creator: creator, Seq: res.Seq, Asker: asker,
			Credits: res.CreditsSpent, CommissionHbd: res.CommissionHbd,
			Deadline: deadline, Status: escrowPending, OfferingID: offeringID,
		})

		ev.Args["seq"] = fmt.Sprintf("%d", res.Seq)
		ev.Args["rateUsed"] = res.RateUsed.String()
		ev.Args["creditsSpent"] = bigStr(res.CreditsSpent)
		ev.Deltas["wallet:"+asker] = "-" + bigStr(commission)
		ev.Deltas["balance:"+asker] = deltaStr(beforeBal, core.BalanceOf(e.Store, creator, asker))
		ev.Deltas["heldCommissionTotal"] = "+" + bigStr(res.CommissionHbd)

		e.scheduleAnswerAndReclaim(creator, res.Seq, deadline, deadlineBlocks)
	}
	e.recordEvent(ev)
}

// scheduleAnswerAndReclaim is the fork point for I6 (ordering-immune):
// exactly one of these two schedules can ever SUCCEED against the same
// escrow (core.Answer requires block<=deadline; core.Reclaim requires
// block>deadline+ReclaimGrace — disjoint by construction), but both may be
// SCHEDULED, and whichever loses the race simply finds the escrow already
// resolved and no-ops silently (attemptAnswer/attemptReclaim below).
func (e *Engine) scheduleAnswerAndReclaim(creator string, seq uint64, deadline, deadlineBlocks uint64) {
	askBlock := e.Block
	cs := e.creators[creator]
	creatorActor := e.pop.Actors[creator]

	abandonedAlready := cs.AbandonBlock != 0 && askBlock >= cs.AbandonBlock
	if !abandonedAlready {
		switch cs.Role {
		case RoleCreatorReliable, RoleCreatorPriceMover, RoleCreatorAbandoner:
			frac := 0.05 + creatorActor.RNG.Float64()*0.35 // answers early/mid-window
			at := askBlock + uint64(frac*float64(deadlineBlocks))
			e.schedule(at, "answer-attempt", func(eng *Engine) { eng.attemptAnswer(creator, seq) })
		case RoleCreatorFlaky:
			if creatorActor.RNG.Float64() < 0.25 {
				// misses entirely: nothing scheduled, asker reclaims later
			} else {
				frac := 0.70 + creatorActor.RNG.Float64()*0.40 // can exceed 1.0 -> legitimately too late
				at := askBlock + uint64(frac*float64(deadlineBlocks))
				e.schedule(at, "answer-attempt", func(eng *Engine) { eng.attemptAnswer(creator, seq) })
			}
		}
	}

	asker := e.escrows[escrowKey(creator, seq)].Asker
	askerActor := e.pop.Actors[asker]

	// Upgrade 2 (H1): with probability escrowAbandonProb the asker WALKS AWAY —
	// no self-reclaim is ever scheduled. Draw the abandon decision FIRST (an
	// unconditional RNG draw, so the stream stays deterministic regardless of
	// the branch taken) and only consume the notice-jitter draw when the asker
	// actually intends to come back. If the creator also never answers (an
	// abandoner/flaky), this leaves a PENDING escrow open past its window on a
	// market heading to FROZEN — the exact H1 stuck state — which only the now-
	// permissionless Reclaim (keeper or good-samaritan) can resolve.
	abandon := askerActor.RNG.Float64() < escrowAbandonProb
	if abandon {
		return
	}
	jitter := uint64(1 + askerActor.RNG.Intn(2000)) // asker notices/acts a while after the window technically opens
	reclaimAt := deadline + core.ReclaimGrace + jitter
	e.schedule(reclaimAt, "reclaim-check", func(eng *Engine) { eng.attemptReclaim(asker, creator, seq) })
}

func (e *Engine) attemptAnswer(creator string, seq uint64) {
	rec := e.escrows[escrowKey(creator, seq)]
	if rec == nil || rec.Status != escrowPending {
		return // already resolved -- nothing to attempt
	}
	answerHash := fmt.Sprintf("ans-%s-%d", creator, seq)
	e.doAnswer(creator, seq, answerHash)
}

func (e *Engine) attemptReclaim(asker, creator string, seq uint64) {
	rec := e.escrows[escrowKey(creator, seq)]
	if rec == nil || rec.Status != escrowPending {
		return
	}
	e.doReclaim(asker, asker, creator, seq) // self-reclaim: caller == payee == asker
}

func (e *Engine) doAnswer(creator string, seq uint64, answerHash string) {
	ev := e.newEvent("answer", creator, creator)
	ev.Args["seq"] = fmt.Sprintf("%d", seq)
	ev.Args["answerHash"] = answerHash
	e.captureDelinquent(ev, creator) // standing guardrail: Answer must never be blocked by delinquency (ask.go: "deliberately consults NO phase/subscription state")

	beforeBal := core.BalanceOf(e.Store, creator, creator)

	var res *core.AnswerResult
	e.coreCall("answer", ev, func() error {
		var err error
		res, err = core.Answer(e.Store, creator, creator, e.Block, seq, answerHash)
		return err
	})
	if ev.OK {
		rec := e.resolveEscrow(creator, seq, escrowAnswered)
		e.addHolder(creator, creator)
		if rec != nil {
			e.treasuryShadow = addBig(e.treasuryShadow, rec.CommissionHbd)
			ev.Deltas["treasuryShadow"] = "+" + bigStr(rec.CommissionHbd)
			ev.Deltas["heldCommissionTotal"] = "-" + bigStr(rec.CommissionHbd)
		}
		ev.Args["creditsToCreator"] = bigStr(res.CreditsToCreator)
		ev.Deltas["balance:"+creator] = deltaStr(beforeBal, core.BalanceOf(e.Store, creator, creator))
	}
	e.recordEvent(ev)
}

// doReclaim resolves an escrow via core.Reclaim. `caller` is who SUBMITS the
// reclaim (the asker themselves for a self-reclaim, or a third party — keeper
// or good-samaritan speculator — for the H1 permissionless push); `asker` is
// who gets PAID. core.Reclaim ALWAYS pays the escrow's own asker and never the
// caller, so the payout is credited to res.Asker (authoritative), and the
// event actor is the caller — a reclaim where actor != asker is exactly what
// the journey analysis counts as a permissionless, third-party reclaim.
func (e *Engine) doReclaim(caller, asker, creator string, seq uint64) {
	ev := e.newEvent("reclaim", caller, creator)
	ev.Args["seq"] = fmt.Sprintf("%d", seq)
	ev.Args["asker"] = asker
	if caller != asker {
		ev.Args["permissionless"] = "true" // a third party pushed this on the asker's behalf (H1)
	}
	e.captureDelinquent(ev, creator) // standing guardrail: Reclaim must never be blocked by delinquency (ask.go: "deliberately consults NO phase/subscription state")

	beforeBal := core.BalanceOf(e.Store, creator, asker)

	var res *core.ReclaimResult
	e.coreCall("reclaim", ev, func() error {
		var err error
		res, err = core.Reclaim(e.Store, caller, creator, e.Block, seq)
		return err
	})
	if ev.OK {
		e.resolveEscrow(creator, seq, escrowReclaimed)
		payee := res.Asker // core pays the escrow's own asker, never the caller
		if actor, ok := e.pop.Actors[payee]; ok && res.CommissionHbd != nil && res.CommissionHbd.Sign() > 0 {
			actor.HBD = addBig(actor.HBD, res.CommissionHbd)
		}
		if res.CommissionHbd != nil && res.CommissionHbd.Sign() > 0 {
			e.totalHbdOut = addBig(e.totalHbdOut, res.CommissionHbd)
		}
		ev.Args["creditsReturned"] = bigStr(res.CreditsReturned)
		ev.Args["commissionRefundedHbd"] = bigStr(res.CommissionHbd)
		ev.Deltas["balance:"+payee] = deltaStr(beforeBal, core.BalanceOf(e.Store, creator, payee))
		ev.Deltas["wallet:"+payee] = "+" + bigStr(res.CommissionHbd)
		ev.Deltas["heldCommissionTotal"] = "-" + bigStr(res.CommissionHbd)
	}
	e.recordEvent(ev)
}

// doDecline resolves an escrow via core.Decline (RULING E, ask.go) — the
// creator's free, honest "no": a full round-trip of credits AND the whole
// commission back to the asker, inside the SAME window an Answer would be
// legal in. Money-shape-identical to doReclaim above (same payee, same two
// legs returned in full), which is why the shadow-ledger bookkeeping below
// mirrors it line for line — the two calls differ only in WHO can trigger
// them (creator-only here, permissionless there) and in WHAT they mean for
// the delivery gate (Decline is explicitly neutral — neither a miss nor a
// delivery; Reclaim always records a miss). Both of those distinctions are
// core's business, not this wrapper's: core.Decline itself refuses a caller
// that is not the creator and never touches the miss/delivered counters.
func (e *Engine) doDecline(creator string, seq uint64) {
	rec := e.escrows[escrowKey(creator, seq)]
	asker := ""
	if rec != nil {
		asker = rec.Asker
	}

	ev := e.newEvent("decline", creator, creator)
	ev.Args["seq"] = fmt.Sprintf("%d", seq)
	e.captureDelinquent(ev, creator) // standing guardrail: Decline must never be blocked by delinquency (ask.go: "deliberately consults NO phase/subscription state")

	beforeBal := core.BalanceOf(e.Store, creator, asker)

	var res *core.ReclaimResult
	e.coreCall("decline", ev, func() error {
		var err error
		res, err = core.Decline(e.Store, creator, creator, e.Block, seq)
		return err
	})
	if ev.OK {
		e.resolveEscrow(creator, seq, escrowDeclined)
		payee := res.Asker // core pays the escrow's own asker — decline is creator-only to CALL, but the payout target is fixed by the escrow, same shape as Reclaim
		if actor, ok := e.pop.Actors[payee]; ok && res.CommissionHbd != nil && res.CommissionHbd.Sign() > 0 {
			actor.HBD = addBig(actor.HBD, res.CommissionHbd)
		}
		if res.CommissionHbd != nil && res.CommissionHbd.Sign() > 0 {
			e.totalHbdOut = addBig(e.totalHbdOut, res.CommissionHbd)
		}
		ev.Args["creditsReturned"] = bigStr(res.CreditsReturned)
		ev.Args["commissionRefundedHbd"] = bigStr(res.CommissionHbd)
		ev.Deltas["balance:"+payee] = deltaStr(beforeBal, core.BalanceOf(e.Store, creator, payee))
		ev.Deltas["wallet:"+payee] = "+" + bigStr(res.CommissionHbd)
		ev.Deltas["heldCommissionTotal"] = "-" + bigStr(res.CommissionHbd)
	}
	e.recordEvent(ev)
}

// doSell redeems deltaS of the caller's tokens along the curve (core.Sell) —
// the ACTIVE/OVERDUE-market exit rail that complements doRefund's wind-down
// rail below. Before this wrapper existed, this simulator could drive NO
// action at all against core.Sell: every holder's only modelled exit was
// doRefund, which core.Refund gates to inWindDown ONLY (FROZEN/CLOSED). A
// holder on a market that never winds down within the run (a
// RoleCreatorReliable creator who renews forever, say) therefore had no exit
// whatsoever in the SIMULATION, even though Sell is open and correct on the
// real contract the whole time — a pure simulator gap that the dead-end
// analysis (sim/analysis/journey.go) was, until this fix landed alongside it,
// misreading as a genuine stuck-value finding. See speculatorTick, which now
// picks this rail instead of a doomed doRefund while a market is still
// trading.
func (e *Engine) doSell(caller, creator string, deltaS *big.Int) {
	if deltaS == nil || deltaS.Sign() <= 0 {
		return
	}

	ev := e.newEvent("sell", caller, creator)
	ev.Args["tokens"] = bigStr(deltaS)
	e.captureDelinquent(ev, creator) // standing guardrail: Sell must never be blocked by delinquency (sell.go reads inWindDown only, never RequireInflowOpen)

	beforeReserve := core.Reserve(e.Store, creator)
	beforeSupply := core.Supply(e.Store, creator)
	beforeBal := core.BalanceOf(e.Store, creator, caller)

	var res *core.SellResult
	e.coreCall("sell", ev, func() error {
		var err error
		res, err = core.Sell(e.Store, caller, creator, e.Block, deltaS)
		return err
	})
	if ev.OK {
		actor := e.pop.Actors[caller]
		actor.HBD = addBig(actor.HBD, res.Net)
		e.totalHbdOut = addBig(e.totalHbdOut, res.Net)

		// Two separate HBD legs land in kTreasury on a Sell, and both must be
		// mirrored into treasuryShadow (this simulator's only window onto
		// kTreasury — see engine.go's field doc): the trade fee's platform
		// half (accrueTradeFee, tradefee.go — identical to doBuy's own
		// FeePlatform handling above) and the exit tax's platform half
		// (accrueExitTax's 50/50 split, exittax.go — identical treatment to
		// doRefund/doRefundHolder below). Sell's result exposes Tax directly
		// (unlike Refund's, which returns only the net), so no reconstruction
		// is needed here.
		creatorTaxHalf := new(big.Int).Div(res.Tax, big.NewInt(2)) // accrueExitTax's own split, mirrored exactly
		platformTaxHalf := subBig(res.Tax, creatorTaxHalf)
		e.treasuryShadow = addBig(e.treasuryShadow, platformTaxHalf)
		e.treasuryShadow = addBig(e.treasuryShadow, res.FeePlatform)

		ev.Args["sold"] = bigStr(res.Sold)
		ev.Args["gross"] = bigStr(res.Gross)
		ev.Args["tax"] = bigStr(res.Tax)
		ev.Args["fee"] = bigStr(res.Fee)
		ev.Args["net"] = bigStr(res.Net)
		ev.Deltas["wallet:"+caller] = "+" + bigStr(res.Net)
		ev.Deltas["treasuryShadow"] = "+" + bigStr(addBig(platformTaxHalf, res.FeePlatform))
		ev.Deltas["reserve"] = deltaStr(beforeReserve, core.Reserve(e.Store, creator))
		ev.Deltas["supply"] = deltaStr(beforeSupply, core.Supply(e.Store, creator))
		ev.Deltas["balance:"+caller] = deltaStr(beforeBal, core.BalanceOf(e.Store, creator, caller))
	}
	e.recordEvent(ev)
}

func (e *Engine) doRefund(caller, creator string, credits *big.Int) {
	if credits == nil || credits.Sign() <= 0 {
		return
	}

	ev := e.newEvent("refund", caller, creator)
	ev.Args["credits"] = bigStr(credits)
	e.captureDelinquent(ev, creator) // standing guardrail: Refund must never be blocked by delinquency (refund.go gates on inWindDown only)

	beforeReserve := core.Reserve(e.Store, creator)
	beforeSupply := core.Supply(e.Store, creator)
	beforeBal := core.BalanceOf(e.Store, creator, caller)

	var payout *big.Int
	e.coreCall("refund", ev, func() error {
		var err error
		payout, err = core.Refund(e.Store, caller, creator, e.Block, credits)
		return err
	})
	if ev.OK {
		actor := e.pop.Actors[caller]
		actor.HBD = addBig(actor.HBD, payout)
		e.totalHbdOut = addBig(e.totalHbdOut, payout)

		// K2 WIND-DOWN EXIT TAX, 50/50 SPLIT (exittax.go's accrueExitTax):
		// core.Refund returns only the NET (gross − tax) it pays the caller,
		// with no exported way to read the tax it carved back out — so this
		// simulator recovers it: gross = floor(beforeReserve*credits/
		// beforeSupply) is refund.go's own documented refundPayout formula,
		// evaluated on the (reserve, supply) pair read BEFORE the call (the
		// same pair core.Refund itself reads), and tax = gross − payout is
		// exactly what accrueExitTax then split. The platform half of that
		// tax lands in kTreasury — this simulator's ONLY window onto
		// kTreasury is treasuryShadow (core exports no live treasury getter,
		// see engine.go's field doc), so every credit to it must be mirrored
		// here or the HBD-conservation identity silently drifts by exactly
		// the missed amount, which is exactly what was happening: a taxed
		// refund halted checkInvariants short by the platform half. The
		// creator half lands in kFeeBal, which checkInvariants already reads
		// LIVE via core.FeeBalanceOf (feePotsTotal) — so it must NOT also be
		// added to any shadow here, or it would be double-counted.
		gross := mulDivFloorBig(beforeReserve, credits, beforeSupply)
		tax := subBig(gross, payout)
		if tax.Sign() > 0 {
			creatorHalf := new(big.Int).Div(tax, big.NewInt(2)) // accrueExitTax's own split, mirrored exactly
			platformHalf := subBig(tax, creatorHalf)
			e.treasuryShadow = addBig(e.treasuryShadow, platformHalf)
			ev.Args["exitTax"] = bigStr(tax)
			ev.Deltas["treasuryShadow"] = "+" + bigStr(platformHalf)
		}

		ev.Args["payout"] = bigStr(payout)
		ev.Deltas["wallet:"+caller] = "+" + bigStr(payout)
		ev.Deltas["reserve"] = deltaStr(beforeReserve, core.Reserve(e.Store, creator))
		ev.Deltas["supply"] = deltaStr(beforeSupply, core.Supply(e.Store, creator))
		ev.Deltas["balance:"+caller] = deltaStr(beforeBal, core.BalanceOf(e.Store, creator, caller))
	}
	e.recordEvent(ev)
}

func (e *Engine) doRefundHolder(pusher, creator, holder string) {
	ev := e.newEvent("refundHolder", pusher, creator)
	ev.Args["holder"] = holder
	e.captureDelinquent(ev, creator) // standing guardrail: RefundHolder must never be blocked by delinquency (refund.go gates on inWindDown only)

	beforeReserve := core.Reserve(e.Store, creator)
	beforeSupply := core.Supply(e.Store, creator)
	beforeBal := core.BalanceOf(e.Store, creator, holder)

	var payout *big.Int
	e.coreCall("refundHolder", ev, func() error {
		var err error
		payout, err = core.RefundHolder(e.Store, pusher, creator, holder, e.Block)
		return err
	})
	if ev.OK {
		if holderActor, ok := e.pop.Actors[holder]; ok {
			holderActor.HBD = addBig(holderActor.HBD, payout)
		}
		e.totalHbdOut = addBig(e.totalHbdOut, payout)

		// Same K2 tax recovery as doRefund above: RefundHolder pushes the
		// pushed HOLDER's entire balance, so beforeBal (read above, pre-call)
		// IS the `credits` refundPayout was evaluated against — gross =
		// floor(beforeReserve*beforeBal/beforeSupply), tax = gross − payout,
		// platform half mirrored into treasuryShadow (creator half already
		// covered live via feePotsTotal — see doRefund's comment for the
		// full reasoning, identical here).
		gross := mulDivFloorBig(beforeReserve, beforeBal, beforeSupply)
		tax := subBig(gross, payout)
		if tax.Sign() > 0 {
			creatorHalf := new(big.Int).Div(tax, big.NewInt(2))
			platformHalf := subBig(tax, creatorHalf)
			e.treasuryShadow = addBig(e.treasuryShadow, platformHalf)
			ev.Args["exitTax"] = bigStr(tax)
			ev.Deltas["treasuryShadow"] = "+" + bigStr(platformHalf)
		}

		ev.Args["payout"] = bigStr(payout)
		ev.Deltas["wallet:"+holder] = "+" + bigStr(payout)
		ev.Deltas["reserve"] = deltaStr(beforeReserve, core.Reserve(e.Store, creator))
		ev.Deltas["supply"] = deltaStr(beforeSupply, core.Supply(e.Store, creator))
		ev.Deltas["balance:"+holder] = deltaStr(beforeBal, core.BalanceOf(e.Store, creator, holder))
	}
	e.recordEvent(ev)
}

// doCloseIfDrained: core.CloseIfDrained has no error return (a plain bool),
// so it bypasses e.coreCall — there is no "rejected call" state to verify
// against a store diff, only "did or didn't flip to CLOSED."
func (e *Engine) doCloseIfDrained(creator string) {
	ev := e.newEvent("closeIfDrained", e.pop.KeeperName, creator)
	beforePhase := core.Phase(e.Store, creator, e.Block)

	closed := core.CloseIfDrained(e.Store, creator, e.Block)

	ev.OK = true
	ev.Args["closed"] = boolStr(closed)
	ev.Deltas["phase"] = beforePhase + " -> " + core.Phase(e.Store, creator, e.Block)
	e.recordEvent(ev)
}

func (e *Engine) doRecordObs(creator, oracleName string, rate *big.Int) {
	ev := e.newEvent("recordObs", oracleName, creator)
	ev.Args["rate"] = bigStr(rate)
	core.RecordObs(e.Store, creator, e.Block, rate) // no error return by contract (API.md)
	ev.OK = true
	e.recordEvent(ev)
}

// doWithdrawTreasury drives the C2 fix (Upgrade 1): the platform owner pulls
// the accrued protocol revenue out of kTreasury via core.WithdrawTreasury.
// Mirrors contract/main.go's `withdrawTreasury` wrapper — state is mutated
// FIRST (core.WithdrawTreasury debits kTreasury), THEN the owner is "paid"
// (here: credited to this simulator's owner-wallet accumulator), the same
// CEI ordering every HBD-out path in this codebase uses. It withdraws the
// ENTIRE accrued treasury (treasuryShadow, which tracks kTreasury exactly, so
// core's own (0, balance] bound is never tripped), so every successful call
// drives the treasury to exactly 0 — the drainability the ledger asserts.
//
// creator is "" because this is a GLOBAL action, not a per-market one — it
// touches the bare kTreasury key alone (I4: no path to any market reserve).
func (e *Engine) doWithdrawTreasury(owner string) {
	amount := new(big.Int).Set(e.treasuryShadow)
	if amount.Sign() <= 0 {
		return // nothing has accrued since the last sweep; a real owner would not submit an empty withdrawal
	}

	ev := e.newEvent("withdrawTreasury", owner, "")
	ev.Args["amount"] = bigStr(amount)

	beforeShadow := new(big.Int).Set(e.treasuryShadow)
	var paid *big.Int
	e.coreCall("withdrawTreasury", ev, func() error {
		var err error
		paid, err = core.WithdrawTreasury(e.Store, owner, amount)
		return err
	})
	if ev.OK {
		// HBD leaves the contract to the owner: the shadow treasury drops and
		// totalHbdOut rises by the same amount, so the engine's HBD-conservation
		// identity (checked after this very event) is preserved exactly.
		e.treasuryShadow = subBig(e.treasuryShadow, paid)
		e.totalHbdOut = addBig(e.totalHbdOut, paid)
		if ownerActor, ok := e.pop.Actors[owner]; ok {
			ownerActor.HBD = addBig(ownerActor.HBD, paid) // accumulator of what the owner has withdrawn (RoleOwner doc)
		}
		ev.Args["withdrawn"] = bigStr(paid)
		ev.Args["treasuryAfter"] = bigStr(e.treasuryShadow)
		ev.Deltas["treasuryShadow"] = deltaStr(beforeShadow, e.treasuryShadow)
		ev.Deltas["wallet:"+owner] = "+" + bigStr(paid)
	}
	e.recordEvent(ev)
}

// doRetire drives core.Retire — the creator's own, IRREVERSIBLE, once-only
// wind-down notice (RULING D/K3, market.go). Moves no HBD (Retire touches
// only kRetiredAt; paidUntil is left untouched, the reserve is left
// untouched) — the event carries the derived "windingDown" transition purely
// for trace readability, not because anything here is money-critical.
func (e *Engine) doRetire(creator string) {
	ev := e.newEvent("retire", creator, creator)
	e.captureDelinquent(ev, creator) // standing guardrail: Retire is gated by requireOpenCreatorMarket only, never delivery standing

	beforeWindingDown := e.creatorWindingDown(creator)
	e.coreCall("retire", ev, func() error {
		return core.Retire(e.Store, creator, creator, e.Block)
	})
	if ev.OK {
		ev.Deltas["windingDown"] = boolStr(beforeWindingDown) + " -> " + boolStr(e.creatorWindingDown(creator))
	}
	e.recordEvent(ev)
}

// doClaimTradeFees drives core.ClaimTradeFees (tradefee.go, RULING F8's pull
// half): pays out the caller's ENTIRE accrued trade-fee balance (kFeeBal) —
// the creator half of every 10% trade fee (Buy/Sell) AND every K2/K-split
// exit tax (Sell/Refund/RefundHolder), all of which accrue to the SAME pot.
// Only ever called with caller == a creator claiming their OWN pot (kFeeBal
// is never credited to anyone else in this codebase — see tradefee.go/
// exittax.go, both keyed on `creator`), which is also why checkInvariants'
// live feePotsTotal sum (engine.go) only ever iterates creatorNames: this
// wrapper's payout is exactly the amount that sum will drop by, so no
// shadow-ledger mirror is needed here — only totalHbdOut, mirroring
// doWithdrawTreasury's identical "live pot, no shadow" shape.
func (e *Engine) doClaimTradeFees(caller string) {
	ev := e.newEvent("claimTradeFees", caller, caller)
	e.captureDelinquent(ev, caller) // standing guardrail: ClaimTradeFees "consults NOTHING" (tradefee.go) — must never be blocked by delinquency

	beforeFee := core.FeeBalanceOf(e.Store, caller)

	var paid *big.Int
	e.coreCall("claimTradeFees", ev, func() error {
		var err error
		paid, err = core.ClaimTradeFees(e.Store, caller)
		return err
	})
	if ev.OK {
		if paid.Sign() > 0 {
			if actor, ok := e.pop.Actors[caller]; ok {
				actor.HBD = addBig(actor.HBD, paid)
			}
			e.totalHbdOut = addBig(e.totalHbdOut, paid)
		}
		ev.Args["claimed"] = bigStr(paid)
		ev.Deltas["feeBal:"+caller] = deltaStr(beforeFee, core.FeeBalanceOf(e.Store, caller))
		ev.Deltas["wallet:"+caller] = "+" + bigStr(paid)
	}
	e.recordEvent(ev)
}

// ---- the creator shop (offerings.go): CreateOffering / SetOfferingPrice /
// SetOfferingTitle / DeleteOffering. None of the four move HBD — posting,
// repricing, renaming or withdrawing a listing is pure config, gated by
// requireShopEditable/requireOpenCreatorMarket (market-exists, not CLOSED,
// and — for the first three — not RETIRED), never by delivery standing or
// the global pause. Money only ever moves later, when a buyer Asks against a
// live offering id (doAskExecute, above, already handles that uniformly via
// core.OfferingPrice(id) — id 0 mirrors the legacy face price exactly).

func (e *Engine) doCreateOffering(creator, title string, price int64) {
	ev := e.newEvent("createOffering", creator, creator)
	ev.Args["title"] = title
	ev.Args["price"] = fmt.Sprintf("%d", price)
	e.captureDelinquent(ev, creator) // standing guardrail: shop-config writes are gated by requireShopEditable only, never delivery standing

	var id uint64
	e.coreCall("createOffering", ev, func() error {
		var err error
		id, err = core.CreateOffering(e.Store, creator, creator, e.Block, title, price)
		return err
	})
	if ev.OK {
		ev.Args["id"] = fmt.Sprintf("%d", id)
	}
	e.recordEvent(ev)
}

func (e *Engine) doSetOfferingPrice(creator string, id uint64, newPrice int64) {
	ev := e.newEvent("setOfferingPrice", creator, creator)
	ev.Args["id"] = fmt.Sprintf("%d", id)
	ev.Args["newPrice"] = fmt.Sprintf("%d", newPrice)
	e.captureDelinquent(ev, creator)
	before := core.OfferingPrice(e.Store, creator, id)

	e.coreCall("setOfferingPrice", ev, func() error {
		return core.SetOfferingPrice(e.Store, creator, creator, e.Block, id, newPrice)
	})
	if ev.OK {
		ev.Deltas["offerPrice:"+fmt.Sprintf("%d", id)] = deltaStr(before, core.OfferingPrice(e.Store, creator, id))
	}
	e.recordEvent(ev)
}

func (e *Engine) doSetOfferingTitle(creator string, id uint64, newTitle string) {
	ev := e.newEvent("setOfferingTitle", creator, creator)
	ev.Args["id"] = fmt.Sprintf("%d", id)
	ev.Args["newTitle"] = newTitle
	e.captureDelinquent(ev, creator)
	beforeTitle := core.OfferingTitle(e.Store, creator, id)
	beforePrice := core.OfferingPrice(e.Store, creator, id)

	e.coreCall("setOfferingTitle", ev, func() error {
		return core.SetOfferingTitle(e.Store, creator, creator, id, newTitle)
	})
	if ev.OK {
		ev.Deltas["offerTitle:"+fmt.Sprintf("%d", id)] = beforeTitle + " -> " + core.OfferingTitle(e.Store, creator, id)
		// SetOfferingTitle never changes THIS id's own price (offerings.go:
		// "renaming a service is not a repricing") — recorded as a delta only
		// when it moved, so a clean no-op rename doesn't spuriously suggest a
		// price change happened.
		afterPrice := core.OfferingPrice(e.Store, creator, id)
		if cmpBig(beforePrice, afterPrice) != 0 {
			ev.Deltas["offerPrice:"+fmt.Sprintf("%d", id)] = deltaStr(beforePrice, afterPrice)
		}
	}
	e.recordEvent(ev)
}

func (e *Engine) doDeleteOffering(creator string, id uint64) {
	ev := e.newEvent("deleteOffering", creator, creator)
	ev.Args["id"] = fmt.Sprintf("%d", id)
	e.captureDelinquent(ev, creator)

	e.coreCall("deleteOffering", ev, func() error {
		return core.DeleteOffering(e.Store, creator, creator, id)
	})
	e.recordEvent(ev)
}

// ===========================================================================
// Population lifecycle wiring — called once from engine.go's Run via
// scheduleInitialEvents, then each role's own tick function reschedules
// itself for as long as the run continues.
// ===========================================================================

func (e *Engine) scheduleInitialEvents() {
	// Creators register at staggered points across day 0.
	for _, name := range e.creatorNames {
		nameCopy := name
		actor := e.pop.Actors[nameCopy]
		at := genesisBlock + uint64(actor.RNG.Int63n(int64(core.BlocksPerDay)))
		e.schedule(at, "register", func(eng *Engine) {
			eng.doRegister(nameCopy)
			if eng.haltErr != nil {
				return
			}
			eng.scheduleCreatorTick(nameCopy, eng.Block+creatorTickCadence)
		})

		if oracleName, ok := e.pop.OracleForCreator[nameCopy]; ok {
			oracleNameCopy := oracleName
			oActor := e.pop.Actors[oracleNameCopy]
			oracleStart := at + uint64(1+oActor.RNG.Intn(2000))
			e.schedule(oracleStart, "oracle-start", func(eng *Engine) {
				eng.startOracle(nameCopy, oracleNameCopy)
			})
		}
	}

	// Holder-actors start on day 1, after creators have had a full day to
	// register.
	for _, name := range e.pop.HolderNames {
		nameCopy := name
		actor := e.pop.Actors[nameCopy]
		startAt := genesisBlock + core.BlocksPerDay + uint64(actor.RNG.Int63n(int64(core.BlocksPerDay)))
		switch actor.Role {
		case RoleFan:
			e.schedule(startAt, "fan-start", func(eng *Engine) { eng.scheduleFanTickAt(nameCopy, eng.Block) })
		case RoleOneShot:
			e.schedule(startAt, "oneshot-start", func(eng *Engine) { eng.oneShotSequence(nameCopy) })
		case RoleSpeculator:
			e.schedule(startAt, "speculator-start", func(eng *Engine) { eng.scheduleSpeculatorTickAt(nameCopy, eng.Block) })
		case RoleTrader:
			e.schedule(startAt, "trader-start", func(eng *Engine) { eng.startTrader(nameCopy, eng.Block) })
		}
	}

	// Keeper starts sweeping from day 1 onward — UNLESS this run models an
	// absent keeper (Upgrade 3), in which case no keeper op ever fires and the
	// fund fail-safes must hold anyway: holders self-refund, and abandoned
	// escrows are still resolved by the good-samaritan sweep (speculatorTick).
	if e.keeperProfile != KeeperAbsent {
		keeperName := e.pop.KeeperName
		keeperActor := e.pop.Actors[keeperName]
		keeperStart := genesisBlock + core.BlocksPerDay + uint64(keeperActor.RNG.Int63n(int64(core.BlocksPerDay)))
		e.schedule(keeperStart, "keeper-start", func(eng *Engine) { eng.scheduleKeeperTickAt(keeperStart) })
	}

	// Owner sweeps the accrued treasury on a ~3-day cadence (Upgrade 1 / C2).
	// Runs regardless of keeper profile — the treasury exit is the owner's,
	// not the keeper's. Each sweep withdraws the ENTIRE accrued balance, so
	// every successful withdrawal drives the treasury to exactly 0, which is
	// what lets the ledger analysis PROVE drainability ("reaches 0"), not just
	// conservation.
	ownerName := e.pop.OwnerName
	ownerActor := e.pop.Actors[ownerName]
	ownerStart := genesisBlock + core.BlocksPerDay + uint64(ownerActor.RNG.Int63n(int64(core.BlocksPerDay)))
	e.schedule(ownerStart, "owner-start", func(eng *Engine) { eng.scheduleOwnerTickAt(ownerStart) })
}

// ---- creator ----

func (e *Engine) scheduleCreatorTick(name string, at uint64) {
	e.schedule(at, "creator-tick", func(eng *Engine) { eng.creatorTick(name) })
}

func (e *Engine) creatorTick(name string) {
	cs := e.creators[name]
	actor := e.pop.Actors[name]

	if cs.AbandonBlock != 0 && e.Block >= cs.AbandonBlock {
		return // dark: no further ticks scheduled; the market's own lazy clock and the keeper take over from here
	}

	// A market can also reach CLOSED WITHOUT a scripted AbandonBlock: a
	// "flaky" creator (no AbandonBlock at all) can simply lose the dice roll
	// on every single renewal attempt across a whole 5-day grace window and
	// wind up frozen, then closed by the keeper, by pure bad luck — observed
	// for real in a seed=1/days=90 run (creator-flaky-2). core correctly and
	// harmlessly rejects every further Renew against a CLOSED market
	// (ErrState, SPEC §1.7.5: wind-down is terminal), but a real creator
	// would stop trying rather than retry forever — so this simulator does
	// too, rather than spinning a dead tick loop of guaranteed-failed Renew
	// calls for the rest of the run.
	if core.Phase(e.Store, name, e.Block) == core.StateClosed {
		return
	}

	paidUntil := core.PaidUntil(e.Store, name)
	switch cs.Role {
	case RoleCreatorReliable, RoleCreatorPriceMover, RoleCreatorAbandoner:
		if e.Block+3*core.BlocksPerDay >= paidUntil {
			periods := uint64(1 + actor.RNG.Intn(2))
			e.doRenew(name, name, periods)
			if e.haltErr != nil {
				return
			}
		}
	case RoleCreatorFlaky:
		if e.Block >= paidUntil && actor.RNG.Float64() < 0.20 {
			e.doRenew(name, name, 1)
			if e.haltErr != nil {
				return
			}
		}
	}

	if cs.Role == RoleCreatorPriceMover {
		if actor.RNG.Float64() < 0.50 {
			e.priceMoverAdjustFace(name)
			if e.haltErr != nil {
				return
			}
		}
		if actor.RNG.Float64() < 0.10 {
			e.maybeRaiseCap(name, 1.5, 3.0)
			if e.haltErr != nil {
				return
			}
		}
	} else if cs.Role == RoleCreatorReliable {
		if actor.RNG.Float64() < 0.05 {
			e.maybeRaiseCap(name, 1.2, 2.0)
			if e.haltErr != nil {
				return
			}
		}
	}

	next := e.Block + nextInterval(actor.RNG, creatorTickCadence, e.Block)
	if next <= e.endBlock {
		e.scheduleCreatorTick(name, next)
	}
}

// priceMoverAdjustFace picks a candidate new face within a wide random
// factor of the CURRENT live face — deliberately wide enough to sometimes
// land outside SetFace's 2x/7d band, so this simulator organically exercises
// that guard's rejection path, not just its happy path.
func (e *Engine) priceMoverAdjustFace(creator string) {
	actor := e.pop.Actors[creator]
	face := core.Face(e.Store, creator)
	if face.Sign() <= 0 {
		return
	}
	factor := 0.60 + actor.RNG.Float64()*1.05 // [0.60, 1.65)
	newFace := int64(float64(face.Int64()) * factor)
	if newFace < core.MinFace {
		newFace = core.MinFace
	}
	if newFace > core.MaxFace {
		newFace = core.MaxFace
	}
	e.doSetFace(creator, newFace)
}

func (e *Engine) maybeRaiseCap(creator string, loFactor, hiFactor float64) {
	supply := core.Supply(e.Store, creator)
	cap := core.Cap(e.Store, creator)
	if cap.Sign() <= 0 {
		return
	}
	ratio := new(big.Float).Quo(new(big.Float).SetInt(supply), new(big.Float).SetInt(cap))
	r, _ := ratio.Float64()
	if r < 0.70 {
		return
	}
	actor := e.pop.Actors[creator]
	factor := loFactor + actor.RNG.Float64()*(hiFactor-loFactor)
	newCap := int64(float64(cap.Int64()) * factor)
	if newCap > core.MaxCap {
		newCap = core.MaxCap
	}
	if newCap <= cap.Int64() {
		return
	}
	e.doSetCap(creator, newCap)
}

// ---- fan ----

func (e *Engine) scheduleFanTickAt(name string, at uint64) {
	e.schedule(at, "fan-tick", func(eng *Engine) { eng.fanTick(name) })
}

func (e *Engine) fanTick(name string) {
	actor := e.pop.Actors[name]
	favorites := e.holderFavorites[name]
	if len(favorites) == 0 {
		return
	}
	target := favorites[actor.RNG.Intn(len(favorites))]

	roll := actor.RNG.Float64()
	switch {
	case roll < 0.35: // top up
		amount := big.NewInt(randRangeInt64(actor.RNG, 2_000, 20_000))
		if cmpBig(actor.HBD, amount) < 0 {
			amount = new(big.Int).Set(actor.HBD)
		}
		e.doBuyBudget(name, target, amount)
	case roll < 0.75: // ask (top up first if short)
		e.ensureCreditsForAsk(name, target)
		if e.haltErr != nil {
			return
		}
		e.askIntent(name, target)
	case roll < 0.80: // occasionally keep a favourite creator alive
		paidUntil := core.PaidUntil(e.Store, target)
		if e.Block+2*core.BlocksPerDay >= paidUntil {
			e.doRenew(name, target, 1)
		}
	case roll < 0.85: // notices the market froze; redeems what they can
		if core.Phase(e.Store, target, e.Block) == core.StateFrozen {
			bal := core.BalanceOf(e.Store, target, name)
			if bal.Sign() > 0 {
				e.doRefund(name, target, bal)
			}
		}
	}
	if e.haltErr != nil {
		return
	}

	next := e.Block + nextInterval(actor.RNG, fanTickCadence, e.Block)
	if next <= e.endBlock {
		e.scheduleFanTickAt(name, next)
	}
}

// ensureCreditsForAsk tops up (prepays) just enough for target's current
// quoted ask cost, plus a small buffer, clamped to what the wallet can
// afford — never attempting a prepay the actor cannot pay for.
func (e *Engine) ensureCreditsForAsk(name, creator string) {
	face := core.Face(e.Store, creator)
	if face.Sign() <= 0 {
		return
	}
	// RULING C: refusal (error) instead of a PAR fallback — skip the top-up
	// when the market cannot price a service right now.
	rate, err := core.SettlementRate(e.Store, creator, e.Block)
	if err != nil {
		return
	}
	// tokenLegOf, not the bare face — see tokenLegOf's doc.
	need := ceilDivBig(tokenLegOf(face), rate)
	bal := core.BalanceOf(e.Store, creator, name)
	if cmpBig(bal, need) >= 0 {
		return
	}
	// `short` is a TOKEN count (credits). Under the curve (RULING A: the PAR
	// mint is gone) the top-up is a Buy of that many tokens plus a 20%
	// buffer, clamped to what the wallet can actually afford at the live
	// curve price INCLUDING the trade fee.
	short := subBig(need, bal)
	buffer := new(big.Int).Div(short, big.NewInt(5))
	n := addBig(short, buffer)

	actor := e.pop.Actors[name]
	if aff := e.maxAffordableTokens(creator, actor.HBD); cmpBig(n, aff) > 0 {
		n = aff
	}
	if n.Sign() <= 0 {
		return
	}
	e.doBuy(name, creator, n)
}

// ---- one-shot asker ----

// oneShotSequence is this role's ENTIRE lifetime: prepay exactly what the
// current quote says one ask costs (clamped to their wallet — if the wallet
// is short, they prepay whatever they have, which will very likely then
// fail Ask's own balance/maxCredits guard: a genuine, honest "couldn't
// quite afford it" outcome this simulator lets play out rather than
// silently avoiding), then ask once. No recurring tick.
func (e *Engine) oneShotSequence(name string) {
	actor := e.pop.Actors[name]
	favorites := e.holderFavorites[name]
	if len(favorites) == 0 {
		return
	}
	target := favorites[0]

	face := core.Face(e.Store, target)
	if face.Sign() <= 0 {
		return
	}
	// RULING C: refusal (error) instead of a PAR fallback — a one-shot asker
	// whose target market cannot price simply never asks.
	rate, err := core.SettlementRate(e.Store, target, e.Block)
	if err != nil {
		return
	}
	// `need` is a TOKEN count. Buy exactly that many (clamped to what the
	// wallet affords at the live curve price — if short, they buy what they
	// can, which will very likely then fail Ask's own balance guard: the
	// same honest "couldn't quite afford it" outcome as before, on the
	// curve). tokenLegOf, not the bare face — see tokenLegOf's doc.
	need := ceilDivBig(tokenLegOf(face), rate)
	if aff := e.maxAffordableTokens(target, actor.HBD); cmpBig(need, aff) > 0 {
		need = aff
	}
	if need.Sign() <= 0 {
		return
	}
	e.doBuy(name, target, need)
	if e.haltErr != nil {
		return
	}

	delay := uint64(1 + actor.RNG.Intn(3*int(core.BlocksPerDay)))
	e.schedule(e.Block+delay, "oneshot-ask", func(eng *Engine) {
		eng.askIntent(name, target)
	})
}

// ---- speculator ----

func (e *Engine) scheduleSpeculatorTickAt(name string, at uint64) {
	e.schedule(at, "speculator-tick", func(eng *Engine) { eng.speculatorTick(name) })
}

func (e *Engine) speculatorTick(name string) {
	actor := e.pop.Actors[name]

	// Good-samaritan sweep (Upgrade 2 / H1, and the Upgrade 3 keeper-absent
	// fail-safe): a speculator scans many markets anyway, so on each tick it
	// clears a few abandoned, past-window PENDING escrows via the permissionless
	// Reclaim, paying the rightful asker (never itself). This runs whether or
	// not a keeper exists, which is exactly what proves an abandoned escrow is
	// resolvable by ANY third party — not only the keeper. Consumes no RNG, so
	// the speculator's own decision stream below is unchanged.
	e.resolveStalePendingEscrows(name, 3)
	if e.haltErr != nil {
		return
	}

	if len(e.creatorNames) == 0 {
		return
	}
	target := e.creatorNames[actor.RNG.Intn(len(e.creatorNames))]

	roll := actor.RNG.Float64()
	switch {
	case roll < 0.45: // diversify: buy into a random market
		amount := big.NewInt(randRangeInt64(actor.RNG, 3_000, 40_000))
		if cmpBig(actor.HBD, amount) < 0 {
			amount = new(big.Int).Set(actor.HBD)
		}
		e.doBuyBudget(name, target, amount)
	case roll < 0.70: // transfer a chunk of a held position
		bal := core.BalanceOf(e.Store, target, name)
		if bal.Sign() > 0 {
			to := e.pickTransferTarget(name, actor.RNG)
			if to != "" {
				amount := new(big.Int).Div(bal, big.NewInt(int64(1+actor.RNG.Intn(4)))) // 25%-100%
				if amount.Sign() > 0 {
					e.doTransfer(target, name, to, amount)
				}
			}
		}
	default: // opportunistic redeem -- Sell while the market trades (the ONLY
		// rail core opens in that state — core.Refund refuses outside wind-
		// down, see refund.go's/sell.go's rail-switch docs), Refund at
		// wind-down; more eager once the market is FROZEN/CLOSED, since a
		// wind-down position is the one actually worth cashing all the way
		// out.
		bal := core.BalanceOf(e.Store, target, name)
		if bal.Sign() > 0 {
			phase := core.Phase(e.Store, target, e.Block)
			windingDown := phase == core.StateFrozen || phase == core.StateClosed
			frac := int64(4)
			if windingDown {
				frac = 1
			}
			amount := new(big.Int).Div(bal, big.NewInt(frac))
			if amount.Sign() > 0 {
				if windingDown {
					e.doRefund(name, target, amount)
				} else {
					e.doSell(name, target, amount)
				}
			}
		}
	}
	if e.haltErr != nil {
		return
	}

	next := e.Block + nextInterval(actor.RNG, speculatorTickCadence, e.Block)
	if next <= e.endBlock {
		e.scheduleSpeculatorTickAt(name, next)
	}
}

// pickTransferTarget picks any other holder-actor as a transfer recipient,
// uniformly, deterministically from rng.
func (e *Engine) pickTransferTarget(from string, rng *rand.Rand) string {
	candidates := make([]string, 0, len(e.pop.HolderNames))
	for _, n := range e.pop.HolderNames {
		if n != from {
			candidates = append(candidates, n)
		}
	}
	if len(candidates) == 0 {
		return ""
	}
	return candidates[rng.Intn(len(candidates))]
}

// ---- trader ----

func (e *Engine) startTrader(name string, at uint64) {
	e.traderInitialStake(name)
	if e.haltErr != nil {
		return
	}
	e.scheduleTraderTickAt(name, at)
}

func (e *Engine) traderInitialStake(name string) {
	actor := e.pop.Actors[name]
	for _, creator := range e.holderFavorites[name] {
		if actor.HBD.Sign() <= 0 {
			return
		}
		amount := big.NewInt(randRangeInt64(actor.RNG, 1_000, 15_000))
		if cmpBig(actor.HBD, amount) < 0 {
			amount = new(big.Int).Set(actor.HBD)
		}
		e.doBuyBudget(name, creator, amount)
		if e.haltErr != nil {
			return
		}
	}
}

func (e *Engine) scheduleTraderTickAt(name string, at uint64) {
	e.schedule(at, "trader-tick", func(eng *Engine) { eng.traderTick(name) })
}

func (e *Engine) traderTick(name string) {
	actor := e.pop.Actors[name]
	favorites := e.holderFavorites[name]
	if len(favorites) == 0 {
		return
	}
	target := favorites[actor.RNG.Intn(len(favorites))]
	bal := core.BalanceOf(e.Store, target, name)

	if bal.Sign() > 0 && actor.RNG.Float64() < 0.80 {
		to := e.pickTransferTarget(name, actor.RNG)
		if to != "" {
			amount := new(big.Int).Div(bal, big.NewInt(int64(1+actor.RNG.Intn(3)))) // 33%-100%
			if amount.Sign() > 0 {
				e.doTransfer(target, name, to, amount)
			}
		}
	} else if actor.RNG.Float64() < 0.30 {
		amount := big.NewInt(randRangeInt64(actor.RNG, 500, 5_000))
		if cmpBig(actor.HBD, amount) >= 0 {
			e.doBuyBudget(name, target, amount)
		}
	}
	if e.haltErr != nil {
		return
	}

	next := e.Block + nextInterval(actor.RNG, traderTickCadence, e.Block)
	if next <= e.endBlock {
		e.scheduleTraderTickAt(name, next)
	}
}

// ---- keeper ----

func (e *Engine) scheduleKeeperTickAt(at uint64) {
	e.schedule(at, "keeper-tick", func(eng *Engine) { eng.keeperTick() })
}

// keeperTick builds a keeper.MarketView per creator from LIVE core reads
// (Phase, Supply) plus this simulator's own holder registry for candidate
// holders — exactly the shape cmd/keeper/main.go's collectMarketViews uses,
// except every candidate Balance here is ALSO a live core.BalanceOf read
// (never a stale cache), matching SPEC §2.5's "verify, don't trust" rule.
// The real keeper.Plan decision algorithm then decides every op; this
// function only executes what Plan decided, via the real core.RefundHolder/
// core.CloseIfDrained wrappers above.
func (e *Engine) keeperTick() {
	// First resolve any abandoned, past-window PENDING escrows permissionlessly
	// (Upgrade 2 / H1). This returns escrowed credits to their askers' balances
	// so the subsequent keeper.Plan pass can RefundHolder those balances and
	// CloseIfDrained the market — the escrow was the one thing that used to pin
	// supply > 0 forever. Done BEFORE building views so the views below reflect
	// the freshly-returned balances (live core reads).
	e.resolveStalePendingEscrows(e.pop.KeeperName, 0)
	if e.haltErr != nil {
		return
	}

	views := make([]keeper.MarketView, 0, len(e.creatorNames))
	for _, cname := range e.creatorNames {
		phase := core.Phase(e.Store, cname, e.Block)
		holders := make([]keeper.HolderBalance, 0, len(e.holderOrder[cname]))
		for _, h := range e.holderOrder[cname] {
			holders = append(holders, keeper.HolderBalance{Holder: h, Balance: core.BalanceOf(e.Store, cname, h)})
		}
		views = append(views, keeper.MarketView{
			Creator: cname, Phase: phase, Supply: core.Supply(e.Store, cname), Holders: holders,
		})
	}

	for _, op := range keeper.Plan(views) {
		switch op.Kind {
		case keeper.OpRefundHolder:
			e.doRefundHolder(e.pop.KeeperName, op.Creator, op.Holder)
		case keeper.OpCloseIfDrained:
			e.doCloseIfDrained(op.Creator)
		}
		if e.haltErr != nil {
			return
		}
	}

	actor := e.pop.Actors[e.pop.KeeperName]
	next := e.Block + nextInterval(actor.RNG, keeperTickCadence, e.Block)
	if next <= e.endBlock {
		e.scheduleKeeperTickAt(next)
	}
}

// resolveStalePendingEscrows pushes core.Reclaim on every PENDING escrow whose
// reclaim window has opened (block > deadline+ReclaimGrace), as `pusher` — a
// permissionless, third-party reclaim (Upgrade 2 / H1). core.Reclaim always
// pays the escrow's own asker, never the pusher, so this is pure janitorial
// work: it drains an abandoned escrow's credits back to the asker's balance,
// letting supply fall (once that balance is later refunded) and the market
// finally reach CLOSED. Deterministic — iterates append-only slices in
// first-observed order, consumes no RNG. maxPerCall==0 means unlimited.
//
// This is what the keeper does before it plans, AND what the good-samaritan
// sweep in speculatorTick does independently of any keeper — so an abandoned
// escrow is resolvable whether or not a keeper is present (the fail-safe
// Upgrade 3 exists to confirm).
func (e *Engine) resolveStalePendingEscrows(pusher string, maxPerCall int) {
	n := 0
	for _, cname := range e.creatorNames {
		for _, key := range e.pendingByCreator[cname] {
			rec := e.escrows[key]
			if rec == nil || rec.Status != escrowPending {
				continue
			}
			if e.Block > rec.Deadline+core.ReclaimGrace {
				e.doReclaim(pusher, rec.Asker, cname, rec.Seq)
				if e.haltErr != nil {
					return
				}
				n++
				if maxPerCall > 0 && n >= maxPerCall {
					return
				}
			}
		}
	}
}

// ---- owner (singleton platform owner; Upgrade 1 / C2 treasury exit) ----

func (e *Engine) scheduleOwnerTickAt(at uint64) {
	e.schedule(at, "owner-tick", func(eng *Engine) { eng.ownerTick() })
}

func (e *Engine) ownerTick() {
	e.doWithdrawTreasury(e.pop.OwnerName)
	if e.haltErr != nil {
		return
	}
	actor := e.pop.Actors[e.pop.OwnerName]
	next := e.Block + nextInterval(actor.RNG, ownerTickCadence, e.Block)
	if next <= e.endBlock {
		e.scheduleOwnerTickAt(next)
	}
}

// ---- oracle (synthetic per-market TWAP feed, price_mover creators only) ----

// oracleWalkState is the running synthetic "market price" for one
// price_mover creator's credits — a pure simulator invention: nothing in
// core or the real deployment produces this today (see ask.go's own
// SettlementRate doc — "core.RecordObs was called from NOTHING but this
// package's own tests... no DEX pool is wired"). This is what lets the
// simulator exercise the TWAP-active regime at all, deliberately contrasted
// against the reliable/flaky/abandoner creators, which never get an oracle
// and therefore settle every single ask at PAR for the whole run — exactly
// today's production reality.
type oracleWalkState struct {
	rate float64
}

func (e *Engine) startOracle(creator, oracleName string) {
	actor := e.pop.Actors[oracleName]
	// Start comfortably above PAR (1) so relative moves have real integer
	// granularity: starting AT par, the smallest possible next observation
	// (2) is already a 100% jump, which would trip MaxRateDeviationBps (20%)
	// on literally the second observation.
	e.oracleWalks[oracleName] = &oracleWalkState{rate: 1_000.0 + actor.RNG.Float64()*4_000.0}
	e.oracleTick(creator, oracleName)
}

func (e *Engine) oracleTick(creator, oracleName string) {
	actor := e.pop.Actors[oracleName]
	state := e.oracleWalks[oracleName]

	stepPct := 1 + actor.RNG.Float64()*3 // ordinary drift: 1%-4%
	if actor.RNG.Float64() < 0.08 {
		stepPct = 12 + actor.RNG.Float64()*18 // occasional shock: 12%-30%, deliberately, to exercise
		// AskRate's median-deviation guard and the SettlementRate PAR-
		// fallback path it triggers, not just steady-state TWAP pricing.
	}
	if actor.RNG.Float64() < 0.5 {
		stepPct = -stepPct
	}
	state.rate *= 1 + stepPct/100
	if state.rate < 1 {
		state.rate = 1
	}

	e.doRecordObs(creator, oracleName, big.NewInt(int64(state.rate)))
	if e.haltErr != nil {
		return
	}

	next := e.Block + nextInterval(actor.RNG, oracleTickCadence, e.Block)
	if next <= e.endBlock {
		e.schedule(next, "oracle-tick", func(eng *Engine) { eng.oracleTick(creator, oracleName) })
	}
}
