package core

import (
	"math/big"
	"testing"
)

// v5.1: MANUFACTURING A MISS IS NEVER FREE, AT ANY PRICE.
//
// Before this, MissReclaimSliceBps took 25% of a commission that is
// floor(credits x 12%) — zero at eight credits or fewer — so three unanswered
// one-credit asks bought a 7-day inflow shutdown for nothing. The fix is a
// one-credit floor, so this test walks the whole cheap range and the boundary
// where the percentage takes over on its own.
func TestV51_MissDeterrentIsNeverZero(t *testing.T) {
	for _, credits := range []int64{1, 2, 3, 5, 8, 9, 20, 100, 1000} {
		commission := commissionOwedFor(big.NewInt(credits))
		slice := mMulDivCeil(commission, new(big.Int).SetUint64(MissReclaimSliceBps), big.NewInt(10000))
		if slice.Sign() <= 0 {
			slice = big.NewInt(1)
		}
		if slice.Cmp(big.NewInt(credits)) > 0 {
			slice = big.NewInt(credits)
		}
		if slice.Sign() <= 0 {
			t.Fatalf("credits=%d: the deterrent rounded to zero", credits)
		}
		if slice.Cmp(big.NewInt(credits)) > 0 {
			t.Fatalf("credits=%d: the slice (%s) exceeds the escrow it is carved from", credits, slice)
		}
		t.Logf("credits=%4d  commission=%4s  miss slice=%3s", credits, commission, slice)
	}
}

// And the same arithmetic where it actually runs, so the test cannot pass while
// Reclaim does something else: three cheap misses must cost the griefer three
// credits, not zero.
func TestV51_ThreeCheapMissesCostThreeCredits(t *testing.T) {
	total := big.NewInt(0)
	for i := 0; i < int(MinMissesForDelinquency); i++ {
		commission := commissionOwedFor(big.NewInt(1))
		slice := mMulDivCeil(commission, new(big.Int).SetUint64(MissReclaimSliceBps), big.NewInt(10000))
		if slice.Sign() <= 0 {
			slice = big.NewInt(1)
		}
		total = new(big.Int).Add(total, slice)
	}
	if total.Cmp(big.NewInt(int64(MinMissesForDelinquency))) != 0 {
		t.Fatalf("a %d-miss shutdown costs %s credits, want %d", MinMissesForDelinquency, total, MinMissesForDelinquency)
	}
	t.Logf("shutting a creator's inflows for %d days now costs the griefer %s credits, was 0",
		DelinquencyBlocks/BlocksPerDay, total)
}

// THE EDGE THE FLOOR CREATES, run through the REAL Reclaim: a ONE-CREDIT
// escrow that is missed returns NOTHING to the asker and one token to the
// owner. That is the deliberate price of a creator going silent for a whole
// window on the cheapest possible ask; what must never happen is the escrow
// paying out more than it holds, or the asker being charged on an honest
// Decline. Both are asserted here.
func TestV51_OneCreditMissPaysTheOwnerAndNeverOverdraws(t *testing.T) {
	s := NewMemStore()
	bindOwner(s)
	const deadline = uint64(500)
	// commissionCredits 0 is what settlePosted stores for a one-credit ask.
	mkPendingEscrow(s, creator1, 0, asker1, 1, deadline, "cid", 0)

	got, err := Reclaim(s, asker1, creator1, deadline+ReclaimGrace+1, 0)
	if err != nil {
		t.Fatalf("Reclaim: %v", err)
	}
	if got.CreditsReturned.Sign() != 0 {
		t.Fatalf("asker got %s back on a missed one-credit ask, want 0 (the deterrent takes it)", got.CreditsReturned)
	}
	askerBal := totalBalance(s, creator1, asker1)
	ownerBal := totalBalance(s, creator1, Owner(s))
	if askerBal.Sign() != 0 {
		t.Fatalf("asker balance = %s, want 0", askerBal)
	}
	if ownerBal.Cmp(tk(1)) != 0 { // one token = 100 units (v6)
		t.Fatalf("owner balance = %s, want exactly the 1 token the escrow held", ownerBal)
	}
	// Conservation: what left the escrow is exactly what it held.
	if sum := new(big.Int).Add(askerBal, ownerBal); sum.Cmp(tk(1)) != 0 {
		t.Fatalf("escrow paid out %s against 1 credit held", sum)
	}
}

// A DECLINE IS STILL FREE — the creator's honest "no" must never carry the
// deterrent, at any size. This is the half of the rule the floor could have
// broken by accident.
func TestV51_DeclineStillRefundsInFull(t *testing.T) {
	s := NewMemStore()
	bindOwner(s)
	mkPendingEscrow(s, creator1, 0, asker1, 1, 500, "cid", 0)
	if _, err := Decline(s, creator1, creator1, 100, 0); err != nil {
		t.Fatalf("Decline: %v", err)
	}
	if bal := totalBalance(s, creator1, asker1); bal.Cmp(tk(1)) != 0 {
		t.Fatalf("declined escrow returned %s, want the whole 1 credit", bal)
	}
	if ownerBal := totalBalance(s, creator1, Owner(s)); ownerBal.Sign() != 0 {
		t.Fatalf("a decline paid the owner %s — the deterrent must never fire on a decline", ownerBal)
	}
}
