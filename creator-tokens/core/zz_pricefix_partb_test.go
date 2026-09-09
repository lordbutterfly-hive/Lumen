package core

import (
	"math/big"
	"testing"
)

// zz_pricefix_partb_test.go — the exact invariants of the PRICE-1 candidate
// (per-cohort non-dilutable floor). All scratch-only.

// The floor is EXACTLY the blend on a homogeneous maturing bucket (one cohort),
// and EXACTLY the per-cohort sum on a heterogeneous one; the reported tax is
// max(blend, cohort).
func TestPFPartB_CohortFloorExactAndHomogeneousNoOp(t *testing.T) {
	const c = "alice"
	t0 := uint64(2_000_000)
	t1 := t0 + ExitTaxDecayBlocks

	// (1) HOMOGENEOUS: a single fresh buy. cohortTax must EQUAL blendTax, so the
	// floor is a no-op and the single-rate identity still holds exactly.
	s := NewMemStore()
	pfMarket(t, s, c, t1)
	pfBuy(t, s, "h", c, t1, 400) // one cohort, fresh
	supply := getMoney(s, kSupply(c))
	_, fromMat := splitDraw(s, c, "h", big.NewInt(400))
	taxable, _ := SellProceeds(supply, fromMat)
	bps := ExitTaxBpsAt(heldBlocksAt(s, c, "h", t1))
	blend := ExitTaxOn(taxable, bps)
	cohort, _, _, _ := maturingCohortTax(s, c, "h", supply, fromMat, t1)
	if cohort.Cmp(blend) != 0 {
		t.Fatalf("homogeneous: cohortTax %s != blendTax %s (floor must be a no-op)", cohort, blend)
	}
	r, _ := QuoteSell(s, "h", c, t1, big.NewInt(400))
	if r.Tax.Cmp(ExitTaxOn(r.TaxableGross, r.TaxBps)) != 0 {
		t.Fatalf("homogeneous: single-rate identity broke: tax %s != %s", r.Tax, ExitTaxOn(r.TaxableGross, r.TaxBps))
	}

	// (2) HETEROGENEOUS (PRICE-1): aged pile + fresh transfer-in. cohortTax must
	// EXCEED blendTax and equal the intended (fresh @1500 on the top slice).
	s2 := NewMemStore()
	pfMarket(t, s2, c, t1)
	pfBuy(t, s2, "whale", c, t0, 4000) // aged cohort
	pfBuy(t, s2, "alt", c, t1, 400)    // fresh
	if err := TransferCredits(s2, "alt", c, "alt", "whale", t1, big.NewInt(400)); err != nil {
		t.Fatal(err)
	}
	supply2 := getMoney(s2, kSupply(c))
	_, fm2 := splitDraw(s2, c, "whale", big.NewInt(4400))
	taxable2, _ := SellProceeds(supply2, fm2)
	bps2 := ExitTaxBpsAt(heldBlocksAt(s2, c, "whale", t1))
	blend2 := ExitTaxOn(taxable2, bps2)
	cohort2, _, _, _ := maturingCohortTax(s2, c, "whale", supply2, fm2, t1)
	topM, _ := SellProceeds(supply2, big.NewInt(400))
	intended := ExitTaxOn(topM, MaxExitTaxBps)
	if cohort2.Cmp(blend2) <= 0 {
		t.Fatalf("heterogeneous: cohortTax %s must exceed blendTax %s (launder)", cohort2, blend2)
	}
	if cohort2.Cmp(intended) != 0 {
		t.Fatalf("heterogeneous: cohortTax %s != intended (fresh @1500 top slice) %s", cohort2, intended)
	}
	rq, _ := QuoteSell(s2, "whale", c, t1, big.NewInt(4400))
	if rq.Tax.Cmp(cohort2) != 0 {
		t.Fatalf("reported tax %s != max(blend,cohort) %s", rq.Tax, cohort2)
	}
	t.Logf("PART-B: homogeneous no-op (cohort==blend==%s); PRICE-1 heterogeneous cohort=%s == intended=%s > blend=%s", blend, cohort2, intended, blend2)
}

