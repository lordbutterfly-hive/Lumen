package core

// zz_fix_xferlaunder_test.go — the verification suite for the COHORT-FAITHFUL
// TRANSFER fix (2026-09-08): the transfer-hop launder (PRICE-1 / X3 finding 1),
// the graduation launder (finding 2) and the blend-floor over-charge (finding 3).
//
// Every assertion here is a MEASUREMENT, not a restatement of the code.

import (
	"fmt"
	"math/big"
	"math/rand"
	"testing"
)

// ---------------------------------------------------------------------------
// THE INSTRUMENT. Once the cohort ledger is the source of truth for maturity,
// the honest place to measure conservation is the LEDGER, not the blended clock
// (which is a lossy projection that goes stale the moment a freshest-first debit
// removes tokens it still counts). These two helpers are that instrument.
// ---------------------------------------------------------------------------

// xlWeight is Σ count·min(block − acq, Dt) over a holder's maturing cohorts —
// the capped age-weight ledger property P2 asserts a transfer may MOVE but never
// MANUFACTURE.
func xlWeight(s Store, c, h string, block uint64) *big.Int {
	w := mZero()
	for _, l := range getLotsRaw(s, c, h) {
		var age uint64
		if l.acq != 0 && l.acq < block {
			age = block - l.acq
			if age > ExitTaxDecayBlocks {
				age = ExitTaxDecayBlocks
			}
		}
		w = mAdd(w, new(big.Int).Mul(l.count, new(big.Int).SetUint64(age)))
	}
	return w
}

// xlCapacity is Σ count·lotRateAt(acq, block) — the tax the ledger says the
// position owes per unit of price, in token·bps. A transfer must not DESTROY it
// (P3: self-custody is free) and must not manufacture a discount.
func xlCapacity(s Store, c, h string, block uint64) *big.Int {
	cap := mZero()
	for _, l := range getLotsRaw(s, c, h) {
		cap = mAdd(cap, new(big.Int).Mul(l.count, new(big.Int).SetUint64(lotRateAt(l.acq, block))))
	}
	return cap
}

func xlSumOver(s Store, c string, hs []string, block uint64, f func(Store, string, string, uint64) *big.Int) *big.Int {
	t := mZero()
	for _, h := range hs {
		t = mAdd(t, f(s, c, h, block))
	}
	return t
}

// ---------------------------------------------------------------------------
//  1. CONSERVATION ON THE LEDGER — transfers move maturity, never mint it, and
//     (absent a MaxLots merge) never destroy it either.
//
// ---------------------------------------------------------------------------
func TestXL_TransferConservesLedgerWeightAndCapacity(t *testing.T) {
	r := rand.New(rand.NewSource(0x5EED01))
	const c = "xlcons"
	holders := []string{"a", "b", "c", "d", "e"}
	exactCapacity, merged := 0, 0

	for iter := 0; iter < 2000; iter++ {
		s := NewMemStore()
		start := uint64(7 * ExitTaxDecayBlocks)
		pfMarket(t, s, c, start+9*ExitTaxDecayBlocks)
		for _, h := range holders {
			n := big.NewInt(r.Int63n(50_000) + 1)
			blk := start - uint64(r.Int63n(int64(3*ExitTaxDecayBlocks)))
			if _, err := Buy(s, h, c, blk, n); err != nil {
				t.Fatalf("iter %d seed buy: %v", iter, err)
			}
		}
		block := start + uint64(r.Int63n(int64(ExitTaxDecayBlocks)))
		for hop := 0; hop < 8; hop++ {
			from, to := holders[r.Intn(len(holders))], holders[r.Intn(len(holders))]
			if from == to {
				continue
			}
			bal := getMoney(s, kBal(c, from))
			if bal.Sign() == 0 {
				continue
			}
			amt := new(big.Int).Add(big.NewInt(1), new(big.Int).Rand(r, bal))

			wBefore := xlSumOver(s, c, holders, block, xlWeight)
			capBefore := xlSumOver(s, c, holders, block, xlCapacity)
			nLots := 0
			for _, h := range holders {
				nLots += len(getLotsRaw(s, c, h))
			}
			if err := TransferCredits(s, from, c, from, to, block, amt); err != nil {
				t.Fatalf("iter %d hop %d: %v", iter, hop, err)
			}
			wAfter := xlSumOver(s, c, holders, block, xlWeight)
			capAfter := xlSumOver(s, c, holders, block, xlCapacity)

			// P2 — maturity is never MANUFACTURED. Strict, no tolerance: a
			// cohort moves verbatim, and the only transforms applied to it
			// (capAcqAge, boundLots' merge-at-the-younger-acq) both RAISE acq,
			// i.e. REDUCE age.
			if wAfter.Cmp(wBefore) > 0 {
				t.Fatalf("iter %d hop %d: LEDGER AGE-WEIGHT MANUFACTURED %s -> %s", iter, hop, wBefore, wAfter)
			}
			// P3 — maturity is never DESTROYED either, except by a MaxLots merge
			// (which raises capacity, the treasury's direction, and cannot happen
			// below the cap).
			if capAfter.Cmp(capBefore) < 0 {
				t.Fatalf("iter %d hop %d: LEDGER TAX CAPACITY DESTROYED %s -> %s (self-custody must be free)",
					iter, hop, capBefore, capAfter)
			}
			if capAfter.Cmp(capBefore) == 0 {
				exactCapacity++
			} else {
				merged++
			}
			// Σ lots == kBal for every holder, always.
			for _, h := range holders {
				sum := mZero()
				for _, l := range getLotsRaw(s, c, h) {
					sum = mAdd(sum, l.count)
				}
				if lots := getLotsRaw(s, c, h); len(lots) > 0 && sum.Cmp(getMoney(s, kBal(c, h))) != 0 {
					t.Fatalf("iter %d hop %d: Σlots %s != kBal %s for %s", iter, hop, sum, getMoney(s, kBal(c, h)), h)
				} else if len(lots) > MaxLots {
					t.Fatalf("iter %d hop %d: %d cohorts > MaxLots", iter, hop, len(lots))
				}
			}
		}
	}
	if exactCapacity < 1000 {
		t.Fatalf("VACUOUS: only %d exact-capacity transfers observed", exactCapacity)
	}
	t.Logf("transfers measured: %d capacity-EXACT, %d raised by a MaxLots merge (never lowered)", exactCapacity, merged)
}

