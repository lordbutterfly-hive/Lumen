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

// TestDelivery_RefusalCarriesTheDedicatedSymbol pins the DELINQUENT error
// symbol. RequireInflowOpen's delivery branch is the ONLY place that returns
// it, which is what lets a consumer identify "refused because the creator is
// delinquent" without reading the message text.
//
// It used to return the generic ErrState, shared by dozens of unrelated
// refusals. The simulator's standing-guardrail check therefore had to
// substring-match the wording, and an adversarial review showed the cost: a
// reword in this file would have turned the simulator's OUTFLOW halt into a
// no-op that still reported a pass — so a real regression (an outflow
// starting to consult delivery standing) would have gone unnoticed.
//
// If this test fails because the symbol changed, fix the symbol; do not
// "fix" it by going back to matching prose.
func TestDelivery_RefusalCarriesTheDedicatedSymbol(t *testing.T) {
	s, at := dgSetup(t)
	for i := 0; i < 3; i++ {
		at = dgMiss(t, s, at) + 1
	}
	if delinquent, _ := DeliveryStanding(s, creator1, at); !delinquent {
		t.Fatalf("setup failed: creator is not delinquent")
	}

	err := RequireInflowOpen(s, creator1, at)
	if err == nil {
		t.Fatal("setup failed: inflows are still open for a delinquent creator")
	}
	ce, ok := err.(*Err)
	if !ok {
		t.Fatalf("delinquency refusal must be a typed *core.Err, got %T", err)
	}
	if ce.Symbol != ErrDelinquent {
		t.Fatalf("delinquency refusal carries Symbol %q, want %q — consumers can no longer distinguish it from any other %s refusal without matching message text, which is exactly the fragility this symbol was added to remove",
			ce.Symbol, ErrDelinquent, ErrState)
	}

	// And the symbol must stay specific: a DIFFERENT inflow refusal (global
	// pause) must NOT report itself as delinquency, or a consumer branching
	// on the symbol would over-count.
	s2, at2 := dgSetup(t)
	SetPaused(s2, true)
	perr := RequireInflowOpen(s2, creator1, at2)
	if perr == nil {
		t.Fatal("setup failed: a paused contract still accepts inflows")
	}
	if pe, ok := perr.(*Err); ok && pe.Symbol == ErrDelinquent {
		t.Fatal("a PAUSE refusal reports Symbol=DELINQUENT — the symbol is not specific to the delivery gate and consumers branching on it will over-count")
	}
}

// ---------------------------------------------------------------------------
// USER RULINGS 1 and 2 (2026-07-28) — griefing is no longer free, and the
// penalty window is derived from the OFFENCE rather than from whenever
// somebody chose to press Reclaim.
// ---------------------------------------------------------------------------

// missSliceFor recomputes the retained slice from first principles —
// ceil(commission * MissReclaimSliceBps / 10000) on plain integers, without
// touching mMulDivCeil — so these tests pin the RULE and would still fail if
// the production helper it happens to share a formula with were changed.
func missSliceFor(commission *big.Int) *big.Int {
	num := new(big.Int).Mul(commission, new(big.Int).SetUint64(MissReclaimSliceBps))
	den := big.NewInt(10000)
	q, r := new(big.Int).QuoRem(num, den, new(big.Int))
	if r.Sign() > 0 {
		q.Add(q, big.NewInt(1))
	}
	return q
}

