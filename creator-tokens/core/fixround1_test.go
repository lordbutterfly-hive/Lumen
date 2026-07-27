package core

import (
	"math/big"
	"math/rand"
	"os"
	"strings"
	"testing"
)

// fixround1_test.go — named regression tests for adversarial FIX ROUND 1
// (2026-07-21/22). One test per finding id, each reproducing the defect and
// asserting the fix at the real compiled integers.
//
//	ET-1  chunk-dodge (was: of the realized-gain cap; RULING K1 removes the
//	      cap, so the dodge is closed structurally by gross tax + ceil)
//	ET-2  unanswered escrow re-ages the asker's clock  -> escrowRec acqBlock
//	SET-1 short TWAP ring evicts its own history       -> ShortObsSpacing
//	SET-2 C4 floor contradicts MinFace / rises w/ price -> MinFace=500 + ServiceFaceRange
//	SET-3 spend cap unsatisfiable below supply 20       -> credits>1 guard
//	THM-1 retire/lapse notice window bank run           -> RULING K3 (curve rail dropped)
//	ET-3  (REMOVED with the RULING-J1 cap — no sub-rate band exists any more)

// ---------------------------------------------------------------------------
// ET-1 — chunking a dump must never pay LESS exit tax than a single sale.
// RULING K1 (2026-07-22) reverses J1's realized-gain cap, so the tax is now
// GROSS proceeds × τ with NO cap and NO episode accounting: the anti-dodge
// property is a free consequence of ceil superadditivity + curve-leg path-
// independence (Σ ceil(pᵢ·τ) >= ceil(Σpᵢ·τ)). A split pays AT LEAST the
// single-sale tax, over by at most the ceil dust (< 1 base unit per extra
// tranche) — the 45–68% under-payment the CAP allowed is gone. This is the
// regression the task requires: "two same-block Sells pay the same total tax
// as one" (equal within ceil dust, never less).
// ---------------------------------------------------------------------------

func TestSell_ChunkingCannotEvade(t *testing.T) {
	// dumpTax runs "whale buys W, fans buy F, whale dumps W as `splits`" in one
	// block (τ constant) and returns the total exit tax.
	dumpTax := func(t *testing.T, W, F int64, splits []int64) *big.Int {
		t.Helper()
		s := NewMemStore()
		c := "crea"
		if err := Register(s, c, c, 1000, 1000, 1_000_000_000); err != nil {
			t.Fatal(err)
		}
		if _, err := Buy(s, "whale", c, 1000, big.NewInt(W)); err != nil {
			t.Fatal(err)
		}
		if _, err := Buy(s, "fans", c, 1000, big.NewInt(F)); err != nil {
			t.Fatal(err)
		}
		tax := mZero()
		for _, k := range splits {
			r, err := Sell(s, "whale", c, 1000, big.NewInt(k))
			if err != nil {
				t.Fatalf("W=%d F=%d split %d: %v", W, F, k, err)
			}
			if r.Net.Sign() < 0 {
				t.Fatalf("negative net %s on a tranche of %d", r.Net, k)
			}
			tax = mAdd(tax, r.Tax)
		}
		return tax
	}

	// The measured worst cases from the ET-1 finding. Under the J1 cap each
	// two-way split cut the tax 45–68%; under K1's gross tax a 2-tranche split
	// pays the single-sale total, over by at most 1 base unit (one ceil), NEVER
	// less. (W=10000/F=500 was the 67.62% dodge: 177,200,625 -> 57,375,816.)
	cases := []struct {
		W, F  int64
		split int64
	}{
		{1000, 200, 375},
		{5000, 800, 1360},
		{10000, 500, 825},
		{200, 100, 75},
	}
	for _, c := range cases {
		single := dumpTax(t, c.W, c.F, []int64{c.W})
		two := dumpTax(t, c.W, c.F, []int64{c.split, c.W - c.split})
		if two.Cmp(single) < 0 {
			t.Fatalf("W=%d F=%d: 2-tranche tax %s < single-shot %s — a split EVADED (dodge reopened)",
				c.W, c.F, two, single)
		}
		if new(big.Int).Sub(two, single).Cmp(big.NewInt(1)) > 0 { // 2 tranches -> at most 1 ceil-dust unit
			t.Fatalf("W=%d F=%d: 2-tranche tax %s exceeds single-shot %s by more than 1 dust unit",
				c.W, c.F, two, single)
		}
	}

	// Exhaustive split scan on the strongest case: NO split beats the single
	// sale, at any tranche count or split point.
	W, F := int64(10000), int64(500)
	single := dumpTax(t, W, F, []int64{W})
	for _, first := range []int64{1, 100, 825, 1000, 2500, 5000, 7500, 9999} {
		two := dumpTax(t, W, F, []int64{first, W - first})
		if two.Cmp(single) < 0 {
			t.Fatalf("split (%d,%d) paid %s < single %s — a split evaded", first, W-first, two, single)
		}
	}
	// Many-tranche even split: still >= single (dodge closed), and within the
	// ceil-dust bound of one unit per extra tranche.
	even := make([]int64, 0, 100)
	for i := 0; i < 100; i++ {
		even = append(even, W/100)
	}
	got := dumpTax(t, W, F, even)
	if got.Cmp(single) < 0 {
		t.Fatalf("100-tranche even split paid %s < single %s", got, single)
	}
	if new(big.Int).Sub(got, single).Cmp(big.NewInt(100)) > 0 { // <= (tranches-1) dust
		t.Fatalf("100-tranche split %s exceeds single %s by more than the ceil-dust bound", got, single)
	}

	// The single-sale tax is the FULL gross rate (RULING K1 identity), not the
	// dodged fraction: q.Tax == ExitTaxOn(q.Gross, τ), exactly.
	s := NewMemStore()
	c := "crea2"
	if err := Register(s, c, c, 1000, 1000, 1_000_000_000); err != nil {
		t.Fatal(err)
	}
	Buy(s, "a", c, 1000, big.NewInt(100))
	Buy(s, "b", c, 1000, big.NewInt(100))
	q, _ := QuoteSell(s, "a", c, 1001, big.NewInt(100))
	if q.Tax.Cmp(ExitTaxOn(q.Gross, q.TaxBps)) != 0 {
		t.Fatalf("single sale tax %s != ExitTaxOn(gross %s, %d) — the gross tax has no cap", q.Tax, q.Gross, q.TaxBps)
	}
}

