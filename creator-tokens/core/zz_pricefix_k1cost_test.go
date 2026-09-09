package core

import (
	"math/big"
	"testing"
)

// Quantify OUTFLOWK1 as an ATTACK: attacker's real cost to mount the 50000-gift
// vs the victim's measured harm. If cost >> harm, it is the launder, not grief.
func TestPFK1_AttackerCostVsHarm(t *testing.T) {
	const c, bob, mallory = "alice", "bob", "mallory"
	s := NewMemStore()
	if err := Register(s, c, c, 1000, 1000, MaxCap); err != nil {
		t.Fatal(err)
	}
	t0 := uint64(2000)
	t1 := t0 + ExitTaxDecayBlocks
	setU64(s, kPaidUntil(c), t1+SubscriptionPeriod)
	if _, err := Buy(s, bob, c, t0, big.NewInt(50000)); err != nil {
		t.Fatal(err)
	}
	// attacker's cost to buy 50000 fresh at supply 50000:
	br, err := Buy(s, mallory, c, t1, big.NewInt(50000))
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("attacker BUY 50000: cost(reserve)=%s fee=%s totalDue=%s", br.Cost, br.Fee, br.TotalDue)
	t.Logf("attacker recovers NOTHING (gives the 50000 away): net attacker loss = %s", br.TotalDue)
	// The OUTFLOWK1 harness reports victim harm (baseTotal-atkTotal) at the 15%%
	// exit-tax ceiling = 10,215,452 (was 39,771,029,984 at the old 20%% ceiling).
	t.Logf("victim measured harm (from OUTFLOWK1) = 10,215,452")
	ratio := new(big.Int).Div(br.TotalDue, big.NewInt(10_215_452))
	t.Logf("attacker cost : victim harm ratio = %s : 1", ratio)
}
