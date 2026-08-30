package core

import (
	"math/big"
	"testing"
)

// a1_lapse_test.go — A1 (owner ruling 2026-08-30): "no wind-downs, just
// delisting, a big warning to pay to reactivate, and holders are never
// punished for a creator's bill." The contract's half of that, in one test:
//
//	lapse -> OVERDUE (grace) -> FROZEN, where FROZEN means
//	  Buy / Ask refused      (inflow stop; requireMarketAcceptsMoney unchanged)
//	  Sell OPEN on the curve (inWindDown no longer lists StateFrozen)
//	  Refund / RefundHolder REFUSED (no wind-down, so no pro-rata rail)
//	  Renew ACCEPTED         (requireMarketAcceptsRenewal admits FROZEN)
//	and Renew from FROZEN restores ACTIVE with Buy working again; Retire on a
//	FROZEN market is the one road into wind-down, and it is terminal.
//
// Every assertion below fails on the pre-A1 code in at least one clause.
func TestA1_LapseIsAnInflowStopNotAWindDown(t *testing.T) {
	s := NewMemStore()
	const c, fan, holder = "a1creator", "a1fan", "a1holder"
	const reg = uint64(500_000)
	if err := Register(s, c, c, reg, 1000, MaxCap); err != nil {
		t.Fatal(err)
	}
	if _, err := Buy(s, holder, c, reg+1, big.NewInt(20)); err != nil {
		t.Fatal(err)
	}
	paidUntil := getU64(s, kPaidUntil(c))
	frozenAt := paidUntil + GraceBlocks + 100
	if got := Phase(s, c, frozenAt); got != StateFrozen {
		t.Fatalf("fixture: phase = %s, want FROZEN", got)
	}

	// Inflow stop.
	if _, err := Buy(s, fan, c, frozenAt, big.NewInt(1)); errSymbol(err) != ErrState {
		t.Fatalf("Buy on FROZEN must be refused (inflow stop), got %v", err)
	}
	if err := RequireInflowOpen(s, c, frozenAt); err == nil {
		t.Fatal("RequireInflowOpen must refuse FROZEN (Ask goes through it)")
	}
	// Not a wind-down.
	if inWindDown(s, c, frozenAt) {
		t.Fatal("A1: a natural FROZEN must not be a wind-down")
	}
	if _, err := Refund(s, holder, c, frozenAt, big.NewInt(1)); errSymbol(err) != ErrState {
		t.Fatalf("Refund on FROZEN must be refused (no pro-rata rail on lapse), got %v", err)
	}
	if _, err := RefundHolder(s, "keeper", c, holder, frozenAt+ExitTaxDecayBlocks); errSymbol(err) != ErrState {
		t.Fatalf("RefundHolder on FROZEN must be refused even a full decay window later, got %v", err)
	}
	// The holder's exit is untouched.
	reserveBefore := getMoney(s, kReserve(c))
	if _, err := Sell(s, holder, c, frozenAt, big.NewInt(5)); err != nil {
		t.Fatalf("Sell on FROZEN must work (curve exit intact): %v", err)
	}
	if getMoney(s, kReserve(c)).Cmp(reserveBefore) >= 0 {
		t.Fatal("Sell on FROZEN must have paid out of the reserve")
	}
	// R === area(S) survives the whole episode: no pro-rata ever touched it.
	if res, area := getMoney(s, kReserve(c)), Area(getMoney(s, kSupply(c))); res.Cmp(area) != 0 {
		t.Fatalf("trading invariant broken across a lapse: reserve %s != area(S) %s", res, area)
	}

	// Pay to reactivate: anyone may pay, and it lands.
	if err := Renew(s, fan, c, frozenAt, 1, subFee(1)); err != nil {
		t.Fatalf("Renew on FROZEN must be accepted (pay to reactivate): %v", err)
	}
	if got := Phase(s, c, frozenAt); got != StateActive {
		t.Fatalf("phase after Renew = %s, want ACTIVE", got)
	}
	if _, err := Buy(s, fan, c, frozenAt+1, big.NewInt(1)); err != nil {
		t.Fatalf("Buy after reactivation must work: %v", err)
	}
	if inWindDown(s, c, frozenAt+1) {
		t.Fatal("reactivated market must not be in wind-down")
	}

	// Lapse again, then the creator gives up: Retire is the one road into
	// wind-down, and from there the ladder is the old one — Sell routes to
	// Refund, Renew is terminal.
	paidUntil2 := getU64(s, kPaidUntil(c))
	frozen2 := paidUntil2 + GraceBlocks + 100
	if got := Phase(s, c, frozen2); got != StateFrozen {
		t.Fatalf("fixture: phase = %s, want FROZEN again", got)
	}
	if err := Retire(s, c, c, frozen2); err != nil {
		t.Fatalf("Retire on a FROZEN market must be legal: %v", err)
	}
	if !inWindDown(s, c, frozen2) {
		t.Fatal("retired market must be in wind-down")
	}
	if open, ok := windDownOpenBlock(s, c, frozen2); !ok || open != frozen2 {
		t.Fatalf("windDownOpen = (%d,%v), want (%d,true)", open, ok, frozen2)
	}
	if _, err := Sell(s, holder, c, frozen2, big.NewInt(1)); errSymbol(err) != ErrState {
		t.Fatalf("Sell after Retire must route to Refund, got %v", err)
	}
	if _, err := Refund(s, holder, c, frozen2, big.NewInt(1)); err != nil {
		t.Fatalf("Refund after Retire must work: %v", err)
	}
	if err := Renew(s, fan, c, frozen2, 1, subFee(1)); errSymbol(err) != ErrState {
		t.Fatalf("Renew after Retire must be refused (terminal), got %v", err)
	}
}

