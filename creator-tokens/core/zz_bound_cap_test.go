package core

import (
	"math/big"
	"testing"
)

// zz_bound_cap_test.go — PROOF 1: the per-cohort `lots|` ledger is BOUNDED.
//
// Before this fix the ledger appended one cohort per DISTINCT acq with no cap,
// so the number of cohorts (and the serialized value's size, and the parse cost
// every later Sell/Refund pays) grew linearly in the number of distinct-block
// inflows. Inflows are not self-inflicted — TransferCredits lets any account
// push one onto any holder — so the growth was an attacker-controlled,
// unbounded state-bloat / RC-exhaustion vector aimed at a VICTIM's position.
//
// These tests drive the real entrypoints (Buy, TransferCredits) as well as the
// raw inflow hook, and assert the cap holds after EVERY single inflow, not just
// at the end.

// zbMarket registers c and keeps it ACTIVE through `until`.
func zbMarket(t *testing.T, s *MemStore, c string, until uint64) {
	t.Helper()
	if err := Register(s, c, c, 1000, 1000, MaxCap); err != nil {
		t.Fatalf("Register(%s): %v", c, err)
	}
	setU64(s, kPaidUntil(c), until+SubscriptionPeriod)
}

// ---------------------------------------------------------------------------
// 1a. 200 distinct-block SELF inflows (Buy) -> <= MaxLots cohorts, not 200.
// ---------------------------------------------------------------------------
func TestZZBound_200DistinctBuys_LedgerBounded(t *testing.T) {
	const c, h = "alice", "holder"
	t0 := uint64(2_000_000)
	const N = 200
	s := NewMemStore()
	zbMarket(t, s, c, t0+N+10)

	for i := 0; i < N; i++ {
		blk := t0 + uint64(i) // a DISTINCT block every time — the unbounded shape
		if _, err := Buy(s, h, c, blk, big.NewInt(1)); err != nil {
			t.Fatalf("Buy #%d @%d: %v", i, blk, err)
		}
		if got := zvNumCohorts(s, c, h); got > MaxLots {
			t.Fatalf("BOUND BROKEN after inflow #%d: %d cohorts > MaxLots=%d", i, got, MaxLots)
		}
		// Σlots == kBal must hold after EVERY write (merges are count-additive).
		if sum, bal := zvSumLotsRaw(s, c, h), getMoney(s, kBal(c, h)); sum.Cmp(bal) != 0 {
			t.Fatalf("CONSERVATION BROKEN after inflow #%d: Σlots=%s != kBal=%s", i, sum, bal)
		}
	}
	cohorts := zvNumCohorts(s, c, h)
	if cohorts > MaxLots {
		t.Fatalf("after %d distinct-block buys: %d cohorts > MaxLots=%d", N, cohorts, MaxLots)
	}
	if cohorts >= N {
		t.Fatalf("bound did nothing: %d cohorts for %d inflows", cohorts, N)
	}
	t.Logf("BOUND HOLDS: %d distinct-block buys -> %d cohorts (MaxLots=%d), Σlots=%s == kBal=%s, serialized=%d bytes",
		N, cohorts, MaxLots, zvSumLotsRaw(s, c, h), getMoney(s, kBal(c, h)), len(zvLotsStr(s, c, h)))
}

// ---------------------------------------------------------------------------
// 1b. THE ACTUAL GRIEF SHAPE: 200 distinct-block inflows pushed onto a VICTIM
// by an attacker via TransferCredits. Same bound.
// ---------------------------------------------------------------------------
func TestZZBound_200AttackerGifts_VictimLedgerBounded(t *testing.T) {
	const c, victim, attacker = "alice", "victim", "attacker"
	t0 := uint64(2_000_000)
	const N = 200
	s := NewMemStore()
	zbMarket(t, s, c, t0+2*N+10)

	// The victim holds an ordinary aged position first.
	if _, err := Buy(s, victim, c, t0, big.NewInt(50_000)); err != nil {
		t.Fatal(err)
	}
	maxSeen := 0
	for i := 0; i < N; i++ {
		blk := t0 + 1 + uint64(i)
		if _, err := Buy(s, attacker, c, blk, big.NewInt(1)); err != nil {
			t.Fatalf("attacker Buy #%d: %v", i, err)
		}
		if err := TransferCredits(s, attacker, c, attacker, victim, blk, big.NewInt(1)); err != nil {
			t.Fatalf("attacker gift #%d: %v", i, err)
		}
		got := zvNumCohorts(s, c, victim)
		if got > maxSeen {
			maxSeen = got
		}
		if got > MaxLots {
			t.Fatalf("BOUND BROKEN after gift #%d: victim ledger %d cohorts > MaxLots=%d", i, got, MaxLots)
		}
		if sum, bal := zvSumLotsRaw(s, c, victim), getMoney(s, kBal(c, victim)); sum.Cmp(bal) != 0 {
			t.Fatalf("CONSERVATION BROKEN after gift #%d: Σlots=%s != kBal=%s", i, sum, bal)
		}
	}
	t.Logf("BOUND HOLDS UNDER ATTACK: %d attacker gifts at %d distinct blocks -> victim ledger peaked at %d cohorts "+
		"(MaxLots=%d), final %d cohorts / %d bytes; Σlots=%s == kBal=%s",
		N, N, maxSeen, MaxLots, zvNumCohorts(s, c, victim), len(zvLotsStr(s, c, victim)),
		zvSumLotsRaw(s, c, victim), getMoney(s, kBal(c, victim)))
	zvAssertNoOrphanLots(t, s, "after 200 attacker gifts")
	zvAssertReserveEqualsArea(t, s, c, "after 200 attacker gifts")
}

