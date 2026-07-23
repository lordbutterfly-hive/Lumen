package market

import (
	"math/big"
	"testing"
)

// A settled round where a WINNER never claims: after the claim window, their
// abandoned winnings are swept to the DHF (@hive.fund), not burned or stranded.
// Conservation: claimed + swept == pool, exactly.
func TestSweep_UnclaimedWinnings_ToDHF(t *testing.T) {
	s := newMem()
	Init(s, owner)
	id, _ := CreateRound(s, owner, 0, CreateParams{Asset: AssetHive, Strikes: []uint64{10000}, LockBlock: 2000, SettleBlock: 4000, GraceBlocks: 300})
	bet(t, s, "winA", id, 1, "10000")
	bet(t, s, "winB", id, 1, "10000") // never claims
	bet(t, s, "loser", id, 0, "10000")
	pool := getMoney(s, rk(id, "pool")) // 30000
	if _, err := Settle(s, "k", 4000, id, 12000, 4000, true); err != nil {
		t.Fatal(err) // bucket 1 wins
	}

	// winA and the loser claim; winB abandons their share.
	pWinA, _, _ := Claim(s, "winA", id) // floor(10000*30000/20000) = 15000
	pLose, _, _ := Claim(s, "loser", id)
	if pWinA.Cmp(mp(t, "15000")) != 0 || pLose.Sign() != 0 {
		t.Fatalf("winA %s (want 15000), loser %s (want 0)", pWinA, pLose)
	}

	// Sweep too early is refused (winB could still show up).
	if _, _, err := SweepUnclaimed(s, 4000+ClaimWindowBlocks, id); err == nil {
		t.Fatal("sweep succeeded at the window boundary (must be strictly after)")
	}
	// Past the claim window: winB's unclaimed 15000 sweeps to the DHF.
	amt, dhf, err := SweepUnclaimed(s, 4000+ClaimWindowBlocks+1, id)
	if err != nil {
		t.Fatal(err)
	}
	if dhf != DHFAccount || DHFAccount != "hive:hive.fund" {
		t.Fatalf("swept to %q, want the DHF %q", dhf, DHFAccount)
	}
	if amt.Cmp(mp(t, "15000")) != 0 {
		t.Fatalf("swept %s, want winB's unclaimed 15000", amt)
	}
	// CONSERVATION: everything went to a claimant or the DHF, nothing lost/created.
	out := new(big.Int).Add(pWinA, amt)
	if out.Cmp(pool) != 0 {
		t.Fatalf("claimed 15000 + swept %s != pool %s", amt, pool)
	}
	// After the sweep, winB can no longer claim — the funds are at the DHF.
	if _, _, err := Claim(s, "winB", id); err == nil {
		t.Fatal("winB claimed after the sweep (would double-spend the DHF)")
	}
	t.Logf("SWEEP OK: winB's unclaimed 15000 → DHF %s; claimed 15000 + swept 15000 == pool 30000.", dhf)
}

// A VOID round where a staker abandons their refund: it too sweeps to the DHF.
func TestSweep_VoidAbandonedRefund_ToDHF(t *testing.T) {
	s := newMem()
	Init(s, owner)
	id, _ := CreateRound(s, owner, 0, CreateParams{Asset: AssetHive, Strikes: []uint64{10000}, LockBlock: 2000, SettleBlock: 4000, GraceBlocks: 300})
	bet(t, s, "a", id, 0, "10000")
	bet(t, s, "b", id, 0, "20000") // both on bucket 0 → winning bucket empty → VOID
	if _, err := Settle(s, "k", 4000, id, 12000, 4000, true); err != nil {
		t.Fatal(err)
	}
	if roundState(s, id) != StateVoid {
		t.Fatal("expected zero-winner VOID")
	}
	ra, _, _ := Claim(s, "a", id) // a refunds 10000; b abandons 20000
	if ra.Cmp(mp(t, "10000")) != 0 {
		t.Fatalf("a refund %s, want 10000", ra)
	}
	amt, dhf, err := SweepUnclaimed(s, 4000+ClaimWindowBlocks+1, id)
	if err != nil {
		t.Fatal(err)
	}
	if amt.Cmp(mp(t, "20000")) != 0 || dhf != DHFAccount {
		t.Fatalf("swept %s to %s, want 20000 to the DHF", amt, dhf)
	}
}

// The claim window gates the SWEEP, never a claim: a (very late) claimant is
// still paid in full right up until someone actually sweeps.
func TestSweep_ClaimStillWorksUntilSwept(t *testing.T) {
	s := newMem()
	Init(s, owner)
	id, _ := CreateRound(s, owner, 0, CreateParams{Asset: AssetHive, Strikes: []uint64{10000}, LockBlock: 2000, SettleBlock: 4000, GraceBlocks: 300})
	bet(t, s, "w", id, 1, "10000")
	bet(t, s, "l", id, 0, "10000")
	Settle(s, "k", 4000, id, 12000, 4000, true)
	// Well past the window, but nobody has swept yet: the winner still claims full.
	p, _, err := Claim(s, "w", id)
	if err != nil || p.Cmp(mp(t, "20000")) != 0 { // sole winner takes the whole distributable (pool, zero-rake)
		t.Fatalf("late claim before sweep: %v payout %s (want 20000)", err, p)
	}
	// Now everyone who was owed has claimed → nothing left to sweep.
	if _, _, err := SweepUnclaimed(s, 4000+ClaimWindowBlocks+1, id); err == nil {
		t.Fatal("sweep succeeded with nothing unclaimed")
	}
}

// A round can be swept at most once.
func TestSweep_NoDoubleSweep(t *testing.T) {
	s := newMem()
	Init(s, owner)
	id, _ := CreateRound(s, owner, 0, CreateParams{Asset: AssetHive, Strikes: []uint64{10000}, LockBlock: 2000, SettleBlock: 4000, GraceBlocks: 300})
	bet(t, s, "w", id, 1, "10000")
	bet(t, s, "l", id, 0, "10000")
	Settle(s, "k", 4000, id, 12000, 4000, true)
	// Nobody claims → the whole distributable sweeps.
	if _, _, err := SweepUnclaimed(s, 4000+ClaimWindowBlocks+1, id); err != nil {
		t.Fatal(err)
	}
	if _, _, err := SweepUnclaimed(s, 4000+ClaimWindowBlocks+2, id); err == nil {
		t.Fatal("second sweep of the same round succeeded")
	}
}
