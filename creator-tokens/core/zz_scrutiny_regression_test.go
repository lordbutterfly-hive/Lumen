package core

// SCRUTINY-FINAL-poc_test.go — decorrelated scrutiny PoCs, 2026-09-08.
// Drop into core/ of the ct-final tree and run:
//   go test ./core/ -run TestSCRUT -v
// Helpers reused from the tree's own fixtures: pfMarket, pfBuy (zz_pricefix_repro_test.go),
// zbLotsRate (zz_bound_launder_test.go), hzCloneStore (harness_test.go).

import (
	"fmt"
	"math/big"
	"math/rand"
	"testing"
)

// ---------------------------------------------------------------------------
// FINDING 1 — TRANSFER-OUT LAUNDER (PRICE-1 / X3 NOT CLOSED).
// transfer.go:175 reads the sender's SINGLE BLENDED clock and holdclock.go:375
// stamps it on the recipient's new cohort, so one extra hop converts a
// heterogeneous (aged+fresh) ledger into a single homogeneous cohort at the
// DILUTED blended rate. Same block. No waiting.
// ---------------------------------------------------------------------------
func TestSCRUT_A_TransferOutLaunder(t *testing.T) {
	const c = "alice"
	const N, M = int64(4000), int64(400)
	t0 := uint64(2_000_000)
	t1 := t0 + ExitTaxDecayBlocks

	s := NewMemStore()
	pfMarket(t, s, c, t1+10)
	pfBuy(t, s, "whale", c, t0, N) // aged, matured-but-never-graduated
	pfBuy(t, s, "alt", c, t1, M)   // fresh

	ctl := hzCloneStore(s)
	qCtl, err := QuoteSell(ctl, "alt", c, t1, big.NewInt(M))
	if err != nil {
		t.Fatal(err)
	}
	if err := TransferCredits(s, "alt", c, "alt", "whale", t1, big.NewInt(M)); err != nil {
		t.Fatal(err)
	}
	if err := TransferCredits(s, "whale", c, "whale", "mule", t1, big.NewInt(M)); err != nil {
		t.Fatal(err)
	}
	t.Logf("mule ledger after wash: %v", zbLotsRate(s, c, "mule", t1))
	qWash, err := QuoteSell(s, "mule", c, t1, big.NewInt(M))
	if err != nil {
		t.Fatal(err)
	}
	avoided := new(big.Int).Sub(qCtl.Tax, qWash.Tax)
	t.Logf("CONTROL tax=%s (%d bps)  WASHED tax=%s (%d bps)  AVOIDED=%s (%.2f%%)",
		qCtl.Tax, qCtl.TaxBps, qWash.Tax, qWash.TaxBps, avoided,
		100*float64(avoided.Int64())/float64(qCtl.Tax.Int64()))
	if avoided.Sign() > 0 {
		t.Errorf("LAUNDER OPEN: two transfers cut the exit tax by %s", avoided)
	}
}

func TestSCRUT_A2_TransferOutLaunder_Executed(t *testing.T) {
	const c = "alice"
	const M = int64(400)
	t0 := uint64(2_000_000)
	t1 := t0 + ExitTaxDecayBlocks
	run := func(N int64, wash bool) (*big.Int, *big.Int, uint64) {
		s := NewMemStore()
		pfMarket(t, s, c, t1+10)
		pfBuy(t, s, "whale", c, t0, N)
		pfBuy(t, s, "alt", c, t1, M)
		seller := "alt"
		if wash {
			if err := TransferCredits(s, "alt", c, "alt", "whale", t1, big.NewInt(M)); err != nil {
				t.Fatal(err)
			}
			if err := TransferCredits(s, "whale", c, "whale", "mule", t1, big.NewInt(M)); err != nil {
				t.Fatal(err)
			}
			seller = "mule"
		}
		r, err := Sell(s, seller, c, t1, big.NewInt(M), nil)
		if err != nil {
			t.Fatal(err)
		}
		return r.Tax, r.Net, r.TaxBps
	}
	fmt.Println("  pile N | honest tax | washed tax | avoided | % avoided | bps")
	for _, N := range []int64{4000, 40000, 400000, 4000000} {
		hTax, _, hBps := run(N, false)
		wTax, _, wBps := run(N, true)
		av := new(big.Int).Sub(hTax, wTax)
		fmt.Printf("  %7d | %10s | %10s | %10s | %8.2f%% | %d -> %d\n", N, hTax, wTax, av,
			100*float64(av.Int64())/float64(hTax.Int64()), hBps, wBps)
		if av.Sign() > 0 {
			t.Errorf("N=%d: %s base units avoided in ONE block", N, av)
		}
	}
}

