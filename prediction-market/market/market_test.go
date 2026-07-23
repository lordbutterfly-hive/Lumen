package market

import (
	"math/big"
	"testing"
)

// In-memory Store for tests.
type memStore struct{ m map[string]string }

func newMem() *memStore                     { return &memStore{m: map[string]string{}} }
func (s *memStore) Get(k string) (string, bool) { v, ok := s.m[k]; return v, ok }
func (s *memStore) Set(k, v string)         { s.m[k] = v }
func (s *memStore) Delete(k string)         { delete(s.m, k) }

const owner = "hive:owner"

func mp(t *testing.T, s string) *big.Int {
	t.Helper()
	v, ok := new(big.Int).SetString(s, 10)
	if !ok {
		t.Fatalf("bad number %q", s)
	}
	return v
}

// setup an initialized contract + one binary HBD round (strike 10000 bps = par).
// lock=2000, settle=4000, grace=300; settle window = SettleWindowBlocks (1200),
// so voidStale is only allowed at block >= 4000+1200+300 = 5500.
func setup(t *testing.T) (*memStore, uint64) {
	t.Helper()
	s := newMem()
	if err := Init(s, owner); err != nil {
		t.Fatal(err)
	}
	id, err := CreateRound(s, owner, 0, CreateParams{
		Asset: AssetHbd, Strikes: []uint64{10000}, LockBlock: 2000, SettleBlock: 4000, GraceBlocks: 300,
	})
	if err != nil {
		t.Fatal(err)
	}
	return s, id
}

func bet(t *testing.T, s Store, acct string, id uint64, outcome int, amt string) {
	t.Helper()
	if err := RecordBet(s, acct, 10, id, outcome, mp(t, amt)); err != nil {
		t.Fatalf("bet %s: %v", acct, err)
	}
}

func sumOutcomePools(s Store, id uint64, n int) *big.Int {
	total := big.NewInt(0)
	for k := 0; k < n; k++ {
		total.Add(total, getMoney(s, rkOutcomePool(id, k)))
	}
	return total
}

// ---------------------------------------------------------------------------

func TestInvariant_PoolConservation(t *testing.T) {
	s, id := setup(t)
	bet(t, s, "a", id, 1, "7000")
	bet(t, s, "b", id, 1, "11000")
	bet(t, s, "c", id, 0, "50000")
	// pool == Σ outcomePool
	if got, want := getMoney(s, rk(id, "pool")), sumOutcomePools(s, id, 2); got.Cmp(want) != 0 {
		t.Fatalf("pool %s != Σopool %s", got, want)
	}
	// stakeTotal per acct == its stake sum
	if getMoney(s, rkStakeTotal(id, "a")).Cmp(mp(t, "7000")) != 0 {
		t.Fatal("stakeTotal a wrong")
	}
	if getMoney(s, rk(id, "pool")).Cmp(mp(t, "68000")) != 0 {
		t.Fatalf("pool = %s want 68000", getMoney(s, rk(id, "pool")))
	}
}

func TestInvariant_ZeroDust_SumOfClaimsEqualsDistributable(t *testing.T) {
	s, id := setup(t)
	// three winners with prime stakes on outcome 1, one loser on outcome 0.
	bet(t, s, "a", id, 1, "7000")
	bet(t, s, "b", id, 1, "11000")
	bet(t, s, "c", id, 1, "13000")
	bet(t, s, "d", id, 0, "50000")
	pool := getMoney(s, rk(id, "pool")) // 81000
	res, err := Settle(s, "keeper", 4000, id, 12000, 4000, true)
	if err != nil {
		t.Fatal(err)
	}
	if res.State != StateSettled || res.Winner != 1 {
		t.Fatalf("expected SETTLED winner 1, got %+v", res)
	}
	fee := mMulBpsDiv(pool, DefaultFeeBps)
	distributable := new(big.Int).Sub(pool, fee)

	total := big.NewInt(0)
	for _, w := range []string{"a", "b", "c"} {
		p, _, err := Claim(s, w, id)
		if err != nil {
			t.Fatalf("claim %s: %v", w, err)
		}
		total.Add(total, p)
	}
	if total.Cmp(distributable) != 0 {
		t.Fatalf("Σ claims %s != distributable %s (dust leaked)", total, distributable)
	}
	// loser gets nothing
	p, _, err := Claim(s, "d", id)
	if err != nil {
		t.Fatal(err)
	}
	if p.Sign() != 0 {
		t.Fatalf("loser paid %s", p)
	}
}

