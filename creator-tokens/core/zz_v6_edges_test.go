package core

import (
	"math/big"
	"testing"
)

// v6 edge cases and failure states (spec MERITUM-V6-FRACTIONAL-TOKENS §3),
// each pinned to the contract's own numbers.

func v6Market(t *testing.T, c string, block uint64) Store {
	t.Helper()
	s := NewMemStore()
	setStr(s, kOwner(), "hive:platform")
	if err := Register(s, c, c, block, 1000, MaxCap); err != nil {
		t.Fatalf("register: %v", err)
	}
	return WrapUnits(s)
}

// §3.1 — a buy of 0.00 is refused; 0.01 on an empty market costs 10 + the
// one-base-unit minimum fee = 11; the first whole token is still 1007 + 50.
func TestV6Edge_FirstUnitAndFirstToken(t *testing.T) {
	s := v6Market(t, "hive:c", 100)
	if _, err := Buy(s, "hive:b", "hive:c", 101, big.NewInt(0)); err == nil {
		t.Fatal("buy of 0.00 accepted")
	}
	r, err := Buy(s, "hive:b", "hive:c", 101, big.NewInt(1))
	if err != nil {
		t.Fatalf("buy 0.01: %v", err)
	}
	if r.Cost.Cmp(big.NewInt(10)) != 0 || r.Fee.Cmp(big.NewInt(1)) != 0 || r.TotalDue.Cmp(big.NewInt(11)) != 0 {
		t.Fatalf("0.01 on an empty market = %s + %s = %s, want 10 + 1 = 11", r.Cost, r.Fee, r.TotalDue)
	}
	if Reserve(s, "hive:c").Cmp(Area(big.NewInt(1))) != 0 || Supply(s, "hive:c").Cmp(big.NewInt(1)) != 0 {
		t.Fatalf("reserve %s supply %s after the first unit", Reserve(s, "hive:c"), Supply(s, "hive:c"))
	}
	s2 := v6Market(t, "hive:c", 100)
	r2, err := Buy(s2, "hive:b", "hive:c", 101, tk(1))
	if err != nil {
		t.Fatalf("buy 1.00: %v", err)
	}
	if r2.Cost.Cmp(big.NewInt(1007)) != 0 || r2.Fee.Cmp(big.NewInt(50)) != 0 || r2.TotalDue.Cmp(big.NewInt(1057)) != 0 {
		t.Fatalf("1.00 on an empty market = %s/%s/%s, want 1007/50/1057", r2.Cost, r2.Fee, r2.TotalDue)
	}
}

// §3.2 — selling the market down one unit at a time drains the reserve to
// exactly Area(0) = 0, every dust sale pays at least one base unit of fee, and
// the market closes at supply 0 once it is winding down.
func TestV6Edge_SellTheLastUnit(t *testing.T) {
	const c, h = "hive:c", "hive:h"
	s := v6Market(t, c, 100)
	if _, err := Buy(s, h, c, 101, big.NewInt(3)); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		r, err := Sell(s, h, c, 102+uint64(i), big.NewInt(1))
		if err != nil {
			t.Fatalf("unit sale %d: %v", i, err)
		}
		if r.Fee.Cmp(big.NewInt(MinFeeBaseUnits)) < 0 {
			t.Fatalf("unit sale %d fee %s below the minimum", i, r.Fee)
		}
		if mAdd(mAdd(r.Net, r.Tax), r.Fee).Cmp(r.Gross) != 0 {
			t.Fatalf("unit sale %d legs %s+%s+%s != %s", i, r.Net, r.Tax, r.Fee, r.Gross)
		}
	}
	if Supply(s, c).Sign() != 0 || Reserve(s, c).Sign() != 0 {
		t.Fatalf("after the last unit: supply %s reserve %s, want 0/0", Supply(s, c), Reserve(s, c))
	}
	if _, err := Sell(s, h, c, 110, big.NewInt(1)); err == nil {
		t.Fatal("selling from an empty position accepted")
	}
	if err := Retire(s, c, c, 111); err != nil {
		t.Fatalf("retire: %v", err)
	}
	if CloseIfDrained(s, c, 112) {
		t.Fatal("CloseIfDrained fired inside the retire notice window")
	}
	if !CloseIfDrained(s, c, 111+GraceBlocks+1) {
		t.Fatal("CloseIfDrained must fire at supply 0 once the notice window has passed")
	}
}

