package analysis

import (
	"math/big"
	"testing"
)

func TestLedger_CleanLifecycleCloses(t *testing.T) {
	tr := &Trace{Seed: 1, Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000),
		prepayEv(200, "bob", "alice", 5000),
		askEv(300, "bob", "alice", 240 /* owed = floor(2000*1200/10000) */, 28800, 2000),
		answerEv(310, "alice", "alice", 0),
		refundEv(400, "bob", "alice", 3000), // bob's remaining balance: 5000-2000
	}}

	rpt := AnalyzeLedger(tr)

	if !rpt.Closes {
		t.Fatalf("expected identity to close, got FirstBadEvent=%d reason=%q divergence=%v", rpt.FirstBadEvent, rpt.FirstBadReason, rpt.Divergence)
	}
	if rpt.FirstBadEvent != -1 {
		t.Fatalf("Closes=true but FirstBadEvent=%d, want -1", rpt.FirstBadEvent)
	}

	wantEntered := big.NewInt(10000 + 5000 + 240)
	if rpt.Entered.Total.Cmp(wantEntered) != 0 {
		t.Errorf("Entered.Total = %s, want %s", rpt.Entered.Total, wantEntered)
	}
	wantLeft := big.NewInt(3000)
	if rpt.Left.Total.Cmp(wantLeft) != 0 {
		t.Errorf("Left.Total = %s, want %s", rpt.Left.Total, wantLeft)
	}
	// Sits = treasury(10000+240) + reserve(5000-3000) + escrowHeld(0, answered) = 10240+2000+0
	wantSits := big.NewInt(10240 + 2000)
	if rpt.Sits.Total.Cmp(wantSits) != 0 {
		t.Errorf("Sits.Total = %s, want %s", rpt.Sits.Total, wantSits)
	}
	if len(rpt.UnintendedLoss) != 0 {
		t.Errorf("expected no unintended loss, got %+v", rpt.UnintendedLoss)
	}

	bob := rpt.PerActor["bob"]
	if bob == nil {
		t.Fatal("expected a ledger entry for bob")
	}
	if bob.PaidIn.Cmp(big.NewInt(5240)) != 0 {
		t.Errorf("bob.PaidIn = %s, want 5240", bob.PaidIn)
	}
	if bob.Unexplained.Sign() != 0 {
		t.Errorf("bob.Unexplained = %s, want 0", bob.Unexplained)
	}

	alice := rpt.PerActor["alice"]
	if alice == nil {
		t.Fatal("expected a ledger entry for alice")
	}
	if alice.CreditsHeldValue.Cmp(big.NewInt(2000)) != 0 {
		t.Errorf("alice.CreditsHeldValue = %s, want 2000 (answered credits, reserve==supply peg holds)", alice.CreditsHeldValue)
	}
	if alice.Unexplained.Sign() > 0 {
		t.Errorf("alice.Unexplained = %s, should not be positive (she received real value from answering)", alice.Unexplained)
	}
}

func TestLedger_NegativeReserveBreaksIdentity(t *testing.T) {
	// A malformed/buggy trace: an OK refund whose requested credits exceed
	// what this creator's reserve could possibly cover. Real core would
	// never let this through (Refund checks the caller's own balance first),
	// so this simulates an engine or core regression and proves the ledger
	// catches it rather than silently netting out across other creators.
	tr := &Trace{Seed: 2, Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000),
		prepayEv(200, "bob", "alice", 1000),
		refundEv(300, "bob", "alice", 2000), // more than supply=1000 can support
	}}

	rpt := AnalyzeLedger(tr)

	if rpt.Closes {
		t.Fatal("expected the identity to NOT close given a negative-reserve refund")
	}
	if rpt.FirstBadEvent != 2 {
		t.Errorf("FirstBadEvent = %d, want 2 (the refund event)", rpt.FirstBadEvent)
	}
	if rpt.FirstBadReason == "" {
		t.Error("expected a non-empty FirstBadReason")
	}
	if rpt.Divergence == nil {
		t.Error("expected a non-nil Divergence once Closes is false")
	}
	t.Logf("reason: %s", rpt.FirstBadReason)
}

