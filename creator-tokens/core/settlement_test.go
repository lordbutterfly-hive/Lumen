package core

import (
	"math/big"
	"math/rand"
	"strings"
	"testing"
)

// settlement_test.go — RULING C's proofs (RULINGS-v2-2026-07-21):
//
//   - RULING J collapses the settlement-rate contradiction, WITH NUMBERS
//     (TestSettlement_RulingJCollapsesRateContradiction)
//   - the min() picks whichever arm is lowest, spot ceiling included
//     (TestSettlementRate_MinPicksLowestArm)
//   - the no-arbitrage property behind the spot arm
//     (TestSettlement_NoArbitrageSpotCeiling)
//   - every guard boundary, exact (TestSettleSpend_*)
//   - the C5 divergence tripwire (TestSettlementRate_C5Tripwire)
//   - the long ring's storage semantics (TestRecordObs_LongRingSpacing,
//     TestAskRateLong_MinimumHistory)
//   - RULING C3: one derivation for every token-settled service, pinned via
//     Ask (TestSettlement_AskUsesTheRuledDerivation)
//   - a settlement refusal can never gate an outflow, end-to-end
//     (TestSettlementRefusalGatesNoOutflow)
//   - a lone attacker writing observations every block for hours cannot move
//     the settlement rate (TestSettlement_LoneAttackerWalkDoesNotMovePrice)
//
// Shared fixture helpers (seedSettleObs / resetObsRings / curveMarket /
// activateMarket) live in ask_test.go.

// ---- storage-level ring builders -------------------------------------------
//
// The divergent-window fixtures below need the SHORT and LONG rings to hold
// DIFFERENT rates, which RecordObs (one writer, both rings) cannot produce
// from a constant series — so these write the rings at the storage level,
// exactly the way twap_test.go's own corrupt-slot test writes slots directly.
// Each ring's contents still satisfy every window guard on its own.

// stFillShort writes `n` observations at `rate`, 200 blocks apart, ENDING at
// block `end` — a valid short window (span (n-1)*200, all guards pass for a
// query shortly after `end`).
func stFillShort(s Store, creator string, end uint64, n uint64, rate *big.Int) {
	for i := uint64(0); i < n; i++ {
		setStr(s, kObs(creator, i), packTwapObs(end-(n-1-i)*200, rate))
	}
	setU64(s, kObsIdx(creator), n)
}

// stFillLong writes `n` observations at `rate`, LongObsSpacing apart, ENDING
// at block `end` — a valid long window for n >= LongMinObsCount with span
// (n-1)*LongObsSpacing >= LongMinObsBlocks.
func stFillLong(s Store, creator string, end uint64, n uint64, rate *big.Int) {
	for i := uint64(0); i < n; i++ {
		setStr(s, kObsLong(creator, i), packTwapObs(end-(n-1-i)*LongObsSpacing, rate))
	}
	setU64(s, kObsLongIdx(creator), n)
}

// ---- RULING J collapses the contradiction, with numbers --------------------

// TestSettlement_RulingJCollapsesRateContradiction is the verification the
// settlement task order demanded: "There is no correct settlement rate when
// the reserve exceeds the curve area, because value-conservation (settle at
// backing R/S) and no-arbitrage (settle at or below curve spot) contradict.
// RULING J's R === area(S) should collapse that contradiction — verify it
// does, with numbers."
//
//	WITH divergence (pre-RULING-J state): the rulings' exhibit, re-computed
//	at the compiled curve — S=100, E=960,090,850 base units of unallocated
//	excess. Value-conservation demands floor(R/S) = 9,602,315; no-arbitrage
//	demands rate <= spot(100) = 1,813. The two constraints are 5,296x apart:
//	EVERY rate violates at least one. The contradiction is real.
//
//	UNDER RULING J (R === area(S) with equality): R/S = area(S)/S is the
//	curve's AVERAGE price, and the average of a non-decreasing price
//	sequence never exceeds its top (marginal = spot) — verified below for
//	every S in [1, 3000] plus 200 random S up to 10^7, zero violations. So
//	every rate <= spot automatically satisfies value-conservation too: one
//	constraint implies the other, and min(TWAPs, spot) is a complete answer.
func TestSettlement_RulingJCollapsesRateContradiction(t *testing.T) {
	// The divergence side: the contradiction, demonstrated.
	S := big.NewInt(100)
	excess := big.NewInt(960_090_850)
	r := mAdd(Area(S), excess)
	valueConservation := new(big.Int).Div(r, S) // floor(R/S)
	noArbCeiling := SpotRate(S)
	if valueConservation.Cmp(big.NewInt(9_602_315)) != 0 {
		t.Fatalf("diverged floor(R/S) = %s, want 9,602,315 (fixture drifted)", valueConservation)
	}
	if noArbCeiling.Cmp(big.NewInt(1813)) != 0 {
		t.Fatalf("spot(100) = %s, want 1,813 (fixture drifted)", noArbCeiling)
	}
	if valueConservation.Cmp(noArbCeiling) <= 0 {
		t.Fatalf("diverged fixture no longer exhibits the contradiction: floor(R/S)=%s <= spot=%s", valueConservation, noArbCeiling)
	}
	ratio := new(big.Int).Div(valueConservation, noArbCeiling)
	if ratio.Cmp(big.NewInt(5296)) != 0 {
		t.Fatalf("contradiction gap = %sx, want 5,296x", ratio)
	}

	// The equality side: avg <= spot everywhere, so the contradiction is gone.
	rng := rand.New(rand.NewSource(20260721))
	check := func(S int64) {
		sb := big.NewInt(S)
		avg := new(big.Int).Div(Area(sb), sb) // floor(area(S)/S) — value-conservation under equality
		spot := SpotRate(sb)
		if avg.Cmp(spot) > 0 {
			t.Fatalf("EQUALITY VIOLATION of avg<=spot at S=%d: floor(area/S)=%s > spot=%s — the contradiction is back", S, avg, spot)
		}
	}
	for S := int64(1); S <= 3000; S++ {
		check(S)
	}
	for i := 0; i < 200; i++ {
		check(3000 + rng.Int63n(10_000_000))
	}
}

