package market

import (
	"math/big"
	"strings"
	"testing"
)

// Pins for build-map findings F-P4 (failure-path cluster) and F-P6 (oracle
// tick-cadence determinism). See BM-pm-recsys.md §F-P4 / §F-P6.

// ─────────────────────────────────────────────────────────────────────────────
// F-P4 sub-item 2 — getU64→0 reclaim/voidStale deadline-gate collapse.
//
// A well-formed round always has settle>0 (create.go:89-94). getU64 returns 0 on
// a missing/corrupt value, which collapses the deadline gate
// `block <= settleBlock+SettleWindowBlocks+grace` to `block <= 1200+grace`, so a
// corrupt round becomes reclaimable/void-able ~settleBlock blocks EARLY — while it
// should still be live. The guard converts that silent early-fire into an explicit
// corrupt-state refusal. The chosen block (3000) sits STRICTLY between the
// collapsed deadline (0+1200+300=1500) and the true deadline (4000+1200+300=5500):
// without the guard the call would wrongly fire here; with it, it must refuse and
// leave the round untouched.
// ─────────────────────────────────────────────────────────────────────────────

func TestReclaim_RefusesZeroSettle(t *testing.T) {
	s := newMem()
	if err := Init(s, owner); err != nil {
		t.Fatal(err)
	}
	id, err := CreateRound(s, owner, 0, CreateParams{
		Asset: AssetHive, Strikes: []uint64{10000}, LockBlock: 2000, SettleBlock: 4000, GraceBlocks: 300,
	})
	if err != nil {
		t.Fatal(err)
	}
	bet(t, s, "alice", id, 0, "10000")

	// Corrupt the settle height to 0 (also what getU64 yields on a garbage value).
	s.Set(rk(id, "settle"), "0")
	const block = uint64(3000) // 1500 (collapsed) < 3000 < 5500 (true deadline)

	_, _, err = Reclaim(s, "alice", block, id)
	if err == nil {
		t.Fatal("reclaim succeeded on a zero/corrupt settle height — the collapsed deadline gate let it fire early")
	}
	merr, ok := err.(*Err)
	if !ok || merr.Symbol != ErrState {
		t.Fatalf("want *Err ErrState, got %v", err)
	}
	if !strings.Contains(merr.Msg, "settle height") {
		t.Fatalf("want the corrupt-state guard message, got %q — a different check may have masked the guard", merr.Msg)
	}
	// The guard must leave the round UNTOUCHED: no early void, no refund path run.
	if st := roundState(s, id); st != StateOpen {
		t.Fatalf("guard voided the round (state=%q); it must refuse and leave it OPEN", st)
	}
	if getStr(s, rkClaimed(id, "alice")) == "1" {
		t.Fatal("guard ran the refund path (claimed flag set); it must refuse before any payout")
	}
}

