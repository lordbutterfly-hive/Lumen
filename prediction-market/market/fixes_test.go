package market

import (
	"math/big"
	"testing"
)

// C1 — settle-timing cherry-pick killed. Settlement is pinned to the FIRST
// pendulum tick at/after settleBlock, so the price is deterministic regardless
// of which block the caller settles in, and a tick past the prompt window VOIDs
// rather than letting a cherry-picked later tick decide.
func TestFix_C1_TickPinnedSettlement(t *testing.T) {
	// a valid first tick (== settleBlock) settles.
	s, id := setup(t)
	bet(t, s, "a", id, 1, "10000")
	bet(t, s, "b", id, 0, "10000")
	res, err := Settle(s, "k", 4050, id, 12000, 4000, true) // tick 4000 ∈ [4000, 4100)
	if err != nil || res.State != StateSettled {
		t.Fatalf("valid first tick should settle: %v %+v", err, res)
	}

	// a tick PAST the prompt window (>= settleBlock+MaxSettleTickLag) VOIDs.
	s2, id2 := setup(t)
	bet(t, s2, "a", id2, 1, "10000")
	bet(t, s2, "b", id2, 0, "10000")
	res2, err := Settle(s2, "k", 4500, id2, 12000, 4000+MaxSettleTickLag, true)
	if err != nil || res2.State != StateVoid || res2.Reason != VoidTickWindowMissed {
		t.Fatalf("stale tick should VOID(tick_window_missed): %v %+v", err, res2)
	}

	// a pre-settle tick is rejected (can't settle on a price older than settleBlock).
	s3, id3 := setup(t)
	bet(t, s3, "a", id3, 1, "10000")
	bet(t, s3, "b", id3, 0, "10000")
	if _, err := Settle(s3, "k", 4000, id3, 12000, 3999, true); err == nil {
		t.Fatal("tick before settleBlock should be rejected")
	}

	// DETERMINISM: two identical rounds settled at DIFFERENT blocks but with the
	// same first-tick value must produce the SAME winner — the caller's block no
	// longer influences the outcome (the essence of the cherry-pick fix).
	sa, ida := setup(t)
	bet(t, sa, "a", ida, 1, "10000")
	bet(t, sa, "b", ida, 0, "10000")
	sb, idb := setup(t)
	bet(t, sb, "a", idb, 1, "10000")
	bet(t, sb, "b", idb, 0, "10000")
	ra, _ := Settle(sa, "k", 4001, ida, 12000, 4000, true)
	rb, _ := Settle(sb, "k", 4099, idb, 12000, 4000, true) // different block, SAME tick
	if ra.Winner != rb.Winner {
		t.Fatalf("same tick must give same winner regardless of settle block: %d vs %d", ra.Winner, rb.Winner)
	}
}

// C2 + NEW-1 — createRound bounds the owner-supplied timing params so a grace
// overflow (early force-VOID) and an astronomical settleBlock (permanent
// fund-freeze) are both impossible.
func TestFix_C2_NEW1_TimingBounds(t *testing.T) {
	s := newMem()
	Init(s, owner)
	base := CreateParams{Asset: AssetHbd, Strikes: []uint64{10000}, LockBlock: 2000, SettleBlock: 4000}

	p := base
	p.GraceBlocks = MaxGraceBlocks + 1
	if _, err := CreateRound(s, owner, 0, p); err == nil {
		t.Fatal("grace > MaxGraceBlocks accepted (C2 overflow surface)")
	}
	p2 := base
	p2.SettleBlock = MaxRoundHorizonBlocks + 5000
	if _, err := CreateRound(s, owner, 0, p2); err == nil {
		t.Fatal("settle beyond MaxRoundHorizonBlocks accepted (NEW-1 permanent-freeze)")
	}
	p3 := base
	p3.GraceBlocks = MaxGraceBlocks
	if _, err := CreateRound(s, owner, 0, p3); err != nil {
		t.Fatalf("grace at the cap should be accepted: %v", err)
	}
}