// ---- the min() and its arms ------------------------------------------------

func TestSettlementRate_ShortWindowCapsSpot(t *testing.T) {
	// ★ REWRITTEN 2026-09-16 (owner ruling: no trading-history gate). Until
	// then this pinned min(spot, median(short, long, spot)) and a refusal when
	// the long window could not price. The rate is now min(spot, short) when
	// the short window prices and spot otherwise; the long ring is recorded
	// history that settlement never reads, so its contents must be invisible
	// here — every fixture below carries a long ring precisely to prove that.
	// All fixtures: S=200 (spot 2680, avg_ceil 1827 — C5 quiet for every rate
	// used here since 4·1500 = 6000 > 1827).
	const q = uint64(500_000)

	t.Run("ShortBelowSpot_CapsTheRate", func(t *testing.T) {
		// A pump inside the hour cannot lift the rate above the recent average.
		s := NewMemStore()
		curveMarket(s, creator1, 200)
		stFillShort(s, creator1, q-50, MinObsCount, big.NewInt(1500))
		stFillLong(s, creator1, q-50, stObsCount, big.NewInt(2000))
		got, err := SettlementRate(s, creator1, q)
		if err != nil {
			t.Fatalf("SettlementRate: %v", err)
		}
		if got.Cmp(big.NewInt(1500)) != 0 {
			t.Fatalf("rate = %s, want 1500 (min(spot 2680, short 1500); the long ring's 2000 must be invisible)", got)
		}
	})

	t.Run("LongRingIsInvisible", func(t *testing.T) {
		// Same short, a wildly different long ring: identical answer.
		for _, longRate := range []int64{1, 2000, 90_000} {
			s := NewMemStore()
			curveMarket(s, creator1, 200)
			stFillShort(s, creator1, q-50, MinObsCount, big.NewInt(2500))
			stFillLong(s, creator1, q-50, stObsCount, big.NewInt(longRate))
			got, err := SettlementRate(s, creator1, q)
			if err != nil {
				t.Fatalf("SettlementRate (long=%d): %v", longRate, err)
			}
			if got.Cmp(big.NewInt(2500)) != 0 {
				t.Fatalf("rate = %s with long ring at %d, want 2500 (settlement must not read the long ring)", got, longRate)
			}
		}
	})

	t.Run("SpotIsLowest", func(t *testing.T) {
		// The load-bearing no-arbitrage ceiling: a short window way above the
		// curve's live marginal price -> the rate is capped at spot.
		s := NewMemStore()
		curveMarket(s, creator1, 200)
		stFillShort(s, creator1, q-50, MinObsCount, big.NewInt(60_000))
		stFillLong(s, creator1, q-50, stObsCount, big.NewInt(50_000))
		got, err := SettlementRate(s, creator1, q)
		if err != nil {
			t.Fatalf("SettlementRate: %v", err)
		}
		if got.Cmp(big.NewInt(2680)) != 0 {
			t.Fatalf("rate = %s, want 2680 (SpotRate(200) — the no-arbitrage ceiling)", got)
		}
	})

	t.Run("NoShortWindow_CurvePrices", func(t *testing.T) {
		// The inverted young-market refusal: a valid LONG window alone, a
		// short ring below its minimum count -> the curve alone prices.
		s := NewMemStore()
		curveMarket(s, creator1, 200)
		stFillShort(s, creator1, q-50, MinObsCount-1, big.NewInt(1500))
		stFillLong(s, creator1, q-50, stObsCount, big.NewInt(1500))
		got, err := SettlementRate(s, creator1, q)
		if err != nil {
			t.Fatalf("SettlementRate refused with no short window: %v", err)
		}
		if got.Cmp(big.NewInt(2680)) != 0 {
			t.Fatalf("rate = %s, want spot 2680 (no usable short window: the curve alone prices)", got)
		}
	})

	t.Run("StaleShortWindow_CurvePrices", func(t *testing.T) {
		// Staleness is a market condition, not a bug: past MaxStaleBlocks the
		// short window steps aside and spot prices. (Frozen markets are shut
		// upstream by RequireInflowOpen; this is only the rate.)
		s := NewMemStore()
		curveMarket(s, creator1, 200)
		stFillShort(s, creator1, q-50, MinObsCount, big.NewInt(1500))
		got, err := SettlementRate(s, creator1, q-50+MaxStaleBlocks+1)
		if err != nil {
			t.Fatalf("SettlementRate refused on a stale short window: %v", err)
		}
		if got.Cmp(big.NewInt(2680)) != 0 {
			t.Fatalf("rate = %s, want spot 2680 (stale short window: the curve alone prices)", got)
		}
	})

	t.Run("CorruptShortRing_StillRefuses", func(t *testing.T) {
		// A corrupt ring is a BUG, never a market condition: no fallback.
		s := NewMemStore()
		curveMarket(s, creator1, 200)
		setU64(s, kObsIdx(creator1), 3)
		for i := uint64(0); i < 3; i++ {
			setStr(s, kObs(creator1, i), "not-an-observation")
		}
		_, err := SettlementRate(s, creator1, q)
		if err == nil {
			t.Fatal("SettlementRate priced off a corrupt short ring")
		}
		if askErrSymbol(err) != ErrState {
			t.Fatalf("symbol = %q, want %q (err=%v)", askErrSymbol(err), ErrState, err)
		}
	})
}

