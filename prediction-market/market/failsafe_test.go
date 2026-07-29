package market

import (
	"math/big"
	"testing"
)

// FAIL-SAFE — funds stuck ⇒ returned to sender. The catastrophe: a round is
// created, several people stake HIVE, then the ORACLE DIES and NO keeper ever
// runs, so the round never settles. Past the deadline, every staker
// unilaterally calls Reclaim and gets their FULL stake back — no owner, no
// oracle, no keeper involved. Σ refunds == pool: nothing stuck, nothing lost.
func TestFailsafe_StuckRound_AllStakersRecover(t *testing.T) {
	s := newMem()
	Init(s, owner)
	id, err := CreateRound(s, owner, 0, CreateParams{
		Asset: AssetHive, Strikes: []uint64{2646, 3234}, LockBlock: 2000, SettleBlock: 4000, GraceBlocks: 300,
	})
	if err != nil {
		t.Fatal(err)
	}
	people := []struct {
		name  string
		out   int
		stake string
	}{
		{"alice", 0, "5000"},
		{"bob", 1, "12000"},
		{"carol", 2, "8000"},
		{"dave", 0, "3000"},
		{"erin", 2, "20000"},
	}
	pool := big.NewInt(0)
	for _, p := range people {
		if err := RecordBet(s, p.name, 10, id, p.out, mp(t, p.stake)); err != nil {
			t.Fatalf("bet %s: %v", p.name, err)
		}
		pool.Add(pool, mp(t, p.stake))
	}

	// Hard deadline = settleBlock(4000) + SettleWindowBlocks + grace(300).
	deadline := uint64(4000) + SettleWindowBlocks + 300

	// BEFORE the deadline reclaim must refuse — a still-settleable round can't be
	// force-voided out from under a legitimate settle (no loss-dodge).
	if _, _, err := Reclaim(s, "alice", deadline, id); err == nil {
		t.Fatal("reclaim succeeded at the deadline boundary (must be STRICTLY after)")
	}

	// Oracle dead, nobody settled — past the deadline every staker reclaims.
	totalRefund := big.NewInt(0)
	for i, p := range people {
		refund, asset, err := Reclaim(s, p.name, deadline+1, id)
		if err != nil {
			t.Fatalf("reclaim %s: %v", p.name, err)
		}
		if asset != AssetHive {
			t.Fatalf("reclaim %s asset %q, want hive", p.name, asset)
		}
		if refund.Cmp(mp(t, p.stake)) != 0 {
			t.Fatalf("reclaim %s got %s, want full stake %s", p.name, refund, p.stake)
		}
		totalRefund.Add(totalRefund, refund)
		if i == 0 && roundState(s, id) != StateVoid {
			t.Fatal("first reclaim did not flip the stuck round to VOID")
		}
	}
	// Every HIVE staked came back — no funds stuck, none created.
	if totalRefund.Cmp(pool) != 0 {
		t.Fatalf("Σ refunds %s != pool %s (funds stuck or created)", totalRefund, pool)
	}
	// The void reason records WHY (fail-safe), and double-reclaim is rejected.
	if getStr(s, rk(id, "vr")) != VoidDeadlineReclaim {
		t.Fatalf("void reason %q, want %q", getStr(s, rk(id, "vr")), VoidDeadlineReclaim)
	}
	if _, _, err := Reclaim(s, "alice", deadline+2, id); err == nil {
		t.Fatal("double reclaim allowed")
	}
	t.Logf("FAIL-SAFE OK: oracle dead, no keeper, no owner — all %d stakers reclaimed Σ %d base units == pool. Nothing stuck.",
		len(people), totalRefund)
}

// Once a stuck round is reclaim-voided, the ordinary claim() path also refunds
// (reclaim and claim are interchangeable on a VOID round).
func TestFailsafe_ReclaimVoid_ThenClaimAlsoRefunds(t *testing.T) {
	s := newMem()
	Init(s, owner)
	id, _ := CreateRound(s, owner, 0, CreateParams{Asset: AssetHive, Strikes: []uint64{10000}, LockBlock: 2000, SettleBlock: 4000, GraceBlocks: 300})
	bet(t, s, "a", id, 0, "10000")
	bet(t, s, "b", id, 1, "7000")
	deadline := uint64(4000) + SettleWindowBlocks + 300
	// a reclaims (flips to VOID + gets refund); b then uses the NORMAL claim path.
	ra, _, err := Reclaim(s, "a", deadline+1, id)
	if err != nil || ra.Cmp(mp(t, "10000")) != 0 {
		t.Fatalf("reclaim a: %v refund %s", err, ra)
	}
	rb, _, err := Claim(s, "b", id)
	if err != nil || rb.Cmp(mp(t, "7000")) != 0 {
		t.Fatalf("claim b on reclaim-voided round: %v refund %s", err, rb)
	}
}

