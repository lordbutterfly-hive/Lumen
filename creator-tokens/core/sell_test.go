package core

import (
	"math/big"
	"math/rand"
	"testing"
)

// sell_test.go — Sell under RULINGS J + J1 (money tax, TREASURY destination,
// realized-gain cap, exact-area proceeds): worked examples to the unit, the
// tax split equalities, the rail switch (phase-routed, NEVER paused), the
// corrupt-state solvency refusal, the whale-tax un-recoverability across
// tranche and account counts, chunked-vs-single tax behaviour, the
// governing theorem end-to-end, and the randomized-sequence property suite
// for the equality invariant, ledger conservation and the hold clock.
//
// Exact expectations are computed at the RULING-I calibration (BasePrice=
// 1000, a=63/8, b=21/8000). Reference areas used below:
//
//	area(10)=10,434  area(11)=11,521  area(15)=15,948  area(20)=21,661
//	area(21)=22,827  area(30)=33,686  area(100)=140,656  area(200)=365,340
//	area(280)=609,113(=area(300)−70,186)  area(300)=679,299

// slRequireCalibration hard-fails (never skips) when the compiled curve
// changes: worked-example expectations must be RECOMPUTED, not silently
// bypassed.
func slRequireCalibration(t *testing.T) {
	t.Helper()
	if BasePrice != 1000 || CurveLinNum != 63000 || CurveQuadNum != 21 || CurveDenom != 8000 {
		t.Fatalf("calibration changed — recompute this file's expectations; do NOT skip")
	}
}

// slSetupCurveMarket builds a market whose entire state came through the
// curve: hodler owns 10 (S=10, R=10,434 = area(10) — equality, E=0) bought
// at block 1000.
func slSetupCurveMarket(t *testing.T) (*MemStore, string) {
	t.Helper()
	s := NewMemStore()
	setupMarket(s, "creatora", 100, 1_000_000_000)
	if _, err := Buy(s, "hodler", "creatora", 1000, big.NewInt(10)); err != nil {
		t.Fatal(err)
	}
	return s, "creatora"
}

// slAssertSplits asserts the exact split equality on a SellResult (C-18's
// successor): p == net + tax + feeC + feeP — zero dust anywhere.
func slAssertSplits(t *testing.T, r *SellResult) {
	t.Helper()
	sum := mAdd(mAdd(r.Net, r.Tax), mAdd(r.FeeCreator, r.FeePlatform))
	if sum.Cmp(r.Gross) != 0 {
		t.Fatalf("split violated: net %s + tax %s + feeC %s + feeP %s != p %s",
			r.Net, r.Tax, r.FeeCreator, r.FeePlatform, r.Gross)
	}
	if mAdd(r.FeeCreator, r.FeePlatform).Cmp(r.Fee) != 0 {
		t.Fatalf("fee split violated: %s + %s != %s", r.FeeCreator, r.FeePlatform, r.Fee)
	}
	// RULING K1 sanity on every asserted result: the tax is EXACTLY the gross
	// rate tax ceil(p·τ/1e4) — no cap, no episode, no gain term. This exact
	// identity (not a bracket) is what makes the tax un-splittable by ceil
	// superadditivity, and it is the property net >= 0 rests on (ceil(p·τ) +
	// fee < p for τ <= 2000).
	if want := ExitTaxOn(r.Gross, r.TaxBps); r.Tax.Cmp(want) != 0 {
		t.Fatalf("tax %s != ExitTaxOn(gross %s, %d bps) %s — the gross tax has no cap", r.Tax, r.Gross, r.TaxBps, want)
	}
}

// THE RULING-K1 HEADLINE, worked to the unit: an instant round trip pays the
// FULL rate tax on gross proceeds — no realized-gain cap. This REVERSES J1
// (which zeroed the no-gain seller's tax): K1's accepted, disclosed cost is
// that a fresh seller pays τ of PROCEEDS, not of gain. The trip loses both 10%
// fees AND the full 20% tax. The upside K1 buys: the tax is un-splittable
// (ceil superadditive) with ZERO per-position state.
func TestSell_WorkedExample_InstantRoundTrip_FullRateTax(t *testing.T) {
	slRequireCalibration(t)
	s, c := slSetupCurveMarket(t) // S=10, R=10,434=area(10), E=0

	// Fresh attacker buys 5 at block 2000: cost = area(15) − area(10) =
	// 5,514, fee 551 — paid 6,065. R = 15,948 = area(15).
	rb, err := Buy(s, "attacker", c, 2000, big.NewInt(5))
	if err != nil {
		t.Fatal(err)
	}
	if rb.TotalDue.Cmp(big.NewInt(6065)) != 0 {
		t.Fatalf("buy total = %s, want 6065", rb.TotalDue)
	}
	treasury0 := getMoney(s, kTreasury())

	// Sells all 5 in the same block (h=0 ⇒ τ=2000 max): p = area(15) − area(10)
	// = 5,514 (the full slice, no burn); K1 tax = ceil(5,514·0.2) = 1,103 (GROSS
	// rate, no cap); fee = floor(551.4) = 551 (feeC 275, feeP 276); net =
	// 5,514 − 1,103 − 551 = 3,860.
	rs, err := Sell(s, "attacker", c, 2000, big.NewInt(5))
	if err != nil {
		t.Fatal(err)
	}
	slAssertSplits(t, rs)
	if rs.TaxBps != 2000 || rs.HeldBlocks != 0 {
		t.Fatalf("rate = %d bps at held %d, want 2000 at 0", rs.TaxBps, rs.HeldBlocks)
	}
	if rs.Gross.Cmp(big.NewInt(5514)) != 0 ||
		rs.Tax.Cmp(big.NewInt(1103)) != 0 || rs.Fee.Cmp(big.NewInt(551)) != 0 ||
		rs.FeeCreator.Cmp(big.NewInt(275)) != 0 || rs.FeePlatform.Cmp(big.NewInt(276)) != 0 ||
		rs.Net.Cmp(big.NewInt(3860)) != 0 {
		t.Fatalf("sell = p %s tax %s fee %s (%s/%s) net %s, want 5514/1103/551(275/276)/3860",
			rs.Gross, rs.Tax, rs.Fee, rs.FeeCreator, rs.FeePlatform, rs.Net)
	}

	// After: S=10, R = 15,948 − 5,514 = 10,434 = area(10) EXACTLY — the
	// equality invariant. The attacker's round trip LOST 2,205 (paid 6,065,
	// received 3,860): 1,102 fees + 1,103 tax, 0 to rounding.
	if got := getMoney(s, kSupply(c)); got.Cmp(big.NewInt(10)) != 0 {
		t.Fatalf("supply = %s, want 10", got)
	}
	if got := getMoney(s, kReserve(c)); got.Cmp(big.NewInt(10_434)) != 0 {
		t.Fatalf("reserve = %s, want 10434 = area(10) (equality)", got)
	}
	e := new(big.Int).Sub(getMoney(s, kReserve(c)), Area(getMoney(s, kSupply(c))))
	if e.Sign() != 0 {
		t.Fatalf("E = %s, want exactly 0 (RULING A)", e)
	}
	pnl := new(big.Int).Sub(rs.Net, rb.TotalDue)
	if pnl.Cmp(big.NewInt(-2205)) != 0 {
		t.Fatalf("attacker P&L = %s, want −2205 (both fees + the full gross tax)", pnl)
	}
	// Treasury received the PLATFORM HALF of the 1,103 tax plus the platform
	// fee half (2026-07-27 split); the creator's claimable pot received the
	// other tax half. The attacker's P&L above is unaffected — the split moves
	// where the tax lands, never how much is assessed.
	taxC, taxP := exitTaxSplit(c, "attacker", big.NewInt(1103))
	wantTrea := mAdd(mAdd(treasury0, taxP), rs.FeePlatform)
	if got := getMoney(s, kTreasury()); got.Cmp(wantTrea) != 0 {
		t.Fatalf("treasury = %s, want %s (platform half of the tax + platform fee half)", got, wantTrea)
	}
	if reunited := mAdd(taxC, taxP); reunited.Cmp(big.NewInt(1103)) != 0 {
		t.Fatalf("tax split leaked: %s != assessed 1103", reunited)
	}
	// The seller's balance went to 0 (full exit); wacq NOT touched by the sell.
	if got := getMoney(s, kBal(c, "attacker")); !mIsZero(got) {
		t.Fatalf("attacker balance = %s, want 0", got)
	}
	if w := holderAcqBlock(s, c, "attacker"); w != 2000 {
		t.Fatalf("attacker wacq = %d, want 2000 unchanged by the sell", w)
	}
}