// TestSettlement_NoArbitrageSpotCeiling is the property behind the spot arm
// (RULING C1): whenever rate <= spot, c = ceil(F/rate) >= F/rate and every
// token in [S, S+c) costs more than spot, so buyCost(S, c) >= F — the c
// tokens the creator receives can never be worth less on the curve than the
// face the asker owed. Checked at the WORST admissible rate (== spot), so it
// holds a fortiori for every lower rate the min() can produce. The ruling's
// own sweep was 36,270 combinations, 0 violations; this re-verifies at the
// compiled integer curve.
func TestSettlement_NoArbitrageSpotCeiling(t *testing.T) {
	rng := rand.New(rand.NewSource(20260721_2))
	for i := 0; i < 4000; i++ {
		S := big.NewInt(1 + rng.Int63n(5000))
		F := big.NewInt(1 + rng.Int63n(int64(MaxFace)))
		rate := SpotRate(S)
		c := creditsForAsk(F, rate)
		cost := BuyCost(S, c)
		if cost.Cmp(F) < 0 {
			t.Fatalf("NO-ARBITRAGE VIOLATION: S=%s F=%s rate=spot=%s c=%s but buyCost=%s < F", S, F, rate, c, cost)
		}
	}
}

// ---- guard boundaries, exact -----------------------------------------------

func TestSettleSpend_MinPriceGuardBoundary(t *testing.T) {
	// RULING C4: face·2 >= rate. Fixture: S=200, rate 2000 (marker below
	// spot 2680; C5 quiet: 1827 <= 8000).
	s := NewMemStore()
	curveMarket(s, creator1, 200)
	q := seedSettleObs(s, creator1, 1000, big.NewInt(2000))

	// face 1000: face·2 == rate exactly — the boundary PASSES.
	if _, err := settleSpend(s, creator1, q, big.NewInt(1000)); err != nil {
		t.Fatalf("face·2 == rate must pass the minimum-price guard: %v", err)
	}
	// face 999: 1998 < 2000 — refused, and by THIS guard.
	_, err := settleSpend(s, creator1, q, big.NewInt(999))
	if err == nil {
		t.Fatal("face below rate/2 must refuse (a 1-token spend would overcharge >2x)")
	}
	if askErrSymbol(err) != ErrState || !strings.Contains(err.Error(), "minimum-price") {
		t.Fatalf("want the minimum-price refusal, got: %v", err)
	}
}

func TestSettleSpend_DepthCeilingBoundary(t *testing.T) {
	// RULING C2 under v5 (2026-09-18): face·10000 <= MaxServiceFaceAreaBps·area(S)
	// with MaxServiceFaceAreaBps == 10000, i.e. the ceiling IS area(S) —
	// area-relative and NEVER reserve-relative. S=200: area = 365,340.
	//
	// The old assertion pinned the 50% form (ceiling 182,670) and, at the
	// boundary, pinned the SPEND CAP firing behind it. Both halves moved in
	// the same ruling, so both are restated here rather than deleted: the
	// ceiling is the market's whole backing, and at the boundary the spend
	// cap no longer fires because a settlement may now consume up to the
	// supply itself.
	s := NewMemStore()
	curveMarket(s, creator1, 200)
	q := seedSettleObs(s, creator1, 1000, big.NewInt(2000))

	// One unit OVER the ceiling: still refused by the depth guard, which
	// still runs BEFORE the spend cap — this also pins the guard order.
	_, err := settleSpend(s, creator1, q, big.NewInt(365_341))
	if err == nil {
		t.Fatal("face above area(S) must refuse")
	}
	if askErrSymbol(err) != ErrState || !strings.Contains(err.Error(), "depth ceiling") {
		t.Fatalf("want the depth-ceiling refusal, got: %v", err)
	}
	// AT the ceiling the spend PRICES: ceil(365,340/2000) = 183 credits,
	// which is under the 200-token supply. A market may sell a service
	// worth everything backing it, to somebody who holds that much of it.
	quote, err := settleSpend(s, creator1, q, big.NewInt(365_340))
	if err != nil {
		t.Fatalf("face == area(S) must price under v5: %v", err)
	}
	if quote.Credits.Cmp(big.NewInt(183)) != 0 {
		t.Fatalf("credits = %s, want 183", quote.Credits)
	}
}

