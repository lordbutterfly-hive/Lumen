package core

import (
	"math/big"
	"testing"
)

// zz_fix_refundholder_test.go — REFUNDHOLDER-BLEND: the measurement that settled
// "RefundHolder's blended-clock exit tax is exact because it sweeps the whole
// position" (it is NOT), and the proof that the door it opened is now shut.
//
// THE MEASUREMENT (Part A, unchanged numbers, re-run on every build so the repro
// can never silently degenerate): on a heterogeneous maturing bucket the blend
// reads FULLY MATURED — 0 bps — while the holder's fresh cohorts are still most
// of a window young. RefundHolder charged that 0. The exact per-cohort charge on
// the identical tokens at the identical block reaches 455 bps of the maturing
// base (4.55% against the 1500-bps ceiling) on the shapes searched here; the
// two-cohort closed form is MaxExitTaxBps·p(1−p) = 375 bps at a 50/50 split.
// RefundHolder is PERMISSIONLESS and `caller` never appears in a key it touches,
// so the holder pushed THEMSELVES and booked the whole evasion in one call.
//
// THE FIX (Part B): the charge is now refundMaturingCohortTax — the SAME pure
// per-cohort, freshest-first, no-blend-floor rule the Refund rail uses — and the
// consent gate refuses while ANY cohort still owes, so the money fix cannot be
// turned around into the EXITTAX-1 harm (a stranger crystallising a still-fresh
// cohort's tax against the holder's will). Liveness is unchanged: the wind-down
// backstop still bypasses the gate at open+ExitTaxDecayBlocks.

// ---------------------------------------------------------------------------
// shared fixtures
// ---------------------------------------------------------------------------

// rhTerms returns the terms RefundHolder works from at `block`, both ways: the
// OLD blended charge and the exact per-cohort charge on identical inputs.
func rhTerms(s Store, c, h string, block uint64) (bal, gross, base, blendTax, cohortTax, delta *big.Int, blendBps uint64) {
	bal = totalBalance(s, c, h)
	supply := getMoney(s, kSupply(c))
	reserve := getMoney(s, kReserve(c))
	gross = refundPayout(reserve, bal, supply)
	_, fromMaturing := splitDraw(s, c, h, bal)
	base = maturingGrossShare(gross, fromMaturing, bal)
	blendBps = ExitTaxBpsAt(heldBlocksAt(s, c, h, block))
	blendTax = ExitTaxOn(base, blendBps) // what RefundHolder charged BEFORE the fix
	cohortTax = refundMaturingCohortTax(s, c, h, base, fromMaturing, block)
	delta = new(big.Int).Sub(cohortTax, blendTax) // >0 => the blend UNDER-charges
	return
}

// rhBuild: aged pile N (bought at t0, ripe at t1) + fresh slice M transferred in
// at t1; market retired at t1 so the wind-down rail is open from there on.
func rhBuild(t *testing.T, N, M int64) (s *MemStore, c string, t0, t1 uint64) {
	t.Helper()
	c = "alice"
	t0 = uint64(2_000_000)
	t1 = t0 + ExitTaxDecayBlocks
	s = NewMemStore()
	pfMarket(t, s, c, t1)
	pfBuy(t, s, "whale", c, t0, N)
	pfBuy(t, s, "alt", c, t1, M)
	if err := TransferCredits(s, "alt", c, "alt", "whale", t1, big.NewInt(M)); err != nil {
		t.Fatalf("TransferCredits: %v", err)
	}
	if err := Retire(s, c, c, t1); err != nil {
		t.Fatalf("Retire: %v", err)
	}
	return s, c, t0, t1
}

// rhShape builds a ripe pile plus up to N green slices, every one created by a
// real Buy + TransferCredits (so every acq is one a real account could hold).
func rhShape(t *testing.T, aged int64, greens []int64, gapDiv []uint64) (s *MemStore, c string, retireBlk uint64) {
	t.Helper()
	c = "alice"
	t0 := uint64(2_000_000)
	base := t0 + ExitTaxDecayBlocks
	last := base
	for _, g := range gapDiv {
		if b := base + ExitTaxDecayBlocks/g; b > last {
			last = b
		}
	}
	s = NewMemStore()
	pfMarket(t, s, c, last+10)
	pfBuy(t, s, "whale", c, t0, aged)
	for i, n := range greens {
		blk := base + ExitTaxDecayBlocks/gapDiv[i]
		who := "g" + string(rune('a'+i))
		pfBuy(t, s, who, c, blk, n)
		if err := TransferCredits(s, who, c, who, "whale", blk, big.NewInt(n)); err != nil {
			t.Fatalf("transfer %d: %v", i, err)
		}
	}
	if err := Retire(s, c, c, last); err != nil {
		t.Fatalf("Retire: %v", err)
	}
	return s, c, last
}