// TestDelivery_GriefingCostsTheAskerTheMissSlice is RULING 1's whole point.
// Before it, Reclaim handed back the credits AND 100% of the commission and the
// credits came back with their original acquisition clock, so a hostile asker
// could manufacture three misses — a seven-day shutdown of somebody's market —
// and end the round trip with the exact balance they started with.
// delivery.go's own comment claimed "a hostile asker must pay for each ask",
// which was false. This measures the cost and asserts it is strictly positive.
func TestDelivery_GriefingCostsTheAskerTheMissSlice(t *testing.T) {
	s, at := dgSetup(t)
	commission := commissionOwedFor(big.NewInt(9090))
	slice := missSliceFor(commission)
	if slice.Sign() <= 0 {
		t.Fatalf("miss slice on a %s commission is %s — griefing would still be free", commission, slice)
	}

	treasuryBefore := getMoney(s, kTreasury())
	balBefore := getMoney(s, kBal(creator1, asker1))

	for i := 0; i < 3; i++ {
		at = dgMiss(t, s, at) + 1
	}

	// The CREDITS are still returned whole — RULING 1 charges the HBD leg only.
	if bal := getMoney(s, kBal(creator1, asker1)); bal.Cmp(balBefore) != 0 {
		t.Fatalf("asker token balance %s -> %s; credits must always come back whole", balBefore, bal)
	}
	// Three misses, three slices, all of it in the treasury and none of it
	// anywhere near the creator (paying the creator for going silent would pay
	// for the exact behaviour the gate punishes).
	wantTreasury := new(big.Int).Add(treasuryBefore, new(big.Int).Mul(slice, big.NewInt(3)))
	if treas := getMoney(s, kTreasury()); treas.Cmp(wantTreasury) != 0 {
		t.Fatalf("treasury = %s, want %s (3 misses x %s)", treas, wantTreasury, slice)
	}
	if fee := getMoney(s, kFeeBal(creator1)); fee.Sign() != 0 {
		t.Fatalf("creator fee balance = %s, want 0 — the miss slice must never reach the creator", fee)
	}
	if delinquent, _ := DeliveryStanding(s, creator1, at); !delinquent {
		t.Fatalf("sanity: the three misses should have convicted")
	}
}

// TestDelivery_SelfDealtReclaimIsNotAMissAndPaysNoSlice — the slice and the
// miss counter must agree about what an offence is. A self-dealt escrow is
// excluded from the counters, so charging it a slice would be a fee on a
// non-event, and would let anyone quietly tax a creator's own housekeeping.
func TestDelivery_SelfDealtReclaimIsNotAMissAndPaysNoSlice(t *testing.T) {
	s, at := dgSetup(t)
	setMoney(s, kBal(creator1, creator1), big.NewInt(500_000))
	commission := commissionOwedFor(big.NewInt(9090))
	treasuryBefore := getMoney(s, kTreasury())

	res, err := askAt0(s, creator1, creator1, at, big.NewInt(1000), commission, "cid", MinAskDeadline)
	if err != nil {
		t.Fatalf("self Ask: %v", err)
	}
	rres, err := Reclaim(s, creator1, creator1, at+MinAskDeadline+ReclaimGrace+1, res.Seq)
	if err != nil {
		t.Fatalf("self Reclaim: %v", err)
	}
	if rres.CommissionRetainedHbd.Sign() != 0 {
		t.Fatalf("retained %s on a self-dealt reclaim, want 0 (not a miss)", rres.CommissionRetainedHbd)
	}
	if rres.CommissionHbd.Cmp(commission) != 0 {
		t.Fatalf("CommissionHbd = %s, want the full %s back", rres.CommissionHbd, commission)
	}
	if treas := getMoney(s, kTreasury()); treas.Cmp(treasuryBefore) != 0 {
		t.Fatalf("treasury moved on a self-dealt reclaim: %s -> %s", treasuryBefore, treas)
	}
	if misses, _ := DeliveryRecord(s, creator1); misses != 0 {
		t.Fatalf("self-dealt reclaim counted as a miss (misses=%d)", misses)
	}
}

