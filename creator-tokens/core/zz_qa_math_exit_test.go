package core

import (
	"math/big"
	"testing"
)

// The exit side of the owner's token-math QA (2026-09-21): does the exit tax stay
// proportional across amounts and hold times, does splitting an exit change what a
// holder pays, can the tax round to zero, and is every base unit accounted for.
// The token is a whole unit (see the purchase file), so "0.1 token" exits do not
// exist; the smallest exit is one token and the split test is N tokens at once
// against N single-token sells from the same position.

// One fresh buyer who bought `n` tokens at block 1000 on a market seeded to supply S.
func qaBuyer(t *testing.T, S, n int64) (*MemStore, string) {
	t.Helper()
	s, c := qaMarketAtSupply(t, S)
	if _, err := Buy(s, "hive:buyer", c, 1000, qaBig(n)); err != nil {
		t.Fatalf("buy: %v", err)
	}
	return s, c
}

func qaSellAt(t *testing.T, s *MemStore, c string, block uint64, n int64) *SellResult {
	t.Helper()
	r, err := Sell(s, "hive:buyer", c, block, qaBig(n))
	if err != nil {
		t.Fatalf("sell %d at %d: %v", n, block, err)
	}
	return r
}

var qaHolds = []uint64{0, 7 * BlocksPerDay, 21 * BlocksPerDay, 41 * BlocksPerDay, ExitTaxDecayBlocks, ExitTaxDecayBlocks + BlocksPerDay}

// 11.1 / 11.2 / 11.3: tax = floor(gross x rate) at every amount and every hold, and
// the rate is the same for one token as for ten. Proportionality is exact up to the
// single floor, so |tax/gross - rate| < 1 base unit / gross.
func TestQAMath_Exit_Proportional(t *testing.T) {
	qaRequireCalibration(t)
	t.Log("EXIT_TABLE_BEGIN")
	t.Log("hold\tn\tgross\trateBps\ttax\tfee\tnet\tresidual")
	for _, h := range qaHolds {
		for _, n := range []int64{1, 2, 3, 5, 10} {
			s, c := qaBuyer(t, 50, 10)
			r := qaSellAt(t, s, c, 1000+h, n)
			rate := ExitTaxBpsAt(h)
			wantTax := ExitTaxOn(r.Gross, rate)
			if r.Tax.Cmp(wantTax) != 0 {
				t.Fatalf("hold %d n %d: tax %s, want floor(%s x %d bps) = %s", h, n, r.Tax, r.Gross, rate, wantTax)
			}
			// ExitTaxOn CEILS (mMulDivCeil): the protocol gains under one base unit per
			// sell, never more, and the seller never gains from the rounding.
			exact := new(big.Int).Mul(r.Gross, qaBig(int64(rate)))
			lost := new(big.Int).Sub(new(big.Int).Mul(r.Tax, qaBig(10_000)), exact)
			if lost.Sign() < 0 || lost.Cmp(qaBig(10_000)) >= 0 {
				t.Fatalf("hold %d n %d: ceil residual %s/10000 out of [0,1)", h, n, lost)
			}
			// net + tax + fee == gross, always.
			sum := mAdd(mAdd(r.Net, r.Tax), r.Fee)
			if sum.Cmp(r.Gross) != 0 {
				t.Fatalf("hold %d n %d: net+tax+fee = %s, gross = %s", h, n, sum, r.Gross)
			}
			if mAdd(r.FeeCreator, r.FeePlatform).Cmp(r.Fee) != 0 {
				t.Fatalf("hold %d n %d: fee halves %s+%s != %s", h, n, r.FeeCreator, r.FeePlatform, r.Fee)
			}
			t.Logf("%d\t%d\t%s\t%d\t%s\t%s\t%s\t%s", h, n, r.Gross, rate, r.Tax, r.Fee, r.Net, lost)
		}
	}
	t.Log("EXIT_TABLE_END")
}

// 11.4: one sell of N tokens against N sells of one token from the same position at
// the same block. The curve is path independent (purchase file), so gross is equal;
// the tax is CEILED per sell and the fee floored per sell, so a split can only pay
// MORE tax and LESS fee, each by under one base unit per extra sell. Measured.
func TestQAMath_Exit_SplitVersusSingle(t *testing.T) {
	qaRequireCalibration(t)
	t.Log("SPLIT_TABLE_BEGIN")
	t.Log("hold\tN\tgrossOnce\tgrossSplit\ttaxOnce\ttaxSplit\tfeeOnce\tfeeSplit\tnetOnce\tnetSplit")
	for _, h := range qaHolds {
		for _, N := range []int64{2, 3, 10} {
			s1, c1 := qaBuyer(t, 50, N)
			once := qaSellAt(t, s1, c1, 1000+h, N)
			s2, c2 := qaBuyer(t, 50, N)
			gross, tax, fee, net := mZero(), mZero(), mZero(), mZero()
			for i := int64(0); i < N; i++ {
				r := qaSellAt(t, s2, c2, 1000+h, 1)
				gross, tax, fee, net = mAdd(gross, r.Gross), mAdd(tax, r.Tax), mAdd(fee, r.Fee), mAdd(net, r.Net)
			}
			if gross.Cmp(once.Gross) != 0 {
				t.Fatalf("hold %d N %d: gross differs by path: %s vs %s", h, N, once.Gross, gross)
			}
			// The split pays at most (N-1) more base units of tax (ceil per sale), and
			// its fee moves by under N base units either way: the floor per sale makes a
			// large split cheaper, the one-base-unit minimum makes a dust split dearer.
			dTax := new(big.Int).Sub(tax, once.Tax)
			dFee := new(big.Int).Abs(new(big.Int).Sub(once.Fee, fee))
			if dTax.Sign() < 0 || dTax.Cmp(qaBig(N)) >= 0 || dFee.Cmp(qaBig(N)) >= 0 {
				t.Fatalf("hold %d N %d: split moved tax by %s and fee by %s (bound is < %d base units each)", h, N, dTax, dFee, N)
			}
			// Reserve is drained by exactly gross on both paths, and both end at the same supply.
			if getMoney(s1, kReserve(c1)).Cmp(getMoney(s2, kReserve(c2))) != 0 || getMoney(s1, kSupply(c1)).Cmp(getMoney(s2, kSupply(c2))) != 0 {
				t.Fatalf("hold %d N %d: reserve/supply differ by path", h, N)
			}
			t.Logf("%d\t%d\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s", h, N, once.Gross, gross, once.Tax, tax, once.Fee, fee, once.Net, net)
		}
	}
	t.Log("SPLIT_TABLE_END")
}