// TestSell_ET1_Fuzz_ChunkNeverBeatsSingle — random markets, random dumps,
// random splits: a split NEVER pays less exit tax than the single sale, and
// net is never negative.
func TestSell_ET1_Fuzz_ChunkNeverBeatsSingle(t *testing.T) {
	r := rand.New(rand.NewSource(20260722))
	for iter := 0; iter < 400; iter++ {
		W := int64(r.Intn(8000) + 50)
		F := int64(r.Intn(4000)) // fan inflow may be 0 (pure loss dump)
		run := func(splits []int64) *big.Int {
			s := NewMemStore()
			c := "c"
			if err := Register(s, c, c, 1000, 1000, 1_000_000_000); err != nil {
				t.Fatal(err)
			}
			Buy(s, "w", c, 1000, big.NewInt(W))
			if F > 0 {
				Buy(s, "f", c, 1000, big.NewInt(F))
			}
			tax := mZero()
			for _, k := range splits {
				res, err := Sell(s, "w", c, 1000, big.NewInt(k))
				if err != nil {
					t.Fatalf("iter %d: sell %d of W=%d: %v", iter, k, W, err)
				}
				if res.Net.Sign() < 0 {
					t.Fatalf("iter %d: negative net %s", iter, res.Net)
				}
				tax = mAdd(tax, res.Tax)
			}
			return tax
		}
		single := run([]int64{W})
		// a random split point
		cut := int64(r.Intn(int(W-1))) + 1
		two := run([]int64{cut, W - cut})
		if two.Cmp(single) < 0 {
			t.Fatalf("iter %d W=%d F=%d cut=%d: split tax %s < single %s — DODGE", iter, W, F, cut, two, single)
		}
	}
}

// ---------------------------------------------------------------------------
// ET-2 — an unanswered escrow must return the tokens with the HOLD CLOCK
// intact, so the asker is not "exit-taxed" for the creator's non-delivery.
// (RULING K deleted the cost basis, so the basis half of the original ET-2
// fix is gone with it; the clock half — the acqBlock stored in the escrow —
// stays, and is what this test pins: a round-tripped escrow is invisible to a
// later sale's tax.)
// ---------------------------------------------------------------------------

