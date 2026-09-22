package core

import (
	"math/big"
	"testing"
)

// QA: purchase math at the contract level, with the exact numbers the
// frontend's budget-to-token conversion must reproduce.
//
// The frontend takes a USD budget and picks the LARGEST whole token count
// whose TotalDue fits it (contract-math.ts tokensAffordableForBudget). The
// chain never sees the budget: Buy takes a token count and charges
// BuyCost(S, n) + floor(5%). These tests pin, for the owner's budget list at
// four supplies, what that count is and what the chain charges for it, so a
// TS check can assert the same table (market/buy-preview-math.selftest.ts).
//
// Every table row is also EXECUTED through Buy on a fresh store, so the
// printed numbers are what the mutating path charges, not just what the
// quote helper returns.

func qaRequireCalibration(t *testing.T) {
	t.Helper()
	if BasePrice != 1000 || CurveLinNum != 63000 || CurveQuadNum != 21 || CurveDenom != 8000 || TradeFeeBps != 500 {
		t.Fatalf("calibration changed; recompute this file's expectations, do not skip")
	}
}

func qaBig(n int64) *big.Int { return big.NewInt(n) }

// qaMarketAtSupply registers a market and brings its supply to S through a
// seed holder, so the buyer under test sees exactly the supply the row names.
func qaMarketAtSupply(t *testing.T, S int64) (*MemStore, string) {
	t.Helper()
	const c = "hive:creator"
	s := NewMemStore()
	setStr(s, kOwner(), "hive:platform")
	if err := Register(s, c, c, 1000, 1000, 1_000_000_000*TokenScale); err != nil {
		t.Fatalf("register: %v", err)
	}
	if S > 0 {
		if _, err := Buy(s, "hive:seed", c, 1000, tk(S)); err != nil {
			t.Fatalf("seed buy: %v", err)
		}
	}
	if got := getMoney(s, kSupply(c)); got.Cmp(tk(S)) != 0 {
		t.Fatalf("supply = %s, want %d", got, S)
	}
	return s, c
}

// qaTotalDue is the quote the chain charges for n tokens at supply S.
func qaTotalDue(S, n int64) (cost, fee, total *big.Int) {
	cost = BuyCost(tk(S), tk(n)) // whole tokens, in units (v6)
	fee, _, _ = tradeFeeOn(cost)
	total = mAdd(cost, fee)
	return
}

// qaAffordable is an independent linear scan (the frontend uses a binary
// search): the largest n with TotalDue(S, n) <= budget.
func qaAffordable(S, budget int64) int64 {
	n := int64(0)
	for {
		_, _, total := qaTotalDue(S, n+1)
		if total.Cmp(qaBig(budget)) > 0 {
			return n
		}
		n++
	}
}

var qaSupplies = []int64{0, 12, 50, 1000}

// The owner's budget list, in HBD base units (1 USD == 1 HBD == 1000 units).
var qaBudgets = []int64{10_000, 10_010, 10_500, 10_990, 25_370, 500, 1_000}

