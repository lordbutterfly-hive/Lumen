//go:build pruned_findings

// ════ AUDIT FINDING-DETECTOR, NOT A UNIT TEST ════
//
// This file FAILS ON PURPOSE. Each test asserts the ABSENCE of a defect the PRUNED audit
// of 2026-08-19 proved is PRESENT, so a failure here is the finding reproducing itself,
// not a regression.
//
// ★ IT IS BEHIND A BUILD TAG SO THE DEFAULT SUITE STAYS GREEN. Left untagged, `go test
// ./...` was red for reasons that are all known and documented - which destroys the one
// thing a suite is for: telling you when something NEW broke. A permanently-red suite is
// a suite nobody reads.
//
//   run the detectors:  go test -tags pruned_findings ./...
//   run the real suite: go test ./...
//
// When a finding is FIXED, its detector here starts passing. That is the intended signal:
// delete the test then, or move it into the real suite as a regression guard.
//
// Findings, artifacts and twins: /mnt/o/LUMEN-DOCS/audits/creator-tokens/2026-08-19/

package keeper

// zz_pruned_phase2_deviation_test.go — PRUNED Phase 2 (deviation hunt), keeper.
// SCRATCH / AUDIT ARTEFACT. Not part of the product test suite. Delete freely.
//
// Every assertion below runs the REAL core package against a REAL core.MemStore
// and the REAL keeper.Plan / keeper.Sweep. Nothing is mocked.

import (
	"fmt"
	"math/big"
	"strings"
	"testing"
	"time"

	"creator-tokens/core"
)

// ---------------------------------------------------------------------------
// scenario builders (mirrors cmd/keeper/main.go's own demo timings exactly)
// ---------------------------------------------------------------------------

const (
	zzRegBlock = uint64(1_000_000)
	zzFace     = int64(1000)
	zzCap      = int64(1_000_000)
)

func zzMust(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("setup failed: %v", err)
	}
}

// zzLapsedMarket reproduces cmd/keeper's shipped demo: register at 1_000_000,
// one holder buys at +1, subscription lapses naturally, "now" is 500 blocks
// into wind-down.
func zzLapsedMarket(t *testing.T, creator, holder string, tokens int64) (*core.MemStore, uint64) {
	t.Helper()
	s := core.NewMemStore()
	zzMust(t, core.Register(s, creator, creator, zzRegBlock, zzFace, zzCap))
	_, err := core.Buy(s, holder, creator, zzRegBlock+1, big.NewInt(tokens))
	zzMust(t, err)
	lapse := zzRegBlock + core.SubscriptionPeriod + core.GraceBlocks
	return s, lapse + 500 // cmd/keeper/main.go:179 demoBlock
}

func zzViews(s *core.MemStore, block uint64, creator string, holders ...string) []MarketView {
	hv := make([]HolderBalance, 0, len(holders))
	for _, h := range holders {
		hv = append(hv, HolderBalance{Holder: h, Balance: core.BalanceOf(s, creator, h)})
	}
	_, retired := core.RetiredAt(s, creator)
	return []MarketView{{
		Creator: creator,
		Phase:   core.Phase(s, creator, block),
		Retired: retired,
		Supply:  core.Supply(s, creator),
		Holders: hv,
	}}
}

// ---------------------------------------------------------------------------
// D1. Plan is BLIND to the contract's second push gate (EXITTAX-1 / NOTICE-1).
//     Every refundHolder op the shipped demo emits is REFUSED on chain, and
//     Sweep reports every one of them as Succeeded.
// ---------------------------------------------------------------------------

