package sim

import (
	"math"
	"math/rand"
)

// TickIntervalBlocks mirrors the DOCUMENTED real-world pendulum cadence —
// market/params.go's MaxSettleTickLag comment states "The pendulum ticks
// every DefaultTickIntervalBlocks (=100) and hive_moving_avg_bps is CONSTANT
// between ticks" and MaxSettleTickLag itself is "Set to one tick interval so
// exactly one tick qualifies" (=100). The simulator's oracle uses the same
// 100-block cadence so the settle-window math it exercises is the real one,
// not an invented one.
const TickIntervalBlocks = 100

// oracleTick is one immutable, once-generated oracle reading. Once cached it
// never changes — a real MA reading at a given block height is a historical
// fact, not something that gets rewritten on a later query.
type oracleTick struct {
	priceBps uint64
	ok       bool
}

// Oracle is the price-path + feed-health actor: a random walk in bps ticking
// every TickIntervalBlocks blocks (at a random phase offset, so the
// settleBlock-vs-tick-grid alignment varies run to run like a real chain
// would), with a two-state (healthy/stale) Markov process layered on top so
// the feed is "sometimes bad or stale" — both isolated blips (survivable by
// a keeper retry inside the settle window) and rare, long outages (long
// enough to span SettleWindowBlocks+GraceBlocks and force a genuine
// VoidStaleFeed, exercising that fail-safe path).
//
// Every tick, once generated, is cached forever (deterministic given the
// seed) — callers may query ticks in any order; generation always walks
// forward from the highest tick generated so far and fills in everything in
// between, so re-querying an already-generated tick is a pure cache hit and
// the whole price path is reproducible byte-for-byte from the seed alone.
type Oracle struct {
	rng *rand.Rand

	phase    uint64 // 0..TickIntervalBlocks-1, the first tick's block
	interval uint64

	driftPerTick float64
	volPerTick   float64

	blipEnterProb   float64 // per-tick P(healthy -> short blip)
	blipMeanTicks   float64
	outageEnterProb float64 // per-tick P(healthy -> long outage)
	outageMeanTicks float64

	ticks       map[uint64]oracleTick // tickBlock -> reading
	lastTick    uint64                // highest generated tick block
	haveAny     bool
	lastLogP    float64 // log(price) at lastTick, carried forward for the walk
	inBurst     bool
	burstUntilN int // remaining ticks in the current burst (blip or outage)
}

// OracleConfig tunes the price walk + feed-health process. Defaults (see
// DefaultOracleConfig) are chosen so that over a simulated year (~104,832
// ticks) blips are common (survived easily) and a handful of outages are
// long enough (>= ~36 ticks, i.e. >= SettleWindowBlocks+GraceBlocks) to
// force genuine VoidStaleFeed rounds — verified empirically in sim_test.go,
// not just asserted from the formula.
type OracleConfig struct {
	StartPriceBps   uint64
	DriftPerTick    float64
	VolPerTick      float64
	BlipEnterProb   float64
	BlipMeanTicks   float64
	OutageEnterProb float64
	OutageMeanTicks float64
}

func DefaultOracleConfig() OracleConfig {
	return OracleConfig{
		StartPriceBps:   2940, // ~$0.294, the value used throughout market/*_test.go
		DriftPerTick:    0.0,
		VolPerTick:      0.0009, // ~0.09%/tick ⇒ a multi-week round can realistically drift ±10-30%
		BlipEnterProb:   0.004,  // ~1 blip every ~250 ticks (~1/week)
		BlipMeanTicks:   3,      // a few hundred blocks — trivially survived by any keeper retry
		OutageEnterProb: 0.0006, // a long outage roughly every ~1,600 ticks (~few per year)
		OutageMeanTicks: 60,     // mean 6,000 blocks; a meaningful fraction exceed the
		// SettleWindowBlocks(1200)+GraceBlocks(2400)=3600-block (36-tick) threshold
		// needed to force a genuine VoidStaleFeed, per the geometric tail.
	}
}

func NewOracle(rng *rand.Rand, cfg OracleConfig) *Oracle {
	phase := uint64(rng.Int63n(int64(TickIntervalBlocks)))
	return &Oracle{
		rng:             rng,
		phase:           phase,
		interval:        TickIntervalBlocks,
		driftPerTick:    cfg.DriftPerTick,
		volPerTick:      cfg.VolPerTick,
		blipEnterProb:   cfg.BlipEnterProb,
		blipMeanTicks:   cfg.BlipMeanTicks,
		outageEnterProb: cfg.OutageEnterProb,
		outageMeanTicks: cfg.OutageMeanTicks,
		ticks:           map[uint64]oracleTick{},
		lastLogP:        math.Log(float64(clampPrice(cfg.StartPriceBps))),
	}
}