// ---------------------------------------------------------------------------
// 2. THE LAUNDER IS CLOSED AT EVERY HOP COUNT, ON BOTH RAILS.
// ---------------------------------------------------------------------------
func TestXL_LaunderClosedAtEveryHopCount(t *testing.T) {
	const c = "alice"
	const N, M = int64(4_000_000), int64(40_000)
	t0 := uint64(2_000_000)
	t1 := t0 + ExitTaxDecayBlocks

	run := func(hops int) (*big.Int, uint64) {
		s := NewMemStore()
		pfMarket(t, s, c, t1+10)
		pfBuy(t, s, "whale", c, t0, N)
		pfBuy(t, s, "alt", c, t1, M)
		holder := "alt"
		if hops > 0 {
			// hop 1 is always INTO the aged pile — that is the launder's premise.
			if err := TransferCredits(s, "alt", c, "alt", "whale", t1, big.NewInt(M)); err != nil {
				t.Fatal(err)
			}
			holder = "whale"
			for i := 1; i < hops; i++ {
				next := fmt.Sprintf("mule%d", i)
				if err := TransferCredits(s, holder, c, holder, next, t1, big.NewInt(M)); err != nil {
					t.Fatal(err)
				}
				holder = next
			}
		}
		q, err := QuoteSell(s, holder, c, t1, big.NewInt(M))
		if err != nil {
			t.Fatal(err)
		}
		return q.Tax, q.TaxBps
	}
	honest, _ := run(0)
	for _, hops := range []int{1, 2, 3, 5, 10, 25} {
		got, bps := run(hops)
		if got.Cmp(honest) < 0 {
			t.Errorf("LAUNDER OPEN at %d hops: tax %s < honest %s (%d bps)", hops, got, honest, bps)
		}
		t.Logf("%2d hop(s): tax=%s (honest %s)", hops, got, honest)
	}
}