// Reclaim must NOT refund a loss on a round that settled normally within the
// window — else a loser dodges. It errors on SETTLED; the loser's claim() → 0.
func TestFailsafe_Reclaim_RefusesSettledRound(t *testing.T) {
	s := newMem()
	Init(s, owner)
	id, _ := CreateRound(s, owner, 0, CreateParams{Asset: AssetHive, Strikes: []uint64{10000}, LockBlock: 2000, SettleBlock: 4000, GraceBlocks: 300})
	bet(t, s, "win", id, 1, "10000")
	bet(t, s, "lose", id, 0, "10000")
	if _, err := Settle(s, "k", 4000, id, 12000, 4000, true); err != nil { // bucket 1 wins
		t.Fatal(err)
	}
	// The loser cannot use reclaim to claw back a real loss.
	if _, _, err := Reclaim(s, "lose", 4000+SettleWindowBlocks+301, id); err == nil {
		t.Fatal("reclaim refunded a loser on a SETTLED round (loss-dodge)")
	}
	if p, _, _ := Claim(s, "lose", id); p.Sign() != 0 {
		t.Fatalf("loser claim paid %s, want 0", p)
	}
}

// The pre-existing owner-less recovery (voidStale → claim) also returns funds —
// the baseline path that the reclaim fail-safe backs up with a simpler, single
// call. Proves there is more than one independent way out of a stuck round.
func TestFailsafe_ExistingVoidStalePathRecovers(t *testing.T) {
	s := newMem()
	Init(s, owner)
	id, _ := CreateRound(s, owner, 0, CreateParams{Asset: AssetHive, Strikes: []uint64{10000}, LockBlock: 2000, SettleBlock: 4000, GraceBlocks: 300})
	bet(t, s, "a", id, 0, "10000")
	bet(t, s, "b", id, 1, "10000")
	// No owner, no oracle: any staker voidStales past window+grace, then claims.
	if _, err := VoidStale(s, "a", 4000+SettleWindowBlocks+301, id); err != nil {
		t.Fatalf("voidStale: %v", err)
	}
	ra, _, _ := Claim(s, "a", id)
	rb, _, _ := Claim(s, "b", id)
	if ra.Cmp(mp(t, "10000")) != 0 || rb.Cmp(mp(t, "10000")) != 0 {
		t.Fatalf("refunds a=%s b=%s, want 10000 each", ra, rb)
	}
}

// ★ RECLAIM CANNOT BE USED TO WALK AWAY FROM A LIVE BET.
//
// The worry this pins: reclaim returns a staker's money, so if it were reachable
// while betting is open — or after the outcome starts to look bad but before the
// round resolves — it would be a free option. Stake, watch, and pull out if the
// price moves against you. That would be exploited immediately and it would make
// the pool meaningless.
//
// It is not reachable. Reclaim's gate is `block > settleBlock + SettleWindowBlocks
// + grace` (reclaim.go), and EVERY other path that can void a round is itself at
// or past settleBlock: settle refuses "too early to settle" below it
// (settle.go:36-38) and voidStale demands the same full deadline
// (settle.go:129-131). So there is no block at which a round is both bettable and
// reclaimable, and no back door via an early void.
//
// This test walks the whole timeline rather than just the boundary, because the
// boundary case alone would still pass if someone widened the gate to, say,
// `block > lockBlock`.
func TestFailsafe_Reclaim_RefusedWhileTheBetIsStillLive(t *testing.T) {
	s := newMem()
	Init(s, owner)
	const lock, settle, grace = uint64(2000), uint64(4000), uint64(300)
	id, err := CreateRound(s, owner, 0, CreateParams{
		Asset: AssetHive, Strikes: []uint64{2646, 3234}, LockBlock: lock, SettleBlock: settle, GraceBlocks: grace,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := RecordBet(s, "alice", 10, id, 1, mp(t, "9000")); err != nil {
		t.Fatal(err)
	}

	deadline := settle + SettleWindowBlocks + grace
	for _, tc := range []struct {
		block uint64
		when  string
	}{
		{10, "the block the bet was placed"},
		{lock / 2, "mid betting window"},
		{lock - 1, "one block before lock"},
		{lock, "the lock block itself"},
		{lock + 1, "locked, bets closed, outcome unknown"},
		{settle - 1, "one block before settlement is even allowed"},
		{settle, "the settle block — settle() is the only resolver here"},
		{settle + 1, "inside the settle window"},
		{settle + SettleWindowBlocks, "last block of the settle window"},
		{deadline, "the deadline itself (gate is STRICTLY after)"},
	} {
		if _, _, err := Reclaim(s, "alice", tc.block, id); err == nil {
			t.Fatalf("EXPLOITABLE: reclaim succeeded at block %d (%s) — a staker could exit a live bet", tc.block, tc.when)
		}
	}

	// And the round is still OPEN throughout: none of those attempts voided it,
	// which is the other half of the exploit (force a void, then everyone claims).
	if got := roundState(s, id); got != StateOpen {
		t.Fatalf("a refused reclaim changed round state to %q — it must leave the round untouched", got)
	}

	// Only past the full deadline does it work.
	refund, _, err := Reclaim(s, "alice", deadline+1, id)
	if err != nil {
		t.Fatalf("past the deadline reclaim must work: %v", err)
	}
	if refund.Cmp(mp(t, "9000")) != 0 {
		t.Fatalf("refund %s, want the full stake 9000", refund)
	}
}
