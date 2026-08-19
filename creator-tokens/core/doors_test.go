package core

import (
	"math/big"
	"testing"
)

func drSetup(t *testing.T) (*MemStore, string, string) {
	t.Helper()
	const c, h = "hive:alice", "hive:bob"
	s := tbMarket(t, c)
	tbMature(t, s, c, h, 1000, 1_000_000)
	return s, c, h
}

// ★ THE CRITICAL ONE. In a factory, an allowance keyed only (owner, spender)
// means one approval — granted for one creator — spends EVERY creator's token
// the victim holds. The reference single-token contract keys it exactly that
// way, so this is the mistake a faithful copy makes.
func TestDoors_AllowanceIsPerCreator(t *testing.T) {
	const alice, carol, bob, mkt = "hive:alice", "hive:carol", "hive:bob", "hive:market"
	s := tbMarket(t, alice)
	tbMature(t, s, alice, bob, 1000, 1_000_000)
	if err := Register(s, carol, carol, 1000, 1000, 1_000_000_000); err != nil {
		t.Fatal(err)
	}
	tbMature(t, s, carol, bob, 1000, 1_000_000)

	// Bob approves the market for ALICE's token only.
	if err := Approve(s, bob, mkt, alice, mZero(), big.NewInt(1000)); err != nil {
		t.Fatalf("approve: %v", err)
	}

	// That approval must not reach carol's token.
	err := TransferMatured(s, carol, bob, "hive:attacker", mkt, big.NewInt(1))
	if e, ok := err.(*Err); !ok || e.Symbol != ErrAuth {
		t.Fatalf("an approval for %s spent %s's token (err=%v) — one click would drain "+
			"a holder's entire portfolio", alice, carol, err)
	}
	if MaturedOf(s, carol, bob).Cmp(big.NewInt(1000)) != 0 {
		t.Fatal("carol-token balance moved on an alice-token approval")
	}
}

// A self-transfer reads both sides then writes both. Without the guard that
// doubles the balance — an unpriced mint.
func TestDoors_SelfTransferRefused(t *testing.T) {
	s, c, h := drSetup(t)
	before := MaturedOf(s, c, h)
	if err := TransferMatured(s, c, h, h, h, big.NewInt(100)); err == nil {
		t.Fatal("self-transfer allowed — this mints tokens out of nothing")
	}
	if after := MaturedOf(s, c, h); after.Cmp(before) != 0 {
		t.Fatalf("balance changed on a refused self-transfer: %s -> %s", before, after)
	}
}

// Contract recipients are refused, or an escrowing marketplace flow makes a
// contract a permanent holder: it cannot be refunded, so supply never reaches
// zero, the market never closes, and the creator can never re-register.
func TestDoors_ContractRecipientRefused(t *testing.T) {
	s, c, h := drSetup(t)
	err := TransferMatured(s, c, h, "contract:vsc1Bpool", h, big.NewInt(100))
	if err == nil {
		t.Fatal("a contract was allowed to hold creator tokens — that position can never " +
			"be swept and pins the market open forever")
	}
	if MaturedOf(s, c, h).Cmp(big.NewInt(1000)) != 0 {
		t.Fatal("balance moved on a refused transfer")
	}
}

// The balance guard must be explicit. The wire codec is unsigned, so an
// unchecked debit wraps rather than failing.
func TestDoors_OverTransferRefusedAndNothingWraps(t *testing.T) {
	s, c, h := drSetup(t)
	if err := TransferMatured(s, c, h, "hive:carol", h, big.NewInt(1001)); err == nil {
		t.Fatal("over-transfer allowed")
	}
	if got := MaturedOf(s, c, h); got.Cmp(big.NewInt(1000)) != 0 {
		t.Fatalf("sender balance is %s after a refused transfer — a wrap would show here", got)
	}
	if MaturedOf(s, c, "hive:carol").Sign() != 0 {
		t.Fatal("recipient credited on a refused transfer")
	}
}

func TestDoors_OwnerMovesOwnTokensWithoutAllowance(t *testing.T) {
	s, c, h := drSetup(t)
	if err := TransferMatured(s, c, h, "hive:carol", h, big.NewInt(400)); err != nil {
		t.Fatalf("owner could not move their own tokens: %v", err)
	}
	if MaturedOf(s, c, h).Cmp(big.NewInt(600)) != 0 || MaturedOf(s, c, "hive:carol").Cmp(big.NewInt(400)) != 0 {
		t.Fatal("balances wrong after a self-spend")
	}
}