func TestSCRUT_A3_TransferOutLaunder_RefundRail(t *testing.T) {
	const c = "alice"
	const N, M = int64(4000), int64(400)
	t0 := uint64(2_000_000)
	t1 := t0 + ExitTaxDecayBlocks
	build := func(wash bool) (*MemStore, string) {
		s := NewMemStore()
		pfMarket(t, s, c, t1+10)
		pfBuy(t, s, "whale", c, t0, N)
		pfBuy(t, s, "alt", c, t1, M)
		holder := "alt"
		if wash {
			if err := TransferCredits(s, "alt", c, "alt", "whale", t1, big.NewInt(M)); err != nil {
				t.Fatal(err)
			}
			if err := TransferCredits(s, "whale", c, "whale", "mule", t1, big.NewInt(M)); err != nil {
				t.Fatal(err)
			}
			holder = "mule"
		}
		if err := Retire(s, c, c, t1); err != nil {
			t.Fatal(err)
		}
		return s, holder
	}
	taxOf := func(wash bool) *big.Int {
		s, holder := build(wash)
		gross := refundPayout(getMoney(s, kReserve(c)), big.NewInt(M), getMoney(s, kSupply(c)))
		net, err := Refund(s, holder, c, t1, big.NewInt(M), nil)
		if err != nil {
			t.Fatal(err)
		}
		return new(big.Int).Sub(gross, net)
	}
	honest, washed := taxOf(false), taxOf(true)
	av := new(big.Int).Sub(honest, washed)
	t.Logf("REFUND rail: honest=%s washed=%s AVOIDED=%s (%.2f%%)", honest, washed, av,
		100*float64(av.Int64())/float64(honest.Int64()))
	if av.Sign() > 0 {
		t.Errorf("X3 LAUNDER RE-OPENED via transfer-out: %s avoided", av)
	}
}

// The shelter is REUSABLE: 30 consecutive daily washes, rate pinned at 35 bps.
func TestSCRUT_A4_ShelterIsReusable(t *testing.T) {
	const c = "alice"
	const N, M = int64(4_200_000), int64(100_000)
	t0 := uint64(2_000_000)
	t1 := t0 + ExitTaxDecayBlocks
	s := NewMemStore()
	pfMarket(t, s, c, t1+400*BlocksPerDay)
	pfBuy(t, s, "whale", c, t0, N)
	var lastMule string
	var lastBlk uint64
	for day := 0; day < 30; day++ {
		blk := t1 + uint64(day)*BlocksPerDay
		mule, alt := fmt.Sprintf("mule%d", day), fmt.Sprintf("alt%d", day)
		if _, err := Buy(s, alt, c, blk, big.NewInt(M)); err != nil {
			t.Fatal(err)
		}
		if err := TransferCredits(s, alt, c, alt, "whale", blk, big.NewInt(M)); err != nil {
			t.Fatal(err)
		}
		if err := TransferCredits(s, "whale", c, "whale", mule, blk, big.NewInt(M)); err != nil {
			t.Fatal(err)
		}
		lastMule, lastBlk = mule, blk
	}
	q, err := QuoteSell(s, lastMule, c, lastBlk, big.NewInt(M))
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("after 30 daily washes the day-29 mule sells at %d bps (honest %d)", q.TaxBps, MaxExitTaxBps)
	if q.TaxBps*5 < MaxExitTaxBps {
		t.Errorf("SHELTER STILL LIVE: %d bps vs %d honest", q.TaxBps, MaxExitTaxBps)
	}
}