func TestQAMath_Purchase_BudgetTable(t *testing.T) {
	qaRequireCalibration(t)
	t.Log("BUDGET_TABLE_BEGIN")
	t.Log("supply\tbudget\ttokens\tcost\tfee\ttotal\tremainder\tnextTotal")
	for _, S := range qaSupplies {
		for _, budget := range qaBudgets {
			n := qaAffordable(S, budget)
			cost, fee, total := qaTotalDue(S, n)
			_, _, next := qaTotalDue(S, n+1)
			remainder := new(big.Int).Sub(qaBig(budget), total)
			t.Logf("%d\t%d\t%d\t%s\t%s\t%s\t%s\t%s", S, budget, n, cost, fee, total, remainder, next)

			// Never over budget; the next token would be.
			if total.Cmp(qaBig(budget)) > 0 {
				t.Fatalf("S=%d budget=%d: total %s exceeds the budget", S, budget, total)
			}
			if next.Cmp(qaBig(budget)) <= 0 {
				t.Fatalf("S=%d budget=%d: %d tokens is not the maximum (n+1 costs %s)", S, budget, n, next)
			}
			if n == 0 {
				continue
			}
			// The mutating path charges exactly the quote.
			s, c := qaMarketAtSupply(t, S)
			reserve0 := getMoney(s, kReserve(c))
			feeC0 := getMoney(s, kFeeBal(c))
			treasury0 := getMoney(s, kTreasury())
			r, err := Buy(s, "hive:buyer", c, 2000, tk(n))
			if err != nil {
				t.Fatalf("S=%d n=%d: buy refused: %v", S, n, err)
			}
			if r.TotalDue.Cmp(total) != 0 || r.Cost.Cmp(cost) != 0 || r.Fee.Cmp(fee) != 0 {
				t.Fatalf("S=%d n=%d: Buy charged %s/%s/%s, quote says %s/%s/%s", S, n, r.Cost, r.Fee, r.TotalDue, cost, fee, total)
			}
			if r.Minted.Cmp(tk(n)) != 0 || BalanceOf(s, c, "hive:buyer").Cmp(tk(n)) != 0 {
				t.Fatalf("S=%d n=%d: minted %s, balance %s", S, n, r.Minted, BalanceOf(s, c, "hive:buyer"))
			}
			if d := new(big.Int).Sub(getMoney(s, kReserve(c)), reserve0); d.Cmp(cost) != 0 {
				t.Fatalf("S=%d n=%d: reserve moved by %s, want cost %s", S, n, d, cost)
			}
			if got := getMoney(s, kReserve(c)); got.Cmp(Area(tk(S+n))) != 0 {
				t.Fatalf("S=%d n=%d: reserve %s != area(%d) = %s", S, n, got, S+n, Area(tk(S+n)))
			}
			dC := new(big.Int).Sub(getMoney(s, kFeeBal(c)), feeC0)
			dP := new(big.Int).Sub(getMoney(s, kTreasury()), treasury0)
			if dC.Cmp(r.FeeCreator) != 0 || dP.Cmp(r.FeePlatform) != 0 || mAdd(dC, dP).Cmp(fee) != 0 {
				t.Fatalf("S=%d n=%d: fee pots moved %s/%s, want %s/%s (sum %s)", S, n, dC, dP, r.FeeCreator, r.FeePlatform, fee)
			}
			// Split rule: creator gets floor(fee/2), the odd unit goes to the platform.
			if r.FeeCreator.Cmp(new(big.Int).Rsh(fee, 1)) != 0 {
				t.Fatalf("S=%d n=%d: creator fee %s != floor(%s/2)", S, n, r.FeeCreator, fee)
			}
		}
	}
	t.Log("BUDGET_TABLE_END")
}

// Just below / at / just above each token boundary: the count must step
// exactly at TotalDue(n), never one unit early or late.
func TestQAMath_Purchase_BoundaryBudgets(t *testing.T) {
	qaRequireCalibration(t)
	t.Log("BOUNDARY_TABLE_BEGIN")
	t.Log("supply\tn\ttotal(n)\taffordable(total-1)\taffordable(total)\taffordable(total+1)")
	for _, S := range qaSupplies {
		for _, n := range []int64{1, 2, 3, 10} {
			_, _, total := qaTotalDue(S, n)
			tv := total.Int64()
			below, at, above := qaAffordable(S, tv-1), qaAffordable(S, tv), qaAffordable(S, tv+1)
			t.Logf("%d\t%d\t%d\t%d\t%d\t%d", S, n, tv, below, at, above)
			if below != n-1 || at != n || above != n {
				t.Fatalf("S=%d n=%d: boundary counts %d/%d/%d, want %d/%d/%d", S, n, below, at, above, n-1, n, n)
			}
		}
	}
	t.Log("BOUNDARY_TABLE_END")
}

// Cost/fee/total grid for a TS cross-check (the frontend's quoteBuyBaseUnits
// must reproduce every row).
func TestQAMath_Purchase_QuoteGrid(t *testing.T) {
	qaRequireCalibration(t)
	t.Log("QUOTE_GRID_BEGIN")
	for _, S := range qaSupplies {
		for _, n := range []int64{1, 2, 3, 5, 7, 9, 10, 11, 24, 25, 100} {
			cost, fee, total := qaTotalDue(S, n)
			t.Logf("%d\t%d\t%s\t%s\t%s\t%s", S, n, cost, fee, total, SpotRate(tk(S+n)))
			// Fee is a FLOOR of 5% of the curve cost (favours the buyer by < 1 unit).
			want := new(big.Int).Div(new(big.Int).Mul(cost, qaBig(500)), qaBig(10_000))
			if fee.Cmp(want) != 0 {
				t.Fatalf("S=%d n=%d: fee %s != floor(cost*500/10000) = %s", S, n, fee, want)
			}
		}
	}
	t.Log("QUOTE_GRID_END")
}

