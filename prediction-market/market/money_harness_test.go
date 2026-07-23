package market

import (
	"math/big"
	"testing"
)

// Money harness — simulates a full weekly HIVE round with 15 real participants
// staking varied HIVE amounts, settles it, has EVERYONE claim, and proves the
// money conserves exactly: HIVE in == payouts + fee + keeper bounty, with no
// funds stuck and no dust. This is the "everyone is paid out completely and as
// they should be" check. (Core-level: it exercises the exact escrow/payout math;
// real token movement via sdk.HiveDraw/HiveTransfer is the wasm layer + devnet.)

type participant struct {
	name    string
	outcome int    // bucket 0..4
	stake   string // HIVE base units (1000 = 1.000 HIVE)
}

// A HIVE round, N=5 %-move buckets. Strikes are bps of the HBD/HIVE feed; with a
// Monday-open reference of 2940 (~$0.294), the ±10%/±20% boundaries are:
//
//	≤−20%      : price < 2352
//	−20%..−10% : 2352 ≤ price < 2646
//	flat ±10%  : 2646 ≤ price < 3234
//	+10%..+20% : 3234 ≤ price < 3528
//	≥+20%      : price ≥ 3528
var harnessStrikes = []uint64{2352, 2646, 3234, 3528}

func newHiveRound(t *testing.T, s *memStore) uint64 {
	t.Helper()
	id, err := CreateRound(s, owner, 0, CreateParams{
		Asset:          AssetHive,
		Strikes:        harnessStrikes,
		LockBlock:      2000,
		SettleBlock:    4000,
		GraceBlocks:    300,
		ReferencePrice: 2940,
		Label:          "Where will HIVE close this week?",
	})
	if err != nil {
		t.Fatalf("createRound: %v", err)
	}
	return id
}

func hiv(t *testing.T, base string) string {
	t.Helper()
	v := mp(t, base)
	whole := new(big.Int).Div(v, big.NewInt(1000))
	frac := new(big.Int).Mod(v, big.NewInt(1000))
	return whole.String() + "." + pad3(frac.String())
}

func pad3(s string) string {
	for len(s) < 3 {
		s = "0" + s
	}
	return s
}

func TestMoneyHarness_HiveRound_SettledEveryonePaid(t *testing.T) {
	s := newMem()
	if err := Init(s, owner); err != nil {
		t.Fatal(err)
	}
	id := newHiveRound(t, s)

	// 15 people stake HIVE across the 5 buckets. Bucket 3 (+10..+20%) will win.
	people := []participant{
		{"alice", 0, "5000"}, // ≤−20%
		{"bob", 0, "3000"},
		{"carol", 1, "12000"}, // −20..−10%
		{"dave", 1, "8000"},
		{"erin", 1, "4000"},
		{"frank", 2, "50000"}, // flat (crowd favorite)
		{"grace", 2, "30000"},
		{"heidi", 2, "25000"},
		{"ivan", 2, "10000"},
		{"judy", 2, "7000"},
		{"mallory", 3, "20000"}, // +10..+20%  ← WINNING bucket
		{"niaj", 3, "15000"},
		{"olivia", 3, "9000"},
		{"peggy", 4, "6000"}, // ≥+20%
		{"quinn", 4, "3000"},
	}

	totalIn := big.NewInt(0)
	for _, p := range people {
		if err := RecordBet(s, p.name, 10, id, p.outcome, mp(t, p.stake)); err != nil {
			t.Fatalf("bet %s: %v", p.name, err)
		}
		totalIn.Add(totalIn, mp(t, p.stake))
	}

	pool := getMoney(s, rk(id, "pool"))
	if pool.Cmp(totalIn) != 0 {
		t.Fatalf("pool %s != Σ stakes %s", pool, totalIn)
	}
	t.Logf("HIVE IN: %d participants, pool = %s HIVE", len(people), hiv(t, pool.String()))

	// Settle at price 3300 → lands in bucket 3 ([3234, 3528)). Tick pinned to the
	// first tick at/after settleBlock (4000), settle at block 4050.
	res, err := Settle(s, "keeper", 4050, id, 3300, 4000, true)
	if err != nil {
		t.Fatal(err)
	}
	if res.State != StateSettled || res.Winner != 3 {
		t.Fatalf("expected SETTLED winner=3, got %+v", res)
	}
	fee := mMulBpsDiv(pool, DefaultFeeBps) // snapshot fee (0 on the zero-rake deploy)
	distributable := new(big.Int).Sub(pool, fee)
	bounty := res.Bounty
	t.Logf("SETTLED: winner=bucket 3 (+10..+20%%) · fee=%s (zero-rake) · keeper bounty=%s · distributable=%s HIVE",
		hiv(t, fee.String()), hiv(t, bounty.String()), hiv(t, distributable.String()))

	// Everyone claims. Winners split `distributable` pro-rata; losers get 0.
	totalPaid := big.NewInt(0)
	for _, p := range people {
		payout, asset, err := Claim(s, p.name, id)
		if err != nil {
			t.Fatalf("claim %s: %v", p.name, err)
		}
		if asset != AssetHive {
			t.Fatalf("claim %s paid in %q, want hive", p.name, asset)
		}
		totalPaid.Add(totalPaid, payout)
		if p.outcome == 3 {
			if payout.Sign() <= 0 {
				t.Fatalf("winner %s paid 0", p.name)
			}
		} else if payout.Sign() != 0 {
			t.Fatalf("loser %s paid %s (must be 0)", p.name, payout)
		}
		t.Logf("  %-8s bucket %d stake %-8s → payout %s HIVE", p.name, p.outcome, hiv(t, mp(t, p.stake).String()), hiv(t, payout.String()))
	}

	// 1) Winners split distributable EXACTLY — zero dust.
	if totalPaid.Cmp(distributable) != 0 {
		t.Fatalf("Σ payouts %s != distributable %s (under/over-paid)", totalPaid, distributable)
	}
	// 2) FULL CONSERVATION: HIVE in == payouts + accrued fee + keeper bounty. Nothing stuck, nothing created.
	feeAccrued := getMoney(s, kFeeAccrued(AssetHive))
	out := new(big.Int).Add(totalPaid, feeAccrued)
	out.Add(out, bounty)
	if out.Cmp(pool) != 0 {
		t.Fatalf("HIVE OUT %s != HIVE IN %s (funds stuck or created)", out, pool)
	}
	// 3) No double claim.
	if _, _, err := Claim(s, "mallory", id); err == nil {
		t.Fatal("double claim allowed")
	}
	t.Logf("CONSERVED: in %s == payouts %s + fee %s + bounty %s HIVE. Everyone paid, nothing stuck.",
		hiv(t, pool.String()), hiv(t, totalPaid.String()), hiv(t, feeAccrued.String()), hiv(t, bounty.String()))
}

