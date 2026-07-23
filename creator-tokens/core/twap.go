package core

import (
	"math/big"
	"strconv"
	"strings"
)

// twap.go — price observations and the time-weighted-average reads that feed
// settlement (SPEC-CREATOR-KEYS.md §1.3b; RULING C, RULINGS-v2-2026-07-21).
//
// WHY: services are priced in HBD, settled in tokens at a rate derived from
// the market's own bonding curve (the curve IS the price source — Buy and
// Sell call RecordObs with the marginal curve rate; see buy.go/sell.go).
// Spot can be moved within a single block, and we have VERIFIED AT SOURCE
// that intra-block transaction order on Magi is chosen unilaterally by the
// block producer and is NOT consensus-enforced (go-vsc-node
// modules/block-producer/blockProducer.go:344-362). That makes spot-price
// manipulation deterministic for a producer, not merely likely.
//
// This module is the defence, per SPEC §1.3b mitigations (1) and (2): never
// price from a single observation; require a minimum count AND span of
// DISTINCT-BLOCK observations before pricing at all; compute a true
// time-weighted average with integer math only; and cap how far the result
// may sit from the window median, refusing rather than settling at a
// suspicious price.
//
// TWO RINGS (RULING C1 added the second):
//
//   - SHORT ring (kObs/kObsIdx): one observation per ShortObsSpacing (40)
//     blocks max, 32 slots — a full ring therefore spans AT LEAST 31·40 =
//     1240 blocks (>= MinObsBlocks) and up to ~2.7 days of clamped weight.
//     Read by AskRate. The spacing limiter is load-bearing, not hygiene: see
//     params.go's ShortObsSpacing for the SET-1 autopsy (without it, >32
//     trades per hour compressed the window below MinObsBlocks and every
//     settlement path refused — a market that succeeded killed its own
//     services product).
//   - LONG ring (kObsLong/kObsLongIdx): one observation per LongObsSpacing
//     (6300) blocks max, 32 slots — spans exactly the ruled 7 days. Read by
//     askRateLong. Same packed format, same writer, coarser sampling. The
//     storage cost is one extra state write per ~5.25h of trading per
//     creator (params.go's LongObsSpacing doc); the granularity cost is that
//     the long window reacts in 6300-block steps — which is the point: a
//     sustained rate walk must hold its position (and its capital) across
//     many samples to move this window at all.
//
// Settlement (settlement.go) takes min(AskRate, askRateLong, SpotRate(S)) —
// the min is what makes each ring's failure mode safe: a walked short window
// is bounded by the long one, a stale long window is bounded by its own
// staleness refusal, and a pumped spot never raises the rate above either
// TWAP (RULING C1; the DOWN direction is bounded by settlement.go's spend
// cap, not by the rings).
//
// Storage: fixed-size ring buffers per creator. The index key holds the
// total number of observations ever WRITTEN for that creator (not a slot
// index), so the physical slot for the n-th write is always n % ObsWindow.
// The set of live slots for a given total count n is derived arithmetically
// from n alone — there is no separate "oldest" pointer that could fall out
// of sync with the data.

// twapObs is one decoded ring-buffer entry.
type twapObs struct {
	block uint64
	rate  *big.Int
}

// packTwapObs / unpackTwapObs encode a slot as "<block>|<rate>". Reuses
// parseMoney (money.go) for the rate so a corrupt slot is handled the same
// way every other module handles corrupt money state: as a typed error, never
// a panic. big.Int.String() never emits '|', and FormatUint never emits '|',
// so the delimiter is unambiguous.
func packTwapObs(block uint64, rate *big.Int) string {
	return strconv.FormatUint(block, 10) + "|" + rate.String()
}

func unpackTwapObs(v string) (block uint64, rate *big.Int, ok bool) {
	i := strings.IndexByte(v, '|')
	if i < 0 {
		return 0, nil, false
	}
	b, err := strconv.ParseUint(v[:i], 10, 64)
	if err != nil {
		return 0, nil, false
	}
	r, err := parseMoney(v[i+1:])
	if err != nil {
		return 0, nil, false
	}
	return b, r, true
}

