package sim

import (
	"container/heap"
	"math/big"
	"path/filepath"
	"strings"
	"testing"

	"creator-tokens/core"
	"creator-tokens/sim/analysis"
)

// upgrades_test.go — engine-level proofs for the three sim enhancements the
// scrutinizer asked for: the C2 treasury exit is actually driven and drains to
// zero; the H1 fund fail-safes hold with NO keeper; the H2 exact-commission
// guard rejects a same-block SetFace-before-ask sandwich; and the adversarial
// intra-block order actually reorders the sandwich.

// analyzeRun runs a real engine and feeds its trace back through the analysis
// layer exactly as cmd/simreport would (round-tripping through JSON so the
// test exercises the same path the tool does, not the in-memory structs).
func analyzeRun(t *testing.T, cfg Config) analysis.Report {
	t.Helper()
	eng := NewEngine(cfg)
	if err := eng.Run(cfg.Days); err != nil {
		t.Fatalf("run hit an invariant violation: %v", err)
	}
	path := filepath.Join(t.TempDir(), "trace.json")
	if err := eng.Trace.WriteJSON(path); err != nil {
		t.Fatalf("WriteJSON: %v", err)
	}
	tr, err := analysis.LoadTrace(path)
	if err != nil {
		t.Fatalf("LoadTrace: %v", err)
	}
	return analysis.Analyze(tr)
}

// TestOwnerDrainsTreasuryToZero — Upgrade 1 (C2). The owner actor periodically
// withdraws the whole accrued treasury, so over a real run the ledger analysis
// must observe the exit exercised AND the treasury driven to EXACTLY 0. Pre-
// fix (no WithdrawTreasury) this same run would flag TreasuryFrozenFlag; the
// point is that the sim now DRIVES the exit and proves it works.
func TestOwnerDrainsTreasuryToZero(t *testing.T) {
	rpt := analyzeRun(t, Config{Seed: 1, Days: 20, NumCreators: 8, NumActors: 24})

	if !rpt.Ledger.TreasuryExitExercised {
		t.Fatal("treasury exit was never exercised — the owner actor did not drive WithdrawTreasury")
	}
	if !rpt.Ledger.TreasuryReachedZero {
		t.Fatalf("treasury was never driven to 0 by the owner (final=%s, max=%s) — drainability not proven",
			rpt.Ledger.TreasuryFinal, rpt.Ledger.TreasuryMaxObserved)
	}
	if rpt.Ledger.TreasuryFrozenFlag {
		t.Error("TreasuryFrozenFlag must be false once the exit is driven")
	}
	if rpt.Ledger.Left.TreasuryWithdrawn.Sign() <= 0 {
		t.Errorf("expected a positive amount withdrawn, got %s", rpt.Ledger.Left.TreasuryWithdrawn)
	}
	if !rpt.Ledger.Closes {
		t.Errorf("money identity must still close with the treasury exit in play: %s", rpt.Ledger.FirstBadReason)
	}

	// The whole run must remain non-critical (the exit is exercised).
	if rpt.Critical() {
		t.Error("a run where the owner drains the treasury must not be Critical on the treasury gate")
	}
}