// TestZZ_D1 has been REMOVED, 2026-08-19, because the defect it measured is
// FIXED and the test asserted the DEFECT. It pinned `rep.Succeeded == len(ops)`
// on a sweep whose ops all revert on chain — which is precisely the lie F9
// removed: Succeeded now means "chain execution confirmed", and a transport-only
// ack counts as Unverified. Left in place it would be a permanently red detector
// insisting on behaviour the contract no longer has.
//
// Its coverage moved into the tracked suite, where it guards the fix instead of
// documenting the hole:
//   - keeper/plan_test.go  TestPlan_RefundBlockedHolderProducesNoRefundHolderOp
//   - keeper/plan_test.go  TestPlan_RealCore_NoRefundHolderOpInsideExitTaxWindow
//   - keeper/sweep_test.go TestSweep_ConfirmedRevertIsRecordedFailedNeverSucceeded
//   - keeper/sweep_test.go TestSweep_NoExecutionVerifierIsUnverifiedNotSucceeded
//
// D1b, D6 and D7 are untouched and still pass: D1b measures the window boundary
// (a fact about the contract, not about the keeper's honesty), and D6/D7 use the
// audit's own zzViews helper, deliberately left un-updated so they keep
// measuring what they always measured.
func TestZZ_D1b_BlindWindowLength(t *testing.T) {
	const creator, holder = "aliceart", "patron1"
	s, _ := zzLapsedMarket(t, creator, holder, 400)
	lapse := zzRegBlock + core.SubscriptionPeriod + core.GraceBlocks

	firstAccepted := uint64(0)
	for _, d := range []uint64{500, core.BlocksPerDay, 10 * core.BlocksPerDay, 20 * core.BlocksPerDay,
		30 * core.BlocksPerDay, 41 * core.BlocksPerDay, core.ExitTaxDecayBlocks - 1, core.ExitTaxDecayBlocks} {
		blk := lapse + d
		// fresh store per probe so an accepted push does not poison later ones
		s2, _ := zzLapsedMarket(t, creator, holder, 400)
		ops := Plan(zzViews(s2, blk, creator, holder)) // BEFORE the push, so Plan sees the live snapshot
		_, err := core.RefundHolder(s2, "hive:keeperbot", creator, holder, blk)
		planned := 0
		for _, o := range ops {
			if o.Kind == OpRefundHolder {
				planned++
			}
		}
		status := "REFUSED"
		if err == nil {
			status = "accepted"
			if firstAccepted == 0 {
				firstAccepted = d
			}
		}
		t.Logf("D1b winddown+%-9d blocks (%5.1f days): Plan emits %d refundHolder op(s); chain %s",
			d, float64(d)/float64(core.BlocksPerDay), planned, status)
	}
	_ = s
	t.Logf("D1b: ExitTaxDecayBlocks = %d blocks = %.0f days. Plan has ZERO terms referencing it.",
		core.ExitTaxDecayBlocks, float64(core.ExitTaxDecayBlocks)/float64(core.BlocksPerDay))
	t.Logf("D1b: first accepted at winddown+%d", firstAccepted)

	// WORST CASE: a holder who buys on the LAST block before the freeze. Their
	// clock is maximally fresh at wind-down open, so the blind window is the
	// full ExitTaxDecayBlocks.
	lateS := core.NewMemStore()
	zzMust(t, core.Register(lateS, creator, creator, zzRegBlock, zzFace, zzCap))
	freeze := zzRegBlock + core.SubscriptionPeriod + core.GraceBlocks
	_, e := core.Buy(lateS, holder, creator, freeze-1, big.NewInt(400))
	zzMust(t, e)
	for _, d := range []uint64{1, 7 * core.BlocksPerDay, 41 * core.BlocksPerDay, core.ExitTaxDecayBlocks - 2, core.ExitTaxDecayBlocks} {
		blk := freeze + d
		s3 := core.NewMemStore()
		zzMust(t, core.Register(s3, creator, creator, zzRegBlock, zzFace, zzCap))
		_, e3 := core.Buy(s3, holder, creator, freeze-1, big.NewInt(400))
		zzMust(t, e3)
		ops := Plan(zzViews(s3, blk, creator, holder))
		planned := 0
		for _, o := range ops {
			if o.Kind == OpRefundHolder {
				planned++
			}
		}
		_, err := core.RefundHolder(s3, "hive:keeperbot", creator, holder, blk)
		status := "REFUSED"
		if err == nil {
			status = "accepted"
		}
		t.Logf("D1b LATE BUYER (bought at freeze-1) winddown+%-9d (%5.1f days): Plan emits %d op(s); chain %s",
			d, float64(d)/float64(core.BlocksPerDay), planned, status)
	}
}

// ---------------------------------------------------------------------------
// D2. THE KEEPER PROFIT MODEL. Once the market-level DoS backstop is open, a
//     push fires at the holder's LIVE clock. The keeper alone chooses the
//     block, so the keeper alone chooses the tax rate — and its operator banks
//     the platform half of every unit of that tax.
// ---------------------------------------------------------------------------

// zzBackstopOpenMarketWithFreshHolder builds a market that has been winding
// down for a full ExitTaxDecayBlocks (so the backstop is open) and then hands
// a position to `victim` via TransferCredits, which resets the victim's hold
// clock to fully fresh.
func zzBackstopOpenMarketWithFreshHolder(t *testing.T, creator, seller, victim string) (*core.MemStore, uint64) {
	t.Helper()
	s := core.NewMemStore()
	zzMust(t, core.Register(s, creator, creator, zzRegBlock, zzFace, zzCap))
	_, err := core.Buy(s, seller, creator, zzRegBlock+1, big.NewInt(400))
	zzMust(t, err)
	lapse := zzRegBlock + core.SubscriptionPeriod + core.GraceBlocks
	handover := lapse + core.ExitTaxDecayBlocks + 1 // backstop is open
	zzMust(t, core.TransferCredits(s, seller, creator, seller, victim, handover, big.NewInt(400)))
	return s, handover
}

