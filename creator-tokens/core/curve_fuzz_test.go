package core

import (
	"fmt"
	"math/big"
	"math/rand"
	"strings"
	"testing"
)

// curve_fuzz_test.go — the PROPERTY / FUZZ suite for the money core
// (curve.go, holdclock.go, exittax.go, tradefee.go, buy.go, sell.go).
// Binding specs: RULINGS-v2-2026-07-21 — RULING I (BasePrice + 25% quadratic,
// exact-area), RULING J (tax to TREASURY; the holder-distribution pot is
// DELETED), RULING J1 (realized-gain cap), MONEY-MATH CORE as amended.
//
// This file is DELIBERATELY independent of the per-file unit tests: it
// re-derives every bound from the spec rather than from the implementation,
// so a wrong implementation and a wrong test cannot agree with each other by
// copy-paste.
//
// WHAT IS ASSERTED, AND AT WHICH LAYER — this split is forced by RULING F5
// (the curve constants are compile-time consts with no setter, EVER), so the
// STATEFUL path can only ever be exercised at the compiled calibration:
//
//	layer 1 — pure primitives (curveAreaIn/curveBuyCostIn/curveSellProceedsIn):
//	          the L1-L5 EQUALITIES, the single-floor dust bound, and the
//	          GOVERNING THEOREM (flat pro-rata payout <= cost for a fresh
//	          buyer) over MANY (base, lin, quad, den) parameterisations,
//	          randomized AND small-exhaustive.
//	layer 2 — a MODEL of buy/sell reserve accounting built out of the REAL
//	          pure primitives + the REAL ExitTaxOn/ExitTaxBpsAt/tradeFeeOn:
//	          E CONSTANT under trading (the equality invariant relative to
//	          any seeded excess), the ledger identity, and solo round-trip
//	          non-profit for EVERY tax in [0, rate] (which brackets the J1
//	          assessed tax), across every calibration.
//	layer 3 — the REAL stateful path (Buy/Sell/TransferCredits against a
//	          MemStore) at the compiled calibration: the equality invariant,
//	          the exact ledger, I3, the RULING-J treasury ledger, the C-19
//	          fee/reserve separation, basis self-cleaning, and the
//	          round-trip / no-free-money economics, over thousands of
//	          randomized operation sequences from randomized starting
//	          states.
//
// DELETED WITH THEIR MECHANISMS (recorded so nobody hunts for them):
// the WA-identity assertions (kHoldWeightSum — RULING A4), the burn-era
// taxed-token assertions, and — RULING J — the ENTIRE tax-pot battery
// (the A5 pot-solvency sweep, the pot ledger, ClaimTax coverage, the
// anti-buy-in accumulator assertions, the A1/A2 exclusion cases): the
// holder distribution was measured regressive (effective rate ≈ τ·(1−share))
// and its patch family refuted, so the pot, its keys and its claim path no
// longer exist. Its treasury-side replacements are asserted below (the
// treasury ledger in cfCheck) and in sell_test.go's worked examples. The
// two RED findings this file carried (F-1 exit DoS, F-2 partial write —
// TestCurveFuzz_SellAfterTransferIn) are KEPT with their substantive
// assertions intact.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// cfSeeds — the fixed seed list. A failure prints the seed and the sequence
// index; re-running the same test reproduces it exactly.
var cfSeeds = []int64{1, 7, 42, 101, 555, 2026, 20260721, 99991, 31337, 8675309, 13, 4}

type cfCalib struct {
	name string
	base *big.Int
	lin  *big.Int
	quad *big.Int
	den  *big.Int
}

// cfCalibs — the curve-parameterisation grid (RULING I's family: price ~
// nonneg blends of i^0, i^1, i^2): the compiled blend, each pure component,
// the withdrawn pure-linear 21/2 (regression continuity), dust and coarse
// regimes, and a large-coprime tuple where the numerator mod den cycles a
// large residue class.
func cfCalibs() []cfCalib {
	return []cfCalib{
		{"compiled b=1000 63000/21/8000", big.NewInt(1000), big.NewInt(63000), big.NewInt(21), big.NewInt(8000)},
		{"base-only b=1000", big.NewInt(1000), big.NewInt(0), big.NewInt(0), big.NewInt(1)},
		{"linear-only 63000/8000", big.NewInt(0), big.NewInt(63000), big.NewInt(0), big.NewInt(8000)},
		{"quad-only 21/8000", big.NewInt(0), big.NewInt(0), big.NewInt(21), big.NewInt(8000)},
		{"old-linear 21/2 no base", big.NewInt(0), big.NewInt(21), big.NewInt(0), big.NewInt(2)},
		{"dust 1/1/1e9", big.NewInt(0), big.NewInt(1), big.NewInt(1), big.NewInt(1000000000)},
		{"large-coprime 12345/7919/104729/999983", big.NewInt(12345), big.NewInt(7919), big.NewInt(104729), big.NewInt(999983)},
	}
}

// cfRand returns a value in [0, hi], mixing magnitudes so both the dust
// region and the multi-word big.Int region are exercised in the same run.
func cfRand(r *rand.Rand, hi int64) *big.Int {
	if hi <= 0 {
		return mZero()
	}
	switch r.Intn(4) {
	case 0: // dust
		return big.NewInt(r.Int63n(min64(hi, 12) + 1))
	case 1: // small
		return big.NewInt(r.Int63n(min64(hi, 1000) + 1))
	case 2: // medium
		return big.NewInt(r.Int63n(min64(hi, 1_000_000) + 1))
	default: // full range
		return big.NewInt(r.Int63n(hi + 1))
	}
}

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

func cfBI(v int64) *big.Int { return big.NewInt(v) }

// cfExactNum — the exact rational area numerator over den (mirrors
// curve_test.go's cvExactNum; re-declared under the cf prefix per this
// file's ownership rule).
func cfExactNum(S *big.Int, cal cfCalib) *big.Int {
	num := new(big.Int).Mul(cal.base, cal.den)
	num.Mul(num, S)
	num.Add(num, new(big.Int).Mul(cal.lin, curveTri(S)))
	return num.Add(num, new(big.Int).Mul(cal.quad, curvePyr(S)))
}

// ---------------------------------------------------------------------------
// LAYER 1 — the pure curve primitives: L1-L5 as EQUALITIES + the governing
// theorem, across every calibration (mirrors curve_test.go's lemma suite but
// re-derived, wider magnitudes, small-exhaustive on top).
// ---------------------------------------------------------------------------