func rhTaxBooked(s Store, c string, fee, tre *big.Int) *big.Int {
	return new(big.Int).Add(
		new(big.Int).Sub(getMoney(s, kFeeBal(c)), fee),
		new(big.Int).Sub(getMoney(s, kTreasury()), tre))
}

// ---------------------------------------------------------------------------
// PART A — THE MEASUREMENT. The blend is NOT exact for the whole-position sweep.
// ---------------------------------------------------------------------------

func TestRHFix_A1_BlendDivergesOnTheWholeSweep(t *testing.T) {
	const N, M = int64(4000), int64(4000)
	s, c, _, t1 := rhBuild(t, N, M)
	w := holderAcqBlock(s, c, "whale")
	T := w + ExitTaxDecayBlocks // first block the BLEND reads fully matured

	for i, l := range getLots(s, c, "whale") {
		t.Logf("  lot[%d] count=%s acq=%d rate=%d bps", i, l.count, l.acq, lotRateAt(l.acq, T))
	}
	_, _, base, blendTax, cohortTax, delta, bps := rhTerms(s, c, "whale", T)
	t.Logf("blend acq=%d; blend matures at T=t1+%d; fresh cohort matures at t1+%d",
		w, T-t1, ExitTaxDecayBlocks)
	t.Logf("base=%s  blend(%d bps)=%s  exact per-cohort=%s  DIVERGENCE=%s",
		base, bps, blendTax, cohortTax, delta)
	if bps != 0 {
		t.Fatalf("repro degenerate: blend is not 0 bps at T (got %d)", bps)
	}
	if delta.Sign() <= 0 {
		t.Fatalf("repro degenerate: no divergence (delta=%s)", delta)
	}
	// 375 bps of the base is the two-cohort closed form at a 50/50 split.
	inBps := new(big.Int).Quo(new(big.Int).Mul(delta, big.NewInt(10000)), base)
	t.Logf("DIVERGENCE = %s bps of the maturing base (MaxExitTaxBps=%d)", inBps, MaxExitTaxBps)
	if inBps.Cmp(big.NewInt(375)) != 0 {
		t.Fatalf("closed form moved: expected 375 bps of base, got %s", inBps)
	}
}

func TestRHFix_A2_WorstReachableDivergence(t *testing.T) {
	shapes := []struct {
		aged   int64
		greens []int64
		gaps   []uint64
	}{
		{4000, []int64{4000}, []uint64{1000000}},
		{5000, []int64{2000, 2000, 2000}, []uint64{3, 3, 3}},
		{5000, []int64{2000, 2000, 2000}, []uint64{6, 3, 2}},
		{5000, []int64{1000, 2000, 4000}, []uint64{8, 4, 2}},
		{5000, []int64{4000, 2000, 1000}, []uint64{8, 4, 2}},
		{5000, []int64{1000, 1000, 1000, 1000, 4000}, []uint64{16, 8, 4, 2, 1}},
		{10000, []int64{2000, 2000, 2000, 2000, 2000}, []uint64{10, 6, 4, 3, 2}},
		{20000, []int64{5000, 5000, 5000, 5000, 5000}, []uint64{10, 6, 4, 3, 2}},
		{50000, []int64{10000, 10000, 10000}, []uint64{6, 3, 2}},
		{5000, []int64{3000, 3000}, []uint64{8, 2}},
		{5000, []int64{2000, 6000}, []uint64{4, 2}},
	}
	best := big.NewInt(0)
	for _, sh := range shapes {
		s, c, last := rhShape(t, sh.aged, sh.greens, sh.gaps)
		w := holderAcqBlock(s, c, "whale")
		T := w + ExitTaxDecayBlocks
		if T < last {
			T = last
		}
		_, _, base, blendTax, cohortTax, delta, bps := rhTerms(s, c, "whale", T)
		inBps := new(big.Int).Quo(new(big.Int).Mul(delta, big.NewInt(10000)), base)
		t.Logf("aged=%6d greens=%v -> blend=%d bps (tax %s) cohort=%s DIVERGENCE=%s (%s bps of base)",
			sh.aged, sh.greens, bps, blendTax, cohortTax, delta, inBps)
		if inBps.Cmp(best) > 0 {
			best = inBps
		}
	}
	t.Logf("WORST MEASURED DIVERGENCE = %s bps of the maturing base, ceiling %d bps", best, MaxExitTaxBps)
	if best.Cmp(big.NewInt(455)) < 0 {
		t.Fatalf("the searched space no longer reproduces the measured worst case (got %s bps, expected >= 455)", best)
	}
}