// THE REFERENCE ATTACKER, worked to the unit: early buyer, fans buy after,
// fresh dump — the full 20% gross tax (RULING K1: no cap) goes to the TREASURY
// (RULING J), where no tranche or account trick recovers it. (This case paid
// the identical amount under the old J1 cap too, because the realized gain
// exceeded the rate — the attacker regime the cap never helped.)
func TestSell_WorkedExample_AttackerGain_FullRateTax_ToTreasury(t *testing.T) {
	slRequireCalibration(t)
	s := NewMemStore()
	setupMarket(s, "creatora", 100, 1_000_000_000)
	c := "creatora"

	// alice (the attacker) buys 100 from S=0: cost = area(100) = 140,656,
	// fee 14,065 — paid 154,721. Basis 140,656.
	ra, err := Buy(s, "alice", c, 1000, big.NewInt(100))
	if err != nil {
		t.Fatal(err)
	}
	if ra.TotalDue.Cmp(big.NewInt(154_721)) != 0 {
		t.Fatalf("alice paid %s, want 154721", ra.TotalDue)
	}
	// bob (the fans) buys 100: cost = area(200) − area(100) = 224,684.
	if _, err := Buy(s, "bob", c, 1010, big.NewInt(100)); err != nil {
		t.Fatal(err)
	}
	treasury0 := getMoney(s, kTreasury())

	// alice dumps her 100 one block later — fresh (τ=2000): p = area(200) −
	// area(100) = 224,684; K1 tax = ceil(224,684·0.2) = 44,937 (gross, no cap);
	// fee = 22,468; net = 224,684 − 44,937 − 22,468 = 157,279.
	rs, err := Sell(s, "alice", c, 1011, big.NewInt(100))
	if err != nil {
		t.Fatal(err)
	}
	slAssertSplits(t, rs)
	if rs.Gross.Cmp(big.NewInt(224_684)) != 0 ||
		rs.Tax.Cmp(big.NewInt(44_937)) != 0 || rs.Net.Cmp(big.NewInt(157_279)) != 0 {
		t.Fatalf("dump = p %s tax %s net %s, want 224684/44937/157279",
			rs.Gross, rs.Tax, rs.Net)
	}
	// The tax is split 50/50 creator/platform (2026-07-27). What has NOT
	// changed is the property this assertion exists for: alice — the seller —
	// gets back not one unit of it. Her half goes to the CREATOR's claimable
	// pot, an account she does not control, so there is still no path by which
	// a seller recovers their own exit tax. (That was the whole defect the
	// deleted holder-distribution pot had: the seller's retained balance and
	// alts recovered up to 97.5% of it.)
	taxC, taxP := exitTaxSplit(c, "alice", rs.Tax)
	wantTrea := mAdd(mAdd(treasury0, taxP), rs.FeePlatform)
	if got := getMoney(s, kTreasury()); got.Cmp(wantTrea) != 0 {
		t.Fatalf("treasury = %s, want %s (platform half of the tax + platform fee half)", got, wantTrea)
	}
	if reunited := mAdd(taxC, taxP); reunited.Cmp(rs.Tax) != 0 {
		t.Fatalf("tax split leaked: %s != assessed %s", reunited, rs.Tax)
	}
	// Honest disclosure, asserted: alice STILL nets a profit (157,279 −
	// 154,721 = 2,558) — funded entirely by bob's later buy, never by the
	// reserve (equality holds below). The curve-leg transfer from late
	// buyers to early sellers IS the instrument (RULING J residual truth #1);
	// the tax prices it, it cannot delete it.
	profit := new(big.Int).Sub(rs.Net, ra.TotalDue)
	if profit.Cmp(big.NewInt(2558)) != 0 {
		t.Fatalf("attacker profit = %s, want 2558 (disclosed by-design transfer, post-tax)", profit)
	}
	if R, S := getMoney(s, kReserve(c)), getMoney(s, kSupply(c)); R.Cmp(Area(S)) != 0 {
		t.Fatalf("equality broken: R=%s != area(%s)=%s", R, S, Area(S))
	}
}