// ---------------------------------------------------------------------------
// FINDING 2 — GRADUATION LAUNDER. graduate() gates on the BLENDED clock and
// lotsClear() then deletes the ledger, on a claim (matured.go:409) that every
// cohort must be at the cap. False for a heterogeneous bucket.
// ---------------------------------------------------------------------------
func TestSCRUT_B_GraduationLaunder(t *testing.T) {
	const c = "alice"
	const M = int64(1000)
	t0 := uint64(3_000_000)
	t1 := t0 + ExitTaxDecayBlocks
	fmt.Println("  pile N | wait blocks | wait days | fresh cohort bps at grad | tax killed")
	for _, N := range []int64{4000, 42000, 100000, 1000000} {
		s := NewMemStore()
		pfMarket(t, s, c, t1+3*ExitTaxDecayBlocks)
		pfBuy(t, s, "whale", c, t0, N)
		pfBuy(t, s, "alt", c, t1, M)
		if err := TransferCredits(s, "alt", c, "alt", "whale", t1, big.NewInt(M)); err != nil {
			t.Fatal(err)
		}
		lo, hi := t1, t1+ExitTaxDecayBlocks
		for lo < hi {
			mid := (lo + hi) / 2
			if maturedNow(s, c, "whale", mid) {
				hi = mid
			} else {
				lo = mid + 1
			}
		}
		gb := lo
		freshBps := lotRateAt(getLotsRaw(s, c, "whale")[0].acq, gb)
		qB, _ := QuoteSell(s, "whale", c, gb, big.NewInt(M))
		Graduate(s, c, "whale", gb)
		qA, _ := QuoteSell(s, "whale", c, gb, big.NewInt(M))
		killed := new(big.Int).Sub(qB.Tax, qA.Tax)
		fmt.Printf("  %7d | %11d | %9.2f | %24d | %s\n", N, gb-t1, float64(gb-t1)/float64(BlocksPerDay), freshBps, killed)
		if killed.Sign() > 0 {
			t.Errorf("N=%d: Graduate killed %s of owed tax while the fresh cohort read %d bps", N, killed, freshBps)
		}
	}
}

// ---------------------------------------------------------------------------
// FINDING 3 — SELL's max(blend, cohort) OVER-CHARGES a genuinely aged holder
// after a partial FRESH exit (the case refund.go explicitly refuses to floor).
// ---------------------------------------------------------------------------
func TestSCRUT_D_SellFloorOverchargesAgedRemainder(t *testing.T) {
	const c = "alice"
	const N, M = int64(4000), int64(4000)
	t0 := uint64(2_000_000)
	t1 := t0 + ExitTaxDecayBlocks
	s := NewMemStore()
	pfMarket(t, s, c, t1+10)
	pfBuy(t, s, "whale", c, t0, N)
	pfBuy(t, s, "alt", c, t1, M)
	if err := TransferCredits(s, "alt", c, "alt", "whale", t1, big.NewInt(M)); err != nil {
		t.Fatal(err)
	}
	if _, err := Sell(s, "whale", c, t1, big.NewInt(M)); err != nil {
		t.Fatal(err)
	}
	q, err := QuoteSell(s, "whale", c, t1, big.NewInt(N))
	if err != nil {
		t.Fatal(err)
	}
	cohort, _, _, _ := maturingCohortTax(s, c, "whale", getMoney(s, kSupply(c)), big.NewInt(N), t1)
	over := new(big.Int).Sub(q.Tax, cohort)
	t.Logf("aged remainder: cohortTax=%s (owed) charged=%s gross=%s OVER-CHARGE=%s",
		cohort, q.Tax, q.Gross, over)
	if over.Sign() > 0 {
		t.Errorf("SELL FLOOR OVER-CHARGES an aged holder by %s", over)
	}
}

