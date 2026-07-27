package core

import (
	"math/big"
	"testing"
)

// delivery_test.go — the delivery gate (delivery.go, RULING E, 2026-07-27).
//
// The single most important test in this file is
// TestDelivery_DelinquencyNeverGatesAnyPayout: a gate that can trap someone's
// money is worse than no gate at all.

// dgSetup builds an ACTIVE market with a settleable rate and a funded asker.
// Returns the block asks may be made at.
func dgSetup(t *testing.T) (Store, uint64) {
	t.Helper()
	s := NewMemStore()
	curveMarket(s, creator1, 1000)
	setMoney(s, kFace(creator1), big.NewInt(9090))
	setMoney(s, kBal(creator1, asker1), big.NewInt(500_000))
	askBlock := seedSettleObs(s, creator1, 1000, big.NewInt(2000))
	activateMarket(s, creator1, askBlock)
	// Keep the subscription paid far past every block these tests use, so the
	// ONLY thing that can ever close an inflow here is delivery standing.
	setU64(s, kPaidUntil(creator1), askBlock+1_000_000)
	return s, askBlock
}

// dgMiss drives one full ask -> ignored -> reclaimed cycle and returns the
// block the reclaim happened at.
func dgMiss(t *testing.T, s Store, at uint64) uint64 {
	t.Helper()
	commission := commissionOwedFor(big.NewInt(9090))
	res, err := askAt0(s, asker1, creator1, at, big.NewInt(1000), commission, "cid", MinAskDeadline)
	if err != nil {
		t.Fatalf("Ask at %d: %v", at, err)
	}
	reclaimAt := at + MinAskDeadline + ReclaimGrace + 1
	if _, err := Reclaim(s, asker1, creator1, reclaimAt, res.Seq); err != nil {
		t.Fatalf("Reclaim at %d: %v", reclaimAt, err)
	}
	return reclaimAt
}

func TestDelivery_BelowThresholdDoesNotGate(t *testing.T) {
	s, at := dgSetup(t)
	// Two misses is under MinMissesForDelinquency (3) no matter how bad the
	// rate looks — one or two data points is not a record.
	at = dgMiss(t, s, at) + 1
	at = dgMiss(t, s, at) + 1
	if delinquent, _ := DeliveryStanding(s, creator1, at); delinquent {
		t.Fatalf("delinquent after 2 misses; MinMissesForDelinquency is %d", MinMissesForDelinquency)
	}
	if err := RequireInflowOpen(s, creator1, at); err != nil {
		t.Fatalf("inflows closed after 2 misses: %v", err)
	}
}

func TestDelivery_ThresholdCrossedClosesInflows(t *testing.T) {
	s, at := dgSetup(t)
	for i := 0; i < 3; i++ {
		at = dgMiss(t, s, at) + 1
	}
	delinquent, until := DeliveryStanding(s, creator1, at)
	if !delinquent {
		t.Fatalf("not delinquent after 3 straight misses (100%% miss rate)")
	}
	if until <= at {
		t.Fatalf("delinquentUntil %d is not in the future of %d", until, at)
	}
	if err := RequireInflowOpen(s, creator1, at); err == nil {
		t.Fatalf("inflows still open while delinquent")
	}
	// The counters reset on conviction so the penalty is served once, not
	// re-triggered forever by the same three misses.
	misses, delivered := DeliveryRecord(s, creator1)
	if misses != 0 || delivered != 0 {
		t.Fatalf("counters not reset on conviction: misses=%d delivered=%d", misses, delivered)
	}
}

// TestDelivery_DelinquencyNeverGatesAnyPayout is the guardrail: delinquency
// may refuse new money IN and must never, under any circumstance, block money
// going OUT. If this test ever fails, the gate is a fund trap and must be
// reverted, not patched.
func TestDelivery_DelinquencyNeverGatesAnyPayout(t *testing.T) {
	s, at := dgSetup(t)

	// An ask placed BEFORE the creator falls foul of the gate, so there is a
	// live escrow straddling the conviction — the realistic case.
	commission := commissionOwedFor(big.NewInt(9090))
	inflight, err := askAt0(s, asker1, creator1, at, big.NewInt(1000), commission, "inflight", MaxAskDeadline)
	if err != nil {
		t.Fatalf("in-flight Ask: %v", err)
	}
	// The asker already holds tokens (dgSetup) and the creator has a fee
	// balance to claim — both from before the conviction.
	addMoney(s, kFeeBal(creator1), big.NewInt(1234))

	for i := 0; i < 3; i++ {
		at = dgMiss(t, s, at) + 1
	}
	if delinquent, _ := DeliveryStanding(s, creator1, at); !delinquent {
		t.Fatalf("setup failed: creator is not delinquent")
	}
	if err := RequireInflowOpen(s, creator1, at); err == nil {
		t.Fatalf("setup failed: inflows are still open")
	}

	// EVERY payout rail, while delinquent:
	if _, err := Answer(s, creator1, creator1, at, inflight.Seq, "ans"); err != nil {
		t.Fatalf("Answer blocked while delinquent — the in-flight customer is trapped: %v", err)
	}
	if _, err := Sell(s, asker1, creator1, at, big.NewInt(10)); err != nil {
		t.Fatalf("Sell blocked while delinquent — a holder is trapped: %v", err)
	}
	if _, err := ClaimTradeFees(s, creator1); err != nil {
		t.Fatalf("ClaimTradeFees blocked while delinquent: %v", err)
	}
	// And a fresh escrow can still be declined/reclaimed — proven by the
	// dgMiss cycles above, every one of which reclaimed successfully while the
	// creator's record was already bad.
}

