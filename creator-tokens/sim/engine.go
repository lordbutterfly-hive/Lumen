package sim

import (
	"container/heap"
	"fmt"
	"math/big"
	"math/rand"
	"sort"
	"strings"

	"creator-tokens/core"
)

// ---------------------------------------------------------------------------
// DETERMINISM. A run replays exactly from its seed because:
//  1. Population construction (actors.go's NewPopulation) derives every
//     actor's *rand.Rand from one master RNG, itself seeded from Seed, in a
//     fixed, deterministic construction order.
//  2. The event scheduler below (eventHeap) is a strict priority queue on
//     (block, insertion-sequence) — insertion sequence is a monotonic
//     counter, so ties at the same block resolve in the exact order items
//     were scheduled, never via Go's randomized map iteration.
//  3. Every collection this package iterates for something that affects
//     scheduling, arithmetic order, or trace content is a slice built in
//     deterministic (usually: first-observed) order — never a bare `range`
//     over a map. See holderOrder/pendingByCreator/pendingByAsker below and
//     creatorNames/holderNames on Population.
//  4. Each actor's own RNG is advanced ONLY while that actor's own scheduled
//     step is executing — the engine is single-threaded and never
//     interleaves two actors' random draws within one step.
// ---------------------------------------------------------------------------

// genesisBlock is where the simulated chain "starts." Deliberately NOT 0:
// core/market.go documents a known, unfixed edge case at block==0 —
// registering there writes kRegisteredAt(creator)=0, which reads back
// identically to "never registered" everywhere else in the package. That is
// a pre-existing, already-documented finding, not something this simulator
// exists to rediscover, so every run starts comfortably clear of it.
const genesisBlock uint64 = 10_000

// checkDelinquencyGuardrail (below) identifies a delivery-gate refusal by its
// ERROR SYMBOL, core.ErrDelinquent, which core/market.go's RequireInflowOpen
// returns for that branch and nothing else returns at all.
//
// It used to substring-match ErrMsg for "delinquent on delivery", because
// core/errors.go had no symbol finer than the shared ErrState. An independent
// adversarial review (2026-07-28) showed why that mattered: rewording one
// sentence in core would leave PurchaseRefusedForDelinquency merely
// undercounting, but would make the OUTFLOW halt STRUCTURALLY UNREACHABLE —
// a genuine standing-guardrail regression in core (an outflow starting to
// consult delivery standing) would silently score as OutflowSucceeded++ and
// still print as a pass. core.ErrDelinquent was added to close that; do not
// reintroduce a text match here.

const (
	escrowPending   = "PENDING"
	escrowAnswered  = "ANSWERED"
	escrowReclaimed = "RECLAIMED"
	// escrowDeclined (RULING E, core/delivery.go/core/ask.go's Decline) — the
	// creator's free, honest "no": full round-trip of credits AND commission
	// back to the asker, inside the answer window, explicitly NEUTRAL in the
	// delivery gate (neither a miss nor a delivery). Distinct from RECLAIMED
	// so the shadow ledger can tell "the creator declined" from "the asker
	// never got an answer" apart, exactly as core's own askDeclined status does.
	escrowDeclined = "DECLINED"
)

// EscrowShadow is this simulator's own record of one escrowed ask — NOT a
// core type. core exposes no reader for escrow records (by design: they are
// an internal implementation detail of ask.go), so the simulator keeps its
// own shadow copy, populated from the exact values core.Ask/Answer/Reclaim
// returned or were called with. It backs three things: (a) the I3 escrowed-
// credits term, (b) the held-commission HBD term, and (c) letting creator/
// asker actors know which of their own escrows are still open.
type EscrowShadow struct {
	Creator       string
	Seq           uint64
	Asker         string
	Credits       *big.Int
	CommissionHbd *big.Int
	Deadline      uint64
	Status        string // PENDING / ANSWERED / RECLAIMED / DECLINED
	OfferingID    uint64 // which named service this ask targeted (0 == the legacy `face` price, offerings.go)
}

func escrowKey(creator string, seq uint64) string {
	return fmt.Sprintf("%s|%d", creator, seq)
}

// creatorState is the simulator's own bookkeeping for one creator's market —
// again, never a source of truth (core.Store is), only a cache of the
// choices this simulator made plus the running total invariant checks need.
type creatorState struct {
	Name         string
	Role         Role
	InitialFace  int64
	InitialCap   int64
	AbandonBlock uint64 // 0 = this creator never abandons
	PaidInTotal  *big.Int

	// RetireOnAbandon (Retire coverage): when AbandonBlock != 0, whether this
	// creator's shutdown is a formal Retire (core.Retire — irreversible,
	// closes inflows including the curve rail IMMEDIATELY, even during the
	// 5-day notice) rather than a silent ghost (the natural OVERDUE->FROZEN
	// lapse ladder, unchanged pre-existing behaviour). See NewEngine.
	RetireOnAbandon bool
	// VoluntaryRetireBlock (Retire coverage): a minority of RELIABLE creators
	// retire on purpose, late in the run, with a clean delivery record --
	// distinct from abandonment, exercising Retire on a HEALTHY market. 0 =
	// never. See NewEngine and creatorTick.
	VoluntaryRetireBlock uint64
}

// Keeper-behaviour profiles (Upgrade 3). The creator sim historically ran a
// single, maximally-honest keeper (it swept on a fixed cadence and never
// missed). The market sim already modelled reliable/late/absent keepers; this
// adopts (a subset of) that axis so the fund fail-safes can be confirmed to
// hold with NO keeper at all — holders must still self-refund, and abandoned
// escrows must still be resolvable by any third party (the H1 permissionless
// reclaim), never only by the keeper.
const (
	KeeperReliable = "reliable" // sweeps on cadence, resolves stale escrows, drives wind-down (default)
	KeeperAbsent   = "absent"   // never scheduled: no keeper op ever fires the whole run
)

// Config parameterizes one simulation run.
type Config struct {
	Seed        int64
	Days        int
	NumCreators int
	NumActors   int
	Verbose     bool

	// KeeperProfile selects the keeper-behaviour axis (Upgrade 3). Empty
	// defaults to KeeperReliable, preserving every pre-existing run.
	KeeperProfile string

	// AdversarialOrder replaces the strict FIFO intra-block tie-break with a
	// producer-adversarial one (Upgrade 3b): at the same block, a creator's
	// own actions (SetFace in particular) are ordered BEFORE a victim asker's
	// ask execution, so a band-legal SetFace-before-ask sandwich can be
	// produced deterministically. Default false keeps the strict FIFO order
	// every pre-existing run relied on.
	AdversarialOrder bool
}

