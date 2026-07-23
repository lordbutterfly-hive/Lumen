package keeper

import (
	"fmt"
	"math/big"
	"testing"

	"creator-tokens/core"
)

// keeper_integration_test.go proves the two crash-safety properties the
// task requires ("submitting the same refund twice must be harmless" and
// "the keeper must be able to resume mid-sweep without double-paying or
// skipping") against the REAL core package — core.MemStore plus the actual
// core.Register/Prepay/Ask/Reclaim/RefundHolder/CloseIfDrained functions —
// not a mock standing in for them. core is pure Go with no network
// dependency, so this is still a fast, deterministic `go test`; it is a
// genuine integration test of this package's Plan/Sweep against the real
// contract logic, in the same spirit as the imitated template's own
// TestRunCreateCycle_HappyPath (hive-price-market/scheduler/scheduler_test.go),
// which feeds a planned round straight into the real market.CreateRound.

// coreSubmitter is a Submitter backed by the real core package against an
// in-memory Store — the strongest test double available for this package,
// since it is not a stand-in for core's behaviour, it IS core's behaviour.
type coreSubmitter struct {
	store  *core.MemStore
	caller string
	block  uint64
}

func (c *coreSubmitter) Submit(op Op) (string, error) {
	switch op.Kind {
	case OpRefundHolder:
		payout, err := core.RefundHolder(c.store, c.caller, op.Creator, op.Holder, c.block)
		if err != nil {
			return "", err
		}
		return payout.String(), nil
	case OpCloseIfDrained:
		closed := core.CloseIfDrained(c.store, op.Creator, c.block)
		return fmt.Sprintf("closed=%v", closed), nil
	default:
		return "", fmt.Errorf("keeper test: unknown op kind %v", op.Kind)
	}
}

func TestIntegration_DoubleSubmitRefundHolderIsHarmless(t *testing.T) {
	store := core.NewMemStore()
	creator := "creatora"
	holder := "holder1"
	registeredBlock := uint64(1_000_000)

	if err := core.Register(store, creator, creator, registeredBlock, 500, 1_000_000); err != nil {
		t.Fatalf("Register: %v", err)
	}
	if _, err := core.Prepay(store, holder, creator, registeredBlock+1, big.NewInt(5000)); err != nil {
		t.Fatalf("Prepay: %v", err)
	}

	freezeBlock := registeredBlock + core.SubscriptionPeriod + core.GraceBlocks + 10
	if phase := core.Phase(store, creator, freezeBlock); phase != core.StateFrozen {
		t.Fatalf("phase at freezeBlock = %s, want FROZEN", phase)
	}

	mv := MarketView{
		Creator: creator,
		Phase:   core.StateFrozen,
		Supply:  core.Supply(store, creator),
		Holders: []HolderBalance{{Holder: holder, Balance: core.BalanceOf(store, creator, holder)}},
	}
	ops := Plan([]MarketView{mv})
	if len(ops) != 2 || ops[0].Kind != OpRefundHolder {
		t.Fatalf("ops = %+v, want [refundHolder, closeIfDrained]", ops)
	}
	refundOp := ops[0]

	sub := &coreSubmitter{store: store, caller: "hive:keeper-bot", block: freezeBlock}

	receipt1, err := sub.Submit(refundOp)
	if err != nil {
		t.Fatalf("first Submit: %v", err)
	}
	if receipt1 != "5000" {
		t.Fatalf("first payout = %s, want 5000 (full refund at peg)", receipt1)
	}
	reserveAfter1 := core.Reserve(store, creator)
	supplyAfter1 := core.Supply(store, creator)
	if got := core.BalanceOf(store, creator, holder); got.Sign() != 0 {
		t.Fatalf("balance after first refund = %s, want 0", got)
	}

	// Submit the exact SAME op again -- simulating a retried submission
	// whose first attempt actually landed on-chain but whose confirmation
	// was lost (the case Sweep's own retry logic must tolerate).
	receipt2, err := sub.Submit(refundOp)
	if err != nil {
		t.Fatalf("second (duplicate) Submit: %v", err)
	}
	if receipt2 != "0" {
		t.Fatalf("second payout = %s, want 0 (harmless no-op on an already-zero balance)", receipt2)
	}
	if got := core.BalanceOf(store, creator, holder); got.Sign() != 0 {
		t.Fatalf("balance after duplicate refund = %s, want still 0", got)
	}
	if got := core.Reserve(store, creator); got.Cmp(reserveAfter1) != 0 {
		t.Fatalf("reserve moved on a duplicate submit: was %s, now %s -- DOUBLE PAY", reserveAfter1, got)
	}
	if got := core.Supply(store, creator); got.Cmp(supplyAfter1) != 0 {
		t.Fatalf("supply moved on a duplicate submit: was %s, now %s -- DOUBLE BURN", supplyAfter1, got)
	}
}