// TestKeeperAbsentFailSafesHold — Upgrade 3(a). With NO keeper at all, the
// fund fail-safes must still hold: holders self-refund (no persistent dead
// ends), abandoned escrows are still resolved by a third party (permissionless
// reclaims by non-keeper actors > 0), no market is bricked, and the owner's
// treasury exit is unaffected by the keeper's absence.
func TestKeeperAbsentFailSafesHold(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping the 90-day absent-keeper run in -short mode")
	}
	// NumCreators retuned 8 -> 4 (same 24 actors, same seed) — the retune
	// itself is correct and necessary, empirically verified against this
	// exact seed before landing, but the mechanism this comment used to name
	// (F2, an adversarial review) was WRONG, not merely imprecise, and would
	// have sent the next maintainer chasing oracleTickCadence, which has no
	// effect at all on this test.
	//
	// MEASURED CAUSE (a dump of every refusal across six seed/creator/day
	// configs, cross-checked directly against this session's own diagnostic
	// run): ZERO staleness (ErrOracle/MaxStaleBlocks) refusals in ANY config
	// tested. Every non-delinquency "ask" failure is
	// `STATE | settlement spend exceeds 5% of supply (spend cap)` —
	// settlement.go's MaxSpendSupplyBps, a market-DEPTH constraint, not a
	// TWAP-staleness one: c*10000 <= S*500, so a fixed-size ask needs a
	// large enough SUPPLY to clear it, and supply is what organic trading
	// against a fixed actor pool actually builds up. At 8 creators sharing
	// 24 actors' organic Buy/Sell traffic, each individual market's supply
	// grows too slowly for a typical ask's credits requirement to ever clear
	// 5% of it, so asks (and therefore misses, and therefore delinquency,
	// and therefore the H1 fail-safe's abandoned-escrow scenario this test
	// exists to prove) almost never actually happen within 90 days at this
	// seed. Fewer creators sharing the SAME actor pool concentrate the same
	// trading volume onto fewer, deeper markets — supply grows faster per
	// market, the spend cap binds less, and the scenario reliably manifests.
	// See sim/actions.go's shopTick/claimTradeFees/pickAskTarget wiring
	// (2026-07-28) for the actions this now also exercises that a sparser
	// config would starve just as badly, for the identical depth reason.
	cfg := Config{Seed: 1, Days: 90, NumCreators: 4, NumActors: 24, KeeperProfile: KeeperAbsent}
	eng := NewEngine(cfg)
	if err := eng.Run(cfg.Days); err != nil {
		t.Fatalf("absent-keeper run hit an invariant violation: %v", err)
	}

	// Confirm the keeper genuinely never acted: RefundHolder and CloseIfDrained
	// are keeper-only in this simulator, so there must be zero of them.
	//
	// ★ THE FAIL-SAFE HAS BEEN RE-SHAPED TWICE, AND THIS IS WHAT IT MEANS NOW.
	// Originally it was "holders self-REFUND without a keeper", because a lapsed
	// market froze into a wind-down and the pull rail was the only exit. A1
	// (2026-08-30) made a lapse an inflow stop instead, so the exit became the
	// curve Sell and the count moved to sells on FROZEN markets. The OWNER
	// RULING of 2026-09-12 removed the subscription entirely: markets do not
	// lapse at all, so FROZEN is reachable only by a creator's own Retire and
	// "sells on a FROZEN market" is now a count of something that cannot happen
	// on an abandoned market.
	//
	// The property itself never changed: A HOLDER CAN GET OUT WHEN THE CREATOR
	// HAS WALKED AWAY AND NOBODY IS KEEPING THE LIGHTS ON. So the count is sells
	// on markets whose creator has actually abandoned them (past their own
	// AbandonBlock, read from the engine's population rather than guessed), plus
	// refunds on retired ones. Sells on a live, attended market are still NOT
	// counted — that is what would make this vacuous.
	abandonedAt := map[string]uint64{}
	for name, cs := range eng.creators {
		if cs.AbandonBlock != 0 {
			abandonedAt[name] = cs.AbandonBlock
		}
	}
	refunds, abandonedSells := 0, 0
	for _, ev := range eng.Trace.Events {
		switch ev.Action {
		case "refundHolder", "closeIfDrained":
			t.Fatalf("keeper acted (%s at block %d) despite KeeperProfile=absent", ev.Action, ev.Block)
		case "refund":
			if ev.OK {
				refunds++
			}
		case "sell":
			if !ev.OK {
				continue
			}
			if b, ok := abandonedAt[ev.Creator]; ok && ev.Block >= b {
				abandonedSells++
			}
		}
	}
	t.Logf("keeper-absent exits: %d curve sells on ABANDONED markets, %d pro-rata refunds on retired ones", abandonedSells, refunds)
	if len(abandonedAt) == 0 {
		t.Fatal("fixture produced no abandoned creator at all — this run proves nothing about the fail-safe")
	}
	if refunds+abandonedSells == 0 {
		t.Error("expected holders to still exit without a keeper (sell on an abandoned market, or refund on a retired one) — the fail-safe")
	}

	path := filepath.Join(t.TempDir(), "trace.json")
	if err := eng.Trace.WriteJSON(path); err != nil {
		t.Fatalf("WriteJSON: %v", err)
	}
	tr, err := analysis.LoadTrace(path)
	if err != nil {
		t.Fatalf("LoadTrace: %v", err)
	}
	rpt := analysis.Analyze(tr)

	if len(rpt.DeadEnds.Persistent) != 0 {
		t.Errorf("expected no persistent per-actor dead ends without a keeper, got %+v", rpt.DeadEnds.Persistent)
	}
	if len(rpt.DeadEnds.MarketDeadEnds) != 0 {
		t.Errorf("expected no market bricked without a keeper (abandoned escrows resolvable by any third party), got %+v", rpt.DeadEnds.MarketDeadEnds)
	}
	if rpt.DeadEnds.PermissionlessReclaims == 0 {
		t.Error("expected >=1 permissionless reclaim driven by a NON-keeper third party — the H1 fail-safe with no keeper")
	}
	if !rpt.Ledger.TreasuryReachedZero {
		t.Error("owner treasury exit must still drain to 0 regardless of keeper presence")
	}
}