// §3.3 / §3.4 — an ask that settles to a single unit: commission floors to 0,
// maxCredits is compared in units (one unit short is refused), and a miss keeps
// the whole 0.01 (the deterrent floor clamps to the escrow).
func TestV6Edge_OneUnitAsk_CommissionZero_MissKeepsAll(t *testing.T) {
	const c, a = "hive:c", "hive:asker"
	raw := NewMemStore()
	setStr(raw, kOwner(), "hive:platform")
	if err := Register(raw, c, c, 100, MinFace, MaxCap); err != nil {
		t.Fatal(err)
	}
	s := WrapUnits(raw)
	// Push the curve until one whole token is worth >= 100 x face, so that
	// ceil(face x 100 / rate) == 1 unit.
	S := int64(1000)
	for SpotRate(tk(S)).Cmp(big.NewInt(100*MinFace)) < 0 {
		S *= 2
		if S > MaxCap/TokenScale {
			t.Fatal("curve never reaches 100 x MinFace per token")
		}
	}
	setMoney(s, kSupply(c), tk(S))
	setMoney(s, kReserve(c), Area(tk(S)))
	if _, err := Buy(s, a, c, 101, big.NewInt(1)); err != nil {
		t.Fatalf("buy one unit: %v", err)
	}
	q, err := SettleSpend(s, c, 102, big.NewInt(MinFace))
	if err != nil {
		t.Fatalf("settle: %v", err)
	}
	if q.Credits.Cmp(big.NewInt(1)) != 0 {
		t.Fatalf("credits for MinFace at rate %s = %s, want 1 unit", q.Rate, q.Credits)
	}
	if _, err := Ask(s, a, c, 102, big.NewInt(0), "ask-one-unit", MinAskDeadline, 0); err == nil {
		t.Fatal("maxCredits 0 must refuse a 1-unit ask")
	}
	ar, err := Ask(s, a, c, 102, big.NewInt(1), "ask-one-unit", MinAskDeadline, 0)
	if err != nil {
		t.Fatalf("ask: %v", err)
	}
	if ar.CreditsSpent.Cmp(big.NewInt(1)) != 0 || ar.CommissionCredits.Sign() != 0 {
		t.Fatalf("ask spent %s with commission %s, want 1 and 0", ar.CreditsSpent, ar.CommissionCredits)
	}
	if BalanceOf(s, c, a).Sign() != 0 {
		t.Fatalf("asker still holds %s", BalanceOf(s, c, a))
	}
	rc, err := Reclaim(s, "hive:anyone", c, 102+MinAskDeadline+ReclaimGrace+1, ar.Seq)
	if err != nil {
		t.Fatalf("reclaim: %v", err)
	}
	if rc.CreditsReturned.Sign() != 0 || rc.CommissionRetainedCredits.Cmp(big.NewInt(1)) != 0 {
		t.Fatalf("miss on a 0.01 ask returned %s, retained %s; want 0 / 1 (floor clamps to the escrow)", rc.CreditsReturned, rc.CommissionRetainedCredits)
	}
}

// §3.5 — transferring 0.01 out of a 100.00 two-cohort position moves it from
// the freshest cohort with its clock; the recipient's matured bucket is untouched.
func TestV6Edge_TransferOneUnitFreshestFirst(t *testing.T) {
	const c, h, r = "hive:c", "hive:h", "hive:r"
	s := v6Market(t, c, 100)
	if _, err := Buy(s, h, c, 200, tk(60)); err != nil {
		t.Fatal(err)
	}
	if _, err := Buy(s, h, c, 1200, tk(40)); err != nil {
		t.Fatal(err)
	}
	if err := TransferCredits(s, h, c, h, r, 1300, big.NewInt(1)); err != nil {
		t.Fatalf("transfer 0.01: %v", err)
	}
	hl := getLots(s, c, h)
	if len(hl) != 2 || hl[0].count.Cmp(big.NewInt(3999)) != 0 || hl[0].acq != 1200 || hl[1].count.Cmp(tk(60)) != 0 || hl[1].acq != 200 {
		t.Fatalf("sender lots = %+v, want 39.99@1200 + 60.00@200", hl)
	}
	rl := getLots(s, c, r)
	if len(rl) != 1 || rl[0].count.Cmp(big.NewInt(1)) != 0 || rl[0].acq != 1200 {
		t.Fatalf("recipient lots = %+v, want 0.01@1200", rl)
	}
	if MaturedOf(s, c, r).Sign() != 0 || BalanceOf(s, c, h).Cmp(big.NewInt(9999)) != 0 {
		t.Fatalf("matured[r]=%s balance[h]=%s", MaturedOf(s, c, r), BalanceOf(s, c, h))
	}
	if _, err := Sell(s, h, c, 1301, big.NewInt(10000)); err == nil {
		t.Fatal("selling more than held accepted")
	}
}