// THE DISCLOSED K1 COST, worked to the unit: a fan who bought the top and
// panic-sells into the post-dump bottom realizes a LOSS and STILL pays the
// full gross tax. RULING K1 reversed J1's realized-gain cap (which charged
// this fan 0) — the accepted trade is that the cap's one sympathetic edge (a
// fresh loss-seller) now pays τ of proceeds, in exchange for an un-splittable
// tax with zero per-position state. This test pins the NEW behaviour so the
// disclosure stays honest and visible.
func TestSell_WorkedExample_VictimSellsAtLoss_StillPaysFullTax(t *testing.T) {
	slRequireCalibration(t)
	s := NewMemStore()
	setupMarket(s, "creatora", 100, 1_000_000_000)
	c := "creatora"

	// A whale owns the bottom of the curve; the fan buys 20 at the top
	// (S=280→300): cost = area(300) − area(280) = 70,186.
	if _, err := Buy(s, "whale", c, 1000, big.NewInt(280)); err != nil {
		t.Fatal(err)
	}
	if _, err := Buy(s, "fan", c, 1010, big.NewInt(20)); err != nil {
		t.Fatal(err)
	}
	// The whale dumps 200 — the price collapses (S: 300 → 100).
	if _, err := Sell(s, "whale", c, 1011, big.NewInt(200)); err != nil {
		t.Fatal(err)
	}
	treasury0 := getMoney(s, kTreasury())

	// The fan panic-sells all 20 into the bottom, FRESH (τ=2000): p =
	// area(100) − area(80) = 34,685 (a realized LOSS against the 70,186 paid).
	// K1 tax = ceil(34,685·0.2) = 6,937 (gross, no cap — the loss is NOT
	// sheltered). fee = 3,468. net = 34,685 − 6,937 − 3,468 = 24,280.
	rs, err := Sell(s, "fan", c, 1012, big.NewInt(20))
	if err != nil {
		t.Fatal(err)
	}
	slAssertSplits(t, rs)
	if rs.TaxBps != 2000 {
		t.Fatalf("rate = %d bps, want 2000 (fresh)", rs.TaxBps)
	}
	if rs.Gross.Cmp(big.NewInt(34_685)) != 0 ||
		rs.Tax.Cmp(big.NewInt(6937)) != 0 || rs.Net.Cmp(big.NewInt(24_280)) != 0 {
		t.Fatalf("victim sell = p %s tax %s net %s, want 34685/6937/24280 (K1: loss is not sheltered)",
			rs.Gross, rs.Tax, rs.Net)
	}
	// Treasury got the PLATFORM HALF of the gross tax + the platform fee half
	// (2026-07-27 split); the creator's pot got the other tax half. The point
	// of this test is unchanged: a seller at a LOSS still pays the full gross
	// tax — it is just no longer all collected by one account.
	_, taxP := exitTaxSplit(c, "victim", big.NewInt(6937))
	wantTrea := mAdd(mAdd(treasury0, taxP), rs.FeePlatform)
	if got := getMoney(s, kTreasury()); got.Cmp(wantTrea) != 0 {
		t.Fatalf("treasury = %s, want %s (platform half of gross tax + platform fee half)", got, wantTrea)
	}
}

func TestSell_TaxDecay_ZeroAfterSixWeeks(t *testing.T) {
	slRequireCalibration(t)
	s, c := slSetupCurveMarket(t)
	if _, err := Buy(s, "patient", c, 2000, big.NewInt(5)); err != nil {
		t.Fatal(err)
	}
	// Keep the subscription alive across the six-week hold — the market
	// must be ACTIVE/OVERDUE for the curve rail.
	setU64(s, kPaidUntil(c), 2000+ExitTaxDecayBlocks+SubscriptionPeriod)

	rs, err := Sell(s, "patient", c, 2000+ExitTaxDecayBlocks, big.NewInt(5))
	if err != nil {
		t.Fatal(err)
	}
	slAssertSplits(t, rs)
	if rs.TaxBps != 0 || rs.Tax.Sign() != 0 {
		t.Fatalf("tax after full decay = %d bps / %s units, want 0/0", rs.TaxBps, rs.Tax)
	}
	// Untaxed: p = area(15) − area(10) = 5,514 — EXACTLY what the buyer paid
	// for this slice (L5 equality). fee 551, net 4,963. Still a loss vs the
	// 6,065 paid — the 10% fees each way guarantee no free round trip even
	// at zero tax.
	if rs.Gross.Cmp(big.NewInt(5514)) != 0 || rs.Net.Cmp(big.NewInt(4963)) != 0 {
		t.Fatalf("untaxed sell p %s net %s, want 5514/4963 (exact area step — L5 equality)", rs.Gross, rs.Net)
	}
}

// Mid-decay partial exit by the sole holder — the GROSS-RATE regime under
// RULING K1, worked to the unit: no cap, so a half-decayed position pays τ of
// its full proceeds. Every unit goes to the treasury (RULING J).
func TestSell_TaxDecay_Midpoint_FullRate_ToTreasury(t *testing.T) {
	slRequireCalibration(t)
	s := NewMemStore()
	setupMarket(s, "creatora", 100, 1_000_000_000)
	if _, err := Buy(s, "holder", "creatora", 1000, big.NewInt(30)); err != nil {
		t.Fatal(err) // cost = area(30) = 33,686
	}
	setU64(s, kPaidUntil("creatora"), 1000+ExitTaxDecayBlocks+SubscriptionPeriod)
	treasuryBefore := getMoney(s, kTreasury())

	// Held exactly half the decay window: τ = 1000 bps exactly. Selling 10 of
	// 30: p = area(30) − area(20) = 12,025; K1 tax = ceil(12,025·0.1) = 1,203
	// (gross, no cap); fee = floor(1,202.5) = 1,202 (601/601); net = 12,025 −
	// 1,203 − 1,202 = 9,620.
	rs, err := Sell(s, "holder", "creatora", 1000+ExitTaxDecayBlocks/2, big.NewInt(10))
	if err != nil {
		t.Fatal(err)
	}
	slAssertSplits(t, rs)
	if rs.TaxBps != 1000 || rs.Gross.Cmp(big.NewInt(12_025)) != 0 ||
		rs.Tax.Cmp(big.NewInt(1203)) != 0 || rs.Net.Cmp(big.NewInt(9620)) != 0 {
		t.Fatalf("mid-decay sell = τ%d p %s tax %s net %s, want 1000/12025/1203/9620",
			rs.TaxBps, rs.Gross, rs.Tax, rs.Net)
	}
	// Treasury got the platform half of the tax + the platform fee half.
	_, taxP := exitTaxSplit("creatora", "holder", big.NewInt(1203))
	wantTreasury := mAdd(mAdd(treasuryBefore, taxP), rs.FeePlatform)
	if got := getMoney(s, kTreasury()); got.Cmp(wantTreasury) != 0 {
		t.Fatalf("treasury = %s, want %s (platform half of the tax + platform fee half)", got, wantTreasury)
	}
}