// TestFaceSpikeSandwichRejected — Upgrade 3(b). Drives a same-block face
// sandwich through the sim's own wrappers and proves the asker's signed cap
// stops it.
//
// ★ THIS WAS TestH2SetFaceDropSandwichRejected, AND THE DIRECTION FLIPPED WITH
// THE MONEY MODEL (OWNER RULING 2026-09-12). The H2 guard it drove required
// commissionHbdPaid to EXACTLY equal commissionOwedFor(face at execution), so
// the dangerous sandwich was a band-legal face DROP: the asker had already paid
// the commission owed at the higher face, and the surplus would have been held
// and then booked to a treasury with no exit. There is no separate commission
// amount any more — the 12% is carved out of the credits — so a face drop is now
// simply a cheaper ask and is correctly ACCEPTED.
//
// The sandwich that still matters is the SPIKE: a creator raising their face
// between the asker signing and the ask executing, under producer-chosen
// intra-block ordering. maxCredits — the asker's own signed ceiling, which now
// bounds the WHOLE price rather than one of two legs — is what refuses it, and
// that is what this test drives. The control proves the refusal is about the
// spike and not about asks in general at the new face.
func TestFaceSpikeSandwichRejected(t *testing.T) {
	cfg := Config{Seed: 7, Days: 5, NumCreators: 4, NumActors: 8, AdversarialOrder: true}
	eng := NewEngine(cfg)
	eng.endBlock = genesisBlock + uint64(cfg.Days)*core.BlocksPerDay
	eng.Block = genesisBlock

	creator := eng.creatorNames[0]
	asker := eng.pop.HolderNames[0]

	// Pin a known face so the two commission figures provably differ, then
	// register (Register anchors the band at this face). Also pin a large
	// cap so the small buys below (see the oracle warm-up note) never brush
	// a per-seed-random ceiling.
	eng.creators[creator].InitialFace = 4000
	eng.creators[creator].InitialCap = 1_000_000
	eng.doRegister(creator)
	if eng.haltErr != nil {
		t.Fatalf("register halted: %v", eng.haltErr)
	}
	if core.Face(eng.Store, creator).Int64() != 4000 {
		t.Fatalf("face = %s, want 4000", core.Face(eng.Store, creator))
	}

	// Fund the asker generously — plenty at the curve's low-supply prices
	// for everything below, including the ten small buys that build the
	// oracle history.
	eng.pop.Actors[asker].HBD = addBig(eng.pop.Actors[asker].HBD, big.NewInt(1_000_000_000))

	// ORACLE FIXTURE FIX (this test used to fail before even reaching the H2
	// guard, refused by settlement.go's settlePosted/twap.go's twapWindowRead
	// with ErrOracle "fewer than the minimum distinct-block observations").
	// settlePosted prices EVERY ask off min(short TWAP, long TWAP, spot), and
	// both TWAP rings refuse to price at all until they hold a minimum COUNT
	// of distinct-block samples spanning a minimum BLOCK WINDOW (twap.go). The
	// only production writer of those rings is core.Buy/Sell (RecordObs is
	// fed by the curve — "the curve IS the price source"), so a fixture that
	// wants a real settlement must build a real trading history the same way,
	// not poke the rings directly.
	//
	// The LONG ring is the binding one: it needs >= LongMinObsCount (8)
	// samples spanning >= LongMinObsBlocks (2 days = 57,600 blocks), each
	// written >= LongObsSpacing (6,300 blocks) apart (twap.go's RecordObs
	// dedup). Nine buys exactly LongObsSpacing apart, followed by a tenth
	// after one further (still un-clamped) gap, span 58,400 blocks end to
	// end — comfortably past the 57,600 floor with no single gap exceeding
	// LongMaxObsWeightBlocks (12,600), so none of the accumulated dwell
	// weight is clamped away either (twapWindowRead's second, independent
	// "un-clamped weight" check).
	//
	// EACH buy is deliberately SMALL (20 tokens) and evenly spaced: the curve
	// (curve.go) is steep enough that supply, not calendar time, is what
	// breaks settlement. A big buy here (the old fixture bought 8,000 in one
	// shot) pushes the market's own supply — and with it the curve's average
	// "backing per token" and marginal "spot" price — high enough that a
	// 4,000-unit face can no longer clear settlement.go's own guards: RULING
	// C4's minimum-price floor (a face must be at least half of one token's
	// value) and RULING C5's divergence tripwire (backing must stay within
	// 4x the settlement rate) become UNSATISFIABLE together once supply
	// passes roughly 700 tokens at this curve (verified directly against
	// core.Area/core.SpotRate: at supply 8,000 the C4 floor alone requires
	// face >= ~116,000). Conversely, too LOW a supply starves RULING C2's
	// OTHER guard — the settlement spend cap (a single ask may not settle
	// more than 5% of supply in credits) — which a supply of just a few tens
	// of tokens fails outright. 200 tokens, built in even 20-token steps (so
	// no single step moves the curve's price more than ~14%, comfortably
	// under twap.go's MaxRateDeviationBps), sits in the window where face
	// 4000 clears every settlement guard for BOTH the control face (4000)
	// and the dropped sandwich face (3000) at once (verified directly
	// against core.Area/core.SpotRate before writing this fixture).
	const warmupBuy = 20
	const warmupRounds = 9
	for i := 0; i < warmupRounds; i++ {
		eng.Block = genesisBlock + uint64(i)*core.LongObsSpacing
		eng.doBuy(asker, creator, big.NewInt(warmupBuy))
		if eng.haltErr != nil {
			t.Fatalf("warm-up buy %d halted: %v", i, eng.haltErr)
		}
	}
	// The final observation, one more (safely un-clamped) gap later: this is
	// also the asker's top-up to the balance the rest of the test expects.
	eng.Block = genesisBlock + uint64(warmupRounds-1)*core.LongObsSpacing + 8000
	eng.doBuy(asker, creator, big.NewInt(20))
	if eng.haltErr != nil {
		t.Fatalf("top-up buy halted: %v", eng.haltErr)
	}
	if got := core.BalanceOf(eng.Store, creator, asker); got.Cmp(big.NewInt(200)) != 0 {
		t.Fatalf("asker credits = %s, want 200 (the warm-up/top-up buys did not land)", got)
	}

	// The asker quotes at face 4000 and signs a cap of exactly what that costs.
	// Derived from the live settlement, not guessed, so the cap is the tightest
	// legitimate one rather than a generous round number.
	q, err := core.SettleSpend(eng.Store, creator, eng.Block, big.NewInt(4000))
	if err != nil {
		t.Fatalf("quote at face 4000: %v", err)
	}
	signedCap := new(big.Int).Set(q.Credits)

	// CONTROL: the ask executes against the face it was quoted at -> succeeds.
	eng.doAskExecute(asker, creator, signedCap, "cid-control", core.MinAskDeadline, 0)
	control := eng.Trace.Events[len(eng.Trace.Events)-1]
	if control.Action != "ask" || !control.OK {
		t.Fatalf("control ask should succeed at the quoted face 4000 with cap %s, got OK=%v err=%s/%s", signedCap, control.OK, control.ErrSym, control.ErrMsg)
	}

	// SANDWICH: band-legal SPIKE 4000 -> 8000 (exactly the 2x band), same block.
	eng.doSetFace(creator, 8000)
	sf := eng.Trace.Events[len(eng.Trace.Events)-1]
	if sf.Action != "setFace" || !sf.OK {
		t.Fatalf("band-legal face spike 4000->8000 should succeed, got OK=%v err=%s/%s", sf.OK, sf.ErrSym, sf.ErrMsg)
	}

	// The asker's already-signed cap was quoted at 4000. maxCredits must refuse.
	eng.doAskExecute(asker, creator, signedCap, "cid-sandwich", core.MinAskDeadline, 0)
	sandwich := eng.Trace.Events[len(eng.Trace.Events)-1]
	if sandwich.Action != "ask" {
		t.Fatalf("expected the last event to be the sandwich ask, got %q", sandwich.Action)
	}
	if sandwich.OK {
		t.Fatal("SANDWICH VIOLATION: an ask signed against face 4000 executed against a spiked face 8000 — the maxCredits cap did not fire")
	}
	if sandwich.ErrSym != "INPUT" || !strings.Contains(sandwich.ErrMsg, "creditsSpent exceeds maxCredits") {
		t.Errorf("expected the maxCredits slippage rejection, got %s: %s", sandwich.ErrSym, sandwich.ErrMsg)
	}

	// PROOF the cap is rejecting the SPIKE specifically, not the ask in general
	// once the face has moved (the fixture's oracle history could in principle
	// still be one settlement guard away from failing on ANY ask at the new
	// face — this rules that out): an asker who re-quotes at the CURRENT face
	// and signs the cap that price actually costs succeeds at the same block,
	// against the same asker and the same oracle state.
	q2, err := core.SettleSpend(eng.Store, creator, eng.Block, big.NewInt(8000))
	if err != nil {
		t.Fatalf("re-quote at face 8000: %v", err)
	}
	eng.doAskExecute(asker, creator, q2.Credits, "cid-honest-at-new-face", core.MinAskDeadline, 0)
	honest := eng.Trace.Events[len(eng.Trace.Events)-1]
	if honest.Action != "ask" || !honest.OK {
		t.Fatalf("an ask re-quoted at the CURRENT face (8000, cap %s) should succeed — if it doesn't, the sandwich rejection above proves nothing about the cap specifically; got OK=%v err=%s/%s",
			q2.Credits, honest.OK, honest.ErrSym, honest.ErrMsg)
	}
}