// §3.8 — a PENDING escrow written before the update (9 fields, credits "1")
// is answered, declined and reclaimed after it: the creator is credited 1.00
// token, the asker gets 1.00 back, and a miss keeps 1.00 (the floor).
func TestV6Edge_LegacyEscrowAnsweredDeclinedReclaimed(t *testing.T) {
	answer := func() {
		_, s := legacyMarket(t)
		before := totalBalance(s, v6c, v6c)
		an, err := Answer(s, v6c, v6c, 20000, 0, "ans-legacy")
		if err != nil {
			t.Fatalf("answer legacy escrow: %v", err)
		}
		if an.CreditsToCreator.Cmp(tk(1)) != 0 || an.CommissionToOwner.Sign() != 0 {
			t.Fatalf("answer credited %s with commission %s, want 100 / 0", an.CreditsToCreator, an.CommissionToOwner)
		}
		if totalBalance(s, v6c, v6c).Cmp(mAdd(before, tk(1))) != 0 {
			t.Fatalf("creator balance after answer = %s", totalBalance(s, v6c, v6c))
		}
	}
	// The fixture's escrow left from the MATURED bucket (em leg "1" = the whole
	// token): a decline puts 1.00 back into the asker's matured bucket and the
	// maturing cohort is untouched.
	declineMaturedLeg := func() {
		_, s := legacyMarket(t)
		dr, err := Decline(s, v6c, v6c, 20000, 0)
		if err != nil {
			t.Fatalf("decline legacy escrow: %v", err)
		}
		if dr.CreditsReturned.Cmp(tk(1)) != 0 || BalanceOf(s, v6c, v6o).Cmp(tk(2)) != 0 || MaturedOf(s, v6c, v6o).Cmp(tk(1)) != 0 {
			t.Fatalf("decline returned %s; asker total %s matured %s (want 100 / 200 / 100)", dr.CreditsReturned, BalanceOf(s, v6c, v6o), MaturedOf(s, v6c, v6o))
		}
		if lots := getLots(s, v6c, v6o); len(lots) != 1 || lots[0].count.Cmp(tk(1)) != 0 || lots[0].acq != 1900 {
			t.Fatalf("maturing cohort disturbed by a matured-leg return: %+v", lots)
		}
	}
	// The same escrow with a MATURING leg (no em record): the returned token
	// re-enters the ledger as its own cohort with the escrow's clock (1300),
	// next to the asker's legacy cohort (1900).
	declineMaturingLeg := func() {
		raw, s := legacyMarket(t)
		raw.Delete(kEscrowMaturedLeg(v6c, 0))
		dr, err := Decline(s, v6c, v6c, 20000, 0)
		if err != nil {
			t.Fatalf("decline legacy escrow (maturing leg): %v", err)
		}
		if dr.CreditsReturned.Cmp(tk(1)) != 0 || MaturingOf(s, v6c, v6o).Cmp(tk(2)) != 0 || MaturedOf(s, v6c, v6o).Sign() != 0 {
			t.Fatalf("maturing-leg decline: returned %s maturing %s matured %s", dr.CreditsReturned, MaturingOf(s, v6c, v6o), MaturedOf(s, v6c, v6o))
		}
		lots := getLots(s, v6c, v6o)
		if len(lots) != 2 || lots[0].acq != 1900 || lots[1].acq != 1300 || lots[1].count.Cmp(tk(1)) != 0 {
			t.Fatalf("returned cohort lost the escrow's clock: %+v", lots)
		}
	}
	reclaim := func() {
		_, s := legacyMarket(t)
		if _, err := Reclaim(s, "hive:anyone", v6c, 30000+ReclaimGrace, 0); err == nil {
			t.Fatal("reclaim inside the grace window accepted")
		}
		rc, err := Reclaim(s, "hive:anyone", v6c, 30000+ReclaimGrace+1, 0)
		if err != nil {
			t.Fatalf("reclaim legacy escrow: %v", err)
		}
		if rc.CreditsReturned.Sign() != 0 || rc.CommissionRetainedCredits.Cmp(tk(1)) != 0 {
			t.Fatalf("miss on a legacy 1-token ask returned %s, retained %s; want 0 / 100", rc.CreditsReturned, rc.CommissionRetainedCredits)
		}
	}
	answer()
	declineMaturedLeg()
	declineMaturingLeg()
	reclaim()
}

