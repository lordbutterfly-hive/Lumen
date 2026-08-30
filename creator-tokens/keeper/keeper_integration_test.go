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
// core.Register/Buy/Ask/Reclaim/RefundHolder/CloseIfDrained functions — not
// a mock standing in for them. core is pure Go with no network dependency,
// so this is still a fast, deterministic `go test`; it is a genuine
// integration test of this package's Plan/Sweep against the real contract
// logic, in the same spirit as the imitated template's own
// TestRunCreateCycle_HappyPath (hive-price-market/scheduler/scheduler_test.go),
// which feeds a planned round straight into the real market.CreateRound.
//
// ★ FIXED (this pass): every test below called core.Prepay, which was
// deleted along with the PAR-mint mechanism (RULING A, RULINGS-v2-2026-07-21
// — core.Buy on the bonding curve is the only issuance path now); the whole
// file failed `go vet`/`go test` with "undefined: core.Prepay" before this
// fix (verified directly). Two more, quieter defects rode along with it,
// both invisible to `go build`/`go vet` because they are RUNTIME rejections,
// not compile errors:
//
//  1. Every core.Register call here posted face=500. MinFace was bumped to
//     577 by the 2026-07-27 commission carve-out (params.go — the posted
//     face is now grossed up so its post-commission TOKEN leg still clears
//     the C4 settlement floor), so every Register call in this file would
//     have reverted with "face out of range [MinFace, MaxFace]" the moment
//     the Prepay fix above made the file compile. Fixed by moving every
//     face literal to 1000 (comfortably above 577; matches BasePrice).
//  2. TestIntegration_CloseIfDrainedWaitsForOutstandingEscrow's core.Ask call
//     was missing offeringID (Ask's signature grew a 9th parameter for the
//     2026-07-27 offering catalogue) and relied on the DELETED TWAP-or-PAR
//     settlement fallback (RULING C, 2026-07-21: settlement now REFUSES
//     instead of falling back to PAR when neither observation window can
//     price) — with zero core.RecordObs calls for "creatorc", core.Ask would
//     refuse with an oracle error, never reach the credits-spent assertion
//     this test makes. Fixed by seeding both TWAP rings exactly the way
//     cmd/keeper/main.go's own demo scenario does for its "danerin" market
//     (33 constant-rate observations spaced core.LongObsSpacing apart) and
//     shrinking the funding buy from 10000 to 600 tokens so a face of 1000
//     (whose post-commission token leg is 880) can actually clear the C4/C5
//     settlement guards at that supply — a face/supply combination that
//     satisfies BOTH guards simultaneously stops existing once supply grows
//     much past this (settlement.go's ServiceFaceRange doc: the C4 floor
//     rises with the curve's average price, which is quadratic in supply).
//
// A FOURTH consequence, not a bug in this file but a real behaviour change
// every numeric assertion below had to account for: RULING K2's wind-down
// exit tax (exittax.go) now applies to Refund/RefundHolder, not just the
// curve Sell. A position bought right before a market's NATURAL lapse can
// never be old enough to owe zero tax by the time FROZEN begins —
// SubscriptionPeriod+GraceBlocks (35 days) is always LESS than
// ExitTaxDecayBlocks (42 days) — so every RefundHolder payout below is
// GROSS pro-rata minus a real, nonzero, computed tax, never the raw pro-rata
// share a PAR-era reader would expect. See expectedRefundHolderNet's own doc.
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