func TestDelivery_DeclineIsNotAMiss(t *testing.T) {
	s, at := dgSetup(t)
	commission := commissionOwedFor(big.NewInt(9090))
	balBefore := getMoney(s, kBal(creator1, asker1))

	for i := 0; i < 5; i++ {
		res, err := askAt0(s, asker1, creator1, at, big.NewInt(1000), commission, "cid", MinAskDeadline)
		if err != nil {
			t.Fatalf("Ask %d: %v", i, err)
		}
		dec, err := Decline(s, creator1, creator1, at+1, res.Seq)
		if err != nil {
			t.Fatalf("Decline %d: %v", i, err)
		}
		if dec.CreditsReturned.Cmp(res.CreditsSpent) != 0 {
			t.Fatalf("Decline returned %s credits, want the escrowed %s", dec.CreditsReturned, res.CreditsSpent)
		}
		if dec.CommissionHbd.Cmp(commission) != 0 {
			t.Fatalf("Decline returned %s commission, want the full %s — we are paid for delivered service only", dec.CommissionHbd, commission)
		}
		if dec.Asker != asker1 {
			t.Fatalf("Decline pays %s, want the asker %s", dec.Asker, asker1)
		}
		at += 2
	}

	if delinquent, _ := DeliveryStanding(s, creator1, at); delinquent {
		t.Fatalf("declining 5 asks made the creator delinquent — declining must be free")
	}
	// A decline is NEUTRAL: it earns no miss (that is what makes saying no
	// free) and it earns no delivery either. Counting it as a delivery let a
	// creator stall until the last legal block, refuse, and still score a
	// perfect record — and let them pad the denominator to dilute real misses.
	// See Decline's own doc: this call carries nothing that can tell a prompt
	// refusal from a maximally-late one, so it must claim neither.
	if misses, delivered := DeliveryRecord(s, creator1); misses != 0 || delivered != 0 {
		t.Fatalf("record = %d misses / %d delivered, want 0/0 — a decline is neutral in the gate", misses, delivered)
	}
	// The asker is made whole in credits every time (the commission leg is the
	// wrapper's HBD transfer, asserted above via the result).
	if got := getMoney(s, kBal(creator1, asker1)); got.Cmp(balBefore) != 0 {
		t.Fatalf("asker credits = %s after 5 decline round trips, want the original %s", got, balBefore)
	}
}

func TestDelivery_JudgesTheRateNotTheCount(t *testing.T) {
	s, at := dgSetup(t)
	// 20 clean deliveries first.
	commission := commissionOwedFor(big.NewInt(9090))
	for i := 0; i < 20; i++ {
		res, err := askAt0(s, asker1, creator1, at, big.NewInt(1000), commission, "cid", MinAskDeadline)
		if err != nil {
			t.Fatalf("Ask %d: %v", i, err)
		}
		if _, err := Answer(s, creator1, creator1, at+1, res.Seq, "ans"); err != nil {
			t.Fatalf("Answer %d: %v", i, err)
		}
		at += 2
	}
	// Then 3 misses: 3 of 23 resolved is 13%, under the 25% ceiling.
	for i := 0; i < 3; i++ {
		at = dgMiss(t, s, at) + 1
	}
	if delinquent, _ := DeliveryStanding(s, creator1, at); delinquent {
		t.Fatalf("a creator who delivered 20 and missed 3 was convicted; MaxMissBps is %d", MaxMissBps)
	}
	if err := RequireInflowOpen(s, creator1, at); err != nil {
		t.Fatalf("inflows closed for a 13%% miss rate: %v", err)
	}
}

func TestDelivery_PenaltyExpiresWithACleanSheet(t *testing.T) {
	s, at := dgSetup(t)
	for i := 0; i < 3; i++ {
		at = dgMiss(t, s, at) + 1
	}
	_, until := DeliveryStanding(s, creator1, at)

	// One block before the window ends: still shut.
	if delinquent, _ := DeliveryStanding(s, creator1, until-1); !delinquent {
		t.Fatalf("penalty lifted early at %d (window ends %d)", until-1, until)
	}
	// At the boundary block: open again. The window is [conviction, until).
	if delinquent, _ := DeliveryStanding(s, creator1, until); delinquent {
		t.Fatalf("penalty still in force at its own end block %d", until)
	}
	if err := RequireInflowOpen(s, creator1, until); err != nil {
		t.Fatalf("inflows still closed after the penalty expired: %v", err)
	}
	if misses, delivered := DeliveryRecord(s, creator1); misses != 0 || delivered != 0 {
		t.Fatalf("creator did not come out with a clean sheet: %d misses / %d delivered", misses, delivered)
	}
}