// ---------------------------------------------------------------------------
// REFUTED / CLEAN checks below.
// ---------------------------------------------------------------------------

func tokensBelow(lots []mLot, A uint64) *big.Int {
	sum := mZero()
	for _, l := range lots {
		if l.acq < A {
			sum = mAdd(sum, l.count)
		}
	}
	return sum
}

// boundLots acq-monotonicity as first-order stochastic dominance.
func TestSCRUT_F_BoundLotsAcqMonotone(t *testing.T) {
	rng := rand.New(rand.NewSource(99))
	for iter := 0; iter < 3000; iter++ {
		block := uint64(2_000_000 + rng.Intn(5_000_000))
		n := MaxLots + 1 + rng.Intn(40)
		lots := make([]mLot, 0, n)
		acqs := map[uint64]bool{}
		for len(lots) < n {
			var a uint64
			switch rng.Intn(4) {
			case 0:
				a = uint64(rng.Intn(int(block)))
			case 1:
				a = block - uint64(rng.Intn(int(ExitTaxDecayBlocks)+1))
			case 2:
				a = block - ExitTaxDecayBlocks - uint64(rng.Intn(1000))
			default:
				a = block - uint64(rng.Intn(50))
			}
			if acqs[a] {
				continue
			}
			acqs[a] = true
			lots = append(lots, mLot{count: big.NewInt(int64(1 + rng.Intn(1_000_000))), acq: a})
		}
		sortLotsFreshestFirst(lots)
		in := append([]mLot(nil), lots...)
		sumIn := mZero()
		for _, l := range in {
			sumIn = mAdd(sumIn, l.count)
		}
		out := boundLots(append([]mLot(nil), lots...), block)
		if len(out) > MaxLots {
			t.Fatalf("bound broken len=%d", len(out))
		}
		sumOut := mZero()
		for _, l := range out {
			sumOut = mAdd(sumOut, l.count)
		}
		if sumIn.Cmp(sumOut) != 0 {
			t.Fatalf("count not conserved %s -> %s", sumIn, sumOut)
		}
		for a := range acqs {
			for _, A := range []uint64{a, a + 1} {
				if tokensBelow(out, A).Cmp(tokensBelow(in, A)) > 0 {
					t.Fatalf("ACQ FELL at threshold %d", A)
				}
			}
		}
		for i := 1; i < len(out); i++ {
			if out[i].acq > out[i-1].acq {
				t.Fatalf("output not sorted")
			}
		}
	}
}