func TestIntegration_ResumeMidSweepNoDoublePayNoSkip(t *testing.T) {
	store := core.NewMemStore()
	creator := "creatorb"
	registeredBlock := uint64(2_000_000)
	if err := core.Register(store, creator, creator, registeredBlock, 500, 1_000_000); err != nil {
		t.Fatalf("Register: %v", err)
	}

	holders := []struct {
		name string
		amt  int64
	}{
		{"big", 9000},
		{"mid", 3000},
		{"small", 1000},
	}
	var reserveTotal int64
	for _, h := range holders {
		if _, err := core.Prepay(store, h.name, creator, registeredBlock+1, big.NewInt(h.amt)); err != nil {
			t.Fatalf("Prepay(%s): %v", h.name, err)
		}
		reserveTotal += h.amt
	}

	freezeBlock := registeredBlock + core.SubscriptionPeriod + core.GraceBlocks + 10
	if phase := core.Phase(store, creator, freezeBlock); phase != core.StateFrozen {
		t.Fatalf("phase = %s, want FROZEN", phase)
	}

	snapshot := func() MarketView {
		var hb []HolderBalance
		for _, h := range holders {
			hb = append(hb, HolderBalance{Holder: h.name, Balance: core.BalanceOf(store, creator, h.name)})
		}
		return MarketView{Creator: creator, Phase: core.Phase(store, creator, freezeBlock), Supply: core.Supply(store, creator), Holders: hb}
	}

	sub := &coreSubmitter{store: store, caller: "hive:keeper-bot", block: freezeBlock}

	// ---- round 1: the keeper processes exactly ONE op, then "crashes" ----
	round1Ops := Plan([]MarketView{snapshot()})
	if len(round1Ops) != 4 { // 3 refundHolder + 1 closeIfDrained
		t.Fatalf("round1 ops = %+v, want 4", round1Ops)
	}
	if round1Ops[0].Holder != "big" {
		t.Fatalf("round1Ops[0] = %+v, want the largest holder first (big)", round1Ops[0])
	}
	firstPayout, err := sub.Submit(round1Ops[0])
	if err != nil {
		t.Fatalf("round1 first submit: %v", err)
	}
	if firstPayout != "9000" {
		t.Fatalf("round1 first payout = %s, want 9000", firstPayout)
	}
	// Deliberately stop here -- simulating the keeper process dying before
	// ops[1:] were ever attempted.

	// ---- round 2: "resume" -- a fresh snapshot re-derived from live state ----
	fresh := snapshot()
	for _, hb := range fresh.Holders {
		if hb.Holder == "big" && hb.Balance.Sign() != 0 {
			t.Fatalf("big's balance did not drop to 0 after round 1: %s", hb.Balance)
		}
	}

	report := Sweep([]MarketView{fresh}, sub, BackoffPolicy{MaxAttempts: 1}, nil)
	if report.Failed != 0 {
		t.Fatalf("round2 report had failures: %+v", report)
	}
	// big must NOT appear anywhere in round 2's plan -- no double pay.
	for _, o := range report.Outcomes {
		if o.Op.Holder == "big" {
			t.Fatalf("big was resubmitted in round 2 -- DOUBLE PAY: %+v", o)
		}
	}
	// mid and small MUST both appear and succeed -- not skipped.
	seen := map[string]bool{}
	for _, o := range report.Outcomes {
		if o.Op.Kind == OpRefundHolder {
			seen[o.Op.Holder] = true
		}
	}
	if !seen["mid"] || !seen["small"] {
		t.Fatalf("round 2 skipped a holder that still had a balance: outcomes=%+v", report.Outcomes)
	}

	// ---- solvency check: total paid out across BOTH rounds == the original reserve (I1, full unwind) ----
	totalPaid := big.NewInt(9000) // round 1's single payout
	for _, o := range report.Outcomes {
		if o.Op.Kind == OpRefundHolder && o.Err == nil {
			paid, ok := new(big.Int).SetString(o.Receipt, 10)
			if !ok {
				t.Fatalf("could not parse receipt %q as an integer", o.Receipt)
			}
			totalPaid.Add(totalPaid, paid)
		}
	}
	if totalPaid.Int64() != reserveTotal {
		t.Fatalf("total paid across both rounds = %s, want exactly %d (the original reserve)", totalPaid, reserveTotal)
	}

	// ---- everyone is now at zero, supply is zero, and closeIfDrained (submitted as part of round 2) actually closed the market ----
	for _, h := range holders {
		if got := core.BalanceOf(store, creator, h.name); got.Sign() != 0 {
			t.Fatalf("%s balance after full sweep = %s, want 0", h.name, got)
		}
	}
	if got := core.Supply(store, creator); got.Sign() != 0 {
		t.Fatalf("supply after full sweep = %s, want 0", got)
	}
	if phase := core.Phase(store, creator, freezeBlock); phase != core.StateClosed {
		t.Fatalf("phase after full sweep = %s, want CLOSED", phase)
	}

	// ---- a THIRD sweep (nothing left to do) must find no ops at all ----
	finalView := snapshot()
	finalReport := Sweep([]MarketView{finalView}, sub, BackoffPolicy{MaxAttempts: 1}, nil)
	if len(finalReport.Outcomes) != 0 {
		t.Fatalf("a sweep of an already-CLOSED market produced ops: %+v", finalReport.Outcomes)
	}
}