// A 1-token sell redeems its FULL slice (RULING A/F: the burn-era version
// destroyed the token for zero payout — a 100% effective tax) and pays the
// full gross rate tax (RULING K1: no cap).
func TestSell_OneTokenSell_RedeemsFullSlice_FullRateTax(t *testing.T) {
	slRequireCalibration(t)
	s, c := slSetupCurveMarket(t) // S=10, R=10,434
	if _, err := Buy(s, "dusty", c, 2000, big.NewInt(1)); err != nil {
		t.Fatal(err) // cost = area(11) − area(10) = 1,087
	}
	// Ten more tokens arrive above dusty's (S: 11 → 21).
	if _, err := Buy(s, "later", c, 2001, big.NewInt(10)); err != nil {
		t.Fatal(err)
	}

	rs, err := Sell(s, "dusty", c, 2001, big.NewInt(1))
	if err != nil {
		t.Fatal(err)
	}
	slAssertSplits(t, rs)
	// p = area(21) − area(20) = 1,166 (the full slice — nothing burned);
	// K1 tax (fresh, τ=2000) = ceil(1,166·0.2) = 234 (gross, no cap); fee =
	// floor(116.6) = 116; net = 1,166 − 234 − 116 = 816.
	if rs.Gross.Cmp(big.NewInt(1166)) != 0 ||
		rs.Tax.Cmp(big.NewInt(234)) != 0 || rs.Fee.Cmp(big.NewInt(116)) != 0 ||
		rs.Net.Cmp(big.NewInt(816)) != 0 {
		t.Fatalf("1-token sell = p %s tax %s fee %s net %s, want 1166/234/116/816 (full slice, full gross tax)",
			rs.Gross, rs.Tax, rs.Fee, rs.Net)
	}
	// The reserve returned exactly to area(20) — the slice redeemed in full.
	if got := getMoney(s, kReserve(c)); got.Cmp(Area(big.NewInt(20))) != 0 {
		t.Fatalf("reserve = %s, want area(20) = %s", got, Area(big.NewInt(20)))
	}
}