// Conservation: R==Area(S), net+tax+fee==gross, Sum(lots)==kBal, len<=MaxLots,
// no orphan lots| key, Sum(balances)==supply. 300 x 80 randomized ops.
func TestSCRUT_C2_ConservationFuzz(t *testing.T) {
	rng := rand.New(rand.NewSource(20260908))
	const c = "alice"
	for iter := 0; iter < 300; iter++ {
		s := NewMemStore()
		blk := uint64(2_000_000 + rng.Intn(1_000_000))
		pfMarket(t, s, c, blk+8*ExitTaxDecayBlocks)
		holders := []string{"h1", "h2", "h3", "h4"}
		for step := 0; step < 80; step++ {
			blk += uint64(1 + rng.Intn(40_000))
			h := holders[rng.Intn(len(holders))]
			switch rng.Intn(4) {
			case 0:
				if _, err := Buy(s, h, c, blk, big.NewInt(int64(1+rng.Intn(500)))); err != nil {
					continue
				}
			case 1:
				bal := totalBalance(s, c, h)
				if bal.Sign() == 0 {
					continue
				}
				n := big.NewInt(int64(1 + rng.Intn(1000)))
				if n.Cmp(bal) > 0 {
					n.Set(bal)
				}
				r, err := Sell(s, h, c, blk, n)
				if err != nil {
					continue
				}
				sum := new(big.Int).Add(r.Net, r.Tax)
				sum.Add(sum, r.Fee)
				if sum.Cmp(r.Gross) != 0 {
					t.Fatalf("net+tax+fee != gross")
				}
				if new(big.Int).Add(r.FeeCreator, r.FeePlatform).Cmp(r.Fee) != 0 {
					t.Fatalf("feeC+feeP != fee")
				}
				if r.Net.Sign() < 0 {
					t.Fatalf("negative net")
				}
			case 2:
				to := holders[rng.Intn(len(holders))]
				if to == h {
					continue
				}
				bal := totalBalance(s, c, h)
				if bal.Sign() == 0 {
					continue
				}
				n := big.NewInt(int64(1 + rng.Intn(200)))
				if n.Cmp(bal) > 0 {
					n.Set(bal)
				}
				_ = TransferCredits(s, h, c, h, to, blk, n)
			case 3:
				Graduate(s, c, h, blk)
			}
			if got, want := getMoney(s, kReserve(c)), Area(getMoney(s, kSupply(c))); got.Cmp(want) != 0 {
				t.Fatalf("R=%s != Area(S)=%s", got, want)
			}
			totSup := mZero()
			for _, hh := range holders {
				totSup = mAdd(totSup, totalBalance(s, c, hh))
				lots := getLotsRaw(s, c, hh)
				if len(lots) > MaxLots {
					t.Fatalf("len(lots)=%d > MaxLots", len(lots))
				}
				sum := mZero()
				for _, l := range lots {
					sum = mAdd(sum, l.count)
				}
				if len(lots) > 0 && sum.Cmp(getMoney(s, kBal(c, hh))) != 0 {
					t.Fatalf("Sum(lots) != kBal")
				}
				if _, ok := s.Get(kLots(c, hh)); ok && getMoney(s, kBal(c, hh)).Sign() == 0 {
					t.Fatalf("ORPHAN lots key with zero kBal")
				}
			}
			if totSup.Cmp(getMoney(s, kSupply(c))) != 0 {
				t.Fatalf("Sum(balances) != supply")
			}
		}
	}
}

// Legacy (un-ledgered) position: cohort tax == blend, every clock branch.
func TestSCRUT_G_LegacySynthesisEqualsBlend(t *testing.T) {
	const c = "alice"
	block := uint64(3_000_000)
	for _, w := range []uint64{0, 1, block - ExitTaxDecayBlocks - 5, block - ExitTaxDecayBlocks,
		block - ExitTaxDecayBlocks + 1, block - 1000, block - 1, block, block + 5} {
		s := NewMemStore()
		pfMarket(t, s, c, block+10)
		pfBuy(t, s, "seed", c, block-2*ExitTaxDecayBlocks, 5000)
		setMoney(s, kBal(c, "legacy"), big.NewInt(1000))
		setU64(s, kSupply(c), mAdd(getMoney(s, kSupply(c)), big.NewInt(1000)).Uint64())
		addMoney(s, kReserve(c), new(big.Int).Sub(Area(getMoney(s, kSupply(c))), getMoney(s, kReserve(c))))
		if w != 0 {
			setU64(s, kAcqBlock(c, "legacy"), w)
		}
		supply := getMoney(s, kSupply(c))
		fm := big.NewInt(1000)
		taxable, _ := SellProceeds(supply, fm)
		blend := ExitTaxOn(taxable, ExitTaxBpsAt(heldBlocksAt(s, c, "legacy", block)))
		cohort, ctaxable, _, err := maturingCohortTax(s, c, "legacy", supply, fm, block)
		if err != nil {
			t.Fatal(err)
		}
		if ctaxable.Cmp(taxable) != 0 || cohort.Cmp(blend) != 0 {
			t.Errorf("w=%d LEGACY DIVERGENCE: cohort=%s blend=%s", w, cohort, blend)
		}
	}
}