func TestInvariant_SolvencyNeverExceeded(t *testing.T) {
	// Fuzz-ish: varied stake distributions, Σ claims must always be ≤ distributable.
	dists := [][]string{
		{"1000", "1000", "1000"},
		{"999999", "1009", "1013"},
		{"1000", "999999999999999999999999", "1013"},
		{"1009", "1013", "7919"}, // primes ≥ MinBet → maximal floor loss
	}
	for _, d := range dists {
		s, id := setup(t)
		for i, amt := range d {
			bet(t, s, string(rune('a'+i)), id, 1, amt)
		}
		bet(t, s, "loser", id, 0, "5000")
		pool := getMoney(s, rk(id, "pool"))
		if _, err := Settle(s, "k", 4000, id, 12000, 4000, true); err != nil {
			t.Fatal(err)
		}
		distributable := new(big.Int).Sub(pool, mMulBpsDiv(pool, DefaultFeeBps))
		total := big.NewInt(0)
		for i := range d {
			p, _, err := Claim(s, string(rune('a'+i)), id)
			if err != nil {
				t.Fatal(err)
			}
			total.Add(total, p)
		}
		if total.Cmp(distributable) > 0 {
			t.Fatalf("dist %v: Σclaims %s > distributable %s (INSOLVENT)", d, total, distributable)
		}
	}
}

func TestInvariant_FeeBpsSnapshotImmutable(t *testing.T) {
	s := newMem()
	Init(s, owner)
	SetFeeBps(s, owner, 0) // create round at fee 0
	id, _ := CreateRound(s, owner, 0, CreateParams{Asset: AssetHbd, Strikes: []uint64{10000}, LockBlock: 2000, SettleBlock: 4000, GraceBlocks: 300})
	bet(t, s, "a", id, 1, "10000")
	bet(t, s, "b", id, 0, "10000")
	if err := SetFeeBps(s, owner, 500); err != nil { // raise fee AFTER round created
		t.Fatal(err)
	}
	pool := getMoney(s, rk(id, "pool"))
	Settle(s, "k", 4000, id, 12000, 4000, true)
	// distributable must reflect fee=0 (the snapshot), not the live 500.
	p, _, _ := Claim(s, "a", id)
	if p.Cmp(pool) != 0 {
		t.Fatalf("fee snapshot violated: winner got %s, want full pool %s (fee should be 0)", p, pool)
	}
	if getMoney(s, kFeeAccrued(AssetHbd)).Sign() != 0 {
		t.Fatal("fee accrued despite snapshot fee=0")
	}
}

func TestInvariant_SettleVoidMutualExclusion(t *testing.T) {
	// settle then voidStale must fail.
	s, id := setup(t)
	bet(t, s, "a", id, 1, "10000")
	bet(t, s, "b", id, 0, "10000")
	if _, err := Settle(s, "k", 4000, id, 12000, 4000, true); err != nil {
		t.Fatal(err)
	}
	if _, err := VoidStale(s, "k", 5500, id); err == nil {
		t.Fatal("voidStale succeeded after settle (double-resolution)")
	}
	if _, err := Settle(s, "k", 4000, id, 12000, 4000, true); err == nil {
		t.Fatal("settle succeeded twice")
	}
	// void then settle must fail.
	s2, id2 := setup(t)
	bet(t, s2, "a", id2, 1, "10000")
	if _, err := VoidStale(s2, "k", 5501, id2); err != nil { // settleBlock=4000 window=1200 grace=300 → fires strictly > 5500
		t.Fatal(err)
	}
	if _, err := Settle(s2, "k", 4000, id2, 12000, 4000, true); err == nil {
		t.Fatal("settle succeeded after void")
	}
}