func TestXL_LaunderClosedOnRefundRailMultiHop(t *testing.T) {
	const c = "alice"
	const N, M = int64(400_000), int64(4_000)
	t0 := uint64(2_000_000)
	t1 := t0 + ExitTaxDecayBlocks

	taxOf := func(hops int) *big.Int {
		s := NewMemStore()
		pfMarket(t, s, c, t1+10)
		pfBuy(t, s, "whale", c, t0, N)
		pfBuy(t, s, "alt", c, t1, M)
		holder := "alt"
		if hops > 0 {
			if err := TransferCredits(s, "alt", c, "alt", "whale", t1, big.NewInt(M)); err != nil {
				t.Fatal(err)
			}
			holder = "whale"
			for i := 1; i < hops; i++ {
				next := fmt.Sprintf("mule%d", i)
				if err := TransferCredits(s, holder, c, holder, next, t1, big.NewInt(M)); err != nil {
					t.Fatal(err)
				}
				holder = next
			}
		}
		if err := Retire(s, c, c, t1); err != nil {
			t.Fatal(err)
		}
		gross := refundPayout(getMoney(s, kReserve(c)), big.NewInt(M), getMoney(s, kSupply(c)))
		net, err := Refund(s, holder, c, t1, big.NewInt(M), nil)
		if err != nil {
			t.Fatal(err)
		}
		return new(big.Int).Sub(gross, net)
	}
	honest := taxOf(0)
	for _, hops := range []int{1, 2, 4, 8} {
		got := taxOf(hops)
		if got.Cmp(honest) < 0 {
			t.Errorf("REFUND LAUNDER OPEN at %d hops: %s < honest %s", hops, got, honest)
		}
		t.Logf("refund %d hop(s): tax=%s (honest %s)", hops, got, honest)
	}
}

// The X3 shape with the pile SPLIT across many cohorts, and the mule receiving
// through an account that already holds an aged pile of its own.
func TestXL_LaunderClosedThroughAnAlreadyAgedMule(t *testing.T) {
	const c = "alice"
	t0 := uint64(2_000_000)
	t1 := t0 + ExitTaxDecayBlocks
	s := NewMemStore()
	pfMarket(t, s, c, t1+10)
	pfBuy(t, s, "whale", c, t0, 1_000_000)
	pfBuy(t, s, "mule", c, t0+7, 1_000_000) // the mule is aged too
	pfBuy(t, s, "alt", c, t1, 50_000)

	ctl := hzCloneStore(s)
	qCtl, err := QuoteSell(ctl, "alt", c, t1, big.NewInt(50_000))
	if err != nil {
		t.Fatal(err)
	}
	if err := TransferCredits(s, "alt", c, "alt", "whale", t1, big.NewInt(50_000)); err != nil {
		t.Fatal(err)
	}
	if err := TransferCredits(s, "whale", c, "whale", "mule", t1, big.NewInt(50_000)); err != nil {
		t.Fatal(err)
	}
	q, err := QuoteSell(s, "mule", c, t1, big.NewInt(50_000))
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("through an aged mule: control tax=%s washed tax=%s", qCtl.Tax, q.Tax)
	if q.Tax.Cmp(qCtl.Tax) < 0 {
		t.Errorf("LAUNDER OPEN through an aged mule: %s < %s", q.Tax, qCtl.Tax)
	}
}

// ---------------------------------------------------------------------------
//  3. GRADUATION — a heterogeneous position must not graduate its GREEN cohorts,
//     must not have them cleared, and must still bank its RIPE ones (no grief).
//
// ---------------------------------------------------------------------------
func TestXL_GraduateNeverClearsAGreenCohort(t *testing.T) {
	const c = "alice"
	t0 := uint64(3_000_000)
	t1 := t0 + ExitTaxDecayBlocks
	for _, N := range []int64{4000, 42000, 100_000, 1_000_000} {
		s := NewMemStore()
		pfMarket(t, s, c, t1+3*ExitTaxDecayBlocks)
		pfBuy(t, s, "whale", c, t0, N)
		pfBuy(t, s, "alt", c, t1, 1000)
		if err := TransferCredits(s, "alt", c, "alt", "whale", t1, big.NewInt(1000)); err != nil {
			t.Fatal(err)
		}
		// The block at which the BLENDED clock first reads "matured".
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
		qB, _ := QuoteSell(s, "whale", c, gb, big.NewInt(1000))
		moved := Graduate(s, c, "whale", gb)
		qA, _ := QuoteSell(s, "whale", c, gb, big.NewInt(1000))
		if qA.Tax.Cmp(qB.Tax) < 0 {
			t.Errorf("N=%d: Graduate destroyed %s of owed tax", N, new(big.Int).Sub(qB.Tax, qA.Tax))
		}
		// The ripe pile DID bank (no grief), and the green cohort survived.
		if moved.Cmp(big.NewInt(N)) != 0 {
			t.Errorf("N=%d: graduated %s, want the whole ripe pile %d", N, moved, N)
		}
		lots := getLotsRaw(s, c, "whale")
		if len(lots) != 1 || lots[0].count.Cmp(big.NewInt(1000)) != 0 {
			t.Errorf("N=%d: green cohort not preserved: %v", N, zbLotsRate(s, c, "whale", gb))
		}
		if lotRateAt(lots[0].acq, gb) == 0 {
			t.Errorf("N=%d: the surviving cohort reads rate 0 — it was re-aged", N)
		}
		if got := getMatured(s, c, "whale"); got.Cmp(big.NewInt(N)) != 0 {
			t.Errorf("N=%d: matured bucket %s, want %d", N, got, N)
		}
		if got := getMoney(s, kBal(c, "whale")); got.Cmp(big.NewInt(1000)) != 0 {
			t.Errorf("N=%d: maturing bucket %s, want 1000", N, got)
		}
		t.Logf("N=%7d: graduated %s ripe, kept 1000 green at %d bps, tax %s -> %s",
			N, moved, lotRateAt(lots[0].acq, gb), qB.Tax, qA.Tax)
	}
}

