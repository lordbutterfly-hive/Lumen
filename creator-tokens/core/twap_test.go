package core

import (
	"math/big"
	"testing"
)

// twap_test.go — this module is the only defence against the verified
// producer-ordering price-manipulation defect (SPEC-CREATOR-KEYS.md §1.3b),
// so it is tested like a security control: exact hand-computed values, not
// "roughly right"; every guard proven both to fire and to have the correct
// boundary; the ring buffer proven to actually evict, not just accept writes
// past its size; and internal-state assertions (not just the public return
// value) wherever that makes the proof stronger.

func assertErrSymbol(t *testing.T, err error, symbol string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error with symbol %s, got nil", symbol)
	}
	e, ok := err.(*Err)
	if !ok {
		t.Fatalf("expected *Err, got %T: %v", err, err)
	}
	if e.Symbol != symbol {
		t.Fatalf("expected error symbol %s, got %s (%v)", symbol, e.Symbol, err)
	}
}

func mustBigStr(s string) *big.Int {
	v, ok := new(big.Int).SetString(s, 10)
	if !ok {
		panic("bad big.Int literal in test: " + s)
	}
	return v
}

// recordConst writes one observation per block in blocks, all at the same rate.
func recordConst(s Store, creator string, blocks []uint64, rate int64) {
	for _, b := range blocks {
		RecordObs(s, creator, b, big.NewInt(rate))
	}
}

// ---------------------------------------------------------------------------
// Refusal conditions: too few observations, window too short. Both must
// error rather than fall back to spot — a young market has no usable price.
// ---------------------------------------------------------------------------

func TestTwapTooFewObservations(t *testing.T) {
	s := NewMemStore()
	creator := "alice"

	// 7 distinct-block observations spanning 12000 blocks — the SPAN guard
	// would happily pass; only the COUNT guard (MinObsCount=8) should fire,
	// proving the two guards are independent and neither substitutes for the
	// other.
	blocks := []uint64{0, 2000, 4000, 6000, 8000, 10000, 12000}
	recordConst(s, creator, blocks, 1000)

	_, err := AskRate(s, creator, 13000)
	assertErrSymbol(t, err, ErrOracle)

	// Add the 8th observation: now both guards are satisfied and the same
	// creator/rate history prices cleanly.
	RecordObs(s, creator, 14000, big.NewInt(1000))
	rate, err := AskRate(s, creator, 15000)
	if err != nil {
		t.Fatalf("expected success once MinObsCount is met, got %v", err)
	}
	if rate.Cmp(big.NewInt(1000)) != 0 {
		t.Fatalf("expected 1000, got %s", rate)
	}
}

func TestTwapWindowTooShort(t *testing.T) {
	s := NewMemStore()
	creator := "bob"

	// 8 observations (MinObsCount satisfied) clustered in the first 280
	// blocks — the COUNT guard passes; only the SPAN guard (MinObsBlocks =
	// 1200) should fire.
	//
	// SET-1 FIX (2026-07-22): the spacing is ShortObsSpacing (40), not 10.
	// RecordObs now rate-limits the SHORT ring the way it always
	// rate-limited the long one, so 10-block-spaced writes would land only 2
	// samples and this test would fire the COUNT guard instead of the SPAN
	// guard it exists to pin. Same intent, minimum legal spacing.
	blocks := []uint64{0, 40, 80, 120, 160, 200, 240, 280}
	recordConst(s, creator, blocks, 1000)

	// Exact boundary: windowBlocks = block - oldest.
	if _, err := AskRate(s, creator, 1199); err == nil {
		t.Fatalf("expected refusal at windowBlocks=1199 (< MinObsBlocks)")
	} else {
		assertErrSymbol(t, err, ErrOracle)
	}

	// One block later the window exactly meets MinObsBlocks and must pass.
	rate, err := AskRate(s, creator, 1200)
	if err != nil {
		t.Fatalf("expected success at windowBlocks==MinObsBlocks exactly, got %v", err)
	}
	if rate.Cmp(big.NewInt(1000)) != 0 {
		t.Fatalf("expected 1000, got %s", rate)
	}
}