// TestA1_RenewGateIsSeparateFromBuyGate pins the one thing that must never
// drift: Renew's admission of FROZEN lives in requireMarketAcceptsRenewal and
// NOT in requireMarketAcceptsMoney, so Buy and Ask cannot inherit it. If
// someone "simplifies" the two gates into one, this fails.
func TestA1_RenewGateIsSeparateFromBuyGate(t *testing.T) {
	s := NewMemStore()
	const c = "a1gates"
	if err := Register(s, c, c, 1000, 1000, MaxCap); err != nil {
		t.Fatal(err)
	}
	frozen := getU64(s, kPaidUntil(c)) + GraceBlocks
	if err := requireMarketAcceptsRenewal(s, c, frozen); err != nil {
		t.Fatalf("renewal gate must admit FROZEN: %v", err)
	}
	if err := requireMarketAcceptsMoney(s, c, frozen); err == nil {
		t.Fatal("money gate must still refuse FROZEN (Buy/Ask inflow stop)")
	}
	// Both refuse the global pause and a retire mark; both refuse CLOSED.
	setStr(s, kPaused(), "1")
	if err := requireMarketAcceptsRenewal(s, c, frozen); errSymbol(err) != ErrPaused {
		t.Fatalf("renewal gate must refuse the global pause, got %v", err)
	}
	setStr(s, kPaused(), "")
	if err := Retire(s, c, c, frozen); err != nil {
		t.Fatal(err)
	}
	if err := requireMarketAcceptsRenewal(s, c, frozen+1); errSymbol(err) != ErrState {
		t.Fatalf("renewal gate must refuse a retired market, got %v", err)
	}
	setStr(s, kState(c), StateClosed)
	if err := requireMarketAcceptsRenewal(s, c, frozen+1); errSymbol(err) != ErrState {
		t.Fatalf("renewal gate must refuse CLOSED, got %v", err)
	}
}