// expectedRefundHolderNet computes exactly what core.RefundHolder will pay a
// holder RIGHT NOW, by reading the same live reserve/supply/balance a real
// call would and applying core's own EXPORTED tax functions
// (ExitTaxBpsAt/ExitTaxOn). This is not a duplicate of any UNEXPORTED core
// formula: floor(reserve*bal/supply) is refund.go's own documented public
// contract for the pro-rata slice (RefundPrice's doc: "floor(reserve/supply)"
// per token), and ExitTaxBpsAt/ExitTaxOn are exported specifically so a
// caller — a quote UI, or this test — can reproduce the exact split before
// signing (exittax.go's own doc on why they're exported).
//
// heldFrom is the block the holder's ENTIRE position was acquired: every
// holder in these tests buys their whole balance in a single core.Buy call,
// so their hold clock is exactly that block (holdclock.go's C-14: a fresh
// account's wacq == the inflow block exactly) — this package cannot read the
// live wacq clock directly (holdclock.go's accessors are unexported), so the
// caller states it explicitly instead of this helper re-deriving it.
func expectedRefundHolderNet(store *core.MemStore, creator, holder string, heldFrom, atBlock uint64) *big.Int {
	reserve := core.Reserve(store, creator)
	supply := core.Supply(store, creator)
	bal := core.BalanceOf(store, creator, holder)
	gross := new(big.Int).Mul(reserve, bal)
	gross.Div(gross, supply)
	held := atBlock - heldFrom
	taxBps := core.ExitTaxBpsAt(held)
	tax := core.ExitTaxOn(gross, taxBps)
	return new(big.Int).Sub(gross, tax)
}