// A3 — the OTHER direction. Can the blend charge MORE than the cohorts owe
// (confiscation from an honest holder)? Only by rate-rounding, and only while
// the gate is shut. Measured worst on the grid, in bps of the base.
func TestRHFix_A3_OverchargeIsRoundingOnly(t *testing.T) {
	worst := big.NewInt(0)
	var wBase *big.Int
	var wBlocked bool
	for _, r := range [][2]int64{{999000, 1000}, {99000, 1000}, {9000, 1000}, {5000, 5000}, {1000, 9000}, {1000, 99000}, {1000, 999000}} {
		s, c, _, t1 := rhBuild(t, r[0], r[1])
		for d := uint64(0); d <= ExitTaxDecayBlocks; d += ExitTaxDecayBlocks / 240 {
			T := t1 + d
			_, _, base, _, _, delta, _ := rhTerms(s, c, "whale", T)
			if delta.Sign() < 0 && delta.Cmp(worst) < 0 {
				worst, wBase = delta, base
				wBlocked = RefundHolderTaxGateBlocked(s, c, "whale", T)
			}
		}
	}
	if worst.Sign() == 0 {
		t.Logf("no over-charge anywhere on the grid")
		return
	}
	inBps := new(big.Int).Quo(new(big.Int).Mul(new(big.Int).Neg(worst), big.NewInt(10000)), wBase)
	t.Logf("WORST OVER-CHARGE = %s base units on a base of %s == %s bps of base; gateBlocked=%v",
		new(big.Int).Neg(worst), wBase, inBps, wBlocked)
	if inBps.Cmp(big.NewInt(1)) > 0 {
		t.Fatalf("over-charge exceeds the 1-bps rate-rounding bound: %s bps", inBps)
	}
}

// A4 — LEGACY (no `lots|` key) and HOMOGENEOUS positions are EXACT: the cohort
// charge equals the blend charge byte for byte, so nothing honest moves.
func TestRHFix_A4_LegacyAndHomogeneousAreExact(t *testing.T) {
	c := "alice"
	t0 := uint64(2_000_000)
	for _, frac := range []uint64{0, 4, 3, 2, 1} {
		s := NewMemStore()
		pfMarket(t, s, c, t0+ExitTaxDecayBlocks)
		pfBuy(t, s, "whale", c, t0, 4000)
		pfBuy(t, s, "alt", c, t0+1000, 1000)
		if err := TransferCredits(s, "alt", c, "alt", "whale", t0+1000, big.NewInt(1000)); err != nil {
			t.Fatalf("TransferCredits: %v", err)
		}
		s.Delete(kLots(c, "whale")) // legacy: a pre-ledger position
		if err := Retire(s, c, c, t0+2000); err != nil {
			t.Fatalf("Retire: %v", err)
		}
		T := t0 + 2000
		if frac > 0 {
			T += ExitTaxDecayBlocks / frac
		}
		_, _, base, blendTax, cohortTax, delta, bps := rhTerms(s, c, "whale", T)
		t.Logf("legacy T=t0+%-8d base=%s blend(%4d bps)=%s cohort=%s delta=%s",
			T-t0, base, bps, blendTax, cohortTax, delta)
		if delta.Sign() != 0 {
			t.Fatalf("LEGACY NOT EXACT at T=t0+%d: delta=%s", T-t0, delta)
		}
	}
	// homogeneous, ledgered: one cohort, so the floor is a no-op
	s := NewMemStore()
	pfMarket(t, s, c, t0+ExitTaxDecayBlocks)
	pfBuy(t, s, "solo", c, t0, 4000)
	if err := Retire(s, c, c, t0+10); err != nil {
		t.Fatalf("Retire: %v", err)
	}
	for _, d := range []uint64{10, ExitTaxDecayBlocks / 2, ExitTaxDecayBlocks} {
		_, _, _, blendTax, cohortTax, delta, bps := rhTerms(s, c, "solo", t0+d)
		t.Logf("homogeneous d=%-8d blend(%4d bps)=%s cohort=%s delta=%s", d, bps, blendTax, cohortTax, delta)
		if delta.Sign() != 0 {
			t.Fatalf("HOMOGENEOUS NOT EXACT at d=%d: delta=%s", d, delta)
		}
	}
}