// TestH16_LegacySurplusMarketCannotBeRevived (PRUNED 2026-08-30 H16). A market that
// froze under the PREVIOUS rules and had a partial pro-rata refund carries
// R > area(S). Reviving it would reopen Buy against that surplus. The revival
// check refuses; Retire still pays the surplus to the remaining holders.
func TestH16_LegacySurplusMarketCannotBeRevived(t *testing.T) {
	s := NewMemStore()
	const c, alice, bob = "h16creator", "h16alice", "h16bob"
	const reg = uint64(1_000_000)
	if err := Register(s, c, c, reg, 1000, MaxCap); err != nil {
		t.Fatal(err)
	}
	if _, err := Buy(s, alice, c, reg+1, big.NewInt(400)); err != nil {
		t.Fatal(err)
	}
	if _, err := Buy(s, bob, c, reg+2, big.NewInt(100)); err != nil {
		t.Fatal(err)
	}
	// Lapse past grace, then reproduce what the OLD rules allowed: alice takes a
	// flat pro-rata refund of her 400 while naturally FROZEN. Same arithmetic as
	// refund.go's refundPayout, written into state directly because the A1 core
	// under test no longer opens that rail on a lapse.
	frozen := getU64(s, kPaidUntil(c)) + GraceBlocks + 100
	if got := Phase(s, c, frozen); got != StateFrozen {
		t.Fatalf("fixture: phase = %s, want FROZEN", got)
	}
	R := getMoney(s, kReserve(c))
	S := getMoney(s, kSupply(c))
	gross := refundPayout(R, big.NewInt(400), S)
	setMoney(s, kReserve(c), new(big.Int).Sub(R, gross))
	setMoney(s, kSupply(c), new(big.Int).Sub(S, big.NewInt(400)))
	setMoney(s, kBal(c, alice), big.NewInt(0))
	surplus := new(big.Int).Sub(getMoney(s, kReserve(c)), Area(getMoney(s, kSupply(c))))
	if surplus.Sign() <= 0 {
		t.Fatalf("fixture: expected a surplus after a partial pro-rata refund, got %s", surplus)
	}
	t.Logf("legacy surplus after refunding 400 of 500: %s base units", surplus)

	// The revival is refused, by anyone, with the reason.
	err := Renew(s, "afan", c, frozen, 1, big.NewInt(SubscriptionFee))
	if err == nil || errSymbol(err) != ErrState {
		t.Fatalf("Renew on a legacy-surplus FROZEN market must be refused, got %v", err)
	}
	// And with the revival refused the market stays FROZEN, so Buy is refused by
	// the ordinary inflow gate: the surplus is never exposed to a fresh buyer.
	if _, err := Buy(s, "raider", c, frozen, big.NewInt(1)); err == nil || errSymbol(err) != ErrState {
		t.Fatalf("Buy on the still-FROZEN surplus market must be refused, got %v", err)
	}
	// A Buy-time equality assert was tried here as defense in depth and WITHDRAWN:
	// curve_fuzz_test.go's legacy-excess robustness property (cfSeedMarket seeds
	// R = area(S) + excess and proves the curve rails neither move nor extract it)
	// is a deliberate contract, and once revival is refused there is no road by
	// which a surplus market is ever ACTIVE, so the assert bought nothing and
	// broke a true property. Recorded so nobody re-adds it without that context.
	// The holder is not trapped: Sell on the curve works, and Retire pays the
	// surplus to the remaining holder.
	if _, err := Sell(s, bob, c, frozen, big.NewInt(10)); err != nil {
		t.Fatalf("Sell must stay open on the lapsed market: %v", err)
	}
	if err := Retire(s, c, c, frozen); err != nil {
		t.Fatal(err)
	}
	later := frozen + GraceBlocks + ExitTaxDecayBlocks + 1
	bal := getMoney(s, kBal(c, bob))
	reserveBefore := getMoney(s, kReserve(c))
	payout, err := Refund(s, bob, c, later, bal)
	if err != nil {
		t.Fatalf("Refund after Retire: %v", err)
	}
	if payout.Cmp(reserveBefore) != 0 {
		t.Fatalf("the last holder's pro-rata after Retire should be the WHOLE reserve incl. the surplus: got %s, reserve was %s", payout, reserveBefore)
	}

	// CONTROL: an honest lapsed market (R == area(S)) revives and trades.
	s2 := NewMemStore()
	if err := Register(s2, c, c, reg, 1000, MaxCap); err != nil {
		t.Fatal(err)
	}
	if _, err := Buy(s2, alice, c, reg+1, big.NewInt(100)); err != nil {
		t.Fatal(err)
	}
	frozen2 := getU64(s2, kPaidUntil(c)) + GraceBlocks + 100
	if err := Renew(s2, "afan", c, frozen2, 1, big.NewInt(SubscriptionFee)); err != nil {
		t.Fatalf("honest lapsed market must revive: %v", err)
	}
	if _, err := Buy(s2, "buyer", c, frozen2+1, big.NewInt(1)); err != nil {
		t.Fatalf("Buy after an honest revival must work: %v", err)
	}
}