// §3.11 — a 0.01 buy records the spot rate of the token it lands in, the same
// observation a whole-token buy would record at that boundary; dust buys in one
// block cannot add observations beyond the ring's spacing rule.
func TestV6Edge_DustBuysAndTheOracleRing(t *testing.T) {
	const c = "hive:c"
	a := v6Market(t, c, 100)
	b := v6Market(t, c, 100)
	ra, err := Buy(a, "hive:x", c, 150, big.NewInt(1))
	if err != nil {
		t.Fatal(err)
	}
	rb, err := Buy(b, "hive:x", c, 150, tk(1))
	if err != nil {
		t.Fatal(err)
	}
	if ra.RateRecorded.Cmp(rb.RateRecorded) != 0 || ra.RateRecorded.Cmp(SpotRate(tk(1))) != 0 {
		t.Fatalf("dust buy recorded %s, whole-token buy %s, spot(1) %s", ra.RateRecorded, rb.RateRecorded, SpotRate(tk(1)))
	}
	n0 := getU64(a, kObsIdx(c))
	for i := 0; i < 50; i++ {
		if _, err := Buy(a, "hive:x", c, 150, big.NewInt(1)); err != nil {
			t.Fatal(err)
		}
	}
	if n1 := getU64(a, kObsIdx(c)); n1 != n0 {
		t.Fatalf("50 same-block dust buys grew the ring from %d to %d observations", n0, n1)
	}
}

// §3.12 — splitting a sale into unit sales is never cheaper: the curve slice
// is path-independent and every unit sale pays the one-base-unit fee floor.
func TestV6Edge_SplitSalesNeverCheaper(t *testing.T) {
	const c, h = "hive:c", "hive:h"
	whole := v6Market(t, c, 100)
	split := v6Market(t, c, 100)
	for _, s := range []Store{whole, split} {
		if _, err := Buy(s, h, c, 200, tk(10)); err != nil {
			t.Fatal(err)
		}
	}
	rw, err := Sell(whole, h, c, 300, tk(1))
	if err != nil {
		t.Fatal(err)
	}
	gross, fee, tax := mZero(), mZero(), mZero()
	for i := 0; i < int(TokenScale); i++ {
		r, err := Sell(split, h, c, 300, big.NewInt(1))
		if err != nil {
			t.Fatalf("unit sale %d: %v", i, err)
		}
		gross, fee, tax = mAdd(gross, r.Gross), mAdd(fee, r.Fee), mAdd(tax, r.Tax)
	}
	if gross.Cmp(rw.Gross) != 0 {
		t.Fatalf("split gross %s != whole gross %s (path independence)", gross, rw.Gross)
	}
	if fee.Cmp(rw.Fee) < 0 || fee.Cmp(big.NewInt(TokenScale*MinFeeBaseUnits)) < 0 {
		t.Fatalf("split fee %s < whole fee %s or below the %d floor", fee, rw.Fee, TokenScale*MinFeeBaseUnits)
	}
	if tax.Cmp(rw.Tax) < 0 {
		t.Fatalf("split tax %s < whole tax %s (ceil per sale can never under-charge)", tax, rw.Tax)
	}
	if Reserve(split, c).Cmp(Reserve(whole, c)) != 0 || Supply(split, c).Cmp(Supply(whole, c)) != 0 {
		t.Fatal("the two markets diverged")
	}
}

// §3.7 / §3.13 — cap bounds in units and the top of the range.
func TestV6Edge_CapBoundsAndOverflow(t *testing.T) {
	const c = "hive:c"
	s := v6Market(t, c, 100)
	if err := SetCap(s, c, c, 101, MinCap-1); err == nil {
		t.Fatal("cap of 0.99 accepted")
	}
	if err := SetCap(s, c, c, 101, MaxCap+1); err == nil {
		t.Fatal("cap above MaxCap accepted")
	}
	raw := NewMemStore()
	setStr(raw, kOwner(), "hive:platform")
	if err := Register(raw, "hive:d", "hive:d", 100, 1000, MaxCap+1); err == nil {
		t.Fatal("register with cap above MaxCap accepted")
	}
	if err := SetCap(s, c, c, 101, MinCap); err != nil {
		t.Fatalf("cap of exactly 1.00: %v", err)
	}
	if _, err := Buy(s, "hive:b", c, 102, big.NewInt(MinCap+1)); err == nil {
		t.Fatal("buy past the cap accepted")
	}
	if _, err := Buy(s, "hive:b", c, 102, big.NewInt(MinCap)); err != nil {
		t.Fatalf("buy up to the cap: %v", err)
	}
	top := big.NewInt(MaxCap)
	if Area(top).Sign() <= 0 || BuyCost(new(big.Int).Sub(top, big.NewInt(1)), big.NewInt(1)).Sign() <= 0 {
		t.Fatal("curve degenerates at MaxCap units")
	}
	if p, _ := SellProceeds(top, big.NewInt(1)); p.Sign() <= 0 {
		t.Fatal("sell at MaxCap degenerates")
	}
}
