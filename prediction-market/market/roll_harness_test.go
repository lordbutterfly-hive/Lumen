package market

import (
	"math/big"
	"testing"
)

// Production-config money harness — the EXACT shape users hit: a 7-bucket HBD
// round opened via the permissionless RollRound, bet across all 7 buckets
// (including the middle "near current" bucket), settled at a middle-bucket price,
// everyone claims. Proves conservation (Σpayouts == distributable == pool),
// zero-dust, and that the middle bucket of 7 wins + pays. Closes the audit's
// GAP #1 (the flagship harness was 5-bucket HIVE; RollRound was never driven
// end-to-end through bet→settle→claim) and GAP #3 (middle-of-7 wins).
func TestRollHarness_SevenBucketHbd_SettledEveryonePaid(t *testing.T) {
	s := newMem()
	if err := Init(s, owner); err != nil {
		t.Fatal(err)
	}

	// Roll the production round: ref 2940 → strikes [2058,2352,2646,3234,3528,3822], HBD.
	id, err := RollRound(s, 1000, 2940, true)
	if err != nil {
		t.Fatal(err)
	}
	if getStr(s, rk(id, "asset")) != AssetHbd {
		t.Fatalf("roll asset = %q, want hbd", getStr(s, rk(id, "asset")))
	}
	if roundN(s, id) != 7 {
		t.Fatalf("roundN = %d, want 7", roundN(s, id))
	}

	// 15 participants across all 7 buckets. Bucket 3 (near-current) will win.
	people := []participant{
		{"alice", 0, "5000"},  // ≤ −30%
		{"bob", 1, "3000"},    // −30..−20%
		{"carol", 2, "12000"}, // −20..−10%
		{"dave", 3, "20000"},  // near current ← WINNER
		{"erin", 3, "15000"},  // WINNER
		{"frank", 3, "9000"},  // WINNER
		{"grace", 4, "8000"},  // +10..+20%
		{"heidi", 5, "6000"},  // +20..+30%
		{"ivan", 6, "4000"},   // ≥ +30%
		{"judy", 2, "7000"},
		{"mallory", 4, "10000"},
		{"niaj", 0, "3000"},
		{"olivia", 3, "11000"}, // WINNER
		{"peggy", 6, "2000"},
		{"quinn", 5, "5000"},
	}
	totalIn := big.NewInt(0)
	for _, p := range people {
		if err := RecordBet(s, p.name, 1010, id, p.outcome, mp(t, p.stake)); err != nil {
			t.Fatalf("bet %s: %v", p.name, err)
		}
		totalIn.Add(totalIn, mp(t, p.stake))
	}
	pool := getMoney(s, rk(id, "pool"))
	if pool.Cmp(totalIn) != 0 {
		t.Fatalf("pool %s != Σ stakes %s", pool, totalIn)
	}

	// Settle at price 3000 ∈ [2646, 3234) → bucket 3 (the middle) wins. Tick pinned
	// into [settleBlock, settleBlock+MaxSettleTickLag).
	settleBlock := getU64(s, rk(id, "settle"))
	res, err := Settle(s, "keeper", settleBlock+50, id, 3000, settleBlock+50, true)
	if err != nil {
		t.Fatal(err)
	}
	if res.State != StateSettled || res.Winner != 3 {
		t.Fatalf("expected SETTLED winner=3 (middle bucket of 7), got %+v", res)
	}

	fee := mMulBpsDiv(pool, getU64(s, rk(id, "fb"))) // 0 on the zero-rake deploy
	distributable := new(big.Int).Sub(pool, fee)

	totalPaid := big.NewInt(0)
	for _, p := range people {
		payout, asset, err := Claim(s, p.name, id)
		if err != nil {
			t.Fatalf("claim %s: %v", p.name, err)
		}
		if asset != AssetHbd {
			t.Fatalf("claim %s paid in %q, want hbd", p.name, asset)
		}
		totalPaid.Add(totalPaid, payout)
		if p.outcome == 3 && payout.Sign() <= 0 {
			t.Fatalf("middle-bucket winner %s paid 0", p.name)
		}
		if p.outcome != 3 && payout.Sign() != 0 {
			t.Fatalf("loser %s (bucket %d) paid %s, must be 0", p.name, p.outcome, payout)
		}
	}
	// Zero-dust: winners split distributable EXACTLY.
	if totalPaid.Cmp(distributable) != 0 {
		t.Fatalf("Σ payouts %s != distributable %s (7-bucket HBD)", totalPaid, distributable)
	}
	// Full conservation: HBD in == payouts + accrued fee (0) + bounty (0).
	out := new(big.Int).Add(totalPaid, getMoney(s, kFeeAccrued(AssetHbd)))
	out.Add(out, res.Bounty)
	if out.Cmp(pool) != 0 {
		t.Fatalf("HBD OUT %s != HBD IN %s (funds stuck or created)", out, pool)
	}
	// No double claim.
	if _, _, err := Claim(s, "dave", id); err == nil {
		t.Fatal("double claim allowed")
	}
	t.Logf("PROD-CONFIG OK: 7-bucket HBD roll, middle bucket 3 won, %d stakers, Σpayouts == pool == %s. Conserved.",
		len(people), pool)
}

// bucketFor is correct at every one of the six 7-bucket strike boundaries — a
// price exactly on a strike belongs to the UPPER bucket (consensus-safe). Closes
// the audit's GAP #2 (the existing boundary test only covered a single strike).
func TestRoll_BucketForSevenBoundaries(t *testing.T) {
	strikes := []uint64{2058, 2352, 2646, 3234, 3528, 3822} // computeStrikes(2940)
	cases := []struct {
		price uint64
		want  int
	}{
		{1, 0}, {2057, 0}, {2058, 1}, // on-strike → upper
		{2351, 1}, {2352, 2},
		{2645, 2}, {2646, 3},
		{3233, 3}, {3234, 4},
		{3527, 4}, {3528, 5},
		{3821, 5}, {3822, 6},
		{100000, 6},
	}
	for _, c := range cases {
		if got := bucketFor(c.price, strikes); got != c.want {
			t.Fatalf("bucketFor(%d) = %d, want %d", c.price, got, c.want)
		}
	}
}