// The token is a WHOLE unit. The wire parser (contract/parse.BigDecimal) and
// core's parseMoney are the same rule: base-10 digits only. There is no
// fractional token anywhere in the contract; ASSET_DECIMALS in the frontend
// applies to HBD, never to a token count.
func TestQAMath_Purchase_TokenIsHundredths(t *testing.T) {
	// v6: state holds UNITS (digits only in the state parser), the wire holds
	// tokens with up to two decimals (parseTokens). Both are asserted here.
	for _, bad := range []string{"0.5", "1.0", "1e3", "-1", " 1", "1 ", "", "0x10"} {
		if _, err := parseMoney(bad); err == nil {
			t.Fatalf("parseMoney(%q) accepted a non-unit amount", bad)
		}
	}
	if u, err := parseTokens("0.5"); err != nil || u.Cmp(qaBig(50)) != 0 {
		t.Fatalf("parseTokens(0.5) = %v %v, want 50 units", u, err)
	}
	if _, err := parseTokens("0.001"); err == nil {
		t.Fatal("a third decimal must be refused")
	}
	s, c := qaMarketAtSupply(t, 0)
	if _, err := Buy(s, "hive:buyer", c, 2000, qaBig(0)); err == nil {
		t.Fatal("Buy(0) must be refused")
	}
	if _, err := Sell(s, "hive:buyer", c, 2000, qaBig(0)); err == nil {
		t.Fatal("Sell(0) must be refused")
	}
	// The smallest purchase is one unit: cost floor(1007/100) = 10, fee lifted to the one-base-unit minimum.
	unitCost := BuyCost(qaBig(0), qaBig(1))
	unitFee, _, _ := tradeFeeOn(unitCost)
	if unitCost.Cmp(qaBig(10)) != 0 || unitFee.Cmp(qaBig(1)) != 0 {
		t.Fatalf("first unit = %s + %s, want 10 + 1", unitCost, unitFee)
	}
	cost, fee, total := qaTotalDue(0, 1)
	if cost.Cmp(qaBig(1007)) != 0 || fee.Cmp(qaBig(50)) != 0 || total.Cmp(qaBig(1057)) != 0 {
		t.Fatalf("first whole token = %s/%s/%s, want 1007/50/1057", cost, fee, total)
	}
	t.Logf("MIN_PURCHASE\tS=0\tunit cost=%s fee=%s\twhole token cost=%s fee=%s total=%s", unitCost, unitFee, cost, fee, total)
}

// Mainnet replay: the three buys observed on chain, re-derived here so the
// deployed bytecode and this tree are shown to agree on the numbers.
func TestQAMath_Purchase_MainnetReplay(t *testing.T) {
	qaRequireCalibration(t)
	// 1 token at S=0: curve cost 1007 (the 10 percent era charged fee 100 on it).
	if cost := BuyCost(tk(0), tk(1)); cost.Cmp(qaBig(1007)) != 0 {
		t.Fatalf("1 token at S=0 costs %s, want 1007", cost)
	}
	// hbd-temp: 2 tokens at S=0, TotalDue 2124 (2023 + 101), reserve 2023 = area(2).
	cost, fee, total := qaTotalDue(0, 2)
	if cost.Cmp(qaBig(2023)) != 0 || fee.Cmp(qaBig(101)) != 0 || total.Cmp(qaBig(2124)) != 0 {
		t.Fatalf("2 tokens at S=0 = %s/%s/%s, want 2023/101/2124", cost, fee, total)
	}
	if Area(tk(2)).Cmp(qaBig(2023)) != 0 {
		t.Fatalf("area(2) = %s, want 2023 (live hbd-temp reserve)", Area(tk(2)))
	}
	// blanchy: 1 token at S=2, TotalDue 1075 (1024 + 51), reserve then 3047 = area(3).
	cost, fee, total = qaTotalDue(2, 1)
	if cost.Cmp(qaBig(1024)) != 0 || fee.Cmp(qaBig(51)) != 0 || total.Cmp(qaBig(1075)) != 0 {
		t.Fatalf("1 token at S=2 = %s/%s/%s, want 1024/51/1075", cost, fee, total)
	}
	if Area(tk(3)).Cmp(qaBig(3047)) != 0 {
		t.Fatalf("area(3) = %s, want 3047 (live blanchy reserve)", Area(tk(3)))
	}
}

// Rounding direction at the one curve rounding site. area() floors once, so a
// buy's cost is floor(A(S+n)) - floor(A(S)), which sits within one unit of the
// exact rational either side. It cannot be farmed: the reserve is always
// exactly area(S) and Sell returns the same difference, so a buy-then-sell
// round trip on the curve leg is exactly zero.
func TestQAMath_Purchase_CurveRoundingIsPathIndependent(t *testing.T) {
	qaRequireCalibration(t)
	for S := int64(0); S <= 2000; S += 7 {
		for _, n := range []int64{1, 2, 3, 13} {
			cost := BuyCost(tk(S), tk(n))
			back, err := SellProceeds(tk(S+n), tk(n))
			if err != nil {
				t.Fatal(err)
			}
			if back.Cmp(cost) != 0 {
				t.Fatalf("S=%d n=%d: buy cost %s, sell back %s", S, n, cost, back)
			}
			// Splitting the same n into single tokens telescopes to the same cost.
			sum := mZero()
			for i := int64(0); i < n; i++ {
				sum = mAdd(sum, BuyCost(tk(S+i), tk(1)))
			}
			if sum.Cmp(cost) != 0 {
				t.Fatalf("S=%d n=%d: one buy %s, %d single buys %s", S, n, cost, n, sum)
			}
		}
	}
}