// Bound grief: 4000 dust gifts, victim maturity drift.
func TestSCRUT_E_BoundGriefAccumulation(t *testing.T) {
	const c = "alice"
	t0 := uint64(2_000_000)
	s := NewMemStore()
	pfMarket(t, s, c, t0+10*ExitTaxDecayBlocks)
	pfBuy(t, s, "victim", c, t0, 1_000_000)
	pfBuy(t, s, "att", c, t0+1, 300_000)
	victimAcq0 := getLotsRaw(s, c, "victim")[0].acq
	blk := t0 + 2
	for i := 0; i < 4000; i++ {
		blk += 1 + uint64(i%3)
		if err := TransferCredits(s, "att", c, "att", "victim", blk, big.NewInt(1)); err != nil {
			t.Fatal(err)
		}
	}
	var vAcq uint64
	var vCount *big.Int
	for _, l := range getLotsRaw(s, c, "victim") {
		if vCount == nil || l.count.Cmp(vCount) > 0 {
			vCount, vAcq = l.count, l.acq
		}
	}
	bps := float64(vAcq-victimAcq0) / float64(ExitTaxDecayBlocks) * float64(MaxExitTaxBps)
	t.Logf("4000 dust gifts: victim cohort acq %d -> %d (%.6f bps of maturity confiscated)", victimAcq0, vAcq, bps)
	if bps > 1.0 {
		t.Errorf("GRIEF: %.4f bps", bps)
	}
}

// Honest daily buyer (42 days) is never merged; MaxLots=64 headroom confirmed.
func TestSCRUT_M_HonestDailyBuyerNeverMerged(t *testing.T) {
	const c = "alice"
	t0 := uint64(2_000_000)
	s := NewMemStore()
	pfMarket(t, s, c, t0+10*ExitTaxDecayBlocks)
	for d := 0; d < 42; d++ {
		if _, err := Buy(s, "h", c, t0+uint64(d)*BlocksPerDay, big.NewInt(10)); err != nil {
			t.Fatal(err)
		}
	}
	if n := len(getLotsRaw(s, c, "h")); n != 42 {
		t.Errorf("honest daily buyer WAS merged: %d cohorts", n)
	}
}

// A cohort persisted with acq == 0 reads MaxExitTaxBps forever (robustness).
func TestSCRUT_K_ZeroAcqCohortNeverMatures(t *testing.T) {
	for _, held := range []uint64{0, 1, ExitTaxDecayBlocks, 10 * ExitTaxDecayBlocks} {
		if got := lotRateAt(0, 5_000_000+held); got != MaxExitTaxBps {
			t.Fatalf("acq=0 gave %d", got)
		}
	}
	s := NewMemStore()
	setMoney(s, kBal("c", "h"), big.NewInt(100)) // kBal set, kAcqBlock unset
	if err := debitBalance(s, "c", "h", big.NewInt(40)); err != nil {
		t.Fatal(err)
	}
	raw, _ := s.Get(kLots("c", "h"))
	t.Logf("persisted ledger after a debit on a clockless position: %q (permanently max-taxed)", raw)
}

// ---------------------------------------------------------------------------
// Supporting measurements cited in SCRUTINY-FINAL.md §3, §6, §8.
// ---------------------------------------------------------------------------

