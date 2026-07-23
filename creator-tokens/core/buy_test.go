package core

import (
	"math/big"
	"testing"
)

// buy_test.go — Buy: exact amounts (money-math worked numbers), every guard,
// the C-19 fee/reserve separation, I1' (C-9), the hold clock at the buy site,
// the price-source wiring, and quote/execution equivalence.

func bySetup(cap int64) (*MemStore, string) {
	s := NewMemStore()
	setupMarket(s, "creatora", 100, cap)
	return s, "creatora"
}

func TestBuy_HappyPath_ExactAmounts(t *testing.T) {
	// Recomputed 2026-07-21 for RULING I (BasePrice=1000, a=63/8, b=21/8000);
	// the previous expectations (cost 577 etc.) belonged to the withdrawn
	// pure-linear PS=21/D=2 calibration.
	if BasePrice != 1000 || CurveLinNum != 63000 || CurveQuadNum != 21 || CurveDenom != 8000 {
		t.Fatalf("calibration changed — recompute these expectations; do NOT skip")
	}
	s, c := bySetup(1_000_000)

	r, err := Buy(s, "hodler", c, 200, big.NewInt(10))
	if err != nil {
		t.Fatal(err)
	}
	// cost = area(10) − area(0) = 10·1000 + floor((63000·55 + 21·385)/8000)
	// = 10000 + floor(434.135…) = 10,434 — the EXACT area step (RULING A /
	// curve.go L1; the floor is LIVE: ceil gives 10,435 and fails this).
	// fee = floor(1043.4) = 1043, split 521/522 (odd unit → platform),
	// total draw 11,477.
	if r.Cost.Cmp(big.NewInt(10_434)) != 0 || r.Fee.Cmp(big.NewInt(1043)) != 0 ||
		r.FeeCreator.Cmp(big.NewInt(521)) != 0 || r.FeePlatform.Cmp(big.NewInt(522)) != 0 ||
		r.TotalDue.Cmp(big.NewInt(11_477)) != 0 || r.Minted.Cmp(big.NewInt(10)) != 0 {
		t.Fatalf("BuyResult = cost %s fee %s (%s/%s) total %s minted %s, want 10434/1043(521/522)/11477/10",
			r.Cost, r.Fee, r.FeeCreator, r.FeePlatform, r.TotalDue, r.Minted)
	}

	// State: supply, reserve == the curve leg ONLY (C-19 — the fee is NOT in
	// the reserve), balance, clock, basis, fee pots.
	if got := getMoney(s, kSupply(c)); got.Cmp(big.NewInt(10)) != 0 {
		t.Fatalf("supply = %s, want 10", got)
	}
	if got := getMoney(s, kReserve(c)); got.Cmp(big.NewInt(10_434)) != 0 {
		t.Fatalf("reserve = %s, want 10434 — the curve leg only, never cost+fee (C-19)", got)
	}
	if got := getMoney(s, kBal(c, "hodler")); got.Cmp(big.NewInt(10)) != 0 {
		t.Fatalf("balance = %s, want 10", got)
	}
	if w := holderAcqBlock(s, c, "hodler"); w != 200 {
		t.Fatalf("wacq = %d, want the buy block 200 (fresh position, C-14)", w)
	}
	// RULING K deleted the cost basis (kBasis): the exit tax is gross proceeds
	// × τ(h), no realized-gain cap, so a buy no longer records what was paid.
	if got := getMoney(s, kFeeBal(c)); got.Cmp(big.NewInt(521)) != 0 {
		t.Fatalf("creator fee pot = %s, want 521 (pull, F8)", got)
	}
	if got := getMoney(s, kTreasury()); got.Cmp(big.NewInt(522)) != 0 {
		t.Fatalf("treasury = %s, want 522", got)
	}

	// THE equality invariant (C-9, RULING A): R === area(S), E === 0, after
	// every buy — no unallocated remainder, ever.
	e := new(big.Int).Sub(getMoney(s, kReserve(c)), Area(getMoney(s, kSupply(c))))
	if e.Sign() != 0 {
		t.Fatalf("E after first buy = %s, want exactly 0 (R === area(S) with equality — RULING A)", e)
	}

	// The curve became the price source: one observation, at the post-trade
	// marginal spotRate(10) = 1000 + floor((63000·10 + 21·100)/8000) = 1079,
	// at the buy block.
	if n := getU64(s, kObsIdx(c)); n != 1 {
		t.Fatalf("obs count = %d, want 1", n)
	}
	o, ok := readTwapObs(s, c, 0)
	if !ok || o.block != 200 || o.rate.Cmp(big.NewInt(1079)) != 0 {
		t.Fatalf("obs = {block %d rate %s}, want {200 1079} (spotRate of the post-trade supply)", o.block, o.rate)
	}
	if r.RateRecorded.Cmp(big.NewInt(1079)) != 0 {
		t.Fatalf("RateRecorded = %s, want 1079", r.RateRecorded)
	}
}

