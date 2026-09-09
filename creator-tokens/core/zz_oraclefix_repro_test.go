package core

import (
	"math/big"
	"testing"
)

// zz_oraclefix_repro_test.go — INSTRUMENT + PROOF (additive, scratch-only) for
// the oracle-cluster fix: SettlementRate is now min(spot, median(short, long,
// spot)) instead of min(short, long, spot). BEFORE = the old three-way min,
// computed inline here as mMin(mMin(short,long),spot); AFTER = the live
// SettlementRate. Storage-level ring construction, exactly the way
// settlement_test.go builds divergent windows. All three findings, one change.

func ofOldMin(short, long, spot *big.Int) *big.Int { return mMin(mMin(short, long), spot) }

func ofWriteShort(s Store, c string, start uint64, rates []*big.Int) uint64 {
	for i, r := range rates {
		setStr(s, kObs(c, uint64(i)%ObsWindow), packTwapObs(start+uint64(i)*ShortObsSpacing, r))
	}
	setU64(s, kObsIdx(c), uint64(len(rates)))
	return start + uint64(len(rates)-1)*ShortObsSpacing
}

// ---------------------------------------------------------------------------
// CT-ORACLE-01 — the short-ring dwell-clamp walk, with supply RESTORED. A lone
// depressed marker saturates the clamp and walks the SHORT twap ~16% down; the
// old min() followed it, so settlement fell ~16% while the market's real
// supply/position were fully restored. The median discards the lone low arm.
// ---------------------------------------------------------------------------
func TestOF_CTORACLE01_SettlementWalkClosed(t *testing.T) {
	const c = "of01"
	const S = int64(9350)
	const dump = int64(1349)
	honest := SpotRate(big.NewInt(S))
	depressed := SpotRate(big.NewInt(S - dump))

	build := func(attack bool) (short, long, spot, settle *big.Int) {
		s := NewMemStore()
		curveMarket(s, c, S) // supply=S, reserve=Area(S) — RESTORED
		activateMarket(s, c, 0)
		rates := make([]*big.Int, 0, 32)
		for i := 0; i < 31; i++ {
			rates = append(rates, honest)
		}
		if attack {
			rates = append(rates, depressed)
		} else {
			rates = append(rates, honest)
		}
		last := ofWriteShort(s, c, 1_000_000, rates)
		stFillLong(s, c, last, stObsCount, honest) // long ring unmoved
		q := last + MaxObsWeightBlocks             // marker dwell saturates the clamp
		short, _ = AskRate(s, c, q)
		long, _ = askRateLong(s, c, q)
		spot = SpotRate(big.NewInt(S))
		settle, _ = SettlementRate(s, c, q)
		return
	}

	_, _, _, hSettle := build(false)
	aShort, aLong, aSpot, aSettle := build(true)

	oldMin := ofOldMin(aShort, aLong, aSpot) // what the shipped min() would have returned
	walkOld := 100 * f2(new(big.Int).Sub(oldMin, hSettle)) / f2(hSettle)
	walkNew := 100 * f2(new(big.Int).Sub(aSettle, hSettle)) / f2(hSettle)
	t.Logf("CT-ORACLE-01: honest settle=%s | short walked to %s (%.2f%%)", hSettle, aShort,
		100*f2(new(big.Int).Sub(aShort, hSettle))/f2(hSettle))
	t.Logf("  BEFORE (old min): settle=%s  walk=%.2f%%   AFTER (median): settle=%s  walk=%.2f%%",
		oldMin, walkOld, aSettle, walkNew)

	if oldMin.Cmp(hSettle) >= 0 {
		t.Fatalf("instrument broken: old min %s should have walked BELOW honest %s", oldMin, hSettle)
	}
	if aSettle.Cmp(hSettle) != 0 {
		t.Fatalf("CT-ORACLE-01 NOT closed: median settle=%s != honest %s (walk %.2f%%)", aSettle, hSettle, walkNew)
	}
}

