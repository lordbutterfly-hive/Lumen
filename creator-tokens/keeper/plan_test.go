package keeper

import (
	"math/big"
	"testing"

	"creator-tokens/core"
)

func bi(n int64) *big.Int { return big.NewInt(n) }

func TestPlan_OnlyFrozenMarketsProduceOps(t *testing.T) {
	markets := []MarketView{
		{Creator: "active1", Phase: core.StateActive, Holders: []HolderBalance{{Holder: "h1", Balance: bi(100)}}},
		{Creator: "overdue1", Phase: core.StateOverdue, Holders: []HolderBalance{{Holder: "h1", Balance: bi(100)}}},
		{Creator: "closed1", Phase: core.StateClosed, Holders: []HolderBalance{{Holder: "h1", Balance: bi(100)}}},
		{Creator: "frozen1", Phase: core.StateFrozen, Holders: []HolderBalance{{Holder: "h1", Balance: bi(100)}}},
	}
	ops := Plan(markets)

	for _, op := range ops {
		if op.Creator != "frozen1" {
			t.Fatalf("expected ops only for the FROZEN market, got op for %s: %v", op.Creator, op)
		}
	}
	if len(ops) != 2 { // 1 refundHolder + 1 closeIfDrained
		t.Fatalf("len(ops) = %d, want 2 (refundHolder + closeIfDrained), got %+v", len(ops), ops)
	}
	if ops[0].Kind != OpRefundHolder || ops[0].Holder != "h1" {
		t.Fatalf("ops[0] = %+v, want refundHolder(h1)", ops[0])
	}
	if ops[1].Kind != OpCloseIfDrained {
		t.Fatalf("ops[1] = %+v, want closeIfDrained", ops[1])
	}
}

func TestPlan_CloseIfDrainedAppendedEvenWithNoHolders(t *testing.T) {
	// A market fully swept by a prior run: FROZEN, but no candidate holders
	// left. Plan must still attempt closeIfDrained -- see Plan's own doc on
	// why this is unconditional.
	markets := []MarketView{
		{Creator: "frozen1", Phase: core.StateFrozen, Holders: nil},
	}
	ops := Plan(markets)
	if len(ops) != 1 || ops[0].Kind != OpCloseIfDrained {
		t.Fatalf("ops = %+v, want exactly one closeIfDrained op", ops)
	}
}

func TestPlan_VerifiesRatherThanTrustsBalances(t *testing.T) {
	// Even though the indexer's HolderList is documented to only report
	// non-zero balances, Plan must not blindly forward every name it's
	// handed -- a zero, negative, or nil balance attached to a holder must
	// be silently excluded, never turned into a wasted refundHolder call.
	markets := []MarketView{{
		Creator: "frozen1",
		Phase:   core.StateFrozen,
		Holders: []HolderBalance{
			{Holder: "zero", Balance: bi(0)},
			{Holder: "negative", Balance: bi(-5)},
			{Holder: "nilbal", Balance: nil},
			{Holder: "real", Balance: bi(42)},
		},
	}}
	ops := Plan(markets)

	var refundHolders []string
	for _, op := range ops {
		if op.Kind == OpRefundHolder {
			refundHolders = append(refundHolders, op.Holder)
		}
	}
	if len(refundHolders) != 1 || refundHolders[0] != "real" {
		t.Fatalf("refundHolder targets = %v, want exactly [real]", refundHolders)
	}
}

func TestPlan_MarketOrderingIsAlphabeticalByCreator(t *testing.T) {
	markets := []MarketView{
		{Creator: "zebra", Phase: core.StateFrozen, Holders: []HolderBalance{{Holder: "h", Balance: bi(1)}}},
		{Creator: "apple", Phase: core.StateFrozen, Holders: []HolderBalance{{Holder: "h", Balance: bi(1)}}},
		{Creator: "mango", Phase: core.StateFrozen, Holders: []HolderBalance{{Holder: "h", Balance: bi(1)}}},
	}
	ops := Plan(markets)

	var seen []string
	for _, op := range ops {
		if len(seen) == 0 || seen[len(seen)-1] != op.Creator {
			seen = append(seen, op.Creator)
		}
	}
	want := []string{"apple", "mango", "zebra"}
	if len(seen) != len(want) {
		t.Fatalf("creator order = %v, want %v", seen, want)
	}
	for i := range want {
		if seen[i] != want[i] {
			t.Fatalf("creator order = %v, want %v", seen, want)
		}
	}
}