func TestBuy_SecondBuy_WorkedExample(t *testing.T) {
	// Recomputed 2026-07-21 for RULING I (was the "683" example at 21/2).
	if BasePrice != 1000 || CurveLinNum != 63000 || CurveQuadNum != 21 || CurveDenom != 8000 {
		t.Fatalf("calibration changed — recompute these expectations; do NOT skip")
	}
	s, c := bySetup(1_000_000)
	if _, err := Buy(s, "hodler", c, 200, big.NewInt(10)); err != nil {
		t.Fatal(err)
	}
	// From S=10, buying 5 costs area(15) − area(10) = 15,948 − 10,434 =
	// 5,514 (the exact area step), fee = floor(551.4) = 551, total 6,065.
	r, err := Buy(s, "attacker", c, 300, big.NewInt(5))
	if err != nil {
		t.Fatal(err)
	}
	if r.Cost.Cmp(big.NewInt(5514)) != 0 || r.Fee.Cmp(big.NewInt(551)) != 0 || r.TotalDue.Cmp(big.NewInt(6065)) != 0 {
		t.Fatalf("second buy = cost %s fee %s total %s, want 5514/551/6065 (RULING I exact-area)", r.Cost, r.Fee, r.TotalDue)
	}
	// Reserve = 10,434 + 5,514 = 15,948 = area(15) EXACTLY — the buys
	// telescope along the area function with zero dust (RULING A equality).
	if got := getMoney(s, kReserve(c)); got.Cmp(big.NewInt(15_948)) != 0 {
		t.Fatalf("reserve = %s, want 15948 (= 10434 + 5514 = area(15), equality — no dust)", got)
	}
	// Two distinct-block observations now exist.
	if n := getU64(s, kObsIdx(c)); n != 2 {
		t.Fatalf("obs count = %d, want 2", n)
	}
}

func TestBuy_ZeroPremine_CreatorHoldsNothing(t *testing.T) {
	s, c := bySetup(1_000_000)
	if _, err := Buy(s, "fan1", c, 200, big.NewInt(100)); err != nil {
		t.Fatal(err)
	}
	if got := getMoney(s, kBal(c, c)); !mIsZero(got) {
		t.Fatalf("creator balance = %s after a fan's buy — premine is forbidden", got)
	}
}

func TestBuy_Guards(t *testing.T) {
	mk := func() (*MemStore, string) { return bySetup(1000) }

	t.Run("invalid-caller", func(t *testing.T) {
		s, c := mk()
		if _, err := Buy(s, "bad|pipe", c, 200, big.NewInt(1)); errSymbol(err) != ErrAuth {
			t.Fatalf("err = %v, want %s", err, ErrAuth)
		}
	})
	t.Run("invalid-creator", func(t *testing.T) {
		s, _ := mk()
		if _, err := Buy(s, "alice", "bad|pipe", 200, big.NewInt(1)); errSymbol(err) != ErrInput {
			t.Fatalf("err = %v, want %s", err, ErrInput)
		}
	})
	t.Run("no-such-market", func(t *testing.T) {
		s := NewMemStore()
		if _, err := Buy(s, "alice", "ghost", 200, big.NewInt(1)); errSymbol(err) != ErrNotFound {
			t.Fatalf("err = %v, want %s", err, ErrNotFound)
		}
	})
	t.Run("paused-buy-IS-blocked", func(t *testing.T) {
		// Buy is an INFLOW — the one curve side the pause legitimately gates
		// (the mirror of TestSell_IgnoresGlobalPause).
		s, c := mk()
		setStr(s, kPaused(), "1")
		if _, err := Buy(s, "alice", c, 200, big.NewInt(1)); errSymbol(err) != ErrPaused {
			t.Fatalf("err = %v, want %s", err, ErrPaused)
		}
	})
	t.Run("frozen-rejected", func(t *testing.T) {
		s, c := mk()
		setU64(s, kPaidUntil(c), 100)
		if _, err := Buy(s, "alice", c, 100+GraceBlocks, big.NewInt(1)); errSymbol(err) != ErrState {
			t.Fatalf("err = %v, want %s", err, ErrState)
		}
	})
	// UPDATED 2026-07-22 (ruled behaviour changed — RULING K3, the retire
	// notice DROPS the curve rail). A retired market is winding down for BOTH
	// rails from the retire block on: inflows are REFUSED (RequireInflowOpen
	// consults marketRetired) and exits route through the flat pro-rata Refund,
	// NOT the curve. This reverses the part of RULING D that kept Buy open
	// during the notice — that was THM-1's first-mover race. So a Buy anywhere
	// from the retire block onward (during the OVERDUE notice AND after it
	// freezes) is now REJECTED. Both probes are asserted so the close can never
	// silently regress back to the racy notice.
	t.Run("retired-closes-inflows-during-notice-and-after", func(t *testing.T) {
		s, c := mk()
		if err := Retire(s, c, c, 300); err != nil {
			t.Fatal(err)
		}
		if _, err := Buy(s, "alice", c, 301, big.NewInt(1)); errSymbol(err) != ErrState {
			t.Fatalf("buy inside the retire notice: err = %v, want %s (RULING K3 closes inflows the instant a market retires)", err, ErrState)
		}
		if _, err := Buy(s, "alice", c, 300+GraceBlocks, big.NewInt(1)); errSymbol(err) != ErrState {
			t.Fatalf("buy AT retiredAt+GraceBlocks: err = %v, want %s (the market is FROZEN and retired)", err, ErrState)
		}
	})
	t.Run("overdue-still-open", func(t *testing.T) {
		s, c := mk()
		setU64(s, kPaidUntil(c), 100)
		if _, err := Buy(s, "alice", c, 150, big.NewInt(1)); err != nil {
			t.Fatalf("OVERDUE buy failed: %v — grace is fully functional", err)
		}
	})
	t.Run("nil-n", func(t *testing.T) {
		s, c := mk()
		if _, err := Buy(s, "alice", c, 200, nil); errSymbol(err) != ErrInput {
			t.Fatalf("err = %v, want %s", err, ErrInput)
		}
	})
	t.Run("zero-n", func(t *testing.T) {
		s, c := mk()
		if _, err := Buy(s, "alice", c, 200, mZero()); errSymbol(err) != ErrInput {
			t.Fatalf("err = %v, want %s", err, ErrInput)
		}
	})
	t.Run("cap-exact-fill-ok-one-more-rejected", func(t *testing.T) {
		s, c := mk() // cap 1000
		if _, err := Buy(s, "alice", c, 200, big.NewInt(1000)); err != nil {
			t.Fatalf("exact-fill buy failed: %v", err)
		}
		if _, err := Buy(s, "bob", c, 201, big.NewInt(1)); errSymbol(err) != ErrCap {
			t.Fatalf("err = %v, want %s", err, ErrCap)
		}
	})
}

