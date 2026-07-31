package core

import (
	"math/big"
	"testing"
)

// fc4_producer_majority_test.go — F-C4 test-debt (LATENT · ⚑DECISION).
//
// THE RESIDUAL F-C4 NAMES. Intra-block transaction order on Magi is chosen
// unilaterally by the block producer (twap.go's header, verified at source), so
// a producer can decide which marginal rate each observation records. The short
// ring's movement cap is measured against the window MEDIAN, and a median can
// only be moved by corrupting MORE THAN HALF the window — ⌈17/32⌉ = 17 slots.
// A producer who wins that majority CAN therefore walk the short ring. That
// residual is acknowledged and un-fixed by design; the ⚑DECISION for the human
// is "accept the bounded residual vs. a stronger oracle" — and the reason it is
// only bounded (not a free settlement lever) is what this test pins:
//
//	settlement = min(AskRate_short, askRateLong, SpotRate)   (settlement.go:115)
//
// A walked-UP short ring is bounded by the LONG ring, which samples once per
// 6300 blocks — to walk IT a producer must hold the manipulated rate (and its
// capital) across many samples spanning days, at which point the rate IS the
// market. This test proves: (1) the median flips at exactly the majority
// threshold; (2) a MINORITY walk is refused by the cap; (3) a majority CAN walk
// the short ring (the honest residual, non-vacuous); (4) but min(short,long)
// gives that walk zero settlement value; (5) a sub-window burst cannot even
// touch the long ring.
//
// TESTS ONLY. No params change — the design decision (bounded residual vs.
// stronger oracle) is HELD for the human.

// fcSeedShort / fcSeedLong write a full 32-slot ring directly (as the harness's
// resetObsRings does), one slot per rate in `rates`, at `ShortObsSpacing` /
// `LongObsSpacing` block intervals ending at `endBlock`. Direct seeding models
// the exact ring END-STATE a walk produces, so the READ behaviour (AskRate /
// askRateLong / SettlementRate) is what is under test.
func fcSeedShort(s Store, creator string, endBlock uint64, rates []int64) {
	n := uint64(len(rates))
	for i := uint64(0); i < n; i++ {
		blk := endBlock - (n-1-i)*ShortObsSpacing
		setStr(s, kObs(creator, i%ObsWindow), packTwapObs(blk, big.NewInt(rates[i])))
	}
	setU64(s, kObsIdx(creator), n)
}

func fcSeedLong(s Store, creator string, endBlock uint64, rates []int64) {
	n := uint64(len(rates))
	for i := uint64(0); i < n; i++ {
		blk := endBlock - (n-1-i)*LongObsSpacing
		setStr(s, kObsLong(creator, i%ObsWindow), packTwapObs(blk, big.NewInt(rates[i])))
	}
	setU64(s, kObsLongIdx(creator), n)
}

// fcMixRates returns 32 rates: the first (32−attacker) at `honest`, the last
// `attacker` at `walked`.
func fcMixRates(attacker int, honest, walked int64) []int64 {
	rates := make([]int64, ObsWindow)
	for i := range rates {
		if i >= int(ObsWindow)-attacker {
			rates[i] = walked
		} else {
			rates[i] = honest
		}
	}
	return rates
}

