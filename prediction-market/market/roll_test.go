package market

import "testing"

// The permissionless roll derives strikes + timing deterministically from the
// oracle reference price — no operator input, nothing to cherry-pick.
func TestRoll_DeterministicStrikesAndTiming(t *testing.T) {
	s := newMem()
	Init(s, owner)
	id, err := RollRound(s, 1000, 2940, true) // ref 2940 bps (~$0.294)
	if err != nil {
		t.Fatal(err)
	}
	strikes := roundStrikes(s, id)
	want := []uint64{2058, 2352, 2646, 3234, 3528, 3822} // 2940 * {7,8,9,11,12,13} / 10 (±10/20/30%)
	if len(strikes) != len(want) {
		t.Fatalf("got %d strikes, want %d", len(strikes), len(want))
	}
	if got := getStr(s, rk(id, "asset")); got != AssetHbd {
		t.Fatalf("roll asset = %q, want hbd (HBD stake token)", got)
	}
	for i := range want {
		if strikes[i] != want[i] {
			t.Fatalf("strike[%d] = %d, want %d", i, strikes[i], want[i])
		}
	}
	if got := getU64(s, rk(id, "lock")); got != 1000+RollBettingBlocks {
		t.Fatalf("lock = %d, want %d", got, 1000+RollBettingBlocks)
	}
	if got := getU64(s, rk(id, "settle")); got != 1000+RollBettingBlocks+RollSettleGapBlocks {
		t.Fatalf("settle = %d, want %d", got, 1000+RollBettingBlocks+RollSettleGapBlocks)
	}
	if getStr(s, rk(id, "creator")) != "protocol" {
		t.Fatalf("creator = %q, want protocol (no human created it)", getStr(s, rk(id, "creator")))
	}
	if getU64(s, rk(id, "refprice")) != 2940 {
		t.Fatal("refprice should record the oracle reference")
	}
	if roundState(s, id) != StateOpen {
		t.Fatal("rolled round should be OPEN")
	}
}

// It takes NO caller — anyone triggers it. That is the decentralization.
func TestRoll_Permissionless(t *testing.T) {
	s := newMem()
	Init(s, owner)
	if _, err := RollRound(s, 1000, 2940, true); err != nil {
		t.Fatalf("permissionless roll failed: %v", err)
	}
}

// A roll can't open a round without a valid reference price (dead/zero feed).
func TestRoll_RejectsBadFeed(t *testing.T) {
	s := newMem()
	Init(s, owner)
	if _, err := RollRound(s, 1000, 2940, false); err == nil {
		t.Fatal("roll with feedOK=false should fail")
	}
	if _, err := RollRound(s, 1000, 0, true); err == nil {
		t.Fatal("roll with zero reference price should fail")
	}
}

// The one-open-round guard makes the permissionless roll un-spammable: a new
// round can only be rolled once the previous one resolves.
func TestRoll_OneOpenRoundGuard(t *testing.T) {
	s := newMem()
	Init(s, owner)
	if _, err := RollRound(s, 1000, 2940, true); err != nil {
		t.Fatal(err)
	}
	if _, err := RollRound(s, 1100, 2950, true); err == nil {
		t.Fatal("second roll while a round is OPEN should fail (no overlap)")
	}
}