func TestSettleSpend_SpendCapBoundary(t *testing.T) {
	// The spend cap under v5 (2026-09-18) is the SUPPLY ITSELF:
	// c·10000 <= S·MaxSpendSupplyBps with MaxSpendSupplyBps == 10000, i.e.
	// c <= S. It is a structural assertion — a real asker can never exceed
	// it, because credits are escrowed from a balance that is itself <= S —
	// so this test drives settleSpend directly to prove the boundary is
	// still enforced rather than deleted.
	//
	// What the old 5% form asserted (c == 10 passes at S=200, c == 11
	// refuses) is now the ORDINARY case, and it is asserted here too: the
	// 11-credit spend that used to be refused must price.
	s := NewMemStore()
	curveMarket(s, creator1, 200)
	q := seedSettleObs(s, creator1, 1000, big.NewInt(2680))

	// The spend the 5% cap used to refuse.
	quote, err := settleSpend(s, creator1, q, big.NewInt(26_801))
	if err != nil {
		t.Fatalf("an 11-credit spend on a 200-token market must price under v5: %v", err)
	}
	if quote.Credits.Cmp(big.NewInt(11)) != 0 {
		t.Fatalf("credits = %s, want 11", quote.Credits)
	}

	// The boundary itself, in coherent state. The cap is reachable only
	// when the settlement rate sits BELOW the backing per token (area/S):
	// credits = ceil(face/rate) and face is itself capped at area(S), so
	// c > S needs rate < area(S)/S. A short window that has sagged under
	// the backing — but not so far that C5's 4x tripwire fires — is exactly
	// that state. S=200: area 365,340, backing 1,827, C5 floor 457.
	s2 := NewMemStore()
	curveMarket(s2, creator1, 200)
	q2 := seedSettleObs(s2, creator1, 1000, big.NewInt(1000))

	// face 200,000 at rate 1000 -> c == 200 == S exactly: PASSES.
	quote, err = settleSpend(s2, creator1, q2, big.NewInt(200_000))
	if err != nil {
		t.Fatalf("c == exactly the supply must pass: %v", err)
	}
	if quote.Credits.Cmp(big.NewInt(200)) != 0 {
		t.Fatalf("credits = %s, want 200", quote.Credits)
	}

	// face 200,001 -> c == 201 > S: refused, and by THIS guard (the depth
	// ceiling is 365,340 here, so it is not the one talking).
	_, err = settleSpend(s2, creator1, q2, big.NewInt(200_001))
	if err == nil {
		t.Fatal("c above the supply must refuse")
	}
	if askErrSymbol(err) != ErrState || !strings.Contains(err.Error(), "spend cap") {
		t.Fatalf("want the spend-cap refusal, got: %v", err)
	}
}

func TestSettleSpend_KeepsCeilNeverFloor(t *testing.T) {
	// RULING C: the token count stays ceil(face/rate) — floor would admit
	// c == 0, a FREE service. face 1 at rate 2000 -> 1 credit, never 0.
	s := NewMemStore()
	// Zero reserve (see curveMarket's note): rate 2000 is above avg here
	// anyway, but face 1 needs the C4 guard OFF to reach the ceil — no:
	// face 1 FAILS C4 (2 < 2000), which is the point of C4. So prove the
	// ceil at a C4-passing face instead: face 1001 at rate 2000 -> ceil =
	// 1 (floor would give 0 only below rate; here floor(1001/2000) = 0 —
	// exactly the free-service case ceil prevents).
	curveMarket(s, creator1, 200)
	q := seedSettleObs(s, creator1, 1000, big.NewInt(2000))
	quote, err := settleSpend(s, creator1, q, big.NewInt(1001))
	if err != nil {
		t.Fatalf("settleSpend: %v", err)
	}
	if quote.Credits.Cmp(big.NewInt(1)) != 0 {
		t.Fatalf("credits = %s, want 1 — ceil(1001/2000); a floor here would be a FREE service", quote.Credits)
	}
}

// ---- the C5 divergence tripwire --------------------------------------------