// §3 tail — the dust-gift grief the blend FLOOR puts back on top of the
// (already correct) cohort charge.
func TestSCRUT_J_DustGiftGriefViaBlendFloor(t *testing.T) {
	const c = "alice"
	const N = int64(4000)
	t0 := uint64(2_000_000)
	t1 := t0 + ExitTaxDecayBlocks
	s := NewMemStore()
	pfMarket(t, s, c, t1+10)
	pfBuy(t, s, "victim", c, t0, N)
	pfBuy(t, s, "att", c, t1, 1)
	qClean, err := QuoteSell(s, "victim", c, t1, big.NewInt(N))
	if err != nil {
		t.Fatal(err)
	}
	if err := TransferCredits(s, "att", c, "att", "victim", t1, big.NewInt(1)); err != nil {
		t.Fatal(err)
	}
	_, fm := splitDraw(s, c, "victim", big.NewInt(N+1))
	cohort, _, _, _ := maturingCohortTax(s, c, "victim", getMoney(s, kSupply(c)), fm, t1)
	qDusted, err := QuoteSell(s, "victim", c, t1, big.NewInt(N+1))
	if err != nil {
		t.Fatal(err)
	}
	over := new(big.Int).Sub(qDusted.Tax, cohort)
	t.Logf("pre-gift tax=%s  post-gift tax=%s  cohort owes=%s  FLOOR adds=%s",
		qClean.Tax, qDusted.Tax, cohort, over)
	if over.Sign() > 0 {
		t.Errorf("blend floor re-imposes %s of grief the ledger had priced away", over)
	}
}

// §6 — adversarial bound grief with attacker-CHOSEN cohort acqs and sizes.
func TestSCRUT_E2_AdversarialBoundGrief(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	block := uint64(5_000_000)
	worst := 0.0
	for iter := 0; iter < 4000; iter++ {
		vCount := int64(1 + rng.Intn(2_000_000))
		vAcq := block - ExitTaxDecayBlocks + uint64(rng.Intn(int(ExitTaxDecayBlocks)))
		lots := []mLot{{count: big.NewInt(vCount), acq: vAcq}}
		used := map[uint64]bool{vAcq: true}
		for len(lots) < MaxLots+1 {
			a := block - uint64(rng.Intn(int(ExitTaxDecayBlocks)+1))
			if used[a] {
				continue
			}
			used[a] = true
			var k int64
			switch rng.Intn(3) {
			case 0:
				k = 1
			case 1:
				k = int64(1 + rng.Intn(1000))
			default:
				k = vCount + int64(rng.Intn(1000))
			}
			lots = append(lots, mLot{count: big.NewInt(k), acq: a})
		}
		sortLotsFreshestFirst(lots)
		out := boundLots(append([]mLot(nil), lots...), block)
		moved := new(big.Int).Sub(tokensBelow(lots, vAcq+1), tokensBelow(out, vAcq+1))
		if moved.Sign() > 0 {
			if d := float64(moved.Int64()) / float64(vCount); d > worst {
				worst = d
			}
		}
	}
	t.Logf("worst fraction of the victim cohort pushed above its own acq in one bound step: %.6f", worst)
	if worst > 0.01 {
		t.Errorf("adversarial bound grief: %.6f", worst)
	}
}

// §8 — refund-rail cohort rounding across cohort counts that force boundLots.
func TestSCRUT_H_RefundCohortRounding(t *testing.T) {
	const c = "alice"
	t0 := uint64(2_000_000)
	for _, k := range []int{1, 2, 5, 17, 64, 65, 200} {
		s := NewMemStore()
		blk := t0
		pfMarket(t, s, c, t0+3*ExitTaxDecayBlocks)
		for i := 0; i < k; i++ {
			blk = t0 + uint64(i)*997
			if _, err := Buy(s, "h", c, blk, big.NewInt(int64(1+i%7))); err != nil {
				t.Fatal(err)
			}
		}
		if err := Retire(s, c, c, blk); err != nil {
			t.Fatal(err)
		}
		bal := getMoney(s, kBal(c, "h"))
		gross := refundPayout(getMoney(s, kReserve(c)), bal, getMoney(s, kSupply(c)))
		_, fm := splitDraw(s, c, "h", bal)
		base := maturingGrossShare(gross, fm, bal)
		tax := refundMaturingCohortTax(s, c, "h", base, fm, blk)
		if tax.Cmp(base) > 0 {
			t.Fatalf("k=%d tax=%s > base=%s", k, tax, base)
		}
		net, err := Refund(s, "h", c, blk, bal, nil)
		if err != nil {
			t.Fatalf("k=%d Refund: %v", k, err)
		}
		if net.Sign() < 0 {
			t.Fatalf("k=%d negative net", k)
		}
		if d := new(big.Int).Sub(gross, net); d.Cmp(tax) != 0 {
			t.Fatalf("k=%d gross-net=%s != tax=%s", k, d, tax)
		}
		t.Logf("k=%3d inflows: base=%s tax=%s net=%s", k, base, tax, net)
	}
}