func cfAssertCurveBounds(t *testing.T, cal cfCalib, S, n, k *big.Int) {
	t.Helper()
	b, l, q, d := cal.base, cal.lin, cal.quad, cal.den
	Sn := mAdd(S, n)

	// ---- L1 EQUALITY: buyCost(S,n) == area(S+n) − area(S) ----
	bc := curveBuyCostIn(S, n, b, l, q, d)
	areaStep := new(big.Int).Sub(curveAreaIn(Sn, b, l, q, d), curveAreaIn(S, b, l, q, d))
	if bc.Cmp(areaStep) != 0 {
		t.Fatalf("L1 EQUALITY VIOLATED [%s]: buyCost(%s,%s)=%s != area step %s — the reserve would drift off the area lattice",
			cal.name, S, n, bc, areaStep)
	}

	// ---- L2 EQUALITY: sellProceeds(S,k) == area(S) − area(S−k) ----
	sp, err := curveSellProceedsIn(S, k, b, l, q, d)
	if err != nil {
		t.Fatalf("sellProceeds(%s,%s) [%s]: unexpected error %v", S, k, cal.name, err)
	}
	rem := new(big.Int).Sub(S, k)
	areaDrop := new(big.Int).Sub(curveAreaIn(S, b, l, q, d), curveAreaIn(rem, b, l, q, d))
	if sp.Cmp(areaDrop) != 0 {
		t.Fatalf("L2 EQUALITY VIOLATED [%s]: sellProceeds(%s,%s)=%s != area step %s",
			cal.name, S, k, sp, areaDrop)
	}

	// ---- L3 EQUALITY: chunked buy telescopes exactly ----
	n1 := new(big.Int).Rsh(n, 1)
	n2 := new(big.Int).Sub(n, n1)
	split := mAdd(curveBuyCostIn(S, n1, b, l, q, d), curveBuyCostIn(mAdd(S, n1), n2, b, l, q, d))
	if split.Cmp(bc) != 0 {
		t.Fatalf("L3 EQUALITY VIOLATED [%s]: split buy %s != whole %s", cal.name, split, bc)
	}

	// ---- L4 EQUALITY: chunked sell telescopes exactly ----
	k1 := new(big.Int).Rsh(k, 1)
	k2 := new(big.Int).Sub(k, k1)
	sp1, e1 := curveSellProceedsIn(S, k1, b, l, q, d)
	sp2, e2 := curveSellProceedsIn(new(big.Int).Sub(S, k1), k2, b, l, q, d)
	if e1 != nil || e2 != nil {
		t.Fatalf("split sell errored [%s]: %v / %v", cal.name, e1, e2)
	}
	if mAdd(sp1, sp2).Cmp(sp) != 0 {
		t.Fatalf("L4 EQUALITY VIOLATED [%s]: split sell %s != whole %s", cal.name, mAdd(sp1, sp2), sp)
	}

	// ---- L5 EQUALITY: sellProceeds(S+n,n) == buyCost(S,n) ----
	spn, err := curveSellProceedsIn(Sn, n, b, l, q, d)
	if err != nil {
		t.Fatalf("sellProceeds(%s,%s) [%s]: unexpected error %v", Sn, n, cal.name, err)
	}
	if spn.Cmp(bc) != 0 {
		t.Fatalf("L5 EQUALITY VIOLATED [%s]: round trip not zero-sum — sell %s != buy %s", cal.name, spn, bc)
	}

	// ---- dust bound: |bc·den − Δnum| < den; area floor in [0, den) ----
	exactStep := new(big.Int).Sub(cfExactNum(Sn, cal), cfExactNum(S, cal))
	buyErr := new(big.Int).Sub(new(big.Int).Mul(bc, d), exactStep)
	if a := new(big.Int).Abs(buyErr); a.Cmp(d) >= 0 {
		t.Fatalf("DUST OUT OF RANGE [%s] on buyCost(%s,%s): |bc·den − Δnum| = %s >= den=%s",
			cal.name, S, n, a, d)
	}
	areaErr := new(big.Int).Sub(cfExactNum(S, cal), new(big.Int).Mul(curveAreaIn(S, b, l, q, d), d))
	if areaErr.Sign() < 0 || areaErr.Cmp(d) >= 0 {
		t.Fatalf("AREA FLOOR VIOLATED [%s] on area(%s): num − area·den = %s, want in [0,%s)", cal.name, S, areaErr, d)
	}

	// ---- THE GOVERNING THEOREM (RULINGS v2/I): a fresh buyer of n at S,
	// with R = area(S+n) exactly at the freeze, redeems at most
	// floor(area(S+n)·n/(S+n)) pro-rata — never more than their cost. ----
	if n.Sign() > 0 {
		payout := mMulDiv(curveAreaIn(Sn, b, l, q, d), n, Sn)
		if payout.Cmp(bc) > 0 {
			t.Fatalf("GOVERNING THEOREM VIOLATED [%s]: S=%s n=%s cost=%s < flat pro-rata payout=%s",
				cal.name, S, n, bc, payout)
		}
	}
}

// Wide randomized sweep. Supplies run up to 1e9 (MaxCap) so P(S) ~ 3e26 and
// quad·P(S) exercise the multi-word big.Int paths a uint64 would wrap.
func TestCurveFuzz_L1toL5_RandomizedAcrossCalibrations(t *testing.T) {
	for _, cal := range cfCalibs() {
		for _, seed := range cfSeeds {
			r := rand.New(rand.NewSource(seed))
			for i := 0; i < 400; i++ {
				S := cfRand(r, MaxCap)
				n := cfRand(r, MaxCap)
				k := mZero()
				if S.Sign() > 0 {
					k = new(big.Int).Mod(cfRand(r, MaxCap), mAdd(S, cfBI(1)))
				}
				cfAssertCurveBounds(t, cal, S, n, k)
			}
		}
	}
}