// ---------------------------------------------------------------------------
// CT-ORACLE-02 — honest growth closes the services path for ~5.69 days. A market
// that grew fast has a HIGH spot and a caught-up SHORT ring, but the 7-day LONG
// ring still holds stale-low samples. The old min() picked that stale long, so
// backing/rate blew past the C5 4x divergence tripwire and Ask refused until the
// long ring caught up (26 samples · 6300 blocks = 5.69 days, unshortenable). The
// median discards the lone stale long, so the shop stays open — and the remedy
// (the SHORT ring) the creator CAN feed at a 40-block cadence.
// ---------------------------------------------------------------------------
func TestOF_CTORACLE02_HonestGrowthKeepsShopOpen(t *testing.T) {
	const c = "of02"
	const grown = int64(4000) // 10x growth from ~400
	s := NewMemStore()
	curveMarket(s, c, grown) // supply=4000, reserve=Area(4000)
	activateMarket(s, c, 0)
	q := uint64(2_000_000)
	spot := SpotRate(big.NewInt(grown))          // ~74,500 (the grown marginal)
	stale := SpotRate(big.NewInt(400))            // ~4,570 (the pre-growth long-ring rate)
	// SHORT ring caught up to the grown rate (creator/organic trades feed it every 40 blocks).
	short := make([]*big.Int, 32)
	for i := range short {
		short[i] = spot
	}
	last := ofWriteShort(s, c, q-40*40, short)
	stFillLong(s, c, last, stObsCount, stale) // LONG ring still stale-low
	qq := last + 50

	shortR, _ := AskRate(s, c, qq)
	longR, _ := askRateLong(s, c, qq)
	backing := mMulDivCeil(getMoney(s, kReserve(c)), big.NewInt(1), getMoney(s, kSupply(c)))
	oldMin := ofOldMin(shortR, longR, spot)
	oldLimit := new(big.Int).Mul(oldMin, big.NewInt(int64(DivergenceRateMultiple)))
	oldRefuses := backing.Cmp(oldLimit) > 0

	newRate, newErr := SettlementRate(s, c, qq)
	t.Logf("CT-ORACLE-02: backing=%s spot=%s short=%s staleLong=%s", backing, spot, shortR, longR)
	t.Logf("  BEFORE (old min): rate=%s  4x=%s  backing>4x => Ask REFUSES=%v (the 5.69-day lockout)", oldMin, oldLimit, oldRefuses)
	t.Logf("  AFTER (median):   rate=%v  err=%v  => Ask PRICES (shop stays open on honest growth)", newRate, newErr)

	if !oldRefuses {
		t.Fatalf("instrument broken: the old min should have tripped C5 (backing %s <= 4x %s)", backing, oldLimit)
	}
	if newErr != nil {
		t.Fatalf("CT-ORACLE-02 NOT fixed: median settlement still refuses on honest growth: %v", newErr)
	}
	if newRate.Cmp(spot) > 0 {
		t.Fatalf("no-arbitrage breached: rate %s > spot %s", newRate, spot)
	}
}

// ---------------------------------------------------------------------------
// PRICE-3 — a rising market over-charges every asker because the old min() used
// the stalest (lowest) arm, charging the most tokens for a face-priced service.
// The median uses the middle arm (still <= spot), so the asker pays FEWER tokens
// — closer to fair — while never dropping below the honest floor.
// ---------------------------------------------------------------------------
func TestOF_PRICE3_RisingMarketOverchargeReduced(t *testing.T) {
	const c = "ofp3"
	const S = int64(4000)
	s := NewMemStore()
	curveMarket(s, c, S)
	activateMarket(s, c, 0)
	q := uint64(3_000_000)
	spot := SpotRate(big.NewInt(S)) // 74,500 — the live marginal (rising)
	shortRate := big.NewInt(50_000) // recent avg, lags spot
	longRate := big.NewInt(27_250)  // 7-day avg, lags most (the stalest arm)
	last := ofWriteShort(s, c, q-32*40, func() []*big.Int {
		r := make([]*big.Int, 32)
		for i := range r {
			r[i] = shortRate
		}
		return r
	}())
	stFillLong(s, c, last, stObsCount, longRate)
	qq := last + 50

	sh, _ := AskRate(s, c, qq)
	lo, _ := askRateLong(s, c, qq)
	oldRate := ofOldMin(sh, lo, spot) // == longRate, the stalest
	newRate, err := SettlementRate(s, c, qq)
	if err != nil {
		t.Fatalf("settlement refused: %v", err)
	}
	// tokens charged for a fixed face; fewer tokens at the higher (median) rate.
	face := big.NewInt(10_000_000)
	oldCredits := creditsForAsk(face, oldRate)
	newCredits := creditsForAsk(face, newRate)
	t.Logf("PRICE-3 rising market: spot=%s short=%s staleLong=%s", spot, sh, lo)
	t.Logf("  BEFORE (old min=stale long %s): asker charged %s tokens for a %s face", oldRate, oldCredits, face)
	t.Logf("  AFTER  (median %s):             asker charged %s tokens  (%.1f%% fewer, never below spot)",
		newRate, newCredits, 100*(1-f2(newCredits)/f2(oldCredits)))
	if newRate.Cmp(oldRate) <= 0 {
		t.Fatalf("PRICE-3 not improved: median rate %s <= old stale rate %s (would not reduce the overcharge)", newRate, oldRate)
	}
	if newRate.Cmp(spot) > 0 {
		t.Fatalf("no-arbitrage breached: rate %s > spot %s", newRate, spot)
	}
	if newCredits.Cmp(oldCredits) >= 0 {
		t.Fatalf("PRICE-3 not improved: asker charged %s tokens, not fewer than the old %s", newCredits, oldCredits)
	}
}