// ---------------------------------------------------------------------------
// Exact weighted-average arithmetic, hand-computed.
// ---------------------------------------------------------------------------

// TestTwapExactWeightedAverage hand-verifies the integer weighting formula.
// 7 observations at rate 1000 spaced 1000 blocks apart, then an 8th at rate
// 1100 (a 10% bump, inside the 20% cap). Query one interval later.
//
//	weighted sum = 7 * (1000 blocks * 1000 rate) + (1000 blocks * 1100 rate)
//	             = 7,000,000 + 1,100,000 = 8,100,000
//	totalWeight  = 8000 - 0 = 8000
//	twap         = floor(8,100,000 / 8000) = floor(1012.5) = 1012
func TestTwapExactWeightedAverage(t *testing.T) {
	s := NewMemStore()
	creator := "carol"

	blocks := []uint64{0, 1000, 2000, 3000, 4000, 5000, 6000}
	recordConst(s, creator, blocks, 1000)
	RecordObs(s, creator, 7000, big.NewInt(1100))

	rate, err := AskRate(s, creator, 8000)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := big.NewInt(1012)
	if rate.Cmp(want) != 0 {
		t.Fatalf("expected exact twap %s, got %s", want, rate)
	}
}

// ---------------------------------------------------------------------------
// Manipulation scenario: long stable history, then one wildly-off observation
// in the latest block. Two paired tests, same stable base:
//   - a spike that stays inside MaxRateDeviationBps proves the TWAP barely
//     moves (time-weighting alone defeats it: exact same 1000 result as the
//     unperturbed history);
//   - a much larger spike proves the deviation cap trips and the ask
//     REVERTS rather than settling at a suspicious price, even though the
//     time-weighted number itself (1000, unretrievable through the public
//     API once capped) is just as unmoved as in the first case. That is the
//     point of having both defences: time-weighting hides a small deceptive
//     read; the cap catches a large one that time-weighting would otherwise
//     also quietly absorb.
// ---------------------------------------------------------------------------

func stableTenObservations(s Store, creator string) {
	blocks := []uint64{0, 3000, 6000, 9000, 12000, 15000, 18000, 21000, 24000, 27000}
	recordConst(s, creator, blocks, 1000)
}

// weighted sum = 9*(3000*1000) + 1*(1*1000) + 1*(1*spikeRate)
//
//	= 27,000,000 + 1,000 + spikeRate
//
// totalWeight  = 27002
func TestTwapManipulationSpikeWithinCapBarelyMoves(t *testing.T) {
	s := NewMemStore()
	creator := "dave"
	stableTenObservations(s, creator)

	// Spike: rate 1150 (15% above the 1000 baseline, inside the 20% cap),
	// recorded 1 block after the stable history, queried 1 block after that.
	RecordObs(s, creator, 27001, big.NewInt(1150))

	rate, err := AskRate(s, creator, 27002)
	if err != nil {
		t.Fatalf("expected the ask to price despite the spike, got %v", err)
	}
	// sum = 27,000,000 + 1,000 + 1,150 = 27,002,150
	// twap = floor(27,002,150 / 27002) = floor(1000.0055...) = 1000
	want := big.NewInt(1000)
	if rate.Cmp(want) != 0 {
		t.Fatalf("expected the TWAP to barely move off the stable baseline (want %s), got %s — spike observation was 1150", want, rate)
	}
}