func zzPush(t *testing.T, s *core.MemStore, creator, holder string, block uint64) (gross, tax, net, creatorHalf *big.Int) {
	t.Helper()
	resBefore := core.Reserve(s, creator)
	feeBefore := core.FeeBalanceOf(s, creator)
	n, err := core.RefundHolder(s, "hive:keeperbot", creator, holder, block)
	if err != nil {
		t.Fatalf("push at block %d refused: %v", block, err)
	}
	gross = new(big.Int).Sub(resBefore, core.Reserve(s, creator))
	net = n
	tax = new(big.Int).Sub(gross, net)
	creatorHalf = new(big.Int).Sub(core.FeeBalanceOf(s, creator), feeBefore)
	return
}

func TestZZ_D2_KeeperBlockChoiceIsAPricedLever_REFUTED(t *testing.T) {
	// HYPOTHESIS UNDER TEST (from the model, T3 / A-KP-1): "Timing is not
	// economically neutral: the wind-down exit tax is a function of the block
	// (core/refund.go:386-470), so the block at which a push lands decides how
	// much of that holder's payout is carved to the treasury."
	//
	// RESULT: REFUTED at this pin. Recorded, not deleted. See D9 for the proof
	// of WHY (no fresh clock can enter a market after wind-down opens, so every
	// legal push is already at tau = 0) and D10 for the mechanism (maturity
	// travels with the tokens; a transfer cannot reset a clock).
	const creator, seller, victim = "aliceart", "patron1", "patron2"

	sEarly, handover := zzBackstopOpenMarketWithFreshHolder(t, creator, seller, victim)
	early := handover + 1
	ops := Plan(zzViews(sEarly, early, creator, victim))
	if len(ops) == 0 || ops[0].Kind != OpRefundHolder || ops[0].Holder != victim {
		t.Fatalf("D2: Plan did not emit the push it needs to: %v", ops)
	}
	gE, taxE, netE, chE := zzPush(t, sEarly, creator, victim, early)

	sLate, handover2 := zzBackstopOpenMarketWithFreshHolder(t, creator, seller, victim)
	late := handover2 + core.ExitTaxDecayBlocks
	gL, taxL, netL, chL := zzPush(t, sLate, creator, victim, late)

	t.Logf("D2 EARLIEST legal push (block %d, 1 block after an OTC handover): gross=%v tax=%v net=%v creatorHalf=%v platformHalf=%v",
		early, gE, taxE, netE, chE, new(big.Int).Sub(taxE, chE))
	t.Logf("D2 LATEST    push (block %d, +42 days):                          gross=%v tax=%v net=%v creatorHalf=%v platformHalf=%v",
		late, gL, taxL, netL, chL, new(big.Int).Sub(taxL, chL))
	if gE.Cmp(gL) != 0 {
		t.Fatalf("D2: gross differs between runs (%v vs %v)", gE, gL)
	}
	if taxE.Sign() != 0 || taxL.Sign() != 0 {
		t.Fatalf("D2: hypothesis is NOT refuted after all — a taxed push landed (early=%v late=%v). Re-open the profit model.", taxE, taxL)
	}
	t.Logf("D2 VERDICT: the keeper's block choice moved 0 HBD. The timing lever is worth ZERO, for every block the push is legal at.")
	t.Logf("D2 keeper.go:39-42's AMOUNT claim therefore holds — but not for the reason the model gives, and core/refund.go:485-503 asserts the opposite.")
}

// D2b. The same, swept across the whole legal window rather than two endpoints.
func TestZZ_D2b_TaxIsZeroAtEveryLegalPushBlock(t *testing.T) {
	const creator, seller, victim = "aliceart", "patron1", "patron2"
	for _, frac := range []uint64{0, 1, 7, 14, 21, 28, 35, 42} {
		s, handover := zzBackstopOpenMarketWithFreshHolder(t, creator, seller, victim)
		blk := handover + frac*core.BlocksPerDay + 1
		g, tax, net, ch := zzPush(t, s, creator, victim, blk)
		plat := new(big.Int).Sub(tax, ch)
		bps := big.NewInt(0)
		if g.Sign() > 0 {
			bps = new(big.Int).Div(new(big.Int).Mul(tax, big.NewInt(10000)), g)
		}
		t.Logf("D2b keeper waits %2d day(s): rate=%4v bps  gross=%v  holder nets %v  creator +%v  PLATFORM +%v",
			frac, bps, g, net, ch, plat)
		if tax.Sign() != 0 {
			t.Errorf("D2b: nonzero tax %v at +%d days — the lever exists after all", tax, frac)
		}
	}
	t.Logf("D2b MaxExitTaxBps=%d, ExitTaxDecayBlocks=%d (%.0f days). accrueExitTax: creatorHalf=floor(tax/2)->kFeeBal(creator), platformHalf=remainder->kTreasury (core/exittax.go:209-221).",
		core.MaxExitTaxBps, core.ExitTaxDecayBlocks, float64(core.ExitTaxDecayBlocks)/float64(core.BlocksPerDay))
	t.Logf("D2b The ONLY way the platform half is ever credited by a PUSH is the core/refund.go:485-487 branch, which D9 shows is unreachable.")
}