func TestSettlementRate_C5Tripwire(t *testing.T) {
	t.Run("QuietOnEqualityState", func(t *testing.T) {
		// A fully coherent market — R === area(S), marker == spot — never
		// trips: backing-per-token is the AVERAGE price, average <= spot =
		// rate < 4·rate. This is the tripwire PROVING the equality
		// invariant, per the ruling.
		s := NewMemStore()
		curveMarket(s, creator1, 100)
		q := seedSettleObs(s, creator1, 1000, big.NewInt(1813)) // == spot(100)
		if _, err := SettlementRate(s, creator1, q); err != nil {
			t.Fatalf("tripwire fired on a coherent equality state: %v", err)
		}
	})

	t.Run("ExactRateBoundary", func(t *testing.T) {
		// ceil(area(100)/100) = 1407. 4·352 = 1408 >= 1407: passes.
		// 4·351 = 1404 < 1407: fires. (Rates this far below the average
		// also mean C4 would need face >= 176 — irrelevant here, the rate
		// derivation runs first.)
		s := NewMemStore()
		curveMarket(s, creator1, 100)
		q := seedSettleObs(s, creator1, 1000, big.NewInt(352))
		if _, err := SettlementRate(s, creator1, q); err != nil {
			t.Fatalf("rate 352 must pass the tripwire (4·352=1408 >= 1407): %v", err)
		}
		s2 := NewMemStore()
		curveMarket(s2, creator1, 100)
		q2 := seedSettleObs(s2, creator1, 1000, big.NewInt(351))
		_, err := SettlementRate(s2, creator1, q2)
		if err == nil {
			t.Fatal("rate 351 must trip (4·351=1404 < ceil(R/S)=1407)")
		}
		if askErrSymbol(err) != ErrState || !strings.Contains(err.Error(), "divergence tripwire") {
			t.Fatalf("want the divergence-tripwire refusal, got: %v", err)
		}
	})

	t.Run("FiresOnCorruptReserve", func(t *testing.T) {
		// The tripwire's actual job: a reserve that somehow exceeds the
		// curve area (the equality invariant broken) refuses settlement
		// loudly instead of pricing against corrupt backing.
		s := NewMemStore()
		curveMarket(s, creator1, 100)
		q := seedSettleObs(s, creator1, 1000, big.NewInt(1813))
		setMoney(s, kReserve(creator1), new(big.Int).Mul(Area(big.NewInt(100)), big.NewInt(10)))
		_, err := SettlementRate(s, creator1, q)
		if err == nil {
			t.Fatal("tripwire must fire when R = 10·area(S)")
		}
		if !strings.Contains(err.Error(), "divergence tripwire") {
			t.Fatalf("want the divergence-tripwire refusal, got: %v", err)
		}
	})
}

// ---- long-ring storage semantics -------------------------------------------

func TestRecordObs_LongRingSpacing(t *testing.T) {
	s := NewMemStore()
	r := big.NewInt(1000)

	RecordObs(s, creator1, 10_000, r)
	if got := getU64(s, kObsLongIdx(creator1)); got != 1 {
		t.Fatalf("long count after first obs = %d, want 1", got)
	}
	// Inside the LONG sampling interval: the long ring does not sample. The
	// SHORT ring has its own, much finer limiter since the SET-1 fix
	// (ShortObsSpacing = 40), so of these two writes only the far one lands:
	// 10_001 is inside the short interval [10_000, 10_040) and is dropped,
	// 10_000+LongObsSpacing-1 is far outside it and is recorded.
	RecordObs(s, creator1, 10_001, r)
	RecordObs(s, creator1, 10_000+LongObsSpacing-1, r)
	if got := getU64(s, kObsIdx(creator1)); got != 2 {
		t.Fatalf("short count = %d, want 2 (one per ShortObsSpacing interval)", got)
	}
	if got := getU64(s, kObsLongIdx(creator1)); got != 1 {
		t.Fatalf("long count = %d, want still 1 (inside the %d-block sampling interval)", got, LongObsSpacing)
	}
	// Exactly at the spacing boundary: sampled.
	RecordObs(s, creator1, 10_000+LongObsSpacing, r)
	if got := getU64(s, kObsLongIdx(creator1)); got != 2 {
		t.Fatalf("long count = %d, want 2 (exactly LongObsSpacing later)", got)
	}
}


// ---- RULING C3: one derivation for every token-settled service ------------

func TestSettlement_AskUsesTheRuledDerivation(t *testing.T) {
	// ★ ORACLE-CLUSTER FIX: divergent-window fixture (short 2500, long 1500,
	// spot 2680). The DERIVED settlement rate is min(spot, median(2500,1500,
	// 2680)) = min(2680, 2500) = 2500 — clearly NEITHER a single naive arm
	// (the old min / long-alone would both be 1500) NOR spot. Every
	// token-settled service path must use exactly the derived rate. (v1 RULING
	// 3c priced off the long window ALONE and that was backwards; the median
	// derivation, capped at spot, is the current rule.)
	const q = uint64(500_000)
	build := func() Store {
		s := NewMemStore()
		curveMarket(s, creator1, 200)
		stFillShort(s, creator1, q-50, MinObsCount, big.NewInt(2500))
		stFillLong(s, creator1, q-50, stObsCount, big.NewInt(1500))
		activateMarket(s, creator1, q)
		setMoney(s, kBal(creator1, asker1), big.NewInt(100))
		return s
	}
	want := big.NewInt(2500) // min(spot 2680, median(2500,1500,2680)=2500)
	face := big.NewInt(3000) // tokenLeg 2640 -> ceil(2640/2500) = 2 credits (face in [1420,207579])

	s := build()
	setMoney(s, kFace(creator1), face)
	askRes, err := askAt0(s, asker1, creator1, q, big.NewInt(2), "cid", MinAskDeadline)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if askRes.RateUsed.Cmp(want) != 0 {
		t.Fatalf("Ask.RateUsed = %s, want %s", askRes.RateUsed, want)
	}
}

// ---- a settlement refusal gates NO funds -----------------------------------

