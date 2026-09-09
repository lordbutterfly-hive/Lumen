package core

import (
	"math/big"
	"testing"
)

// zz_bound_grief_test.go — PROOF 4/6: the bound closes the state-bloat grief
// WITHOUT opening a tax grief in its place, and the attacker's cost is stated.
//
// ★ WHY THE MERGE RULE IS "CHEAPEST ADJACENT PAIR" AND NOT LITERALLY "THE TWO
// OLDEST". The two-oldest rule is safe under its own stated premise — that both
// of the two oldest cohorts are aged, hence lowest-rate, hence a merge at the
// younger acq costs almost nothing. collapseMaturedLots implements exactly that
// case, for free and exactly tax-neutral, and runs FIRST. But the premise is not
// an invariant: an attacker chooses the ledger's shape. Give a victim ONE large
// aged cohort and flood MaxLots fresh dust cohorts on top, and "the two oldest"
// are the victim's AGED PILE and a FRESH dust cohort — merging those at the
// younger acq re-ages the victim's ENTIRE position to fresh, for the price of
// MaxLots+1 dust transfers. TestZZBound_NaiveTwoOldestRuleWouldReAgeTheVictim
// below RUNS that rule and measures the damage; the shipped rule is measured on
// the identical attack right above it.

// zbNaiveTwoOldestBound is the LITERAL "merge the two oldest" rule, implemented
// here ONLY so its failure mode can be measured against the shipped one. Never
// called by production code.
func zbNaiveTwoOldestBound(lots []mLot, max int) []mLot {
	out := append([]mLot(nil), lots...)
	sortLotsFreshestFirst(out)
	for len(out) > max {
		n := len(out)
		merged := mLot{
			count: mAdd(out[n-2].count, out[n-1].count),
			acq:   out[n-2].acq, // the YOUNGER of the two oldest
		}
		out = append(out[:n-2], merged)
	}
	return out
}

// zbFloodVictim builds: victim holds `pile` tokens bought at t0 (fully matured
// by t1), then `gifts` attacker dust gifts land at distinct blocks from t1 on.
// Returns the store, the last flood block, and the attacker's total sunk cost.
func zbFloodVictim(t *testing.T, c string, pile int64, gifts int) (s *MemStore, last uint64, attackerCost *big.Int) {
	t.Helper()
	t0 := uint64(2_000_000)
	t1 := t0 + ExitTaxDecayBlocks
	s = NewMemStore()
	zbMarket(t, s, c, t1+uint64(gifts)+10)
	if _, err := Buy(s, "victim", c, t0, big.NewInt(pile)); err != nil {
		t.Fatalf("victim buy: %v", err)
	}
	attackerCost = mZero()
	for i := 0; i < gifts; i++ {
		blk := t1 + uint64(i)
		r, err := Buy(s, "attacker", c, blk, big.NewInt(1))
		if err != nil {
			t.Fatalf("attacker buy #%d: %v", i, err)
		}
		attackerCost = mAdd(attackerCost, r.Cost)
		if err := TransferCredits(s, "attacker", c, "attacker", "victim", blk, big.NewInt(1)); err != nil {
			t.Fatalf("attacker gift #%d: %v", i, err)
		}
		last = blk
	}
	return s, last, attackerCost
}