func TestLedger_CommissionOverpaymentTrackedAndClassified(t *testing.T) {
	tr := &Trace{Seed: 3, Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000), // owed commission = floor(2000*1200/10000) = 240
		prepayEv(200, "bob", "alice", 5000),
		askEv(300, "bob", "alice", 300, 28800, 2000), // paid 300, owed 240 -> excess 60
		answerEv(310, "alice", "alice", 0),
	}}

	rpt := AnalyzeLedger(tr)
	if !rpt.Closes {
		t.Fatalf("expected identity to close, reason=%q", rpt.FirstBadReason)
	}
	if len(rpt.Overpayments) != 1 {
		t.Fatalf("expected 1 overpayment, got %d: %+v", len(rpt.Overpayments), rpt.Overpayments)
	}
	op := rpt.Overpayments[0]
	if op.Owed.Cmp(big.NewInt(240)) != 0 || op.Paid.Cmp(big.NewInt(300)) != 0 || op.Excess.Cmp(big.NewInt(60)) != 0 {
		t.Errorf("overpayment = %+v, want owed=240 paid=300 excess=60", op)
	}
	if op.Resolution != "answered" {
		t.Errorf("overpayment.Resolution = %q, want %q (the excess is permanently lost to treasury on answer)", op.Resolution, "answered")
	}
}

func TestLedger_ReclaimReturnsOverpaymentInFull(t *testing.T) {
	// Same overpayment, but this time the ask times out and is reclaimed —
	// I5 says the FULL held amount (including the accidental excess) comes
	// back, so this should NOT show up as any kind of loss.
	tr := &Trace{Seed: 4, Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000),
		prepayEv(200, "bob", "alice", 5000),
		askEv(300, "bob", "alice", 300, 28800 /* 1 day */, 2000),
		reclaimEv(300+28800+1200+1, "bob", "alice", 0), // past deadline+ReclaimGrace
	}}

	rpt := AnalyzeLedger(tr)
	if !rpt.Closes {
		t.Fatalf("expected identity to close, reason=%q", rpt.FirstBadReason)
	}
	if len(rpt.Overpayments) != 1 || rpt.Overpayments[0].Resolution != "reclaimed" {
		t.Fatalf("expected 1 reclaimed overpayment, got %+v", rpt.Overpayments)
	}
	bob := rpt.PerActor["bob"]
	if bob.Unexplained.Sign() != 0 {
		t.Errorf("bob.Unexplained = %s, want 0 (full commission incl. the accidental excess was returned)", bob.Unexplained)
	}
}

func TestLedger_TransferIsNotAnUnintendedLoss(t *testing.T) {
	// bob prepays, gives ALL his credits to charlie for free (a legal gift —
	// API.md rule 2/4: transfer is never gated), charlie refunds them.
	// Neither side should show up as an unintended loss: bob chose to give
	// the value away, and charlie never paid the contract anything (so
	// charlie's PaidIn is legitimately 0 while ReceivedOut is 5000, which
	// makes Unexplained deeply NEGATIVE — never flagged, since only a
	// POSITIVE Unexplained is a loss).
	tr := &Trace{Seed: 5, Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000),
		prepayEv(200, "bob", "alice", 5000),
		transferEv(250, "bob", "alice", "charlie", 5000),
		refundEv(300, "charlie", "alice", 5000),
	}}

	rpt := AnalyzeLedger(tr)
	if !rpt.Closes {
		t.Fatalf("expected identity to close, reason=%q", rpt.FirstBadReason)
	}
	if len(rpt.UnintendedLoss) != 0 {
		t.Fatalf("expected no unintended loss from a voluntary transfer, got %+v", rpt.UnintendedLoss)
	}
	bob := rpt.PerActor["bob"]
	if bob.Unexplained.Sign() != 0 {
		t.Errorf("bob.Unexplained = %s, want 0 (TransferredAway must fully explain the gift)", bob.Unexplained)
	}
	if bob.TransferredAway.Cmp(big.NewInt(5000)) != 0 {
		t.Errorf("bob.TransferredAway = %s, want 5000", bob.TransferredAway)
	}
}