func TestInvariant_LosingStakeForfeited(t *testing.T) {
	s, id := setup(t)
	// "a" bets BOTH outcomes; only the winning-outcome stake pays.
	bet(t, s, "a", id, 1, "10000") // winning
	bet(t, s, "a", id, 0, "40000") // losing
	bet(t, s, "b", id, 0, "10000")
	pool := getMoney(s, rk(id, "pool")) // 60000
	Settle(s, "k", 4000, id, 12000, 4000, true) // outcome 1 wins, winPool=10000
	p, _, _ := Claim(s, "a", id)
	distributable := new(big.Int).Sub(pool, mMulBpsDiv(pool, DefaultFeeBps))
	// a is the sole winner ⇒ gets all distributable; the 40000 losing stake is forfeited, NOT added.
	if p.Cmp(distributable) != 0 {
		t.Fatalf("winner got %s want %s (losing stake must be forfeited, not refunded)", p, distributable)
	}
}

func TestInvariant_NoDoubleClaim(t *testing.T) {
	s, id := setup(t)
	bet(t, s, "a", id, 1, "10000")
	bet(t, s, "b", id, 0, "10000")
	Settle(s, "k", 4000, id, 12000, 4000, true)
	if _, _, err := Claim(s, "a", id); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Claim(s, "a", id); err == nil {
		t.Fatal("double claim allowed")
	}
}

func TestInvariant_BetAfterLockRejected(t *testing.T) {
	s, id := setup(t) // lock=100
	if err := RecordBet(s, "a", 1999, id, 1, mp(t, "10000")); err != nil {
		t.Fatalf("bet at lock-1 should pass: %v", err)
	}
	if err := RecordBet(s, "a", 2000, id, 1, mp(t, "10000")); err == nil {
		t.Fatal("bet at lock accepted")
	}
	if err := RecordBet(s, "a", 2001, id, 1, mp(t, "10000")); err == nil {
		t.Fatal("bet after lock accepted")
	}
}

func TestInvariant_VoidRefundSumsAllOutcomes(t *testing.T) {
	s, id := setup(t)
	bet(t, s, "a", id, 1, "7000")
	bet(t, s, "a", id, 0, "3000") // a on both outcomes
	// single-sided-ish? both outcomes funded by a alone → funded==2 but let's force void via stale
	res, err := VoidStale(s, "k", 5501, id)
	if err != nil || res.State != StateVoid {
		t.Fatalf("void: %v %+v", err, res)
	}
	p, _, _ := Claim(s, "a", id)
	if p.Cmp(mp(t, "10000")) != 0 {
		t.Fatalf("void refund %s, want 10000 (sum across outcomes)", p)
	}
}

func TestInvariant_WithdrawFeesNeverExceedsAccrued(t *testing.T) {
	// Zero-rake by default; enable a fee to exercise the withdraw-solvency invariant.
	s := newMem()
	if err := Init(s, owner); err != nil {
		t.Fatal(err)
	}
	const feeBps = 200
	if err := SetFeeBps(s, owner, feeBps); err != nil {
		t.Fatal(err)
	}
	id, err := CreateRound(s, owner, 0, CreateParams{Asset: AssetHbd, Strikes: []uint64{10000}, LockBlock: 2000, SettleBlock: 4000, GraceBlocks: 300})
	if err != nil {
		t.Fatal(err)
	}
	bet(t, s, "a", id, 1, "40000")
	bet(t, s, "b", id, 0, "40000")
	pool := getMoney(s, rk(id, "pool")) // 80000
	Settle(s, "k", 4000, id, 12000, 4000, true)
	fee := mMulBpsDiv(pool, feeBps)                   // 1600
	bounty := computeBounty(pool, fee)       // %-of-pool (SettleBountyBps), capped at fee
	feeRest := new(big.Int).Sub(fee, bounty) // fee - bounty accrues to owner
	amt, _, err := WithdrawFees(s, owner, AssetHbd)
	if err != nil {
		t.Fatal(err)
	}
	if amt.Cmp(feeRest) != 0 {
		t.Fatalf("withdrew %s want %s", amt, feeRest)
	}
	if _, _, err := WithdrawFees(s, owner, AssetHbd); err == nil {
		t.Fatal("second withdraw of empty fee balance succeeded")
	}
}