func clampPrice(p uint64) uint64 {
	if p == 0 {
		return 1
	}
	return p
}

// tickAtOrBefore returns the largest valid tick-grid block <= block, or
// (0,false) if block < phase (no tick has occurred yet).
func (o *Oracle) tickAtOrBefore(block uint64) (uint64, bool) {
	if block < o.phase {
		return 0, false
	}
	n := (block - o.phase) / o.interval
	return o.phase + n*o.interval, true
}

// NextTickAtOrAfter returns the smallest valid tick-grid block >= block.
func (o *Oracle) NextTickAtOrAfter(block uint64) uint64 {
	if block <= o.phase {
		return o.phase
	}
	n := (block - o.phase + o.interval - 1) / o.interval
	return o.phase + n*o.interval
}

// genNext generates exactly the next tick after o.lastTick (or the bootstrap
// first tick at o.phase if nothing generated yet), consuming a fixed 2 RNG
// draws (one NormFloat64 for the log-return, one Float64 for the
// burst/health roll), and caches it.
func (o *Oracle) genNext() {
	var next uint64
	if !o.haveAny {
		next = o.phase
	} else {
		next = o.lastTick + o.interval
	}

	// Price: one log-normal step from the last known log-price.
	step := o.driftPerTick + o.rng.NormFloat64()*o.volPerTick
	o.lastLogP += step
	price := clampPrice(uint64(math.Round(math.Exp(o.lastLogP))))

	// Feed health: a two-state-plus-burst-timer process. If currently in a
	// burst (blip or outage), stay unhealthy and count down; otherwise roll
	// for a NEW burst starting at this tick.
	ok := true
	if o.inBurst {
		ok = false
		o.burstUntilN--
		if o.burstUntilN <= 0 {
			o.inBurst = false
		}
	} else {
		r := o.rng.Float64()
		switch {
		case r < o.outageEnterProb:
			o.inBurst = true
			o.burstUntilN = geometricDraw(o.rng, o.outageMeanTicks)
			ok = false
		case r < o.outageEnterProb+o.blipEnterProb:
			o.inBurst = true
			o.burstUntilN = geometricDraw(o.rng, o.blipMeanTicks)
			ok = false
		default:
			ok = true
		}
	}

	o.ticks[next] = oracleTick{priceBps: price, ok: ok}
	o.lastTick = next
	o.haveAny = true
}

// geometricDraw returns a >=1 duration with the given mean, via the
// geometric distribution (P(exit)=1/mean).
func geometricDraw(rng *rand.Rand, mean float64) int {
	if mean < 1 {
		mean = 1
	}
	pExit := 1.0 / mean
	n := 1
	for rng.Float64() >= pExit {
		n++
		if n > 1_000_000 { // safety valve against a pathological mean
			break
		}
	}
	return n
}

// ensureUpto generates every tick (in strict increasing order) from the last
// generated one through the largest valid tick <= block, so any subsequent
// lookup at or below `block` is a cache hit.
func (o *Oracle) ensureUpto(block uint64) {
	target, has := o.tickAtOrBefore(block)
	if !has {
		return // nothing to generate yet (block before the first tick)
	}
	for !o.haveAny || o.lastTick < target {
		o.genNext()
	}
}

// LatestKnownAt returns the most-recently-observed reading as of `block` —
// what a live env read (e.g. pendulum.hive_moving_avg_bps) would show at
// that moment, since the MA is constant between ticks. ok=false in the
// returned tickBlock,found pair only if block precedes the very first tick.
func (o *Oracle) LatestKnownAt(block uint64) (priceBps uint64, feedOK bool, tickBlock uint64, found bool) {
	tb, has := o.tickAtOrBefore(block)
	if !has {
		return 0, false, 0, false
	}
	o.ensureUpto(block)
	t := o.ticks[tb]
	return t.priceBps, t.ok, tb, true
}

// TickAt returns the reading at an exact tick-grid block (generating up to
// it if needed). Panics if tickBlock is not on the tick grid — a caller
// error, not a simulation outcome.
func (o *Oracle) TickAt(tickBlock uint64) oracleTick {
	if tickBlock < o.phase || (tickBlock-o.phase)%o.interval != 0 {
		panic("sim: TickAt called with a block not on the oracle's tick grid")
	}
	o.ensureUpto(tickBlock)
	return o.ticks[tickBlock]
}
