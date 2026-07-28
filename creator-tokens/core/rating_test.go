package core

import (
	"math/big"
	"testing"
)

// rating_test.go — the buyer's rating (rating.go, USER RULING 2026-07-28).
//
// The single most important test here is TestRating_NeverGatesAnyFundPath: a
// reputation score that can touch money is worse than no score at all, because
// it hands one party a lever over the other's balance.

// rtDelivered drives one full ask -> answered cycle and returns the escrow seq.
func rtDelivered(t *testing.T, s Store, at uint64, asker string) uint64 {
	t.Helper()
	commission := commissionOwedFor(big.NewInt(9090))
	res, err := askAt0(s, asker, creator1, at, big.NewInt(1000), commission, "cid", MinAskDeadline)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if _, err := Answer(s, creator1, creator1, at+1, res.Seq, "ans"); err != nil {
		t.Fatalf("Answer: %v", err)
	}
	return res.Seq
}

func TestRating_BuyerCanRateADeliveredJobOnce(t *testing.T) {
	s, at := dgSetup(t)
	seq := rtDelivered(t, s, at, asker1)

	if err := Rate(s, asker1, creator1, seq, 4); err != nil {
		t.Fatalf("Rate: %v", err)
	}
	if got := RatingOf(s, creator1, seq); got != 4 {
		t.Fatalf("RatingOf = %d, want 4", got)
	}
	sum, count := CreatorRating(s, creator1)
	if sum != 4 || count != 1 {
		t.Fatalf("CreatorRating = (%d,%d), want (4,1)", sum, count)
	}

	// Once only — otherwise a buyer could grind a creator's average down (or a
	// friendly one grind it up) from a single purchase.
	if err := Rate(s, asker1, creator1, seq, 1); err == nil {
		t.Fatalf("second rating accepted; it must be refused")
	}
	if got := RatingOf(s, creator1, seq); got != 4 {
		t.Fatalf("RatingOf = %d after a refused re-rate, want the original 4", got)
	}
}

func TestRating_OnlyTheBuyerCanRate(t *testing.T) {
	s, at := dgSetup(t)
	seq := rtDelivered(t, s, at, asker1)

	// Not a stranger — a rating that anyone could leave is worth nothing, and
	// would let a competitor 1-star a creator for free.
	if err := Rate(s, rando1, creator1, seq, 1); err == nil || askErrSymbol(err) != ErrAuth {
		t.Fatalf("stranger rating accepted or wrong error: %v", err)
	}
	// Not the creator either — five stars must not be self-issuable.
	if err := Rate(s, creator1, creator1, seq, 5); err == nil || askErrSymbol(err) != ErrAuth {
		t.Fatalf("creator rating own job accepted or wrong error: %v", err)
	}
	if _, count := CreatorRating(s, creator1); count != 0 {
		t.Fatalf("a refused rating still moved the aggregate (count=%d)", count)
	}
}

func TestRating_OnlyDeliveredJobsAreRateable(t *testing.T) {
	s, at := dgSetup(t)
	commission := commissionOwedFor(big.NewInt(9090))

	// PENDING — nothing has happened yet.
	pending, err := askAt0(s, asker1, creator1, at, big.NewInt(1000), commission, "cid", MinAskDeadline)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if err := Rate(s, asker1, creator1, pending.Seq, 1); err == nil {
		t.Fatalf("rating a PENDING escrow accepted")
	}

	// RECLAIMED — the creator went silent. That is already recorded objectively
	// as a MISS by the delivery gate; letting it also carry a subjective score
	// would double-count the same event.
	reclaimAt := at + MinAskDeadline + ReclaimGrace + 1
	if _, err := Reclaim(s, asker1, creator1, reclaimAt, pending.Seq); err != nil {
		t.Fatalf("Reclaim: %v", err)
	}
	if err := Rate(s, asker1, creator1, pending.Seq, 1); err == nil {
		t.Fatalf("rating a RECLAIMED escrow accepted")
	}

	// DECLINED — the creator said no and handed everything back. Nothing was
	// delivered, so there is nothing to rate.
	declined, err := askAt0(s, asker1, creator1, reclaimAt+1, big.NewInt(1000), commission, "cid2", MinAskDeadline)
	if err != nil {
		t.Fatalf("Ask 2: %v", err)
	}
	if _, err := Decline(s, creator1, creator1, reclaimAt+2, declined.Seq); err != nil {
		t.Fatalf("Decline: %v", err)
	}
	if err := Rate(s, asker1, creator1, declined.Seq, 1); err == nil {
		t.Fatalf("rating a DECLINED escrow accepted")
	}
}

func TestRating_ScoreIsBounded(t *testing.T) {
	s, at := dgSetup(t)
	seq := rtDelivered(t, s, at, asker1)
	for _, bad := range []uint64{0, 6, 1000} {
		if err := Rate(s, asker1, creator1, seq, bad); err == nil {
			t.Fatalf("score %d accepted; bounds are %d-%d", bad, MinRating, MaxRating)
		}
	}
	if err := Rate(s, asker1, creator1, seq, MaxRating); err != nil {
		t.Fatalf("score %d refused: %v", MaxRating, err)
	}
}

// TestRating_NeverGatesAnyFundPath is the load-bearing one. A rating is
// SUBJECTIVE, so if it could close an inflow or block an outflow it would be a
// weapon: one buyer could shut a creator's sales, or a creator could withhold
// delivery over a bad score. The contract's own guardrail already says
// non-payment and non-delivery must never gate funds; a subjective score is
// strictly more dangerous than either.
func TestRating_NeverGatesAnyFundPath(t *testing.T) {
	s, at := dgSetup(t)
	seq := rtDelivered(t, s, at, asker1)
	if err := Rate(s, asker1, creator1, seq, MinRating); err != nil {
		t.Fatalf("Rate: %v", err)
	}

	// The worst possible standing must change NOTHING about money.
	if err := RequireInflowOpen(s, creator1, at+10); err != nil {
		t.Fatalf("a 1-star rating closed inflows: %v", err)
	}
	// A new ask still works...
	commission := commissionOwedFor(big.NewInt(9090))
	if _, err := askAt0(s, asker1, creator1, at+10, big.NewInt(1000), commission, "cid3", MinAskDeadline); err != nil {
		t.Fatalf("a 1-star rating blocked a new ask: %v", err)
	}
	// ...and so does the holder's exit.
	if _, err := Sell(s, asker1, creator1, at+11, big.NewInt(1)); err != nil {
		t.Fatalf("a 1-star rating blocked a sell: %v", err)
	}
	// And the delivery gate is untouched by it: ratings and misses are separate
	// facts, and only the objective one may ever convict.
	if delinquent, _ := DeliveryStanding(s, creator1, at+11); delinquent {
		t.Fatalf("a rating made the creator delinquent")
	}
}

func TestRating_UnknownEscrowIsRefused(t *testing.T) {
	s, _ := dgSetup(t)
	if err := Rate(s, asker1, creator1, 999, 5); err == nil {
		t.Fatalf("rating a nonexistent escrow accepted")
	}
}