func TestPlan_HoldersOrderedByBalanceDescendingThenName(t *testing.T) {
	markets := []MarketView{{
		Creator: "c1",
		Phase:   core.StateFrozen,
		Holders: []HolderBalance{
			{Holder: "small", Balance: bi(10)},
			{Holder: "tieB", Balance: bi(50)},
			{Holder: "big", Balance: bi(1000)},
			{Holder: "tieA", Balance: bi(50)},
		},
	}}
	ops := Plan(markets)

	var order []string
	for _, op := range ops {
		if op.Kind == OpRefundHolder {
			order = append(order, op.Holder)
		}
	}
	want := []string{"big", "tieA", "tieB", "small"}
	if len(order) != len(want) {
		t.Fatalf("holder order = %v, want %v", order, want)
	}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("holder order = %v, want %v", order, want)
		}
	}
	// closeIfDrained must be last.
	if ops[len(ops)-1].Kind != OpCloseIfDrained {
		t.Fatalf("last op = %+v, want closeIfDrained", ops[len(ops)-1])
	}
}

func TestPlan_IsDeterministicAndDoesNotMutateInput(t *testing.T) {
	markets := []MarketView{
		{Creator: "c2", Phase: core.StateFrozen, Holders: []HolderBalance{{Holder: "h1", Balance: bi(5)}}},
		{Creator: "c1", Phase: core.StateFrozen, Holders: []HolderBalance{{Holder: "h2", Balance: bi(7)}}},
	}
	inputCopy := append([]MarketView(nil), markets...)

	ops1 := Plan(markets)
	ops2 := Plan(markets)

	if len(ops1) != len(ops2) {
		t.Fatalf("Plan is not deterministic in length: %d vs %d", len(ops1), len(ops2))
	}
	for i := range ops1 {
		if ops1[i] != ops2[i] {
			t.Fatalf("Plan is not deterministic at index %d: %+v vs %+v", i, ops1[i], ops2[i])
		}
	}
	// input slice order must be untouched (Plan sorts a copy).
	for i := range markets {
		if markets[i].Creator != inputCopy[i].Creator {
			t.Fatalf("Plan mutated caller's input slice order: got %s at %d, want %s", markets[i].Creator, i, inputCopy[i].Creator)
		}
	}
}

func TestOpKind_String(t *testing.T) {
	if OpRefundHolder.String() != "refundHolder" {
		t.Fatalf("OpRefundHolder.String() = %q", OpRefundHolder.String())
	}
	if OpCloseIfDrained.String() != "closeIfDrained" {
		t.Fatalf("OpCloseIfDrained.String() = %q", OpCloseIfDrained.String())
	}
}

func TestOp_String(t *testing.T) {
	rh := Op{Kind: OpRefundHolder, Creator: "c", Holder: "h"}
	if got := rh.String(); got != "refundHolder(creator=c, holder=h)" {
		t.Fatalf("Op.String() = %q", got)
	}
	cd := Op{Kind: OpCloseIfDrained, Creator: "c"}
	if got := cd.String(); got != "closeIfDrained(creator=c)" {
		t.Fatalf("Op.String() = %q", got)
	}
}

