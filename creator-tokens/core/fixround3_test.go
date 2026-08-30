package core

import (
	"math/big"
	"testing"
)

// fixround3_test.go — named regression tests for adversarial FIX ROUND 3
// (2026-07-22). One test (or cluster) per finding id.
//
//	WINDDOWN-RESET-1  windDownOpenBlock unconditionally preferred retiredAt even
//	                  when the market had ALREADY been continuously winding down
//	                  (naturally FROZEN, un-renewable) BEFORE Retire was called,
//	                  re-arming ExitTaxDecayBlocks of force-push immunity.
//	                  -> FIX (2026-07-22): anchor to min(retiredAt, naturalFreeze).
//
// ★★ DISSOLVED BY A1 (owner ruling 2026-08-30), NOT FIXED AGAIN. A natural
// FROZEN is no longer a wind-down (market.go inWindDown): a lapsed market's
// holders keep the curve exit, no push can fire on it, and it is NOT
// "continuously winding down" before a later Retire — nothing was winding
// down. So the premise of WINDDOWN-RESET-1 (an earlier wind-down that a later
// Retire could re-anchor forward) cannot arise, and windDownOpenBlock has one
// anchor, retiredAt. The two tests that pinned the min() are replaced by ONE
// that asserts the new truth the same sequence now has to satisfy: lapse, then
// Retire, anchors AT the retire, and the fresh-holder protection runs a full
// ExitTaxDecayBlocks from THERE — a real assertion that fails if either the
// natural-freeze anchor or the min() ever comes back. The lead session asked
// for exactly this: establish whether the case dissolves and, if it does,
// delete it rather than keep a test that can no longer fail.
//
// GUARD: this touches only the push GATE (windDownOpenBlock), never the curve
// math or the reserve debit, so R === area(S) in the trading phase and the
// wind-down terminal exactness (C-24: a complete wind-down drains R to exactly
// 0) are unchanged — both asserted below.

func TestWindDownOpenBlock_LapseThenRetire_AnchorsAtRetire(t *testing.T) {
	s := NewMemStore()
	const c, holderA, holderB = "windreset", "alice", "bob"
	const reg = uint64(1_000_000)
	if err := Register(s, c, c, reg, 1000, MaxCap); err != nil {
		t.Fatal(err)
	}
	if _, err := Buy(s, holderA, c, reg+1, big.NewInt(10)); err != nil {
		t.Fatal(err)
	}
	if _, err := Buy(s, holderB, c, reg+1, big.NewInt(10)); err != nil {
		t.Fatal(err)
	}

	paidUntil := reg + SubscriptionPeriod    // 1,864,000
	naturalFreeze := paidUntil + GraceBlocks // 2,008,000
	if Phase(s, c, naturalFreeze) != StateFrozen {
		t.Fatalf("fixture: phase at naturalFreeze = %s, want FROZEN", Phase(s, c, naturalFreeze))
	}

	// Long past the freeze. Under the OLD ladder the market had been winding
	// down since naturalFreeze and a push would fire here. Under A1 nothing is
	// winding down: no anchor, no push, curve exit intact.
	past := naturalFreeze + ExitTaxDecayBlocks + 10 // 3,217,610
	if open, ok := windDownOpenBlock(s, c, past); ok {
		t.Fatalf("A1: lapsed market reports wind-down open at %d; must be (0,false)", open)
	}
	if _, err := RefundHolder(s, "keeper", c, holderA, past); errSymbol(err) != ErrState {
		t.Fatalf("A1: push on a lapsed market must be refused, got %v", err)
	}

	// Retire the lapsed market: THIS is where wind-down begins.
	if err := Retire(s, c, c, past); err != nil {
		t.Fatalf("Retire on a lapsed market must be legal: %v", err)
	}
	if open, ok := windDownOpenBlock(s, c, past); !ok || open != past {
		t.Fatalf("post-retire windDownOpen = (%d,%v), want (%d,true): the anchor is the retire, never the earlier freeze", open, ok, past)
	}

	// The fresh-holder protection runs a full ExitTaxDecayBlocks from the
	// RETIRE. Both clocks maximally fresh (griefer-refreshed): refused one block
	// short of the window, fires AT it. (Under the old min() anchor the window
	// would have been measured from naturalFreeze and both pushes would fire at
	// `past` already — the assertion below is what distinguishes the two.)
	fresh := past - 100
	setU64(s, kAcqBlock(c, holderA), fresh)
	setU64(s, kAcqBlock(c, holderB), fresh)
	short := past + ExitTaxDecayBlocks - 1
	setU64(s, kAcqBlock(c, holderA), short-100)
	setU64(s, kAcqBlock(c, holderB), short-100)
	if _, err := RefundHolder(s, "keeper", c, holderA, short); errSymbol(err) != ErrState {
		t.Fatalf("one block short of retireAt+ExitTaxDecayBlocks a fresh holder must be protected, got %v", err)
	}
	at := past + ExitTaxDecayBlocks
	setU64(s, kAcqBlock(c, holderA), at-100)
	setU64(s, kAcqBlock(c, holderB), at-100)
	for _, h := range []string{holderA, holderB} {
		if _, err := RefundHolder(s, "keeper", c, h, at); err != nil {
			t.Fatalf("AT retireAt+ExitTaxDecayBlocks the push of %s must fire despite a fresh clock: %v", h, err)
		}
	}
	if sup := getMoney(s, kSupply(c)); sup.Sign() != 0 {
		t.Fatalf("supply after both sweeps = %s, want 0", sup)
	}
	if res := getMoney(s, kReserve(c)); res.Sign() != 0 {
		t.Fatalf("reserve after complete wind-down = %s, want 0 (C-24)", res)
	}
	if !CloseIfDrained(s, c, at) {
		t.Fatal("market must CLOSE once drained — the DoS is bounded to ExitTaxDecayBlocks from the retire")
	}
}
