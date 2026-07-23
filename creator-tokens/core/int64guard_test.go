package core

import (
	"math/big"
	"testing"
)

// TestBUYINT64_PreCommitGuard verifies the PRUNED-2026-07-22 fix: a token
// quantity whose curve cost overflows int64 is rejected with a clean typed
// ErrInput BEFORE any state write, rather than committing state and then
// aborting in the wasm wrapper's int64 narrowing (whose host state-atomicity
// we do not want to depend on). The overflow crossover is ~21.24M tokens (the
// cubic area term); 30M is comfortably past it, well under MaxCap.
func TestBUYINT64_PreCommitGuard(t *testing.T) {
	const (
		creator = "int64creator"
		block   = uint64(1000)
	)
	big30M := big.NewInt(30_000_000)

	// (1) An ordinary Buy of an overflowing size on a live market: rejected
	//     with ErrInput, and NOTHING committed (RULING G).
	s := NewMemStore()
	if err := Register(s, creator, creator, block, MinFace, MaxCap); err != nil {
		t.Fatalf("Register: %v", err)
	}
	reserveBefore := getMoney(s, kReserve(creator)).String()
	supplyBefore := getMoney(s, kSupply(creator)).String()

	if _, err := Buy(s, "bigbuyer", creator, block+1, big30M); err == nil {
		t.Fatal("Buy of 30M tokens must be rejected (TotalDue overflows int64), got success")
	} else if sym := errSymbol(err); sym != ErrInput {
		t.Fatalf("want ErrInput from the int64 guard, got %v", err)
	}
	if got := getMoney(s, kReserve(creator)).String(); got != reserveBefore {
		t.Fatalf("reserve mutated by a rejected Buy: %s != %s", got, reserveBefore)
	}
	if got := getMoney(s, kSupply(creator)).String(); got != supplyBefore {
		t.Fatalf("supply mutated by a rejected Buy: %s != %s", got, supplyBefore)
	}

	// (2) The launch path (RegisterWithFirstBuy) shares buyCompute, so an
	//     overflowing firstBuy is rejected before the market is created.
	s2 := NewMemStore()
	if _, err := RegisterWithFirstBuy(s2, creator, creator, block, MinFace, MaxCap, big30M); err == nil {
		t.Fatal("RegisterWithFirstBuy with a 30M firstBuy must be rejected, got success")
	} else if sym := errSymbol(err); sym != ErrInput {
		t.Fatalf("want ErrInput from the int64 guard on the launch path, got %v", err)
	}

	// (3) A normal-scale buy still succeeds (the guard does not disturb the
	//     legitimate range).
	s3 := NewMemStore()
	if err := Register(s3, creator, creator, block, MinFace, MaxCap); err != nil {
		t.Fatalf("Register: %v", err)
	}
	if _, err := Buy(s3, "smallbuyer", creator, block+1, big.NewInt(1000)); err != nil {
		t.Fatalf("a normal 1000-token Buy must still succeed, got %v", err)
	}
}