// ---------------------------------------------------------------------------
// 4a. THE SHIPPED RULE: a flood cannot re-age the victim's aged pile.
// ---------------------------------------------------------------------------
func TestZZBound_FloodCannotReAgeVictimPile(t *testing.T) {
	const c = "alice"
	const pile = int64(1_000_000)
	const gifts = MaxLots + 20 // comfortably past the cap
	t0 := uint64(2_000_000)

	s, last, attackerCost := zbFloodVictim(t, c, pile, gifts)

	if got := zvNumCohorts(s, c, "victim"); got > MaxLots {
		t.Fatalf("bound broken: %d cohorts", got)
	}
	// THE VICTIM'S AGED COHORT IS UNTOUCHED: same count, same acq, still rate 0.
	lots := getLotsRaw(s, c, "victim")
	oldest := lots[len(lots)-1]
	if oldest.acq != t0 {
		t.Fatalf("VICTIM RE-AGED: oldest cohort acq=%d, want the original %d (a merge moved the aged pile)",
			oldest.acq, t0)
	}
	if oldest.count.Cmp(big.NewInt(pile)) != 0 {
		t.Fatalf("VICTIM PILE DISTURBED: oldest cohort holds %s, want %d", oldest.count, pile)
	}
	if bps := lotRateAt(oldest.acq, last); bps != 0 {
		t.Fatalf("VICTIM RE-AGED: aged pile now reads %d bps, want 0", bps)
	}

	// ---- IN MONEY, SEPARATING THE TWO TAX TERMS ----------------------------
	// The reported tax is max(blendTax, cohortTax). Only the COHORT term is
	// produced by this ledger and therefore only it can be affected by the bound;
	// the blend term is a pure function of (kBal, kAcqBlock), which this change
	// does not touch at all, and its dust-gift grief is the PRE-EXISTING,
	// P4-bounded one (a donation moves the blended rate by at most the donated
	// FRACTION). Assert them separately so the bound is judged on its own term.
	supply := getMoney(s, kSupply(c))
	total := getMoney(s, kBal(c, "victim"))
	_, fm := splitDraw(s, c, "victim", total)
	cohortTax, _, topBps, err := maturingCohortTax(s, c, "victim", supply, fm, last)
	if err != nil {
		t.Fatal(err)
	}
	blendBps := ExitTaxBpsAt(heldBlocksAt(s, c, "victim", last))
	taxable, _ := SellProceeds(supply, fm)
	blendTax := ExitTaxOn(taxable, blendBps)

	// THE COHORT TERM'S CEILING: with the aged pile still at 0 bps, the whole
	// cohort charge can be no more than the FULL rate on the gifted tokens' own
	// top slice. If a merge had re-aged the pile this would blow past it.
	giftSlice, _ := SellProceeds(supply, big.NewInt(gifts))
	giftCap := ExitTaxOn(giftSlice, MaxExitTaxBps)
	// ExitTaxOn CEILs PER COHORT, so the gifted tokens spread over up to MaxLots
	// cohorts pay up to MaxLots base units (0.001 HBD each) of ceil padding above
	// a single ceil over the whole slice. Allow exactly that and not one unit
	// more: anything beyond it would be rate, i.e. a re-aged pile.
	giftCapWithCeil := new(big.Int).Add(giftCap, big.NewInt(int64(MaxLots)))
	if cohortTax.Cmp(giftCapWithCeil) > 0 {
		t.Fatalf("GRIEF AMPLIFICATION: cohortTax %s exceeds the full-rate tax on the %d gifted tokens (%s) "+
			"plus the per-cohort ceil allowance (%d) — a merge re-aged the victim's pile",
			cohortTax, gifts, giftCap, MaxLots)
	}
	t.Logf("COHORT TERM BOUNDED: cohortTax=%s <= full-rate tax on the %d gifted tokens (%s) + %d units of "+
		"per-cohort ceil padding; topBps=%d; the victim's %d-token aged pile contributes 0 "+
		"(had the pile been re-aged this term would be ~%s).",
		cohortTax, gifts, giftCap, MaxLots, topBps, pile, ExitTaxOn(taxable, MaxExitTaxBps))

	// For the record: on this shape the BLEND is the binding term, i.e. the bound
	// contributes nothing to the victim's bill. The blend's own dust grief is
	// P4-bounded at ceil(MaxExitTaxBps·gift/(pile+gift))+1 bps and is untouched
	// by this change.
	p4Bound := mMulDivCeil(new(big.Int).Mul(big.NewInt(gifts), new(big.Int).SetUint64(MaxExitTaxBps)),
		big.NewInt(1), big.NewInt(pile+gifts))
	p4Bound.Add(p4Bound, big.NewInt(1))
	if uint64(blendBps) > p4Bound.Uint64() {
		t.Fatalf("blend rate %d bps exceeds the P4 donated-fraction bound %s bps", blendBps, p4Bound)
	}
	q, err := QuoteSell(s, "victim", c, last, total)
	if err != nil {
		t.Fatal(err)
	}
	// ★ THE REPORTED TAX IS THE COHORT TAX, FULL STOP (2026-09-08). This used to
	// assert tax == max(blend, cohort). The max() floor is gone (sell.go): on
	// exactly this shape it was the BINDING term and it was an OVER-charge — the
	// blend re-rated the victim's whole 1,000,000-token aged pile because of dust
	// it had been given, while the ledger correctly charges the dust on the dust's
	// own top slice and leaves the pile at 0. Removing it cuts the flood grief by
	// the ratio logged below, and the ledger's own ceiling (asserted above) is
	// what now bounds it — a structural bound, not a rate bound.
	t.Logf("FLOOD (%d gifts -> %d cohorts): blendTax=%s (%d bps, P4 bound %s bps) cohortTax=%s -> reported tax=%s; "+
		"the removed blend floor would have charged %s (%.1fx more); attacker sank %s HBD base units on the dust.",
		gifts, zvNumCohorts(s, c, "victim"), blendTax, blendBps, p4Bound, cohortTax, q.Tax,
		blendTax, float64(blendTax.Int64())/float64(cohortTax.Int64()), attackerCost)
	if q.Tax.Cmp(cohortTax) != 0 {
		t.Fatalf("reported tax %s != the per-cohort tax %s", q.Tax, cohortTax)
	}
	if q.Tax.Cmp(blendTax) > 0 {
		t.Fatalf("the cohort ledger must not charge MORE than the old blend on a pure dust flood: %s > %s", q.Tax, blendTax)
	}
	zvAssertNoOrphanLots(t, s, "after flood")
	zvAssertReserveEqualsArea(t, s, c, "after flood")
}