// readTwapObsKey decodes the observation stored at an exact state key
// (either ring — the caller picks the key builder).
func readTwapObsKey(s Store, key string) (twapObs, bool) {
	v, ok := s.Get(key)
	if !ok || v == "" {
		return twapObs{}, false
	}
	b, r, ok := unpackTwapObs(v)
	if !ok {
		return twapObs{}, false
	}
	return twapObs{block: b, rate: r}, true
}

// readTwapObs reads slot idx of the SHORT ring — kept under its historical
// name because twap_test exercises it directly as the storage primitive.
func readTwapObs(s Store, creator string, idx uint64) (twapObs, bool) {
	return readTwapObsKey(s, kObs(creator, idx))
}

// RecordObs appends a price observation to the per-creator rings.
//
// SHORT ring: written only when the previous short sample is at least
// ShortObsSpacing (40) blocks old — the SET-1 fix (params.go carries the
// full autopsy). The first writer inside each interval wins, so no matter
// how many interactions touch this creator, the ring cannot be compressed
// below (ObsWindow−1)·ShortObsSpacing = 1240 blocks of span, which is what
// makes twapWindowRead's MinObsBlocks (1200) check structurally satisfiable
// instead of accidentally so. This SUBSUMES the old same-block dedup
// (spacing >= 1), and it only ever needs to compare against the single
// most-recently-written slot, because writes happen at non-decreasing block
// heights.
//
// BEFORE THE FIX the guard was `last.block == block` alone, so >32 trades
// inside 1200 blocks evicted the ring's own history and every settlement
// path refused — success (or 12.7 HBD of griefing fees) killed the entire
// services product. Measured threshold on the real package: 31 trades/hour
// OK, 33 fatal.
//
// LONG ring (RULING C1): written only when the previous long sample is at
// least LongObsSpacing blocks old (which subsumes the same-block dedup), so
// 32 slots span the ruled 7 days. The FIRST observation inside each spacing
// interval is the one that lands; an attacker cannot choose WHICH of their
// writes samples the long ring any more precisely than the honest flow can,
// and the value recorded is the curve's own marginal rate either way (the
// only production writers are Buy/Sell).
//
// A nil or non-positive rate is silently ignored. RecordObs has no error
// return by contract (API.md) — the only safe response to garbage input is
// to not record it, never to panic or to poison a ring with a bad rate.
func RecordObs(s Store, creator string, block uint64, rate *big.Int) {
	if rate == nil || rate.Sign() <= 0 {
		return
	}
	n := getU64(s, kObsIdx(creator))
	skipShort := false
	if n > 0 {
		if last, ok := readTwapObs(s, creator, (n-1)%ObsWindow); ok && block < last.block+ShortObsSpacing {
			skipShort = true // inside the current sampling interval — already sampled
		}
	}
	if !skipShort {
		setStr(s, kObs(creator, n%ObsWindow), packTwapObs(block, rate))
		setU64(s, kObsIdx(creator), n+1)
	}

	// Long ring: sample at most once per LongObsSpacing blocks. Checked
	// independently of the short dedup — a same-block second write must not
	// reach here anyway (spacing >= 1 subsumes it), but the long ring must
	// keep sampling even when the short ring is full of newer traffic.
	ln := getU64(s, kObsLongIdx(creator))
	if ln > 0 {
		if last, ok := readTwapObsKey(s, kObsLong(creator, (ln-1)%ObsWindow)); ok && block < last.block+LongObsSpacing {
			return // inside the current sampling interval — already sampled
		}
	}
	setStr(s, kObsLong(creator, ln%ObsWindow), packTwapObs(block, rate))
	setU64(s, kObsLongIdx(creator), ln+1)
}

// twapRingCfg parameterises one ring's window read so the SHORT and LONG
// reads share a single audited algorithm instead of two drifting copies.
type twapRingCfg struct {
	obsKey     func(c string, i uint64) string
	idxKey     func(c string) string
	minCount   uint64 // fewer live samples than this -> refuse
	minSpan    uint64 // minimum span AND minimum accumulated clamped weight
	maxStale   uint64 // newest sample older than this vs the query -> refuse
	maxWeight  uint64 // per-sample dwell clamp
	sinceBlock uint64 // samples recorded before this block are DROPPED (0 = keep all)
}

