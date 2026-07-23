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