func TestLedger_RegistrationAndSubscriptionAreIntendedCosts(t *testing.T) {
	// alice registers and self-renews; a fan pays for a second renewal.
	// Neither should ever be flagged as an unintended loss for anyone.
	tr := &Trace{Seed: 6, Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000),
		renewEv(200, "alice", "alice", 1, 10000),
		renewEv(300, "fan1", "alice", 1, 10000), // API.md: "a fan can keep a creator alive"
	}}

	rpt := AnalyzeLedger(tr)
	if !rpt.Closes {
		t.Fatalf("expected identity to close, reason=%q", rpt.FirstBadReason)
	}
	if len(rpt.UnintendedLoss) != 0 {
		t.Fatalf("expected no unintended loss, got %+v", rpt.UnintendedLoss)
	}
	alice := rpt.PerActor["alice"]
	if alice.RegistrationFeesPaid.Cmp(big.NewInt(10000)) != 0 || alice.SubscriptionFeesPaid.Cmp(big.NewInt(10000)) != 0 {
		t.Errorf("alice fees = reg %s sub %s, want 10000/10000", alice.RegistrationFeesPaid, alice.SubscriptionFeesPaid)
	}
	fan := rpt.PerActor["fan1"]
	if fan.SubscriptionFeesPaid.Cmp(big.NewInt(10000)) != 0 {
		t.Errorf("fan1.SubscriptionFeesPaid = %s, want 10000", fan.SubscriptionFeesPaid)
	}
	if fan.Unexplained.Sign() != 0 {
		t.Errorf("fan1.Unexplained = %s, want 0 (a deliberate gift to the creator, not a loss)", fan.Unexplained)
	}
}

func TestLedger_UnresolvedEscrowIsHeldNotLost(t *testing.T) {
	// An ask that is still PENDING at the end of the trace: bob's commission
	// and credits are held, not lost — this must not appear as an
	// unintended loss, and Sits must include the held commission.
	tr := &Trace{Seed: 7, Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000),
		prepayEv(200, "bob", "alice", 5000),
		askEv(300, "bob", "alice", 240, 28800, 2000),
	}}

	rpt := AnalyzeLedger(tr)
	if !rpt.Closes {
		t.Fatalf("expected identity to close, reason=%q", rpt.FirstBadReason)
	}
	if rpt.Sits.EscrowHeldTotal.Cmp(big.NewInt(240)) != 0 {
		t.Errorf("Sits.EscrowHeldTotal = %s, want 240", rpt.Sits.EscrowHeldTotal)
	}
	bob := rpt.PerActor["bob"]
	if bob.PendingEscrowCommission.Cmp(big.NewInt(240)) != 0 {
		t.Errorf("bob.PendingEscrowCommission = %s, want 240", bob.PendingEscrowCommission)
	}
	if bob.PendingEscrowCreditsValue.Cmp(big.NewInt(2000)) != 0 {
		t.Errorf("bob.PendingEscrowCreditsValue = %s, want 2000", bob.PendingEscrowCreditsValue)
	}
	if bob.Unexplained.Sign() != 0 {
		t.Errorf("bob.Unexplained = %s, want 0 (held, not lost)", bob.Unexplained)
	}
	if len(rpt.UnintendedLoss) != 0 {
		t.Errorf("expected no unintended loss for a still-pending escrow, got %+v", rpt.UnintendedLoss)
	}
}

func TestLedger_MissingArgsIsNotedNotFabricated(t *testing.T) {
	ev := registerEv(100, "alice", 2000, 1_000_000)
	delete(ev.Args, "feePaid")
	tr := &Trace{Events: []Event{ev}}

	rpt := AnalyzeLedger(tr)
	if len(rpt.Notes) == 0 {
		t.Error("expected a data-quality note when Args.feePaid is missing, got none")
	}
	if rpt.Entered.Registration.Sign() != 0 {
		t.Errorf("expected Entered.Registration to stay 0 rather than fabricate a value, got %s", rpt.Entered.Registration)
	}
}