func TestAsk_ET2_UnansweredEscrowPreservesClock(t *testing.T) {
	build := func(ask bool) *SellResult {
		s := NewMemStore()
		c := "alice"
		base := uint64(8_000_000)
		// face 9065 -> ceil(face/1813)==5 credits at the seeded rate
		if err := Register(s, c, c, base, 9065, 1_000_000_000); err != nil {
			t.Fatal(err)
		}
		setU64(s, kPaidUntil(c), base+100*SubscriptionPeriod)
		if _, err := Buy(s, "whale", c, base, big.NewInt(100)); err != nil {
			t.Fatal(err)
		}
		resetObsRings(s, c)
		for i := uint64(1); i < 16; i++ {
			RecordObs(s, c, base+i*LongObsSpacing, SpotRate(big.NewInt(100)))
		}
		q := base + 15*LongObsSpacing + 50
		if _, err := Buy(s, "fan", c, q, big.NewInt(5)); err != nil {
			t.Fatal(err)
		}
		rq := q + 1 + MinAskDeadline + ReclaimGrace + 1
		if ask {
			ar, err := askAt0(s, "fan", c, q+1, big.NewInt(5), CommissionOwedFor(getMoney(s, kFace(c))), "cid", MinAskDeadline)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := Reclaim(s, "fan", c, rq, ar.Seq); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := Sell(s, "whale", c, rq+1, big.NewInt(80)); err != nil {
			t.Fatal(err) // crash the market
		}
		r, err := Sell(s, "fan", c, rq+2, big.NewInt(5))
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	ctl := build(false)
	vic := build(true)
	// The whole point: the escrow round trip is invisible to a later sale —
	// the asker's hold clock (and therefore the tax rate, the tax, and the net)
	// is exactly what it would have been had they never asked. If the reclaim
	// re-aged the clock, the victim's τ would read fresher and the victim would
	// pay MORE gross tax than the control.
	if vic.TaxBps != ctl.TaxBps {
		t.Fatalf("ET-2: hold clock differs after an unanswered escrow: victim %d bps vs control %d bps", vic.TaxBps, ctl.TaxBps)
	}
	if vic.Tax.Cmp(ctl.Tax) != 0 {
		t.Fatalf("ET-2: tax differs: victim %s vs control %s", vic.Tax, ctl.Tax)
	}
	if vic.Net.Cmp(ctl.Net) != 0 {
		t.Fatalf("ET-2: net differs: victim %s vs control %s", vic.Net, ctl.Net)
	}
}

// TestAsk_ET2_ClockConservedThroughReclaim — the asker's hold clock is
// conserved to the block across escrow-out and reclaim (age-neutral round
// trip), so an unanswered escrow cannot re-age the asker into a higher exit
// tax. (RULING K deleted the cost basis, so there is no basis leg to conserve
// any more — only the clock.)
func TestAsk_ET2_ClockConservedThroughReclaim(t *testing.T) {
	s := NewMemStore()
	c := "alice"
	base := uint64(8_000_000)
	if err := Register(s, c, c, base, 9065, 1_000_000_000); err != nil {
		t.Fatal(err)
	}
	setU64(s, kPaidUntil(c), base+100*SubscriptionPeriod)
	Buy(s, "whale", c, base, big.NewInt(100))
	resetObsRings(s, c)
	for i := uint64(1); i < 16; i++ {
		RecordObs(s, c, base+i*LongObsSpacing, SpotRate(big.NewInt(100)))
	}
	q := base + 15*LongObsSpacing + 50
	Buy(s, "fan", c, q, big.NewInt(5))
	acqBefore := holderAcqBlock(s, c, "fan")

	// Ask escrows everything, then RECLAIM (unanswered): the clock returns
	// exactly (age-neutral).
	ar, err := askAt0(s, "fan", c, q+1, big.NewInt(5), CommissionOwedFor(getMoney(s, kFace(c))), "cid", MinAskDeadline)
	if err != nil {
		t.Fatal(err)
	}
	rq := q + 1 + MinAskDeadline + ReclaimGrace + 1
	if _, err := Reclaim(s, "fan", c, rq, ar.Seq); err != nil {
		t.Fatal(err)
	}
	if got := holderAcqBlock(s, c, "fan"); got != acqBefore {
		t.Fatalf("ET-2: reclaim restored clock %d, want %d (age-neutral)", got, acqBefore)
	}
}

// ---------------------------------------------------------------------------
// SET-1 — a busy market must keep pricing services; the short TWAP ring is
// rate-limited so it can never evict its own history below MinObsBlocks.
// ---------------------------------------------------------------------------

func TestSettlement_SET1_BusyMarketStillPrices(t *testing.T) {
	s := NewMemStore()
	c := "alice"
	base := uint64(8_000_000)
	if err := Register(s, c, c, base, 1_000_000, 1_000_000_000); err != nil {
		t.Fatal(err)
	}
	setU64(s, kPaidUntil(c), base+100*SubscriptionPeriod)
	// A market at a stable supply with a constant price history — so the ONLY
	// thing under test is the SPAN condition (the SET-1 bug), never the
	// median-deviation guard (a separate, legitimate refusal).
	curveMarket(s, c, 1000)
	q0 := seedSettleObs(s, c, base, SpotRate(big.NewInt(1000)))
	if _, err := SettlementRate(s, c, q0); err != nil {
		t.Fatalf("baseline settlement refused: %v", err)
	}

	// Flood: flat Buy(1)/Sell(1) round trips returning to S=1000 each time,
	// spaced only 5 blocks apart => far more than 32 trades per 1200 blocks.
	// Pre-fix, the short ring accepted one write per BLOCK and evicted its own
	// history within the burst, dropping the window span below MinObsBlocks
	// and making every settlement path refuse ("observations span less than
	// the minimum window"). Post-fix, ShortObsSpacing rate-limits the ring so
	// its span is structurally >= MinObsBlocks. The recorded rates stay ~spot
	// (1000/1001), so the median guard never fires — SPAN is the sole subject.
	blk := q0 + 100
	for i := 0; i < 200; i++ {
		if _, err := Buy(s, "grief", c, blk, big.NewInt(1)); err != nil {
			t.Fatal(err)
		}
		blk += 5
		if _, err := Sell(s, "grief", c, blk, big.NewInt(1)); err != nil {
			t.Fatal(err)
		}
		blk += 5
	}
	if _, err := SettlementRate(s, c, blk+10); err != nil {
		t.Fatalf("SET-1: settlement refused after 200 rapid round trips (the self-inflicted kill switch): %v", err)
	}

	// The structural guarantee: a full ring spans >= MinObsBlocks by
	// construction, so no amount of trading can compress it below the span
	// floor again.
	if (ObsWindow-1)*ShortObsSpacing < MinObsBlocks {
		t.Fatalf("SET-1: (ObsWindow-1)*ShortObsSpacing = %d < MinObsBlocks %d — the structural guarantee is gone",
			(ObsWindow-1)*ShortObsSpacing, MinObsBlocks)
	}
	// The young-market refusal is unchanged: MinObsCount samples cannot span
	// MinObsBlocks on their own.
	if (MinObsCount-1)*ShortObsSpacing >= MinObsBlocks {
		t.Fatalf("SET-1: a %d-sample ring now spans MinObsBlocks — the young-market refusal broke", MinObsCount)
	}
}

// ---------------------------------------------------------------------------
// SET-2 — the C4 minimum-price floor must not contradict the accepted face
// range: every face Register/SetFace accepts must be settleable at launch,
// and the live floor is queryable so a creator sees it rise with the price.
// ---------------------------------------------------------------------------

func TestSettlement_SET2_MinFaceClearsC4Floor(t *testing.T) {
	// The const-level contradiction is removed: the smallest ACCEPTED face is
	// at least the C4 floor at the theoretical minimum rate (BasePrice). This
	// is exactly the assertion the finding's fix (a) demands so Register /
	// SetFace and the settlement guard cannot compile a face that is accepted
	// yet permanently unsettleable at the BasePrice floor.
	if MinFace*2 < BasePrice {
		t.Fatalf("SET-2: MinFace*2 (%d) < BasePrice (%d) — a documented-minimum face is unsettleable at the compiled floor", MinFace*2, BasePrice)
	}

	// The real fix that makes the floor VISIBLE: ServiceFaceRange exports the
	// live [min,max] window, the min is the C4 floor at the market's own rate,
	// and a face AT that floor settles while a face one unit below it does
	// not — the failure is diagnosable BEFORE the revenue call, not silent.
	s := NewMemStore()
	c := "alice"
	base := uint64(8_000_000)
	if err := Register(s, c, c, base, 1000, 1_000_000_000); err != nil {
		t.Fatal(err)
	}
	setU64(s, kPaidUntil(c), base+100*SubscriptionPeriod)
	curveMarket(s, c, 100)
	q := seedSettleObs(s, c, base, SpotRate(big.NewInt(100)))
	loSmall, hiSmall, err := ServiceFaceRange(s, c, q)
	if err != nil {
		t.Fatal(err)
	}
	if loSmall.Cmp(hiSmall) > 0 {
		t.Fatalf("SET-2: S=100 window empty [%s,%s]", loSmall, hiSmall)
	}
	// The exported floor is exactly settleable; one unit below it refuses.
	if _, err := SettleSpend(s, c, q, loSmall); err != nil {
		t.Fatalf("SET-2: the exported floor %s did not settle: %v", loSmall, err)
	}
	if _, err := SettleSpend(s, c, q, new(big.Int).Sub(loSmall, big.NewInt(1))); err == nil {
		t.Fatalf("SET-2: a face one unit below the exported floor %s settled — the window is wrong", loSmall)
	}

	// The floor RISES with the token price (the honest product limit the
	// finding demands be surfaced): a face legal today can go dead purely
	// because the market appreciated.
	curveMarket(s, c, 2000)
	seedSettleObs(s, c, base, SpotRate(big.NewInt(2000)))
	q2 := base + (stObsCount-1)*LongObsSpacing + 50
	loBig, _, err := ServiceFaceRange(s, c, q2)
	if err != nil {
		t.Fatal(err)
	}
	if loBig.Cmp(loSmall) <= 0 {
		t.Fatalf("SET-2: floor did not rise with the token price (%s at S=100 vs %s at S=2000)", loSmall, loBig)
	}
}

// ---------------------------------------------------------------------------
// SET-3 — the 5%-of-supply spend cap must not be unsatisfiable at small
// supply: a one-credit spend (the minimum possible) is always allowed.
// ---------------------------------------------------------------------------

func TestSettlement_SET3_SmallSupplyStillPrices(t *testing.T) {
	for _, S := range []int64{2, 5, 10, 19, 20, 40} {
		s := NewMemStore()
		c := "alice"
		base := uint64(8_000_000)
		if err := Register(s, c, c, base, 1_000_000, 1_000_000_000); err != nil {
			t.Fatal(err)
		}
		setU64(s, kPaidUntil(c), base+100*SubscriptionPeriod)
		curveMarket(s, c, S)
		rate := SpotRate(big.NewInt(S))
		seedSettleObs(s, c, base, rate)
		q := base + (stObsCount-1)*LongObsSpacing + 50
		// The cheapest POSTED face the contract itself declares legal — asking
		// ServiceFaceRange instead of recomputing ceil(rate/2) keeps this test
		// honest across the commission carve-out (USER RULING 2026-07-27: C4
		// measures the TOKEN leg, so the legal posted floor is grossed up by
		// the commission and is no longer ceil(rate/2)). Still exactly 1 credit.
		face, _, err := ServiceFaceRange(s, c, q)
		if err != nil {
			t.Fatalf("SET-3: S=%d ServiceFaceRange refused: %v", S, err)
		}
		quote, err := SettleSpend(s, c, q, face)
		if err != nil {
			t.Fatalf("SET-3: S=%d a one-credit service refused: %v", S, err)
		}
		if quote.Credits.Cmp(big.NewInt(1)) != 0 {
			t.Fatalf("SET-3: S=%d expected a 1-credit spend, got %s", S, quote.Credits)
		}
	}

	// The cap still BINDS for credits > 1 (it is not weakened where it does
	// its down-walk job): a 2-credit spend at S=20 (cap = 1) must refuse.
	s := NewMemStore()
	c := "alice"
	base := uint64(8_000_000)
	if err := Register(s, c, c, base, 1_000_000, 1_000_000_000); err != nil {
		t.Fatal(err)
	}
	setU64(s, kPaidUntil(c), base+100*SubscriptionPeriod)
	curveMarket(s, c, 20)
	rate := SpotRate(big.NewInt(20))
	seedSettleObs(s, c, base, rate)
	q := base + (stObsCount-1)*LongObsSpacing + 50
	// face that costs 2 credits: 2*rate - 1
	face2 := new(big.Int).Sub(new(big.Int).Mul(rate, big.NewInt(2)), big.NewInt(1))
	if _, err := SettleSpend(s, c, q, face2); err == nil {
		t.Fatal("SET-3: a 2-credit spend at S=20 (cap=1) was admitted — the cap was over-weakened")
	}
}

// ---------------------------------------------------------------------------
// EXITTAX-1 (FIX ROUND 1, 2026-07-22) — a permissionless RefundHolder push may
// never crystallize a still-fresh holder's exit tax to the treasury against
// their will. Before the fix, any third party (a griefer, the rugging creator,
// or the platform owner who banks kTreasury) could force a fresh holder's
// refund the instant a market wound down and take up to MaxExitTaxBps (20%) of
// that holder's pro-rata backing — defeating RULING K2's promise that "the
// decay clears it for anyone who has held", because the push denied the holder
// the chance to hold. The push now refuses while the holder's tax is nonzero.
// The exact fixture is the finding's own case (supply 10000, reserve
// 10,000,000, a 10% fresh holder), naturally FROZEN (creator never Registered).
// ---------------------------------------------------------------------------

func TestRefundHolder_EXITTAX1_FreshPushRefused(t *testing.T) {
	s := NewMemStore()
	const creator = "exittax1creator"
	const victim = "victimfan"
	const griefer = "griefer1"

	setMoney(s, kSupply(creator), big.NewInt(10000))
	setMoney(s, kReserve(creator), big.NewInt(10_000_000))
	setMoney(s, kBal(creator, victim), big.NewInt(1000)) // 10% of supply
	setU64(s, kAcqBlock(creator, victim), 200000)        // a genuine, fresh hold clock

	// Never Registered => kPaidUntil == 0 => FROZEN for any block >= GraceBlocks,
	// so this is inWindDown. heldBlocks == 2 at the push block => full 20% tax.
	pushBlock := uint64(200002)
	if got := Phase(s, creator, pushBlock); got != StateFrozen {
		t.Fatalf("fixture: phase = %s, want FROZEN", got)
	}
	if bps := ExitTaxBpsAt(heldBlocksAt(s, creator, victim, pushBlock)); bps != MaxExitTaxBps {
		t.Fatalf("fixture: fresh victim should read the max tax %d, got %d", MaxExitTaxBps, bps)
	}

	// (1) THE GRIEF IS REFUSED — a stranger cannot force the fresh victim out.
	balB, supB := getMoney(s, kBal(creator, victim)), getMoney(s, kSupply(creator))
	resB, treaB := getMoney(s, kReserve(creator)), getMoney(s, kTreasury())
	feeCB := getMoney(s, kFeeBal(creator))
	if _, err := RefundHolder(s, griefer, creator, victim, pushBlock); errSymbol(err) != ErrState {
		t.Fatalf("EXITTAX-1: a fresh holder's permissionless push must be REFUSED, got err=%v", err)
	}
	// Nothing mutated on the rejected call (RULING G).
	if getMoney(s, kBal(creator, victim)).Cmp(balB) != 0 || getMoney(s, kSupply(creator)).Cmp(supB) != 0 ||
		getMoney(s, kReserve(creator)).Cmp(resB) != 0 || getMoney(s, kTreasury()).Cmp(treaB) != 0 {
		t.Fatal("EXITTAX-1: a rejected push mutated state")
	}

	// (2) THE HOLDER IS NOT TRAPPED — their own (taxed) self-Refund still works,
	// at exactly their own hold-clock rate: gross 1,000,000, 20% tax 200,000,
	// net 800,000. This is the accepted RULING K2 cost of THEIR OWN choice to
	// exit early; what EXITTAX-1 forbids is a STRANGER imposing it.
	selfNet, err := Refund(s, victim, creator, pushBlock, big.NewInt(1000))
	if err != nil {
		t.Fatalf("EXITTAX-1: the holder's OWN self-Refund must still work: %v", err)
	}
	if selfNet.Cmp(big.NewInt(800000)) != 0 {
		t.Fatalf("self-Refund net = %s, want 800000 (gross 1,000,000 − 20%% tax 200,000)", selfNet)
	}
	// Split 50/50 (2026-07-27): the victim is not the creator, so treasury
	// takes 100,000 and the creator's claimable pot the other 100,000. The
	// point of the assertion is unchanged — the full 200,000 tax was collected
	// and the victim got none of it back.
	vTaxC, vTaxP := exitTaxSplit(creator, victim, big.NewInt(200000))
	if got := new(big.Int).Sub(getMoney(s, kTreasury()), treaB); got.Cmp(vTaxP) != 0 {
		t.Fatalf("treasury gained %s on the self-Refund, want the platform half %s", got, vTaxP)
	}
	if got := new(big.Int).Sub(getMoney(s, kFeeBal(creator)), feeCB); got.Cmp(vTaxC) != 0 {
		t.Fatalf("creator pot gained %s on the self-Refund, want the creator half %s", got, vTaxC)
	}
	if reunited := mAdd(vTaxC, vTaxP); reunited.Cmp(big.NewInt(200000)) != 0 {
		t.Fatalf("tax split leaked: %s != assessed 200000", reunited)
	}
}

// TestRefundHolder_EXITTAX1_AgedPushAllowedAndDodgeClosed proves the two
// remaining EXITTAX-1 properties: (3) once a holder's tax has fully decayed the
// push is allowed again as a harmless 0-tax sweep (so abandoned positions still
// drain and CLOSE/re-register is only delayed, never blocked); and (4) the
// whale escape RULING K2 closes stays closed — a fresh dominant holder cannot
// be pushed out at 0 tax by an ally, because the push refuses while their tax is
// nonzero. (Zeroing the push tax instead would have reopened exactly this dodge.)
func TestRefundHolder_EXITTAX1_AgedPushAllowedAndDodgeClosed(t *testing.T) {
	s := NewMemStore()
	const creator = "exittax1aged"
	const whale = "freshwhale"
	const ally = "whaleally"

	setMoney(s, kSupply(creator), big.NewInt(10000))
	setMoney(s, kReserve(creator), big.NewInt(10_000_000))
	setMoney(s, kBal(creator, whale), big.NewInt(9000)) // dominant, 90% of supply
	setU64(s, kAcqBlock(creator, whale), 1_000_000)     // fresh at the wind-down

	// (4) DODGE CLOSED — the whale's ally cannot push the fresh whale out at 0 tax.
	freshBlock := uint64(1_000_005) // FROZEN (unregistered), whale held 5 blocks
	if got := Phase(s, creator, freshBlock); got != StateFrozen {
		t.Fatalf("fixture: phase = %s, want FROZEN", got)
	}
	if _, err := RefundHolder(s, ally, creator, whale, freshBlock); errSymbol(err) != ErrState {
		t.Fatalf("whale dodge: a fresh whale's ally-push must be REFUSED, got err=%v", err)
	}

	// (3) AGED PUSH ALLOWED — a full ExitTaxDecayBlocks later the whale has
	// decayed to τ = 0, and the push is an untaxed sweep (net == gross, treasury
	// untouched). gross = floor(10,000,000·9000/10000) = 9,000,000.
	agedBlock := uint64(1_000_000 + ExitTaxDecayBlocks + 1)
	treaB := getMoney(s, kTreasury())
	net, err := RefundHolder(s, ally, creator, whale, agedBlock)
	if err != nil {
		t.Fatalf("aged push must succeed at 0 tax: %v", err)
	}
	if net.Cmp(big.NewInt(9_000_000)) != 0 {
		t.Fatalf("aged push net = %s, want gross 9,000,000 (0 tax at full decay)", net)
	}
	if got := getMoney(s, kTreasury()); got.Cmp(treaB) != 0 {
		t.Fatalf("aged push moved the treasury by %s, want 0 (no tax at full decay)", new(big.Int).Sub(got, treaB))
	}
	if got := getMoney(s, kBal(creator, whale)); !mIsZero(got) {
		t.Fatalf("whale balance after aged push = %s, want 0 (fully swept)", got)
	}
}

// ---------------------------------------------------------------------------
// NOTICE-1 (FIX ROUND 1, 2026-07-22) — RULING K3 makes the entire 5-day retire
// notice a wind-down state (inWindDown via marketRetired), which newly enabled
// the permissionless RefundHolder push DURING the notice. Combined with the K2
// wind-down tax, a stranger could force a fresh fan's exit inside the notice —
// and the creator controls WHEN the notice opens (Retire), so it can be sprung
// right after a wave of fresh buys. The EXITTAX-1 decay gate closes it there
// too: a fresh fan cannot be force-pushed during the notice, but is never
// trapped (their own self-Refund pull is open the whole wind-down).
// ---------------------------------------------------------------------------

func TestRefundHolder_NOTICE1_FreshPushRefusedDuringRetireNotice(t *testing.T) {
	s := NewMemStore()
	const creator = "notice1creator"
	const victim = "noticevictim"
	const griefer = "noticegriefer"

	setupMarket(s, creator, 100000, MaxCap) // Registered, comfortably ACTIVE
	setMoney(s, kSupply(creator), big.NewInt(10000))
	setMoney(s, kReserve(creator), big.NewInt(10_000_000))
	setMoney(s, kBal(creator, victim), big.NewInt(1000))
	setU64(s, kAcqBlock(creator, victim), 200000) // a fresh fan

	// Creator retires -> the 5-day notice opens. During it Phase is OVERDUE, but
	// a RETIRED market is inWindDown (K3): the curve rail is dropped and the flat
	// pro-rata rail (Refund/RefundHolder) is the exit.
	if err := Retire(s, creator, creator, 200001); err != nil {
		t.Fatalf("Retire: %v", err)
	}
	noticeBlock := uint64(200002) // deep in the notice
	if got := Phase(s, creator, noticeBlock); got != StateOverdue {
		t.Fatalf("fixture: notice phase = %s, want OVERDUE", got)
	}
	if !inWindDown(s, creator, noticeBlock) {
		t.Fatal("fixture: a retired market must be inWindDown during its notice (K3)")
	}

	// The griefer cannot force the fresh fan out during the notice.
	balB := getMoney(s, kBal(creator, victim))
	treaB := getMoney(s, kTreasury())
	if _, err := RefundHolder(s, griefer, creator, victim, noticeBlock); errSymbol(err) != ErrState {
		t.Fatalf("NOTICE-1: a fresh fan's push during the retire notice must be REFUSED, got err=%v", err)
	}
	if getMoney(s, kBal(creator, victim)).Cmp(balB) != 0 || getMoney(s, kTreasury()).Cmp(treaB) != 0 {
		t.Fatal("NOTICE-1: a rejected notice-window push mutated state")
	}

	// The fan is NOT trapped — their own self-Refund works during the notice,
	// taxed at their own clock (their choice): gross 1,000,000, 20% → net 800,000.
	selfNet, err := Refund(s, victim, creator, noticeBlock, big.NewInt(1000))
	if err != nil {
		t.Fatalf("NOTICE-1: the fan's own self-Refund must work during the notice: %v", err)
	}
	if selfNet.Cmp(big.NewInt(800000)) != 0 {
		t.Fatalf("self-Refund net = %s, want 800000 (gross 1,000,000 − 20%% tax)", selfNet)
	}
}

// ---------------------------------------------------------------------------
// OUTFLOW-1 (FIX ROUND 1, 2026-07-22) — core.ClaimTradeFees (the creator's 5%
// pull-claimable trade-fee outflow, tradefee.go) had NO wasm entrypoint in
// contract/main.go and was invoked nowhere else in the repo: a structural,
// total fund LOCK on all creator trade-fee revenue the instant buy/sell ship
// and fees begin accruing to kFeeBal. Worse than a RULING-G revert-on-reject —
// there was no error to catch and no phase to wait out, the money simply had no
// invocable path out. This asserts the entrypoint now exists and is wired to
// core.ClaimTradeFees with the state-first (CEI) shape. The contract package is
// TinyGo/wasm-only (its runtime import is build-constrained out of normal go),
// so this reads the source directly — the strongest structural check available
// at this layer, and exactly the kind of presence check that would have caught
// the original omission.
// ---------------------------------------------------------------------------

func TestContract_OUTFLOW1_ClaimTradeFeesEntrypointWired(t *testing.T) {
	src, err := os.ReadFile("../contract/main.go")
	if err != nil {
		t.Fatalf("read contract/main.go: %v", err)
	}
	text := string(src)
	if !strings.Contains(text, "//go:wasmexport claimTradeFees") {
		t.Fatal("OUTFLOW-1 REGRESSION: contract/main.go has no //go:wasmexport claimTradeFees entrypoint — creator trade-fee revenue (core.ClaimTradeFees) has no invocable path out, a structural fund lock")
	}
	if !strings.Contains(text, "core.ClaimTradeFees(store, caller)") {
		t.Fatal("OUTFLOW-1 REGRESSION: the claimTradeFees entrypoint does not wire core.ClaimTradeFees(store, caller)")
	}
	// CEI / state-first discipline: the core call (which zeroes kFeeBal) must
	// precede the HBD payout, mirroring withdrawTreasury. Assert the core mutation
	// appears before a HiveTransfer within the entrypoint region.
	ci := strings.Index(text, "//go:wasmexport claimTradeFees")
	region := text[ci:]
	if end := strings.Index(region[1:], "//go:wasmexport"); end >= 0 {
		region = region[:end+1]
	}
	claimAt := strings.Index(region, "core.ClaimTradeFees(store, caller)")
	xferAt := strings.Index(region, "sdk.HiveTransfer")
	if claimAt < 0 || xferAt < 0 || claimAt > xferAt {
		t.Fatal("OUTFLOW-1 REGRESSION: claimTradeFees must mutate core state (core.ClaimTradeFees) BEFORE it pays out (sdk.HiveTransfer) — CEI/state-first")
	}
}