func TestVoidStale_RefusesZeroSettle(t *testing.T) {
	s := newMem()
	if err := Init(s, owner); err != nil {
		t.Fatal(err)
	}
	id, err := CreateRound(s, owner, 0, CreateParams{
		Asset: AssetHive, Strikes: []uint64{10000}, LockBlock: 2000, SettleBlock: 4000, GraceBlocks: 300,
	})
	if err != nil {
		t.Fatal(err)
	}
	bet(t, s, "a", id, 0, "10000")
	bet(t, s, "b", id, 1, "10000")

	s.Set(rk(id, "settle"), "0")
	const block = uint64(3000) // between collapsed 1500 and true 5500

	_, err = VoidStale(s, "a", block, id)
	if err == nil {
		t.Fatal("voidStale succeeded on a zero/corrupt settle height — the collapsed deadline gate let it fire early")
	}
	merr, ok := err.(*Err)
	if !ok || merr.Symbol != ErrState {
		t.Fatalf("want *Err ErrState, got %v", err)
	}
	if !strings.Contains(merr.Msg, "settle height") {
		t.Fatalf("want the corrupt-state guard message, got %q", merr.Msg)
	}
	if st := roundState(s, id); st != StateOpen {
		t.Fatalf("guard voided the round (state=%q); it must refuse and leave it OPEN", st)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// F-P4 sub-item 3 — same-block Claim-vs-Sweep race. `owed` is the single
// accounting source: Claim decrements it by the payout, Sweep takes only the
// remaining `owed`, so Σ(claims)+sweep == distributable regardless of ordering,
// and a claimant preempted by the sweep can never double-collect. No guard is
// needed; this is the regression pin proving the invariant holds both ways.
// ─────────────────────────────────────────────────────────────────────────────

func TestClaimThenSweep_And_SweepThenClaim_ConserveOwed(t *testing.T) {
	// Two winners on the same bucket + a loser; zero-rake ⇒ distributable == pool.
	build := func() (*memStore, uint64, *big.Int, uint64) {
		s := newMem()
		if err := Init(s, owner); err != nil {
			t.Fatal(err)
		}
		id, err := CreateRound(s, owner, 0, CreateParams{
			Asset: AssetHive, Strikes: []uint64{10000}, LockBlock: 2000, SettleBlock: 4000, GraceBlocks: 300,
		})
		if err != nil {
			t.Fatal(err)
		}
		bet(t, s, "winA", id, 1, "10000")
		bet(t, s, "winB", id, 1, "10000")
		bet(t, s, "loser", id, 0, "10000")
		if _, err := Settle(s, "k", 4000, id, 12000, 4000, true); err != nil { // bucket 1 wins
			t.Fatal(err)
		}
		distributable := getMoney(s, rk(id, "drem")) // == pool (zero rake)
		sweepBlock := uint64(4000) + ClaimWindowBlocks + 1
		return s, id, distributable, sweepBlock
	}

	// Ordering A: winA claims, THEN the round is swept in the same (min-legal) block.
	{
		s, id, distributable, sweepBlock := build()
		out := big.NewInt(0)
		pA, _, err := Claim(s, "winA", id)
		if err != nil {
			t.Fatalf("claim winA: %v", err)
		}
		out.Add(out, pA)
		amt, _, err := SweepUnclaimed(s, sweepBlock, id)
		if err != nil {
			t.Fatalf("sweep after claim: %v", err)
		}
		out.Add(out, amt)
		// winB was preempted by the sweep and can NEVER double-collect from the DHF.
		if _, _, err := Claim(s, "winB", id); err == nil {
			t.Fatal("claim-after-sweep (winB) succeeded — double spend against the DHF")
		}
		if out.Cmp(distributable) != 0 {
			t.Fatalf("claim-then-sweep: Σ(claims)+sweep = %s != distributable %s", out, distributable)
		}
	}

	// Ordering B: sweep FIRST, then the claims — both claims must be refused; the
	// sweep took the whole remaining `owed`.
	{
		s, id, distributable, sweepBlock := build()
		out := big.NewInt(0)
		amt, _, err := SweepUnclaimed(s, sweepBlock, id)
		if err != nil {
			t.Fatalf("sweep first: %v", err)
		}
		out.Add(out, amt)
		if _, _, err := Claim(s, "winA", id); err == nil {
			t.Fatal("claim-after-sweep (winA) succeeded — double spend")
		}
		if _, _, err := Claim(s, "winB", id); err == nil {
			t.Fatal("claim-after-sweep (winB) succeeded — double spend")
		}
		if out.Cmp(distributable) != 0 {
			t.Fatalf("sweep-then-claim: sweep = %s != distributable %s", out, distributable)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// F-P6 — settle-determinism across the tick window.
//
// The C1 anti-cherry-pick mitigation (settle.go + MaxSettleTickLag) rests on two
// facts about the go-vsc pendulum oracle, VERIFIED from source:
//   1. It ticks every DefaultTickIntervalBlocks = 100 (oracle/tracker.go:17), and
//      TickIfDue only recomputes the snapshot on multiples of 100 (tracker.go:293-296).
//   2. pendulum.hive_moving_avg_bps is the snapshot from LastTick(), written ONLY
//      inside TickIfDue (tracker.go:336) — constant between ticks
//      (state_engine.go:2669,2678).
//
// This test models that host exactly (tick = most-recent 100-block boundary; a
// DISTINCT MA per tick so an adjacent-tick reach WOULD land a different bucket) and
// proves that no matter which block in the window a caller picks, the only SETTLED
// winner obtainable is the single in-window tick's winner — a cherry-picker cannot
// reach the neighbour buckets (earlier blocks reject; later blocks VOID). Because
// tickHeight is DERIVED from the block, the test is sensitive to the
// MaxSettleTickLag/tick-interval relationship: widening the lag to admit a second
// tick would surface a second winner and fail assertion #2.
// ─────────────────────────────────────────────────────────────────────────────

func TestSettle_DeterministicAcrossTickWindow(t *testing.T) {
	const settleBlock = uint64(4000) // a tick boundary (multiple of 100)

	// Buckets via strikes {9000,11000}: 0=[,9000) 1=[9000,11000) 2=[11000,).
	maAt := func(tick uint64) uint64 {
		switch {
		case tick < settleBlock:
			return 8000 // → bucket 0
		case tick == settleBlock:
			return 10000 // → bucket 1  (the only settleable value in the window)
		default:
			return 12000 // → bucket 2
		}
	}
	strikes := []uint64{9000, 11000}
	wantWinner := bucketFor(10000, strikes) // 1

	build := func() (*memStore, uint64) {
		s := newMem()
		if err := Init(s, owner); err != nil {
			t.Fatal(err)
		}
		id, err := CreateRound(s, owner, 0, CreateParams{
			Asset: AssetHive, Strikes: strikes, LockBlock: 2000, SettleBlock: settleBlock, GraceBlocks: 300,
		})
		if err != nil {
			t.Fatal(err)
		}
		bet(t, s, "a", id, 0, "5000")
		bet(t, s, "b", id, 1, "5000")
		bet(t, s, "c", id, 2, "5000")
		return s, id
	}

	settledWinners := map[int]struct{}{}
	settledBlocks := 0
	// Sweep the previous tick, the in-window tick, and the next tick.
	for block := settleBlock - MaxSettleTickLag; block < settleBlock+2*MaxSettleTickLag; block++ {
		tick := (block / 100) * 100 // most-recent pendulum tick at/before this block
		s, id := build()
		res, err := Settle(s, "k", block, id, maAt(tick), tick, true)
		if err != nil {
			continue // rejected (too early / tick precedes settle) — cannot settle
		}
		if res.State == StateSettled {
			settledBlocks++
			settledWinners[res.Winner] = struct{}{}
			if res.Winner != wantWinner {
				t.Fatalf("block %d settled to winner %d, want the single in-window winner %d — cherry-pick reopened",
					block, res.Winner, wantWinner)
			}
		}
	}

	if settledBlocks == 0 {
		t.Fatal("no block settled across the window — vacuous; the window must contain a settleable block")
	}
	if len(settledWinners) != 1 {
		t.Fatalf("settlement is NOT deterministic across the window: settled winners %v (want exactly {%d})",
			settledWinners, wantWinner)
	}
	if _, ok := settledWinners[wantWinner]; !ok {
		t.Fatalf("the single settled winner is not %d: %v", wantWinner, settledWinners)
	}
}
