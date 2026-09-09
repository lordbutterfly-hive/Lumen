package core

import (
	"math/big"
	"testing"
)

// zz_pricefix_griefscan_test.go — is the OUTFLOWK1 regression a RATIONAL grief
// or the launder wearing a victim costume? Scans gift size onto a fixed aged
// pile and prints, for each: which tax term wins (blend vs cohort floor), the
// attacker's real cost to buy the gift, the victim's extra tax, and whether the
// victim can neutralise the gift and return to baseline.

func TestPFGriefScan_AttackerCostVsVictimHarm(t *testing.T) {
	const c = "alice"
	N := int64(50000) // the victim's aged pile
	t0 := uint64(2_000_000)
	t1 := t0 + ExitTaxDecayBlocks

	// Baseline: victim alone sells N at full maturity (rate 0).
	baseNet := func() *big.Int {
		s := NewMemStore()
		pfMarket(t, s, c, t1)
		pfBuy(t, s, "victim", c, t0, N)
		r, err := Sell(s, "victim", c, t1, big.NewInt(N), nil)
		if err != nil {
			t.Fatal(err)
		}
		return r.Net
	}()

	t.Logf("baseline victim net (sells %d aged @0 tax) = %s", N, baseNet)
	t.Logf("%-8s %-10s %-14s %-14s %-16s %-16s", "gift", "winner", "blendTax", "cohortTax", "attackerCost", "victimExtraTax")

	for _, g := range []int64{1, 10, 100, 1000, 2500, 5000, 10000, 25000, 50000} {
		s := NewMemStore()
		pfMarket(t, s, c, t1)
		pfBuy(t, s, "victim", c, t0, N)
		// attacker buys g fresh and transfers to victim.
		pfBuy(t, s, "attacker", c, t1, g)
		S := getMoney(s, kSupply(c))
		attackerCost, _ := SellProceeds(S, big.NewInt(g)) // gift's curve value ~ what attacker sank
		if err := TransferCredits(s, "attacker", c, "attacker", "victim", t1, big.NewInt(g)); err != nil {
			t.Fatal(err)
		}
		// Victim sells N (freshest-first will draw the gift first under the fix).
		q, err := QuoteSell(s, "victim", c, t1, big.NewInt(N))
		if err != nil {
			t.Fatal(err)
		}
		// Recompute the two tax terms to see which the max picked.
		supply := getMoney(s, kSupply(c))
		_, fromMaturing := splitDraw(s, c, "victim", big.NewInt(N))
		taxable, _ := SellProceeds(supply, fromMaturing)
		blendTax := ExitTaxOn(taxable, q.TaxBps)
		cohortTax, _, _, _ := maturingCohortTax(s, c, "victim", supply, fromMaturing, t1)
		winner := "blend"
		if cohortTax.Cmp(blendTax) > 0 {
			winner = "COHORT"
		}
		victimExtra := new(big.Int).Sub(baseNet, q.Net) // how much less the victim nets vs baseline
		t.Logf("%-8d %-10s %-14s %-14s %-16s %-16s", g, winner, blendTax, cohortTax, attackerCost, victimExtra)
	}
}

// Can the victim NEUTRALISE a poison gift — send the fresh tokens back out
// (freshest-first) and sell their own aged pile at 0, returning to baseline?
func TestPFGriefScan_VictimCanNeutralise(t *testing.T) {
	const c = "alice"
	N, g := int64(50000), int64(50000)
	t0 := uint64(2_000_000)
	t1 := t0 + ExitTaxDecayBlocks

	s := NewMemStore()
	pfMarket(t, s, c, t1)
	pfBuy(t, s, "victim", c, t0, N)
	pfBuy(t, s, "attacker", c, t1, g)
	if err := TransferCredits(s, "attacker", c, "attacker", "victim", t1, big.NewInt(g)); err != nil {
		t.Fatal(err)
	}
	// Victim dumps the fresh gift to a burner (freshest-first sends the gift).
	if err := TransferCredits(s, "victim", c, "victim", "burner", t1, big.NewInt(g)); err != nil {
		t.Fatal(err)
	}
	// Now victim sells their own aged pile.
	r, err := Sell(s, "victim", c, t1, big.NewInt(N), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("after neutralising (dump gift, sell aged): victim taxBps=%d tax=%s net=%s", r.TaxBps, r.Tax, r.Net)
	if r.Tax.Sign() != 0 {
		t.Logf("NOTE: victim's aged pile still taxed %s — gift not fully neutralised freshest-first", r.Tax)
	} else {
		t.Logf("NEUTRALISED: victim sold aged pile at 0 tax after dumping the gift (back to baseline)")
	}
}
