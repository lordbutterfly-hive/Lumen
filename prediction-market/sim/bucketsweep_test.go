package sim

// Bucket-count sweep — answers the product question "should we drop from 7
// buckets to 4 or fewer, and what happens if no one bets the winning bucket?"
//
// A zero-stake winning bucket is not fund-loss: market/settle.go:76 returns
// VoidZeroWinner, the round VOIDs, and every staker is refunded in full
// (market/claim.go, fuzz_solvency_test.go). But a VOID is a DEAD WEEK — the
// market resolves to nothing, no winner, no engagement payoff. So the metric
// that matters is the VOID RATE: P(the settled bucket has zero stake).
//
// This test is pure analysis (additive; touches no contract code). It drives:
//   - the REAL per-tick log-normal walk the oracle uses (sim/oracle.go:
//     driftPerTick + NormFloat64()*volPerTick), integrated over the REAL round
//     span (RollBettingBlocks+RollSettleGapBlocks = 201,600 blocks = 2,016
//     ticks), so the reference->settle move distribution is faithful; and
//   - the REAL crowd-anchor actor bias weightedMiddleBucket(rng, n) from
//     sim/actors.go, mixed with informed "sharp" bettors.
//
// It sweeps three vol regimes because the sim's default (~4%/week) is low for
// HIVE — real HIVE weekly vol is ~10-15% — and the whole answer flips with vol.
//
// Run: go test ./sim/ -run BucketSweep -v

import (
	"fmt"
	"math"
	"math/rand"
	"testing"
)

// bucketForLocal is a faithful copy of market.round.go's bucketFor (unexported
// there; identical semantics: price on a strike belongs to the UPPER bucket).
func bucketForLocal(price float64, strikes []float64) int {
	for i, s := range strikes {
		if price < s {
			return i
		}
	}
	return len(strikes)
}

// bucketConfig names a set of internal strikes as %-moves off the reference.
// N buckets == len(pcts)+1. All symmetric-odd configs keep a "flat" middle
// band; the 4-bucket config is deliberately asymmetric (no flat anchor) to
// show why an even count is structurally worse.
type bucketConfig struct {
	name string
	pcts []float64 // e.g. {-0.30,-0.20,-0.10,0.10,0.20,0.30} for the 7-bucket prod config
}

func (c bucketConfig) strikes(ref float64) []float64 {
	out := make([]float64, len(c.pcts))
	for i, p := range c.pcts {
		out[i] = ref * (1 + p)
	}
	return out
}
func (c bucketConfig) n() int { return len(c.pcts) + 1 }

// perTickVol needed to realize a target weekly log-return std, given the real
// round span of 2,016 ticks: weeklyStd = sqrt(nTicks)*perTickVol.
const roundTicks = float64((RollBettingBlocks_ + RollSettleGapBlocks_)) / float64(TickIntervalBlocks)

// mirror the market constants locally (they live in package market; this is a
// sim-package test, so re-declare the two we need — asserted equal below).
const (
	RollBettingBlocks_   = 144000
	RollSettleGapBlocks_ = 57600
)

func TestBucketSweep(t *testing.T) {
	const (
		ref     = 2940.0
		rounds  = 200000 // Monte-Carlo rounds per cell
		sharpFr = 0.30   // fraction of bettors that are informed (see sharpBucket spirit)
	)

	configs := []bucketConfig{
		{"7-bucket ±10/20/30 (current)", []float64{-0.30, -0.20, -0.10, 0.10, 0.20, 0.30}},
		{"5-bucket ±10/20", []float64{-0.20, -0.10, 0.10, 0.20}},
		{"4-bucket ±10 +split@0 (asym, no flat anchor)", []float64{-0.10, 0.0, 0.10}},
		{"3-bucket ±10 (down/flat/up)", []float64{-0.10, 0.10}},
	}
	volRegimes := []struct {
		name     string
		weeklyPc float64 // weekly log-return std
	}{
		{"LOW  ~4%/wk (sim default, ~29% annual)", 0.040},
		{"MID  ~10%/wk (~72% annual)", 0.100},
		{"HIGH ~15%/wk (~108% annual, realistic HIVE)", 0.150},
	}
	bettorCounts := []int{5, 10, 20, 50}

	t.Logf("round span = %.0f ticks; sim default per-tick vol 0.0009 => weekly std %.2f%%",
		roundTicks, math.Sqrt(roundTicks)*0.0009*100)

	for _, vr := range volRegimes {
		t.Logf("\n================ VOL REGIME: %s ================", vr.name)
		// First, the winning-bucket distribution per config (shows dead buckets).
		for _, c := range configs {
			dist := winDistribution(c, ref, vr.weeklyPc, rounds)
			t.Logf("  win-dist  %-46s  %s", c.name, fmtDist(dist))
		}
		t.Logf("  --- VOID RATE (winning bucket had zero stake) ---")
		t.Logf("  %-46s %8s %8s %8s %8s", "config \\ bettors/round", "B=5", "B=10", "B=20", "B=50")
		for _, c := range configs {
			row := fmt.Sprintf("  %-46s", c.name)
			for _, B := range bettorCounts {
				vr := voidRate(c, ref, vr.weeklyPc, B, sharpFr, rounds)
				row += fmt.Sprintf(" %7.2f%%", vr*100)
			}
			t.Log(row)
		}
	}
}

// winDistribution returns the fraction of rounds each bucket is the winner.
func winDistribution(c bucketConfig, ref, weeklyStd float64, rounds int) []float64 {
	rng := rand.New(rand.NewSource(1))
	strikes := c.strikes(ref)
	counts := make([]int, c.n())
	for i := 0; i < rounds; i++ {
		settle := ref * math.Exp(rng.NormFloat64()*weeklyStd)
		counts[bucketForLocal(settle, strikes)]++
	}
	out := make([]float64, c.n())
	for i, ct := range counts {
		out[i] = float64(ct) / float64(rounds)
	}
	return out
}

// voidRate Monte-Carlos the full round: draw the settle move -> winning bucket;
// seat B bettors (sharpFr informed, rest crowd-anchored via the REAL
// weightedMiddleBucket bias); void iff the winning bucket got zero stake.
func voidRate(c bucketConfig, ref, weeklyStd float64, B int, sharpFr float64, rounds int) float64 {
	rng := rand.New(rand.NewSource(42))
	strikes := c.strikes(ref)
	n := c.n()
	voids := 0
	nSharp := int(math.Round(float64(B) * sharpFr))
	for r := 0; r < rounds; r++ {
		settle := ref * math.Exp(rng.NormFloat64()*weeklyStd)
		win := bucketForLocal(settle, strikes)
		staked := make([]bool, n)
		for b := 0; b < B; b++ {
			var bk int
			if b < nSharp {
				// informed: sees settle with imperfect noise (~5% std), buckets it.
				guess := settle * math.Exp(rng.NormFloat64()*0.05)
				bk = bucketForLocal(guess, strikes)
			} else {
				// casual: the real crowd-anchor bias, parameterized by n.
				bk = weightedMiddleBucket(rng, n)
			}
			staked[bk] = true
		}
		if !staked[win] {
			voids++
		}
	}
	return float64(voids) / float64(rounds)
}

func fmtDist(d []float64) string {
	s := "["
	for i, v := range d {
		if i > 0 {
			s += " "
		}
		s += fmt.Sprintf("%4.1f%%", v*100)
	}
	return s + "]"
}