// §8 — chunking + the smallest fee-paying trade at 500 bps.
func TestSCRUT_I_DustFeeAndTax(t *testing.T) {
	const c = "alice"
	t0 := uint64(2_000_000)
	s1 := NewMemStore()
	pfMarket(t, s1, c, t0+10)
	pfBuy(t, s1, "h", c, t0, 200)
	r1, err := Sell(s1, "h", c, t0, big.NewInt(200), nil)
	if err != nil {
		t.Fatal(err)
	}
	s2 := NewMemStore()
	pfMarket(t, s2, c, t0+10)
	pfBuy(t, s2, "h", c, t0, 200)
	feeSum, taxSum, grossSum := mZero(), mZero(), mZero()
	for i := 0; i < 200; i++ {
		r, err := Sell(s2, "h", c, t0, big.NewInt(1), nil)
		if err != nil {
			t.Fatal(err)
		}
		feeSum, taxSum, grossSum = mAdd(feeSum, r.Fee), mAdd(taxSum, r.Tax), mAdd(grossSum, r.Gross)
	}
	t.Logf("one 200-sell: gross=%s fee=%s tax=%s", r1.Gross, r1.Fee, r1.Tax)
	t.Logf("200x1-sell  : gross=%s fee=%s tax=%s", grossSum, feeSum, taxSum)
	if grossSum.Cmp(r1.Gross) != 0 {
		t.Errorf("curve path-dependence")
	}
	if taxSum.Cmp(r1.Tax) < 0 {
		t.Errorf("TAX UNDER-CHARGED BY CHUNKING: %s < %s", taxSum, r1.Tax)
	}
	t.Logf("fee lost to chunking: %s over 200 chunks", new(big.Int).Sub(r1.Fee, feeSum))
	for n := int64(1); n <= 3; n++ {
		s3 := NewMemStore()
		pfMarket(t, s3, c, t0+10)
		pfBuy(t, s3, "h", c, t0, n)
		r, err := Sell(s3, "h", c, t0, big.NewInt(n), nil)
		if err != nil {
			continue
		}
		t.Logf("sell %d token(s) at S=%d: gross=%s fee=%s tax=%s", n, n, r.Gross, r.Fee, r.Tax)
	}
}

// §8 — mMedian3 exhaustive check (the new oracle arm).
func TestSCRUT_N_Median3(t *testing.T) {
	vals := []int64{0, 1, 2, 3, 5, 100}
	for _, a := range vals {
		for _, b := range vals {
			for _, cc := range vals {
				got := mMedian3(big.NewInt(a), big.NewInt(b), big.NewInt(cc))
				s := []int64{a, b, cc}
				for i := 1; i < 3; i++ {
					for j := i; j > 0 && s[j] < s[j-1]; j-- {
						s[j], s[j-1] = s[j-1], s[j]
					}
				}
				if got.Int64() != s[1] {
					t.Fatalf("median3(%d,%d,%d)=%s want %d", a, b, cc, got, s[1])
				}
			}
		}
	}
}