// SEMANTICS CHANGED AT INTEGRATION (adjudicating thread, not Agent 5).
//
// This test previously asserted that a single 5x spike REVERTS the ask, because
// the deviation cap compared the TWAP against the newest RAW observation. That
// reference point was self-referential — on a quiet market the newest write
// carries nearly all the time-weight, so it sets the TWAP and then passes its
// own check — and refusing here protects nothing while creating a cheap denial
// of service: anyone able to move the pool for one block could block every ask
// against a creator by spiking and immediately unwinding.
//
// The correct outcome is that the spike is ABSORBED. The attacker pumped spot
// to 5000 and still pays at the honest time-weighted 1000, so the manipulation
// simply failed. The deviation cap now measures against the window MEDIAN,
// which one write cannot move — see TestTwapDeviationCapTripsOnWeightSkew for
// the case it does catch.
func TestTwapSpikeIsAbsorbedNotRejected(t *testing.T) {
	s := NewMemStore()
	creator := "erin"
	stableTenObservations(s, creator)

	RecordObs(s, creator, 27001, big.NewInt(5000)) // 5x pump

	rate, err := AskRate(s, creator, 27002)
	if err != nil {
		t.Fatalf("a single-block spike must be absorbed, not rejected (that would be a griefing vector): %v", err)
	}
	if rate.Cmp(big.NewInt(1000)) != 0 {
		t.Fatalf("expected the 5x spike to be diluted to the honest baseline 1000, got %s", rate)
	}
}

// The case the deviation cap exists for: the time-weighted average has been
// dragged away from the body of the distribution because one observation holds
// outsized weight. Median stays at the honest 1000; the TWAP does not.
//
// CORRECTION (mutation-testing audit, 2026-07-20 — GAP 1): this test was
// previously described, and believed, to prove the MaxObsWeightBlocks weight
// clamp in AskRate. It does not, and a mutation run confirms it: deleting
// `if w > MaxObsWeightBlocks { w = MaxObsWeightBlocks }` from AskRate does
// not change this test's outcome at all. The reason is the exact query block
// chosen — 700+MaxObsWeightBlocks: the newest observation's RAW dwell there
// is `(700+MaxObsWeightBlocks) - 700 == MaxObsWeightBlocks`, i.e. exactly
// equal to the cap, never exceeding it. The clamp's guard is `w >
// MaxObsWeightBlocks` (strictly greater), so at this boundary the condition
// is false and the line is a no-op — deleting it changes nothing here.
//
// What actually trips this test is the SEPARATE median deviation cap
// (params.go, MaxRateDeviationBps): one 3000-rate observation carrying
// almost all of the window's time-weight (2400 of 3100 total, ~77%) drags
// the raw time-weighted average far enough from the 1000 median that the
// deviation check reverts the ask — a defence that fires identically whether
// or not the weight-clamp line exists, since it operates on whatever `twap`
// value came out of the (clamped-or-not) weighting loop. This test's
// assertion (ErrOracle) was always correct; only the rationale above it was
// wrong, and is now stated accurately.
//
// Real coverage of the weight clamp itself — a case where deleting the
// clamp line changes AskRate's RETURNED VALUE, not just its error/no-error
// outcome — is TestTwapWeightClampChangesReturnedRate, immediately below.
func TestTwapDeviationCapTripsOnWeightSkew(t *testing.T) {
	s := NewMemStore()
	creator := "frank"

	// Seven honest observations packed into short intervals, then one
	// high-rate observation left to dwell for exactly one clamp-window's
	// worth of blocks — NOT "until the clamp fires"; see the correction
	// above: at this precise query block the clamp guard is false (w ==
	// MaxObsWeightBlocks, not >), so it never engages.
	for i, b := range []uint64{0, 100, 200, 300, 400, 500, 600} {
		_ = i
		RecordObs(s, creator, b, big.NewInt(1000))
	}
	RecordObs(s, creator, 700, big.NewInt(3000))

	// Query at exactly 700+MaxObsWeightBlocks: the MEDIAN DEVIATION cap trips
	// here (see correction above) — independent of whether the weight clamp
	// line exists at all.
	_, err := AskRate(s, creator, 700+MaxObsWeightBlocks)
	assertErrSymbol(t, err, ErrOracle)
}