// scheduledItem is one entry in the engine's event-driven scheduler: "run fn
// at block N." seq is the tiebreaker described in the determinism note. prio
// is a SECOND, higher-priority tie-break used only when Config.AdversarialOrder
// is set (Upgrade 3b): at the same block, lower prio runs first, so a
// producer-front-run face change (prio<0) precedes a victim ask execution
// (prio>0). prio is 0 for every item in the default FIFO mode, which makes the
// comparator collapse back to the original (block, seq) ordering exactly —
// determinism is preserved either way because prio is a pure function of the
// item's label and the (fixed-at-construction) config.
type scheduledItem struct {
	block uint64
	seq   uint64
	prio  int
	label string
	fn    func(*Engine)
}

type eventHeap []*scheduledItem

func (h eventHeap) Len() int { return len(h) }
func (h eventHeap) Less(i, j int) bool {
	if h[i].block != h[j].block {
		return h[i].block < h[j].block
	}
	if h[i].prio != h[j].prio {
		return h[i].prio < h[j].prio
	}
	return h[i].seq < h[j].seq
}
func (h eventHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *eventHeap) Push(x any)   { *h = append(*h, x.(*scheduledItem)) }
func (h *eventHeap) Pop() any {
	old := *h
	n := len(old)
	item := old[n-1]
	old[n-1] = nil
	*h = old[:n-1]
	return item
}

// InvariantViolation is returned by Engine.Run when any of the asserted
// invariants (I1/I2/I3, the HBD conservation identity, "reserve never
// exceeds what was paid in," or "a rejected call must not mutate state")
// fails. It carries everything needed to reproduce and diagnose the failure:
// the seed (the whole run replays from it) and the full event that was being
// processed at the moment of the violation.
type InvariantViolation struct {
	Seed   int64
	Reason string
	Event  Event
}

func (v *InvariantViolation) Error() string {
	return fmt.Sprintf("INVARIANT VIOLATION (seed=%d): %s\n  triggering event: %+v", v.Seed, v.Reason, v.Event)
}

// Engine is the whole simulation: a real core.Store, the population driving
// it, this package's own shadow ledgers (needed only because core itself has
// no concept of a caller's off-chain HBD wallet or of escrow history — see
// actions.go's file doc), and the event-driven scheduler.
type Engine struct {
	Store *core.MemStore
	Block uint64
	Seed  int64
	Trace *Trace

	pop *Population

	creators     map[string]*creatorState
	creatorNames []string // deterministic order, == pop.CreatorNames

	// holderFavorites/holderSlippageBps: fixed per-holder-actor preferences,
	// drawn once (from that actor's own RNG) at population-wiring time in
	// NewEngine, never re-rolled. fan/one_shot/trader get a small, sticky set
	// of creators they care about ("their" markets); speculators sample the
	// full creatorNames list fresh on every decision instead (see actions.go).
	holderFavorites   map[string][]string
	holderSlippageBps map[string]int64 // ask maxCredits buffer, basis points; only meaningful for fan/one_shot

	// holderOrder/holderSeen: append-only, first-observed order per creator.
	// Never iterate a map for this — see the determinism note.
	holderOrder map[string][]string
	holderSeen  map[string]map[string]bool

	escrows          map[string]*EscrowShadow
	pendingByCreator map[string][]string // creator -> escrow keys, append-only
	pendingByAsker   map[string][]string // asker   -> escrow keys, append-only

	oracleWalks map[string]*oracleWalkState // oracle actor name -> its running synthetic price state

	treasuryShadow      *big.Int // registration + subscription fees + booked (answered) commissions + the platform half of every K2 exit tax (Refund/RefundHolder)
	heldCommissionTotal *big.Int // commission HELD in open escrows (Ask'd, not yet Answered or Reclaimed)
	totalHbdIn          *big.Int // every HBD unit ever pulled from an actor's wallet into the contract
	totalHbdOut         *big.Int // every HBD unit ever paid from the contract back to an actor

	heap       eventHeap
	seqCounter uint64
	endBlock   uint64

	keeperProfile    string // Upgrade 3: KeeperReliable | KeeperAbsent
	adversarialOrder bool   // Upgrade 3b: producer-adversarial intra-block tie-break

	// DQ is the live, in-run proof for the delivery-gate STANDING GUARDRAIL
	// (core/delivery.go): delinquency must refuse PURCHASES (Ask/Buy, via
	// RequireInflowOpen) and must NEVER refuse a payout, a subscription
	// payment, or a shop-config change. Populated by checkDelinquencyGuardrail
	// (called from recordEvent for every single event) rather than by a
	// scripted probe, so the proof comes from ordinary population behaviour
	// hitting real delinquent creators, not a scenario built to pass.
	//
	// EXPORTED (2026-07-28, previously unexported `dq`) so a caller outside
	// this package — cmd/sim, a CI gate, a test — can check
	// DeliveryGuardrailExercised() below and treat a vacuous proof as a hard
	// failure instead of a string buried in Summary()'s text. See
	// TestDenseRunProvesDelinquencyGuardrailNonVacuous (upgrades_test.go) for
	// this package's own enforcement of exactly that.
	DQ DelinquencyStats

	haltErr error
	verbose bool
}

// DelinquencyStats — see Engine.DQ's doc. Every counted event captured its
// creator's delinquency standing via core.DeliveryStanding BEFORE the call
// executed (the same read RequireInflowOpen itself performs, at the same
// block, off the same store — see actions.go's captureDelinquent), so
// "AtCall" here means "already delinquent at the moment this call was
// attempted," never a status that only became true afterward (e.g. a Reclaim
// that itself pushes the creator over the miss threshold does NOT count as
// "attempted while delinquent" — it is the call that CAUSES delinquency).
type DelinquencyStats struct {
	PurchaseAttempts              int // ask/buy attempted against an ALREADY-delinquent creator
	PurchaseRefusedForDelinquency int // ... and correctly refused for exactly that reason
	// PurchaseRefusedOther: refused, but by a DIFFERENT guard that ran first
	// (the settlement spend cap, a retiring market, ...). Not a guardrail
	// failure — the purchase was still refused — but it tells us nothing
	// about the delivery gate either way, because it would have been
	// refused with or without it. Tracked separately so a test can assert
	// the exact identity refused+other == attempted (i.e. NOTHING got
	// through) without conflating "refused" with "refused for this reason".
	PurchaseRefusedOther int
	OutflowAttempts               int // payout/renew/shop-config actions attempted against an ALREADY-delinquent creator
	OutflowSucceeded              int // ... and did NOT fail for a delinquency reason (succeeded, or failed for something unrelated)
}