// ---------------------------------------------------------------------------
// PART B — THE DOOR IS SHUT.
// ---------------------------------------------------------------------------

// B1 — the launder call itself. At the block the blend reads matured and the
// fresh cohort is still green, the permissionless push is REFUSED (consent
// gate), so the 0-tax exit no longer exists; the holder's own Refund on the
// same position at the same block charges the full per-cohort tax.
func TestRHFix_B1_SelfPushLaunderRefused(t *testing.T) {
	const N, M = int64(4000), int64(4000)
	s, c, _, t1 := rhBuild(t, N, M)
	w := holderAcqBlock(s, c, "whale")
	T := w + ExitTaxDecayBlocks

	_, _, _, blendTax, cohortTax, _, bps := rhTerms(s, c, "whale", T)
	if bps != 0 || blendTax.Sign() != 0 {
		t.Fatalf("repro degenerate: blend is %d bps / tax %s at T", bps, blendTax)
	}
	if _, err := RefundHolder(s, "whale", c, "whale", T); err == nil {
		t.Fatalf("LAUNDER OPEN: the self-push succeeded at the blend-matured block")
	} else {
		t.Logf("self-push REFUSED at T=t1+%d: %v", T-t1, err)
	}
	// and a stranger cannot do it either
	if _, err := RefundHolder(s, "keeper", c, "whale", T); err == nil {
		t.Fatalf("LAUNDER OPEN: a stranger's push succeeded at the blend-matured block")
	}
	// the honest door still works and charges the per-cohort tax
	fee, tre := getMoney(s, kFeeBal(c)), getMoney(s, kTreasury())
	bal := totalBalance(s, c, "whale")
	net, err := Refund(s, "whale", c, T, bal)
	if err != nil {
		t.Fatalf("Refund: %v", err)
	}
	booked := rhTaxBooked(s, c, fee, tre)
	t.Logf("Refund(self) at the same block: net=%s tax booked=%s (exact per-cohort=%s)", net, booked, cohortTax)
	if booked.Cmp(cohortTax) != 0 {
		t.Fatalf("Refund booked %s, expected the per-cohort %s", booked, cohortTax)
	}
}