func TestIntegration_CloseIfDrainedWaitsForOutstandingEscrow(t *testing.T) {
	store := core.NewMemStore()
	creator := "creatorc"
	holder := "holderc"
	registeredBlock := uint64(3_000_000)
	face := int64(500)

	if err := core.Register(store, creator, creator, registeredBlock, face, 1_000_000); err != nil {
		t.Fatalf("Register: %v", err)
	}
	if _, err := core.Prepay(store, holder, creator, registeredBlock+1, big.NewInt(10000)); err != nil {
		t.Fatalf("Prepay: %v", err)
	}

	askBlock := registeredBlock + 10
	// No observations recorded for "creatorc": core.Ask derives its own
	// settlement rate internally and falls back to PAR (1) with none — see
	// core/ask.go's SettlementRate doc. maxCredits (the asker's own
	// slippage cap, added 2026-07-20) is set to exactly what PAR settlement
	// costs: ceil(face/PAR) == face == 500.
	//
	// commissionOwed (H2 defect fix, 2026-07-21): core.Ask now requires
	// commissionHbdPaid to EXACTLY equal commissionOwedFor(face) — floor(face
	// * CommissionBps / 10000) — not merely be >= it. face=500 * 1200bps /
	// 10000 = 60.
	commissionOwed := new(big.Int).Mul(big.NewInt(face), big.NewInt(int64(core.CommissionBps)))
	commissionOwed.Div(commissionOwed, big.NewInt(10000))
	askResult, err := core.Ask(store, holder, creator, askBlock, big.NewInt(face), commissionOwed, "content-hash-1", core.MinAskDeadline)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	// face=500, rate=1 (PAR) -> creditsForAsk = ceil(500/1) = 500 credits
	// move into escrow: the holder's LIQUID balance drops to 9500, but
	// Supply (I3) stays 10000 -- the escrowed 500 are still outstanding.
	if got := core.BalanceOf(store, creator, holder); got.Cmp(big.NewInt(9500)) != 0 {
		t.Fatalf("holder balance after ask = %s, want 9500", got)
	}

	freezeBlock := registeredBlock + core.SubscriptionPeriod + core.GraceBlocks + 10
	if phase := core.Phase(store, creator, freezeBlock); phase != core.StateFrozen {
		t.Fatalf("phase at freezeBlock = %s, want FROZEN", phase)
	}

	mv1 := MarketView{
		Creator: creator, Phase: core.StateFrozen,
		Supply:  core.Supply(store, creator),
		Holders: []HolderBalance{{Holder: holder, Balance: core.BalanceOf(store, creator, holder)}},
	}
	sub1 := &coreSubmitter{store: store, caller: "hive:keeper-bot", block: freezeBlock}
	report1 := Sweep([]MarketView{mv1}, sub1, BackoffPolicy{MaxAttempts: 1}, nil)
	if report1.Failed != 0 {
		t.Fatalf("report1 had failures: %+v", report1)
	}
	if got := core.BalanceOf(store, creator, holder); got.Sign() != 0 {
		t.Fatalf("holder liquid balance after sweep 1 = %s, want 0 (fully refunded)", got)
	}
	if got := core.Supply(store, creator); got.Cmp(big.NewInt(500)) != 0 {
		t.Fatalf("supply after sweep 1 = %s, want 500 (still escrowed)", got)
	}

	// closeIfDrained must have been SUBMITTED successfully (it's a valid,
	// cheap call to make) but must NOT have actually closed the market --
	// the escrow is still open (SPEC §1.7.5: "in-flight asks are never cut
	// off").
	var closeOutcome *OpOutcome
	for i := range report1.Outcomes {
		if report1.Outcomes[i].Op.Kind == OpCloseIfDrained {
			closeOutcome = &report1.Outcomes[i]
		}
	}
	if closeOutcome == nil || closeOutcome.Err != nil {
		t.Fatalf("closeIfDrained submission itself must succeed (it is a valid, cheap no-op call): %+v", closeOutcome)
	}
	if closeOutcome.Receipt != "closed=false" {
		t.Fatalf("closeIfDrained receipt = %q, want closed=false (blocked by the outstanding escrow)", closeOutcome.Receipt)
	}
	if phase := core.Phase(store, creator, freezeBlock); phase != core.StateFrozen {
		t.Fatalf("phase after sweep 1 = %s, want still FROZEN", phase)
	}

	// Resolve the escrow: the asker reclaims once deadline+grace has
	// elapsed -- legal in FROZEN (ask.go: Reclaim consults no phase state).
	reclaimBlock := freezeBlock + 10
	if _, err := core.Reclaim(store, holder, creator, reclaimBlock, askResult.Seq); err != nil {
		t.Fatalf("Reclaim: %v", err)
	}
	if got := core.BalanceOf(store, creator, holder); got.Cmp(big.NewInt(500)) != 0 {
		t.Fatalf("holder balance after reclaim = %s, want 500", got)
	}

	// Next scheduled sweep (a fresh snapshot -- exactly how a real
	// deployment would notice the reclaim): the reclaimed credits are
	// refunded, and THIS time closeIfDrained actually closes the market.
	mv2 := MarketView{
		Creator: creator, Phase: core.Phase(store, creator, reclaimBlock),
		Supply:  core.Supply(store, creator),
		Holders: []HolderBalance{{Holder: holder, Balance: core.BalanceOf(store, creator, holder)}},
	}
	sub2 := &coreSubmitter{store: store, caller: "hive:keeper-bot", block: reclaimBlock}
	report2 := Sweep([]MarketView{mv2}, sub2, BackoffPolicy{MaxAttempts: 1}, nil)
	if report2.Failed != 0 {
		t.Fatalf("report2 had failures: %+v", report2)
	}
	if got := core.Supply(store, creator); got.Sign() != 0 {
		t.Fatalf("supply after sweep 2 = %s, want 0", got)
	}
	if phase := core.Phase(store, creator, reclaimBlock); phase != core.StateClosed {
		t.Fatalf("phase after sweep 2 = %s, want CLOSED", phase)
	}
}