// TestTwapWeightClampChangesReturnedRate — GAP 1 closure (mutation-testing
// audit, 2026-07-20). The audit instrumented `if w > MaxObsWeightBlocks { w
// = MaxObsWeightBlocks }` in AskRate: across all 145 existing tests plus
// every fuzz property, that line executed 15,131 times with not one
// assertion pinned to its effect — deleting it produced ZERO test failures.
// TestTwapDeviationCapTripsOnWeightSkew (above) was believed to cover it but
// does not (see the correction on that test). This test constructs a case
// where the clamp is the ONLY thing separating two different,
// both-individually-legal (deviation-cap-passing) answers, and asserts the
// clamped one — so it fails on a value mismatch, not a spurious error, if
// the clamp line is ever removed.
//
// Setup: seven honest observations at rate 1000, 100 blocks apart
// (0,100,...,600), then one observation at rate 1200 at block 700, queried
// 50,000 blocks later. 50,000 is far past MaxObsWeightBlocks (2400) — 20x
// the clamp — so the newest observation's RAW dwell is 50,000 but its
// CLAMPED dwell is 2400; and 50,000 is comfortably inside MaxStaleBlocks
// (86,400) so the staleness guard does not intervene first.
//
// Hand-computed (independently verified against the exact same big.Int
// arithmetic AskRate uses, in a throwaway script — both branches, reported
// alongside this change):
//
//	median of the 8 rates = 1000 (seven 1000s, one 1200 — even count, mean
//	of the two middle values, both 1000).
//
//	WITH the clamp (the last observation's w = min(50000, 2400) = 2400):
//	  totalW   = 7*100 + 2400 = 3100
//	  weighted = 7*(100*1000) + 2400*1200 = 700,000 + 2,880,000 = 3,580,000
//	  twap     = floor(3,580,000 / 3,100) = 1154
//	  deviation check: |1154-1000|*10000 = 1,540,000 <= 1000*2000 =
//	  2,000,000 — PASSES. AskRate returns (1154, nil).
//
//	WITHOUT the clamp (the line under test deleted, so w = 50000 unclamped):
//	  totalW   = 700 + 50000 = 50700
//	  weighted = 700,000 + 50000*1200 = 700,000 + 60,000,000 = 60,700,000
//	  twap     = floor(60,700,000 / 50,700) = 1197
//	  deviation check: |1197-1000|*10000 = 1,970,000 <= 2,000,000 — STILL
//	  PASSES (barely: 30,000 of margin out of 2,000,000). So deleting the
//	  clamp does NOT make AskRate revert here; it silently returns the WRONG
//	  price, 1197 instead of 1154 — exactly the manipulation
//	  MaxObsWeightBlocks exists to prevent (params.go's own doc: "a market
//	  nobody has touched for weeks gives its newest observation a dwell time
//	  covering the entire gap — so one opportunistically timed write
//	  dominates the average").
//
// VERIFIED BY ACTUAL DELETION: this test was run against a scratch copy of
// core/twap.go with the clamp line removed. It failed exactly as predicted —
// "AskRate = 1197, want exactly 1154" — then the line was restored and
// `go test ./core/...` was re-confirmed green. See the task report for the
// exact commands run.
func TestTwapWeightClampChangesReturnedRate(t *testing.T) {
	s := NewMemStore()
	creator := "mallory"

	for _, b := range []uint64{0, 100, 200, 300, 400, 500, 600} {
		RecordObs(s, creator, b, big.NewInt(1000))
	}
	RecordObs(s, creator, 700, big.NewInt(1200))

	const dwell = uint64(50000) // >> MaxObsWeightBlocks(2400): the clamp must engage. << MaxStaleBlocks(86400): the staleness guard must not fire first.
	if dwell <= MaxObsWeightBlocks {
		t.Fatalf("test setup bug: dwell %d must exceed MaxObsWeightBlocks %d for the clamp to actually engage", dwell, MaxObsWeightBlocks)
	}
	if dwell > MaxStaleBlocks {
		t.Fatalf("test setup bug: dwell %d must stay inside MaxStaleBlocks %d or the staleness guard fires before the clamp is ever reached", dwell, MaxStaleBlocks)
	}
	queryBlock := uint64(700) + dwell

	rate, err := AskRate(s, creator, queryBlock)
	if err != nil {
		t.Fatalf("expected the clamped rate to price cleanly (within the median deviation cap — see the hand-computed comment above), got error: %v", err)
	}
	want := big.NewInt(1154)
	if rate.Cmp(want) != 0 {
		t.Fatalf("AskRate = %s, want exactly %s (clamped-weight computation, see comment above) — if this reads 1197 instead, the MaxObsWeightBlocks clamp in AskRate has been removed or broken", rate, want)
	}
}

