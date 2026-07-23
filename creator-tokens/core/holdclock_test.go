package core

import (
	"math/big"
	"math/rand"
	"testing"
)

// holdclock_test.go — the hold clock: C-13/C-14/C-15, the zero-value
// ("unset == fresh") convention and its anti-laundering half, and the
// beyond-2^64 big.Int requirement on the average's intermediates.
//
// The WA aggregate this file used to assert (kHoldWeightSum, the exact
// Σ bal·wacq identity) is DELETED — RULING A4 — together with its mechanism;
// see holdclock.go's file header for the autopsy (purchasable weight +
// the two RULING-G defects the aggregate itself caused).

func TestHoldClock_FreshInflowStartsAtNow_C14(t *testing.T) {
	s := NewMemStore()
	creditInflow(s, "creatora", "alice", big.NewInt(100), 5000)
	if w := holderAcqBlock(s, "creatora", "alice"); w != 5000 {
		t.Fatalf("fresh inflow wacq = %d, want exactly the inflow block 5000 (C-14)", w)
	}
	if h := heldBlocksAt(s, "creatora", "alice", 5000); h != 0 {
		t.Fatalf("held immediately after inflow = %d, want 0", h)
	}
	if h := heldBlocksAt(s, "creatora", "alice", 6200); h != 1200 {
		t.Fatalf("held 1200 blocks later = %d, want 1200", h)
	}
}

func TestHoldClock_WeightedAverage_ExactAndCeil(t *testing.T) {
	cases := []struct {
		name       string
		bal1, bal2 int64
		b1, b2     uint64
		wantWacq   uint64
	}{
		// Equal sizes: exact midpoint.
		{"equal-halves", 100, 100, 1000, 2000, 1500},
		// ceil rounds toward the NEWER block (more tax, pot-favouring):
		// (1·10 + 1·11)/2 = 10.5 → 11.
		{"ceil-toward-newer", 1, 1, 10, 11, 11},
		// A big fresh inflow drags the clock almost all the way to now:
		// (1·10 + 999·1010)/1000 = (10 + 1008990)/1000 = 1009.0 → 1009.
		{"big-fresh-inflow", 1, 999, 10, 1010, 1009},
		// A dust top-up barely moves an old clock:
		// (1000·10 + 1·2010)/1001 = 11.998 → ceil 12.
		{"dust-topup", 1000, 1, 10, 2010, 12},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := NewMemStore()
			creditInflow(s, "cr", "h", big.NewInt(c.bal1), c.b1)
			creditInflow(s, "cr", "h", big.NewInt(c.bal2), c.b2)
			if w := holderAcqBlock(s, "cr", "h"); w != c.wantWacq {
				t.Fatalf("wacq = %d, want %d", w, c.wantWacq)
			}
		})
	}
}

// RULING K deleted the per-holder cost basis (kBasis). A debit now moves only
// the balance and deliberately leaves the clock alone; the two basis-specific
// tests that lived here (TestHoldClock_DebitKeepsClock_AndRemovesProportionalBasis
// and TestHoldClock_Basis_Property) are gone with the machinery they tested.
func TestHoldClock_DebitKeepsClock(t *testing.T) {
	s := NewMemStore()
	creditInflow(s, "cr", "h", big.NewInt(100), 1000)
	if err := debitBalance(s, "cr", "h", big.NewInt(30)); err != nil {
		t.Fatal(err)
	}
	// The seller's clock is NOT touched — the remainder is not re-aged.
	if w := holderAcqBlock(s, "cr", "h"); w != 1000 {
		t.Fatalf("wacq after debit = %d, want unchanged 1000", w)
	}
	if bal := getMoney(s, kBal("cr", "h")); bal.Cmp(big.NewInt(70)) != 0 {
		t.Fatalf("bal = %s, want 70", bal)
	}
	// Draining to zero then a fresh inflow starts at NOW (C-14 again — the
	// stale wacq key must not leak age into the new position).
	if err := debitBalance(s, "cr", "h", big.NewInt(70)); err != nil {
		t.Fatal(err)
	}
	creditInflow(s, "cr", "h", big.NewInt(5), 9999)
	if w := holderAcqBlock(s, "cr", "h"); w != 9999 {
		t.Fatalf("post-drain inflow wacq = %d, want 9999", w)
	}
}

func TestHoldClock_DebitInsufficientRejected(t *testing.T) {
	s := NewMemStore()
	creditInflow(s, "cr", "h", big.NewInt(10), 100)
	before := getMoney(s, kBal("cr", "h"))
	if err := debitBalance(s, "cr", "h", big.NewInt(11)); errSymbol(err) != ErrBalance {
		t.Fatalf("over-debit: err = %v, want %s", err, ErrBalance)
	}
	// RULING G: the rejected debit changed NOTHING (the burn-era version
	// could debit the balance and then fail on the WA aggregate — F-2).
	if got := getMoney(s, kBal("cr", "h")); got.Cmp(before) != 0 {
		t.Fatalf("rejected debit moved the balance: %s -> %s", before, got)
	}
}