// 11.4: can a single exit's tax round to ZERO while the rate is positive? ExitTaxOn
// ceils, so it cannot: any positive rate on any positive gross is at least one base
// unit. Measured across the whole decay on the smallest possible exit.
func TestQAMath_Exit_TaxFloorsToZeroOnlyAtTheTail(t *testing.T) {
	qaRequireCalibration(t)
	// The smallest possible exit: one token off a market of supply 1 (gross ~ BasePrice).
	s, c := qaBuyer(t, 0, 1)
	gross, _ := SellProceeds(qaBig(1), qaBig(1))
	firstZero := uint64(0)
	for h := uint64(0); h <= ExitTaxDecayBlocks; h += BlocksPerDay / 24 {
		rate := ExitTaxBpsAt(h)
		if rate > 0 && ExitTaxOn(gross, rate).Sign() == 0 {
			firstZero = h
			break
		}
	}
	rate0 := ExitTaxBpsAt(0)
	if ExitTaxOn(gross, rate0).Sign() == 0 {
		t.Fatalf("a fresh one-token exit (gross %s at %d bps) taxed zero", gross, rate0)
	}
	r := qaSellAt(t, s, c, 1000, 1)
	t.Logf("TAX_FLOOR\tgross=%s\tfreshRateBps=%d\tfreshTax=%s\tfirstZeroTaxHoldBlocks=%d\tofDecay=%d", gross, rate0, r.Tax, firstZero, ExitTaxDecayBlocks)
	if firstZero == 0 {
		t.Log("TAX_FLOOR\tno positive rate floors a one-token exit to zero")
	} else {
		// At that hold the whole rate is worth under one base unit of a ~1 HBD sale.
		if ExitTaxBpsAt(firstZero)*uint64(gross.Int64()) >= 10_000 {
			t.Fatalf("boundary claim wrong")
		}
	}
}

// 17 / 11.4: nothing is created or destroyed across a buy and repeated partial
// exits: reserve moves by exactly the curve amounts, and every payout is gross
// minus what was kept (tax to the accrual buckets, fee to the two halves).
func TestQAMath_Exit_Conservation(t *testing.T) {
	qaRequireCalibration(t)
	s, c := qaMarketAtSupply(t, 12)
	reserve0 := getMoney(s, kReserve(c))
	b, err := Buy(s, "hive:buyer", c, 1000, qaBig(7))
	if err != nil {
		t.Fatal(err)
	}
	reserve1 := getMoney(s, kReserve(c))
	if new(big.Int).Sub(reserve1, reserve0).Cmp(b.Cost) != 0 {
		t.Fatalf("buy moved reserve by %s, cost %s", new(big.Int).Sub(reserve1, reserve0), b.Cost)
	}
	paid, kept := mZero(), mZero()
	for _, n := range []int64{1, 2, 1, 3} {
		before := getMoney(s, kReserve(c))
		r := qaSellAt(t, s, c, 1000+3*BlocksPerDay, n)
		after := getMoney(s, kReserve(c))
		if new(big.Int).Sub(before, after).Cmp(r.Gross) != 0 {
			t.Fatalf("sell %d moved reserve by %s, gross %s", n, new(big.Int).Sub(before, after), r.Gross)
		}
		paid = mAdd(paid, r.Net)
		kept = mAdd(kept, mAdd(r.Tax, r.Fee))
	}
	if getMoney(s, kSupply(c)).Cmp(tk(12)) != 0 {
		t.Fatalf("supply %s after selling everything bought, want 12", getMoney(s, kSupply(c)))
	}
	drained := new(big.Int).Sub(reserve1, getMoney(s, kReserve(c)))
	if drained.Cmp(mAdd(paid, kept)) != 0 {
		t.Fatalf("reserve drained %s but paid %s + kept %s", drained, paid, kept)
	}
	t.Logf("CONSERVATION\tbought=%s\tdrained=%s\tpaid=%s\tkept=%s", b.Cost, drained, paid, kept)
}