// B2 — SWEEP. Over every shape and block on the grid, RefundHolder either
// refuses, or charges EXACTLY the per-cohort tax. It is never cheaper than the
// exact charge anywhere.
func TestRHFix_B2_NeverCheaperThanCohortAnywhere(t *testing.T) {
	fired, refused := 0, 0
	for _, r := range [][2]int64{{9000, 1000}, {5000, 5000}, {1000, 9000}, {4000, 4000}, {100000, 100000}} {
		for _, d := range []uint64{0, ExitTaxDecayBlocks / 8, ExitTaxDecayBlocks / 4, ExitTaxDecayBlocks / 2,
			3 * ExitTaxDecayBlocks / 4, ExitTaxDecayBlocks - 1, ExitTaxDecayBlocks, ExitTaxDecayBlocks + 1} {
			s, c, _, t1 := rhBuild(t, r[0], r[1])
			T := t1 + d
			_, _, _, _, cohortTax, _, _ := rhTerms(s, c, "whale", T)
			fee, tre := getMoney(s, kFeeBal(c)), getMoney(s, kTreasury())
			resBefore, supBefore := getMoney(s, kReserve(c)), getMoney(s, kSupply(c))
			balBefore := totalBalance(s, c, "whale")
			net, err := RefundHolder(s, "keeper", c, "whale", T)
			if err != nil {
				refused++
				continue
			}
			fired++
			booked := rhTaxBooked(s, c, fee, tre)
			if booked.Cmp(cohortTax) != 0 {
				t.Fatalf("N=%d M=%d d=%d: push booked %s, exact per-cohort is %s",
					r[0], r[1], d, booked, cohortTax)
			}
			// CONSERVATION on the rail this change touches: the reserve is
			// debited the FULL gross, the holder receives gross − tax, and the
			// tax is the only carve. Σ balances == supply after (the push takes
			// the whole position and the whole supply leg with it).
			grossOut := new(big.Int).Sub(resBefore, getMoney(s, kReserve(c)))
			if want := new(big.Int).Add(net, booked); grossOut.Cmp(want) != 0 {
				t.Fatalf("N=%d M=%d d=%d: reserve debit %s != net+tax %s", r[0], r[1], d, grossOut, want)
			}
			if supDelta := new(big.Int).Sub(supBefore, getMoney(s, kSupply(c))); supDelta.Cmp(balBefore) != 0 {
				t.Fatalf("supply moved %s, the position was %s", supDelta, balBefore)
			}
			if b := totalBalance(s, c, "whale"); b.Sign() != 0 {
				t.Fatalf("push left %s behind", b)
			}
			if sum, kb := zvSumLotsRaw(s, c, "whale"), getMoney(s, kBal(c, "whale")); sum.Cmp(kb) != 0 {
				t.Fatalf("Σlots=%s != kBal=%s after the push", sum, kb)
			}
		}
	}
	t.Logf("grid: %d pushes fired (each booking exactly the per-cohort tax), %d refused by the gate", fired, refused)
	if fired == 0 {
		t.Fatalf("vacuous: no push ever fired on the grid")
	}
}

// B3 — DOOR PARITY. For the same position at the same block, the push and the
// holder's own full Refund book the SAME tax and pay the SAME net. There is no
// cheaper door to shop for.
func TestRHFix_B3_DoorParity(t *testing.T) {
	checked := 0
	for _, r := range [][2]int64{{9000, 1000}, {5000, 5000}, {4000, 4000}} {
		for _, d := range []uint64{ExitTaxDecayBlocks, ExitTaxDecayBlocks + 1, 2 * ExitTaxDecayBlocks} {
			sA, c, _, t1 := rhBuild(t, r[0], r[1])
			sB, _, _, _ := rhBuild(t, r[0], r[1])
			T := t1 + d
			if RefundHolderTaxGateBlocked(sA, c, "whale", T) {
				continue
			}
			feeA, treA := getMoney(sA, kFeeBal(c)), getMoney(sA, kTreasury())
			netA, err := Refund(sA, "whale", c, T, totalBalance(sA, c, "whale"))
			if err != nil {
				t.Fatalf("Refund: %v", err)
			}
			taxA := rhTaxBooked(sA, c, feeA, treA)

			feeB, treB := getMoney(sB, kFeeBal(c)), getMoney(sB, kTreasury())
			netB, err := RefundHolder(sB, "keeper", c, "whale", T)
			if err != nil {
				t.Fatalf("RefundHolder: %v", err)
			}
			taxB := rhTaxBooked(sB, c, feeB, treB)

			if taxA.Cmp(taxB) != 0 || netA.Cmp(netB) != 0 {
				t.Fatalf("DOOR MISMATCH N=%d M=%d d=%d: Refund(net=%s tax=%s) vs Push(net=%s tax=%s)",
					r[0], r[1], d, netA, taxA, netB, taxB)
			}
			checked++
		}
	}
	t.Logf("door parity holds on %d (shape, block) pairs", checked)
	if checked == 0 {
		t.Fatalf("vacuous: no comparable pair")
	}
}