// ---------------------------------------------------------------------------
// D3. plan.go's doc says one OpCloseIfDrained is appended "per FROZEN market".
//     The code appends one per ACTIONABLE market (retired OR frozen), and
//     core.CloseIfDrained refuses anything that is not FROZEN.
// ---------------------------------------------------------------------------

func TestZZ_D3_CloseIfDrainedPlannedForNonFrozenRetiredMarket(t *testing.T) {
	const creator = "aliceart"
	s := core.NewMemStore()
	zzMust(t, core.Register(s, creator, creator, zzRegBlock, zzFace, zzCap))
	retireAt := zzRegBlock + 10
	zzMust(t, core.Retire(s, creator, creator, retireAt))

	for _, d := range []uint64{1, core.GraceBlocks - 1, core.GraceBlocks, core.GraceBlocks + 1} {
		blk := retireAt + d
		ph := core.Phase(s, creator, blk)
		ops := Plan(zzViews(s, blk, creator))
		closes := 0
		for _, o := range ops {
			if o.Kind == OpCloseIfDrained {
				closes++
			}
		}
		// probe on a throwaway store so a real close does not poison later probes
		s2 := core.NewMemStore()
		zzMust(t, core.Register(s2, creator, creator, zzRegBlock, zzFace, zzCap))
		zzMust(t, core.Retire(s2, creator, creator, retireAt))
		closed := core.CloseIfDrained(s2, creator, blk)
		t.Logf("D3 retire+%-7d phase=%-8s supply=%v  Plan emits %d closeIfDrained  core.CloseIfDrained -> %v",
			d, ph, core.Supply(s, creator), closes, closed)
		if closes != 1 {
			t.Fatalf("D3: expected exactly 1 planned close, got %d", closes)
		}
	}
	t.Logf("D3: plan.go:136 says \"per FROZEN market\"; plan.go:186 appends per ACTIONABLE market. core/refund.go:566-573 refuses any phase but FROZEN.")
}

// ---------------------------------------------------------------------------
// D4. accountName's full input domain (wire.go:93-98). SWEEP, not one case.
// ---------------------------------------------------------------------------

func TestZZ_D4_AccountNameFullDomain(t *testing.T) {
	cases := []struct {
		in, why string
	}{
		{"hive:alice", "the only shape the package documents"},
		{"alice", "bare name (cmd/keeper --caller could be given this)"},
		{"hive:", "empty body after the scheme"},
		{":alice", "empty scheme"},
		{"", "empty caller"},
		{"did:pkh:eip155:1:0xAbC0000000000000000000000000000000000000", "an EVM DID caller (sdk/address.go:78 calls this a valid identity)"},
		{"did:pkh:bip122:000000000019d6689c085ae165831e93:1BvBMS", "a BTC DID caller"},
		{"system:treasury", "a system address"},
		{"contract:vsc1BcaD8JrwJPAAN5cU1cHKCBdZrd7jz2WGt8", "a contract caller"},
		{"hive:alice:extra", "a colon inside the body"},
	}
	t.Logf("D4 %-58s -> %-40s  %s", "caller", "required_auths[0]", "note")
	for _, c := range cases {
		got := accountName(c.in)
		flag := ""
		if got == "" || strings.ContainsAny(got, ":") || len(got) > 16 {
			flag = "  <-- NOT A VALID HIVE ACCOUNT NAME"
		}
		t.Logf("D4 %-58q -> %-40q  %s%s", c.in, got, c.why, flag)
	}
	t.Logf("D4: wire.go:122 puts this value straight into required_auths with no validation; contract/main.go:207-212 (requireActiveAuth) compares auths[0] against the caller string.")
}

// ---------------------------------------------------------------------------
// D5. T11 executable: a holder string that differs from the contract's own key
//     by ONE byte is a (0, nil) success, indistinguishable from a real refund.
// ---------------------------------------------------------------------------

func TestZZ_D5_HolderStringDriftIsIndistinguishableFromSuccess(t *testing.T) {
	const creator = "aliceart"
	realHolder := "hive:patron1"
	s := core.NewMemStore()
	zzMust(t, core.Register(s, creator, creator, zzRegBlock, zzFace, zzCap))
	_, err := core.Buy(s, realHolder, creator, zzRegBlock+1, big.NewInt(400))
	zzMust(t, err)
	lapse := zzRegBlock + core.SubscriptionPeriod + core.GraceBlocks
	now := lapse + core.ExitTaxDecayBlocks + 1 // backstop open, so nothing else can refuse

	for _, variant := range []string{
		realHolder,      // byte-identical
		"patron1",       // scheme stripped (what accountName would produce)
		"HIVE:patron1",  // case-folded scheme
		"hive:Patron1",  // case-folded body
		"hive:patron1 ", // trailing space
		" hive:patron1", // leading space
	} {
		s2 := core.NewMemStore()
		zzMust(t, core.Register(s2, creator, creator, zzRegBlock, zzFace, zzCap))
		_, e := core.Buy(s2, realHolder, creator, zzRegBlock+1, big.NewInt(400))
		zzMust(t, e)
		balBefore := core.BalanceOf(s2, creator, realHolder)
		payout, err2 := core.RefundHolder(s2, "hive:keeperbot", creator, variant, now)
		balAfter := core.BalanceOf(s2, creator, realHolder)
		verdict := "PAID"
		if err2 != nil {
			verdict = "error: " + err2.Error()
		} else if payout.Sign() == 0 && balBefore.Cmp(balAfter) == 0 {
			verdict = "(0, nil) SILENT NO-OP — keeper records this as Succeeded"
		}
		t.Logf("D5 holder=%-16q payout=%-8v realHolder bal %v -> %v   %s",
			variant, payout, balBefore, balAfter, verdict)
	}
	t.Logf("D5: core/util.go:137-149 validAccount accepts every variant above (printable ASCII, no '|'), so none is rejected at the door.")
}