// TestSettlementRefusalGatesNoOutflow is the RULING C / RULING G proof the
// task demands: "Refusing to price is an INFLOW refusal and gates no funds —
// prove no outflow can be blocked by it."
//
// The structural half: the ONLY package caller of SettlementRate/settleSpend
// is Ask — a new-service inflow, RequireInflowOpen-gated. Escrow RESOLUTION
// (Answer/Reclaim) settles at the escrow's RECORDED credit amount; the curve
// rails (Sell) and the wind-down rails (Refund/
// RefundHolder) price off (S, R) directly; fee/treasury exits move recorded
// balances. None of them can even reach a settlement refusal.
//
// The runtime half, end-to-end here: a REAL market prices services, opens
// real escrows, then a corrupt ring drives settlement into refusal
// (verified; since 2026-09-16 a thin or stale ring no longer refuses) — and
// then EVERY outflow in the package is exercised and succeeds: Sell, TransferCredits, Answer, Reclaim, ClaimTradeFees,
// WithdrawTreasury, and (after the natural lapse) Refund and RefundHolder.
func TestSettlementRefusalGatesNoOutflow(t *testing.T) {
	s := NewMemStore()
	const creator = "quietmarket"
	const holder1 = "qholder1"
	const holder2 = "qholder2"
	const owner = "hive:qowner"
	setStr(s, kOwner(), owner)

	regBlock := uint64(10_000)
	if err := Register(s, creator, creator, regBlock, 10_000, MaxCap); err != nil {
		t.Fatalf("Register: %v", err)
	}
	if _, err := Buy(s, holder1, creator, regBlock+1, big.NewInt(2000)); err != nil {
		t.Fatalf("Buy(holder1): %v", err)
	}
	if _, err := Buy(s, holder2, creator, regBlock+2, big.NewInt(500)); err != nil {
		t.Fatalf("Buy(holder2): %v", err)
	}

	// A working settlement window while the market is alive (S=2500:
	// avg_ceil 16,320 so marker 15,000 clears C5 by 4x; spot 37,093 above).
	askBlock := seedSettleObs(s, creator, regBlock+10, big.NewInt(15_000))
	askA, err := askAt0(s, holder1, creator, askBlock, big.NewInt(1), "to-answer", MaxAskDeadline)
	if err != nil {
		t.Fatalf("Ask(to-answer): %v", err)
	}
	askR, err := askAt0(s, holder2, creator, askBlock, big.NewInt(1), "to-reclaim", MinAskDeadline)
	if err != nil {
		t.Fatalf("Ask(to-reclaim): %v", err)
	}

	// Drive settlement into refusal. NOTE (2026-08-12, updated 2026-08-19):
	// this used to go QUIET past MaxStaleBlocks; then (2026-08-12) staleness
	// stopped refusing at all and "quiet" became a plain far-future offset
	// that just happened to reuse MaxStaleBlocks' old (3-day) scale. Now that
	// MaxStaleBlocks is wired again (twap.go) AND widened to 6 weeks, reusing
	// it here would carry `quiet` past the market's own hzLongGap +
	// GraceBlocks and freeze the market — a second, unwanted refusal source
	// this test is not trying to exercise. The property THIS test exists to
	// pin is unchanged and still valuable: *whatever* makes settlement
	// refuse, no outflow may be gated by it. The refusal is induced by a
	// DIFFERENT gate — a ring below the bootstrap minimum, produced by
	// resetting the write counter exactly as Register does when a market
	// re-registers — which needs no particular distance from askBlock at
	// all, so `quiet` is now a small fixed offset instead — large enough to
	// clear askR's own Reclaim window (MinAskDeadline + ReclaimGrace =
	// 28,800 + 1,200 = 30,000) with margin, small enough to stay well inside
	// the market's hzLongGap so it remains ACTIVE (checked below).
	quiet := askBlock + 40_000
	// ★ 2026-09-16: a below-bootstrap ring no longer refuses (the curve alone
	// prices, owner ruling), so the refusal is induced by the one settlement
	// refusal a live market cannot trade its way out of: a CORRUPT short ring
	// (ErrState). The property under test is unchanged — whatever makes
	// settlement refuse, no outflow may be gated by it.
	setU64(s, kObsIdx(creator), 3)
	for i := uint64(0); i < 3; i++ {
		setStr(s, kObs(creator, i), "corrupt")
	}
	if _, err := SettlementRate(s, creator, quiet); err == nil {
		t.Fatal("premise broken: settlement still prices with a corrupt ring")
	}
	// New service inflows are refused now — that is ALL the refusal gates.
	if _, err := askAt0(s, holder1, creator, quiet, big.NewInt(10), "refused", MinAskDeadline); err == nil {
		t.Fatal("premise broken: Ask succeeded while settlement refuses")
	}

	// Every outflow, while settlement is refusing (market still ACTIVE —
	// paidUntil = regBlock + hzLongGap > quiet):
	if got := Phase(s, creator, quiet); got != StateActive {
		t.Fatalf("fixture: phase at quiet = %s, want ACTIVE (quiet=%d)", got, quiet)
	}
	if _, err := Sell(s, holder2, creator, quiet, big.NewInt(100)); err != nil {
		t.Fatalf("OUTFLOW BLOCKED: Sell during settlement refusal: %v", err)
	}
	if err := TransferCredits(s, holder1, creator, holder1, holder2, quiet, big.NewInt(50)); err != nil {
		t.Fatalf("OUTFLOW BLOCKED: TransferCredits during settlement refusal: %v", err)
	}
	if _, err := Answer(s, creator, creator, quiet, askA.Seq, "answered-late"); err != nil {
		t.Fatalf("OUTFLOW BLOCKED: Answer during settlement refusal: %v", err)
	}
	if _, err := Reclaim(s, "anyonepushing", creator, quiet, askR.Seq); err != nil {
		t.Fatalf("OUTFLOW BLOCKED: Reclaim during settlement refusal: %v", err)
	}
	if amt, err := ClaimTradeFees(s, creator); err != nil || amt.Sign() <= 0 {
		t.Fatalf("OUTFLOW BLOCKED: ClaimTradeFees during settlement refusal: amt=%v err=%v", amt, err)
	}
	if amt, err := WithdrawTreasury(s, owner, big.NewInt(1)); err != nil || amt.Sign() <= 0 {
		t.Fatalf("OUTFLOW BLOCKED: WithdrawTreasury during settlement refusal: amt=%v err=%v", amt, err)
	}

	// And the wind-down rails after the natural lapse, still with a refusing
	// oracle. EXITTAX-1/NOTICE-1 (2026-07-22): the RefundHolder push below refuses
	// a still-taxed holder, so this is placed a full ExitTaxDecayBlocks past the
	// freeze — holder1 (bought regBlock+1, clock untouched by its transfers/asks)
	// is fully decayed to τ = 0 there, so the push is an allowed 0-tax sweep. Still
	// FROZEN and the oracle still refusing at this block (both proven below).
	// A1 (2026-08-30): the wind-down rails open on Retire, not on the lapse.
	// The oracle is still refusing and the phase still FROZEN at `frozen`.
	if err := Retire(s, creator, creator, regBlock+hzLongGap+GraceBlocks+10); err != nil {
		t.Fatalf("fixture: Retire: %v", err)
	}
	frozen := regBlock + hzLongGap + GraceBlocks + 10 + ExitTaxDecayBlocks
	if got := Phase(s, creator, frozen); got != StateFrozen {
		t.Fatalf("fixture: phase = %s, want FROZEN", got)
	}
	// At the frozen block the rate itself may exist (spot always does now);
	// what is shut is the INFLOW door. The premise is that no new ask lands.
	if _, err := askAt0(s, holder1, creator, frozen, big.NewInt(1), "frozen-ask", MinAskDeadline); err == nil {
		t.Fatal("premise broken: Ask succeeded at the frozen block")
	}
	if payout, err := Refund(s, holder2, creator, frozen, big.NewInt(10)); err != nil || payout.Sign() <= 0 {
		t.Fatalf("OUTFLOW BLOCKED: Refund during settlement refusal: payout=%v err=%v", payout, err)
	}
	if payout, err := RefundHolder(s, "anyonepushing", creator, holder1, frozen); err != nil || payout.Sign() <= 0 {
		t.Fatalf("OUTFLOW BLOCKED: RefundHolder during settlement refusal: payout=%v err=%v", payout, err)
	}
}