// ---------------------------------------------------------------------------
// 4b. THE REJECTED RULE, MEASURED. The literal "merge the two oldest" applied to
// the SAME flooded ledger re-ages the victim's whole pile. This is why the
// shipped rule minimises lotMergeCost instead.
// ---------------------------------------------------------------------------
func TestZZBound_NaiveTwoOldestRuleWouldReAgeTheVictim(t *testing.T) {
	const c = "alice"
	const pile = int64(1_000_000)
	const gifts = MaxLots + 20
	t0 := uint64(2_000_000)

	// Rebuild the flooded ledger WITHOUT any bound, so both rules see the same
	// input: 1 aged cohort + `gifts` fresh dust cohorts at distinct blocks.
	t1 := t0 + ExitTaxDecayBlocks
	last := t1 + uint64(gifts) - 1
	lots := []mLot{{count: big.NewInt(pile), acq: t0}}
	for i := 0; i < gifts; i++ {
		lots = append(lots, mLot{count: big.NewInt(1), acq: t1 + uint64(i)})
	}
	sortLotsFreshestFirst(lots)

	naive := zbNaiveTwoOldestBound(lots, MaxLots)
	shipped := boundLots(append([]mLot(nil), lots...), last)

	naiveOldest := naive[len(naive)-1]
	shippedOldest := shipped[len(shipped)-1]

	supply := big.NewInt(pile + int64(gifts) + 100_000)
	fm := big.NewInt(pile + int64(gifts))
	taxNaive := zbLedgerTax(t, naive, supply, fm, last)
	taxShipped := zbLedgerTax(t, shipped, supply, fm, last)
	taxUnbounded := zbLedgerTax(t, lots, supply, fm, last)

	t.Logf("SAME flooded ledger (%d cohorts: 1 aged %d-token pile + %d fresh dust), both rules to %d cohorts:",
		len(lots), pile, gifts, MaxLots)
	t.Logf("  UNBOUNDED   : oldest cohort = %s tokens @acq %d (%d bps); tax = %s",
		lots[len(lots)-1].count, lots[len(lots)-1].acq, lotRateAt(lots[len(lots)-1].acq, last), taxUnbounded)
	t.Logf("  NAIVE 2-OLDEST: oldest cohort = %s tokens @acq %d (%d bps); tax = %s",
		naiveOldest.count, naiveOldest.acq, lotRateAt(naiveOldest.acq, last), taxNaive)
	t.Logf("  SHIPPED       : oldest cohort = %s tokens @acq %d (%d bps); tax = %s",
		shippedOldest.count, shippedOldest.acq, lotRateAt(shippedOldest.acq, last), taxShipped)

	// The naive rule must be demonstrably worse for the victim — that is the
	// whole reason it is not shipped. If this ever stops being true the deviation
	// should be revisited.
	if lotRateAt(naiveOldest.acq, last) == 0 {
		t.Fatalf("expected the naive rule to re-age the aged pile; it did not — revisit the deviation")
	}
	if taxNaive.Cmp(taxShipped) <= 0 {
		t.Fatalf("expected the naive rule to over-charge the victim vs the shipped rule; naive=%s shipped=%s",
			taxNaive, taxShipped)
	}
	// The shipped rule leaves the aged pile exactly where it was.
	if shippedOldest.acq != t0 || shippedOldest.count.Cmp(big.NewInt(pile)) != 0 {
		t.Fatalf("shipped rule disturbed the aged pile: %s @%d", shippedOldest.count, shippedOldest.acq)
	}
	amp := new(big.Int).Sub(taxNaive, taxShipped)
	t.Logf("REJECTED RULE COSTS THE VICTIM %s EXTRA base units on this position (%.1fx the shipped charge) — "+
		"bought with %d dust transfers. The shipped rule leaves the aged pile at acq %d / 0 bps.",
		amp, f2(taxNaive)/f2(taxShipped), gifts+1, t0)
}

