package sim

import (
	"fmt"
	"math/big"
	"sort"

	"hive-price-market/market"
)

// KeeperProfile is the behaviour of the off-chain settle keeper being
// simulated for a given run. Rolling (opening new rounds) is kept EQUALLY
// prompt across all three profiles on purpose — that isolates the one
// variable this simulator is built to measure: how settle-timeliness alone
// drives the VOID rate, since rolling has no window/no timing pressure and
// settling does.
type KeeperProfile int

const (
	KeeperReliable KeeperProfile = iota
	KeeperLate
	KeeperAbsent
)

func (p KeeperProfile) String() string {
	switch p {
	case KeeperReliable:
		return "reliable"
	case KeeperLate:
		return "late"
	case KeeperAbsent:
		return "absent"
	default:
		return "unknown"
	}
}

// Config drives one simulation run. See DefaultConfig for the tuned
// population/oracle defaults used by `go run ./cmd/marketsim`.
type Config struct {
	Seed   int64
	Weeks  int
	Keeper KeeperProfile

	NumSharp, NumCasual, NumWhale, NumSpreader, NumNoShow, NumLatecomer int
	SpreaderBucketsPerActor                                             int

	SharpParticipation     float64
	CasualParticipation    float64
	WhaleParticipation     float64
	SpreaderParticipation  float64
	NoShowParticipation    float64
	LatecomerParticipation float64
	ForgetProb             float64 // extra chance a non-no-show winner/refundee just never claims

	Oracle OracleConfig

	RollLatencyMaxBlocks                      uint64
	ReliablePollLatencyMaxBlocks              uint64
	LateDelayMean1, LateDelayStdev1           float64
	LateSecondAttemptProb                     float64
	LateDelayExtraMean2, LateDelayExtraStdev2 float64
	ReclaimDelayMaxBlocks                     uint64

	TracePath string // if non-empty, Run's caller may dump the tracer here
}

func DefaultConfig() Config {
	return Config{
		Seed:  42,
		Weeks: 52,

		NumSharp:                6,
		NumCasual:               45,
		NumWhale:                3,
		NumSpreader:             4,
		NumNoShow:               12,
		NumLatecomer:            5,
		SpreaderBucketsPerActor: 3,

		SharpParticipation:     0.85,
		CasualParticipation:    0.6,
		WhaleParticipation:     0.35,
		SpreaderParticipation:  0.5,
		NoShowParticipation:    0.7,
		LatecomerParticipation: 0.5,
		ForgetProb:             0.05,

		Oracle: DefaultOracleConfig(),

		RollLatencyMaxBlocks:         300,
		ReliablePollLatencyMaxBlocks: 80,
		// LateDelayMean1/Stdev1 are tuned so a "late" keeper's single attempt
		// lands within the outer SettleWindowBlocks(1200) window almost
		// always (so it usually self-resolves without needing Reclaim), but
		// only catches the single ~100-block qualifying tick a modest
		// fraction of the time (~1/4) — deliberately "late", not "absent":
		// it produces a materially higher VOID rate than reliable (mostly
		// via tick_window_missed) while still mostly avoiding the Reclaim
		// fail-safe, distinguishing it cleanly from the absent profile.
		LateDelayMean1:        180,
		LateDelayStdev1:       250,
		LateSecondAttemptProb: 0.4,
		LateDelayExtraMean2:   3000,
		LateDelayExtraStdev2:  2500,
		ReclaimDelayMaxBlocks: 20000,
	}
}

// participant is one account that successfully placed a bet in a round, kept
// for the post-resolution claim/reclaim pass.
type participant struct {
	Account     string
	Logical     string
	Role        Role
	NeverClaims bool
}