// THE WHALE TAX IS UN-RECOVERABLE (RULING J's measured headline: 0.5% →
// 20.0% effective, "un-recoverable at any tranche count or account count"):
// the same dump, run as 1 / 2 / 10 tranches and as a 2-account split, always
// pays at least the single-shot tax, every unit lands in the treasury, and
// no path returns any of it to the whale.
func TestSell_WhaleTax_UnrecoverableAcrossTranchesAndAccounts(t *testing.T) {
	slRequireCalibration(t)

	// The scenario: whale accumulates 200 early, fans buy 100 on top, whale
	// dumps everything fresh-ish (well inside the decay window ⇒ τ > 0, and
	// the pump means a large realized gain ⇒ the RATE binds throughout —
	// the superadditive regime).
	build := func(t *testing.T) (*MemStore, string, *big.Int) {
		t.Helper()
		s := NewMemStore()
		setupMarket(s, "creatora", 100, 1_000_000_000)
		if _, err := Buy(s, "whale", "creatora", 1000, big.NewInt(200)); err != nil {
			t.Fatal(err)
		}
		if _, err := Buy(s, "fans", "creatora", 1010, big.NewInt(100)); err != nil {
			t.Fatal(err)
		}
		return s, "creatora", getMoney(s, kTreasury())
	}

	dump := func(t *testing.T, s *MemStore, c, seller string, tranches int64, block uint64) (taxSum, netSum *big.Int) {
		t.Helper()
		taxSum, netSum = mZero(), mZero()
		total := getMoney(s, kBal(c, seller))
		per := new(big.Int).Div(total, big.NewInt(tranches))
		for i := int64(0); i < tranches; i++ {
			amt := new(big.Int).Set(per)
			if i == tranches-1 {
				amt = getMoney(s, kBal(c, seller)) // remainder in the last tranche
			}
			rs, err := Sell(s, seller, c, block, amt)
			if err != nil {
				t.Fatalf("tranche %d: %v", i, err)
			}
			slAssertSplits(t, rs)
			taxSum = mAdd(taxSum, rs.Tax)
			netSum = mAdd(netSum, rs.Net)
		}
		return
	}

	// Baseline: one shot.
	s1, c1, trea01 := build(t)
	tax1, _ := dump(t, s1, c1, "whale", 1, 1020)
	if tax1.Sign() <= 0 {
		t.Fatalf("single-shot whale tax = %s, want > 0 (the scenario must be in the taxed regime)", tax1)
	}
	// Every unit of the tax landed in one of its two destinations — treasury
	// (platform half + the platform fee half) and the CREATOR's claimable pot
	// (creator half + the creator fee half) — and the whale has a claim on
	// NEITHER. That is the property this test exists for and the split does not
	// weaken it: kFeeBal is keyed by the creator, and ClaimTradeFees pays the
	// caller their OWN pot, so "creatora" is the only account that can ever
	// draw the creator half. The whale has no pot, no claimable key, and no
	// function that would pay them one unit back.
	deltaTrea := new(big.Int).Sub(getMoney(s1, kTreasury()), trea01)
	deltaPot := new(big.Int).Sub(getMoney(s1, kFeeBal(c1)), mZero())
	collected := mAdd(deltaTrea, deltaPot)
	if collected.Cmp(tax1) < 0 {
		t.Fatalf("treasury+creator-pot delta %s < tax %s — tax leaked somewhere else", collected, tax1)
	}
	if got := getMoney(s1, kFeeBal("whale")); !mIsZero(got) {
		t.Fatalf("whale has a claimable pot of %s — the exit tax must be unrecoverable by the seller", got)
	}

	// ★ CHUNKING IS CLOSED (RULING K1, 2026-07-22). Previously RULING J1's
	// per-sale cap was dodgeable: this scenario (W=200 dumped into only F=100
	// of fan inflow) let the whale's below-average-cost tail tranches be
	// forgiven while a single sale would have netted them against the
	// winners — measured 9.45% at 100 tranches, and up to 67.62% on larger
	// markets. K1 removes the cap entirely: the tax is GROSS proceeds × τ on
	// every sale, so a split pays AT LEAST the single-shot tax by ceil
	// superadditivity + curve-leg path-independence (Σ ceil(pᵢ·τ) >=
	// ceil(Σpᵢ·τ)) — with ZERO per-position state. The floor is 100% of the
	// single-shot amount (allowing only the <=1-unit-per-tranche ceil dust).
	for _, tranches := range []int64{2, 4, 5, 10, 20, 50, 100} {
		s, c, _ := build(t)
		taxN, _ := dump(t, s, c, "whale", tranches, 1020)
		if taxN.Cmp(tax1) < 0 {
			t.Fatalf("%d-tranche dump paid %s tax, BELOW the single-shot %s — the ET-1 chunk-dodge is back",
				tranches, taxN, tax1)
		}
	}
	// And in the regime the tax actually exists for — a real pump, so every
	// tranche's gain exceeds τ of its proceeds — chunking strictly
	// OVER-pays (RULING F's ceil superadditivity, with L4 making the curve
	// leg itself exactly neutral). Same whale, four times the fan inflow.
	{
		s := NewMemStore()
		setupMarket(s, "pumpmkt", 100, 1_000_000_000)
		if _, err := Buy(s, "whale", "pumpmkt", 1000, big.NewInt(200)); err != nil {
			t.Fatal(err)
		}
		if _, err := Buy(s, "fans", "pumpmkt", 1010, big.NewInt(400)); err != nil {
			t.Fatal(err)
		}
		single, _ := dump(t, s, "pumpmkt", "whale", 1, 1020)

		for _, tranches := range []int64{2, 10, 50, 200} {
			s2 := NewMemStore()
			setupMarket(s2, "pumpmkt", 100, 1_000_000_000)
			if _, err := Buy(s2, "whale", "pumpmkt", 1000, big.NewInt(200)); err != nil {
				t.Fatal(err)
			}
			if _, err := Buy(s2, "fans", "pumpmkt", 1010, big.NewInt(400)); err != nil {
				t.Fatal(err)
			}
			taxN, _ := dump(t, s2, "pumpmkt", "whale", tranches, 1020)
			if taxN.Cmp(single) < 0 {
				t.Fatalf("REAL-PUMP regime: %d-tranche dump paid %s < single-shot %s — superadditivity broken where it must hold",
					tranches, taxN, single)
			}
		}
	}

	// ACCOUNT SPLIT — the sybil question, now answered CLEANLY (RULING K1,
	// 2026-07-22). Under the deleted J1 cap the whale could move half the
	// position to an alt and book the loss-making BOTTOM slice at 0 tax while
	// the TOP slice paid full rate — a bounded but real ~32% recovery. K1
	// removes the cap, so EVERY slice pays τ × its own gross proceeds
	// regardless of gain or loss: the alt's fresh clock (a transfer re-ages it)
	// pays full τ on the bottom slice too. By ceil superadditivity + curve-leg
	// path-independence, the two-account total is therefore AT LEAST the
	// single-shot tax — the account-split lever buys the whale NOTHING now.
	// (OTC laundering off-curve still applies — RULING J residual truth #3 —
	// but any ON-CHAIN split, same account or cross account, over-pays.)
	s2, c2, _ := build(t)
	if err := TransferCredits(s2, c2, "whale", "whalealt", 1015, big.NewInt(100)); err != nil {
		t.Fatal(err)
	}
	taxW, _ := dump(t, s2, c2, "whale", 1, 1020)
	taxA, _ := dump(t, s2, c2, "whalealt", 1, 1020)
	twoAccount := mAdd(taxW, taxA)
	if twoAccount.Cmp(tax1) < 0 {
		t.Fatalf("2-account split paid %s < single-shot %s — the cross-account dodge is open (K1 should close it: no gain cap to exploit)", twoAccount, tax1)
	}

	// Same-account 2-tranche also over-pays (never under), by at most the ceil
	// dust — the gross tax is un-splittable.
	s3, c3, _ := build(t)
	twoTranche, _ := dump(t, s3, c3, "whale", 2, 1020)
	if twoTranche.Cmp(tax1) < 0 {
		t.Fatalf("same-account 2-tranche paid %s < single-shot %s (K1 superadditivity broken)", twoTranche, tax1)
	}
	if new(big.Int).Sub(twoTranche, tax1).Cmp(big.NewInt(1)) > 0 {
		t.Fatalf("same-account 2-tranche %s exceeds single-shot %s by more than 1 dust unit", twoTranche, tax1)
	}
	t.Logf("K1: single-account dump tax %s, 2-account split tax %s (both >= single, no recovery)", tax1, twoAccount)
}

func TestSell_Guards(t *testing.T) {
	t.Run("invalid-caller", func(t *testing.T) {
		s, c := slSetupCurveMarket(t)
		if _, err := Sell(s, "bad|pipe", c, 2000, big.NewInt(1)); errSymbol(err) != ErrAuth {
			t.Fatalf("err = %v, want %s", err, ErrAuth)
		}
	})
	t.Run("invalid-creator", func(t *testing.T) {
		s, _ := slSetupCurveMarket(t)
		if _, err := Sell(s, "hodler", "bad|pipe", 2000, big.NewInt(1)); errSymbol(err) != ErrInput {
			t.Fatalf("err = %v, want %s", err, ErrInput)
		}
	})
	t.Run("nil-and-zero-amount", func(t *testing.T) {
		s, c := slSetupCurveMarket(t)
		if _, err := Sell(s, "hodler", c, 2000, nil); errSymbol(err) != ErrInput {
			t.Fatalf("nil err = %v, want %s", err, ErrInput)
		}
		if _, err := Sell(s, "hodler", c, 2000, mZero()); errSymbol(err) != ErrInput {
			t.Fatalf("zero err = %v, want %s", err, ErrInput)
		}
	})
	t.Run("insufficient-balance", func(t *testing.T) {
		s, c := slSetupCurveMarket(t)
		if _, err := Sell(s, "hodler", c, 2000, big.NewInt(11)); errSymbol(err) != ErrBalance {
			t.Fatalf("err = %v, want %s", err, ErrBalance)
		}
		if _, err := Sell(s, "stranger", c, 2000, big.NewInt(1)); errSymbol(err) != ErrBalance {
			t.Fatalf("stranger err = %v, want %s", err, ErrBalance)
		}
	})
	t.Run("frozen-rail-closed", func(t *testing.T) {
		s, c := slSetupCurveMarket(t)
		setU64(s, kPaidUntil(c), 2000)
		if _, err := Sell(s, "hodler", c, 2000+GraceBlocks, big.NewInt(1)); errSymbol(err) != ErrState {
			t.Fatalf("err = %v, want %s (curve rail closes at FROZEN; Refund opens)", err, ErrState)
		}
	})
	t.Run("closed-rail-closed", func(t *testing.T) {
		s, c := slSetupCurveMarket(t)
		setStr(s, kState(c), StateClosed)
		if _, err := Sell(s, "hodler", c, 2000, big.NewInt(1)); errSymbol(err) != ErrState {
			t.Fatalf("err = %v, want %s", err, ErrState)
		}
	})
	t.Run("overdue-rail-open", func(t *testing.T) {
		s, c := slSetupCurveMarket(t)
		setU64(s, kPaidUntil(c), 2000)
		if _, err := Sell(s, "hodler", c, 2100, big.NewInt(1)); err != nil {
			t.Fatalf("OVERDUE sell failed: %v — grace is fully functional", err)
		}
	})
}