// DeliveryGuardrailExercised reports whether THIS run actually tested the
// standing guardrail — both halves it exists to prove — rather than merely
// finding zero violations because no delinquent creator was ever attempted
// against. A caller that wants "vacuous is a failure, not a silent pass"
// (exactly the posture a CI gate should take — added at an independent
// adversarial review's request, 2026-07-28) should treat a run where this
// returns false as non-passing even though Run() itself returned no error.
func (e *Engine) DeliveryGuardrailExercised() bool {
	return e.DQ.PurchaseAttempts > 0 && e.DQ.PurchaseRefusedForDelinquency > 0 &&
		e.DQ.OutflowAttempts > 0 && e.DQ.OutflowSucceeded > 0
}

// NewEngine builds the store, the population, and every shadow-ledger
// structure, but does not yet schedule or run anything — see Run.
func NewEngine(cfg Config) *Engine {
	pop := NewPopulation(cfg.Seed, cfg.NumCreators, cfg.NumActors)

	keeperProfile := cfg.KeeperProfile
	if keeperProfile == "" {
		keeperProfile = KeeperReliable
	}

	e := &Engine{
		Store:               core.NewMemStore(),
		Block:               genesisBlock,
		Seed:                cfg.Seed,
		pop:                 pop,
		creators:            map[string]*creatorState{},
		creatorNames:        append([]string{}, pop.CreatorNames...),
		holderFavorites:     map[string][]string{},
		holderSlippageBps:   map[string]int64{},
		holderOrder:         map[string][]string{},
		holderSeen:          map[string]map[string]bool{},
		escrows:             map[string]*EscrowShadow{},
		pendingByCreator:    map[string][]string{},
		pendingByAsker:      map[string][]string{},
		oracleWalks:         map[string]*oracleWalkState{},
		treasuryShadow:      zeroBig(),
		heldCommissionTotal: zeroBig(),
		totalHbdIn:          zeroBig(),
		totalHbdOut:         zeroBig(),
		keeperProfile:       keeperProfile,
		adversarialOrder:    cfg.AdversarialOrder,
		verbose:             cfg.Verbose,
	}

	// Bind the platform owner exactly the way contract/main.go's Init does —
	// store.Set("owner", caller) — so core.Owner(e.Store) resolves to this
	// simulator's owner actor and WithdrawTreasury's owner gate accepts it
	// (Upgrade 1 / C2). kOwner() is unexported, so, like the wasm wrapper, we
	// use the same literal key it builds ("owner"); the assertion below makes
	// any future divergence in that key fail loudly at construction rather
	// than silently disarming every treasury withdrawal into an auth error.
	e.Store.Set("owner", pop.OwnerName)
	if core.Owner(e.Store) != pop.OwnerName {
		panic("sim: owner binding failed — core.Owner() does not read the 'owner' key contract/main.go's Init writes; WithdrawTreasury would be un-authorizable")
	}

	config := map[string]string{
		"seed":         fmt.Sprintf("%d", cfg.Seed),
		"days":         fmt.Sprintf("%d", cfg.Days),
		"creators":     fmt.Sprintf("%d", cfg.NumCreators),
		"actors":       fmt.Sprintf("%d", cfg.NumActors),
		"genesisBlock": fmt.Sprintf("%d", genesisBlock),
		"blocksPerDay": fmt.Sprintf("%d", core.BlocksPerDay),
	}
	e.Trace = NewTrace(cfg.Seed, config)

	// Seed per-creator bookkeeping and pick each creator's initial face/cap/
	// abandon-block deterministically, using THAT creator's own RNG (never
	// the master RNG — population construction already finished).
	totalBlocks := uint64(cfg.Days) * core.BlocksPerDay
	for _, name := range pop.CreatorNames {
		actor := pop.Actors[name]
		cs := &creatorState{
			Name:        name,
			Role:        actor.Role,
			InitialFace: randRangeInt64(actor.RNG, 1_000, 50_000), // 1.000 - 50.000 HBD per answer
			// InitialCap: RE-SCALED 2026-07-28 (F6, an adversarial review).
			// The cap denominates TOKENS (core/buy.go: "the cap is
			// deliberate scarcity... under the curve it denominates
			// TOKENS"), but this range (2,000-200,000) was sized as if it
			// still denominated PAR-era HBD-equivalent credits. Measured
			// against this session's own diagnostic sweep (12 configs,
			// 7-270 simulated days, 2-8 creators, matching the review's own
			// independently measured 263-617 across 52 runs): organic final
			// supply tops out in the low hundreds even in the densest
			// config tested (2 creators sharing 40 actors, up to ~650
			// tokens) — nowhere near even the OLD range's floor. The 70%
			// maybeRaiseCap trigger (engine.go) and core.Buy's ErrCap guard
			// were therefore both structurally unreachable regardless of
			// RNG: setCap fired 0 times and ErrCap 0 times across every run
			// measured, old range or new seed.
			//
			// The new range (120-450) is sized to sit in the SAME ORDER OF
			// MAGNITUDE as observed reachable supply, not merely "smaller":
			// re-verified directly (not guessed) against a 12-config,
			// 16-seed sweep of this exact range — setCap fired at least
			// once in 8 of the 10 non-trivial configs (only the shortest,
			// 7-day config never generated enough organic growth to reach
			// even 70% of ANY drawn cap in time), 30 firings total across
			// the sweep, and one run drove a creator's supply to EXACTLY
			// its cap (ratio 1.0000) with no further buy attempted against
			// it in that trace — the hard ErrCap ceiling is genuinely
			// reachable at this range, though it did not fire live in this
			// specific sweep (see this session's own report for why: EVERY
			// buy call site in this simulator pre-clamps its requested
			// token count to the market's remaining cap headroom via
			// maxAffordableTokens, so a buy that WOULD exceed the cap is
			// silently sized down rather than ever attempted — a separate,
			// deliberate "never attempt a doomed call" design choice this
			// finding does not touch, reported honestly rather than papered
			// over by tuning the cap absurdly tight to force a hit).
			// HETEROGENEOUS ON PURPOSE (2026-07-28). A single global range
			// cannot buy both properties this simulator needs:
			//
			//   tight caps  -> supply stays small -> setCap/raise-cap actually
			//                  fire, but the settlement spend cap ("no ask may
			//                  spend >5% of supply") then binds on nearly every
			//                  ask, so escrows stop being created at all;
			//   loose caps  -> markets get deep enough to sustain asks (and
			//                  therefore expiries, and therefore the
			//                  permissionless reclaims the H1 no-keeper
			//                  fail-safe proof depends on), but supply never
			//                  approaches the cap so setCap never fires.
			//
			// Measured, seed 1 / 90d / 4 creators / keeper-absent: at a global
			// [120,450] the run produced 11 asks and ZERO reclaims (every ask
			// answered or declined), which silently broke
			// TestKeeperAbsentFailSafesHold; at a global [2_000,200_000] it
			// produced a reclaim but setCap never fired in any run.
			//
			// So draw a MIX: roughly one creator in three is cap-constrained,
			// the rest are deep. Both code paths are then exercised by the same
			// population instead of being traded off against each other.
			InitialCap: func() int64 {
				if actor.RNG.Intn(3) == 0 {
					return randRangeInt64(actor.RNG, 120, 450) // cap-constrained
				}
				return randRangeInt64(actor.RNG, 2_000, 200_000) // deep
			}(),
			PaidInTotal: zeroBig(),
		}
		switch {
		case actor.Role == RoleCreatorAbandoner:
			// Abandon somewhere in the first 15%-55% of the run, leaving
			// room for the full lapse ladder (OVERDUE -> FROZEN -> wind-
			// down) plus keeper sweeps to actually play out and be observed
			// before the run ends, on any horizon from a week upward. On a
			// 1-day run this will simply not complete within the horizon —
			// that is a valid, honest, reportable outcome, not a bug.
			frac := 0.15 + actor.RNG.Float64()*0.40
			cs.AbandonBlock = genesisBlock + uint64(frac*float64(totalBlocks))
		case actor.Role == RoleCreatorFlaky && actor.RNG.Float64() < 0.30:
			// ~30% of flaky creators eventually stop being merely late and
			// just stop entirely, later in the run (30%-70%) — a flaky
			// creator's neglect compounding into abandonment, reusing the
			// exact same downstream machinery (creatorTick/answer-
			// scheduling both key off AbandonBlock uniformly regardless of
			// which role produced it).
			frac := 0.30 + actor.RNG.Float64()*0.40
			cs.AbandonBlock = genesisBlock + uint64(frac*float64(totalBlocks))
		}
		if cs.AbandonBlock != 0 {
			// Roughly half of abandoning creators (Abandoner, and the ~30% of
			// Flaky creators who eventually stop entirely) choose to formally
			// Retire at that point instead of silently ghosting -- a distinct,
			// equally realistic shutdown shape (RULING D/K3's irreversible
			// notice) this simulator must drive too: it closes inflows,
			// INCLUDING the curve rail, IMMEDIATELY -- even during the 5-day
			// notice window -- rather than riding out the natural OVERDUE
			// grace the silent-ghost path still gets. The other half keep the
			// pre-existing silent-ghost behaviour, so both shutdown shapes
			// stay covered by the same population.
			cs.RetireOnAbandon = actor.RNG.Float64() < 0.5
		} else if actor.Role == RoleCreatorReliable && actor.RNG.Float64() < 0.20 {
			// A minority of reliable creators retire VOLUNTARILY, late in the
			// run, with a clean delivery record -- a graceful shutdown
			// distinct from abandonment: still renews and answers everything
			// up to the point they retire, never delinquent, but chooses to
			// stop taking new business. Exercises Retire on a HEALTHY market,
			// not just a neglected one.
			frac := 0.70 + actor.RNG.Float64()*0.25
			cs.VoluntaryRetireBlock = genesisBlock + uint64(frac*float64(totalBlocks))
		}
		e.creators[name] = cs
	}

	// Wire each holder-actor's sticky preferences, using ONLY that actor's
	// own RNG (never the master RNG, which population construction already
	// finished with) — see the determinism note.
	for _, name := range pop.HolderNames {
		actor := pop.Actors[name]
		switch actor.Role {
		case RoleFan:
			e.holderFavorites[name] = pickFavorites(actor.RNG, e.creatorNames, 3)
			e.holderSlippageBps[name] = pickSlippageBps(actor.RNG)
		case RoleOneShot:
			e.holderFavorites[name] = pickFavorites(actor.RNG, e.creatorNames, 1)
			e.holderSlippageBps[name] = pickSlippageBps(actor.RNG)
		case RoleTrader:
			e.holderFavorites[name] = pickFavorites(actor.RNG, e.creatorNames, 2)
		case RoleSpeculator:
			// Deliberately no fixed favorites: speculators sample the full
			// creator list fresh on every decision (actions.go).
		}
	}

	return e
}