// twapWindowRead is the one shared TWAP algorithm — exactly the audited
// AskRate shape (chronological live set, per-sample dwell clamped, floored
// weighted average, movement cap against the window MEDIAN), applied to
// whichever ring cfg selects.
//
// sinceBlock exists for the LONG ring's re-registration epoch (keys.go's
// kObsLong doc): Register resets the SHORT ring's write counter but predates
// the long family, so the long read drops any sample from before the current
// incarnation's kRegisteredAt instead. Dropping at READ time is equivalent
// to the counter reset (the dropped samples can never influence the price)
// without needing a market.go change.
func twapWindowRead(s Store, creator string, block uint64, cfg twapRingCfg) (*big.Int, error) {
	n := getU64(s, cfg.idxKey(creator))
	startSeq := uint64(0)
	if n > ObsWindow {
		startSeq = n - ObsWindow
	}

	points := make([]twapObs, 0, ObsWindow)
	for seq := startSeq; seq < n; seq++ {
		o, ok := readTwapObsKey(s, cfg.obsKey(creator, seq%ObsWindow))
		if !ok {
			return nil, newErr(ErrState, "corrupt twap observation state")
		}
		if o.block < cfg.sinceBlock {
			continue // previous incarnation (long ring) — never priced from
		}
		points = append(points, o)
	}
	// points is now in chronological (block-ascending) order: writes only
	// ever happen at a block height >= every prior write for this creator, so
	// write order IS block order, regardless of ring-buffer physical
	// wraparound.
	if uint64(len(points)) < cfg.minCount {
		return nil, newErr(ErrOracle, "fewer than the minimum distinct-block observations")
	}

	oldest := points[0].block
	if block < oldest {
		return nil, newErr(ErrInput, "query block precedes oldest observation")
	}
	// Staleness: the weight clamp stops one sample dominating, but a market
	// silent for a week would still price off week-old data. Refuse instead.
	newest := points[len(points)-1].block
	if block > newest && block-newest > cfg.maxStale {
		return nil, newErr(ErrOracle, "newest observation is stale beyond the staleness bound")
	}
	windowBlocks := block - oldest
	if windowBlocks < cfg.minSpan {
		return nil, newErr(ErrOracle, "observations span less than the minimum window")
	}

	// Each observation's rate prevails from its own block until the next one
	// (and the newest until the query block) — but that dwell is CLAMPED at
	// cfg.maxWeight. On a market nobody has touched for weeks the newest
	// observation would otherwise carry the entire gap as weight, letting one
	// well-timed write set the price on its own. With the clamp, a stale market
	// runs out of total weight and refuses to price instead.
	weighted := mZero()
	totalW := uint64(0)
	for i, p := range points {
		var w uint64
		if i == len(points)-1 {
			if block < p.block {
				return nil, newErr(ErrInput, "block regression against newest observation")
			}
			w = block - p.block
		} else {
			next := points[i+1].block
			if next < p.block {
				return nil, newErr(ErrState, "corrupt twap observation ordering")
			}
			w = next - p.block
		}
		if w > cfg.maxWeight {
			w = cfg.maxWeight
		}
		if w == 0 {
			continue
		}
		totalW += w
		term := new(big.Int).Mul(p.rate, new(big.Int).SetUint64(w))
		weighted = mAdd(weighted, term)
	}

	// The clamp means weights no longer telescope to windowBlocks, so the
	// denominator is the ACTUAL accumulated weight, and it must still cover the
	// minimum span — otherwise a market that has been quiet for months could
	// satisfy the span check on paper while resting on a few clamped samples.
	if totalW < cfg.minSpan {
		return nil, newErr(ErrOracle, "insufficient un-clamped observation weight to price")
	}
	totalWeight := new(big.Int).SetUint64(totalW)
	twap := new(big.Int).Div(weighted, totalWeight) // floor: a lower rate spends MORE credits per ask (ceilDiv(face,rate)), so flooring favours the creator, same convention as mMulDiv.

	// Movement cap, measured against the window MEDIAN — never against the
	// newest observation. Comparing to the newest is self-referential: whichever
	// write dominates the time-weight both sets the TWAP and then passes its own
	// check. The median cannot be moved by a single write, so an attacker must
	// corrupt more than half the window to shift the reference point.
	// Cross-multiplied, so the check is exact — no rounding direction to get
	// wrong on a security boundary.
	ref := medianRate(points)
	if ref.Sign() <= 0 {
		return nil, newErr(ErrOracle, "median reference rate is non-positive")
	}
	diff := new(big.Int).Sub(twap, ref)
	diff.Abs(diff)
	lhs := new(big.Int).Mul(diff, big.NewInt(10000))
	rhs := new(big.Int).Mul(ref, new(big.Int).SetUint64(MaxRateDeviationBps))
	if lhs.Cmp(rhs) > 0 {
		return nil, newErr(ErrOracle, "rate deviates beyond MaxRateDeviationBps from the window median")
	}

	if twap.Sign() <= 0 {
		return nil, newErr(ErrOracle, "twap rate is non-positive")
	}
	return twap, nil
}