func TestDegenerate_SingleSidedVoids(t *testing.T) {
	s, id := setup(t)
	bet(t, s, "a", id, 1, "10000") // only one outcome funded
	res, err := Settle(s, "k", 4000, id, 12000, 4000, true)
	if err != nil || res.State != StateVoid {
		t.Fatalf("single-sided should VOID: %v %+v", err, res)
	}
	p, _, _ := Claim(s, "a", id)
	if p.Cmp(mp(t, "10000")) != 0 {
		t.Fatalf("single-sided void refund %s want 10000", p)
	}
}

func TestDegenerate_ZeroWinnerVoids(t *testing.T) {
	s, id := setup(t)
	bet(t, s, "a", id, 0, "10000")
	bet(t, s, "b", id, 0, "20000") // both on outcome 0
	// price above strike → outcome 1 wins, but winPool==0 → VOID
	res, err := Settle(s, "k", 4000, id, 12000, 4000, true)
	if err != nil || res.State != StateVoid {
		t.Fatalf("zero-winner should VOID: %v %+v", err, res)
	}
}

func TestSettleWindow_PastWindowVoids(t *testing.T) {
	s, id := setup(t)
	bet(t, s, "a", id, 1, "10000")
	bet(t, s, "b", id, 0, "10000")
	res, err := Settle(s, "k", 4000+SettleWindowBlocks+1, id, 12000, 4000, true)
	if err != nil || res.State != StateVoid {
		t.Fatalf("past settle window should VOID: %v %+v", err, res)
	}
}

func TestSettle_FeedNotOkWithinWindowErrors(t *testing.T) {
	s, id := setup(t)
	bet(t, s, "a", id, 1, "10000")
	bet(t, s, "b", id, 0, "10000")
	if _, err := Settle(s, "k", 4000, id, 12000, 1, false); err == nil {
		t.Fatal("settle with feed not ok should error (retry/void), not settle")
	}
	if roundState(s, id) != StateOpen {
		t.Fatal("round changed state on failed settle")
	}
}

func TestBoundary_PriceOnStrikeIsUpperBucket(t *testing.T) {
	// strike 10000; price exactly 10000 → bucket 1 (upper).
	if bucketFor(10000, []uint64{10000}) != 1 {
		t.Fatal("price==strike must map to the upper bucket")
	}
	if bucketFor(9999, []uint64{10000}) != 0 {
		t.Fatal("price below strike → lower bucket")
	}
}

func TestBet_BelowMinRejected(t *testing.T) {
	s, id := setup(t)
	if err := RecordBet(s, "a", 10, id, 1, mp(t, "999")); err == nil {
		t.Fatal("below-min bet accepted")
	}
}

func TestCreateRound_Validation(t *testing.T) {
	s := newMem()
	Init(s, owner)
	bad := []CreateParams{
		{Asset: "eth", Strikes: []uint64{1}, LockBlock: 10, SettleBlock: 20},               // non-native
		{Asset: AssetHbd, Strikes: []uint64{}, LockBlock: 10, SettleBlock: 20},              // <2 outcomes
		{Asset: AssetHbd, Strikes: []uint64{5, 5}, LockBlock: 10, SettleBlock: 20},          // non-increasing
		{Asset: AssetHbd, Strikes: []uint64{10000}, LockBlock: 0, SettleBlock: 20},          // lock not future
		{Asset: AssetHbd, Strikes: []uint64{10000}, LockBlock: 10, SettleBlock: 10},         // settle<=lock
	}
	for i, p := range bad {
		if _, err := CreateRound(s, owner, 0, p); err == nil {
			t.Fatalf("bad params %d accepted", i)
		}
	}
	if _, err := CreateRound(s, "hive:notowner", 0, CreateParams{Asset: AssetHbd, Strikes: []uint64{10000}, LockBlock: 10, SettleBlock: 20}); err == nil {
		t.Fatal("non-owner created a round")
	}
}

func TestVoidStale_CannotPreemptDuringSettleWindow(t *testing.T) {
	// Review finding 1: a losing bettor must not be able to voidStale a healthy,
	// settleable round during the settle window to dodge their loss.
	s, id := setup(t)
	bet(t, s, "a", id, 1, "40000")
	bet(t, s, "b", id, 0, "40000")
	// During the window (block 4500 < 5500) voidStale must be rejected.
	if _, err := VoidStale(s, "loser", 4500, id); err == nil {
		t.Fatal("voidStale preempted a settleable round during the window")
	}
	// settle still resolves normally in the same block.
	res, err := Settle(s, "k", 4500, id, 12000, 4000, true)
	if err != nil || res.State != StateSettled {
		t.Fatalf("settle should resolve: %v %+v", err, res)
	}
}