// ---------------------------------------------------------------------------
// D6. SWEEP-OR-FAIL: enumerate EVERY contract-side gate on each of the two ops
//     the keeper builds, and mark whether Plan models it.
// ---------------------------------------------------------------------------

func TestZZ_D6_GateSweep(t *testing.T) {
	type gate struct{ op, where, gateName, modelled string }
	rows := []gate{
		{"refundHolder", "contract/main.go:1599", "requireActiveAuth(caller)", "YES — wire.go:122 routes the bot into required_auths"},
		{"refundHolder", "core/refund.go:363", "caller != \"\"", "YES — cmd/keeper always sets --caller"},
		{"refundHolder", "core/refund.go:366", "validAccount(creator)", "NO — Op.Creator is passed through unvalidated (plan.go:184)"},
		{"refundHolder", "core/refund.go:369", "validAccount(holder)", "NO — Op.Holder is passed through unvalidated (plan.go:184)"},
		{"refundHolder", "core/refund.go:372", "inWindDown(creator, block)", "YES — plan.go:165 mirrors it (minus CLOSED)"},
		{"refundHolder", "core/refund.go:380", "totalBalance > 0 (else (0,nil) no-op)", "YES — plan.go:171 filters Balance <= 0"},
		{"refundHolder", "core/refund.go:479", "ExitTaxBpsAt(heldBlocksAt(...)) == 0 ...", "NO — no term in the keeper package mentions the exit tax at all"},
		{"refundHolder", "core/refund.go:481", "... OR block-windDownOpenBlock >= ExitTaxDecayBlocks", "NO — MarketView carries no wind-down-open block"},
		{"refundHolder", "core/refund.go:490", "supply != 0", "PARTIAL — MarketView.Supply exists but plan.go never branches on it"},
		{"refundHolder", "contract/main.go:1620", "isPayableAddress(holder)", "NO — the keeper cannot see this and it reverts AFTER the burn"},
		{"closeIfDrained", "contract/main.go:1661", "requireActiveAuth(caller)", "YES"},
		{"closeIfDrained", "core/refund.go:563", "kRegisteredAt != 0", "NO — nothing in MarketView says whether a market was ever registered"},
		{"closeIfDrained", "core/refund.go:566", "Phase == FROZEN (not merely retired)", "NO — plan.go:186 appends for retired-not-frozen too"},
		{"closeIfDrained", "core/refund.go:574", "supply == 0", "NO — deliberate, documented at plan.go:136-152"},
	}
	modelled, unmodelled := 0, 0
	t.Logf("D6 %-14s %-26s %-46s %s", "op", "gate site", "gate", "modelled by keeper.Plan?")
	for _, r := range rows {
		if strings.HasPrefix(r.modelled, "YES") {
			modelled++
		} else {
			unmodelled++
		}
		t.Logf("D6 %-14s %-26s %-46s %s", r.op, r.where, r.gateName, r.modelled)
	}
	t.Logf("D6 TOTAL: %d gates modelled, %d NOT modelled, of %d contract-side gates on the keeper's two ops.", modelled, unmodelled, len(rows))
}

// ---------------------------------------------------------------------------
// D7. Invariant 18 (sdk-runtime-keeper.md): "SweepReport.Succeeded is never
//     consumed anywhere as evidence that a refund was paid." Executable half:
//     show that Succeeded is set purely by transport.
// ---------------------------------------------------------------------------

type zzAlwaysOKSubmitter struct{ n int }

func (z *zzAlwaysOKSubmitter) Submit(op Op) (string, error) {
	z.n++
	return fmt.Sprintf("tx-%d", z.n), nil
}