// C3 — grace=0 no longer permits a 1-block settle-vs-void race: voidStale fires
// only STRICTLY after settleBlock+SettleWindowBlocks+grace, which at grace==0 can
// never coincide with settle()'s own last legitimate block (it uses strict >).
func TestFix_C3_NoGraceZeroRace(t *testing.T) {
	s := newMem()
	Init(s, owner)
	id, err := CreateRound(s, owner, 0, CreateParams{
		Asset: AssetHbd, Strikes: []uint64{10000}, LockBlock: 2000, SettleBlock: 4000, GraceBlocks: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	bet(t, s, "a", id, 1, "10000")
	W := uint64(4000 + SettleWindowBlocks) // grace == 0
	if _, err := VoidStale(s, "loser", W, id); err == nil {
		t.Fatal("voidStale fired at block==W with grace=0 (the C3 race)")
	}
	if _, err := VoidStale(s, "k", W+1, id); err != nil {
		t.Fatalf("voidStale should fire at W+1: %v", err)
	}
}

// DODGE — the keeper bounty scales with pool size (a fixed 100 would be
// negligible on a large pool, which is what let a losing bettor passively dodge
// by counting on no keeper bothering to settle). NOTE: the bounty is carved from
// the fee, so it only funds when a fee is enabled. The shipped contract runs at
// ZERO fee (TestFix_ZeroRake) → no bounty → this anti-dodge protection is INACTIVE
// on the default deploy (a documented tradeoff of a no-rake parimutuel; settlement
// then relies on winners self-settling to claim). This test enables a fee to prove
// the retained scaling logic is still correct if a fee is ever turned on.
func TestFix_Dodge_BountyScalesWithPool(t *testing.T) {
	s := newMem()
	Init(s, owner)
	const feeBps = 200 // enable a 2% fee (default is 0) to exercise the bounty
	if err := SetFeeBps(s, owner, feeBps); err != nil {
		t.Fatal(err)
	}
	id, _ := CreateRound(s, owner, 0, CreateParams{Asset: AssetHbd, Strikes: []uint64{10000}, LockBlock: 2000, SettleBlock: 4000, GraceBlocks: 300})
	bet(t, s, "a", id, 1, "1000000")
	bet(t, s, "b", id, 0, "1000000") // pool = 2,000,000
	res, err := Settle(s, "k", 4000, id, 12000, 4000, true)
	if err != nil || res.State != StateSettled {
		t.Fatalf("settle: %v %+v", err, res)
	}
	fixed, _ := parseMoney(SettleBounty) // 100
	if res.Bounty.Cmp(fixed) <= 0 {
		t.Fatalf("bounty %s should scale above the fixed floor %s on a large pool", res.Bounty, fixed)
	}
	fee := mMulBpsDiv(big.NewInt(2000000), feeBps) // 40000
	if res.Bounty.Cmp(fee) > 0 {
		t.Fatalf("bounty %s must never exceed the fee %s", res.Bounty, fee)
	}
}


// Round lifecycle — one OPEN round per asset (no overlapping betting windows /
// "knows when to start anew / doesn't fuck up pools"). A different asset may run
// concurrently; a new round for the same asset is only allowed once the previous
// one has resolved.
func TestFix_Lifecycle_OneOpenRoundPerAsset(t *testing.T) {
	s := newMem()
	Init(s, owner)
	mk := func(asset string) (uint64, error) {
		return CreateRound(s, owner, 0, CreateParams{
			Asset: asset, Strikes: []uint64{10000}, LockBlock: 2000, SettleBlock: 4000, GraceBlocks: 300,
		})
	}
	idA, err := mk(AssetHbd)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := mk(AssetHbd); err == nil {
		t.Fatal("a second OPEN round for the same asset was accepted (overlapping windows)")
	}
	if _, err := mk(AssetHive); err != nil {
		t.Fatalf("a different asset should run concurrently: %v", err)
	}
	// resolve round A, then a new hbd round is allowed.
	bet(t, s, "a", idA, 1, "10000")
	bet(t, s, "b", idA, 0, "10000")
	if _, err := Settle(s, "k", 4000, idA, 12000, 4000, true); err != nil {
		t.Fatal(err)
	}
	if _, err := mk(AssetHbd); err != nil {
		t.Fatalf("new hbd round should be allowed after the previous resolved: %v", err)
	}
}

// Cross-round (cross-asset) pool isolation — the same account bets in two
// concurrent rounds; each claim reflects ONLY its own round's stake/pool, proving
// pools can't contaminate each other ("doesn't fuck up pools of bets").
func TestFix_Lifecycle_CrossAssetIsolation(t *testing.T) {
	s := newMem()
	Init(s, owner)
	idH, _ := CreateRound(s, owner, 0, CreateParams{Asset: AssetHbd, Strikes: []uint64{10000}, LockBlock: 2000, SettleBlock: 4000, GraceBlocks: 300})
	idV, _ := CreateRound(s, owner, 0, CreateParams{Asset: AssetHive, Strikes: []uint64{10000}, LockBlock: 2000, SettleBlock: 4000, GraceBlocks: 300})
	// "a" bets in BOTH rounds; sole winner in each (outcome 1, price 12000 > strike).
	bet(t, s, "a", idH, 1, "10000")
	bet(t, s, "b", idH, 0, "10000") // hbd pool 20000
	bet(t, s, "a", idV, 1, "5000")
	bet(t, s, "b", idV, 0, "5000") // hive pool 10000
	Settle(s, "k", 4000, idH, 12000, 4000, true)
	Settle(s, "k", 4000, idV, 12000, 4000, true)
	paH, _, _ := Claim(s, "a", idH)
	paV, _, _ := Claim(s, "a", idV)
	// a is the sole winner in each round → gets that round's full distributable
	// (pool − fee), reflecting ONLY that round's own stake, never the other's.
	distH := new(big.Int).Sub(big.NewInt(20000), mMulBpsDiv(big.NewInt(20000), DefaultFeeBps))
	distV := new(big.Int).Sub(big.NewInt(10000), mMulBpsDiv(big.NewInt(10000), DefaultFeeBps))
	if paH.Cmp(distH) != 0 {
		t.Fatalf("hbd claim = %s want %s (must reflect ONLY the hbd round's stake, not the hive bet)", paH, distH)
	}
	if paV.Cmp(distV) != 0 {
		t.Fatalf("hive claim = %s want %s (must reflect ONLY the hive round)", paV, distV)
	}
}

// Provenance — the reference price (the "why" the strikes were set) is recorded
// on-chain, and the active-round pointer is published.
func TestFix_Provenance_ReferencePrice(t *testing.T) {
	s := newMem()
	Init(s, owner)
	id, err := CreateRound(s, owner, 0, CreateParams{
		Asset: AssetHbd, Strikes: []uint64{10000}, LockBlock: 2000, SettleBlock: 4000, GraceBlocks: 300,
		ReferencePrice: 2940,
	})
	if err != nil {
		t.Fatal(err)
	}
	if getU64(s, rk(id, "refprice")) != 2940 {
		t.Fatal("reference price not recorded on-chain")
	}
	if getU64(s, kActiveRound(AssetHbd)) != id+1 {
		t.Fatal("active-round pointer not published")
	}
}


// Zero-rake — the contract ships with NO protocol fee (DefaultFeeBps = 0). A
// settled round accrues zero house take, WithdrawFees has nothing to sweep, no
// beneficiary is hardcoded, and the sole winner takes the ENTIRE pool.
func TestFix_ZeroRake_NoHouseTake(t *testing.T) {
	if DefaultFeeBps != 0 {
		t.Fatalf("DefaultFeeBps = %d, want 0 (zero-rake, no operator take)", DefaultFeeBps)
	}
	if DefaultHouseAccount != "" {
		t.Fatalf("DefaultHouseAccount = %q, want empty (no hardcoded beneficiary)", DefaultHouseAccount)
	}
	s := newMem()
	Init(s, owner)
	id, _ := CreateRound(s, owner, 0, CreateParams{Asset: AssetHive, Strikes: []uint64{10000}, LockBlock: 2000, SettleBlock: 4000, GraceBlocks: 300})
	bet(t, s, "a", id, 1, "100000") // bucket 1 wins (price 12000 ≥ strike 10000)
	bet(t, s, "b", id, 0, "100000")
	pool := getMoney(s, rk(id, "pool"))
	Settle(s, "k", 4000, id, 12000, 4000, true)

	// No fee accrues on a zero-rake settlement.
	if accrued := getMoney(s, kFeeAccrued(AssetHive)); accrued.Sign() != 0 {
		t.Fatalf("fee accrued %s on a zero-rake round, want 0", accrued)
	}
	// Nothing to withdraw — WithdrawFees errors rather than paying anyone.
	if _, _, err := WithdrawFees(s, owner, AssetHive); err == nil {
		t.Fatal("WithdrawFees succeeded on a zero-rake round (should have no accrued fees)")
	}
	// The sole winner (bucket 1) takes the FULL pool — no rake removed.
	payout, _, err := Claim(s, "a", id)
	if err != nil {
		t.Fatal(err)
	}
	if payout.Cmp(pool) != 0 {
		t.Fatalf("winner payout %s != full pool %s (zero-rake: winner takes all)", payout, pool)
	}
}