// B4 — LIVENESS UNCHANGED. The wind-down backstop still bypasses the gate at
// exactly open+ExitTaxDecayBlocks, even against a maximally-fresh cohort written
// past every public path — and the tax it books there is the per-cohort one.
func TestRHFix_B4_BackstopStillFiresAndChargesCohorts(t *testing.T) {
	const N, M = int64(4000), int64(4000)
	s, c, _, t1 := rhBuild(t, N, M)
	open, ok := windDownOpenBlock(s, c, t1)
	if !ok || open != t1 {
		t.Fatalf("wind-down did not open at t1 (open=%d ok=%v)", open, ok)
	}
	// a maximally-fresh cohort at the backstop block: organically unreachable
	// (every acq <= open), written directly exactly as the EXITTAX-DOS-1 fixture
	// does, so the defense-in-depth branch is measured rather than assumed.
	at := open + ExitTaxDecayBlocks
	dosFreshenClock(s, c, at, "whale")
	if !holderHasGreenCohort(s, c, "whale", at) {
		t.Fatalf("fixture: no green cohort at the backstop block")
	}
	one := at - 1
	if !RefundHolderTaxGateBlocked(s, c, "whale", one) {
		t.Fatalf("gate opened one block EARLY (at open+%d)", one-open)
	}
	if RefundHolderTaxGateBlocked(s, c, "whale", at) {
		t.Fatalf("backstop did NOT open at open+ExitTaxDecayBlocks — liveness regressed")
	}
	_, _, _, blendTax, cohortTax, _, bps := rhTerms(s, c, "whale", at)
	fee, tre := getMoney(s, kFeeBal(c)), getMoney(s, kTreasury())
	net, err := RefundHolder(s, "keeper", c, "whale", at)
	if err != nil {
		t.Fatalf("backstop push refused: %v", err)
	}
	booked := rhTaxBooked(s, c, fee, tre)
	t.Logf("backstop push at open+%d: net=%s booked=%s (blend %d bps would have been %s; per-cohort %s)",
		at-open, net, booked, bps, blendTax, cohortTax)
	if booked.Cmp(cohortTax) != 0 {
		t.Fatalf("backstop booked %s, expected the per-cohort %s", booked, cohortTax)
	}
	if getMoney(s, kBal(c, "whale")).Sign() != 0 || getMatured(s, c, "whale").Sign() != 0 {
		t.Fatalf("push left a residue behind")
	}
}

// B4b — the money half of the fix, measured INSIDE the backstop branch, where
// the gate no longer protects anything and the charge is all that stands
// between a heterogeneous position and a free exit. The state is written
// directly (a stale-aged blend over two green cohorts is organically
// unreachable — every acq <= windDownOpenBlock — which is exactly why the
// branch is kept as defense-in-depth), and the push must book the per-cohort
// charge, not the blend's.
func TestRHFix_B4b_BackstopChargesCohortsNotBlend(t *testing.T) {
	const N, M = int64(4000), int64(4000)
	s, c, _, t1 := rhBuild(t, N, M)
	at := t1 + ExitTaxDecayBlocks // backstop open (open == t1)
	bal := getMoney(s, kBal(c, "whale"))
	half := new(big.Int).Div(bal, big.NewInt(2))
	setLots(s, c, "whale", []mLot{
		{count: half, acq: at}, // 1500 bps
		{count: new(big.Int).Sub(bal, half), acq: at - ExitTaxDecayBlocks/2}, // 750 bps
	})
	setU64(s, kAcqBlock(c, "whale"), at-9*ExitTaxDecayBlocks/10) // stale-aged blend: 150 bps

	_, _, _, blendTax, cohortTax, delta, bps := rhTerms(s, c, "whale", at)
	t.Logf("backstop, heterogeneous: blend %d bps -> %s ; per-cohort -> %s ; the blend under-charges by %s",
		bps, blendTax, cohortTax, delta)
	if delta.Sign() <= 0 {
		t.Fatalf("fixture degenerate: blend does not under-charge (delta=%s)", delta)
	}
	if RefundHolderTaxGateBlocked(s, c, "whale", at) {
		t.Fatalf("backstop should be open at open+ExitTaxDecayBlocks")
	}
	fee, tre := getMoney(s, kFeeBal(c)), getMoney(s, kTreasury())
	if _, err := RefundHolder(s, "keeper", c, "whale", at); err != nil {
		t.Fatalf("backstop push refused: %v", err)
	}
	booked := rhTaxBooked(s, c, fee, tre)
	if booked.Cmp(cohortTax) != 0 {
		t.Fatalf("backstop booked %s (blend would be %s), expected the per-cohort %s", booked, blendTax, cohortTax)
	}
	t.Logf("booked %s == per-cohort; the blend would have let %s walk", booked, delta)
}