// A market nobody has touched for longer than MaxStaleBlocks must refuse to
// price rather than quote from stale data. Re-enabled 2026-08-19 at a
// widened (6-week) horizon after being disabled outright 2026-08-12 (owner
// ruling: the OLD 3-day setting fired on ordinary quiet markets). See
// twapWindowRead's comment in twap.go for the full history and the
// self-heal argument the new horizon depends on.
//
// Both directions are pinned here — a quiet-but-not-ancient market still
// prices, a genuinely ancient one refuses — because either "never refuses"
// or "always refuses past the old 3-day mark" would be the wrong fix, and
// this test is what stops it drifting either way. TestTwapWeightClampChangesReturnedRate's
// dwell (50,000 blocks, ~1.7 days) already proves an ORDINARY-quiet-gap
// query still prices; this test covers the two ends this file must not
// silently invert again.
func TestTwapPricesWhenQuietOnceBootstrapped(t *testing.T) {
	s := NewMemStore()
	creator := "grace"
	stableTenObservations(s, creator)
	// stableTenObservations' newest observation is at block 27000 — every gap
	// below is measured from there.

	// (a) A bootstrapped ring still PRICES through an ordinary quiet spell —
	// including right up to the horizon itself (boundary is accept, not
	// refuse: block-newest > cfg.maxStale is what refuses, so exactly
	// MaxStaleBlocks of gap must still price).
	for _, gap := range []uint64{1, BlocksPerDay, 2 * 7 * BlocksPerDay, MaxStaleBlocks} {
		rate, err := AskRate(s, creator, 27000+gap)
		if err != nil {
			t.Fatalf("gap=%d: bootstrapped ring refused to price inside the staleness horizon: %v", gap, err)
		}
		if rate == nil || rate.Sign() <= 0 {
			t.Fatalf("gap=%d: priced non-positively (%v) — a quiet market must still quote its average", gap, rate)
		}
	}

	// (b) A ring genuinely older than the horizon REFUSES rather than quoting
	// stale data — the anti-vacuity pin: this is what stops the check above
	// from having been satisfied by a "never refuses" regression.
	for _, gap := range []uint64{MaxStaleBlocks + 1, 10 * MaxStaleBlocks, 100 * MaxStaleBlocks} {
		if _, err := AskRate(s, creator, 27000+gap); errSymbol(err) != ErrOracle {
			t.Fatalf("gap=%d: expected an ErrOracle staleness refusal, got err=%v", gap, err)
		}
	}

	// (c) A market that has NOT bootstrapped still refuses regardless of how
	// far out it is queried. The count/span gate is the bootstrap latch and
	// it must keep biting — this is checked at a gap the staleness horizon
	// would also refuse, so a passing test here cannot be masking a broken
	// bootstrap gate behind the (unrelated) staleness one.
	fresh := NewMemStore()
	RecordObs(fresh, "newbie", 1000, mpBig(5000))
	if _, err := AskRate(fresh, "newbie", 1000+MaxStaleBlocks+1); err == nil {
		t.Fatal("a single-observation market priced; the bootstrap gate is gone")
	} else {
		assertErrSymbol(t, err, ErrOracle)
	}
}

// ---------------------------------------------------------------------------
// Ring-buffer wraparound: write more than ObsWindow observations and prove
// the earliest ones are evicted, not merely that later ones are appended.
// ---------------------------------------------------------------------------