// ---------------------------------------------------------------------------
// 4c. GRIEFING COST, stated in numbers: what an attacker must spend to bloat a
// victim's ledger, and what the ceiling on that bloat now is.
// ---------------------------------------------------------------------------
func TestZZBound_GriefingCostAndCeiling(t *testing.T) {
	const c = "alice"
	const pile = int64(1_000_000)
	s, last, cost := zbFloodVictim(t, c, pile, 300)
	cohorts := zvNumCohorts(s, c, "victim")
	bytes := len(zvLotsStr(s, c, "victim"))
	t.Logf("GRIEFING COST: 300 gifts at 300 distinct blocks = 300 Buy + 300 TransferCredits transactions "+
		"(RC + %s HBD base units of token cost, all sunk by the attacker, none recoverable from the victim).",
		cost)
	t.Logf("CEILING REACHED: victim ledger = %d cohorts / %d bytes. Gift 301..∞ adds ZERO cohorts and ZERO bytes. "+
		"MaxLots=%d is the hard ceiling on per-(creator,holder) ledger size, so the marginal return on every "+
		"transaction past the %dth is exactly nil. The DoS is closed.", cohorts, bytes, MaxLots, MaxLots)
	if cohorts > MaxLots {
		t.Fatalf("ceiling broken: %d cohorts", cohorts)
	}
	// The victim is still able to exit normally.
	total := getMoney(s, kBal(c, "victim"))
	r, err := Sell(s, "victim", c, last, total, nil)
	if err != nil {
		t.Fatalf("victim TRAPPED after the flood: %v", err)
	}
	t.Logf("VICTIM NOT TRAPPED: full exit succeeded — gross=%s tax=%s fee=%s net=%s", r.Gross, r.Tax, r.Fee, r.Net)
	zvAssertReserveEqualsArea(t, s, c, "after victim exit")
	zvAssertNoOrphanLots(t, s, "after victim exit")
}