// pickFavorites draws up to n distinct creator names from names, using rng.
// A simple Fisher-Yates partial shuffle on a local copy — deterministic
// given rng's state, touches nothing shared.
func pickFavorites(rng *rand.Rand, names []string, n int) []string {
	if n > len(names) {
		n = len(names)
	}
	if n <= 0 || len(names) == 0 {
		return nil
	}
	pool := append([]string{}, names...)
	for i := 0; i < n; i++ {
		j := i + rng.Intn(len(pool)-i)
		pool[i], pool[j] = pool[j], pool[i]
	}
	return append([]string{}, pool[:n]...)
}

// pickSlippageBps draws an asker's maxCredits slippage buffer: usually a
// comfortable 3%-8%, but ~10% of the time a razor-thin 0.3%-0.7% — deliberate
// variety so this simulator organically exercises the maxCredits guard
// (ask.go's slippage cap) under real price drift between an ask's quote and
// its execution (see actions.go's askIntent), not just the happy path.
func pickSlippageBps(rng *rand.Rand) int64 {
	if rng.Float64() < 0.10 {
		return randRangeInt64(rng, 30, 70)
	}
	return randRangeInt64(rng, 300, 800)
}

// halt records the first invariant violation this run hits and freezes
// further processing (checked at the top of Run's loop and inside every
// multi-step tick). Idempotent: only the FIRST violation is kept, since
// everything downstream of it is potentially garbage.
func (e *Engine) halt(reason string, triggerEv *Event) {
	if e.haltErr != nil {
		return
	}
	var ev Event
	if triggerEv != nil {
		ev = *triggerEv
	}
	e.haltErr = &InvariantViolation{Seed: e.Seed, Reason: reason, Event: ev}
}

// schedule pushes fn to run at block (or as soon as possible after, if the
// heap is popped past that point — never: the engine always advances Block
// to exactly the popped item's block before running it).
func (e *Engine) schedule(block uint64, label string, fn func(*Engine)) {
	e.seqCounter++
	heap.Push(&e.heap, &scheduledItem{block: block, seq: e.seqCounter, prio: e.orderPrio(label), label: label, fn: fn})
}

// orderPrio returns the intra-block ordering priority for a label. In the
// default (FIFO) mode every label returns 0, so ordering collapses to
// (block, seq) exactly as before. Under Config.AdversarialOrder (Upgrade 3b)
// it models a hostile block producer: the creator's own actions run FIRST at
// a given block (so a SetFace drop lands before a victim's ask), and ask
// executions run LAST — reproducing the SetFace-before-ask sandwich the H2
// exact-commission guard exists to reject. Deterministic: a pure function of
// the label and the fixed-at-construction config.
func (e *Engine) orderPrio(label string) int {
	if !e.adversarialOrder {
		return 0
	}
	switch label {
	case "setFace-adversarial", "creator-tick", "oracle-tick":
		return -1 // producer front-runs the creator's / oracle's own moves
	case "ask-execute", "oneshot-ask":
		return 1 // the victim's ask executes only after any same-block face change
	default:
		return 0
	}
}