func TestZZ_D7_SucceededMeansTransportOnly(t *testing.T) {
	const creator, holder = "aliceart", "patron1"
	s, now := zzLapsedMarket(t, creator, holder, 400)
	views := zzViews(s, now, creator, holder)

	sub := &zzAlwaysOKSubmitter{}
	rep := Sweep(views, sub, DefaultBackoffPolicy(), func(time.Duration) {})

	// The contract state was never touched by the submitter, and Sweep still
	// reports a clean run.
	t.Logf("D7 Sweep: %d succeeded, %d failed, %d Submit calls. Receipts: transport identifiers only.", rep.Succeeded, rep.Failed, sub.n)
	for _, o := range rep.Outcomes {
		t.Logf("D7   %-44s receipt=%q err=%v", o.Op.String(), o.Receipt, o.Err)
	}
	if rep.Failed != 0 {
		t.Fatalf("D7: expected 0 failures from an always-OK submitter, got %d", rep.Failed)
	}
	// And the chain-side truth for the same ops at the same block:
	for _, o := range rep.Outcomes {
		if o.Op.Kind != OpRefundHolder {
			continue
		}
		if _, err := core.RefundHolder(s, "hive:keeperbot", o.Op.Creator, o.Op.Holder, now); err != nil {
			t.Logf("D7   ^ that receipt corresponds to a call the contract REFUSES: %v", err)
		}
	}
	t.Logf("D7 sweep.go:77-81 sets Succeeded on err==nil from Submit. sweep.go/submit.go contain no term that could observe a revert.")
}

// D8. cmd/keeper/main.go:120-126 is the only consumer of SweepReport today.
// It prints Succeeded/Failed and, for failures only, the words "this is
// INCONVENIENCE, not harm". Nothing prints anything about a succeeded op that
// reverted, because nothing can know.

// ---------------------------------------------------------------------------
// D9. THE KEEPER PROFIT MODEL, resolved. The brief's hypothesis was that the
//     keeper's block choice sits inside the exit-tax schedule and is therefore
//     a priced lever. It is NOT — and the reason is a second deviation.
//
//     core/refund.go:480-487 (the FIX ROUND 2 "DoS backstop") says the push may
//     fire past a still-taxed clock once the market has been winding down for a
//     full ExitTaxDecayBlocks, "taxing whatever their live clock reads (a
//     possibly-nonzero, griefer-refreshed rate)". That branch is UNREACHABLE at
//     this pin: TOKEN MATURITY (2026-07-27, five days AFTER the backstop) made a
//     clock un-refreshable, and no fresh clock can enter a market after
//     wind-down opens because every inflow path is gated shut.
//
//     Consequence for the keeper: there is no block at which a legal push is
//     taxed, so the keeper's timing choice moves ZERO money. keeper.go:39-42's
//     safety claim survives on AMOUNT — but for a reason its own model does not
//     state, and one the contract's comments actively contradict.
// ---------------------------------------------------------------------------