// AskRate returns the SHORT-window time-weighted-average rate (HBD base
// units per credit) as of block, or a typed ErrOracle when the ring cannot
// yet support a safe price. Never returns spot. Never returns zero or
// negative. Semantics are byte-identical to the pre-RULING-C version (the
// algorithm moved into twapWindowRead unchanged so the long ring could share
// it); settlement no longer uses this ALONE — see SettlementRate.
func AskRate(s Store, creator string, block uint64) (*big.Int, error) {
	return twapWindowRead(s, creator, block, twapRingCfg{
		obsKey:    kObs,
		idxKey:    kObsIdx,
		minCount:  MinObsCount,
		minSpan:   MinObsBlocks,
		maxStale:  MaxStaleBlocks,
		maxWeight: MaxObsWeightBlocks,
		// sinceBlock deliberately 0: Register resets kObsIdx per incarnation
		// (market.go), so the short ring's live set is epoch-clean already.
	})
}

// askRateLong is the 7-day window read (RULING C1's TWAP_long). Package-
// private: nothing outside settlement.go should consume the long window
// alone — v1 RULING 3c priced Unlock off the long TWAP ALONE and that was
// backwards (longest = stalest = highest rate = fewest tokens = LEAST
// creator-favouring; a 100 HBD permanent entitlement went for 12.111 HBD).
// The long window is only ever one arm of settlement's min().
func askRateLong(s Store, creator string, block uint64) (*big.Int, error) {
	return twapWindowRead(s, creator, block, twapRingCfg{
		obsKey:    kObsLong,
		idxKey:    kObsLongIdx,
		minCount:  LongMinObsCount,
		minSpan:   LongMinObsBlocks,
		maxStale:  LongMaxStaleBlocks,
		maxWeight: LongMaxObsWeightBlocks,
		// The long counter survives re-registration (Register predates this
		// ring family), so the epoch boundary is enforced HERE: any sample
		// from before the current incarnation is dropped. Without this, a
		// re-registered market's first services would price off the DEAD
		// incarnation's rates — the exact leak Register's kObsIdx reset
		// closes for the short ring (harness regression test, 2026-07-21).
		sinceBlock: getU64(s, kRegisteredAt(creator)),
	})
}

// medianRate returns the median of the observation rates in the window, by
// value and independent of time-weighting. It is the reference point for the
// movement cap: unlike the newest observation, it cannot be moved by a single
// write, so shifting it requires corrupting more than half the window.
func medianRate(points []twapObs) *big.Int {
	n := len(points)
	if n == 0 {
		return mZero()
	}
	rates := make([]*big.Int, n)
	for i, p := range points {
		rates[i] = new(big.Int).Set(p.rate)
	}
	// Insertion sort: n <= ObsWindow (32), so this is cheaper than pulling in
	// the sort package for the wasm build, and it is allocation-free.
	for i := 1; i < n; i++ {
		v := rates[i]
		j := i - 1
		for j >= 0 && rates[j].Cmp(v) > 0 {
			rates[j+1] = rates[j]
			j--
		}
		rates[j+1] = v
	}
	if n%2 == 1 {
		return rates[n/2]
	}
	// Even count: mean of the two middle values, floored — consistent with the
	// rest of the module, where flooring a rate favours the reserve.
	sum := mAdd(rates[n/2-1], rates[n/2])
	return sum.Div(sum, big.NewInt(2))
}