// The zero-value convention, both halves (see holdclock.go's file doc):
// an UNCLOCKED balance (created outside the chokepoints — a test fixture, or
// any future migration path) is maximally FRESH, and averaging on top of it
// cannot mint age.
func TestHoldClock_UnclockedBalanceIsFresh_NotAncient(t *testing.T) {
	s := NewMemStore()
	// Simulate a fixture-seeded balance: raw kBal write, no clock.
	addMoney(s, kBal("cr", "eve"), big.NewInt(1_000_000))

	// Half 1: heldBlocks reads 0 (maximum tax), NEVER block−0 (zero tax).
	if h := heldBlocksAt(s, "cr", "eve", 10_000_000); h != 0 {
		t.Fatalf("unclocked balance heldBlocks = %d, want 0 (unset MUST mean fresh — anything else is a total exit-tax bypass)", h)
	}

	// Half 2 (anti-laundering): buying 1 token on top must NOT average the
	// million unclocked tokens as "acquired at block 0" — the whole position
	// clocks to NOW exactly.
	creditInflow(s, "cr", "eve", big.NewInt(1), 10_000_000)
	if w := holderAcqBlock(s, "cr", "eve"); w != 10_000_000 {
		t.Fatalf("post-launder wacq = %d, want exactly 10000000 (unclocked old balance averages as NOW, not 0)", w)
	}
	if h := heldBlocksAt(s, "cr", "eve", 10_000_000); h != 0 {
		t.Fatalf("post-launder held = %d, want 0", h)
	}
}

func TestHoldClock_NonMonotoneBlockSaturates(t *testing.T) {
	s := NewMemStore()
	creditInflow(s, "cr", "h", big.NewInt(10), 5000)
	// A query BEFORE the stored clock (never produced by real execution)
	// reads 0 held — the pot-favouring direction.
	if h := heldBlocksAt(s, "cr", "h", 4000); h != 0 {
		t.Fatalf("held at earlier block = %d, want 0 (saturating)", h)
	}
	// An inflow at an earlier block clamps the average input to that block.
	creditInflow(s, "cr", "h", big.NewInt(10), 4000)
	if w := holderAcqBlock(s, "cr", "h"); w != 4000 {
		t.Fatalf("wacq after non-monotone inflow = %d, want 4000 (clamped to the inflow block)", w)
	}
}

// The average's numerator bal·wacq at the caps exceeds int64 — the exact
// silent-overflow trap the big.Int rule exists for: 1e9 tokens · 1.1e10
// block ≈ 1.1e19 > 2^63−1 (9.22e18). A u64 intermediate would have computed
// a wrapped, WRONG average with no error anywhere; the exact ceil below
// proves the big.Int path.
func TestHoldClock_Average_BeyondInt64_Exact(t *testing.T) {
	s := NewMemStore()
	bal := big.NewInt(MaxCap)       // 1e9
	var blk uint64 = 11_000_000_000 // 1.1e10 — ~1046 years of 3s blocks; bound-proving, not realistic
	creditInflow(s, "cr", "whale", bal, blk)
	// Second whale-sized inflow 100 blocks later: numerator = 1e9·1.1e10 +
	// 1e9·(1.1e10+100) = 2.2e19 + 1e11 — multi-word big.Int territory.
	creditInflow(s, "cr", "whale", bal, blk+100)
	if w := holderAcqBlock(s, "cr", "whale"); w != blk+50 {
		t.Fatalf("wacq = %d, want %d exactly (the 2.2e19 numerator would have wrapped in u64)", w, blk+50)
	}
}

// C-13 + C-15 under randomized sequences of inflows and debits across
// several holders with non-decreasing blocks.
func TestHoldClock_Property_C13_C15(t *testing.T) {
	r := rand.New(rand.NewSource(77))
	holders := []string{"h1", "h2", "h3"}
	for iter := 0; iter < 50; iter++ {
		s := NewMemStore()
		c := "cr"
		block := uint64(r.Intn(1000) + 1)
		firstInflow := map[string]uint64{}
		for op := 0; op < 200; op++ {
			block += uint64(r.Intn(500))
			h := holders[r.Intn(len(holders))]
			bal := getMoney(s, kBal(c, h))
			if r.Intn(2) == 0 || bal.Sign() == 0 {
				n := big.NewInt(int64(r.Intn(1000) + 1))
				wBefore := holderAcqBlock(s, c, h)
				creditInflow(s, c, h, n, block)
				wAfter := holderAcqBlock(s, c, h)
				// C-13: wOld <= wNew <= block (wOld only meaningful when the
				// prior balance was clocked and nonzero).
				if wAfter > block {
					t.Fatalf("C-13 violated: wacq %d > block %d", wAfter, block)
				}
				if wBefore > 0 && bal.Sign() > 0 && wAfter < wBefore {
					t.Fatalf("C-13 violated: inflow made position older (%d -> %d)", wBefore, wAfter)
				}
				if _, seen := firstInflow[h]; !seen {
					firstInflow[h] = block
				}
			} else {
				amt := new(big.Int).Rand(r, bal)
				amt.Add(amt, big.NewInt(1))
				if amt.Cmp(bal) > 0 {
					amt.Set(bal)
				}
				if err := debitBalance(s, c, h, amt); err != nil {
					t.Fatal(err)
				}
			}
			// C-15: no holder's age exceeds time since their first inflow —
			// sybils cannot fake time.
			for _, hh := range holders {
				if fi, ok := firstInflow[hh]; ok {
					if got := heldBlocksAt(s, c, hh, block); got > block-fi {
						t.Fatalf("C-15 violated: %s held %d > block−firstInflow %d", hh, got, block-fi)
					}
				}
			}
		}
	}
}