// TestPlan_RetiredMarketInNoticeWindowIsSwept pins the wind-down predicate to
// core's own inWindDown, which is (retired OR frozen) — not frozen alone.
//
// THE DEFECT (2026-07-28): core.Phase is MAX(naturalPhase, retiredPhase), so a
// creator who Retires while their subscription is still paid stays OVERDUE for
// the whole GraceBlocks notice window — yet core.inWindDown is already true
// from the retire block, and core.RefundHolder will happily pay out. Plan
// filtered on Phase == StateFrozen alone and returned ZERO ops for that
// market, on the written but false premise that "frozen IS wind-down open, by
// construction".
//
// Nobody's funds were ever at risk (Refund, the self-serve pull, is open the
// instant inWindDown is true, and the push is permissionless for anyone), so
// this was delayed convenience, not loss — the package's own "at most delay,
// never harm" ceiling. It is fixed because it contradicted the invariant Plan
// claimed to implement, and because a keeper that silently does nothing for
// five days looks identical to a keeper that is broken.
func TestPlan_RetiredMarketInNoticeWindowIsSwept(t *testing.T) {
	retiredButOverdue := MarketView{
		Creator: "alice",
		Phase:   core.StateOverdue, // still OVERDUE — inside the notice window
		Retired: true,              // ...but core.inWindDown is already true
		Supply:  big.NewInt(100),
		Holders: []HolderBalance{{Holder: "bob", Balance: big.NewInt(100)}},
	}
	ops := Plan([]MarketView{retiredButOverdue})
	if len(ops) == 0 {
		t.Fatal("WIND-DOWN REGRESSION: a RETIRED market inside its notice window produced zero ops. core.inWindDown is true from the retire block, so RefundHolder would succeed — Plan is filtering on Phase==Frozen alone again. See MarketView.Retired.")
	}
	var sawRefund, sawClose bool
	for _, op := range ops {
		switch op.Kind {
		case OpRefundHolder:
			sawRefund = true
			if op.Holder != "bob" {
				t.Errorf("refundHolder targeted %q, want bob", op.Holder)
			}
		case OpCloseIfDrained:
			sawClose = true
		}
	}
	if !sawRefund || !sawClose {
		t.Errorf("want both a refundHolder and a closeIfDrained op, got refund=%v close=%v", sawRefund, sawClose)
	}

	// An ordinary ACTIVE market must still be left alone — the fix widens the
	// predicate to match core, it does not make Plan sweep everything.
	live := MarketView{
		Creator: "carol",
		Phase:   core.StateActive,
		Supply:  big.NewInt(100),
		Holders: []HolderBalance{{Holder: "dave", Balance: big.NewInt(100)}},
	}
	if got := Plan([]MarketView{live}); len(got) != 0 {
		t.Fatalf("a healthy ACTIVE market must produce no ops, got %d: %+v", len(got), got)
	}

	// And a CLOSED market has nothing left to sweep, retired or not.
	closed := MarketView{Creator: "erin", Phase: core.StateClosed, Retired: true, Supply: big.NewInt(0)}
	if got := Plan([]MarketView{closed}); len(got) != 0 {
		t.Fatalf("a CLOSED market must produce no ops, got %d: %+v", len(got), got)
	}
}

// TestPlan_RefundBlockedHolderProducesNoRefundHolderOp is the synthetic,
// table-style half of the F9 fix's regression guard: a positive-balance
// holder flagged RefundBlocked must never get a refundHolder op, regardless
// of Balance, while an ordinary (unblocked) holder in the SAME market still
// does — and closeIfDrained is still appended unconditionally either way
// (Plan's own doc). See TestPlan_RealCore_NoRefundHolderOpInsideExitTaxWindow
// below for the end-to-end proof against the real core package.
func TestPlan_RefundBlockedHolderProducesNoRefundHolderOp(t *testing.T) {
	markets := []MarketView{{
		Creator: "frozen1",
		Phase:   core.StateFrozen,
		Holders: []HolderBalance{
			{Holder: "fresh", Balance: bi(400), RefundBlocked: true}, // still inside the exit-tax window
			{Holder: "aged", Balance: bi(100), RefundBlocked: false}, // clock decayed / backstop open
		},
	}}
	ops := Plan(markets)

	var refundHolders []string
	sawClose := false
	for _, op := range ops {
		switch op.Kind {
		case OpRefundHolder:
			refundHolders = append(refundHolders, op.Holder)
		case OpCloseIfDrained:
			sawClose = true
		}
	}
	if len(refundHolders) != 1 || refundHolders[0] != "aged" {
		t.Fatalf("refundHolder ops = %v, want exactly [aged] -- RefundBlocked must suppress fresh's doomed op without touching aged's legitimate one", refundHolders)
	}
	if !sawClose {
		t.Fatal("closeIfDrained must still be appended even though one holder was blocked")
	}
}