func TestTwap_ProducerMajorityBoundedByMedianAndLongRing(t *testing.T) {
	if ObsWindow != 32 {
		t.Fatalf("this test hand-computes against ObsWindow==32, got %d", ObsWindow)
	}

	// -----------------------------------------------------------------------
	// PHASE 1 — the median (the cap's reference point) flips at EXACTLY the
	// majority threshold ⌈17/32⌉. This is WHY >½ is the corruption bar.
	// -----------------------------------------------------------------------
	mkPoints := func(rates []int64) []twapObs {
		pts := make([]twapObs, len(rates))
		for i, r := range rates {
			pts[i] = twapObs{block: uint64(i), rate: big.NewInt(r)}
		}
		return pts
	}
	// 15 attacker slots (a MINORITY) — median stays honest.
	if got := medianRate(mkPoints(fcMixRates(15, 1000, 2000))); got.Cmp(big.NewInt(1000)) != 0 {
		t.Fatalf("15/32 attacker slots moved the median to %s, want 1000 — a minority must NOT control the reference point", got)
	}
	// 16 attacker slots (exactly half, still not a majority) — median is the
	// midpoint of the two middle values, not yet the attacker's number.
	if got := medianRate(mkPoints(fcMixRates(16, 1000, 2000))); got.Cmp(big.NewInt(1500)) != 0 {
		t.Fatalf("16/32 attacker slots put the median at %s, want the midpoint 1500", got)
	}
	// 17 attacker slots (⌈17/32⌉ — the strict majority) — median flips fully to
	// the attacker's value. From here the cap's own reference is attacker-owned.
	if got := medianRate(mkPoints(fcMixRates(17, 1000, 2000))); got.Cmp(big.NewInt(2000)) != 0 {
		t.Fatalf("17/32 attacker slots left the median at %s, want the attacker's 2000 — the majority must own the reference point (this is the F-C4 residual)", got)
	}

	// -----------------------------------------------------------------------
	// PHASE 2 — below the threshold, the cap REFUSES an aggressive minority
	// walk rather than settling at a manipulated price. 15 attacker slots at a
	// huge rate against 17 honest: median stays 1000, the time-weighted average
	// is dragged far past 1000+20%, and AskRate refuses (ErrOracle).
	// -----------------------------------------------------------------------
	{
		s := NewMemStore()
		const c = "fc4minor"
		endBlock := uint64(100_000)
		fcSeedShort(s, c, endBlock, fcMixRates(15, 1000, 100_000)) // 15 minority at 100000
		if _, err := AskRate(s, c, endBlock+50); err == nil {
			t.Fatal("a 15/32 minority walked the short ring to a priced value — the median cap must refuse an aggressive minority")
		} else {
			assertErrSymbol(t, err, ErrOracle)
		}
	}

	// -----------------------------------------------------------------------
	// PHASE 3 — THE RESIDUAL, non-vacuous: a 17/32 MAJORITY DOES walk the short
	// ring to a priced value. 17 attacker slots at 1200 + 15 honest at 1000.
	// median = 1200 (attacker-owned, Phase 1); time-weighted twap = 1106; the
	// cap passes (|1106−1200| well within 20% of 1200) and AskRate RETURNS a
	// walked rate. Hand-computed:
	//   weighted = 15·40·1000 + 16·40·1200 + 50·1200 = 600000+768000+60000 = 1,428,000
	//   totalW   = 31·40 + 50 = 1290
	//   twap     = floor(1,428,000 / 1290) = 1106
	// The short ring alone is NOT safe against a producer majority — proving the
	// residual is real, so the bound proved next is not guarding a non-threat.
	// -----------------------------------------------------------------------
	{
		s := NewMemStore()
		const c = "fc4major"
		endBlock := uint64(100_000)
		fcSeedShort(s, c, endBlock, fcMixRates(17, 1000, 1200)) // 17 majority at 1200
		rate, err := AskRate(s, c, endBlock+50)
		if err != nil {
			t.Fatalf("a 17/32 majority walk was refused (%v) — Phase 1 shows the median is attacker-owned here, so the cap should PASS and the walk should price; if this refuses, the residual model is wrong", err)
		}
		if rate.Cmp(big.NewInt(1106)) != 0 {
			t.Fatalf("majority-walked short rate = %s, want the hand-computed 1106", rate)
		}
		if rate.Cmp(big.NewInt(1000)) <= 0 {
			t.Fatalf("majority walk did not lift the short rate above the honest 1000 (got %s) — the residual would be a non-event", rate)
		}
	}

	// -----------------------------------------------------------------------
	// PHASE 4 — THE BOUND: min(short, long, spot) gives a walked-UP short ring
	// ZERO settlement value. The producer fully owns the short window (all 32
	// slots walked to 2000) but has NOT sustained the walk across the 7-day long
	// window (still honest at 1000). Settlement takes the min, so it settles at
	// the honest long arm — the walk bought nothing.
	// -----------------------------------------------------------------------
	{
		s := NewMemStore()
		const c = "fc4settle"
		const supply = 100
		curveMarket(s, c, supply) // R === area(S); spot = SpotRate(100); keeps C5 quiet at this small supply
		Q := uint64(2_000_000)
		fcSeedShort(s, c, Q-50, fcMixRates(32, 2000, 2000)) // short ring fully WALKED to 2000
		fcSeedLong(s, c, Q-50, fcMixRates(32, 1000, 1000))  // long ring still HONEST at 1000

		short, err := AskRate(s, c, Q)
		if err != nil {
			t.Fatalf("short AskRate: %v", err)
		}
		if short.Cmp(big.NewInt(2000)) != 0 {
			t.Fatalf("short ring not fully walked: AskRate = %s, want 2000", short)
		}
		long, err := askRateLong(s, c, Q)
		if err != nil {
			t.Fatalf("long askRateLong: %v", err)
		}
		if long.Cmp(big.NewInt(1000)) != 0 {
			t.Fatalf("long ring not honest: askRateLong = %s, want 1000", long)
		}
		spot := SpotRate(big.NewInt(supply))
		if long.Cmp(spot) > 0 {
			t.Fatalf("test premise: honest long %s must be <= spot %s so the min picks the long arm", long, spot)
		}

		settle, err := SettlementRate(s, c, Q)
		if err != nil {
			t.Fatalf("SettlementRate refused (%v) — expected it to settle at the honest long arm, not error", err)
		}
		if settle.Cmp(long) != 0 {
			t.Fatalf("settlement = %s, want the honest long arm %s — the walked short ring must not raise settlement", settle, long)
		}
		if settle.Cmp(short) >= 0 {
			t.Fatalf("settlement %s reached the walked short rate %s — min(short,long,spot) failed to bound the producer-majority walk", settle, short)
		}
	}

	// -----------------------------------------------------------------------
	// PHASE 5 — CROSS-WINDOW DRIFT BOUND: a sub-window burst cannot even ADD a
	// long sample, let alone walk the long window. Built through the real
	// RecordObs writer (not direct seeding) so the rate-limiter itself is under
	// test. An honest long history, then a 40-write burst at 5000 spanning 1560
	// blocks (< LongObsSpacing = 6300): the long ring gains ZERO samples and its
	// average is unmoved, while the short ring absorbs all 40.
	// -----------------------------------------------------------------------
	{
		s := NewMemStore()
		const c = "fc4drift"
		base := uint64(3_000_000)
		for i := uint64(0); i < ObsWindow; i++ {
			RecordObs(s, c, base+i*LongObsSpacing, big.NewInt(1000)) // honest, feeds both rings
		}
		longBefore := getU64(s, kObsLongIdx(c))
		shortBefore := getU64(s, kObsIdx(c))

		lastHonest := base + (ObsWindow-1)*LongObsSpacing
		burstStart := lastHonest + 100
		const burstN = 40
		for i := uint64(0); i < burstN; i++ {
			RecordObs(s, c, burstStart+i*ShortObsSpacing, big.NewInt(5000)) // manipulated burst
		}
		burstEnd := burstStart + (burstN-1)*ShortObsSpacing
		if span := burstEnd - burstStart; span >= LongObsSpacing {
			t.Fatalf("test setup: burst span %d must stay below LongObsSpacing %d to prove the sub-window resistance", span, LongObsSpacing)
		}

		// The long ring took NOTHING — a burst inside one LongObsSpacing interval
		// cannot sample it at all.
		if longAfter := getU64(s, kObsLongIdx(c)); longAfter != longBefore {
			t.Fatalf("a %d-block burst added %d long samples, want 0 — the long ring's rate limiter is the cross-window drift bound", burstEnd-burstStart, longAfter-longBefore)
		}
		// ...while the short ring absorbed the whole burst (the asymmetry is real).
		if shortAfter := getU64(s, kObsIdx(c)); shortAfter <= shortBefore {
			t.Fatalf("short ring did not absorb the burst: idx %d -> %d", shortBefore, shortAfter)
		}
		// And the long window's priced rate is unmoved by the burst.
		long, err := askRateLong(s, c, burstEnd)
		if err != nil {
			t.Fatalf("askRateLong after burst: %v", err)
		}
		if long.Cmp(big.NewInt(1000)) != 0 {
			t.Fatalf("the burst moved the long window to %s, want the honest 1000 — a sub-6300-block burst must not touch it", long)
		}
		// Quantified: to add ONE long sample the producer must wait a full
		// LongObsSpacing (6300 blocks); to own the long window's median they need
		// ⌈17/32⌉ samples ≈ 17·6300 ≈ 107,100 blocks ≈ 3.7 days of SUSTAINED,
		// capital-backed manipulation — the "held across days" cost the min()
		// design converts a short-ring walk into.
		t.Logf("F-C4: producer-majority short-ring walk is bounded — settlement takes min(short,long,spot); walking the long window requires ≈17·%d ≈ %d blocks of sustained manipulation.", LongObsSpacing, 17*LongObsSpacing)
	}
}