func TestTwapRingBufferWraparound(t *testing.T) {
	s := NewMemStore()
	creator := "frank"

	if ObsWindow != 32 {
		t.Fatalf("this test's arithmetic assumes ObsWindow==32, got %d — update the test", ObsWindow)
	}

	// Write 40 distinct-block observations. The first 8 (rate=1, a value
	// wildly different from the rest) MUST be evicted once the 33rd write
	// happens; the remaining 32 (rate=1000) must be exactly what AskRate
	// averages over.
	for i := uint64(0); i < 40; i++ {
		block := i * 100
		rate := int64(1000)
		if i < 8 {
			rate = 1
		}
		RecordObs(s, creator, block, big.NewInt(rate))
	}

	if n := getU64(s, kObsIdx(creator)); n != 40 {
		t.Fatalf("expected kObsIdx to keep counting total writes (40), got %d", n)
	}

	// Physical slot 7 was written twice: once by seq7 (block=700, rate=1)
	// and again by seq39 (block=3900, rate=1000), since 7%32 == 39%32 == 7.
	// Confirm the overwrite actually happened at the storage layer.
	o, ok := readTwapObs(s, creator, 7)
	if !ok {
		t.Fatalf("expected slot 7 to be populated")
	}
	if o.block != 3900 || o.rate.Cmp(big.NewInt(1000)) != 0 {
		t.Fatalf("expected slot 7 to hold the seq39 overwrite (block=3900, rate=1000), got block=%d rate=%s", o.block, o.rate)
	}

	// If eviction were broken (e.g. an off-by-one kept one rate=1 sample in
	// the averaged set), this would not equal exactly 1000.
	// Query 5,000 blocks after the newest write. The original 100000 predated
	// the MaxStaleBlocks guard added at integration and sat ~96k blocks past
	// the last observation, which is now (correctly) refused as stale. Any
	// in-window query proves eviction just as well: a surviving rate=1 sample
	// would drag the average off 1000 regardless of how far out we ask.
	rate, err := AskRate(s, creator, 3900+5000)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := big.NewInt(1000)
	if rate.Cmp(want) != 0 {
		t.Fatalf("expected the evicted rate=1 observations to have zero influence (want %s), got %s", want, rate)
	}
}

// ---------------------------------------------------------------------------
// Same-block duplicate observations are ignored (first writer wins).
// ---------------------------------------------------------------------------

func TestTwapDuplicateBlockIgnored(t *testing.T) {
	s := NewMemStore()
	creator := "grace"

	blocks := []uint64{0, 1000, 2000, 3000, 4000, 5000, 6000, 7000}
	recordConst(s, creator, blocks, 1000)

	if n := getU64(s, kObsIdx(creator)); n != 8 {
		t.Fatalf("expected 8 recorded observations, got %d", n)
	}

	// A second call in the SAME block (7000) with a wildly different rate
	// must be a no-op.
	RecordObs(s, creator, 7000, big.NewInt(99999))

	if n := getU64(s, kObsIdx(creator)); n != 8 {
		t.Fatalf("duplicate-block observation must not advance the write index, got count %d", n)
	}
	o, ok := readTwapObs(s, creator, 7%ObsWindow)
	if !ok || o.rate.Cmp(big.NewInt(1000)) != 0 {
		t.Fatalf("duplicate-block observation must not overwrite the first writer's rate; slot now holds %+v", o)
	}

	// And it must not leak into the priced average either.
	rate, err := AskRate(s, creator, 8000)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rate.Cmp(big.NewInt(1000)) != 0 {
		t.Fatalf("expected 1000 (the 99999 duplicate must not influence the TWAP), got %s", rate)
	}
}

// ---------------------------------------------------------------------------
// Integer-math edge cases: rate=1, a very large rate, and an all-identical
// window with irregular spacing.
// ---------------------------------------------------------------------------