// MIGRATION: a pre-fix position (kBal/kAcqBlock set directly, NO ledger) taxes
// EXACTLY as the blend (synthesised as one cohort); a post-fix transfer-in then
// adds a real fresh cohort and the launder closes — no migration transaction.
func TestPFPartB_MigrationSynthesis(t *testing.T) {
	const c = "alice"
	t0 := uint64(2_000_000)
	t1 := t0 + ExitTaxDecayBlocks

	s := NewMemStore()
	pfMarket(t, s, c, t1)
	// Fabricate a LEGACY aged position with NO lots ledger: supply+reserve+bal+
	// clock written raw, exactly the shape a pre-fix mainnet holder has.
	setMoney(s, kSupply(c), big.NewInt(4000))
	setMoney(s, kReserve(c), Area(big.NewInt(4000)))
	setMoney(s, kBal(c, "whale"), big.NewInt(4000))
	setU64(s, kAcqBlock(c, "whale"), t0) // aged
	if getStr(s, kLots(c, "whale")) != "" {
		t.Fatal("precondition: legacy position must have no ledger")
	}
	// A legacy holder selling their own aged pile pays 0 (fully matured), same
	// as the blend — synthesis must not invent tax.
	q0, err := QuoteSell(s, "whale", c, t1, big.NewInt(4000))
	if err != nil {
		t.Fatal(err)
	}
	if q0.Tax.Sign() != 0 {
		t.Fatalf("legacy aged pile taxed %s, want 0 (synthesis invented tax)", q0.Tax)
	}
	// Now a fresh transfer-in lands (post-fix): synthesises the legacy cohort and
	// appends the fresh one, so the launder closes on the mixed sale.
	pfBuy(t, s, "alt", c, t1, 400)
	if err := TransferCredits(s, "alt", c, "alt", "whale", t1, big.NewInt(400)); err != nil {
		t.Fatal(err)
	}
	supply := getMoney(s, kSupply(c))
	topM, _ := SellProceeds(supply, big.NewInt(400))
	intended := ExitTaxOn(topM, MaxExitTaxBps)
	q1, err := QuoteSell(s, "whale", c, t1, big.NewInt(4400))
	if err != nil {
		t.Fatal(err)
	}
	if q1.Tax.Cmp(intended) != 0 {
		t.Fatalf("post-migration launder NOT closed: tax %s != intended %s", q1.Tax, intended)
	}
	t.Logf("MIGRATION: legacy aged pile taxed 0 (blend-equal); after fresh transfer-in, tax=%s == intended=%s (launder closed, no migration tx)", q1.Tax, intended)
}

// Global conservation on the fixed Sell path: money is carved from the payout,
// never a second reserve debit, so R === Area(S) after the fixed sale and the
// split p == net + tax + feeC + feeP holds to the base unit even when the cohort
// floor raises the tax.
func TestPFPartB_ConservationUnderCohortFloor(t *testing.T) {
	const c = "alice"
	t0 := uint64(2_000_000)
	t1 := t0 + ExitTaxDecayBlocks
	s := NewMemStore()
	pfMarket(t, s, c, t1)
	pfBuy(t, s, "whale", c, t0, 4000)
	pfBuy(t, s, "alt", c, t1, 400)
	if err := TransferCredits(s, "alt", c, "alt", "whale", t1, big.NewInt(400)); err != nil {
		t.Fatal(err)
	}
	rBefore := getMoney(s, kReserve(c))
	r, err := Sell(s, "whale", c, t1, big.NewInt(4400), nil)
	if err != nil {
		t.Fatal(err)
	}
	// R === Area(S) after.
	if got, want := getMoney(s, kReserve(c)), Area(getMoney(s, kSupply(c))); got.Cmp(want) != 0 {
		t.Fatalf("R !== Area(S) after fixed sale: R=%s Area=%s", got, want)
	}
	// ΔR == -gross exactly (tax/fee carved from payout, not the reserve).
	if d := new(big.Int).Sub(rBefore, getMoney(s, kReserve(c))); d.Cmp(r.Gross) != 0 {
		t.Fatalf("ΔR %s != gross %s (tax must not touch the reserve)", d, r.Gross)
	}
	// Split equality with the RAISED tax.
	sum := new(big.Int).Add(new(big.Int).Add(r.Net, r.Tax), new(big.Int).Add(r.FeeCreator, r.FeePlatform))
	if sum.Cmp(r.Gross) != 0 {
		t.Fatalf("split p != net+tax+feeC+feeP: %s vs %s", sum, r.Gross)
	}
	t.Logf("CONSERVATION: R===Area(S), ΔR==-gross, p==net+tax+feeC+feeP all hold with cohort-floor tax=%s", r.Tax)
}