// THE outflow rule, curve edition: the global pause must never block a Sell.
// This is the test that fails if anyone ever "simplifies" the rail switch
// into RequireInflowOpen (which also reads kPaused).
func TestSell_IgnoresGlobalPause(t *testing.T) {
	s, c := slSetupCurveMarket(t)
	setStr(s, kPaused(), "1")
	if _, err := Sell(s, "hodler", c, 2000, big.NewInt(5)); err != nil {
		t.Fatalf("Sell under global pause failed: %v — OUTFLOWS NEVER PAUSE", err)
	}
}

func TestSell_RejectedCallMutatesNothing(t *testing.T) {
	s, c := slSetupCurveMarket(t)
	before := hzSnapshotAll(s)
	if _, err := Sell(s, "hodler", c, 2000, big.NewInt(11)); errSymbol(err) != ErrBalance {
		t.Fatalf("expected balance rejection, got %v", err)
	}
	if changed := hzChangedKeys(before, hzSnapshotAll(s)); len(changed) != 0 {
		t.Fatalf("rejected Sell mutated state: %v", changed)
	}
}

// The corrupt-state solvency refusal + the rail pairing: a market whose
// reserve does NOT cover the curve area (unreachable through the shipped
// API — the PAR mint that used to create this state is deleted; simulated
// here by direct state corruption) must REFUSE curve sells rather than pay
// exact-slice proceeds out of the remaining holders' backing, and the
// holder's exit must still exist: wind-down (Retire → FROZEN → Refund) pays
// the honest pro-rata haircut of whatever is really there.
func TestSell_CorruptReserve_RefusedAndWindDownStillExits(t *testing.T) {
	s := NewMemStore()
	c := "creatora"
	setupMarket(s, c, 100, 1_000_000_000)
	if _, err := Buy(s, "victim", c, 200, big.NewInt(100)); err != nil {
		t.Fatal(err)
	}
	// Corrupt the reserve to half the area — a state no writer can produce.
	half := new(big.Int).Rsh(getMoney(s, kReserve(c)), 1)
	setMoney(s, kReserve(c), half)

	if _, err := Sell(s, "victim", c, 300, big.NewInt(10)); errSymbol(err) != ErrState {
		t.Fatalf("corrupt-reserve sell: err = %v, want %s — paying exact slices from an under-backed reserve robs the remaining holders", err, ErrState)
	}
	// The exit rail: the creator retires → the market is winding down (RULING
	// K3: inWindDown fires from the retire block) → Refund distributes what
	// actually remains, pro-rata, less the K2 wind-down tax.
	if err := Retire(s, c, c, 400); err != nil {
		t.Fatal(err)
	}
	const wdBlock = 400 + GraceBlocks // FROZEN (inWindDown either way); the property under test is unchanged
	// The victim owns the whole supply, so the GROSS pro-rata is the whole
	// remaining reserve (half). RULING K2 carves the victim's exit tax from it.
	gross := refundPayout(getMoney(s, kReserve(c)), big.NewInt(100), getMoney(s, kSupply(c)))
	wantNet := new(big.Int).Sub(gross, ExitTaxOn(gross, ExitTaxBpsAt(heldBlocksAt(s, c, "victim", wdBlock))))
	payout, err := Refund(s, "victim", c, wdBlock, big.NewInt(100))
	if err != nil {
		t.Fatalf("wind-down Refund on the corrupt market failed: %v — always-exitable broken", err)
	}
	if gross.Cmp(half) != 0 {
		t.Fatalf("gross full-position refund = %s, want the whole remaining reserve %s", gross, half)
	}
	if payout.Cmp(wantNet) != 0 {
		t.Fatalf("full-position refund net = %s, want %s (whole reserve %s − K2 tax)", payout, wantNet, half)
	}
}

func TestSell_RecordsPreTradeSpot_FirstWriterWins(t *testing.T) {
	slRequireCalibration(t)
	s, c := slSetupCurveMarket(t) // one obs already (buy at 1000, rate 1079)

	// A sell in a NEW block records spotRate(S_before) = spot(10) = 1079.
	rs, err := Sell(s, "hodler", c, 3000, big.NewInt(2))
	if err != nil {
		t.Fatal(err)
	}
	if rs.RateRecorded.Cmp(big.NewInt(1079)) != 0 {
		t.Fatalf("RateRecorded = %s, want 1079 (pre-trade marginal)", rs.RateRecorded)
	}
	if n := getU64(s, kObsIdx(c)); n != 2 {
		t.Fatalf("obs count = %d, want 2", n)
	}
	o, ok := readTwapObs(s, c, 1)
	if !ok || o.block != 3000 || o.rate.Cmp(big.NewInt(1079)) != 0 {
		t.Fatalf("obs[1] = {%d %s}, want {3000 1079}", o.block, o.rate)
	}

	// A second same-block trade offers a rate but the ring ignores it
	// (first-writer-per-block, twap.go's own contract).
	if _, err := Sell(s, "hodler", c, 3000, big.NewInt(2)); err != nil {
		t.Fatal(err)
	}
	if n := getU64(s, kObsIdx(c)); n != 2 {
		t.Fatalf("obs count after same-block sell = %d, want still 2", n)
	}
}