// ---------------------------------------------------------------------------
// 4d. THE GRIEF BOUND, QUANTIFIED AND ADVERSARIAL. An attacker who wants the
// merge to land on a VICTIM's big cohort has to make EVERY other adjacent pair
// cost more than count_victim x delta_victim. Since lotMergeCost is
// count x blocks, "more expensive" means the attacker must hold LARGE cohorts,
// which they must buy. This sweeps the strategies available to them (dust,
// equal-weight, escalating weights; tight and wide acq spacings) and measures
// the maturity actually confiscated from the victim's tokens.
//
// THE METRIC IS THE VICTIM'S OWN MATURITY, not the ledger's total. Merges only
// ever raise an acq, and only ADJACENT cohorts merge, so the victim's tokens are
// unharmed exactly when an output cohort still sits at victimAcq (something may
// have merged UP INTO it — that costs the victim nothing); otherwise they sit in
// the nearest output cohort above victimAcq, and the gap is the blocks of
// maturity confiscated from every one of the victim's tokens.
func TestZZBound_AdversarialMergeCostToVictim(t *testing.T) {
	block := uint64(20_000_000)
	victimCount := big.NewInt(1_000_000)
	victimAcq := block - ExitTaxDecayBlocks/2 // half-matured: the most there is to lose

	type strat struct {
		name    string
		count   int64
		spacing uint64
	}
	strats := []strat{
		{"dust / 1-block spacing", 1, 1},
		{"dust / 1-day spacing", 1, BlocksPerDay},
		{"1k tokens / 1-block spacing", 1_000, 1},
		{"1k tokens / 1-day spacing", 1_000, BlocksPerDay},
		{"100k tokens / 1-block spacing", 100_000, 1},
		{"100k tokens / 1-day spacing", 100_000, BlocksPerDay},
		{"10M tokens / 1-day spacing", 10_000_000, BlocksPerDay},
		{"10M tokens / 1-block spacing", 10_000_000, 1},
	}
	worstBlocksPerToken := uint64(0)
	var worstName string
	for _, st := range strats {
		for _, side := range []string{"fresher", "older"} {
			lots := []mLot{{count: new(big.Int).Set(victimCount), acq: victimAcq}}
			attackerTokens := mZero()
			for i := 0; i < MaxLots; i++ {
				var acq uint64
				if side == "fresher" {
					acq = victimAcq + uint64(i+1)*st.spacing
				} else {
					acq = victimAcq - uint64(i+1)*st.spacing
				}
				if acq >= block {
					acq = block // block-fresh convention; still a distinct-ish cohort
				}
				lots = append(lots, mLot{count: big.NewInt(st.count), acq: acq})
				attackerTokens = mAdd(attackerTokens, big.NewInt(st.count))
			}
			sortLotsFreshestFirst(lots)
			out := boundLots(append([]mLot(nil), lots...), block)
			if len(out) > MaxLots {
				t.Fatalf("%s/%s: bound broken (%d cohorts)", st.name, side, len(out))
			}
			// Where did the victim's tokens end up?
			victimHarm := uint64(0)
			survived := false
			for _, l := range out {
				if l.acq == victimAcq && l.count.Cmp(victimCount) >= 0 {
					survived = true
					break
				}
			}
			if !survived {
				// Nearest output cohort strictly above victimAcq holds them.
				landed := ^uint64(0)
				for _, l := range out {
					if l.acq > victimAcq && l.acq < landed {
						landed = l.acq
					}
				}
				if landed == ^uint64(0) {
					t.Fatalf("%s/%s: victim's tokens vanished from the ledger", st.name, side)
				}
				victimHarm = landed - victimAcq
			}
			if victimHarm > worstBlocksPerToken {
				worstBlocksPerToken, worstName = victimHarm, st.name+"/"+side
			}
			t.Logf("  %-32s %-8s attackerTokens=%-12s victimCohortIntact=%-5v victimMaturityLost=%d blocks/token (window %d)",
				st.name, side, attackerTokens, survived, victimHarm, ExitTaxDecayBlocks)
		}
	}
	// A merge may never cost the victim a material fraction of the window. 1% of
	// the 42-day window is the line drawn here; the measured worst case is far
	// below it (see the log), and a regression that re-aged a pile would blow
	// through it by five orders of magnitude.
	limit := ExitTaxDecayBlocks / 100
	if worstBlocksPerToken > limit {
		t.Fatalf("GRIEF: worst case cost the victim %d blocks of maturity per token (%s), limit %d (1%% of the window)",
			worstBlocksPerToken, worstName, limit)
	}
	t.Logf("ADVERSARIAL GRIEF BOUND: across every attacker strategy swept, the worst maturity loss is "+
		"%d blocks per victim token (worst: %s) against a %d-block window — under %.4f%%. "+
		"To do worse an attacker must fund cohorts far larger than the victim's own position.",
		worstBlocksPerToken, worstName, ExitTaxDecayBlocks,
		100*float64(worstBlocksPerToken)/float64(ExitTaxDecayBlocks))
}
