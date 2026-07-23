package sim

import (
	"fmt"
	"hash/fnv"
	"math/rand"
)

// subRand derives an independent, deterministic *rand.Rand from a master
// seed plus a set of "purpose" tags (e.g. week number, concern name). Using
// per-concern sub-streams (rather than one shared *rand.Rand) means each
// week's bet-placement decisions are a pure function of (seed, week) and are
// IDENTICAL across keeper-profile runs that share the same seed — the
// keeper's settle-timing randomness lives in its own stream and can never
// perturb bettor behaviour. This is what makes the three keeper-profile runs
// (reliable/late/absent) a clean, isolated comparison: same population, same
// oracle path, same bets — only settle timing differs.
func subRand(seed int64, parts ...interface{}) *rand.Rand {
	h := fnv.New64a()
	fmt.Fprintf(h, "%d", seed)
	for _, p := range parts {
		fmt.Fprintf(h, "|%v", p)
	}
	return rand.New(rand.NewSource(int64(h.Sum64())))
}

// foldedDelay draws a non-negative delay with the given mean by folding a
// normal distribution (|Normal(mean, stdev)|) — used for the "late" keeper's
// broad, right-skewed-in-effect settle delay.
func foldedDelay(rng *rand.Rand, mean, stdev float64) uint64 {
	v := mean + rng.NormFloat64()*stdev
	if v < 0 {
		v = -v
	}
	return uint64(v)
}
