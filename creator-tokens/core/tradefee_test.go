package core

import (
	"math/big"
	"testing"
)

// tradefee_test.go — the fee split (floor + odd-unit→platform), the pull
// accrual (RULING F8), and ClaimTradeFees' outflow discipline (never pauses,
// never phase-gated).

func TestTradeFee_Split_Exact(t *testing.T) {
	cases := []struct {
		name            string
		amount          int64
		fee, feeC, feeP int64
	}{
		{"worked-example-54", 54, 5, 2, 3}, // money-math §3.4: odd unit → platform
		{"even-fee", 100, 10, 5, 5},
		{"dust-no-fee", 9, 0, 0, 0},   // floor(0.9) — revenue absorbs the dust, never the reserve
		{"one-unit-fee", 10, 1, 0, 1}, // odd unit → platform, creator floor 0
		{"zero", 0, 0, 0, 0},
		{"worked-example-65", 65, 6, 3, 3},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			fee, feeC, feeP := tradeFeeOn(big.NewInt(c.amount))
			if fee.Cmp(big.NewInt(c.fee)) != 0 || feeC.Cmp(big.NewInt(c.feeC)) != 0 || feeP.Cmp(big.NewInt(c.feeP)) != 0 {
				t.Fatalf("tradeFeeOn(%d) = (%s,%s,%s), want (%d,%d,%d)", c.amount, fee, feeC, feeP, c.fee, c.feeC, c.feeP)
			}
			// C-18's fee half: the split is an EQUALITY, no dust anywhere.
			if mAdd(feeC, feeP).Cmp(fee) != 0 {
				t.Fatalf("split leaks: %s + %s != %s", feeC, feeP, fee)
			}
		})
	}
}

func TestTradeFee_AccrueRoutesToPullPots(t *testing.T) {
	s := NewMemStore()
	accrueTradeFee(s, "creatora", big.NewInt(7), big.NewInt(8))
	accrueTradeFee(s, "creatora", big.NewInt(2), big.NewInt(3))
	if got := getMoney(s, kFeeBal("creatora")); got.Cmp(big.NewInt(9)) != 0 {
		t.Fatalf("creator fee pot = %s, want 9", got)
	}
	if got := getMoney(s, kTreasury()); got.Cmp(big.NewInt(11)) != 0 {
		t.Fatalf("treasury = %s, want 11", got)
	}
}

func TestTradeFee_AccrueZeroWritesNothing(t *testing.T) {
	s := NewMemStore()
	accrueTradeFee(s, "creatora", mZero(), mZero())
	if len(s.Keys()) != 0 {
		t.Fatalf("zero accrual wrote state: %v", s.Keys())
	}
}

func TestClaimTradeFees_HappyThenEmpty(t *testing.T) {
	s := NewMemStore()
	accrueTradeFee(s, "creatora", big.NewInt(123), big.NewInt(124))

	got, err := ClaimTradeFees(s, "creatora")
	if err != nil {
		t.Fatal(err)
	}
	if got.Cmp(big.NewInt(123)) != 0 {
		t.Fatalf("claimed %s, want 123", got)
	}
	if bal := getMoney(s, kFeeBal("creatora")); bal.Sign() != 0 {
		t.Fatalf("pot after claim = %s, want 0", bal)
	}
	// Second claim: harmless zero no-op (RefundHolder's convention).
	got2, err := ClaimTradeFees(s, "creatora")
	if err != nil || got2.Sign() != 0 {
		t.Fatalf("second claim = (%s, %v), want (0, nil)", got2, err)
	}
	// The platform half is untouched by a creator claim.
	if tr := getMoney(s, kTreasury()); tr.Cmp(big.NewInt(124)) != 0 {
		t.Fatalf("treasury = %s, want untouched 124", tr)
	}
}

func TestClaimTradeFees_InvalidCallerRejected(t *testing.T) {
	s := NewMemStore()
	if _, err := ClaimTradeFees(s, "bad|pipe"); errSymbol(err) != ErrAuth {
		t.Fatalf("err = %v, want %s", err, ErrAuth)
	}
	if _, err := ClaimTradeFees(s, ""); errSymbol(err) != ErrAuth {
		t.Fatalf("empty caller err = %v, want %s", err, ErrAuth)
	}
}

// THE outflow rule: a claim of already-earned fees consults NOTHING — not the
// global pause, not any market phase. A creator mid-wind-down (or mid-pause)
// collects their earned revenue exactly like anyone else.
func TestClaimTradeFees_IgnoresPauseAndPhase(t *testing.T) {
	s := NewMemStore()
	accrueTradeFee(s, "creatora", big.NewInt(50), big.NewInt(50))
	setStr(s, kPaused(), "1")                  // global inbound pause ON
	setStr(s, kState("creatora"), StateClosed) // market terminally CLOSED
	got, err := ClaimTradeFees(s, "creatora")
	if err != nil {
		t.Fatalf("claim under pause+CLOSED failed: %v — outflows never pause", err)
	}
	if got.Cmp(big.NewInt(50)) != 0 {
		t.Fatalf("claimed %s, want 50", got)
	}
}