// Graduation is IDEMPOTENT and eventually completes: once the green cohort ages
// out it graduates too, and Σ balances is preserved at every step.
func TestXL_PartialGraduationEventuallyCompletes(t *testing.T) {
	const c = "alice"
	t0 := uint64(3_000_000)
	t1 := t0 + ExitTaxDecayBlocks
	s := NewMemStore()
	pfMarket(t, s, c, t1+4*ExitTaxDecayBlocks)
	pfBuy(t, s, "whale", c, t0, 100_000)
	pfBuy(t, s, "alt", c, t1, 1000)
	if err := TransferCredits(s, "alt", c, "alt", "whale", t1, big.NewInt(1000)); err != nil {
		t.Fatal(err)
	}
	total := big.NewInt(101_000)
	for _, blk := range []uint64{t1 + 20_000, t1 + 200_000, t1 + ExitTaxDecayBlocks - 1, t1 + ExitTaxDecayBlocks, t1 + 2*ExitTaxDecayBlocks} {
		Graduate(s, c, "whale", blk)
		Graduate(s, c, "whale", blk) // idempotent
		got := totalBalance(s, c, "whale")
		if got.Cmp(total) != 0 {
			t.Fatalf("blk=%d: totalBalance %s != %s", blk, got, total)
		}
		sum := mZero()
		for _, l := range getLotsRaw(s, c, "whale") {
			sum = mAdd(sum, l.count)
		}
		if lots := getLotsRaw(s, c, "whale"); len(lots) > 0 && sum.Cmp(getMoney(s, kBal(c, "whale"))) != 0 {
			t.Fatalf("blk=%d: Σlots %s != kBal %s", blk, sum, getMoney(s, kBal(c, "whale")))
		}
		if _, ok := s.Get(kLots(c, "whale")); ok && getMoney(s, kBal(c, "whale")).Sign() == 0 {
			t.Fatalf("blk=%d: ORPHAN lots| key with kBal == 0", blk)
		}
		t.Logf("blk=+%7d: maturing=%s matured=%s lots=%v", blk-t1,
			getMoney(s, kBal(c, "whale")), getMatured(s, c, "whale"), zbLotsRate(s, c, "whale", blk))
	}
	if got := getMoney(s, kBal(c, "whale")); got.Sign() != 0 {
		t.Fatalf("a full window past the last cohort the position must be fully graduated, maturing=%s", got)
	}
	if got := getMatured(s, c, "whale"); got.Cmp(total) != 0 {
		t.Fatalf("matured %s != %s", got, total)
	}
}

// ---------------------------------------------------------------------------
//  4. F-C1 GRIEF — the poisoned gift, measured in base units against the
//     PRE-FIX tree's own numbers.
//
// ---------------------------------------------------------------------------
func TestXL_DustGiftGriefMeasured(t *testing.T) {
	const c = "alice"
	t0 := uint64(2_000_000)
	t1 := t0 + ExitTaxDecayBlocks
	fmt.Println("  victim N | gift | clean tax | post-gift tax | grief | grief/gross")
	for _, N := range []int64{4000, 100_000, 1_000_000} {
		for _, g := range []int64{1, 100} {
			s := NewMemStore()
			pfMarket(t, s, c, t1+10)
			pfBuy(t, s, "victim", c, t0, N)
			pfBuy(t, s, "att", c, t1, g)
			qClean, err := QuoteSell(s, "victim", c, t1, big.NewInt(N))
			if err != nil {
				t.Fatal(err)
			}
			if err := TransferCredits(s, "att", c, "att", "victim", t1, big.NewInt(g)); err != nil {
				t.Fatal(err)
			}
			qDust, err := QuoteSell(s, "victim", c, t1, big.NewInt(N+g))
			if err != nil {
				t.Fatal(err)
			}
			grief := new(big.Int).Sub(qDust.Tax, qClean.Tax)
			// The gift's OWN full-rate value on the dear top slice is the honest
			// ceiling: the victim can never be charged more than what the gifted
			// tokens themselves owe.
			slice, err := SellProceeds(getMoney(s, kSupply(c)), big.NewInt(g))
			if err != nil {
				t.Fatal(err)
			}
			ceiling := ExitTaxOn(slice, MaxExitTaxBps)
			fmt.Printf("  %8d | %4d | %9s | %13s | %6s | %s\n", N, g, qClean.Tax, qDust.Tax, grief, qDust.Gross)
			if grief.Cmp(ceiling) > 0 {
				t.Errorf("N=%d g=%d: grief %s exceeds the gift's own full-rate value %s", N, g, grief, ceiling)
			}
		}
	}
}