// activityMultiplier models a realistic daily/weekly usage curve: quiet
// overnight, ramping through the morning, an evening peak, and lighter
// weekends. It is a SCALE FACTOR on inter-arrival time (engine.nextInterval
// divides by it), so low-activity periods stretch the gap between an
// actor's actions and high-activity periods compress it — this is what
// produces clustering/bursts instead of uniform lockstep ticking.
func activityMultiplier(block uint64) float64 {
	blocksPerHour := core.BlocksPerDay / 24
	hour := int((block % core.BlocksPerDay) / blocksPerHour)
	day := (block - genesisBlock) / core.BlocksPerDay
	weekday := int(day % 7) // 0=first simulated day's weekday, arbitrary reference epoch

	hourly := [24]float64{
		0.10, 0.07, 0.05, 0.05, 0.06, 0.10, // 00-05: overnight quiet
		0.25, 0.45, 0.70, 0.85, 0.95, 1.00, // 06-11: morning ramp
		1.05, 1.00, 0.95, 0.90, 0.95, 1.05, // 12-17: daytime plateau
		1.20, 1.30, 1.15, 0.80, 0.45, 0.20, // 18-23: evening peak, taper
	}
	mult := hourly[hour]
	if weekday == 5 || weekday == 6 { // weekend: lighter overall traffic
		mult *= 0.70
	}
	return mult
}

// nextInterval draws how many blocks until an actor's next tick, given a
// base cadence and the current block's activity level. A uniform jitter
// factor around the base keeps actors sharing a nominal cadence from
// marching in lockstep.
func nextInterval(rng *rand.Rand, baseCadence uint64, atBlock uint64) uint64 {
	mult := activityMultiplier(atBlock)
	if mult < 0.05 {
		mult = 0.05
	}
	jitter := 0.5 + rng.Float64() // [0.5, 1.5)
	f := float64(baseCadence) * jitter / mult
	if f < 1 {
		f = 1
	}
	return uint64(f)
}