func TestQuoteSell_MatchesExecution_AndWritesNothing(t *testing.T) {
	s, c := slSetupCurveMarket(t)
	if _, err := Buy(s, "seller", c, 2000, big.NewInt(7)); err != nil {
		t.Fatal(err)
	}

	before := hzSnapshotAll(s)
	q, err := QuoteSell(s, "seller", c, 2500, big.NewInt(7))
	if err != nil {
		t.Fatal(err)
	}
	if changed := hzChangedKeys(before, hzSnapshotAll(s)); len(changed) != 0 {
		t.Fatalf("QuoteSell wrote state: %v", changed)
	}

	r, err := Sell(s, "seller", c, 2500, big.NewInt(7))
	if err != nil {
		t.Fatal(err)
	}
	if q.Gross.Cmp(r.Gross) != 0 || q.Tax.Cmp(r.Tax) != 0 || q.Net.Cmp(r.Net) != 0 ||
		q.TaxBps != r.TaxBps {
		t.Fatalf("quote/execution drift: quote {p %s tax %s net %s τ%d} vs exec {p %s tax %s net %s τ%d}",
			q.Gross, q.Tax, q.Net, q.TaxBps, r.Gross, r.Tax, r.Net, r.TaxBps)
	}
}

// net >= 0 across the whole tax schedule and dust proceeds — the file-header
// proof of sell.go, exercised: tax + fee can never exceed the slice.
func TestSell_NetNeverNegative_Property(t *testing.T) {
	r := rand.New(rand.NewSource(7))
	for i := 0; i < 400; i++ {
		s := NewMemStore()
		c := "creatora"
		setupMarket(s, c, 100, MaxCap)
		block := uint64(1000)
		setU64(s, kPaidUntil(c), block+200*SubscriptionPeriod)
		n := big.NewInt(int64(r.Intn(50) + 1))
		if _, err := Buy(s, "h", c, block, n); err != nil {
			t.Fatal(err)
		}
		sellBlock := block + uint64(r.Int63n(int64(ExitTaxDecayBlocks)))
		dS := big.NewInt(int64(r.Intn(int(n.Int64()))) + 1)
		rs, err := Sell(s, "h", c, sellBlock, dS)
		if err != nil {
			t.Fatal(err)
		}
		if rs.Net.Sign() < 0 {
			t.Fatalf("negative net: p %s tax %s fee %s (τ=%d)", rs.Gross, rs.Tax, rs.Fee, rs.TaxBps)
		}
		slAssertSplits(t, rs)
	}
}

// ---------------------------------------------------------------------------
// THE GOVERNING THEOREM, END-TO-END through the real API: a fresh buyer of
// any n, at any prior market shape, holding for any time, exits at a flat
// pro-rata wind-down (Retire → FROZEN → Refund of the whole position) with
// payout <= curve cost < total paid. This is the property the entire RULING
// A/I/J architecture exists to guarantee; curve_test.go pins the same
// arithmetic on the pure primitive.
// ---------------------------------------------------------------------------

func TestGoverningTheorem_EndToEnd_FreshBuyerNeverProfitsAtWindDown(t *testing.T) {
	r := rand.New(rand.NewSource(20260721))
	for i := 0; i < 150; i++ {
		s := NewMemStore()
		c := "creatora"
		setupMarket(s, c, 100, MaxCap)
		block := uint64(1000)
		setU64(s, kPaidUntil(c), block+100*SubscriptionPeriod)

		// Random prior market shape: background buys, sometimes partial
		// background sells (which keep R === area(S) exactly either way).
		if pre := r.Intn(3000); pre > 0 {
			if _, err := Buy(s, "background", c, block, big.NewInt(int64(pre))); err != nil {
				t.Fatal(err)
			}
			if r.Intn(2) == 0 && pre > 1 {
				if _, err := Sell(s, "background", c, block, big.NewInt(int64(r.Intn(pre-1)+1))); err != nil {
					t.Fatal(err)
				}
			}
		}

		// The fresh buyer.
		n := big.NewInt(int64(r.Intn(500) + 1))
		block += 10
		rb, err := Buy(s, "fresh", c, block, n)
		if err != nil {
			t.Fatal(err)
		}

		// Any wait (0 .. beyond the decay window), then the market winds
		// down and the buyer refunds their whole position pro-rata.
		block += uint64(r.Int63n(int64(ExitTaxDecayBlocks * 2)))
		setU64(s, kPaidUntil(c), block+SubscriptionPeriod) // keep alive until the retire
		if err := Retire(s, c, c, block); err != nil {
			t.Fatal(err)
		}
		// RULING D: the wind-down rail opens at retiredAt+GraceBlocks (the
		// five-day notice), not on the retire block itself.
		payout, err := Refund(s, "fresh", c, block+GraceBlocks, n)
		if err != nil {
			t.Fatalf("wind-down refund: %v", err)
		}
		// payout <= curve cost (the theorem) < TotalDue (cost + buy fee).
		if payout.Cmp(rb.Cost) > 0 {
			t.Fatalf("GOVERNING THEOREM VIOLATED end-to-end: fresh buyer of %s paid curve cost %s, wind-down returned %s",
				n, rb.Cost, payout)
		}
	}
}

// ---------------------------------------------------------------------------
// The randomized-sequence property suite: the equality invariant after every
// op, exact reserve ledger, I3, treasury ledger (RULING J), ledger
// conservation (global solvency), basis self-cleaning, clock bounds, fee
// conservation. Coverage-gated so the J1 cap regimes are provably exercised.
// ---------------------------------------------------------------------------

