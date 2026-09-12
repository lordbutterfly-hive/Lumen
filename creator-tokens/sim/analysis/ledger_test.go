package analysis

import (
	"math/big"
	"strings"
	"testing"
)

func TestLedger_CleanLifecycleCloses(t *testing.T) {
	tr := &Trace{Seed: 1, Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000),
		prepayEv(200, "bob", "alice", 5000),
		askEv(300, "bob", "alice", 240 /* 12%% of the 2000 credits escrowed */, 28800, 2000),
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

	// ★ NO ASK COMMISSION TERM (OWNER RULING 2026-09-12): an ask moves no HBD,
	// so `entered` is the registration fee plus the prepay and nothing else.
	wantEntered := big.NewInt(10000 + 5000)
	if rpt.Entered.Total.Cmp(wantEntered) != 0 {
		t.Errorf("Entered.Total = %s, want %s", rpt.Entered.Total, wantEntered)
	}
	wantLeft := big.NewInt(3000)
	if rpt.Left.Total.Cmp(wantLeft) != 0 {
		t.Errorf("Left.Total = %s, want %s", rpt.Left.Total, wantLeft)
	}
	// Sits = treasury(10000) + reserve(5000-3000) + escrowHeld(0 — always, since
	// an escrow holds tokens not HBD) = 10000+2000
	wantSits := big.NewInt(10000 + 2000)
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
	if bob.PaidIn.Cmp(big.NewInt(5000)) != 0 {
		t.Errorf("bob.PaidIn = %s, want 5000 (the prepay alone — an ask costs no HBD)", bob.PaidIn)
	}
	if bob.Unexplained.Sign() != 0 {
		t.Errorf("bob.Unexplained = %s, want 0", bob.Unexplained)
	}

	alice := rpt.PerActor["alice"]
	if alice == nil {
		t.Fatal("expected a ledger entry for alice")
	}
	// F8 (an adversarial review): CreditsHeldValue is now NET of the maximum
	// possible K2 exit tax (MaxExitTaxBps=1500, i.e. 15% — ★ 2026-09-08 fee
	// change, was 2000/20%), not gross — the field's own doc claims it is a
	// realizable FLOOR, and a holder never actually receives the pre-tax
	// gross refundPayout figure (core/refund.go). gross=2000 (reserve==
	// supply peg holds: floor(2000*2000/2000)=2000); tax=ceil(2000*1500/
	// 10000)=300; net=2000-300=1700. This value MOVED from the pre-fix 2000
	// (which was a real overstatement, not a rounding nuance) — see
	// ledger.go's CreditsHeldValue field doc and its computation site for
	// the full reasoning.
	if alice.CreditsHeldValue.Cmp(big.NewInt(1700)) != 0 {
		t.Errorf("alice.CreditsHeldValue = %s, want 1700 (answered credits, reserve==supply peg holds, net of the max 15%% K2 exit tax: 2000-300)", alice.CreditsHeldValue)
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
	// An ask that is still PENDING at the end of the trace: bob's CREDITS are
	// held, not lost. Since the OWNER RULING of 2026-09-12 there is no HBD held
	// against an escrow at all, so Sits.EscrowHeldTotal is structurally zero and
	// the whole claim rests on the credits being valued and explained.
	tr := &Trace{Seed: 7, Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000),
		prepayEv(200, "bob", "alice", 5000),
		askEv(300, "bob", "alice", 240, 28800, 2000),
	}}

	rpt := AnalyzeLedger(tr)
	if !rpt.Closes {
		t.Fatalf("expected identity to close, reason=%q", rpt.FirstBadReason)
	}
	if rpt.Sits.EscrowHeldTotal.Sign() != 0 {
		t.Errorf("Sits.EscrowHeldTotal = %s, want 0 — an open escrow holds tokens, not HBD", rpt.Sits.EscrowHeldTotal)
	}
	bob := rpt.PerActor["bob"]
	if bob.PendingEscrowCommission.Sign() != 0 {
		t.Errorf("bob.PendingEscrowCommission = %s, want 0 — no HBD is held against an escrow", bob.PendingEscrowCommission)
	}
	if bob.PendingEscrowCreditsValue.Cmp(big.NewInt(2000)) != 0 {
		t.Errorf("bob.PendingEscrowCreditsValue = %s, want 2000", bob.PendingEscrowCreditsValue)
	}
	// F8 (an adversarial review): bob's SPENDABLE balance (5000 prepaid -
	// 2000 escrowed = 3000, un-escrowed and un-ansewered) is priced by
	// CreditsHeldValue net of the max K2 exit tax, unlike
	// PendingEscrowCreditsValue above (which is NOT tax-adjusted — F8 is
	// scoped to the field whose own doc claims to be a realizable
	// wind-down FLOOR; PendingEscrowCreditsValue makes no such claim, see
	// its own field doc). ★ 2026-09-08 fee change (MaxExitTaxBps 2000 ->
	// 1500): gross=refundPayout(5000,3000,5000)=3000; tax=ceil(3000*1500/
	// 10000)=450; CreditsHeldValue=2550.
	// bob.explained = CreditsHeldValue(2550) + PendingEscrowCreditsValue(2000)
	// = 4550; PaidIn = 5000 (the prepay alone — an ask costs no HBD);
	// Unexplained = 450 — entirely CreditsHeldValue's max-tax floor gap on
	// bob's still-SPENDABLE balance (the SCOPE NOTE item-3 pattern this
	// package documents and accepts), not any part of the escrow actually
	// being lost — PendingEscrowCommission/PendingEscrowCreditsValue above
	// already prove the escrowed leg is fully accounted for at its own
	// value.
	wantUnexplained := big.NewInt(450)
	if bob.Unexplained.Cmp(wantUnexplained) != 0 {
		t.Errorf("bob.Unexplained = %s, want %s (held, not lost — the escrow is fully explained; this is CreditsHeldValue's max-tax floor gap on bob's un-escrowed spendable balance)", bob.Unexplained, wantUnexplained)
	}
	if len(rpt.UnintendedLoss) != 1 {
		t.Errorf("expected bob to appear in UnintendedLoss (positive but fully explained by CreditsHeldValue's tax-floor gap, F8 — not a real loss), got %+v", rpt.UnintendedLoss)
	}
}