// TestAdversarialIntraBlockOrder — Upgrade 3(b) plumbing. At the same block,
// strict FIFO runs items in schedule order; the adversarial order front-runs a
// creator's own move (SetFace via creator-tick) AHEAD of a victim's ask
// execution scheduled earlier, which is what makes a same-block sandwich
// producible organically.
func TestAdversarialIntraBlockOrder(t *testing.T) {
	check := func(adversarial bool, wantFirst string) {
		t.Helper()
		eng := NewEngine(Config{Seed: 1, Days: 1, NumCreators: 1, NumActors: 1, AdversarialOrder: adversarial})
		var order []string
		// ask-execute is scheduled FIRST (smaller seq); creator-tick SECOND.
		eng.schedule(1000, "ask-execute", func(e *Engine) { order = append(order, "ask-execute") })
		eng.schedule(1000, "creator-tick", func(e *Engine) { order = append(order, "creator-tick") })
		for eng.heap.Len() > 0 {
			it := heap.Pop(&eng.heap).(*scheduledItem)
			it.fn(eng)
		}
		if len(order) != 2 || order[0] != wantFirst {
			t.Errorf("adversarial=%v: order=%v, want %q first", adversarial, order, wantFirst)
		}
	}
	check(false, "ask-execute") // FIFO: whatever was scheduled first
	check(true, "creator-tick") // adversarial: the creator front-runs the ask at the same block
}