func TestBuy_RejectedCallMutatesNothing(t *testing.T) {
	s, c := bySetup(10)
	before := hzSnapshotAll(s)
	if _, err := Buy(s, "alice", c, 200, big.NewInt(11)); errSymbol(err) != ErrCap {
		t.Fatalf("expected cap rejection, got %v", err)
	}
	if changed := hzChangedKeys(before, hzSnapshotAll(s)); len(changed) != 0 {
		t.Fatalf("rejected Buy mutated state: %v", changed)
	}
}

func TestQuoteBuy_MatchesExecution_AndWritesNothing(t *testing.T) {
	s, c := bySetup(1_000_000)
	if _, err := Buy(s, "hodler", c, 200, big.NewInt(10)); err != nil {
		t.Fatal(err)
	}

	before := hzSnapshotAll(s)
	q, err := QuoteBuy(s, c, 300, big.NewInt(5))
	if err != nil {
		t.Fatal(err)
	}
	if changed := hzChangedKeys(before, hzSnapshotAll(s)); len(changed) != 0 {
		t.Fatalf("QuoteBuy wrote state: %v", changed)
	}

	r, err := Buy(s, "attacker", c, 300, big.NewInt(5))
	if err != nil {
		t.Fatal(err)
	}
	if q.Cost.Cmp(r.Cost) != 0 || q.Fee.Cmp(r.Fee) != 0 || q.TotalDue.Cmp(r.TotalDue) != 0 ||
		q.FeeCreator.Cmp(r.FeeCreator) != 0 || q.FeePlatform.Cmp(r.FeePlatform) != 0 {
		t.Fatalf("quote/execution drift: quote {%s %s %s} vs exec {%s %s %s}",
			q.Cost, q.Fee, q.TotalDue, r.Cost, r.Fee, r.TotalDue)
	}
}

// Same-block trades feed at most ONE observation (RecordObs first-writer-wins
// — the anti-domination property twap.go documents).
func TestBuy_SameBlockSecondObsIgnored(t *testing.T) {
	s, c := bySetup(1_000_000)
	if _, err := Buy(s, "alice", c, 200, big.NewInt(10)); err != nil {
		t.Fatal(err)
	}
	if _, err := Buy(s, "bob", c, 200, big.NewInt(5)); err != nil {
		t.Fatal(err)
	}
	if n := getU64(s, kObsIdx(c)); n != 1 {
		t.Fatalf("obs count = %d, want 1 (one observation per block, max)", n)
	}
}