// ---- the lone-attacker walk ------------------------------------------------

// TestSettlement_LoneAttackerWalkDoesNotMovePrice is the simulation the task
// demands: "Simulate a lone attacker writing an observation every block for
// hours and prove settlement does not follow."
//
// The fixture is STRONGER than reality in the attacker's favour: on-chain,
// RecordObs is only ever fed by Buy/Sell with the CURVE's own marginal rate
// (deterministic in S — faking a high rate means actually buying the supply
// up and holding it), while here the attacker writes ARBITRARY escalating
// rates directly. Even so:
//
//   - writing EVERY block collapses the short window's span (32 obs cover 31
//     blocks < MinObsBlocks) — the short window refuses, so settlement
//     refuses: safe, and only service inflows are gated;
//   - spacing writes to keep the short window alive walks the SHORT TWAP,
//     but the LONG (7-day) ring samples at most one write per 6300 blocks,
//     so hours of writing land only 1-2 attacker samples among 12 honest
//     ones: the long median stays honest, the long TWAP must sit within
//     MaxRateDeviationBps of it or refuse, and min() takes the lower arm —
//     the settlement rate can NEVER exceed honest·(1+20%) while the
//     attacker holds less than half the long window (>= 3.5 DAYS of
//     sustained every-block writing, at which point the "manipulation" is
//     indistinguishable from the market genuinely repricing);
//   - the spot arm caps everything at the curve's live marginal price,
//     which direct observation-writing cannot move at all.
func TestSettlement_LoneAttackerWalkDoesNotMovePrice(t *testing.T) {
	const honest = int64(11_500)                                           // == spot(1000): a coherent, real market
	bound := big.NewInt(honest + honest*int64(MaxRateDeviationBps)/10_000) // honest·1.2

	build := func() (Store, uint64) {
		s := NewMemStore()
		curveMarket(s, creator1, 1000)
		last := uint64(100_000)
		resetObsRings(s, creator1)
		for i := uint64(0); i < stObsCount; i++ {
			RecordObs(s, creator1, last-(stObsCount-1-i)*LongObsSpacing, big.NewInt(honest))
		}
		return s, last
	}

	t.Run("EveryBlockWalkUp", func(t *testing.T) {
		// 6 hours of one write per block, rate escalating +0.1%/block up to
		// ~20x honest. The attacker OWNS the entire short window the whole
		// time.
		s, last := build()
		attackBlocks := uint64(6 * 1200) // 6h at ~3s blocks
		rate := big.NewInt(honest)
		step := big.NewInt(honest / 1000) // +0.1%/block
		priced, refused := 0, 0
		for b := uint64(1); b <= attackBlocks; b++ {
			rate = mAdd(rate, step)
			RecordObs(s, creator1, last+b, rate)
			if b%600 == 0 { // sample settlement every ~30min
				got, err := SettlementRate(s, creator1, last+b)
				if err != nil {
					refused++
					continue
				}
				priced++
				if got.Cmp(bound) > 0 {
					t.Fatalf("SETTLEMENT FOLLOWED THE WALK at +%d blocks: rate %s > bound %s (honest %d, attacker last wrote %s)", b, got, bound, honest, rate)
				}
			}
		}
		t.Logf("every-block up-walk to %s (%.1fx honest): %d samples priced <= %s, %d refused — settlement never followed", rate, float64(rate.Int64())/float64(honest), priced, bound, refused)
	})

	t.Run("SpacedWalkUp", func(t *testing.T) {
		// The smarter attacker spaces writes ~200 blocks apart so the short
		// window keeps its minimum span, and escalates 5% per write — for a
		// full DAY (144 writes, reaching >1000x honest at the end). The
		// long ring samples ~4-5 of those among 12 honest samples; its
		// median stays honest, so the long window either refuses (deviation
		// beyond 20% of the honest median) or prices within it, and min()
		// never exceeds it.
		s, last := build()
		rate := big.NewInt(honest)
		priced, refused := 0, 0
		var maxPriced *big.Int
		for w := uint64(1); w <= 144; w++ {
			rate = mAdd(rate, new(big.Int).Div(rate, big.NewInt(20))) // +5%/write
			b := last + w*200
			RecordObs(s, creator1, b, rate)
			got, err := SettlementRate(s, creator1, b+1)
			if err != nil {
				refused++
				continue
			}
			priced++
			if maxPriced == nil || got.Cmp(maxPriced) > 0 {
				maxPriced = got
			}
			if got.Cmp(bound) > 0 {
				t.Fatalf("SETTLEMENT FOLLOWED THE SPACED WALK at write %d (block +%d): rate %s > bound %s", w, w*200, got, bound)
			}
		}
		t.Logf("spaced day-long up-walk to %s (%.0fx honest): %d prices (max %v) <= bound %s, %d refusals — settlement never followed", rate, float64(rate.Int64())/float64(honest), priced, maxPriced, bound, refused)
	})

	t.Run("WalkDownIsBoundedByTheSupplyAndTheAskersOwnCeiling", func(t *testing.T) {
		// The DOWN direction: min() genuinely follows a walked-down rate —
		// by design, a lower rate only makes services cost MORE tokens, and
		// the asker consents via maxCredits. What the attacker wants from a
		// down-walk is to make ONE settlement move a huge slice of supply
		// to the creator.
		//
		// ★ v5 (2026-09-18) — WHAT BOUNDS IT NOW. The 5%-of-supply cap was
		// removed (params.go MaxSpendSupplyBps, and the measurements there),
		// so this subtest asserts the bounds that remain, which are the ones
		// that were always doing the work:
		//
		//   a) the spend cap still refuses a settlement that would consume
		//      MORE THAN THE SUPPLY ITSELF — asserted below;
		//   b) the depth ceiling still caps the face at area(S), and C5's
		//      tripwire refuses a rate that has sagged 4x under the backing,
		//      so the reachable credit count stays finite by construction;
		//   c) the asker's own signed maxCredits bounds their exposure at the
		//      Ask() door, before any balance is touched — that is
		//      TestAskMaxCreditsSlippageGuard, and it is the protection an
		//      asker actually relies on;
		//   d) credits are escrowed from the asker's balance, which is <= S,
		//      so a settlement can never move tokens that do not exist.
		s, last := build()
		rate := big.NewInt(honest)
		for w := uint64(1); w <= 60; w++ {
			rate = new(big.Int).Sub(rate, new(big.Int).Div(rate, big.NewInt(25))) // -4%/write
			RecordObs(s, creator1, last+w*200, rate)
		}
		q := last + 60*200 + 1
		got, err := SettlementRate(s, creator1, q)
		if err != nil {
			// Refusing is an equally safe outcome (deviation guards).
			t.Logf("down-walk: settlement refused outright (%v) — safe", err)
			return
		}
		// It priced below honest. The damage bound: a face needing MORE
		// credits than the whole supply still refuses.
		supply := getMoney(s, kSupply(creator1))
		overSupply := mAdd(new(big.Int).Mul(got, supply), big.NewInt(1)) // ceil -> S+1 credits
		_, err = settleSpend(s, creator1, q, overSupply)
		if err == nil {
			t.Fatalf("down-walked market allowed a %s-face settlement needing more credits than the %s-token supply", overSupply, supply)
		}
		if !strings.Contains(err.Error(), "spend cap") && !strings.Contains(err.Error(), "depth ceiling") {
			t.Fatalf("want the spend-cap (or depth) refusal on the down-walked spend, got: %v", err)
		}
		t.Logf("down-walk to %s (%.2fx honest): priced, but a spend above the %s-token supply refuses (%v)", got, float64(got.Int64())/float64(honest), supply, err)
	})
}