func TestIntegration_DoubleSubmitRefundHolderIsHarmless(t *testing.T) {
	store := core.NewMemStore()
	creator := "creatora"
	holder := "holder1"
	registeredBlock := uint64(1_000_000)
	const face = int64(1000) // >= MinFace (577) -- see file doc

	if err := core.Register(store, creator, creator, registeredBlock, face, 1_000_000); err != nil {
		t.Fatalf("Register: %v", err)
	}
	if _, err := core.Buy(store, holder, creator, registeredBlock+1, big.NewInt(5000)); err != nil {
		t.Fatalf("Buy: %v", err)
	}

	freezeBlock := registeredBlock + core.SubscriptionPeriod + core.GraceBlocks + 10
	if phase := core.Phase(store, creator, freezeBlock); phase != core.StateFrozen {
		t.Fatalf("phase at freezeBlock = %s, want FROZEN", phase)
	}

	// refundBlock: the block the actual RefundHolder calls execute at.
	// core.RefundHolder is gated by a SECOND, EXITTAX-1 condition beyond
	// "the market is FROZEN" (refund.go): the permissionless PUSH refuses
	// outright while the pushed holder's own exit tax is still nonzero,
	// UNLESS the market's wind-down has been open for a full
	// ExitTaxDecayBlocks (the market-level DoS backstop). A market that
	// lapses NATURALLY can never satisfy either arm right at freezeBlock —
	// SubscriptionPeriod+GraceBlocks (35 days) is always LESS than
	// ExitTaxDecayBlocks (42 days), so a holder who bought any time after
	// registration is still "fresh" the instant FROZEN begins, and the
	// backstop (measured from the SAME freeze block) hasn't opened yet
	// either. Discovered empirically: at freezeBlock, sub.Submit(refundOp)
	// returned "STATE: permissionless refundHolder is only available once
	// the holder's exit tax has fully decayed...". Advancing to a block a
	// full ExitTaxDecayBlocks past the buy clears the holder's OWN clock, so
	// the ordinary (non-backstop) branch fires -- the realistic case for a
	// buy-and-hold holder who simply never rushed to self-refund.
	// A1 (owner ruling 2026-08-30): a natural lapse is an inflow stop, not a
	// wind-down, so the keeper has nothing to sweep on it (core.RefundHolder
	// refuses; Plan skips non-retired markets). The wind-down these tests
	// exercise is entered the one way that still leads there: the creator
	// retires at the freeze. The subject of each test (double-submit
	// harmlessness, resume-mid-sweep, close-waits-for-escrow) is unchanged.
	if err := core.Retire(store, creator, creator, freezeBlock); err != nil {
		t.Fatalf("Retire: %v", err)
	}
	refundBlock := registeredBlock + 1 + core.ExitTaxDecayBlocks + 1000
	if phase := core.Phase(store, creator, refundBlock); phase != core.StateFrozen {
		t.Fatalf("phase at refundBlock = %s, want still FROZEN", phase)
	}

	mv := MarketView{
		Creator: creator,
		Phase:   core.StateFrozen,
		Retired: true, // A1: Plan sweeps retired markets only
		Supply:  core.Supply(store, creator),
		Holders: []HolderBalance{{Holder: holder, Balance: core.BalanceOf(store, creator, holder)}},
	}
	ops := Plan([]MarketView{mv})
	if len(ops) != 2 || ops[0].Kind != OpRefundHolder {
		t.Fatalf("ops = %+v, want [refundHolder, closeIfDrained]", ops)
	}
	refundOp := ops[0]

	sub := &coreSubmitter{store: store, caller: "hive:keeper-bot", block: refundBlock}

	// wantFirst: gross pro-rata (the holder owns the market's ENTIRE supply,
	// so gross == the full reserve) minus RULING K2's exit tax (which, at
	// refundBlock, is exactly 0 -- the holder's clock has fully decayed) --
	// computed BEFORE the refund, against the still-untouched
	// reserve/supply/balance.
	wantFirst := expectedRefundHolderNet(store, creator, holder, registeredBlock+1, refundBlock)

	receipt1, err := sub.Submit(refundOp)
	if err != nil {
		t.Fatalf("first Submit: %v", err)
	}
	if receipt1 != wantFirst.String() {
		t.Fatalf("first payout = %s, want %s (gross pro-rata minus the RULING-K2 exit tax on a position held since registeredBlock+1)", receipt1, wantFirst)
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
	const face = int64(1000) // >= MinFace (577) -- see file doc
	if err := core.Register(store, creator, creator, registeredBlock, face, 1_000_000); err != nil {
		t.Fatalf("Register: %v", err)
	}

	holders := []struct {
		name string
		amt  int64 // TOKEN COUNT bought (core.Buy mints exactly `amt` tokens along the curve) -- NOT an HBD amount, unlike the deleted Prepay's 1:1 PAR parameter
	}{
		{"big", 9000},
		{"mid", 3000},
		{"small", 1000},
	}
	for _, h := range holders {
		if _, err := core.Buy(store, h.name, creator, registeredBlock+1, big.NewInt(h.amt)); err != nil {
			t.Fatalf("Buy(%s): %v", h.name, err)
		}
	}
	// reserveTotal is read LIVE rather than summed from the `amt` literals
	// above: under the curve the reserve contribution of a buy is
	// BuyCost(supply-at-the-time, n), not `n` itself (PAR's old 1:1 identity
	// is gone), so a manual sum of token counts would not equal the actual
	// HBD the reserve now holds.
	reserveTotal := new(big.Int).Set(core.Reserve(store, creator))

	freezeBlock := registeredBlock + core.SubscriptionPeriod + core.GraceBlocks + 10
	if phase := core.Phase(store, creator, freezeBlock); phase != core.StateFrozen {
		t.Fatalf("phase = %s, want FROZEN", phase)
	}

	// refundBlock: see TestIntegration_DoubleSubmitRefundHolderIsHarmless's
	// own doc for why the ACTUAL RefundHolder calls need a block a full
	// ExitTaxDecayBlocks past the buy, not merely a block where Phase reads
	// FROZEN -- core.RefundHolder's EXITTAX-1 gate refuses a still-taxed
	// holder's push outright, and a naturally-lapsed market can never clear
	// that gate right at its own freeze point (35-day grace < 42-day decay).
	// A1 (owner ruling 2026-08-30): a natural lapse is an inflow stop, not a
	// wind-down, so the keeper has nothing to sweep on it (core.RefundHolder
	// refuses; Plan skips non-retired markets). The wind-down these tests
	// exercise is entered the one way that still leads there: the creator
	// retires at the freeze. The subject of each test (double-submit
	// harmlessness, resume-mid-sweep, close-waits-for-escrow) is unchanged.
	if err := core.Retire(store, creator, creator, freezeBlock); err != nil {
		t.Fatalf("Retire: %v", err)
	}
	refundBlock := registeredBlock + 1 + core.ExitTaxDecayBlocks + 1000

	snapshot := func() MarketView {
		var hb []HolderBalance
		for _, h := range holders {
			hb = append(hb, HolderBalance{Holder: h.name, Balance: core.BalanceOf(store, creator, h.name)})
		}
		_, retired := core.RetiredAt(store, creator)
		return MarketView{Creator: creator, Phase: core.Phase(store, creator, refundBlock), Retired: retired, Supply: core.Supply(store, creator), Holders: hb}
	}

	sub := &coreSubmitter{store: store, caller: "hive:keeper-bot", block: refundBlock}

	// wantBig: computed BEFORE any refund runs, against the fresh
	// reserve/supply/balance state left by the three buys above. All three
	// holders bought at the same block, well past decay by refundBlock, so
	// every tax below is 0 -- expectedRefundHolderNet still computes it via
	// the exported ExitTaxBpsAt/ExitTaxOn rather than assuming zero, so this
	// stays correct if either constant ever changes.
	wantBig := expectedRefundHolderNet(store, creator, "big", registeredBlock+1, refundBlock)

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
	if firstPayout != wantBig.String() {
		t.Fatalf("round1 first payout = %s, want %s (gross pro-rata minus the RULING-K2 exit tax)", firstPayout, wantBig)
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

	// wantMid/wantSmall: mirror core.RefundHolder's OWN sequential math
	// against the state round 2 will actually see -- Sweep processes "mid"
	// before "small" (largest balance first, keeper/plan.go), and each
	// refund changes the reserve/supply the NEXT one reads, so wantSmall is
	// computed against the state AFTER mid's (still only PREDICTED, not yet
	// applied) refund, using the same floor-division pro-rata + exported
	// ExitTaxBpsAt/ExitTaxOn core.RefundHolder itself uses.
	reserveAtR2 := core.Reserve(store, creator)
	supplyAtR2 := core.Supply(store, creator)
	midBal := core.BalanceOf(store, creator, "mid")
	smallBal := core.BalanceOf(store, creator, "small")
	held := refundBlock - (registeredBlock + 1) // all three bought at the same block; sub.block is the same fixed refundBlock for both rounds
	taxBps := core.ExitTaxBpsAt(held)           // identical for all three, for the same reason

	midGross := new(big.Int).Div(new(big.Int).Mul(reserveAtR2, midBal), supplyAtR2)
	midTax := core.ExitTaxOn(midGross, taxBps)
	wantMid := new(big.Int).Sub(midGross, midTax)

	reserveAfterMid := new(big.Int).Sub(reserveAtR2, midGross)
	supplyAfterMid := new(big.Int).Sub(supplyAtR2, midBal)
	smallGross := new(big.Int).Div(new(big.Int).Mul(reserveAfterMid, smallBal), supplyAfterMid)
	smallTax := core.ExitTaxOn(smallGross, taxBps)
	wantSmall := new(big.Int).Sub(smallGross, smallTax)

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
	// mid and small MUST both appear, succeed, and pay exactly the predicted
	// amount -- not skipped, not mispaid.
	seen := map[string]bool{}
	for _, o := range report.Outcomes {
		if o.Op.Kind != OpRefundHolder {
			continue
		}
		seen[o.Op.Holder] = true
		switch o.Op.Holder {
		case "mid":
			if o.Receipt != wantMid.String() {
				t.Fatalf("mid payout = %s, want %s", o.Receipt, wantMid)
			}
		case "small":
			if o.Receipt != wantSmall.String() {
				t.Fatalf("small payout = %s, want %s", o.Receipt, wantSmall)
			}
		}
	}
	if !seen["mid"] || !seen["small"] {
		t.Fatalf("round 2 skipped a holder that still had a balance: outcomes=%+v", report.Outcomes)
	}

	// ---- solvency check: EVERY base unit that ever entered the reserve is
	// accounted for as EITHER a holder payout OR the RULING-K2 exit tax carved
	// from it (never both, never neither) -- the exact identity C-24's
	// "terminal exactness" proves: Σgross == reserveTotal, and Σgross ==
	// Σnet + Σtax by construction, so totalPaid + totalTax == reserveTotal
	// EXACTLY, with zero slack. This replaces the old PAR-era
	// "totalPaid == reserveTotal" check, which assumed a tax-free wind-down
	// that no longer exists (RULING K2 taxes Refund/RefundHolder too).
	totalPaid := new(big.Int).Set(wantBig)
	for _, o := range report.Outcomes {
		if o.Op.Kind == OpRefundHolder && o.Err == nil {
			paid, ok := new(big.Int).SetString(o.Receipt, 10)
			if !ok {
				t.Fatalf("could not parse receipt %q as an integer", o.Receipt)
			}
			totalPaid.Add(totalPaid, paid)
		}
	}
	bigGross := new(big.Int).Sub(reserveTotal, reserveAtR2) // reserveTotal - reserveAtR2 == big's gross debit
	bigTax := core.ExitTaxOn(bigGross, taxBps)
	sumTax := new(big.Int).Add(bigTax, new(big.Int).Add(midTax, smallTax))
	gotSum := new(big.Int).Add(totalPaid, sumTax)
	if gotSum.Cmp(reserveTotal) != 0 {
		t.Fatalf("totalPaid(%s) + totalTax(%s) = %s, want exactly reserveTotal %s", totalPaid, sumTax, gotSum, reserveTotal)
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
	if got := core.Reserve(store, creator); got.Sign() != 0 {
		t.Fatalf("reserve after full sweep = %s, want 0 (C-24 terminal exactness -- nothing stranded)", got)
	}
	if phase := core.Phase(store, creator, refundBlock); phase != core.StateClosed {
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
	face := int64(1000) // >= MinFace (577) -- see file doc

	if err := core.Register(store, creator, creator, registeredBlock, face, 1_000_000); err != nil {
		t.Fatalf("Register: %v", err)
	}
	// 600 tokens, not 10000: at face=1000 the post-commission token leg (880)
	// only clears the C4/C5 settlement guards together at a modest supply --
	// see the file doc's point 2. Mirrors cmd/keeper/main.go's own "danerin"
	// demo market exactly (same face, same buy size, same TWAP seeding), so
	// the two are cross-checked against each other, not just against hand math.
	if _, err := core.Buy(store, holder, creator, registeredBlock+1, big.NewInt(600)); err != nil {
		t.Fatalf("Buy: %v", err)
	}

	// RULING C (2026-07-21): the PAR fallback is DELETED -- core.Ask refuses
	// unless BOTH observation windows (short + 7-day long) can price, so this
	// test must feed a real two-ring history the way live trading would,
	// exactly like cmd/keeper/main.go's own demo does for its "danerin"
	// market: 33 constant-rate observations spaced core.LongObsSpacing apart
	// (33, not 32: the funding Buy above already fed both rings ONE
	// observation at the curve's own marginal rate, which this constant
	// marker series deviates from beyond MaxRateDeviationBps, so one extra
	// write is needed to evict it from both 32-slot rings). The marker rate
	// 1000 sits in the coherent band for S=600: the C5 tripwire needs
	// rate >= ceil(area(600)/600)/4 = 921, and the C4 minimum-price guard
	// needs rate <= 2·tokenLeg = 2·880 = 1760 (tokenLeg = face - commission =
	// 1000 - 120, the 2026-07-27 commission carve-out — C4 measures the TOKEN
	// leg, never the raw posted face); spot(600) = 6670 stays the ceiling. So
	// settlement = min(1000, 1000, 6670) = 1000.
	obsRate := big.NewInt(1000)
	lastObs := registeredBlock + 10
	for i := uint64(0); i < 33; i++ {
		lastObs = registeredBlock + 10 + i*core.LongObsSpacing
		core.RecordObs(store, creator, lastObs, obsRate)
	}
	askBlock := lastObs + 50

	// commissionOwed (H2 defect fix, 2026-07-21): core.Ask requires
	// commissionHbdPaid to EXACTLY equal commissionOwedFor(face) — floor(face
	// * CommissionBps / 10000), not merely be >= it. face=1000 * 1200bps /
	// 10000 = 120.
	commissionOwed := new(big.Int).Mul(big.NewInt(face), big.NewInt(int64(core.CommissionBps)))
	commissionOwed.Div(commissionOwed, big.NewInt(10000))
	// maxCredits=1: tokenLeg(880)/rate(1000) settles to exactly 1 credit
	// (ceil(880/1000) == 1), so 1 is the asker's own tight slippage cap, not
	// an arbitrary round number.
	askResult, err := core.Ask(store, holder, creator, askBlock, big.NewInt(1), commissionOwed, "content-hash-1", core.MinAskDeadline, 0)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	// tokenLeg=880, rate=1000 -> creditsForAsk = ceil(880/1000) = 1 credit
	// moves into escrow: the holder's LIQUID balance drops to 599, but Supply
	// (I3) stays 600 -- the escrowed 1 credit is still outstanding.
	if got := core.BalanceOf(store, creator, holder); got.Cmp(big.NewInt(599)) != 0 {
		t.Fatalf("holder balance after ask = %s, want 599", got)
	}

	freezeBlock := registeredBlock + core.SubscriptionPeriod + core.GraceBlocks + 10
	if phase := core.Phase(store, creator, freezeBlock); phase != core.StateFrozen {
		t.Fatalf("phase at freezeBlock = %s, want FROZEN", phase)
	}

	// refundBlock: see TestIntegration_DoubleSubmitRefundHolderIsHarmless's
	// own doc for why the ACTUAL RefundHolder calls need a block a full
	// ExitTaxDecayBlocks past the buy (registeredBlock+1) -- core.RefundHolder's
	// EXITTAX-1 gate refuses a still-taxed holder's push outright, and this
	// naturally-lapsed market cannot clear that gate right at freezeBlock.
	// A1 (owner ruling 2026-08-30): a natural lapse is an inflow stop, not a
	// wind-down, so the keeper has nothing to sweep on it (core.RefundHolder
	// refuses; Plan skips non-retired markets). The wind-down these tests
	// exercise is entered the one way that still leads there: the creator
	// retires at the freeze. The subject of each test (double-submit
	// harmlessness, resume-mid-sweep, close-waits-for-escrow) is unchanged.
	if err := core.Retire(store, creator, creator, freezeBlock); err != nil {
		t.Fatalf("Retire: %v", err)
	}
	refundBlock := registeredBlock + 1 + core.ExitTaxDecayBlocks + 1000
	if phase := core.Phase(store, creator, refundBlock); phase != core.StateFrozen {
		t.Fatalf("phase at refundBlock = %s, want still FROZEN", phase)
	}

	mv1 := MarketView{
		Creator: creator, Phase: core.StateFrozen, Retired: true, // A1: Plan sweeps retired markets only
		Supply:  core.Supply(store, creator),
		Holders: []HolderBalance{{Holder: holder, Balance: core.BalanceOf(store, creator, holder)}},
	}
	sub1 := &coreSubmitter{store: store, caller: "hive:keeper-bot", block: refundBlock}
	report1 := Sweep([]MarketView{mv1}, sub1, BackoffPolicy{MaxAttempts: 1}, nil)
	if report1.Failed != 0 {
		t.Fatalf("report1 had failures: %+v", report1)
	}
	if got := core.BalanceOf(store, creator, holder); got.Sign() != 0 {
		t.Fatalf("holder liquid balance after sweep 1 = %s, want 0 (fully refunded)", got)
	}
	if got := core.Supply(store, creator); got.Cmp(big.NewInt(1)) != 0 {
		t.Fatalf("supply after sweep 1 = %s, want 1 (still escrowed)", got)
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
	if phase := core.Phase(store, creator, refundBlock); phase != core.StateFrozen {
		t.Fatalf("phase after sweep 1 = %s, want still FROZEN", phase)
	}

	// Resolve the escrow: the asker reclaims once deadline+grace has
	// elapsed -- legal in FROZEN (ask.go: Reclaim consults no phase state).
	reclaimBlock := refundBlock + 10
	if _, err := core.Reclaim(store, holder, creator, reclaimBlock, askResult.Seq); err != nil {
		t.Fatalf("Reclaim: %v", err)
	}
	if got := core.BalanceOf(store, creator, holder); got.Cmp(big.NewInt(1)) != 0 {
		t.Fatalf("holder balance after reclaim = %s, want 1", got)
	}

	// Next scheduled sweep (a fresh snapshot -- exactly how a real
	// deployment would notice the reclaim): the reclaimed credits are
	// refunded, and THIS time closeIfDrained actually closes the market.
	_, retired2 := core.RetiredAt(store, creator)
	mv2 := MarketView{
		Creator: creator, Phase: core.Phase(store, creator, reclaimBlock), Retired: retired2,
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