// TestLedger_DeclineReturnsTheEscrowedCredits — RULING E (ask.go's Decline,
// wired into the engine 2026-07-28). The creator's free "no" must return the
// whole escrow, and the replay must MOVE it rather than silently falling
// through to the no-op default case (which would leave `sits` overstated and
// break the Entered==Left+Sits identity from the first decline onward).
//
// ★ IT NO LONGER MOVES ANY HBD (OWNER RULING 2026-09-12). The old version
// asserted Left.DeclinedCommission — a bucket for the HBD commission a decline
// handed back — and an Overpayment resolution, both of which belonged to a
// commission model that does not exist. What a decline returns now is CREDITS,
// so that is what is asserted: the escrow leaves Sits, the asker's balance is
// whole again, and no HBD bucket moves at all.
func TestLedger_DeclineReturnsTheEscrowedCredits(t *testing.T) {
	tr := &Trace{Seed: 8, Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000),
		prepayEv(200, "bob", "alice", 5000),
		askEv(300, "bob", "alice", 240, 28800, 2000),
		declineEv(310, "alice", 0), // well inside the answer window
	}}

	rpt := AnalyzeLedger(tr)
	if !rpt.Closes {
		t.Fatalf("expected identity to close, reason=%q divergence=%v", rpt.FirstBadReason, rpt.Divergence)
	}
	if rpt.Left.DeclinedCommission.Sign() != 0 {
		t.Errorf("Left.DeclinedCommission = %s, want 0 — a decline moves no HBD", rpt.Left.DeclinedCommission)
	}
	if rpt.Left.ReclaimedCommission.Sign() != 0 {
		t.Errorf("Left.ReclaimedCommission = %s, want 0", rpt.Left.ReclaimedCommission)
	}
	if rpt.Sits.EscrowHeldTotal.Sign() != 0 {
		t.Errorf("Sits.EscrowHeldTotal = %s, want 0 (the escrow resolved, and held no HBD in any case)", rpt.Sits.EscrowHeldTotal)
	}
	bob := rpt.PerActor["bob"]
	// The whole point: the declined escrow is back in bob's spendable balance,
	// so nothing is pending against him any more.
	if bob.PendingEscrowCreditsValue.Sign() != 0 {
		t.Errorf("bob.PendingEscrowCreditsValue = %s, want 0 (the decline resolved the escrow)", bob.PendingEscrowCreditsValue)
	}
	if bob.PaidIn.Cmp(big.NewInt(5000)) != 0 {
		t.Errorf("bob.PaidIn = %s, want 5000 (the prepay alone)", bob.PaidIn)
	}
}
func TestLedger_ClaimTradeFeesMovesFeePotToLeft(t *testing.T) {
	tr := &Trace{Seed: 9, Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000),
		buyEv(200, "bob", "alice", 100, 10000, 1000, 11000), // fee=1000 -> feeCreator=500, feePlatform=500
		claimTradeFeesEv(300, "alice", 500),
	}}

	rpt := AnalyzeLedger(tr)
	if !rpt.Closes {
		t.Fatalf("expected identity to close, reason=%q divergence=%v", rpt.FirstBadReason, rpt.Divergence)
	}
	if rpt.Left.TradeFeesClaimed.Cmp(big.NewInt(500)) != 0 {
		t.Errorf("Left.TradeFeesClaimed = %s, want 500", rpt.Left.TradeFeesClaimed)
	}
	if len(rpt.Sits.FeePotsByCreator) != 0 || rpt.Sits.FeePotsTotal.Sign() != 0 {
		t.Errorf("Sits.FeePotsTotal = %s (byCreator=%v), want 0 after the full pot was claimed", rpt.Sits.FeePotsTotal, rpt.Sits.FeePotsByCreator)
	}
	alice := rpt.PerActor["alice"]
	if alice.ReceivedOut.Cmp(big.NewInt(500)) != 0 {
		t.Errorf("alice.ReceivedOut = %s, want 500", alice.ReceivedOut)
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

// TestLedger_TransferredAwayIsReserveBackedNotRawCredits — F1, an
// adversarial review. Regression for the exact PAR-era unit bug: on a
// curve-appreciated market (reserve != supply, the ORDINARY case post
// RULING A — BasePrice alone guarantees this for any real trade),
// TransferredAway must price the transferred credits at the reserve-backed
// rate, never at the raw credit count. Mirrors the review's own worked
// example in shape (a small transferred credit count worth far more once
// priced against the reserve): bob buys 100 tokens for a curve cost of
// 50,000 (reserve=50000, supply=100 — an 500-unit-per-credit market, nothing
// like the PAR 1:1 peg prepayEv's synthetic fixtures still use elsewhere in
// this file), then gives away 22 of them. Pre-fix this counted as "22" —
// worth exactly zero base units more than the raw token count, a >99%
// understatement.
func TestLedger_TransferredAwayIsReserveBackedNotRawCredits(t *testing.T) {
	tr := &Trace{Seed: 10, Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000),
		buyEv(200, "bob", "alice", 100, 50_000, 5_000, 55_000),
		transferEv(250, "bob", "alice", "charlie", 22),
	}}

	rpt := AnalyzeLedger(tr)
	if !rpt.Closes {
		t.Fatalf("expected identity to close, reason=%q divergence=%v", rpt.FirstBadReason, rpt.Divergence)
	}
	bob := rpt.PerActor["bob"]
	if bob == nil {
		t.Fatal("expected a ledger entry for bob")
	}
	// refundPayout(reserve=50000, credits=22, supply=100) = floor(1,100,000/100) = 11,000.
	wantValue := big.NewInt(11_000)
	if bob.TransferredAway.Cmp(wantValue) != 0 {
		t.Errorf("bob.TransferredAway = %s, want %s (reserve-backed value of 22 credits at reserve=50000/supply=100 — NOT the raw credit count 22, the pre-fix PAR-era bug)", bob.TransferredAway, wantValue)
	}
	if bob.TransferredAway.Cmp(big.NewInt(22)) == 0 {
		t.Fatal("REGRESSION: bob.TransferredAway == 22 (the raw credit count) — the PAR-era unit bug is back")
	}
}