// The dust region, EXHAUSTIVELY — random sampling of a 1e9-wide space almost
// never lands on S=0..3, and that is exactly where integer division
// misbehaves.
func TestCurveFuzz_L1toL5_SmallExhaustive(t *testing.T) {
	for _, cal := range cfCalibs() {
		for S := int64(0); S <= 24; S++ {
			for n := int64(0); n <= 8; n++ {
				for k := int64(0); k <= S; k++ {
					cfAssertCurveBounds(t, cal, cfBI(S), cfBI(n), cfBI(k))
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// LAYER 2 — the calibration model: E CONSTANT under trading, the ledger
// identity, and solo round-trip non-profit, over EVERY calibration.
// Re-implements only the reserve/supply bookkeeping and calls the REAL
// primitives for every number that matters. The tax drawn per sell is a
// RANDOM value in [0, ExitTaxOn(p, τ)] including both endpoints — the J1
// assessed tax always lies in that interval (the cap only ever shrinks the
// rate tax), so the non-profit property proven for the whole interval covers
// the shipped tax exactly. If this fails for a calibration, that calibration
// must never ship.
// ---------------------------------------------------------------------------

type cfModel struct {
	S, R     *big.Int
	cal      cfCalib
	sumCost  *big.Int
	sumGross *big.Int
	spent    *big.Int // Σ (cost + fee) paid in — a single solo actor
	received *big.Int // Σ net taken out (p − tax − fee)
}

func cfNewModel(cal cfCalib) *cfModel {
	return &cfModel{
		S: mZero(), R: mZero(), cal: cal,
		sumCost: mZero(), sumGross: mZero(), spent: mZero(), received: mZero(),
	}
}

func (m *cfModel) excess() *big.Int {
	return new(big.Int).Sub(m.R, curveAreaIn(m.S, m.cal.base, m.cal.lin, m.cal.quad, m.cal.den))
}

func (m *cfModel) buy(n *big.Int) {
	cost := curveBuyCostIn(m.S, n, m.cal.base, m.cal.lin, m.cal.quad, m.cal.den)
	fee := mMulBpsDiv(cost, TradeFeeBps)
	m.S = mAdd(m.S, n)
	m.R = mAdd(m.R, cost) // curve leg ONLY (C-19)
	m.sumCost = mAdd(m.sumCost, cost)
	m.spent = mAdd(m.spent, mAdd(cost, fee))
}

// sell — RULING J shape: the FULL slice redeems; tax is MONEY out of the
// payout (the model does not track a destination — the tax simply does not
// return to the actor, which is all the non-profit property needs; the REAL
// destination, the treasury, is asserted at layer 3).
func (m *cfModel) sell(t *testing.T, r *rand.Rand, deltaS *big.Int, taxBps uint64) {
	p, err := curveSellProceedsIn(m.S, deltaS, m.cal.base, m.cal.lin, m.cal.quad, m.cal.den)
	if err != nil {
		t.Fatalf("model sell: %v", err)
	}
	// tax ∈ [0, rate] — brackets every J1 outcome (assessed = min(rate, gain⁺)).
	rate := ExitTaxOn(p, taxBps)
	var tax *big.Int
	switch r.Intn(3) {
	case 0:
		tax = mZero()
	case 1:
		tax = new(big.Int).Set(rate)
	default:
		tax = new(big.Int).Rand(r, mAdd(rate, cfBI(1)))
	}
	fee, feeC, feeP := tradeFeeOn(p)
	if mAdd(feeC, feeP).Cmp(fee) != 0 {
		t.Fatalf("fee split violated: feeCreator+feePlatform = %s != fee %s", mAdd(feeC, feeP), fee)
	}
	net := new(big.Int).Sub(p, tax)
	net.Sub(net, fee)
	if net.Sign() < 0 {
		t.Fatalf("model sell: negative net (p=%s tax=%s fee=%s τ=%d)", p, tax, fee, taxBps)
	}
	m.S = new(big.Int).Sub(m.S, deltaS)
	m.R = new(big.Int).Sub(m.R, p) // curve leg ONLY (C-19)
	m.sumGross = mAdd(m.sumGross, p)
	m.received = mAdd(m.received, net)
}

func TestCurveFuzz_Model_EqualityLedger_AcrossCalibrations(t *testing.T) {
	for _, cal := range cfCalibs() {
		for _, seed := range cfSeeds {
			r := rand.New(rand.NewSource(seed))
			m := cfNewModel(cal)
			for step := 0; step < 300; step++ {
				before := fmt.Sprintf("S=%s R=%s", m.S, m.R)
				switch {
				case r.Intn(2) == 0 || m.S.Sign() == 0:
					n := new(big.Int).Add(cfRand(r, 100000), cfBI(1))
					if mAdd(m.S, n).Cmp(cfBI(MaxCap)) > 0 {
						continue
					}
					m.buy(n)
				default:
					dS := new(big.Int).Add(new(big.Int).Mod(cfRand(r, 100000), m.S), cfBI(1))
					if dS.Cmp(m.S) > 0 {
						dS = new(big.Int).Set(m.S)
					}
					held := uint64(r.Int63n(int64(ExitTaxDecayBlocks) * 2))
					m.sell(t, r, dS, ExitTaxBpsAt(held))
				}

				// THE EQUALITY INVARIANT: from an E=0 genesis, E stays EXACTLY
				// 0 after every op — R tracks the area function with zero
				// drift, at every calibration.
				if e := m.excess(); e.Sign() != 0 {
					t.Fatalf("EQUALITY VIOLATED [%s seed=%d step=%d]: after %s -> S=%s R=%s, E=%s (want exactly 0)",
						cal.name, seed, step, before, m.S, m.R, e)
				}
				// Ledger identity: R == Σ cost − Σ gross, exactly.
				want := new(big.Int).Sub(m.sumCost, m.sumGross)
				if m.R.Cmp(want) != 0 {
					t.Fatalf("LEDGER VIOLATED [%s seed=%d step=%d]: R=%s != Σcost−Σgross=%s", cal.name, seed, step, m.R, want)
				}
				// Solo round-trip: one actor trading alone can never take out
				// more HBD than they put in, at ANY point of ANY sequence,
				// for ANY tax in [0, rate].
				if m.received.Cmp(m.spent) > 0 {
					t.Fatalf("SOLO ROUND-TRIP PROFIT [%s seed=%d step=%d]: received %s > spent %s",
						cal.name, seed, step, m.received, m.spent)
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// LAYER 3 — the real stateful path.
// ---------------------------------------------------------------------------

// cfWorld is one market under test, plus the shadow ledger every assertion is
// checked against. Nothing here reads the implementation's own aggregates to
// decide what they should be: sums come from the RESULT structs, balances are
// recomputed by scanning the store.
type cfWorld struct {
	s       *MemStore
	creator string
	actors  []string
	block   uint64

	seed   int64
	seqIdx int

	r0       *big.Int // reserve at sequence start (seeded state)
	e0       *big.Int // excess at sequence start — must stay CONSTANT
	sumCost  *big.Int // Σ BuyResult.Cost
	sumGross *big.Int // Σ SellResult.Gross
	feeC0    *big.Int // kFeeBal(creator) at start
	trea0    *big.Int // kTreasury() at start
	sumFeeC  *big.Int
	sumFeeP  *big.Int
	sumTax   *big.Int // Σ assessed tax — split 50/50 creator/platform (2026-07-27)
	sumTaxC  *big.Int // Σ the creator's half (0 for a creator selling their own token)
	sumTaxP  *big.Int // Σ the platform's half (the WHOLE tax on a creator's own sell)

	spent    map[string]*big.Int // per-actor Σ TotalDue
	received map[string]*big.Int // per-actor Σ Net

	trace []string

	cov cfCoverage
}

// cfCoverage is the ANTI-VACUITY gate: every randomized test asserts a
// MINIMUM count of each state it claims to cover, so a generator that stops
// reaching the interesting states fails loudly instead of going green.
type cfCoverage struct {
	buys        int
	sells       int
	zeroTaxSell int // fully-decayed hold: the tax is NOT what keeps the curve safe
	maxTaxSell  int // freshest hold: the full 20% rate
	taxedSells  int // sells that actually paid tax (to the treasury — J/K)
	rejected    int
	transfers   int
	ratchetHigh int // sequences started with seeded excess (legacy-E robustness)
}

func (c *cfCoverage) add(o cfCoverage) {
	c.buys += o.buys
	c.sells += o.sells
	c.zeroTaxSell += o.zeroTaxSell
	c.maxTaxSell += o.maxTaxSell
	c.taxedSells += o.taxedSells
	c.rejected += o.rejected
	c.transfers += o.transfers
	c.ratchetHigh += o.ratchetHigh
}

func cfRequireCoverage(t *testing.T, label string, got cfCoverage, want cfCoverage) {
	t.Helper()
	check := func(name string, g, w int) {
		if g < w {
			t.Errorf("VACUOUS FUZZ [%s]: only %d %s in the whole run, want >= %d — the generator stopped reaching this state",
				label, g, name, w)
		}
	}
	check("buys", got.buys, want.buys)
	check("sells", got.sells, want.sells)
	check("zero-tax sells", got.zeroTaxSell, want.zeroTaxSell)
	check("max-tax sells", got.maxTaxSell, want.maxTaxSell)
	check("taxed sells", got.taxedSells, want.taxedSells)
	check("transfers", got.transfers, want.transfers)
	t.Logf("coverage [%s]: buys=%d sells=%d zeroTax=%d maxTax=%d taxed=%d rejected=%d transfers=%d seededE=%d",
		label, got.buys, got.sells, got.zeroTaxSell, got.maxTaxSell, got.taxedSells, got.rejected, got.transfers, got.ratchetHigh)
}

func (w *cfWorld) logf(format string, args ...interface{}) {
	w.trace = append(w.trace, fmt.Sprintf(format, args...))
}

func (w *cfWorld) fail(t *testing.T, format string, args ...interface{}) {
	t.Helper()
	t.Errorf("seed=%d seq=%d creator=%s — REPRODUCING SEQUENCE:\n%s",
		w.seed, w.seqIdx, w.creator, strings.Join(w.trace, "\n"))
	t.Fatalf(format, args...)
}

// cfSeedMarket writes a randomized STARTING STATE directly: an ACTIVE market
// with `holders` already holding clocked balances and a reserve of
// area(S) + excess. The nonzero-excess seeds are LEGACY-STATE ROBUSTNESS:
// no reachable path creates E > 0 any more (the equality invariant), but the
// harness proves that even against such a state the curve neither leaks the
// excess out (E stays constant) nor lets anyone extract it. Seeded balances
// carry NO basis (kBasis unset ⇒ 0) — the zero-value convention: they are
// maximally taxed, which also guarantees the rate-bound J1 regime appears.
func cfSeedMarket(s *MemStore, creator string, block uint64, holders []string, bals []*big.Int, wacqs []uint64, excess *big.Int) {
	supply := mZero()
	for i, h := range holders {
		setMoney(s, kBal(creator, h), bals[i])
		setU64(s, kAcqBlock(creator, h), wacqs[i])
		supply = mAdd(supply, bals[i])
	}
	setMoney(s, kSupply(creator), supply)
	setMoney(s, kReserve(creator), mAdd(Area(supply), excess))
	setMoney(s, kCap(creator), cfBI(MaxCap))
	setU64(s, kRegisteredAt(creator), 1)
	setU64(s, kPaidUntil(creator), block+100*SubscriptionPeriod)
}

func cfNewWorld(t *testing.T, seed int64, seqIdx int, s *MemStore, creator string, actors []string, block uint64) *cfWorld {
	t.Helper()
	w := &cfWorld{
		s: s, creator: creator, actors: actors, block: block,
		seed: seed, seqIdx: seqIdx,
		r0:       getMoney(s, kReserve(creator)),
		sumCost:  mZero(),
		sumGross: mZero(),
		feeC0:    getMoney(s, kFeeBal(creator)),
		trea0:    getMoney(s, kTreasury()),
		sumFeeC:  mZero(),
		sumFeeP:  mZero(),
		sumTax:   mZero(),
		sumTaxC:  mZero(),
		sumTaxP:  mZero(),
		spent:    map[string]*big.Int{},
		received: map[string]*big.Int{},
	}
	for _, a := range actors {
		w.spent[a] = mZero()
		w.received[a] = mZero()
	}
	w.e0 = new(big.Int).Sub(w.r0, Area(getMoney(s, kSupply(creator))))
	w.logf("SEED  block=%d S=%s R=%s E=%s", block, getMoney(s, kSupply(creator)), w.r0, w.e0)
	return w
}

// cfCheck runs the full invariant battery after EVERY operation (successful
// or rejected).
func cfCheck(t *testing.T, w *cfWorld, label string) {
	t.Helper()
	S := getMoney(w.s, kSupply(w.creator))
	R := getMoney(w.s, kReserve(w.creator))

	// ---- THE EQUALITY INVARIANT: E is CONSTANT — exactly the seeded value,
	// exactly 0 for virgin markets. Not merely >=: any drift in either
	// direction is a leak (down: reserve under the curve; up: an ownerless
	// pot forming — the forbidden class).
	e := new(big.Int).Sub(R, Area(S))
	if e.Cmp(w.e0) != 0 {
		w.fail(t, "EQUALITY VIOLATED after %s: E = %s, want the seeded %s exactly (R=%s, area(%s)=%s)",
			label, e, w.e0, R, S, Area(S))
	}

	// ---- exact reserve ledger ----
	wantR := new(big.Int).Sub(mAdd(w.r0, w.sumCost), w.sumGross)
	if R.Cmp(wantR) != 0 {
		w.fail(t, "LEDGER VIOLATED after %s: reserve %s != R0(%s) + Σcost(%s) − Σgross(%s) = %s",
			label, R, w.r0, w.sumCost, w.sumGross, wantR)
	}

	// ---- I3: supply == Σ balances (no escrow in these sequences) ----
	sumBal := sumBalances(w.s, w.creator)
	if S.Cmp(sumBal) != 0 {
		w.fail(t, "I3 VIOLATED after %s: supply %s != Σ balances %s", label, S, sumBal)
	}

	// ---- C-19 + the tax destination: the fee never touches the reserve, the
	// creator's pot holds its start + every creator fee half + its half of
	// every assessed tax, and the treasury holds its start + every platform
	// fee half + the platform's half. ----
	gotFeeC := getMoney(w.s, kFeeBal(w.creator))
	wantFeeC := mAdd(mAdd(w.feeC0, w.sumFeeC), w.sumTaxC)
	if gotFeeC.Cmp(wantFeeC) != 0 {
		w.fail(t, "fee accrual broken after %s: kFeeBal(creator) %s != feeC0+ΣfeeC+ΣtaxC %s", label, gotFeeC, wantFeeC)
	}
	gotTrea := getMoney(w.s, kTreasury())
	wantTrea := mAdd(mAdd(w.trea0, w.sumFeeP), w.sumTaxP)
	if gotTrea.Cmp(wantTrea) != 0 {
		w.fail(t, "TREASURY LEDGER VIOLATED after %s: kTreasury() %s != trea0+ΣfeeP+ΣtaxP %s", label, gotTrea, wantTrea)
	}

	// ---- NOTHING LEAKS: the two halves must re-sum to every unit assessed.
	// This is the property the pre-split "all to treasury" assertion was
	// really protecting, restated so a rounding bug in the split cannot hide
	// behind two individually-plausible balances. ----
	if reunited := mAdd(w.sumTaxC, w.sumTaxP); reunited.Cmp(w.sumTax) != 0 {
		w.fail(t, "TAX SPLIT LEAKED after %s: ΣtaxC+ΣtaxP = %s != Σtax %s", label, reunited, w.sumTax)
	}

	// (RULING K deleted the per-holder cost basis — no basis-hygiene invariant
	// to check any more; the exit tax is gross proceeds × τ(h) with no cap.)

	// ---- no free money: nobody can take out more than came in ----
	totalIn := new(big.Int).Set(w.r0)
	totalOut := mZero()
	for _, a := range w.actors {
		totalIn = mAdd(totalIn, w.spent[a])
		totalOut = mAdd(totalOut, w.received[a])
	}
	if totalOut.Cmp(totalIn) > 0 {
		w.fail(t, "NO-FREE-MONEY VIOLATED after %s: Σ received %s > R0 + Σ spent %s", label, totalOut, totalIn)
	}
}

// cfDoBuy executes one Buy and folds the result into the shadow ledger. A
// rejected buy must mutate NOTHING.
func cfDoBuy(t *testing.T, w *cfWorld, actor string, n *big.Int) {
	t.Helper()
	beforeS := getMoney(w.s, kSupply(w.creator))
	beforeR := getMoney(w.s, kReserve(w.creator))
	r, err := Buy(w.s, actor, w.creator, w.block, n)
	if err != nil {
		w.logf("BUY   %-8s n=%-8s block=%d -> rejected (%s)", actor, n, w.block, errSymbol(err))
		if getMoney(w.s, kSupply(w.creator)).Cmp(beforeS) != 0 || getMoney(w.s, kReserve(w.creator)).Cmp(beforeR) != 0 {
			w.fail(t, "rejected Buy mutated state: S %s->%s R %s->%s", beforeS, getMoney(w.s, kSupply(w.creator)), beforeR, getMoney(w.s, kReserve(w.creator)))
		}
		w.cov.rejected++
		cfCheck(t, w, "rejected buy")
		return
	}
	gotDelta := new(big.Int).Sub(getMoney(w.s, kReserve(w.creator)), beforeR)
	if gotDelta.Cmp(r.Cost) != 0 {
		w.fail(t, "C-19 VIOLATED on buy: Δreserve = %s, want exactly Cost = %s (fee %s must never enter the reserve)", gotDelta, r.Cost, r.Fee)
	}
	if mAdd(r.FeeCreator, r.FeePlatform).Cmp(r.Fee) != 0 {
		w.fail(t, "fee split VIOLATED on buy: feeC %s + feeP %s != fee %s", r.FeeCreator, r.FeePlatform, r.Fee)
	}
	if mAdd(r.Cost, r.Fee).Cmp(r.TotalDue) != 0 {
		w.fail(t, "buy TotalDue %s != Cost %s + Fee %s", r.TotalDue, r.Cost, r.Fee)
	}
	w.sumCost = mAdd(w.sumCost, r.Cost)
	w.sumFeeC = mAdd(w.sumFeeC, r.FeeCreator)
	w.sumFeeP = mAdd(w.sumFeeP, r.FeePlatform)
	w.spent[actor] = mAdd(w.spent[actor], r.TotalDue)
	w.cov.buys++
	w.logf("BUY   %-8s n=%-8s block=%d -> cost=%s fee=%s due=%s", actor, n, w.block, r.Cost, r.Fee, r.TotalDue)
	cfCheck(t, w, "buy")
}

func cfDoSell(t *testing.T, w *cfWorld, actor string, deltaS *big.Int) {
	t.Helper()
	beforeS := getMoney(w.s, kSupply(w.creator))
	beforeR := getMoney(w.s, kReserve(w.creator))
	r, err := Sell(w.s, actor, w.creator, w.block, deltaS)
	if err != nil {
		w.logf("SELL  %-8s dS=%-7s block=%d -> rejected (%s)", actor, deltaS, w.block, errSymbol(err))
		if getMoney(w.s, kSupply(w.creator)).Cmp(beforeS) != 0 || getMoney(w.s, kReserve(w.creator)).Cmp(beforeR) != 0 {
			w.fail(t, "rejected Sell mutated state: S %s->%s R %s->%s", beforeS, getMoney(w.s, kSupply(w.creator)), beforeR, getMoney(w.s, kReserve(w.creator)))
		}
		w.cov.rejected++
		cfCheck(t, w, "rejected sell")
		return
	}
	// The split equality: p == net + tax + feeC + feeP, zero dust anywhere.
	sum := mAdd(mAdd(r.Net, r.Tax), mAdd(r.FeeCreator, r.FeePlatform))
	if sum.Cmp(r.Gross) != 0 {
		w.fail(t, "SPLIT VIOLATED: net %s + tax %s + feeC %s + feeP %s != gross %s", r.Net, r.Tax, r.FeeCreator, r.FeePlatform, r.Gross)
	}
	// RULING K1 (2026-07-22): the exit tax is GROSS proceeds × τ(h), ceil, with
	// NO cap and NO per-position state, so it is EXACTLY ExitTaxOn(Gross, τ)
	// on every single sale — no episode, no basis, no gain term. This is the
	// property that makes it un-splittable: proceeds are path-independent
	// (curve.go L4) and ceil is superadditive, so any split pays >= a single
	// sale (proven in TestSell_ChunkingCannotEvade). Assert the exact identity
	// here, every sale.
	// TWO BUCKETS (2026-07-30): the base is the MATURING share of the gross, not
	// the whole gross — a matured token's rate is exactly 0, so taxing it would
	// charge for time already served. The identity stays EXACT, on every sale;
	// only the base narrowed. TaxableGross == Gross whenever nothing has
	// graduated, which is every pre-existing scenario.
	rate := ExitTaxOn(r.TaxableGross, r.TaxBps)
	if r.Tax.Cmp(rate) != 0 {
		w.fail(t, "K1 TAX MISMATCH: tax %s != ExitTaxOn(taxableGross %s of gross %s, %d bps) %s — the tax has no cap", r.Tax, r.TaxableGross, r.Gross, r.TaxBps, rate)
	}
	// C-19 sell side: ΔR == −Gross EXACTLY.
	gotDelta := new(big.Int).Sub(beforeR, getMoney(w.s, kReserve(w.creator)))
	if gotDelta.Cmp(r.Gross) != 0 {
		w.fail(t, "C-19 VIOLATED on sell: −Δreserve = %s, want exactly Gross = %s", gotDelta, r.Gross)
	}
	// The supply debit is the FULL ΔS — the whole slice redeems (no burn).
	if new(big.Int).Sub(beforeS, getMoney(w.s, kSupply(w.creator))).Cmp(r.Sold) != 0 {
		w.fail(t, "supply debit != ΔS on sell")
	}
	w.cov.sells++
	if r.TaxBps == 0 {
		w.cov.zeroTaxSell++
	}
	if r.TaxBps == MaxExitTaxBps {
		w.cov.maxTaxSell++
	}
	if r.Tax.Sign() > 0 {
		w.cov.taxedSells++
	}
	w.sumGross = mAdd(w.sumGross, r.Gross)
	w.sumFeeC = mAdd(w.sumFeeC, r.FeeCreator)
	w.sumFeeP = mAdd(w.sumFeeP, r.FeePlatform)
	w.sumTax = mAdd(w.sumTax, r.Tax)
	taxC, taxP := exitTaxSplit(w.creator, actor, r.Tax)
	w.sumTaxC = mAdd(w.sumTaxC, taxC)
	w.sumTaxP = mAdd(w.sumTaxP, taxP)
	w.received[actor] = mAdd(w.received[actor], r.Net)
	w.logf("SELL  %-8s dS=%-7s block=%d -> held=%d τ=%dbps p=%s tax=%s net=%s",
		actor, deltaS, w.block, r.HeldBlocks, r.TaxBps, r.Gross, r.Tax, r.Net)
	cfCheck(t, w, "sell")
}

func cfDoTransfer(t *testing.T, w *cfWorld, from, to string, amount *big.Int) {
	t.Helper()
	// RULING K deleted the per-holder cost basis, so a transfer conserves only
	// the balance and re-ages the recipient's clock (checked structurally in
	// transfer_test.go); there is no basis quantity to conserve here.
	err := TransferCredits(w.s, from, w.creator, from, to, w.block, amount)
	if err != nil {
		w.logf("XFER  %-8s -> %-8s amt=%-7s -> rejected (%s)", from, to, amount, errSymbol(err))
	} else {
		w.cov.transfers++
		w.logf("XFER  %-8s -> %-8s amt=%-7s", from, to, amount)
	}
	cfCheck(t, w, "transfer")
}

// cfRandActorWithBalance picks an actor holding at least 1 token, or "".
func cfRandActorWithBalance(r *rand.Rand, w *cfWorld) string {
	order := r.Perm(len(w.actors))
	for _, i := range order {
		if getMoney(w.s, kBal(w.creator, w.actors[i])).Sign() > 0 {
			return w.actors[i]
		}
	}
	return ""
}

// cfRandStart builds a randomized starting state: sometimes a virgin market
// (S=0, R=0, E=0 — the genesis of the equality induction), sometimes a
// seeded one, sometimes with a large seeded excess — the legacy-E robustness
// case (see cfSeedMarket).
func cfRandStart(r *rand.Rand, actors []string) (*MemStore, string, uint64, bool) {
	s := NewMemStore()
	creator := "creatora"
	block := uint64(2_000_000 + r.Int63n(1_000_000))
	kind := r.Intn(3)
	switch kind {
	case 0: // virgin market — S=0, R=0, area(0)=0
		setMoney(s, kSupply(creator), mZero())
		setMoney(s, kReserve(creator), mZero())
		setMoney(s, kCap(creator), cfBI(MaxCap))
		setU64(s, kRegisteredAt(creator), 1)
		setU64(s, kPaidUntil(creator), block+100*SubscriptionPeriod)
	case 1: // seeded, mild excess
		bals := make([]*big.Int, len(actors))
		wacqs := make([]uint64, len(actors))
		for i := range actors {
			bals[i] = new(big.Int).Add(cfRand(r, 50_000), cfBI(1))
			age := uint64(r.Int63n(int64(ExitTaxDecayBlocks) * 2))
			if age >= block {
				age = block - 1
			}
			wacqs[i] = block - age
		}
		cfSeedMarket(s, creator, block, actors, bals, wacqs, cfRand(r, 1_000_000))
	default: // extreme seeded excess — tiny supply, enormous E
		bals := make([]*big.Int, len(actors))
		wacqs := make([]uint64, len(actors))
		for i := range actors {
			bals[i] = cfBI(r.Int63n(4) + 1)
			wacqs[i] = block - uint64(r.Int63n(1000)+1)
		}
		cfSeedMarket(s, creator, block, actors, bals, wacqs, cfBI(1_000_000_000))
	}
	return s, creator, block, kind == 2
}

// cfRunSequence drives one randomized operation sequence.
func cfRunSequence(t *testing.T, r *rand.Rand, seed int64, seqIdx int, steps int, withTransfers bool) *cfWorld {
	t.Helper()
	actors := []string{"alice", "bob", "carol"}
	s, creator, block, extremeE := cfRandStart(r, actors)
	w := cfNewWorld(t, seed, seqIdx, s, creator, actors, block)
	if extremeE {
		w.cov.ratchetHigh++
	}
	cfCheck(t, w, "start")

	for step := 0; step < steps; step++ {
		roll := r.Intn(13)
		switch {
		case roll >= 11:
			// A deliberately INVALID op — keeps "a rejected call mutates
			// nothing" genuinely exercised.
			switch r.Intn(3) {
			case 0: // one token past the cap
				headroom := new(big.Int).Sub(cfBI(MaxCap), getMoney(w.s, kSupply(w.creator)))
				cfDoBuy(t, w, w.actors[r.Intn(len(w.actors))], mAdd(headroom, cfBI(1)))
			case 1: // zero tokens
				cfDoBuy(t, w, w.actors[r.Intn(len(w.actors))], mZero())
			default: // one token more than the holder owns
				actor := w.actors[r.Intn(len(w.actors))]
				bal := getMoney(w.s, kBal(w.creator, actor))
				cfDoSell(t, w, actor, mAdd(bal, cfBI(1)))
			}
		case roll < 4: // buy
			actor := w.actors[r.Intn(len(w.actors))]
			headroom := new(big.Int).Sub(cfBI(MaxCap), getMoney(w.s, kSupply(w.creator)))
			if headroom.Sign() <= 0 {
				continue
			}
			n := new(big.Int).Add(cfRand(r, 20_000), cfBI(1))
			if n.Cmp(headroom) > 0 {
				n = headroom
			}
			cfDoBuy(t, w, actor, n)
		case roll < 9: // sell
			actor := cfRandActorWithBalance(r, w)
			if actor == "" {
				continue
			}
			bal := getMoney(w.s, kBal(w.creator, actor))
			var dS *big.Int
			switch r.Intn(3) {
			case 0:
				dS = cfBI(1)
			case 1:
				dS = new(big.Int).Set(bal)
			default:
				dS = new(big.Int).Add(new(big.Int).Mod(cfRand(r, 20_000), bal), cfBI(1))
			}
			cfDoSell(t, w, actor, dS)
		case roll < 10 && withTransfers: // transfer
			from := cfRandActorWithBalance(r, w)
			if from == "" {
				continue
			}
			to := w.actors[r.Intn(len(w.actors))]
			if to == from {
				continue
			}
			bal := getMoney(w.s, kBal(w.creator, from))
			amt := new(big.Int).Add(new(big.Int).Mod(cfRand(r, 20_000), bal), cfBI(1))
			cfDoTransfer(t, w, from, to, amt)
		default: // advance the block — ages every position, decaying the tax
			adv := uint64(r.Int63n(int64(ExitTaxDecayBlocks)/4 + 1))
			w.block += adv
			w.logf("BLOCK +%d -> %d", adv, w.block)
			cfCheck(t, w, "advance")
		}
	}
	return w
}

// TestCurveFuzz_OpSequence_BuySell — thousands of randomized buy/sell
// sequences from randomized starting states. Asserts, after EVERY step: the
// equality invariant (E constant), the exact reserve ledger, I3, the
// RULING-J treasury ledger, the J1 min(rate, gain) re-derivation, the split
// and fee/reserve equalities, basis hygiene, and no-free-money.
func TestCurveFuzz_OpSequence_BuySell(t *testing.T) {
	var cov cfCoverage
	for _, seed := range cfSeeds {
		r := rand.New(rand.NewSource(seed))
		for seq := 0; seq < 30; seq++ {
			cov.add(cfRunSequence(t, r, seed, seq, 60, false).cov)
		}
	}
	cfRequireCoverage(t, "buy/sell sequences", cov, cfCoverage{
		buys: 2000, sells: 2000, zeroTaxSell: 100, maxTaxSell: 100,
		taxedSells: 300,
	})
	if cov.rejected < 500 {
		t.Errorf("VACUOUS FUZZ: only %d rejected ops — the 'a rejected call mutates nothing' assertion is barely exercised", cov.rejected)
	}
	if cov.ratchetHigh < 20 {
		t.Errorf("VACUOUS FUZZ: only %d sequences started with extreme seeded excess, want >= 20", cov.ratchetHigh)
	}
}

// TestCurveFuzz_OpSequence_SoloActorNeverProfits — an actor trading ALONE
// against a VIRGIN market can never take out more HBD than they put in, at
// any point, any hold age, any chunking. (Under RULING J there is nothing to
// claim back — the tax is the treasury's the instant it is paid.)
func TestCurveFuzz_OpSequence_SoloActorNeverProfits(t *testing.T) {
	var cov cfCoverage
	for _, seed := range cfSeeds {
		r := rand.New(rand.NewSource(seed + 777))
		for seq := 0; seq < 30; seq++ {
			s := NewMemStore()
			creator := "creatora"
			block := uint64(2_000_000)
			setMoney(s, kCap(creator), cfBI(MaxCap))
			setU64(s, kRegisteredAt(creator), 1)
			setU64(s, kPaidUntil(creator), block+100*SubscriptionPeriod)
			actors := []string{"solo"}
			w := cfNewWorld(t, seed, seq, s, creator, actors, block)

			for step := 0; step < 60; step++ {
				bal := getMoney(w.s, kBal(creator, "solo"))
				switch {
				case r.Intn(2) == 0 || bal.Sign() == 0:
					n := new(big.Int).Add(cfRand(r, 50_000), cfBI(1))
					cfDoBuy(t, w, "solo", n)
				default:
					var dS *big.Int
					switch r.Intn(3) {
					case 0:
						dS = cfBI(1)
					case 1:
						dS = new(big.Int).Set(bal)
					default:
						dS = new(big.Int).Add(new(big.Int).Mod(cfRand(r, 50_000), bal), cfBI(1))
					}
					cfDoSell(t, w, "solo", dS)
				}
				if r.Intn(3) == 0 {
					w.block += uint64(r.Int63n(int64(ExitTaxDecayBlocks)/2 + 1))
					w.logf("BLOCK -> %d", w.block)
				}
				// THE assertion: cumulative out <= cumulative in, always.
				if w.received["solo"].Cmp(w.spent["solo"]) > 0 {
					w.fail(t, "SOLO ROUND-TRIP PROFIT at step %d: received %s > spent %s", step, w.received["solo"], w.spent["solo"])
				}
			}
			cov.add(w.cov)
		}
	}
	cfRequireCoverage(t, "solo sequences", cov, cfCoverage{
		buys: 2000, sells: 2000, zeroTaxSell: 100, maxTaxSell: 100,
	})
}

// TestCurveFuzz_OpSequence_WithTransfers — the same battery with
// TransferCredits in the action set (plus per-transfer basis conservation).
// This is one of the two suites that were RED before the RULING-A rewrite:
// the WA aggregate drifted on every transfer, a rejected Sell could destroy
// the seller's balance (I3 broken), and an ordinary transfer could lock a
// holder out of selling. All three mechanisms are structurally gone (WA
// deleted — A4; guard-then-debit ordering — G; recipient leg clocked —
// transfer.go), and the battery's substantive assertions (I3 after every op,
// rejected calls mutate nothing, the exit always works) are unchanged and
// now hold.
func TestCurveFuzz_OpSequence_WithTransfers(t *testing.T) {
	var cov cfCoverage
	for _, seed := range cfSeeds {
		r := rand.New(rand.NewSource(seed + 31))
		for seq := 0; seq < 30; seq++ {
			w := cfRunSequence(t, r, seed, seq, 60, true)
			cov.add(w.cov)
		}
	}
	cfRequireCoverage(t, "transfer sequences", cov, cfCoverage{transfers: 1})
}

// TestCurveFuzz_SellAfterTransferIn_WAUnderflowLocksTheExit — the exact
// reproduction of the two live defects the WA aggregate caused (F-1 exit
// DoS + F-2 partial write on a REJECTED sell), KEPT with its substantive
// assertions intact. Under the current core (WA deleted, chokepoint
// ordering) the Sell now SUCCEEDS — the green path below — proving the fund
// lock and the partial write are gone at their root, not patched over.
func TestCurveFuzz_SellAfterTransferIn_WAUnderflowLocksTheExit(t *testing.T) {
	if BasePrice != 1000 || CurveLinNum != 63000 || CurveQuadNum != 21 || CurveDenom != 8000 {
		t.Fatalf("calibration changed — recompute this finding's expectations; do NOT skip a finding reproduction")
	}
	s := NewMemStore()
	c := "creatora"
	setMoney(s, kCap(c), cfBI(MaxCap))
	setU64(s, kRegisteredAt(c), 1)
	setU64(s, kPaidUntil(c), 10_000_000)

	// alice buys 100 at block 1000; bob buys 100 at block 5000.
	if _, err := Buy(s, "alice", c, 1000, cfBI(100)); err != nil {
		t.Fatal(err)
	}
	if _, err := Buy(s, "bob", c, 5000, cfBI(100)); err != nil {
		t.Fatal(err)
	}
	// The equality invariant holds: R = 140,656 + 224,684 = 365,340 =
	// area(200) (RULING I integers).
	if R, S := getMoney(s, kReserve(c)), getMoney(s, kSupply(c)); R.Cmp(Area(S)) != 0 {
		t.Fatalf("setup: R=%s, area(%s)=%s — want equality", R, S, Area(S))
	}
	if R := getMoney(s, kReserve(c)); R.Cmp(cfBI(365_340)) != 0 {
		t.Fatalf("setup reserve = %s, want 365340 = area(200)", R)
	}

	// The one ordinary action that used to poison it: an OLDER holder sends
	// to a NEWER one. Nothing exotic, no privileged role, no timing trick.
	if err := TransferCredits(s, "alice", c, "alice", "bob", 5000, cfBI(100)); err != nil {
		t.Fatal(err)
	}

	balBefore := getMoney(s, kBal(c, "bob"))
	supBefore := getMoney(s, kSupply(c))
	resBefore := getMoney(s, kReserve(c))

	_, err := Sell(s, "bob", c, 5000, cfBI(200))

	if err != nil {
		t.Errorf("F-1 EXIT DoS CONFIRMED: bob holds %s tokens on a market with R=%s >= area(S=%s)=%s and the curve rail ACTIVE, "+
			"yet Sell(200) fails with %s (%v). An outflow that reverts on an accounting aggregate is a fund lock — "+
			"during ACTIVE this holder has NO other exit rail.",
			balBefore, resBefore, supBefore, Area(supBefore), errSymbol(err), err)

		// F-2: the failed call must have mutated nothing.
		balAfter := getMoney(s, kBal(c, "bob"))
		supAfter := getMoney(s, kSupply(c))
		if balAfter.Cmp(balBefore) != 0 || supAfter.Cmp(supBefore) != 0 {
			t.Errorf("F-2 PARTIAL WRITE CONFIRMED: the REJECTED Sell still mutated state — bob's balance %s -> %s, supply %s -> %s, reserve %s -> %s. "+
				"I3 (supply == Σ bal + escrowed) is now broken by %s tokens; only a wholesale transaction revert at the wasm layer hides it.",
				balBefore, balAfter, supBefore, supAfter, resBefore, getMoney(s, kReserve(c)),
				new(big.Int).Sub(balBefore, balAfter))
		}
		return
	}
	// Green path: the exit works, and the books are exact.
	if R, S := getMoney(s, kReserve(c)), getMoney(s, kSupply(c)); R.Cmp(Area(S)) != 0 {
		t.Fatalf("post-sell: R=%s != area(%s)=%s", R, S, Area(S))
	}
	t.Logf("Sell succeeded — the WA underflow fund-lock (F-1) and the partial-write (F-2) are structurally gone (RULING A4 + G).")
}

// TestCurveFuzz_AtomicRoundTripNeverProfits — the drain probe. From MANY
// randomized states (including huge seeded excess — the regime the pro-rata
// drain lived in), a fresh attacker buys n and immediately sells n back,
// with NO other operation in between, fresh (max RATE — though J1 zeroes the
// assessed tax on the zero-gain trip, which makes the probe SHARPER: the
// non-profit property may not lean on the tax at all) and aged (zero rate).
// Also asserts the excess is EXACTLY unchanged across the round trip — the
// attacker cannot touch it.
func TestCurveFuzz_AtomicRoundTripNeverProfits(t *testing.T) {
	actors := []string{"alice", "bob", "carol"}
	probes, agedProbes := 0, 0
	for _, seed := range cfSeeds {
		r := rand.New(rand.NewSource(seed + 5150))
		for iter := 0; iter < 60; iter++ {
			base, creator, block, _ := cfRandStart(r, actors)
			for _, aged := range []bool{false, true} {
				s := hzCloneStore(base)
				attacker := "attacker.x"
				n := new(big.Int).Add(cfRand(r, 20_000), cfBI(1))
				headroom := new(big.Int).Sub(cfBI(MaxCap), getMoney(s, kSupply(creator)))
				if n.Cmp(headroom) > 0 {
					continue
				}
				eBefore := new(big.Int).Sub(getMoney(s, kReserve(creator)), Area(getMoney(s, kSupply(creator))))

				br, err := Buy(s, attacker, creator, block, n)
				if err != nil {
					t.Fatalf("seed=%d iter=%d: probe Buy(n=%s) rejected: %v", seed, iter, n, err)
				}

				sellBlock := block
				if aged {
					sellBlock = block + ExitTaxDecayBlocks + 1
					setU64(s, kPaidUntil(creator), sellBlock+SubscriptionPeriod)
				}
				sr, err := Sell(s, attacker, creator, sellBlock, n)
				if err != nil {
					t.Fatalf("seed=%d iter=%d aged=%v: probe Sell(n=%s) rejected: %v", seed, iter, aged, n, err)
				}
				if aged && sr.TaxBps != 0 {
					t.Fatalf("aged probe still rate-taxed at %d bps (held %d)", sr.TaxBps, sr.HeldBlocks)
				}
				// RULING K1: a FRESH atomic round trip now pays the full GROSS
				// rate tax (no realized-gain cap) — exactly ExitTaxOn(gross, τ).
				// (Under the deleted J1 cap this was 0, because the realized gain
				// was 0.) The no-profit and excess-unmoved invariants below still
				// hold — the tax only makes the round trip lose MORE.
				if want := ExitTaxOn(sr.Gross, sr.TaxBps); sr.Tax.Cmp(want) != 0 {
					t.Fatalf("probe tax %s != gross rate tax %s (K1: no cap)", sr.Tax, want)
				}
				if sr.Net.Cmp(br.TotalDue) > 0 {
					t.Fatalf("ATOMIC ROUND-TRIP PROFIT (seed=%d iter=%d aged=%v): bought n=%s for %s, took back %s",
						seed, iter, aged, n, br.TotalDue, sr.Net)
				}
				// The excess is EXACTLY what it was — un-extractable.
				R, S := getMoney(s, kReserve(creator)), getMoney(s, kSupply(creator))
				if eAfter := new(big.Int).Sub(R, Area(S)); eAfter.Cmp(eBefore) != 0 {
					t.Fatalf("EXCESS MOVED across atomic round trip (seed=%d iter=%d aged=%v): %s -> %s", seed, iter, aged, eBefore, eAfter)
				}
				probes++
				if aged {
					agedProbes++
				}
			}
		}
	}
	if probes < 500 || agedProbes < 250 {
		t.Errorf("VACUOUS FUZZ: only %d round-trip probes (%d of them zero-rate) — want >= 500 / >= 250", probes, agedProbes)
	}
	t.Logf("coverage [atomic round trips]: %d probes, %d at ZERO rate (neither the tax rate nor the cap is what makes the round trip unprofitable — L5 equality and the fee are)", probes, agedProbes)
}

// TestCurveFuzz_EarlyBuyerProfitsWhenOthersBuy_ByDesign — the honest
// negative. The unrestricted multi-actor "no round-trip profit" is FALSE BY
// DESIGN on a bonding curve, proven with exact integers so nobody later
// "fixes" the math to satisfy an impossible invariant: an early buyer who
// sells after LATER buyers pushed the supply up is selling a higher slice
// than they bought — that IS the mechanism (RULING J residual truth #1:
// the (curve-leg) transfer from late buyers to early sellers cannot be
// removed without deleting the product), funded entirely by the later
// buyers' payments, never by the reserve going short (the equality
// invariant holds throughout). The FRESH dump pays the full 20% rate to the
// treasury (the J1 gain exceeds it — the reference-attacker regime); the
// aged dump pays zero by the decay.
func TestCurveFuzz_EarlyBuyerProfitsWhenOthersBuy_ByDesign(t *testing.T) {
	if BasePrice != 1000 || CurveLinNum != 63000 || CurveQuadNum != 21 || CurveDenom != 8000 {
		t.Fatalf("calibration changed — recompute these expectations; do NOT skip")
	}
	build := func() (*MemStore, string, *BuyResult) {
		s := NewMemStore()
		c := "creatora"
		b := uint64(1_000_000)
		setMoney(s, kCap(c), cfBI(MaxCap))
		setU64(s, kRegisteredAt(c), 1)
		setU64(s, kPaidUntil(c), b+100*SubscriptionPeriod)
		alice, err := Buy(s, "alice", c, b, cfBI(100)) // cost = area(100) = 140,656, fee 14,065
		if err != nil {
			t.Fatal(err)
		}
		if alice.TotalDue.Cmp(cfBI(154_721)) != 0 {
			t.Fatalf("alice paid %s, want 154721 (cost 140656 + fee 14065)", alice.TotalDue)
		}
		if _, err := Buy(s, "bob", c, b+10, cfBI(100)); err != nil { // cost = area(200)−area(100) = 224,684
			t.Fatal(err)
		}
		return s, c, alice
	}

	// FRESH dump: gain 84,028 > rate tax 44,937 ⇒ the attacker pays the
	// identical full 20% (J1's "cap does not help the attacker"), to the
	// treasury (J).
	{
		s, c, alice := build()
		trea0 := getMoney(s, kTreasury())
		sr, err := Sell(s, "alice", c, 1_000_011, cfBI(100))
		if err != nil {
			t.Fatal(err)
		}
		if sr.Gross.Cmp(cfBI(224_684)) != 0 || sr.Tax.Cmp(cfBI(44_937)) != 0 || sr.Net.Cmp(cfBI(157_279)) != 0 {
			t.Fatalf("fresh dump: gross=%s tax=%s net=%s, want 224684/44937/157279", sr.Gross, sr.Tax, sr.Net)
		}
		// The tax is split 50/50 (2026-07-27): alice is not the creator, so
		// the treasury takes the platform half plus the platform fee half, and
		// the creator's claimable pot takes the other tax half.
		taxC, taxP := exitTaxSplit(c, "alice", sr.Tax)
		wantTrea := mAdd(mAdd(trea0, taxP), sr.FeePlatform)
		if got := getMoney(s, kTreasury()); got.Cmp(wantTrea) != 0 {
			t.Fatalf("treasury = %s, want %s (platform half of the tax + platform fee)", got, wantTrea)
		}
		if reunited := mAdd(taxC, taxP); reunited.Cmp(sr.Tax) != 0 {
			t.Fatalf("tax split leaked: %s != assessed %s", reunited, sr.Tax)
		}
		profit := new(big.Int).Sub(sr.Net, alice.TotalDue)
		if profit.Cmp(cfBI(2558)) != 0 {
			t.Fatalf("fresh-dump profit = %s, want 2558", profit)
		}
	}

	// AGED dump: zero rate — alice nets 202,216 on 154,721 paid.
	{
		s, c, alice := build()
		sellBlock := uint64(1_000_000) + ExitTaxDecayBlocks + 1
		setU64(s, kPaidUntil(c), sellBlock+SubscriptionPeriod)
		sr, err := Sell(s, "alice", c, sellBlock, cfBI(100))
		if err != nil {
			t.Fatal(err)
		}
		if sr.TaxBps != 0 || sr.Gross.Cmp(cfBI(224_684)) != 0 || sr.Net.Cmp(cfBI(202_216)) != 0 {
			t.Fatalf("aged exit: tax=%dbps gross=%s net=%s, want 0bps/224684/202216", sr.TaxBps, sr.Gross, sr.Net)
		}
		profit := new(big.Int).Sub(sr.Net, alice.TotalDue)
		if profit.Cmp(cfBI(47_495)) != 0 {
			t.Fatalf("aged-dump profit = %s, want 47495 (by design — funded by bob, not the reserve)", profit)
		}
		// ... and the reserve is whole: the equality invariant, funded
		// entirely by bob's payment, not by the curve.
		S, R := getMoney(s, kSupply(c)), getMoney(s, kReserve(c))
		if R.Cmp(Area(S)) != 0 {
			t.Fatalf("equality broken: R=%s != area(%s)=%s", R, S, Area(S))
		}
		t.Logf("BY DESIGN: alice paid 154721, netted %s (profit %s) because bob's buy raised the slice she sold; "+
			"the unrestricted multi-actor 'no round-trip profit' assertion is NOT an invariant.", sr.Net, profit)
	}
}