func TestMoneyHarness_HiveRound_VoidRefundsEveryone(t *testing.T) {
	s := newMem()
	if err := Init(s, owner); err != nil {
		t.Fatal(err)
	}
	id := newHiveRound(t, s)

	// Everyone bets buckets 0..2; the settle price lands in the EMPTY bucket 4 →
	// zero_winner VOID → every participant is refunded their full stake.
	people := []participant{
		{"alice", 0, "5000"},
		{"bob", 1, "12000"},
		{"carol", 1, "8000"},
		{"dave", 2, "40000"},
		{"erin", 2, "15000"},
		{"frank", 2, "6000"},
		{"grace", 0, "9000"},
		{"heidi", 1, "3000"},
	}
	totalIn := big.NewInt(0)
	for _, p := range people {
		if err := RecordBet(s, p.name, 10, id, p.outcome, mp(t, p.stake)); err != nil {
			t.Fatalf("bet %s: %v", p.name, err)
		}
		totalIn.Add(totalIn, mp(t, p.stake))
	}
	pool := getMoney(s, rk(id, "pool"))

	// price 3600 → bucket 4 (≥+20%), which nobody funded → VoidZeroWinner.
	res, err := Settle(s, "keeper", 4050, id, 3600, 4000, true)
	if err != nil {
		t.Fatal(err)
	}
	if res.State != StateVoid || res.Reason != VoidZeroWinner {
		t.Fatalf("expected VOID(zero_winner), got %+v", res)
	}

	totalRefund := big.NewInt(0)
	for _, p := range people {
		refund, _, err := Claim(s, p.name, id)
		if err != nil {
			t.Fatalf("claim %s: %v", p.name, err)
		}
		if refund.Cmp(mp(t, p.stake)) != 0 {
			t.Fatalf("void refund %s = %s, want full stake %s", p.name, refund, p.stake)
		}
		totalRefund.Add(totalRefund, refund)
	}
	if totalRefund.Cmp(pool) != 0 {
		t.Fatalf("Σ refunds %s != pool %s (void must return every HIVE)", totalRefund, pool)
	}
	// No fee is taken on a void.
	if getMoney(s, kFeeAccrued(AssetHive)).Sign() != 0 {
		t.Fatal("fee accrued on a VOID round")
	}
	t.Logf("VOID(zero_winner): all %d participants refunded in full, Σ refunds %s == pool. No fee taken.",
		len(people), hiv(t, totalRefund.String()))
}