func TestDoors_ThirdPartyNeedsAllowanceAndItDecrements(t *testing.T) {
	s, c, h := drSetup(t)
	const mkt = "hive:market"

	if err := TransferMatured(s, c, h, "hive:carol", mkt, big.NewInt(1)); err == nil {
		t.Fatal("a stranger moved tokens with no allowance")
	}
	if err := Approve(s, h, mkt, c, mZero(), big.NewInt(300)); err != nil {
		t.Fatalf("approve: %v", err)
	}
	if err := TransferMatured(s, c, h, "hive:carol", mkt, big.NewInt(200)); err != nil {
		t.Fatalf("spend within allowance refused: %v", err)
	}
	if got := AllowanceOf(s, h, mkt, c); got.Cmp(big.NewInt(100)) != 0 {
		t.Fatalf("allowance = %s after spending 200 of 300, want 100 — an allowance that "+
			"does not decrement is an infinite one", got)
	}
	if err := TransferMatured(s, c, h, "hive:carol", mkt, big.NewInt(101)); err == nil {
		t.Fatal("spend beyond the remaining allowance succeeded")
	}
}

// Compare-and-set: the re-approve race is a producer-ordering choice here, not a
// gamble, so a stale write must fail rather than stack.
func TestDoors_ApproveIsCompareAndSet(t *testing.T) {
	s, c, h := drSetup(t)
	const mkt = "hive:market"

	if err := Approve(s, h, mkt, c, mZero(), big.NewInt(500)); err != nil {
		t.Fatalf("initial approve: %v", err)
	}
	// A holder who believes it is still zero must not be able to overwrite.
	if err := Approve(s, h, mkt, c, mZero(), big.NewInt(50)); err == nil {
		t.Fatal("stale compare-and-set succeeded — this is the re-approve race")
	}
	if got := AllowanceOf(s, h, mkt, c); got.Cmp(big.NewInt(500)) != 0 {
		t.Fatalf("allowance mutated on a failed CAS: %s", got)
	}
	// With the true current value it succeeds.
	if err := Approve(s, h, mkt, c, big.NewInt(500), big.NewInt(50)); err != nil {
		t.Fatalf("correct compare-and-set refused: %v", err)
	}
	// Revoking is never blocked by a race — a holder must always be able to
	// withdraw authority.
	if err := Approve(s, h, mkt, c, big.NewInt(999999), mZero()); err != nil {
		t.Fatalf("revoke to zero was blocked (%v) — a holder must always be able to "+
			"withdraw authority regardless of what they believe the current value is", err)
	}
	if AllowanceOf(s, h, mkt, c).Sign() != 0 {
		t.Fatal("revoke did not clear the allowance")
	}
}

// Transfers move value between holders; they must never change how much exists.
func TestDoors_TransferConservesTotal(t *testing.T) {
	s, c, h := drSetup(t)
	total := func() *big.Int {
		return mAdd(mAdd(MaturedOf(s, c, h), MaturedOf(s, c, "hive:carol")), MaturedOf(s, c, "hive:dave"))
	}
	before := total()
	if err := TransferMatured(s, c, h, "hive:carol", h, big.NewInt(300)); err != nil {
		t.Fatal(err)
	}
	if err := TransferMatured(s, c, "hive:carol", "hive:dave", "hive:carol", big.NewInt(120)); err != nil {
		t.Fatal(err)
	}
	if after := total(); after.Cmp(before) != 0 {
		t.Fatalf("total matured moved from %s to %s across transfers", before, after)
	}
	if supply := Supply(s, c); supply.Cmp(big.NewInt(1000)) != 0 {
		t.Fatalf("supply changed to %s — a transfer must never mint or burn", supply)
	}
}

// A transferred token keeps its maturity: it is matured, and it stays matured
// for whoever receives it. That is what makes matured tokens interchangeable.
func TestDoors_TransferredTokensStayMatured(t *testing.T) {
	s, c, h := drSetup(t)
	if err := TransferMatured(s, c, h, "hive:carol", h, big.NewInt(500)); err != nil {
		t.Fatal(err)
	}
	if MaturedOf(s, c, "hive:carol").Cmp(big.NewInt(500)) != 0 {
		t.Fatal("recipient did not receive matured tokens")
	}
	if MaturingOf(s, c, "hive:carol").Sign() != 0 {
		t.Fatal("a transfer must not create a maturing position for the recipient")
	}
}

// ★ F1 (scrutiny, 2026-07-30). A `system:` destination passes our own address
// classifier as VALID, but go-vsc's ledger refuses to pay one — so a single
// token parked there survives the burn and then reverts the payout, pinning
// supply above zero forever: the market can never close and the creator can
// never re-register. One token, permanent, unrecoverable.
func TestDoors_SystemDestinationRefused(t *testing.T) {
	s, c, h := drSetup(t)
	for _, dest := range []string{"system:fr_balance", "system:anything", "contract:vsc1Bpool"} {
		if err := TransferMatured(s, c, h, dest, h, big.NewInt(1)); err == nil {
			t.Fatalf("%s accepted as a destination — tokens sent there can never be swept, "+
				"so supply never reaches zero and the market never closes", dest)
		}
	}
	if MaturedOf(s, c, h).Cmp(big.NewInt(1000)) != 0 {
		t.Fatal("balance moved on a refused transfer")
	}
	// A normal account must still work, or the guard is just a wall.
	if err := TransferMatured(s, c, h, "hive:carol", h, big.NewInt(1)); err != nil {
		t.Fatalf("refused a legitimate user destination: %v", err)
	}
}