// ---------------------------------------------------------------------------
// 1c. SIZE IS FLAT IN THE INFLOW COUNT. Drive the inflow hook directly for
// 2,000 distinct blocks and show cohorts/bytes stop growing.
// ---------------------------------------------------------------------------
func TestZZBound_SizeFlatInInflowCount(t *testing.T) {
	const c, h = "alice", "holder"
	t0 := uint64(2_000_000)
	s := NewMemStore()

	type sample struct {
		n       int
		cohorts int
		bytes   int
	}
	var samples []sample
	for i := 0; i < 2000; i++ {
		blk := t0 + uint64(i)
		creditInflowAt(s, c, h, big.NewInt(1), blk, blk)
		if n := i + 1; n == 1 || n == 64 || n == 65 || n == 100 || n == 500 || n == 2000 {
			samples = append(samples, sample{n, zvNumCohorts(s, c, h), len(zvLotsStr(s, c, h))})
		}
		if got := zvNumCohorts(s, c, h); got > MaxLots {
			t.Fatalf("BOUND BROKEN at inflow %d: %d cohorts", i+1, got)
		}
	}
	for _, sm := range samples {
		t.Logf("  inflows=%-5d cohorts=%-3d serialized=%d bytes", sm.n, sm.cohorts, sm.bytes)
	}
	last := samples[len(samples)-1]
	if last.cohorts > MaxLots {
		t.Fatalf("2000 inflows -> %d cohorts", last.cohorts)
	}
	if sum, bal := zvSumLotsRaw(s, c, h), getMoney(s, kBal(c, h)); sum.Cmp(bal) != 0 {
		t.Fatalf("Σlots=%s != kBal=%s after 2000 inflows", sum, bal)
	}
	t.Logf("SIZE BOUNDED: 2000 distinct-block inflows -> %d cohorts / %d bytes (was: 2000 cohorts, unbounded)",
		last.cohorts, last.bytes)
}

// ---------------------------------------------------------------------------
// 1d. A ledger that arrives OVER the cap (state written by pre-bound code) is
// REPAIRED by its next inflow rather than staying over forever.
// ---------------------------------------------------------------------------
func TestZZBound_OverCapLegacyLedgerRepaired(t *testing.T) {
	const c, h = "alice", "holder"
	block := uint64(3_000_000)
	s := NewMemStore()

	// Fabricate a 300-cohort ledger the pre-bound writer could have produced.
	var lots []mLot
	total := mZero()
	for i := 0; i < 300; i++ {
		lots = append(lots, mLot{count: big.NewInt(7), acq: block - 500_000 + uint64(i)})
		total = mAdd(total, big.NewInt(7))
	}
	setLots(s, c, h, lots)
	setMoney(s, kBal(c, h), total)
	setU64(s, kAcqBlock(c, h), block-500_000)
	if got := zvNumCohorts(s, c, h); got != 300 {
		t.Fatalf("precondition: wanted a 300-cohort legacy ledger, got %d", got)
	}

	// One ordinary inflow repairs it.
	creditInflowAt(s, c, h, big.NewInt(1), block, block)
	got := zvNumCohorts(s, c, h)
	if got > MaxLots {
		t.Fatalf("over-cap legacy ledger NOT repaired: %d cohorts > MaxLots=%d", got, MaxLots)
	}
	want := new(big.Int).Add(total, big.NewInt(1))
	if sum := zvSumLotsRaw(s, c, h); sum.Cmp(want) != 0 {
		t.Fatalf("repair lost tokens: Σlots=%s want %s", sum, want)
	}
	t.Logf("SELF-REPAIR: 300-cohort legacy ledger -> %d cohorts after one inflow, Σlots=%s preserved", got, want)
}