func TestZZ_D9_TaxedPushIsUnreachable_BackstopIsDeadCode(t *testing.T) {
	const creator = "aliceart"
	freeze := zzRegBlock + core.SubscriptionPeriod + core.GraceBlocks // windDownOpen for a natural lapse

	// (a) every inflow path is shut once wind-down opens — so no fresh clock
	//     can be minted after windDownOpen. SWEEP: both RequireInflowOpen
	//     callers (core/buy.go:106 Buy, core/ask.go:368 Ask).
	for _, d := range []uint64{0, 1, core.BlocksPerDay, core.ExitTaxDecayBlocks, 2 * core.ExitTaxDecayBlocks} {
		s := core.NewMemStore()
		zzMust(t, core.Register(s, creator, creator, zzRegBlock, zzFace, zzCap))
		blk := freeze + d
		_, errBuy := core.Buy(s, "newbuyer", creator, blk, big.NewInt(10))
		errInflow := core.RequireInflowOpen(s, creator, blk)
		t.Logf("D9a winddown+%-9d  RequireInflowOpen -> %v | core.Buy -> %v", d, errInflow, errBuy)
		if errBuy == nil {
			t.Fatalf("D9a REFUTED: a fresh mint landed at winddown+%d", d)
		}
	}

	// (b) SEARCH: try every wind-down-legal way to move credits around and see
	//     whether ANY holder can read a nonzero exit tax at or after the
	//     backstop opens (winddown + ExitTaxDecayBlocks).
	type recipe struct {
		name  string
		build func(s *core.MemStore, at uint64) (holder string, err error)
	}
	recipes := []recipe{
		{"plain hold (bought at registration)", func(s *core.MemStore, at uint64) (string, error) { return "h0", nil }},
		{"bought on the LAST block before the freeze", func(s *core.MemStore, at uint64) (string, error) {
			_, e := core.Buy(s, "hlate", creator, freeze-1, big.NewInt(50))
			return "hlate", e
		}},
		{"single OTC transfer during wind-down", func(s *core.MemStore, at uint64) (string, error) {
			return "hx1", core.TransferCredits(s, "h0", creator, "h0", "hx1", at, big.NewInt(50))
		}},
		{"transfer chain, 5 hops during wind-down", func(s *core.MemStore, at uint64) (string, error) {
			from := "h0"
			for i := 0; i < 5; i++ {
				to := fmt.Sprintf("hop%d", i)
				if e := core.TransferCredits(s, from, creator, from, to, at+uint64(i), big.NewInt(50)); e != nil {
					return to, e
				}
				from = to
			}
			return "hop4", nil
		}},
		{"bounce A->B->A (the exact griefing recipe refund.go:429-433 names)", func(s *core.MemStore, at uint64) (string, error) {
			if e := core.TransferCredits(s, "h0", creator, "h0", "bnc", at, big.NewInt(50)); e != nil {
				return "h0", e
			}
			return "h0", core.TransferCredits(s, "bnc", creator, "bnc", "h0", at+1, big.NewInt(50))
		}},
		{"late-buyer's tokens handed to a never-before-seen account", func(s *core.MemStore, at uint64) (string, error) {
			if _, e := core.Buy(s, "hlate", creator, freeze-1, big.NewInt(50)); e != nil {
				return "hlate", e
			}
			return "virgin", core.TransferCredits(s, "hlate", creator, "hlate", "virgin", at, big.NewInt(50))
		}},
	}

	for _, r := range recipes {
		for _, probeAt := range []uint64{
			freeze + core.ExitTaxDecayBlocks,
			freeze + core.ExitTaxDecayBlocks + 1,
			freeze + core.ExitTaxDecayBlocks + core.BlocksPerDay,
			freeze + 2*core.ExitTaxDecayBlocks,
		} {
			s := core.NewMemStore()
			zzMust(t, core.Register(s, creator, creator, zzRegBlock, zzFace, zzCap))
			if _, e := core.Buy(s, "h0", creator, zzRegBlock+1, big.NewInt(200)); e != nil {
				t.Fatalf("setup: %v", e)
			}
			// build the recipe at a block INSIDE wind-down but before the probe
			buildAt := probeAt - 10
			if buildAt < freeze+1 {
				buildAt = freeze + 1
			}
			holder, err := r.build(s, buildAt)
			if err != nil {
				t.Logf("D9b %-58s @%d: recipe refused: %v", r.name, probeAt-freeze, err)
				continue
			}
			resBefore := core.Reserve(s, creator)
			feeBefore := core.FeeBalanceOf(s, creator)
			net, perr := core.RefundHolder(s, "hive:keeperbot", creator, holder, probeAt)
			if perr != nil {
				t.Logf("D9b %-58s winddown+%-9d: push REFUSED: %v", r.name, probeAt-freeze, perr)
				continue
			}
			gross := new(big.Int).Sub(resBefore, core.Reserve(s, creator))
			tax := new(big.Int).Sub(gross, net)
			ch := new(big.Int).Sub(core.FeeBalanceOf(s, creator), feeBefore)
			t.Logf("D9b %-58s winddown+%-9d: PAID gross=%-9v tax=%-6v creatorHalf=%-5v platformHalf=%-5v",
				r.name, probeAt-freeze, gross, tax, ch, new(big.Int).Sub(tax, ch))
			if tax.Sign() > 0 {
				t.Errorf("D9 REFUTED: a taxed push landed via %q at winddown+%d — tax=%v. The backstop branch IS reachable and the keeper's block choice IS a priced lever.",
					r.name, probeAt-freeze, tax)
			}
		}
	}
	t.Logf("D9 VERDICT: across %d recipes x 4 probe blocks, every legal push paid tax=0. core/refund.go:485-487's else-branch (\"the push fires and taxes the holder's LIVE clock\") did not fire once.", len(recipes))
}

// D10. The claim underneath D9, isolated: a transfer CANNOT reset the
//
//	recipient's clock. This directly contradicts core/exittax.go:56-59,
//	which is the sentence that discloses the OTC-transfer limit.
func TestZZ_D10_TransferDoesNotResetTheRecipientClock(t *testing.T) {
	const creator = "aliceart"
	s := core.NewMemStore()
	zzMust(t, core.Register(s, creator, creator, zzRegBlock, zzFace, zzCap))
	if _, e := core.Buy(s, "seller", creator, zzRegBlock+1, big.NewInt(200)); e != nil {
		t.Fatal(e)
	}
	// still MATURING (well inside the decay window)
	at := zzRegBlock + 1 + 10*core.BlocksPerDay
	sellerMaturesAt := core.MaturesAtBlock(s, creator, "seller")
	zzMust(t, core.TransferCredits(s, "seller", creator, "seller", "buyer", at, big.NewInt(100)))
	buyerMaturesAt := core.MaturesAtBlock(s, creator, "buyer")
	t.Logf("D10 seller acquired at %d, matures at %d", zzRegBlock+1, sellerMaturesAt)
	t.Logf("D10 transfer at %d; if the buyer 'inherited a fresh clock' (exittax.go:58) they would mature at %d", at, at+core.ExitTaxDecayBlocks)
	t.Logf("D10 buyer ACTUALLY matures at %d  -> maturity TRAVELLED (transfer.go:174-183), it was not reset", buyerMaturesAt)
	if buyerMaturesAt != sellerMaturesAt {
		t.Errorf("D10: buyer clock %d != seller clock %d", buyerMaturesAt, sellerMaturesAt)
	}
	// and a fully-MATURED transfer is fully matured on arrival
	s2 := core.NewMemStore()
	zzMust(t, core.Register(s2, creator, creator, zzRegBlock, zzFace, zzCap))
	if _, e := core.Buy(s2, "seller", creator, zzRegBlock+1, big.NewInt(200)); e != nil {
		t.Fatal(e)
	}
	late := zzRegBlock + 1 + core.ExitTaxDecayBlocks + 1
	zzMust(t, core.TransferCredits(s2, "seller", creator, "seller", "buyer", late, big.NewInt(100)))
	t.Logf("D10 matured transfer at %d: buyer maturing=%v matured=%v (MaturesAtBlock=%d, 0 means nothing maturing)",
		late, core.MaturingOf(s2, creator, "buyer"), core.MaturedOf(s2, creator, "buyer"), core.MaturesAtBlock(s2, creator, "buyer"))
}