// The positive-amount guard (scrutiny F9): core is called directly by the sim
// and the keeper, so it cannot rely on the wrapper's unsigned parse.
func TestDoors_NonPositiveAmountRefused(t *testing.T) {
	s, c, h := drSetup(t)
	for _, amt := range []*big.Int{big.NewInt(0), big.NewInt(-5)} {
		if err := TransferMatured(s, c, h, "hive:carol", h, amt); err == nil {
			t.Fatalf("amount %s accepted — a negative would GROW the sender and shrink the recipient", amt)
		}
	}
	if MaturedOf(s, c, h).Cmp(big.NewInt(1000)) != 0 || MaturedOf(s, c, "hive:carol").Sign() != 0 {
		t.Fatal("balances moved on a refused transfer")
	}
}

// A failed third-party transfer must leave the allowance intact (scrutiny F10):
// decrementing before the balance check is the mutate-then-reject shape the
// write discipline forbids, and core is used directly by the sim and keeper
// where no host revert will undo it.
func TestDoors_FailedThirdPartyTransferLeavesAllowanceIntact(t *testing.T) {
	s, c, h := drSetup(t)
	const mkt = "hive:market"
	if err := Approve(s, h, mkt, c, mZero(), big.NewInt(5000)); err != nil {
		t.Fatal(err)
	}
	// Allowance is ample; the BALANCE is not.
	if err := TransferMatured(s, c, h, "hive:carol", mkt, big.NewInt(1001)); err == nil {
		t.Fatal("over-balance transfer succeeded")
	}
	if got := AllowanceOf(s, h, mkt, c); got.Cmp(big.NewInt(5000)) != 0 {
		t.Fatalf("allowance = %s after a REFUSED transfer, want 5000 untouched — the balance "+
			"guard must run before the allowance is spent", got)
	}
}

// ★ THE OTHER CRITICAL ONE (DEFECT FIX 2026-08-19, PRUNED finding F1). A grant
// is authority over ONE INCARNATION of a market. It used to survive the market
// closing and being re-registered, so a spender who was approved in a dead life
// could move the tokens of the new one — measured at 8,540,519 base units taken
// from a market that had re-opened, to an account that was never approved, and
// reachable with a POSTING key because safeTransferFrom carries no HBD leg.
func TestDoors_AllowanceDoesNotSurviveReRegistration(t *testing.T) {
	const c, h, mkt, carol = "hive:alice", "hive:bob", "hive:market", "hive:carol"
	s := tbMarket(t, c)
	at := tbMature(t, s, c, h, 1000, 1_000_000)

	if err := Approve(s, h, mkt, c, mZero(), big.NewInt(1000)); err != nil {
		t.Fatalf("approve: %v", err)
	}
	// ANTI-VACUITY: the grant works in the life it was made in, or the refusal
	// below proves nothing about incarnations.
	if err := TransferMatured(s, c, h, carol, mkt, big.NewInt(1)); err != nil {
		t.Fatalf("the grant must work in its own incarnation: %v", err)
	}

	// Wind the market all the way down and re-register — the ONLY path that
	// moves the offering epoch, which is what dates a grant.
	if err := Retire(s, c, c, at+10); err != nil {
		t.Fatalf("retire: %v", err)
	}
	windDown := at + 10 + GraceBlocks
	if _, err := Refund(s, h, c, windDown, big.NewInt(999)); err != nil {
		t.Fatalf("holder wind-down refund: %v", err)
	}
	if _, err := Refund(s, carol, c, windDown, big.NewInt(1)); err != nil {
		t.Fatalf("carol wind-down refund: %v", err)
	}
	if !CloseIfDrained(s, c, windDown) {
		t.Fatalf("market did not close; supply=%s", getMoney(s, kSupply(c)))
	}
	reReg := windDown + 100
	if err := Register(s, c, c, reReg, 1000, 1_000_000_000); err != nil {
		t.Fatalf("re-register: %v", err)
	}
	tbMature(t, s, c, h, 1000, reReg+10)

	if got := AllowanceOf(s, h, mkt, c); got.Sign() != 0 {
		t.Fatalf("a grant from the previous incarnation still reads as %s of live authority", got)
	}
	before := MaturedOf(s, c, h)
	if err := TransferMatured(s, c, h, carol, mkt, big.NewInt(400)); err == nil {
		t.Fatal("a spender approved in a DEAD market moved the new incarnation's tokens — " +
			"this is the theft F1 measured")
	}
	if MaturedOf(s, c, h).Cmp(before) != 0 {
		t.Fatal("the victim's balance moved on a refused transfer")
	}

	// And the holder can grant again in the new life: the dead number must not
	// block the compare-and-set with a phantom "allowance changed" error.
	if err := Approve(s, h, mkt, c, mZero(), big.NewInt(50)); err != nil {
		t.Fatalf("re-granting in the new incarnation was blocked by the dead grant: %v", err)
	}
	if err := TransferMatured(s, c, h, carol, mkt, big.NewInt(50)); err != nil {
		t.Fatalf("the fresh grant does not work — the fix over-reached: %v", err)
	}
}