func TestVoidStale_AfterWindowVoids(t *testing.T) {
	s, id := setup(t)
	bet(t, s, "a", id, 1, "10000")
	if _, err := VoidStale(s, "k", 4000+SettleWindowBlocks+300+1, id); err != nil {
		t.Fatalf("voidStale after window+grace should succeed: %v", err)
	}
	if roundState(s, id) != StateVoid {
		t.Fatal("round not voided")
	}
}

func TestCreateRound_MinSettleGapEnforced(t *testing.T) {
	s := newMem()
	Init(s, owner)
	// settle just 10 blocks after lock (< MinSettleGapBlocks) must be rejected.
	if _, err := CreateRound(s, owner, 0, CreateParams{
		Asset: AssetHbd, Strikes: []uint64{10000}, LockBlock: 100, SettleBlock: 110, GraceBlocks: 0,
	}); err == nil {
		t.Fatal("round with sub-minimum lock->settle gap accepted")
	}
}

func TestOwnership_TwoStep(t *testing.T) {
	s := newMem()
	Init(s, owner)
	if err := ChangeOwner(s, owner, "hive:new"); err != nil {
		t.Fatal(err)
	}
	if err := AcceptOwnership(s, "hive:wrong"); err == nil {
		t.Fatal("wrong account accepted ownership")
	}
	if err := AcceptOwnership(s, "hive:new"); err != nil {
		t.Fatal(err)
	}
	if getStr(s, kOwner()) != "hive:new" {
		t.Fatal("ownership not transferred")
	}
}


func TestTransparency_VoidReasonRecorded(t *testing.T) {
	s, id := setup(t)
	bet(t, s, "a", id, 1, "10000") // single-sided → underfunded void
	res, _ := Settle(s, "k", 4000, id, 12000, 4000, true)
	if res.Reason != VoidUnderfunded {
		t.Fatalf("void reason = %q want %q", res.Reason, VoidUnderfunded)
	}
	if getStr(s, rk(id, "vr")) != VoidUnderfunded {
		t.Fatal("void reason not recorded on-chain")
	}
}

func TestTransparency_MetadataStored(t *testing.T) {
	s := newMem()
	Init(s, owner)
	id, err := CreateRound(s, owner, 0, CreateParams{
		Asset: AssetHbd, Strikes: []uint64{10000}, LockBlock: 2000, SettleBlock: 4000, GraceBlocks: 300,
		Label: "Will HIVE be above par this week?", Creator: "hive:analyst",
	})
	if err != nil {
		t.Fatal(err)
	}
	if getStr(s, rk(id, "label")) != "Will HIVE be above par this week?" {
		t.Fatal("label not stored")
	}
	if getStr(s, rk(id, "creator")) != "hive:analyst" {
		t.Fatal("creator not stored")
	}
	if getStr(s, rk(id, "unit")) != SettleUnit {
		t.Fatal("unit not stored")
	}
}

func TestTransparency_ParamsReadableOnChain(t *testing.T) {
	s := newMem()
	Init(s, owner)
	if getStr(s, "p|min_bet") != MinBet {
		t.Fatal("min_bet not readable on-chain")
	}
	if getU64(s, "p|max_fee_bps") != MaxFeeBps {
		t.Fatal("max_fee_bps not readable")
	}
	if getStr(s, "p|unit") != SettleUnit {
		t.Fatal("unit not readable")
	}
}

func TestCreateRound_DefaultCreatorIsCaller(t *testing.T) {
	s := newMem()
	Init(s, owner)
	id, _ := CreateRound(s, owner, 0, CreateParams{Asset: AssetHbd, Strikes: []uint64{10000}, LockBlock: 2000, SettleBlock: 4000, GraceBlocks: 300})
	if getStr(s, rk(id, "creator")) != owner {
		t.Fatal("creator should default to caller")
	}
}