// TestDelivery_StaleOffencesConvictForAnAlreadyExpiredWindow is RULING 2.
// A miss is stamped at RECLAIM time, but reclaim is permissionless and has no
// upper time bound, so three expired escrows could be BANKED and detonated by
// any stranger months later — opening a fresh seven-day shutdown for an offence
// the creator committed in the distant past. Deriving the window from
// deadline+ReclaimGrace makes such a conviction arrive already spent.
func TestDelivery_StaleOffencesConvictForAnAlreadyExpiredWindow(t *testing.T) {
	s, at := dgSetup(t)
	commission := commissionOwedFor(big.NewInt(9090))

	// Three asks that all expire early, and are then left alone.
	seqs := make([]uint64, 0, 3)
	for i := 0; i < 3; i++ {
		res, err := askAt0(s, asker1, creator1, at+uint64(i), big.NewInt(1000), commission, "cid", MinAskDeadline)
		if err != nil {
			t.Fatalf("Ask %d: %v", i, err)
		}
		seqs = append(seqs, res.Seq)
	}
	offenceEnd := at + 2 + MinAskDeadline + ReclaimGrace // the freshest offence

	// Detonated far in the future — well past DelinquencyBlocks after the
	// offences themselves — by a stranger, which is legal (H1, permissionless).
	late := offenceEnd + DelinquencyBlocks + 5000
	for _, seq := range seqs {
		if _, err := Reclaim(s, rando1, creator1, late, seq); err != nil {
			t.Fatalf("late Reclaim seq %d: %v", seq, err)
		}
	}

	delinquent, until := DeliveryStanding(s, creator1, late)
	if delinquent {
		t.Fatalf("creator is delinquent at %d for offences that ended by %d — a banked-and-detonated shutdown", late, offenceEnd)
	}
	if until > late {
		t.Fatalf("delinquentUntil = %d, in the future of %d", until, late)
	}
	if err := RequireInflowOpen(s, creator1, late); err != nil {
		t.Fatalf("inflows closed by a stale offence: %v", err)
	}
}

// TestDelivery_PenaltyWindowIsIndependentOfReclaimOrder — reclaim is
// permissionless, so whoever submits the third one also picks WHICH escrow it
// is. If the sentence were derived from the tipping reclaim's own escrow, that
// submitter would be picking the sentence: stalest-last for a sentence that is
// already over, freshest-last for the full seven days. Our own keeper chooses
// that order. Every permutation must convict identically.
func TestDelivery_PenaltyWindowIsIndependentOfReclaimOrder(t *testing.T) {
	commission := commissionOwedFor(big.NewInt(9090))
	// Three permutations of the same three offences, oldest-first through
	// newest-first.
	orders := [][]int{{0, 1, 2}, {2, 1, 0}, {1, 2, 0}}
	var got []uint64
	for _, order := range orders {
		s, at := dgSetup(t)
		type esc struct {
			seq      uint64
			deadline uint64
		}
		escrows := make([]esc, 3)
		for i := 0; i < 3; i++ {
			// Spread the asks a day apart so the offences are genuinely
			// different blocks; otherwise the test proves nothing.
			askAt := at + uint64(i)*BlocksPerDay
			res, err := askAt0(s, asker1, creator1, askAt, big.NewInt(1000), commission, "cid", MinAskDeadline)
			if err != nil {
				t.Fatalf("Ask %d: %v", i, err)
			}
			escrows[i] = esc{seq: res.Seq, deadline: askAt + MinAskDeadline}
		}
		last := escrows[2].deadline + ReclaimGrace + 1
		for _, i := range order {
			if _, err := Reclaim(s, rando1, creator1, last, escrows[i].seq); err != nil {
				t.Fatalf("Reclaim %d: %v", i, err)
			}
		}
		_, until := DeliveryStanding(s, creator1, last)
		got = append(got, until)
		// The sentence must be the one the FRESHEST offence earned.
		if want := escrows[2].deadline + ReclaimGrace + DelinquencyBlocks; until != want {
			t.Fatalf("order %v: delinquentUntil = %d, want %d (freshest offence + %d)", order, until, want, DelinquencyBlocks)
		}
	}
	for i := 1; i < len(got); i++ {
		if got[i] != got[0] {
			t.Fatalf("sentence depends on reclaim order: %v", got)
		}
	}
}

// TestDelivery_OffenceTrackerClearedOnConviction — the running max is
// per-assessment-window state, exactly like the two counters. If conviction
// left it standing, the NEXT conviction would inherit a sentence earned by
// offences that were already punished, and a creator could be re-sentenced for
// the same old miss.
func TestDelivery_OffenceTrackerClearedOnConviction(t *testing.T) {
	s, at := dgSetup(t)
	for i := 0; i < 3; i++ {
		at = dgMiss(t, s, at) + 1
	}
	if got := getU64(s, kMaxOffenceUntil(creator1)); got != 0 {
		t.Fatalf("kMaxOffenceUntil = %d after conviction, want 0", got)
	}
}
