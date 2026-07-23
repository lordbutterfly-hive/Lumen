package scheduler

import (
	"testing"

	"hive-price-market/market"
)

func TestDecideKeeperAction(t *testing.T) {
	base := RoundSchedule{ID: 1, Asset: "hbd", State: market.StateOpen, SettleBlock: 1000, GraceBlocks: 300}
	// SettleWindowBlocks = 1200, MaxSettleTickLag = 100 (market/params.go).
	windowEnd := base.SettleBlock + market.SettleWindowBlocks   // 2200
	tickWindowEnd := base.SettleBlock + market.MaxSettleTickLag // 1100

	cases := []struct {
		name   string
		block  uint64
		tick   uint64
		feedOK bool
		round  RoundSchedule
		want   KeeperAction
	}{
		{"not open: settled -> wait", 5000, 5000, true, RoundSchedule{ID: 1, State: market.StateSettled, SettleBlock: 1000, GraceBlocks: 300}, KeeperWait},
		{"not open: void -> wait", 5000, 5000, true, RoundSchedule{ID: 1, State: market.StateVoid, SettleBlock: 1000, GraceBlocks: 300}, KeeperWait},

		{"before settle block (real chain height) -> wait", 999, 999, true, base, KeeperWait},

		{"at settle block, tick at settle, feed ok -> settle (happy path)", 1000, 1000, true, base, KeeperSettle},
		{"inside qualifying tick window, feed ok -> settle", 1050, 1050, true, base, KeeperSettle},
		{"at settle block, feed DOWN -> wait (predictable ErrOracle, retriable)", 1000, 1000, false, base, KeeperWait},
		{"at settle block, feed ok but tick hasn't reached settleBlock yet -> wait", 1000, 999, true, base, KeeperWait},

		{"qualifying tick missed (tick past settleBlock+MaxSettleTickLag), still in outer window, feed ok -> settle (fast VoidTickWindowMissed)", 1150, tickWindowEnd + 5, true, base, KeeperSettle},
		{"still in outer window, past tickWindowEnd, feed DOWN -> wait (no tick confirmation, retriable)", 1150, 1050, false, base, KeeperWait},

		{"outer window just lapsed, feed healthy -> settle", windowEnd + 1, windowEnd + 1, true, base, KeeperSettle},
		{"outer window lapsed, feed DOWN -> settle anyway (auto-VOID is oracle-independent, settle.go:41 checked before feedOK)", windowEnd + 1, 500, false, base, KeeperSettle},
		{"outer window lapsed, tick totally frozen far below settleBlock (dead oracle) -> settle anyway (block, not tick, drives this boundary)", windowEnd + 1, 0, false, base, KeeperSettle},
		{"long past window+grace, feed down -> settle (never needs to wait for the extra grace)", windowEnd + base.GraceBlocks + 1, 0, false, base, KeeperSettle},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := DecideKeeperAction(tc.block, tc.tick, tc.feedOK, tc.round)
			if got != tc.want {
				t.Fatalf("DecideKeeperAction(block=%d, tick=%d, feedOK=%v) = %v, want %v", tc.block, tc.tick, tc.feedOK, got, tc.want)
			}
		})
	}
}

func TestKeeperAction_String(t *testing.T) {
	if KeeperWait.String() != "wait" || KeeperSettle.String() != "settle" || KeeperVoidStale.String() != "void_stale" {
		t.Fatalf("String() outputs: wait=%q settle=%q void_stale=%q", KeeperWait.String(), KeeperSettle.String(), KeeperVoidStale.String())
	}
}
