package core

import (
	"math/big"
	"testing"
)

// zz_fix_escrowstrand_test.go — THE COHORT-COUNT ESCAPE FOR R3 (2026-09-07
// audit, HIGH; built 2026-09-12).
//
// THE FINDING. Answer, Decline and Reclaim all credit an escrow's recorded
// cohorts back through creditInflowCohorts, which calls creditInflowAt once per
// cohort — and each of those rewrites and re-serialises the recipient's WHOLE
// lot ledger. One settlement therefore costs O(cohorts x ledger). Past the
// node's per-call ceiling EVERY settlement path for that escrow fails the same
// way, the escrow sits PENDING forever, its credits keep kSupply above zero (I3)
// so CloseIfDrained can never fire, and the creator's identity-bound market can
// never be re-registered. A permanently trapped holder — the one outcome this
// contract's invariants exist to forbid.
//
// THE ESCAPE. boundSettlementLots collapses the replay list to at most
// MaxSettlementLots before any credit happens, reusing boundLots's own two-stage
// merge: the free, exactly tax-neutral collapse of already-matured cohorts
// first, then cheapest-adjacent merges AT THE YOUNGER ACQ.
//
// WHAT THIS FILE PROVES, and the order matters:
//   1. the instrument is NOT VACUOUS — the fixture really does build an escrow
//      whose recorded cohort count is over the cap;
//   2. the bound holds, and conserves every token;
//   3. it can only ever RAISE the tax owed, never lower it (the no-launder
//      direction, inherited from mergeCheapestAdjacentLot and re-measured here
//      rather than assumed);
//   4. all THREE settlement rails still conserve the escrow exactly, on a
//      fixture that is over the cap.

// esFragmentedHolder gives (c, h) `n` distinct cohorts, one per block, oldest
// first, `each` tokens apiece — the shape an active trader's ledger really has.
// It writes through creditInflowAt (the chokepoint), so the lot ledger is built
// by the same code path a Buy would use.
func esFragmentedHolder(s Store, c, h string, n int, each int64, firstBlock, gap uint64) uint64 {
	blk := firstBlock
	for i := 0; i < n; i++ {
		creditInflowAt(s, c, h, tk(each), blk, blk)
		blk += gap
	}
	return blk
}

func TestEscrowStrand_SettlementLotsAreBounded(t *testing.T) {
	s := NewMemStore()
	const c, h = "strandcreator", "strandholder"
	const cohorts = 20
	// Well inside the maturity window, so NONE of these is already matured and
	// the free collapse cannot do the work — the lossy merge has to. That is the
	// half of boundSettlementLots that could be unsafe, so it is the half the
	// fixture must exercise.
	start := uint64(2_000_000)
	last := esFragmentedHolder(s, c, h, cohorts, 100, start, 1_000)

	lots := getLots(s, c, h)
	if len(lots) != cohorts {
		t.Fatalf("fixture: holder has %d cohorts, want %d — the ledger did not fragment", len(lots), cohorts)
	}
	if len(lots) <= MaxSettlementLots {
		t.Fatalf("fixture is VACUOUS: %d cohorts is already inside the %d cap, so the bound would never fire", len(lots), MaxSettlementLots)
	}

	block := last + 10
	bounded := boundSettlementLots(lots, block)
	if len(bounded) > MaxSettlementLots {
		t.Fatalf("bounded to %d cohorts, want <= %d", len(bounded), MaxSettlementLots)
	}

	// CONSERVATION: not one token may be created or destroyed by the merge.
	sum := func(ls []mLot) *big.Int {
		total := mZero()
		for _, l := range ls {
			total = mAdd(total, l.count)
		}
		return total
	}
	if sum(bounded).Cmp(sum(lots)) != 0 {
		t.Fatalf("the bound moved tokens: %s -> %s", sum(lots), sum(bounded))
	}

	// NO UNDER-TAX, measured rather than assumed. Price the whole position
	// through the same per-cohort rate the exit tax uses, before and after.
	weighted := func(ls []mLot) *big.Int {
		total := mZero()
		for _, l := range ls {
			total = mAdd(total, new(big.Int).Mul(l.count, new(big.Int).SetUint64(lotRateAt(l.acq, block))))
		}
		return total
	}
	before, after := weighted(lots), weighted(bounded)
	if after.Cmp(before) < 0 {
		t.Fatalf("the bound LOWERED the tax owed: %s -> %s — that is the launder direction", before, after)
	}
	t.Logf("bounded %d -> %d cohorts; tax weight %s -> %s (never lower)", len(lots), len(bounded), before, after)
}