// B5 — THE ABANDONED SWEEP STILL WORKS. A genuinely aged, genuinely abandoned
// position is still swept at zero tax, which is the whole purpose of the push.
func TestRHFix_B5_AbandonedSweepUnchanged(t *testing.T) {
	c := "alice"
	t0 := uint64(2_000_000)
	s := NewMemStore()
	pfMarket(t, s, c, t0+10)
	pfBuy(t, s, "gone", c, t0, 4000)
	if err := Retire(s, c, c, t0+10); err != nil {
		t.Fatalf("Retire: %v", err)
	}
	at := t0 + ExitTaxDecayBlocks
	fee, tre := getMoney(s, kFeeBal(c)), getMoney(s, kTreasury())
	net, err := RefundHolder(s, "keeper", c, "gone", at)
	if err != nil {
		t.Fatalf("abandoned sweep refused: %v", err)
	}
	booked := rhTaxBooked(s, c, fee, tre)
	t.Logf("abandoned sweep at t0+Dt: net=%s tax=%s supply now %s", net, booked, getMoney(s, kSupply(c)))
	if booked.Sign() != 0 {
		t.Fatalf("a fully-aged abandoned position was taxed %s", booked)
	}
	if !CloseIfDrained(s, c, at) {
		t.Fatalf("market did not close after the sweep drained it")
	}
}

// B6 — THE PRICE OF THE TIGHTER GATE, MEASURED AND BOUNDED (not hidden).
//
// The cohort-aware gate refuses the permissionless push while ANY cohort owes.
// A dust gift creates a green cohort, so one gifted token now blocks the push
// for the whole window instead of the few blocks the blend took to re-settle.
// Measured on the pre-fix tree: a 1-token gift onto a 1,000,000 ripe pile
// blocked the push for 2 BLOCKS; onto a 4,000 pile, 303 blocks; 100 tokens onto
// 4,000, 29,503 blocks. After the fix every one of those is 1,209,600 blocks.
//
// WHAT DID NOT CHANGE IS THE ONLY THING THAT WAS EVER GUARANTEED: the DoS
// backstop still opens at open+ExitTaxDecayBlocks, so market CLOSE and the
// creator's re-registration are bounded exactly where EXITTAX-DOS-1 bounded
// them. What got cheaper is reaching that bound: one dust token instead of a
// gift every few blocks. What got safer is the holder: a green cohort means
// they genuinely still owe tax on part of the position, and EXITTAX-1 says such
// a holder must not be force-exited by a stranger. This test PINS the bound so
// a future change cannot quietly push it past the backstop.
func TestRHFix_B6_DustGiftGriefBoundedAtTheBackstop(t *testing.T) {
	for _, pile := range []int64{4_000, 1_000_000} {
		for _, dust := range []int64{1, 100} {
			c := "alice"
			t0 := uint64(2_000_000)
			t1 := t0 + ExitTaxDecayBlocks
			s := NewMemStore()
			pfMarket(t, s, c, t1)
			pfBuy(t, s, "victim", c, t0, pile)
			pfBuy(t, s, "griefer", c, t1, dust)
			if err := Retire(s, c, c, t1); err != nil {
				t.Fatalf("Retire: %v", err)
			}
			if RefundHolderTaxGateBlocked(s, c, "victim", t1) {
				t.Fatalf("pile=%d: the victim's ripe pile was not pushable before the gift", pile)
			}
			if err := TransferCredits(s, "griefer", c, "griefer", "victim", t1, big.NewInt(dust)); err != nil {
				t.Fatalf("gift: %v", err)
			}
			lo, hi := uint64(0), ExitTaxDecayBlocks+10
			for lo < hi {
				mid := (lo + hi) / 2
				if RefundHolderTaxGateBlocked(s, c, "victim", t1+mid) {
					lo = mid + 1
				} else {
					hi = mid
				}
			}
			t.Logf("pile=%8d dust=%3d: push blocked for %d blocks, backstop at %d",
				pile, dust, lo, ExitTaxDecayBlocks)
			if lo > ExitTaxDecayBlocks {
				t.Fatalf("pile=%d dust=%d: the gift delayed the push PAST the backstop (%d > %d)",
					pile, dust, lo, ExitTaxDecayBlocks)
			}
			// and the victim's own exit was never blocked
			if _, err := Refund(s, "victim", c, t1, totalBalance(s, c, "victim")); err != nil {
				t.Fatalf("victim's own Refund was blocked by the gift: %v", err)
			}
		}
	}
}