// The attacker must never PROFIT from the gift, measured in money on the one
// account that shares the tax (the creator: accrueExitTax pays them half).
func TestXL_GiftGriefStillUnprofitable(t *testing.T) {
	r := rand.New(rand.NewSource(0x9F1F7))
	const c = "xlgrief"
	worstNum, worstDen := big.NewInt(0), big.NewInt(1)
	for i := 0; i < 400; i++ {
		V := big.NewInt(r.Int63n(50_000) + 1000)
		g := big.NewInt(r.Int63n(2_000) + 1)
		build := func() (*MemStore, uint64) {
			s := NewMemStore()
			pfMarket(t, s, c, 5_000_000+3*ExitTaxDecayBlocks)
			if _, err := Buy(s, "victim", c, 5_000_000, V); err != nil {
				t.Fatal(err)
			}
			sellBlock := 5_000_000 + ExitTaxDecayBlocks + 1
			if _, err := Buy(s, c, c, sellBlock, g); err != nil {
				t.Fatal(err)
			}
			return s, sellBlock
		}
		sA, blkA := build()
		srA, err := Sell(sA, "victim", c, blkA, V)
		if err != nil {
			t.Fatal(err)
		}
		sB, blkB := build()
		donation, err := SellProceeds(getMoney(sB, kSupply(c)), g)
		if err != nil {
			t.Fatal(err)
		}
		if err := TransferCredits(sB, c, c, c, "victim", blkB, g); err != nil {
			t.Fatal(err)
		}
		srB, err := Sell(sB, "victim", c, blkB, new(big.Int).Add(V, g))
		if err != nil {
			t.Fatal(err)
		}
		extra := new(big.Int).Sub(srB.Tax, srA.Tax)
		if extra.Sign() < 0 {
			extra.SetInt64(0)
		}
		gain := new(big.Int).Div(extra, big.NewInt(2)) // the creator's half
		if gain.Cmp(donation) >= 0 {
			t.Fatalf("RE-AGING PAYS (iter %d): donated %s worth %s, collected %s", i, g, donation, gain)
		}
		if new(big.Int).Mul(gain, worstDen).Cmp(new(big.Int).Mul(worstNum, donation)) > 0 {
			worstNum, worstDen = gain, donation
		}
	}
	pct := new(big.Int).Mul(worstNum, big.NewInt(100))
	if worstDen.Sign() > 0 {
		pct.Div(pct, worstDen)
	}
	t.Logf("worst observed: the griefer recovers %s%% of the donated tokens' curve value", pct)
}