func TestSellBuy_Property_EqualityLedgerTreasury(t *testing.T) {
	r := rand.New(rand.NewSource(2026))
	holders := []string{"alice", "bob", "carol"}
	rateBinding, zeroTax := 0, 0

	for iter := 0; iter < 30; iter++ {
		s := NewMemStore()
		c := "creatora"
		setupMarket(s, c, 100, MaxCap)
		block := uint64(r.Intn(10000) + 1)
		// Keep the subscription alive for the whole run: the suite tests the
		// trading phase; wind-down rails have their own suite (refund_test).
		setU64(s, kPaidUntil(c), block+100*SubscriptionPeriod)

		sumCosts := mZero() // Σ buyCost   (curve legs in)
		sumGross := mZero() // Σ p         (curve legs out)
		sumFees := mZero()  // Σ fees both directions
		sumTax := mZero()   // Σ assessed tax — ALL of it to the treasury (J)
		treasury0 := getMoney(s, kTreasury())

		for op := 0; op < 300; op++ {
			block += uint64(r.Intn(int(ExitTaxDecayBlocks/10)) + 1)
			h := holders[r.Intn(len(holders))]
			reserveBefore := getMoney(s, kReserve(c))

			switch r.Intn(5) {
			case 0, 1, 2: // buy
				n := big.NewInt(int64(r.Intn(500) + 1))
				rb, err := Buy(s, h, c, block, n)
				if err != nil {
					t.Fatalf("iter %d op %d Buy: %v", iter, op, err)
				}
				sumCosts = mAdd(sumCosts, rb.Cost)
				sumFees = mAdd(sumFees, rb.Fee)
				// C-19 buy side: ΔR == +cost exactly.
				if getMoney(s, kReserve(c)).Cmp(mAdd(reserveBefore, rb.Cost)) != 0 {
					t.Fatalf("C-19 violated on buy: ΔR != cost")
				}
			default: // sell
				bal := getMoney(s, kBal(c, h))
				if bal.Sign() == 0 {
					continue
				}
				deltaS := new(big.Int).Rand(r, bal)
				deltaS.Add(deltaS, big.NewInt(1))
				if deltaS.Cmp(bal) > 0 {
					deltaS.Set(bal)
				}
				rs, err := Sell(s, h, c, block, deltaS)
				if err != nil {
					t.Fatalf("iter %d op %d Sell(%s): %v", iter, op, deltaS, err)
				}
				slAssertSplits(t, rs)
				sumGross = mAdd(sumGross, rs.Gross)
				sumFees = mAdd(sumFees, rs.Fee)
				sumTax = mAdd(sumTax, rs.Tax)
				// K1 regime coverage bookkeeping: the tax is EXACTLY the gross
				// rate (no cap), so a sale is either taxed (τ > 0) or free
				// (fully decayed). slAssertSplits already pins tax == rate.
				if rs.Tax.Sign() > 0 {
					rateBinding++
				} else {
					zeroTax++
				}
				// C-19 sell side: ΔR == −p exactly — the tax and fee never
				// touch the reserve.
				if getMoney(s, kReserve(c)).Cmp(new(big.Int).Sub(reserveBefore, rs.Gross)) != 0 {
					t.Fatalf("C-19 violated on sell: ΔR != −p")
				}
			}

			// ---- after EVERY op ----
			supply := getMoney(s, kSupply(c))
			reserve := getMoney(s, kReserve(c))
			// THE invariant (C-9, RULING A): R === area(S), EQUALITY.
			if reserve.Cmp(Area(supply)) != 0 {
				t.Fatalf("iter %d op %d: EQUALITY violated: R %s != area(%s) %s", iter, op, reserve, supply, Area(supply))
			}
			// C-7: R == Σcost − Σgross exactly — no other reserve writers.
			if reserve.Cmp(new(big.Int).Sub(sumCosts, sumGross)) != 0 {
				t.Fatalf("C-7 violated: R %s != Σcost−Σgross", reserve)
			}
			// C-8 / I3 (no escrow in this suite): S == Σ balances.
			if supply.Cmp(sumBalances(s, c)) != 0 {
				t.Fatalf("C-8 violated: S %s != Σ bal %s", supply, sumBalances(s, c))
			}
			// RULING J treasury ledger: Δtreasury == Σtax + Σplatform fee
			// halves; kFeeBal(c) == Σcreator halves. Together: every skimmed
			// unit is in exactly one pull pot, and the whole tax is in the
			// treasury.
			pots := mAdd(getMoney(s, kFeeBal(c)), new(big.Int).Sub(getMoney(s, kTreasury()), treasury0))
			if pots.Cmp(mAdd(sumFees, sumTax)) != 0 {
				t.Fatalf("fee/tax conservation violated: pots %s != Σfees+Σtax %s", pots, mAdd(sumFees, sumTax))
			}
			// GLOBAL SOLVENCY: everything the contract holds equals
			// everything that came in minus everything paid out.
			// in − out = Σ(cost+fee_b) − Σ(p − tax − fee_s)
			//          = (Σcost − Σp) + Σfees + Σtax = R + Σfees + Σtax.
			holdings := mAdd(reserve, pots)
			flows := new(big.Int).Sub(mAdd(sumCosts, sumFees), sumGross)
			flows = mAdd(flows, sumTax)
			if holdings.Cmp(flows) != 0 {
				t.Fatalf("GLOBAL SOLVENCY violated: holdings %s != Σin−Σout %s", holdings, flows)
			}
			// Basis self-cleaning + clock bound, per holder.
			for _, hh := range holders {
				if w := holderAcqBlock(s, c, hh); w > block {
					t.Fatalf("C-13 violated: wacq %d > block %d", w, block)
				}
			}
		}
	}
	// ANTI-VACUITY: both K1 regimes must occur (taxed and fully-decayed).
	if rateBinding < 50 || zeroTax < 20 {
		t.Fatalf("VACUOUS FUZZ: taxed %d, zero-rate %d — the generator stopped reaching a tax regime",
			rateBinding, zeroTax)
	}
	t.Logf("K1 regime coverage: taxed %d, zero-rate %d", rateBinding, zeroTax)
}

// No free money through any single buy→sell round trip, at any hold length:
// net received <= total paid — with L5's exact equality on the curve leg and
// no third-party buys in between, the trip's realized gain is never positive
// (so under J1 the tax is usually 0) and the entire loss is the fees.
func TestSell_RoundTripNeverProfits_Property(t *testing.T) {
	r := rand.New(rand.NewSource(31337))
	for i := 0; i < 200; i++ {
		s := NewMemStore()
		c := "creatora"
		setupMarket(s, c, 100, MaxCap)
		// Random pre-existing curve depth.
		block := uint64(1000)
		setU64(s, kPaidUntil(c), block+200*SubscriptionPeriod)
		if pre := r.Intn(2000); pre > 0 {
			if _, err := Buy(s, "background", c, block, big.NewInt(int64(pre))); err != nil {
				t.Fatal(err)
			}
		}

		n := big.NewInt(int64(r.Intn(500) + 1))
		block += 10
		rb, err := Buy(s, "tripper", c, block, n)
		if err != nil {
			t.Fatal(err)
		}
		// Sell the whole position after a random hold (0 .. beyond decay).
		block += uint64(r.Intn(int(ExitTaxDecayBlocks * 3 / 2)))
		rs, err := Sell(s, "tripper", c, block, n)
		if err != nil {
			t.Fatal(err)
		}
		if rs.Net.Cmp(rb.TotalDue) > 0 {
			t.Fatalf("free money: bought %s for %s, sold back for %s (held %d)", n, rb.TotalDue, rs.Net, rs.HeldBlocks)
		}
	}
}