// TestPlan_RealCore_NoRefundHolderOpInsideExitTaxWindow is the end-to-end
// proof for F9 (2026-08-19 audit): before this fix, this EXACT scenario --
// lifted from the audit's own D1 detector (creator "aliceart", holder
// "patron1", 400 tokens, cmd/keeper's own demo timings) -- made Plan emit a
// refundHolder op that core.RefundHolder then refused on-chain every single
// time, and Sweep (pre-fix) reported it Succeeded regardless. This proves
// BOTH halves of the fix against the real core package: Plan emits ZERO
// refundHolder ops while the holder is still inside the window, and DOES
// emit one once core.RefundHolderTaxGateBlocked itself reports the gate
// open -- so the fix suppresses exactly the doomed op, not refunds in
// general.
func TestPlan_RealCore_NoRefundHolderOpInsideExitTaxWindow(t *testing.T) {
	const (
		creator         = "aliceart"
		holder          = "patron1"
		registeredBlock = uint64(1_000_000)
		face            = int64(1000)
		cap             = int64(1_000_000)
	)
	build := func(t *testing.T) *core.MemStore {
		t.Helper()
		s := core.NewMemStore()
		if err := core.Register(s, creator, creator, registeredBlock, face, cap); err != nil {
			t.Fatalf("Register: %v", err)
		}
		if _, err := core.Buy(s, holder, creator, registeredBlock+1, big.NewInt(400)); err != nil {
			t.Fatalf("Buy: %v", err)
		}
		return s
	}
	lapse := registeredBlock + core.SubscriptionPeriod + core.GraceBlocks
	viewAt := func(s *core.MemStore, block uint64) MarketView {
		_, retired := core.RetiredAt(s, creator)
		return MarketView{
			Creator: creator,
			Phase:   core.Phase(s, creator, block),
			Retired: retired,
			Supply:  core.Supply(s, creator),
			Holders: []HolderBalance{{
				Holder:        holder,
				Balance:       core.BalanceOf(s, creator, holder),
				RefundBlocked: core.RefundHolderTaxGateBlocked(s, creator, holder, block),
			}},
		}
	}

	// INSIDE the window: cmd/keeper's own demo block, 500 blocks past the
	// natural freeze -- patron1's clock is nowhere near ExitTaxDecayBlocks
	// (42 days) old, and the market-level backstop hasn't opened either.
	insideBlock := lapse + 500
	sInside := build(t)
	if phase := core.Phase(sInside, creator, insideBlock); phase != core.StateFrozen {
		t.Fatalf("precondition: phase at insideBlock = %s, want FROZEN", phase)
	}
	viewInside := viewAt(sInside, insideBlock)
	if !viewInside.Holders[0].RefundBlocked {
		t.Fatal("precondition: core.RefundHolderTaxGateBlocked reports NOT blocked at insideBlock -- scenario is wrong, this must reproduce D1's window")
	}
	// Independently confirm the chain would actually refuse this call, so
	// the assertion below is tied to a REAL revert, not just the flag.
	if _, err := core.RefundHolder(sInside, "hive:keeperbot", creator, holder, insideBlock); err == nil {
		t.Fatal("precondition: core.RefundHolder ACCEPTED the push at insideBlock -- scenario no longer matches D1")
	}
	insideOps := Plan([]MarketView{viewInside})
	for _, op := range insideOps {
		if op.Kind == OpRefundHolder {
			t.Fatalf("F9 REGRESSION: Plan emitted %s for a holder still inside the exit-tax window (chain would refuse it)", op)
		}
	}

	// PAST the window: a fresh store at the same lapse timing, evaluated
	// core.ExitTaxDecayBlocks + 1000 blocks after the buy -- patron1's own
	// clock has fully decayed (mirrors keeper_integration_test.go's
	// TestIntegration_DoubleSubmitRefundHolderIsHarmless timing). Plan must
	// still produce the op once the chain would actually accept it -- the
	// fix suppresses doomed ops, it does not suppress refunds outright.
	pastBlock := registeredBlock + 1 + core.ExitTaxDecayBlocks + 1000
	sPast := build(t)
	if phase := core.Phase(sPast, creator, pastBlock); phase != core.StateFrozen {
		t.Fatalf("precondition: phase at pastBlock = %s, want still FROZEN", phase)
	}
	viewPast := viewAt(sPast, pastBlock)
	if viewPast.Holders[0].RefundBlocked {
		t.Fatal("precondition: core.RefundHolderTaxGateBlocked still reports blocked at pastBlock -- scenario needs a longer wait")
	}
	pastOps := Plan([]MarketView{viewPast})
	sawRefund := false
	for _, op := range pastOps {
		if op.Kind == OpRefundHolder && op.Holder == holder {
			sawRefund = true
		}
	}
	if !sawRefund {
		t.Fatalf("Plan emitted no refundHolder op once the exit-tax gate is genuinely open: ops=%+v", pastOps)
	}
	if _, err := core.RefundHolder(sPast, "hive:keeperbot", creator, holder, pastBlock); err != nil {
		t.Fatalf("chain truth check: core.RefundHolder refused at pastBlock: %v (Plan's RefundBlocked=false disagreed with the real gate)", err)
	}
}