// ---------------------------------------------------------------------------
//  5. THE SELL RAIL NEVER UNDER-CHARGES — the exact replacement for the removed
//     max(blend, cohort) floor. The tax is sandwiched, EXACTLY, between the
//     OLDEST and the FRESHEST drawn cohort's rate applied to the whole taxable
//     base. The lower arm is the anti-launder statement; the upper arm is the
//     anti-over-charge statement the blend floor used to violate.
//
// ---------------------------------------------------------------------------
func TestXL_SellTaxSandwichedByCohortRates(t *testing.T) {
	r := rand.New(rand.NewSource(0x5A9D))
	const c = "xlsand"
	holders := []string{"h1", "h2", "h3"}
	checked := 0
	for iter := 0; iter < 400; iter++ {
		s := NewMemStore()
		blk := uint64(3_000_000)
		pfMarket(t, s, c, blk+40*ExitTaxDecayBlocks)
		for step := 0; step < 40; step++ {
			blk += uint64(1 + r.Intn(200_000))
			h := holders[r.Intn(len(holders))]
			switch r.Intn(4) {
			case 0:
				if _, err := Buy(s, h, c, blk, big.NewInt(int64(1+r.Intn(5000)))); err != nil {
					continue
				}
			case 1:
				to := holders[r.Intn(len(holders))]
				if to == h {
					continue
				}
				bal := totalBalance(s, c, h)
				if bal.Sign() == 0 {
					continue
				}
				n := big.NewInt(int64(1 + r.Intn(3000)))
				if n.Cmp(bal) > 0 {
					n.Set(bal)
				}
				_ = TransferCredits(s, h, c, h, to, blk, n)
			case 2:
				Graduate(s, c, h, blk)
			case 3:
				bal := totalBalance(s, c, h)
				if bal.Sign() == 0 {
					continue
				}
				n := big.NewInt(int64(1 + r.Intn(3000)))
				if n.Cmp(bal) > 0 {
					n.Set(bal)
				}
				supply := getMoney(s, kSupply(c))
				_, fm := splitDraw(s, c, h, n)
				drawn := lotsDrawFreshest(s, c, h, fm)
				sr, err := Sell(s, h, c, blk, n)
				if err != nil {
					continue
				}
				if fm.Sign() == 0 {
					if sr.Tax.Sign() != 0 {
						t.Fatalf("a wholly MATURED draw was taxed %s", sr.Tax)
					}
					continue
				}
				base, err := SellProceeds(supply, fm)
				if err != nil {
					t.Fatal(err)
				}
				var lo, hi uint64 = MaxExitTaxBps, 0
				for _, l := range drawn {
					rr := lotRateAt(l.acq, blk)
					if rr < lo {
						lo = rr
					}
					if rr > hi {
						hi = rr
					}
				}
				if sr.Tax.Cmp(ExitTaxOn(base, lo)) < 0 {
					t.Fatalf("UNDER-CHARGE: tax %s < the OLDEST drawn cohort's rate %d on the whole base %s",
						sr.Tax, lo, ExitTaxOn(base, lo))
				}
				ceil := mAdd(ExitTaxOn(base, hi), big.NewInt(int64(len(drawn))))
				if sr.Tax.Cmp(ceil) > 0 {
					t.Fatalf("OVER-CHARGE: tax %s > the FRESHEST drawn cohort's rate %d on the whole base + ceil padding %s",
						sr.Tax, hi, ceil)
				}
				if sr.Tax.Cmp(base) > 0 {
					t.Fatalf("tax %s exceeds the maturing base %s", sr.Tax, base)
				}
				sum := mAdd(mAdd(sr.Net, sr.Tax), sr.Fee)
				if sum.Cmp(sr.Gross) != 0 {
					t.Fatalf("net+tax+fee != gross")
				}
				checked++
			}
			if got, want := getMoney(s, kReserve(c)), Area(getMoney(s, kSupply(c))); got.Cmp(want) != 0 {
				t.Fatalf("R %s != Area(S) %s", got, want)
			}
		}
	}
	if checked < 500 {
		t.Fatalf("VACUOUS: only %d taxed sales measured", checked)
	}
	t.Logf("%d taxed sales sandwiched between the oldest and freshest drawn cohort rate", checked)
}

// A HOMOGENEOUS position is byte-identical to the blend — the K1 single-rate
// identity, still exact, on the path every ordinary holder takes.
func TestXL_HomogeneousStillExactSingleRate(t *testing.T) {
	const c = "xlhomo"
	t0 := uint64(2_000_000)
	for _, age := range []uint64{0, 1, 1000, ExitTaxDecayBlocks / 2, ExitTaxDecayBlocks - 1, ExitTaxDecayBlocks, 3 * ExitTaxDecayBlocks} {
		s := NewMemStore()
		pfMarket(t, s, c, t0+10*ExitTaxDecayBlocks)
		pfBuy(t, s, "h", c, t0, 5000)
		blk := t0 + age
		r, err := Sell(s, "h", c, blk, big.NewInt(2500))
		if err != nil {
			t.Fatal(err)
		}
		if want := ExitTaxOn(r.TaxableGross, r.TaxBps); r.Tax.Cmp(want) != 0 {
			t.Errorf("age=%d: K1 identity broken: tax %s != ExitTaxOn(%s, %d)=%s", age, r.Tax, r.TaxableGross, r.TaxBps, want)
		}
	}
}