func TestDecline_WindowAndAuth(t *testing.T) {
	s, at := dgSetup(t)
	commission := commissionOwedFor(big.NewInt(9090))

	// Not the creator.
	res, err := askAt0(s, asker1, creator1, at, big.NewInt(1000), commission, "cid", MinAskDeadline)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if _, err := Decline(s, asker1, creator1, at+1, res.Seq); err == nil {
		t.Fatalf("a non-creator declined someone else's escrow")
	}

	// Past the answer window: the miss is already earned and may not be erased.
	late := at + MinAskDeadline + 1
	if _, err := Decline(s, creator1, creator1, late, res.Seq); err == nil {
		t.Fatalf("creator declined AFTER the answer window closed — that would be a retroactive eraser for a customer they ignored")
	}

	// Declining twice, or declining something already answered, is refused.
	if _, err := Decline(s, creator1, creator1, at+1, res.Seq); err != nil {
		t.Fatalf("first Decline: %v", err)
	}
	if _, err := Decline(s, creator1, creator1, at+2, res.Seq); err == nil {
		t.Fatalf("escrow declined twice")
	}
	if _, err := Answer(s, creator1, creator1, at+2, res.Seq, "ans"); err == nil {
		t.Fatalf("a declined escrow was then answered")
	}
}

// TestDelivery_PenaltyNeverBlocksPayingTheSubscription pins the code-review
// finding that was the worst defect in the whole delivery gate: the check sat
// in RequireInflowOpen, which Renew also called, so a 7-day delivery penalty
// outlived the 5-day subscription grace and dragged the market into FROZEN —
// where renewal is illegal forever. A self-clearing penalty became permanent
// destruction of the market, triggerable by an attacker with three junk asks,
// and Renew is permissionless so not even a fan could rescue it.
func TestDelivery_PenaltyNeverBlocksPayingTheSubscription(t *testing.T) {
	s, at := dgSetup(t)
	// Renew checks market existence via kRegisteredAt; dgSetup seeds curve
	// state directly and never writes it.
	setU64(s, kRegisteredAt(creator1), 1)
	for i := 0; i < 3; i++ {
		at = dgMiss(t, s, at) + 1
	}
	if delinquent, _ := DeliveryStanding(s, creator1, at); !delinquent {
		t.Fatal("setup failed: creator is not delinquent")
	}
	// Purchases are refused — that is the gate doing its job.
	if err := RequireInflowOpen(s, creator1, at); err == nil {
		t.Fatal("delinquency did not close purchases")
	}
	// Paying the bill must still work. This is the difference between a
	// penalty and a trap.
	if err := Renew(s, creator1, creator1, at, 1, big.NewInt(SubscriptionFee)); err != nil {
		t.Fatalf("a delinquent creator could not pay their subscription: %v", err)
	}
	// And a third party may still rescue the market, since Renew is
	// permissionless by design.
	if err := Renew(s, "randomfan", creator1, at+1, 1, big.NewInt(SubscriptionFee)); err != nil {
		t.Fatalf("a fan could not renew a delinquent creator's market: %v", err)
	}
}

// TestDelivery_SelfDealtEscrowsCountForNeitherSide — Decline refunds credits
// AND the whole commission, so a creator asking their own market and declining
// costs nothing but transaction fees. Before the self-deal filter each cycle
// incremented the delivered count, so the miss RATE could be driven arbitrarily
// low and the gate would never fire no matter how many real customers were
// ignored. Both counters exclude self-deals, symmetrically — excluding one side
// only would move the lever rather than remove it.
func TestDelivery_SelfDealtEscrowsCountForNeitherSide(t *testing.T) {
	s, at := dgSetup(t)
	setMoney(s, kBal(creator1, creator1), big.NewInt(500_000))
	commission := commissionOwedFor(big.NewInt(9090))

	// The creator asks their OWN market and declines, repeatedly.
	for i := 0; i < 10; i++ {
		res, err := askAt0(s, creator1, creator1, at, big.NewInt(1000), commission, "self", MinAskDeadline)
		if err != nil {
			t.Fatalf("self-ask %d: %v", i, err)
		}
		if _, err := Decline(s, creator1, creator1, at+1, res.Seq); err != nil {
			t.Fatalf("self-decline %d: %v", i, err)
		}
		at += 2
	}
	if misses, delivered := DeliveryRecord(s, creator1); misses != 0 || delivered != 0 {
		t.Fatalf("self-dealt escrows moved the record to %d/%d, want 0/0", misses, delivered)
	}

	// The padding attempt must not have bought any protection: three real
	// misses still convict.
	for i := 0; i < 3; i++ {
		at = dgMiss(t, s, at) + 1
	}
	if delinquent, _ := DeliveryStanding(s, creator1, at); !delinquent {
		t.Fatal("a creator padded their record with self-dealt declines and escaped the gate")
	}
}