// Report summarises one completed simulation run.
type Report struct {
	Seed          int64
	KeeperProfile string
	Weeks         int

	RoundsRolled        int
	RoundsSkippedNoRoll int
	RoundsSettled       int
	RoundsVoid          int
	RoundsVoidByReason  map[string]int

	ResolvedViaSettleCall int
	ResolvedViaVoidStale  int
	ResolvedViaReclaim    int

	TotalStaked *big.Int
	TotalPaid   *big.Int // claims + reclaims paid to actors
	TotalSwept  *big.Int // sent to the DHF

	RejectedLateBets      int
	RejectedDoubleClaims  int
	UnresolvedRoundsAtEnd int

	ActorPnL  map[string]*big.Int
	ActorRole map[string]string

	TraceEvents int
}

func (r *Report) VoidRate() float64 {
	total := r.RoundsSettled + r.RoundsVoid
	if total == 0 {
		return 0
	}
	return float64(r.RoundsVoid) / float64(total)
}

// Simulator drives one full run against a fresh in-memory market.Store.
type Simulator struct {
	cfg    Config
	store  market.Store
	oracle *Oracle
	tracer *Tracer
	ledger *Ledger
	roster []actorSpec

	block uint64 // monotonic frontier: the highest block any action has used so far

	roundsRolled        int
	roundsSkippedNoRoll int
	roundsSettled       int
	roundsVoidByReason  map[string]int
	resolvedViaSettle   int
	resolvedViaVoid     int
	resolvedViaReclaim  int
	rejectedLateBets    int
	rejectedDoubleClaim int
	totalSweptCount     int

	pendingSweep      []uint64
	roundParticipants map[uint64][]participant
}

func NewSimulator(cfg Config) *Simulator {
	oracleRng := subRand(cfg.Seed, "oracle-init")
	sim := &Simulator{
		cfg:                cfg,
		store:              NewMemStore(),
		oracle:             NewOracle(oracleRng, cfg.Oracle),
		tracer:             NewTracer(),
		ledger:             NewLedger(),
		roster:             buildRoster(cfg),
		roundsVoidByReason: map[string]int{},
		roundParticipants:  map[uint64][]participant{},
		block:              1,
	}
	for _, a := range sim.roster {
		sim.ledger.RegisterActor(a.Name, string(a.Role), a.SubAccounts...)
	}
	return sim
}

func (sim *Simulator) Tracer() *Tracer { return sim.tracer }

func (sim *Simulator) violation(week int, roundID uint64, msg string, args ...interface{}) error {
	m := fmt.Sprintf(msg, args...)
	var last *TraceEvent
	if n := len(sim.tracer.events); n > 0 {
		last = &sim.tracer.events[n-1]
	}
	return &InvariantViolation{
		Seed: sim.cfg.Seed, Week: week, Block: sim.block, RoundID: roundID,
		Event: last, Message: m,
	}
}

// Run executes the configured number of weekly rounds, then drains every
// pending round's claim window (sweeping anything abandoned) and performs
// the final global conservation check. On ANY invariant violation it stops
// immediately and returns a rich *InvariantViolation (never silently
// continues past a fund-safety failure).
func (sim *Simulator) Run() (*Report, error) {
	if sim.cfg.Weeks < 0 {
		return sim.buildReport(), fmt.Errorf("sim: negative Weeks")
	}
	// market.Init is called once (mirrors the real one-time deploy Init);
	// RollRound is fully permissionless from here on (real deployed contract
	// exposes no owner-gated actions — see contract/main.go's "NO PRIVILEGED
	// OPERATIONS" section), so "protocol"/"deployer" never acts again.
	if err := market.Init(sim.store, "hive:deployer"); err != nil {
		return sim.buildReport(), fmt.Errorf("sim: Init: %w", err)
	}

	for week := 1; week <= sim.cfg.Weeks; week++ {
		if err := sim.runWeek(week); err != nil {
			return sim.buildReport(), err
		}
	}
	if err := sim.finalDrain(); err != nil {
		return sim.buildReport(), err
	}
	if err := sim.ledger.GlobalConservationCheck(); err != nil {
		return sim.buildReport(), sim.violation(sim.cfg.Weeks, 0, "%s", err.Error())
	}
	if len(sim.pendingSweep) != 0 {
		return sim.buildReport(), sim.violation(sim.cfg.Weeks, 0, "finalDrain left %d rounds un-drained", len(sim.pendingSweep))
	}
	return sim.buildReport(), nil
}