// TestDenseRunProvesDelinquencyGuardrailNonVacuous — the delivery-gate
// standing guardrail (core/delivery.go / engine.go's checkDelinquencyGuardrail)
// existed and was WIRED correctly from the moment it landed, but was 100%
// VACUOUS on its own outflow half in every configuration this package's own
// default tests happened to use (an independent adversarial review measured
// this directly: 5 real runs, seeds 1/2/3/7/11, 90-180 days, up to 12
// creators x 40 actors -- OutflowAttempts was 0 in every single one). An
// invariant that never fires proves nothing, and worse, Summary()'s own
// header used to print "(live-proven, not assumed)" even on a run where it
// plainly was not.
//
// ROOT CAUSE (CORRECTED 2026-07-28, F2, an adversarial review): this note
// used to name TWAP staleness (MaxStaleBlocks) as the mechanism -- WRONG,
// and would have sent the next maintainer chasing oracleTickCadence, which
// has no effect here at all. A dump of every refusal across six seed/
// creator/day configs (cross-checked directly against a diagnostic run this
// session) showed ZERO staleness (ErrOracle) refusals anywhere; every
// non-delinquency "ask" failure is
// `STATE | settlement spend exceeds 5% of supply (spend cap)` --
// settlement.go's MaxSpendSupplyBps, a market-DEPTH constraint:
// c*10000 <= S*500, so a fixed-size ask needs the market's SUPPLY to have
// grown large enough to clear it. At a "realistic" broad population (many
// creators sharing a modest actor pool -- this package's own default CLI
// flags, cmd/sim/main.go), each individual market's supply grows too slowly
// for a typical ask to ever clear that 5% floor, so successful asks (and
// therefore misses, and therefore delinquency) are RARE. Concentrating the
// same actor pool onto fewer creators (this test's Config) raises per-market
// supply growth (not merely "trade density" in the abstract -- specifically
// the spend cap's own denominator) enough that a flaky creator reliably
// crosses MinMissesForDelinquency within the run -- verified empirically
// against this exact seed before landing, not tuned to a single lucky draw
// (see the session's own report for the wider sweep this was picked from).
//
// THIS TEST IS THE PERMANENT, CI-ENFORCED VERSION of that proof: it is not
// enough that a manually-run cmd/sim happens to show good counters once: a
// caller who wants "vacuous is a hard failure" (an independent adversarial
// review's explicit ask) needs it enforced by `go test` itself, every time,
// forever -- which is exactly what DeliveryGuardrailExercised() (engine.go)
// exists for. If this test ever starts failing, that is either (a) a real
// regression in the delivery gate / RequireInflowOpen worth halting on, or
// (b) this population/timing tuning has drifted enough that the scenario no
// longer manifests at this seed -- in which case the fix is to find a new
// seed/config that DOES reach it and prove it again, never to weaken or
// delete this test.
func TestDenseRunProvesDelinquencyGuardrailNonVacuous(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping the 180-day dense run in -short mode")
	}
	cfg := Config{Seed: 2, Days: 180, NumCreators: 2, NumActors: 40, KeeperProfile: KeeperReliable}
	eng := NewEngine(cfg)
	if err := eng.Run(cfg.Days); err != nil {
		t.Fatalf("dense run hit an invariant violation: %v", err)
	}

	if !eng.DeliveryGuardrailExercised() {
		t.Fatalf("standing guardrail proof is VACUOUS at seed=%d: %+v -- either the delivery gate broke (fewer purchases refused / fewer outflows succeeding than attempted) or this run's population/timing no longer reaches delinquency; either way this must not silently pass",
			cfg.Seed, eng.DQ)
	}
	// THE SAFETY PROPERTY, as an exact accounting identity: every purchase
	// attempted against an already-delinquent creator was REFUSED — none got
	// through. A purchase the delivery gate refuses lands in
	// PurchaseRefusedForDelinquency; one that some earlier guard (the
	// settlement spend cap, a retiring market) refused first lands in
	// PurchaseRefusedOther. Anything that SUCCEEDED never reaches either
	// counter, because checkDelinquencyGuardrail halts the whole run on it.
	// So refused+other == attempted is precisely "nothing got through".
	//
	// This replaced a bare `refused == attempted` (2026-07-28), which was not
	// the safety property: it silently also demanded that no OTHER guard ever
	// fire first, so making markets deeper — which is what actually gets this
	// scenario reached — broke it, with 8 of 52 attempts refused by the spend
	// cap. Those 8 were refused; they simply prove nothing about the delivery
	// gate, since they would fail with or without it. The identity below is
	// strictly stronger about safety, and the floor beneath it keeps the
	// coverage claim honest.
	if got := eng.DQ.PurchaseRefusedForDelinquency + eng.DQ.PurchaseRefusedOther; got != eng.DQ.PurchaseAttempts {
		t.Errorf("a purchase against an already-delinquent creator was neither refused for delinquency nor refused by another guard: refusedForDelinquency=%d refusedOther=%d sum=%d attempted=%d",
			eng.DQ.PurchaseRefusedForDelinquency, eng.DQ.PurchaseRefusedOther, got, eng.DQ.PurchaseAttempts)
	}
	// ...and the delivery gate specifically must be doing real work, not
	// riding on other guards: a clear majority of attempts, and at least 10,
	// must be refused BY IT. Without this the identity above would be
	// satisfied by a run in which the gate never fired once.
	if eng.DQ.PurchaseRefusedForDelinquency < 10 || eng.DQ.PurchaseRefusedForDelinquency*2 <= eng.DQ.PurchaseAttempts {
		t.Errorf("the delivery gate itself refused too few purchases to prove anything: refusedForDelinquency=%d of attempted=%d (want >=10 and a strict majority)",
			eng.DQ.PurchaseRefusedForDelinquency, eng.DQ.PurchaseAttempts)
	}
	if eng.DQ.OutflowSucceeded != eng.DQ.OutflowAttempts {
		t.Errorf("every outflow/renew/shop-config action attempted against an already-delinquent creator must NOT be blocked by delinquency: succeeded=%d attempted=%d",
			eng.DQ.OutflowSucceeded, eng.DQ.OutflowAttempts)
	}
	// A floor, not a tight bound: this documents the ORDER OF MAGNITUDE this
	// config/seed actually reaches (both counts were in the several-dozens
	// range when this was verified), so a future change that quietly starves
	// this run back down to "1 purchase, 1 outflow, technically non-vacuous"
	// fails loudly here instead of squeaking by DeliveryGuardrailExercised's
	// bare >0 check.
	if eng.DQ.PurchaseAttempts < 10 || eng.DQ.OutflowAttempts < 10 {
		t.Errorf("standing guardrail proof is technically non-vacuous but far thinner than expected for this seed: %+v (want >=10 of each)", eng.DQ)
	}
}