// Run drives the simulation for the configured number of days from
// genesisBlock, processing the scheduler strictly in block order. It stops
// early (returning the *InvariantViolation) the instant any invariant
// check fails — "halt loudly," never continue past a broken invariant.
func (e *Engine) Run(days int) error {
	e.endBlock = genesisBlock + uint64(days)*core.BlocksPerDay
	e.scheduleInitialEvents()

	for e.heap.Len() > 0 {
		item := heap.Pop(&e.heap).(*scheduledItem)
		if item.block > e.endBlock {
			break
		}
		e.Block = item.block
		item.fn(e)
		if e.haltErr != nil {
			return e.haltErr
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Shadow-ledger maintenance shared by every action in actions.go.

// addHolder records that holder now (or already did) hold a balance in
// creator's market, in first-observed order. Idempotent.
func (e *Engine) addHolder(creator, holder string) {
	if e.holderSeen[creator] == nil {
		e.holderSeen[creator] = map[string]bool{}
	}
	if e.holderSeen[creator][holder] {
		return
	}
	e.holderSeen[creator][holder] = true
	e.holderOrder[creator] = append(e.holderOrder[creator], holder)
}

func (e *Engine) addEscrow(rec *EscrowShadow) {
	key := escrowKey(rec.Creator, rec.Seq)
	e.escrows[key] = rec
	e.pendingByCreator[rec.Creator] = append(e.pendingByCreator[rec.Creator], key)
	e.pendingByAsker[rec.Asker] = append(e.pendingByAsker[rec.Asker], key)
	e.heldCommissionTotal = addBig(e.heldCommissionTotal, rec.CommissionHbd)
}

// resolveEscrow marks an escrow ANSWERED or RECLAIMED and moves its held
// commission out of heldCommissionTotal — into treasuryShadow (answered) or
// back out to the asker's wallet, which the caller (actions.go) handles
// separately since it also needs to touch totalHbdOut.
func (e *Engine) resolveEscrow(creator string, seq uint64, status string) *EscrowShadow {
	key := escrowKey(creator, seq)
	rec := e.escrows[key]
	if rec == nil {
		return nil // should be unreachable: only called right after a successful core.Answer/Reclaim
	}
	rec.Status = status
	e.heldCommissionTotal = subBig(e.heldCommissionTotal, rec.CommissionHbd)
	return rec
}

func (e *Engine) newEvent(action, actor, creator string) *Event {
	role := ""
	if a, ok := e.pop.Actors[actor]; ok {
		role = string(a.Role)
	}
	return &Event{
		Block:   e.Block,
		Day:     int((e.Block - genesisBlock) / core.BlocksPerDay),
		Actor:   actor,
		Role:    role,
		Action:  action,
		Creator: creator,
		Args:    map[string]string{},
		Deltas:  map[string]string{},
	}
}

// recordEvent appends ev to the trace and runs the full invariant sweep.
func (e *Engine) recordEvent(ev *Event) {
	e.Trace.AddEvent(*ev)
	e.checkDelinquencyGuardrail(ev)
	if e.haltErr != nil {
		return
	}
	e.checkInvariants(ev)
}

// creatorWindingDown mirrors core/market.go's private inWindDown() from the
// PUBLIC surface this package can reach (core.RetiredAt + core.Phase): true
// once Retire has fired (even during its 5-day OVERDUE notice -- K3) or the
// market is naturally FROZEN/CLOSED. This is exactly the predicate that
// switches Sell (sell.go) off and Refund/RefundHolder (refund.go) on, and the
// one R===Area(S) stops being an equality at (see checkInvariants below) --
// used by both so the sim's own notion of "which exit rail is open" can never
// drift from the invariant sweep's notion of "should the curve equality still
// hold here."
func (e *Engine) creatorWindingDown(creator string) bool {
	if _, retired := core.RetiredAt(e.Store, creator); retired {
		return true
	}
	switch core.Phase(e.Store, creator, e.Block) {
	case core.StateFrozen, core.StateClosed:
		return true
	default:
		return false
	}
}

// checkDelinquencyGuardrail is the LIVE proof of delivery.go's standing
// guardrail: "delinquency and billing state may refuse purchases but must
// NEVER block a payout or a subscription payment." Every wrapper that can
// target a creator whose delivery standing might matter captures
// ev.Args["creatorDelinquent"] = "true"/"false" BEFORE invoking core (see
// actions.go's captureDelinquent) -- the same (store, block) RequireInflowOpen
// itself reads, so this is never a stale or racy snapshot.
//
//   - "ask"/"buy" (the two flows RequireInflowOpen actually gates,
//     core/delivery.go/buy.go/ask.go): succeeding while ALREADY delinquent is
//     impossible if the gate works -- an immediate HALT, not a soft flag,
//     because it directly disproves "delinquency refuses purchases."
//   - every other captured action (answer/decline/reclaim/sell/refund/
//     refundHolder/claimTradeFees/renew/retire/the four offering-catalogue
//     writers) never calls RequireInflowOpen at all (verified reading
//     core/ask.go, core/sell.go, core/refund.go, core/tradefee.go,
//     core/market.go's requireMarketAcceptsMoney, core/offerings.go's
//     requireShopEditable/requireOpenCreatorMarket) -- so a failure whose
//     ErrMsg blames delinquency here would mean one of those files started
//     consulting delivery standing, which is exactly the guardrail breaking.
//     Also an immediate HALT.
//
// Both counters are exported via Summary() so a run reports HOW MUCH of this
// was actually exercised, not just "zero violations" (which would be equally
// true of a creator population that never got near delinquency at all).
//
// The OUTFLOW branch's HALT keys on core.ErrDelinquent — see that symbol's
// doc in core/errors.go for why a text match was not good enough.
func (e *Engine) checkDelinquencyGuardrail(ev *Event) {
	if ev.Args["creatorDelinquent"] != "true" {
		return
	}
	switch ev.Action {
	case "ask", "buy":
		e.DQ.PurchaseAttempts++
		if ev.OK {
			e.halt(fmt.Sprintf(
				"DELIVERY-GATE VIOLATION: %s by %s against creator=%s SUCCEEDED while the creator was already delinquent on delivery at call time -- RequireInflowOpen's delivery gate should have refused this purchase",
				ev.Action, ev.Actor, ev.Creator), ev)
			return
		}
		if ev.ErrSym == core.ErrDelinquent {
			e.DQ.PurchaseRefusedForDelinquency++
		} else {
			e.DQ.PurchaseRefusedOther++
		}
	case "answer", "decline", "reclaim", "sell", "refund", "refundHolder", "claimTradeFees", "renew", "retire",
		"createOffering", "setOfferingPrice", "setOfferingTitle", "deleteOffering":
		e.DQ.OutflowAttempts++
		if ev.OK || ev.ErrSym != core.ErrDelinquent {
			e.DQ.OutflowSucceeded++
			return
		}
		e.halt(fmt.Sprintf(
			"STANDING-GUARDRAIL VIOLATION: %s by %s against creator=%s was REFUSED because the creator is delinquent on delivery (%s: %s) -- delinquency must never block a payout, a subscription payment, or a shop-config change",
			ev.Action, ev.Actor, ev.Creator, ev.ErrSym, ev.ErrMsg), ev)
	}
}

// snapshotStore captures every key/value currently in the store. Used only
// to prove a REJECTED core call left state untouched (coreCall in
// actions.go) — a full copy is affordable at this population's scale and is
// worth the certainty over spot-checking a few keys.
func (e *Engine) snapshotStore() map[string]string {
	keys := e.Store.Keys()
	m := make(map[string]string, len(keys))
	for _, k := range keys {
		v, _ := e.Store.Get(k)
		m[k] = v
	}
	return m
}

func diffEqual(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if bv, ok := b[k]; !ok || bv != v {
			return false
		}
	}
	return true
}

// ---------------------------------------------------------------------------
// Invariant sweep — runs after EVERY recorded event, successful or not.
//
//	I1 solvency / "reserve never exceeds what was paid in": reserve(c) is
//	   checked against this simulator's own running total of HBD ever
//	   prepaid into c's reserve (the only path that increases it — see
//	   core/refund.go's own I1 proof, which this independently corroborates
//	   from the caller's side rather than core's).
//	I3 supply == Σ balances + escrowed credits, per creator, read straight
//	   from core (core.Supply, core.BalanceOf) against this simulator's own
//	   holder registry and escrow shadow.
//	HBD conservation: total HBD ever drawn from an actor's wallet into the
//	   contract equals total HBD ever paid back out, plus every creator's
//	   live reserve, plus the shadow treasury, plus HBD currently held in
//	   open escrows awaiting Answer/Reclaim.
//
// I2 (refund <= PAR) and I5 (no commission on refunds) are structural
// properties of core's own payout formula and Reclaim's full-commission
// return respectively — this sweep does not re-derive them independently,
// but every refund/reclaim payout this simulator ever records (Deltas) is
// available for the analysis layer to check against RefundRatioBps itself.
func (e *Engine) checkInvariants(triggerEv *Event) {
	if e.haltErr != nil {
		return
	}

	for _, cname := range e.creatorNames {
		supply := core.Supply(e.Store, cname)

		sumBal := zeroBig()
		for _, h := range e.holderOrder[cname] {
			sumBal = addBig(sumBal, core.BalanceOf(e.Store, cname, h))
		}
		escrowed := zeroBig()
		for _, key := range e.pendingByCreator[cname] {
			if rec := e.escrows[key]; rec != nil && rec.Status == escrowPending {
				escrowed = addBig(escrowed, rec.Credits)
			}
		}
		total := addBig(sumBal, escrowed)
		if cmpBig(supply, total) != 0 {
			e.halt(fmt.Sprintf(
				"I3 VIOLATION creator=%s: core.Supply=%s but Sigma(balances)=%s + escrowed(pending)=%s = %s",
				cname, bigStr(supply), bigStr(sumBal), bigStr(escrowed), bigStr(total),
			), triggerEv)
			return
		}

		reserve := core.Reserve(e.Store, cname)
		paidIn := e.creators[cname].PaidInTotal
		if cmpBig(reserve, paidIn) > 0 {
			e.halt(fmt.Sprintf(
				"RESERVE-EXCEEDS-PAID-IN creator=%s: reserve=%s > cumulative HBD ever prepaid=%s",
				cname, bigStr(reserve), bigStr(paidIn),
			), triggerEv)
			return
		}

		// R === Area(S) EXACTLY (C-9, THE governing invariant -- core/curve.go's
		// Area doc, core/buy.go's and core/sell.go's own induction proofs) --
		// asserted directly here rather than assumed from reading core, and
		// ONLY while the curve rail is actually the open rail for this creator
		// (creatorWindingDown false): Buy/Sell maintain the equality
		// inductively from the S=0,R=0 genesis, but the wind-down rail
		// (Refund/RefundHolder, refund.go) deliberately pays flat PRO-RATA
		// (floor(R*credits/S)), which is NOT the curve's own area step and is
		// not supposed to preserve equality -- that is the entire mechanism
		// the governing theorem relies on (a fresh buyer's payout is provably
		// LESS than a curve-shaped payout would be, which is exactly R
		// drifting away from Area(S) in the conservative direction). Checking
		// this unconditionally would flag CORRECT wind-down behaviour as a
		// violation; checking it only pre-wind-down is what actually proves
		// C-9, not a weaker substitute for it.
		if !e.creatorWindingDown(cname) {
			area := core.Area(supply)
			if cmpBig(reserve, area) != 0 {
				e.halt(fmt.Sprintf(
					"R!=AREA(S) VIOLATION creator=%s: reserve=%s != Area(supply=%s)=%s (curve rail still open -- Buy/Sell must maintain this exactly)",
					cname, bigStr(reserve), bigStr(supply), bigStr(area),
				), triggerEv)
				return
			}
		}
	}

	reserveTotal := zeroBig()
	// FIXED 2026-07-21: the identity was missing a whole resting bucket —
	// the creators' PULL-claimable trade-fee halves (kFeeBal, RULING F8).
	// The 10% trade fee splits 5/5; the platform half lands in the treasury
	// (mirrored into treasuryShadow) and the CREATOR half accrues to
	// kFeeBal, which is neither reserve nor treasury and is drawn from the
	// buyer's wallet all the same — so every trade made the check fail by
	// exactly that half. Global solvency is:
	//   in == out + Σ reserve + treasury + Σ heldCommission + Σ feePots
	feePotsTotal := zeroBig()
	for _, cname := range e.creatorNames {
		reserveTotal = addBig(reserveTotal, core.Reserve(e.Store, cname))
		feePotsTotal = addBig(feePotsTotal, core.FeeBalanceOf(e.Store, cname))
	}
	rhs := addBig(addBig(e.totalHbdOut, reserveTotal), addBig(e.treasuryShadow, e.heldCommissionTotal))
	rhs = addBig(rhs, feePotsTotal)
	if cmpBig(e.totalHbdIn, rhs) != 0 {
		e.halt(fmt.Sprintf(
			"HBD-CONSERVATION VIOLATION: totalHbdIn=%s != totalHbdOut(%s)+Sigma(reserve)(%s)+treasury(%s)+heldCommission(%s)+feePots(%s) = %s",
			bigStr(e.totalHbdIn), bigStr(e.totalHbdOut), bigStr(reserveTotal), bigStr(e.treasuryShadow), bigStr(e.heldCommissionTotal), bigStr(feePotsTotal), bigStr(rhs),
		), triggerEv)
		return
	}
}

// coreCall runs fn — a closure invoking exactly one core.* mutator — records
// OK/ErrSym/ErrMsg on ev, and, on rejection, verifies via a full store
// snapshot diff that NOTHING was mutated. Several core comments assert this
// property explicitly for specific paths (e.g. refund.go's
// TestRefund_RejectedCallLeavesStateUntouched); this checks it empirically,
// for every single call this simulator ever makes, successful or not.
func (e *Engine) coreCall(label string, ev *Event, fn func() error) {
	before := e.snapshotStore()
	err := fn()
	ev.OK = err == nil
	if err == nil {
		return
	}
	if cerr, ok := err.(*core.Err); ok {
		ev.ErrSym = cerr.Symbol
		ev.ErrMsg = cerr.Msg
	} else {
		ev.ErrSym = "SIM_UNKNOWN_ERR"
		ev.ErrMsg = err.Error()
	}
	after := e.snapshotStore()
	if !diffEqual(before, after) {
		e.halt(fmt.Sprintf("%s: core call was REJECTED (%s: %s) but mutated store state -- CEI violation", label, ev.ErrSym, ev.ErrMsg), ev)
	}
}

// ---------------------------------------------------------------------------
// Summary — a human-readable end-of-run report. Purely a read over the
// trace already produced plus final live-store reads; touches nothing.

// Summary renders a multi-section, human-readable report: population
// composition, action counts (attempted/succeeded/failed), a failure-symbol
// histogram, per-creator final state, and the closing HBD ledger this run's
// invariant sweep was checking on every single event.
func (e *Engine) Summary() string {
	var b strings.Builder

	fmt.Fprintf(&b, "=== Magi Creator Keys population simulation ===\n")
	fmt.Fprintf(&b, "seed=%d  genesisBlock=%d  finalBlock=%d  finalDay=%d  endBlock(planned)=%d\n",
		e.Seed, genesisBlock, e.Block, int((e.Block-genesisBlock)/core.BlocksPerDay), e.endBlock)
	fmt.Fprintf(&b, "population: %d creators, %d actors, 1 keeper(%s), 1 owner, %d oracle feed(s)\n",
		len(e.creatorNames), len(e.pop.HolderNames), e.keeperProfile, len(e.pop.OracleForCreator))
	if e.adversarialOrder {
		fmt.Fprintf(&b, "intra-block order: ADVERSARIAL (producer front-runs creator/oracle moves ahead of ask executions)\n")
	}
	fmt.Fprintln(&b)

	fmt.Fprintf(&b, "-- creator roster --\n")
	for _, name := range e.creatorNames {
		cs := e.creators[name]
		ab := "never"
		if cs.AbandonBlock != 0 {
			ab = fmt.Sprintf("block %d (day %d)", cs.AbandonBlock, int((cs.AbandonBlock-genesisBlock)/core.BlocksPerDay))
		}
		fmt.Fprintf(&b, "  %-28s role=%-20s abandonBlock=%s\n", name, cs.Role, ab)
	}
	fmt.Fprintln(&b)

	// ---- action counts ----
	type actionStat struct {
		attempted, ok, failed int
		errSyms               map[string]int
	}
	stats := map[string]*actionStat{}
	actionOrder := []string{}
	for _, ev := range e.Trace.Events {
		st, seen := stats[ev.Action]
		if !seen {
			st = &actionStat{errSyms: map[string]int{}}
			stats[ev.Action] = st
			actionOrder = append(actionOrder, ev.Action)
		}
		st.attempted++
		if ev.OK {
			st.ok++
		} else {
			st.failed++
			st.errSyms[ev.ErrSym]++
		}
	}
	sort.Strings(actionOrder)

	fmt.Fprintf(&b, "-- action outcomes (%d events total) --\n", len(e.Trace.Events))
	for _, action := range actionOrder {
		st := stats[action]
		fmt.Fprintf(&b, "  %-16s attempted=%-6d ok=%-6d failed=%-6d\n", action, st.attempted, st.ok, st.failed)
		if len(st.errSyms) > 0 {
			symOrder := make([]string, 0, len(st.errSyms))
			for s := range st.errSyms {
				symOrder = append(symOrder, s)
			}
			sort.Strings(symOrder)
			for _, s := range symOrder {
				fmt.Fprintf(&b, "      %-14s x%d\n", s, st.errSyms[s])
			}
		}
	}
	fmt.Fprintln(&b)

	// ---- offering-ask coverage (F7, an adversarial review) ----
	//
	// EscrowShadow.OfferingID (declared alongside the struct's other fields
	// above) was write-only until this fix: set on every successful ask
	// (doAskExecute, actions.go) and never read anywhere — the review's own
	// finding. e.escrows retains EVERY escrow this run ever opened, keyed by
	// "creator|seq" (addEscrow appends, resolveEscrow only flips Status —
	// nothing ever deletes an entry), so iterating it here is a complete,
	// order-independent tally: exactly what this section needs (a count),
	// never a per-item ordering the map's own non-determinism could disturb.
	// This is also what the field was FOR, per pickAskTarget's own doc: it
	// exists so a real run can show whether offeringID != 0 (the named-
	// offering shop path, offerings.go) is actually being exercised, not
	// just picked and then silently dropped before reaching an ask.
	offeringAsks, legacyFaceAsks := 0, 0
	for _, rec := range e.escrows {
		if rec.OfferingID != 0 {
			offeringAsks++
		} else {
			legacyFaceAsks++
		}
	}
	fmt.Fprintf(&b, "-- offering-ask coverage (F7: EscrowShadow.OfferingID) --\n")
	fmt.Fprintf(&b, "  asks opened: %d total (%d against a named offering, %d against the legacy face price)\n",
		offeringAsks+legacyFaceAsks, offeringAsks, legacyFaceAsks)
	fmt.Fprintln(&b)

	// ---- per-creator final state ----
	fmt.Fprintf(&b, "-- final per-creator state (block %d) --\n", e.Block)
	for _, name := range e.creatorNames {
		phase := core.Phase(e.Store, name, e.Block)
		fmt.Fprintf(&b, "  %-28s phase=%-7s reserve=%-10s supply=%-10s refundRatioBps=%-5d escrowsOpened=%d holders=%d\n",
			name, phase, bigStr(core.Reserve(e.Store, name)), bigStr(core.Supply(e.Store, name)),
			core.RefundRatioBps(e.Store, name), core.EscrowSeq(e.Store, name), len(e.holderOrder[name]))
	}
	fmt.Fprintln(&b)

	// ---- HBD ledger ----
	reserveTotal := zeroBig()
	for _, name := range e.creatorNames {
		reserveTotal = addBig(reserveTotal, core.Reserve(e.Store, name))
	}
	fmt.Fprintf(&b, "-- HBD ledger (invariant checked after every single event) --\n")
	fmt.Fprintf(&b, "  totalHbdIn          = %s\n", bigStr(e.totalHbdIn))
	fmt.Fprintf(&b, "  totalHbdOut         = %s\n", bigStr(e.totalHbdOut))
	fmt.Fprintf(&b, "  Sigma(reserve)      = %s\n", bigStr(reserveTotal))
	fmt.Fprintf(&b, "  treasuryShadow      = %s (live core treasury; owner-withdrawable, C2)\n", bigStr(e.treasuryShadow))
	fmt.Fprintf(&b, "  ownerWithdrawnTotal = %s (accrued to owner-1 via WithdrawTreasury)\n", bigStr(e.pop.Actors[e.pop.OwnerName].HBD))
	fmt.Fprintf(&b, "  heldCommissionTotal = %s\n", bigStr(e.heldCommissionTotal))
	feePotsTotal := zeroBig()
	for _, name := range e.creatorNames {
		feePotsTotal = addBig(feePotsTotal, core.FeeBalanceOf(e.Store, name))
	}
	fmt.Fprintf(&b, "  feePotsTotal        = %s (creators' pull-claimable trade-fee halves, F8)\n", bigStr(feePotsTotal))
	rhs := addBig(addBig(e.totalHbdOut, reserveTotal), addBig(e.treasuryShadow, e.heldCommissionTotal))
	rhs = addBig(rhs, feePotsTotal)
	fmt.Fprintf(&b, "  in == out+reserve+treasury+held+feePots? %v  (%s == %s)\n", cmpBig(e.totalHbdIn, rhs) == 0, bigStr(e.totalHbdIn), bigStr(rhs))
	fmt.Fprintln(&b)

	// ---- delivery-gate standing guardrail (core/delivery.go) ----
	//
	// HEADER WORDING FIX (2026-07-28, flagged by an independent adversarial
	// review): this used to unconditionally print "(live-proven, not
	// assumed)" and only ADMIT vacuity in a note several lines further down —
	// a real, embarrassing contradiction for exactly the run that most needs
	// the honest answer (a vacuous one). The header itself now reflects
	// e.DeliveryGuardrailExercised(), so the headline claim can never
	// contradict the counters printed directly under it.
	if e.DeliveryGuardrailExercised() {
		fmt.Fprintf(&b, "-- delivery-gate standing guardrail (live-proven, not assumed) --\n")
	} else {
		fmt.Fprintf(&b, "-- delivery-gate standing guardrail (NOT PROVEN THIS RUN — see counters and NOTE below) --\n")
	}
	fmt.Fprintf(&b, "  purchases (ask/buy) attempted against an already-delinquent creator: %d\n", e.DQ.PurchaseAttempts)
	fmt.Fprintf(&b, "  ... correctly refused for exactly that reason:                       %d\n", e.DQ.PurchaseRefusedForDelinquency)
	fmt.Fprintf(&b, "  ... refused by a different guard that ran first (spend cap, ...):   %d\n", e.DQ.PurchaseRefusedOther)
	fmt.Fprintf(&b, "  payouts/renew/shop-config attempted against an already-delinquent creator: %d\n", e.DQ.OutflowAttempts)
	fmt.Fprintf(&b, "  ... none blocked by delinquency (succeeded or failed for an unrelated reason): %d\n", e.DQ.OutflowSucceeded)
	if e.DQ.PurchaseAttempts == 0 {
		fmt.Fprintf(&b, "  NOTE: zero purchases were ever attempted against a delinquent creator in this run --\n")
		fmt.Fprintf(&b, "        the \"delinquency refuses purchases\" half is UNPROVEN here, not because it failed but because it was never tested.\n")
	}
	if e.DQ.OutflowAttempts == 0 {
		fmt.Fprintf(&b, "  NOTE: zero non-purchase actions were ever attempted against a delinquent creator in this run --\n")
		fmt.Fprintf(&b, "        the standing guardrail held VACUOUSLY here, not because it was exercised. See coverage.\n")
	}

	if e.haltErr != nil {
		fmt.Fprintf(&b, "\n*** RUN HALTED: %v ***\n", e.haltErr)
	}

	return b.String()
}