// TestLedger_RefundMechanicalGuardCatchesPayoutMismatch — F1, an adversarial
// review ("Add a mechanical guard while you are here: ... assert the
// replayed net equals the trace's own recorded payout Arg. That check would
// have caught the original clamp bug automatically instead of by eye, and
// catches shadow-reserve drift."). Injects a trace where the recorded
// "payout" Arg (what a real core.Refund call would have returned) disagrees
// with what this replay's own independent refundPayout/tax derivation
// computes — simulating exactly the kind of shadow-state drift or engine
// bug the guard exists to catch automatically.
func TestLedger_RefundMechanicalGuardCatchesPayoutMismatch(t *testing.T) {
	tr := &Trace{Events: []Event{
		registerEv(100, "alice", 2000, 1_000_000),
		prepayEv(200, "bob", "alice", 1000), // PAR: reserve=supply=1000
		// The replay independently derives gross=floor(1000*500/1000)=500,
		// tax absent (0), so net=500 — but the trace claims a payout of 999,
		// a real core.Refund could never have actually returned.
		newEv(300, "bob", "refund", "alice").argN("credits", 500).arg("payout", "999").build(),
	}}

	rpt := AnalyzeLedger(tr)
	if rpt.Closes {
		t.Fatal("expected the identity to NOT close given a mismatched recorded payout")
	}
	if rpt.FirstBadEvent != 2 {
		t.Errorf("FirstBadEvent = %d, want 2 (the refund event)", rpt.FirstBadEvent)
	}
	if !strings.Contains(rpt.FirstBadReason, "replayed net") || !strings.Contains(rpt.FirstBadReason, "recorded payout") {
		t.Errorf("FirstBadReason = %q, want it to name the replayed-net-vs-recorded-payout mismatch", rpt.FirstBadReason)
	}
}