// ---------------------------------------------------------------------------
// D11. CATALOG BACKSTOP E1 (integer/precision), sweep.go:115-124.
//      nextDelay computes the next backoff as float64 arithmetic on a
//      time.Duration and converts back with no range check. BackoffPolicy's own
//      doc says "MaxDelay <= 0 means uncapped" (sweep.go:15), so the uncapped
//      configuration is a DOCUMENTED, supported one.
// ---------------------------------------------------------------------------

func TestZZ_D11_E1_NextDelayFloatOverflow(t *testing.T) {
	uncapped := BackoffPolicy{MaxAttempts: 64, InitialDelay: 2 * time.Second, Multiplier: 2, MaxDelay: 0}
	d := uncapped.InitialDelay
	for n := 2; n <= 64; n++ {
		prev := d
		d = nextDelay(d, uncapped)
		if d < 0 || (prev > 0 && d < prev) {
			t.Logf("D11 attempt %d: delay went %v -> %v  <-- NON-POSITIVE / WRAPPED. time.Sleep(<=0) returns immediately, so backoff collapses to a hot retry loop.", n, prev, d)
			t.Logf("D11 sweep.go:120 `time.Duration(float64(cur) * mult)` — no range check; sweep.go:15 documents MaxDelay<=0 as 'uncapped', so this configuration is supported.")
			return
		}
		if n <= 5 || n%10 == 0 {
			t.Logf("D11 attempt %2d: delay %v", n, d)
		}
	}
	t.Logf("D11: no wrap within 64 doublings from 2s (max reached %v)", d)
}

// D12. CATALOG BACKSTOP E15 (DoS/griefing), sweep.go:71-113 + plan.go:183-186.
//
//	Plan emits N+1 ops for an N-holder market with no cap; Sweep submits
//	them strictly sequentially, each with its own full backoff ladder. A
//	single permanently-failing op costs (MaxAttempts-1) waits before the
//	sweep moves on, and there is no per-sweep budget of any kind.
func TestZZ_D12_E15_UnboundedSweepCost(t *testing.T) {
	pol := DefaultBackoffPolicy()
	worstPerOp := time.Duration(0)
	d := pol.InitialDelay
	for n := 2; n <= pol.MaxAttempts; n++ {
		worstPerOp += d
		d = nextDelay(d, pol)
	}
	for _, holders := range []int{1, 10, 100, 1000, 10000} {
		ops := holders + 1
		t.Logf("D12 %6d holders -> %6d ops -> worst-case wall time %v (DefaultBackoffPolicy, every op failing)",
			holders, ops, time.Duration(ops)*worstPerOp)
	}
	t.Logf("D12 plan.go:183-186 emits one op per positive-balance holder plus one close, with no cap; sweep.go:74 iterates them serially. keeper.MarketView.Holders (keeper.go:118) has no length bound.")
	t.Logf("D12 there is no RC budget anywhere in the package: grep for 'rc' finds only OpConfig.RCLimit (wire.go:20), a PER-OP field never summed.")
}

// D13. CATALOG BACKSTOP E3, keeper.go:113-119. MarketView carries no block
//
//	height, so nothing downstream can tell how old the snapshot is, and the
//	op that results is priced at whatever block it happens to land at.
func TestZZ_D13_E3_SnapshotHasNoBlock(t *testing.T) {
	v := MarketView{}
	t.Logf("D13 MarketView fields: Creator(string) Phase(string) Retired(bool) Supply(*big.Int) Holders([]HolderBalance) — %d fields, none of them a block height or timestamp.", 5)
	t.Logf("D13 Phase itself is DERIVED from a block (core/market.go:103 Phase(s, creator, block)), so the snapshot stores a block-dependent answer without the block it was computed at.")
	t.Logf("D13 consequence: keeper.Plan cannot detect a stale snapshot, and keeper.go:72-91 / plan.go:110-115 both defer the fix to 'the caller'. The only two callers in the repo (cmd/keeper/main.go:297, sim/actions.go) both read from an in-memory store at the same instant, so neither exercises staleness at all.")
	_ = v
}