// ---------------------------------------------------------------------------

func (sim *Simulator) advanceTo(b uint64) {
	if b > sim.block {
		sim.block = b
	}
}

func (sim *Simulator) runWeek(week int) error {
	// 1. Roll — same prompt latency distribution under every keeper profile.
	rollRng := subRand(sim.cfg.Seed, "roll", week)
	sim.advanceTo(sim.block + uint64(rollRng.Int63n(int64(sim.cfg.RollLatencyMaxBlocks)+1)))
	id, rolled, err := sim.keeperRoll(week, rollRng)
	if err != nil {
		return err
	}
	if !rolled {
		sim.roundsSkippedNoRoll++
		return nil
	}
	sim.roundsRolled++
	rv := ReadRound(sim.store, id)
	if err := checkPoolConservation(sim.store, id, rv.N); err != nil {
		return sim.violation(week, id, "%s", err.Error())
	}

	// 2. Bets.
	betsRng := subRand(sim.cfg.Seed, "bets", week)
	plans := sim.planBets(betsRng, rv)
	participants, err := sim.executeBets(week, plans, rv)
	if err != nil {
		return err
	}
	if err := sim.executeLatecomerAttempts(week, betsRng, rv); err != nil {
		return err
	}
	sim.advanceTo(rv.Lock)

	// 3. Settle / void per the keeper profile.
	keeperRng := subRand(sim.cfg.Seed, "keeper", week)
	terminal, method, err := sim.resolveRound(week, id, keeperRng)
	if err != nil {
		return err
	}
	switch method {
	case "settle":
		sim.resolvedViaSettle++
	case "voidStale":
		sim.resolvedViaVoid++
	}

	// 4. If the keeper never got the round to a terminal state, stakers fall
	//    back to the Reclaim fail-safe — the design's guarantee that funds
	//    can never be permanently stuck even with zero keeper participation.
	claimsRng := subRand(sim.cfg.Seed, "claims", week)
	if !terminal {
		reclaimed, err := sim.reclaimFallback(week, id, participants, claimsRng)
		if err != nil {
			return err
		}
		if reclaimed {
			sim.resolvedViaReclaim++
		} else {
			// Nobody reclaimed (e.g. a round with zero participants) — leave
			// it OPEN; finalDrain does not touch OPEN rounds by design (only
			// resolved rounds sweep), so an empty stuck round with nothing
			// staked is harmless and simply reported as unresolved.
			return nil
		}
	}

	rv = ReadRound(sim.store, id)
	if rv.State == market.StateSettled {
		sim.roundsSettled++
	} else if rv.State == market.StateVoid {
		sim.roundsVoidByReason[rv.VoidReason]++
	} else {
		return sim.violation(week, id, "round left in state %q after resolution phase", rv.State)
	}

	// 5. Claims (winners/refundees; no-shows and "forgetters" skip).
	if err := sim.processClaims(week, id, participants, claimsRng); err != nil {
		return err
	}

	sim.roundParticipants[id] = participants
	sim.pendingSweep = append(sim.pendingSweep, id)

	// 6. Opportunistic sweep pass — any round whose ~90-day claim window has
	//    now elapsed (naturally, as sim.block advances week over week).
	return sim.sweepPass(week)
}