// esOverCapEscrow builds a market, a fragmented holder, and one ask that spends
// across every one of their cohorts. Returns the ask result and the block it
// executed at.
func esOverCapEscrow(t *testing.T, s *MemStore, c, asker string) (*AskResult, uint64) {
	t.Helper()
	bindOwner(s)
	// The commission fixture (a real settlement rate and a face inside every
	// C-guard), then the holder's balance is REPLACED by a fragmented one so the
	// escrow's own draw spans many cohorts.
	block, _ := commissionMarket(t, s, c, asker)
	setMoney(s, kBal(c, asker), tk(0))
	lotsClear(s, c, asker)
	// ★ SMALL cohorts, deliberately. 20 x 3 = 60 tokens against an ask that costs
	// 50 here, so lotsDrawFreshest has to reach through ~17 of them — where 20
	// LARGE cohorts would be covered by the first two and the escrow would record
	// two, which is what the vacuity guard below caught on the first attempt.
	// Every cohort is inside the maturity window at `block`, so the free collapse
	// cannot do the bound's work either.
	esFragmentedHolder(s, c, asker, 20, 3, block-25_000, 1_000)

	res, err := askAt0(s, asker, c, block, tk(100), "strand-cid", MinAskDeadline)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	recorded := loadEscrowLots(s, c, res.Seq, res.CreditsSpent)
	if len(recorded) <= MaxSettlementLots {
		t.Fatalf("fixture is VACUOUS: the escrow recorded %d cohorts, at or under the %d cap — the escape would never fire", len(recorded), MaxSettlementLots)
	}
	return res, block
}

func TestEscrowStrand_AllThreeRailsSettleAnOverCapEscrow(t *testing.T) {
	// ★ ALL THREE, not one. The finding is that EVERY settlement path fails the
	// same way, so proving one rail says nothing about whether the escrow is
	// escapable — an escrow with one working rail was never stranded.
	t.Run("answer", func(t *testing.T) {
		s := NewMemStore()
		res, block := esOverCapEscrow(t, s, creator1, asker1)
		out, err := Answer(s, creator1, creator1, block+10, res.Seq, "ans")
		if err != nil {
			t.Fatalf("Answer on an over-cap escrow: %v", err)
		}
		if sum := mAdd(out.CreditsToCreator, out.CommissionToOwner); sum.Cmp(res.CreditsSpent) != 0 {
			t.Fatalf("creator %s + owner %s = %s, want the escrowed %s", out.CreditsToCreator, out.CommissionToOwner, sum, res.CreditsSpent)
		}
		if got := totalBalance(s, creator1, creator1); got.Cmp(out.CreditsToCreator) != 0 {
			t.Fatalf("creator position = %s, want %s", got, out.CreditsToCreator)
		}
	})

	t.Run("decline", func(t *testing.T) {
		s := NewMemStore()
		res, block := esOverCapEscrow(t, s, creator1, asker1)
		before := totalBalance(s, creator1, asker1)
		out, err := Decline(s, creator1, creator1, block+10, res.Seq)
		if err != nil {
			t.Fatalf("Decline on an over-cap escrow: %v", err)
		}
		if out.CreditsReturned.Cmp(res.CreditsSpent) != 0 {
			t.Fatalf("returned %s, want the whole escrow %s", out.CreditsReturned, res.CreditsSpent)
		}
		if got := totalBalance(s, creator1, asker1); got.Cmp(mAdd(before, res.CreditsSpent)) != 0 {
			t.Fatalf("asker position = %s, want %s", got, mAdd(before, res.CreditsSpent))
		}
	})

	t.Run("reclaim", func(t *testing.T) {
		s := NewMemStore()
		res, block := esOverCapEscrow(t, s, creator1, asker1)
		out, err := Reclaim(s, asker1, creator1, block+MinAskDeadline+ReclaimGrace+1, res.Seq)
		if err != nil {
			t.Fatalf("Reclaim on an over-cap escrow: %v", err)
		}
		if sum := mAdd(out.CreditsReturned, out.CommissionRetainedCredits); sum.Cmp(res.CreditsSpent) != 0 {
			t.Fatalf("returned %s + retained %s = %s, want the escrowed %s",
				out.CreditsReturned, out.CommissionRetainedCredits, sum, res.CreditsSpent)
		}
	})
}

// TestEscrowStrand_UnderCapIsUntouched is the other half of the claim: the
// escape is a CEILING, not a rewrite. An ordinary escrow — one holder, few
// cohorts — must replay exactly the cohorts it recorded, unmerged.
func TestEscrowStrand_UnderCapIsUntouched(t *testing.T) {
	s := NewMemStore()
	const c, h = "smallcreator", "smallholder"
	start := uint64(2_000_000)
	last := esFragmentedHolder(s, c, h, 3, 100, start, 1_000)
	lots := getLots(s, c, h)
	bounded := boundSettlementLots(lots, last+10)
	if len(bounded) != len(lots) {
		t.Fatalf("an under-cap ledger was merged: %d -> %d", len(lots), len(bounded))
	}
	for i := range lots {
		if lots[i].acq != bounded[i].acq || lots[i].count.Cmp(bounded[i].count) != 0 {
			t.Fatalf("cohort %d changed: %v -> %v", i, lots[i], bounded[i])
		}
	}
}
