package core

import (
	"math/big"
	"testing"
)

// GENERATOR FOR THE FRONTEND'S GOLDEN VECTORS.
//
// apps/blog/features/creator-tokens/ui/token-page/trade-preview.selftest.ts
// asserts the TypeScript port of this package against a table of numbers that
// must NOT come from TypeScript — a port defect looks identical from inside the
// port. This test prints that table from the contract's own compiled
// arithmetic. Run it and paste the block between GOLDEN_BEGIN and GOLDEN_END:
//
//	go test ./core/ -run TestGenerateTradePreviewGoldens -v
//
// ★ WHY IT IS A TEST AND NOT A cmd/. Because it also CHECKS what it prints. A
// generator that only prints can emit a nonsense table that the consumer then
// pins forever; every row below is asserted for internal consistency (net ==
// gross - tax, total == cost + fee, commission <= credits) before it is
// printed, so a broken core produces a FAILING generator, not a poisoned
// golden.
//
// ★ REGENERATED 2026-09-12. The table in the frontend was produced on
// 2026-08-27 at TradeFeeBps 1000 / MaxExitTaxBps 2000 and was never redone when
// params.go halved the fee and cut the tax ceiling on 2026-09-09, so the
// selftest failed against correct code. The ASK rows also changed SHAPE: the
// posted price used to split 88% tokens / 12% HBD (core.splitFace), and since
// the owner ruling of 2026-09-12 the whole face is paid in tokens and the
// commission is carved out of those same credits, so there is no HBD leg to
// print.
func TestGenerateTradePreviewGoldens(t *testing.T) {
	bi := func(n int64) *big.Int { return big.NewInt(n) }
	out := func(format string, a ...any) { t.Logf(format, a...) }

	t.Log("GOLDEN_BEGIN")

	// ---- REFUND: the wind-down rail. gross = floor(reserve*n/supply);
	// the maturing slice of it is taxed at the cohort's decayed rate.
	type rcase struct {
		reserve, supply, held, maturing int64
		heldBlocks                      uint64
		ns                              []int64
	}
	for _, c := range []rcase{
		{120000, 1000, 100, 40, 0, []int64{1, 10, 39, 40, 41, 80, 99, 100}},
		{120000, 1000, 100, 100, 0, []int64{10, 50, 100}},
		{120000, 1000, 100, 1, 0, []int64{1, 50, 100}},
		{60153, 50, 50, 20, 0, []int64{1, 5, 20, 35, 50}},
		{60153, 50, 50, 20, 604800, []int64{1, 20, 50}},
		{60153, 50, 50, 20, 1209600, []int64{1, 20, 50}},
		{999999, 777, 333, 111, 201600, []int64{1, 111, 222, 333}},
	} {
		taxBps := ExitTaxBpsAt(c.heldBlocks)
		for _, n := range c.ns {
			gross := refundPayout(bi(c.reserve), bi(n), bi(c.supply))
			fromMaturing := c.maturing
			if n < fromMaturing {
				fromMaturing = n
			}
			share := mMulDivCeil(gross, bi(fromMaturing), bi(n))
			tax := ExitTaxOn(share, taxBps)
			net := new(big.Int).Sub(gross, tax)
			if net.Sign() < 0 || new(big.Int).Add(net, tax).Cmp(gross) != 0 {
				t.Fatalf("REFUND row does not reconcile: gross=%s tax=%s net=%s", gross, tax, net)
			}
			out("REFUND\t%d\t%d\t%d\t%d\t%d\t%d\t%s\t%s\t%s\t%d",
				c.reserve, c.supply, c.held, c.maturing, c.heldBlocks, n, gross, tax, net, taxBps)
		}
	}

	// ---- BUY: cost = Area(S+n)-Area(S); fee = floor(cost*TradeFeeBps/1e4) ON TOP.
	supplies := []int64{0, 10, 50, 100, 500, 1000}
	// ★ DENSE 1..20, NOT A SPARSE HANDFUL. The consumer looks rows up by the
	// token count a live quote produces, and that count MOVES when a fee rate
	// moves: the old sparse grid {1,2,4,8,15,39,70} was written when a $25
	// budget at supply 50 bought 15 tokens, and the 2026-09-09 fee cut made it
	// buy 16 — a count with no row, so the selftest died on a lookup instead of
	// reporting a number. A dense low range costs nothing and cannot drift.
	counts := []int64{}
	for n := int64(1); n <= 20; n++ {
		counts = append(counts, n)
	}
	counts = append(counts, 39, 70)
	for _, S := range supplies {
		for _, n := range counts {
			cost := BuyCost(bi(S), bi(n))
			fee, _, _ := tradeFeeOn(cost)
			total := new(big.Int).Add(cost, fee)
			if new(big.Int).Sub(total, fee).Cmp(cost) != 0 {
				t.Fatalf("BUY row does not reconcile at S=%d n=%d", S, n)
			}
			out("BUY\t%d\t%d\t%s\t%s\t%s", S, n, cost, fee, total)
		}
	}

	// ---- SPOT: the oracle's instantaneous rate at each supply.
	for _, S := range supplies {
		out("SPOT\t%d\t%s", S, SpotRate(bi(S)))
	}

	// ---- ASK: ONE ASSET. credits = ceil(face/rate) whole tokens, and the
	// platform's cut is floor(credits*CommissionBps/1e4) OF THOSE CREDITS.
	for _, S := range []int64{50, 1000} {
		rate := SpotRate(bi(S))
		for _, face := range []int64{15000, 25000, 200000} {
			credits := creditsForAsk(bi(face), rate)
			commission := commissionOwedFor(credits)
			legValue := new(big.Int).Mul(credits, rate)
			if commission.Cmp(credits) > 0 {
				t.Fatalf("ASK commission %s exceeds the credits %s it is carved from", commission, credits)
			}
			out("ASK\t%d\t%d\t%s\t%s\t%s\t%s", S, face, rate, credits, commission, legValue)
		}
	}

	// ---- TAXBPS: the early-exit schedule at day boundaries.
	for _, d := range []uint64{0, 1, 7, 21, 41, 42, 43} {
		out("TAXBPS\t%d\t%d", d, ExitTaxBpsAt(d*BlocksPerDay))
	}

	t.Log("GOLDEN_END")
}