func TestTwapIntegerEdgeCaseRateOne(t *testing.T) {
	s := NewMemStore()
	creator := "heidi"

	blocks := []uint64{0, 1200, 2400, 3600, 4800, 6000, 7200, 8400}
	recordConst(s, creator, blocks, 1)

	rate, err := AskRate(s, creator, 9600)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rate.Sign() <= 0 {
		t.Fatalf("rate must never be zero or negative, got %s", rate)
	}
	if rate.Cmp(big.NewInt(1)) != 0 {
		t.Fatalf("expected exactly 1, got %s", rate)
	}
}

func TestTwapIntegerEdgeCaseVeryLargeRate(t *testing.T) {
	s := NewMemStore()
	creator := "ivan"
	huge := mustBigStr("123456789012345678901234567890")

	blocks := []uint64{0, 1200, 2400, 3600, 4800, 6000, 7200, 8400}
	for _, b := range blocks {
		RecordObs(s, creator, b, new(big.Int).Set(huge))
	}

	rate, err := AskRate(s, creator, 9600)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rate.Cmp(huge) != 0 {
		t.Fatalf("expected no overflow/truncation on a huge constant rate: want %s, got %s", huge, rate)
	}
}

func TestTwapIntegerEdgeCaseAllIdenticalIrregularSpacing(t *testing.T) {
	s := NewMemStore()
	creator := "judy"

	// Deliberately irregular gaps between observations. Because every rate
	// is identical, the weighted average must equal that rate exactly
	// regardless of how uneven the interval weights are — this is what
	// distinguishes "correct telescoping arithmetic" from "coincidentally
	// right under uniform spacing" (already covered elsewhere).
	// SET-1 FIX (2026-07-22): every gap is now >= ShortObsSpacing (40) so all
	// eight writes actually land in the rate-limited short ring; the spacing
	// stays deliberately irregular (45, 51, 450, 3950, ...), which is the
	// property this test exists to exercise.
	blocks := []uint64{0, 50, 4000, 4045, 9999, 10050, 10500, 20000}
	recordConst(s, creator, blocks, 777)

	rate, err := AskRate(s, creator, 25000)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rate.Cmp(big.NewInt(777)) != 0 {
		t.Fatalf("expected exactly 777 under irregular spacing, got %s", rate)
	}
}

// ---------------------------------------------------------------------------
// RecordObs defensively drops non-positive / nil rates rather than poisoning
// the buffer (it has no error return by contract, per API.md).
// ---------------------------------------------------------------------------

func TestTwapRecordObsIgnoresInvalidRate(t *testing.T) {
	s := NewMemStore()
	creator := "kevin"

	RecordObs(s, creator, 1, big.NewInt(0))
	RecordObs(s, creator, 2, big.NewInt(-5))
	RecordObs(s, creator, 3, nil)

	if n := getU64(s, kObsIdx(creator)); n != 0 {
		t.Fatalf("expected zero recorded observations after zero/negative/nil rates, got %d", n)
	}

	// A subsequent valid call proves the counter itself works and wasn't
	// just coincidentally zero.
	RecordObs(s, creator, 4, big.NewInt(1))
	if n := getU64(s, kObsIdx(creator)); n != 1 {
		t.Fatalf("expected exactly 1 recorded observation after a valid call, got %d", n)
	}
}

// ---------------------------------------------------------------------------
// Corrupt on-chain state must produce a typed error, never a panic.
// ---------------------------------------------------------------------------

func TestTwapCorruptStateReturnsErrorNotPanic(t *testing.T) {
	s := NewMemStore()
	creator := "laura"

	blocks := []uint64{0, 1000, 2000, 3000, 4000, 5000, 6000, 7000}
	recordConst(s, creator, blocks, 1000)

	// Bypass RecordObs and corrupt a live slot directly, simulating state
	// corruption (or a future schema mismatch) rather than a normal write.
	s.Set(kObs(creator, 3), "not-a-valid-observation-encoding")

	_, err := AskRate(s, creator, 8000)
	assertErrSymbol(t, err, ErrState)
}