// sweepPass checks every pending resolved round against the current clock
// frontier: fully self-drained rounds (owed==0) are confirmed and dropped;
// rounds past ClaimWindowBlocks are permissionlessly swept to the DHF.
func (sim *Simulator) sweepPass(week int) error {
	still := sim.pendingSweep[:0]
	for _, id := range sim.pendingSweep {
		rv := ReadRound(sim.store, id)
		if rv.Owed.Sign() == 0 {
			if err := checkFinalDrain(sim.store, id); err != nil {
				return sim.violation(week, id, "%s", err.Error())
			}
			continue
		}
		eligible := rv.Settle + market.ClaimWindowBlocks + 1
		if sim.block < eligible {
			still = append(still, id)
			continue
		}
		callBlock := sim.block
		if callBlock < eligible {
			callBlock = eligible
		}
		amt, dhf, err := market.SweepUnclaimed(sim.store, callBlock, id)
		sim.trace(week, callBlock, id, "sweeper", "sweeper", "sweepUnclaimed", map[string]string{}, err)
		if err != nil {
			return sim.violation(week, id, "sweepUnclaimed failed unexpectedly on a past-claim-window round: %v", err)
		}
		sim.ledger.RecordSwept(amt)
		sim.totalSweptCount++
		_ = dhf
		if err := checkFinalDrain(sim.store, id); err != nil {
			return sim.violation(week, id, "%s", err.Error())
		}
		sim.advanceTo(callBlock)
	}
	sim.pendingSweep = still
	return nil
}

// finalDrain pushes the clock past every still-pending round's claim window
// so the run ends with EVERY round definitively accounted for (claimed or
// swept — never "maybe still claimable").
func (sim *Simulator) finalDrain() error {
	threshold := sim.block
	for _, id := range sim.pendingSweep {
		rv := ReadRound(sim.store, id)
		t := rv.Settle + market.ClaimWindowBlocks + 1
		if t > threshold {
			threshold = t
		}
	}
	sim.advanceTo(threshold)
	return sim.sweepPass(-1)
}

func (sim *Simulator) trace(week int, block, roundID uint64, actor, role, action string, args map[string]string, err error) {
	ev := TraceEvent{Block: block, Week: week, RoundID: roundID, Actor: actor, Role: role, Action: action, Args: args, OK: err == nil}
	if err != nil {
		if merr, ok := err.(*market.Err); ok {
			ev.ErrSymbol = merr.Symbol
			ev.ErrMsg = merr.Msg
		} else {
			ev.ErrMsg = err.Error()
		}
	}
	sim.tracer.Record(ev)
}

func (sim *Simulator) buildReport() *Report {
	r := &Report{
		Seed:                  sim.cfg.Seed,
		KeeperProfile:         sim.cfg.Keeper.String(),
		Weeks:                 sim.cfg.Weeks,
		RoundsRolled:          sim.roundsRolled,
		RoundsSkippedNoRoll:   sim.roundsSkippedNoRoll,
		RoundsSettled:         sim.roundsSettled,
		RoundsVoidByReason:    map[string]int{},
		ResolvedViaSettleCall: sim.resolvedViaSettle,
		ResolvedViaVoidStale:  sim.resolvedViaVoid,
		ResolvedViaReclaim:    sim.resolvedViaReclaim,
		TotalStaked:           sim.ledger.TotalStaked(),
		TotalPaid:             sim.ledger.TotalReceived(),
		TotalSwept:            new(big.Int).Set(sim.ledger.totalSwept),
		RejectedLateBets:      sim.rejectedLateBets,
		RejectedDoubleClaims:  sim.rejectedDoubleClaim,
		UnresolvedRoundsAtEnd: len(sim.pendingSweep),
		ActorPnL:              map[string]*big.Int{},
		ActorRole:             map[string]string{},
		TraceEvents:           sim.tracer.Len(),
	}
	for reason, n := range sim.roundsVoidByReason {
		r.RoundsVoidByReason[reason] = n
		r.RoundsVoid += n
	}
	names := sim.ledger.Names()
	sort.Strings(names)
	for _, n := range names {
		r.ActorPnL[n] = sim.ledger.PnL(n)
		r.ActorRole[n] = sim.ledger.role[n]
	}
	return r
}
