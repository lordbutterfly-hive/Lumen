package core

import (
	"math/big"
	"testing"
)

// twobucket_test.go — the behaviours the maturing/matured split introduces.
//
// The single most important class here is NOT-TRAPPED. Every guard in this
// package used to read one balance key; after the split, any guard that still
// reads only the maturing family refuses a holder access to tokens they own.
// refund.go's header proves that no state can leave a holder with zero open
// rails, and these tests are what keep that proof true.

const tbWindow = ExitTaxDecayBlocks

func tbMarket(t *testing.T, c string) *MemStore {
	t.Helper()
	s := NewMemStore()
	if err := Register(s, c, c, 1000, 1000, 1_000_000_000); err != nil {
		t.Fatalf("register: %v", err)
	}
	return s
}

// tbKeepPaid renews the creator's subscription enough times to cover [from, to]
// with headroom, so the market is ACTIVE for the whole span.
func tbKeepPaid(t *testing.T, s *MemStore, c string, from, to uint64) {
	t.Helper()
	periods := (to-from)/SubscriptionPeriod + 2
	if err := Renew(s, c, c, from, periods, big.NewInt(SubscriptionFee*int64(periods))); err != nil {
		t.Fatalf("renew: %v", err)
	}
}

// tbMature buys and then graduates, leaving the holder wholly matured.
func tbMature(t *testing.T, s *MemStore, c, h string, n int64, buyAt uint64) uint64 {
	t.Helper()
	if _, err := Buy(s, h, c, buyAt, big.NewInt(n)); err != nil {
		t.Fatalf("buy: %v", err)
	}
	at := buyAt + tbWindow
	// The maturity window (42 days) outlives one subscription period (30), so a
	// fixture that just jumps forward finds a FROZEN market and every trade is
	// refused for a reason that has nothing to do with what is under test. Keep
	// the market paid across the wait.
	tbKeepPaid(t, s, c, buyAt, at)
	graduate(s, c, h, at)
	if MaturedOf(s, c, h).Cmp(big.NewInt(n)) != 0 {
		t.Fatalf("setup: expected %d matured, got %s", n, MaturedOf(s, c, h))
	}
	if MaturingOf(s, c, h).Sign() != 0 {
		t.Fatal("setup: maturing bucket should be empty after graduation")
	}
	return at
}

// ---------------------------------------------------------------------------
// NOT TRAPPED
// ---------------------------------------------------------------------------

func TestTwoBucket_MaturedHolderCanSell(t *testing.T) {
	const c, h = "hive:alice", "hive:bob"
	s := tbMarket(t, c)
	at := tbMature(t, s, c, h, 500, 1_000_000)

	r, err := Sell(s, h, c, at, big.NewInt(200))
	if err != nil {
		t.Fatalf("a wholly-matured holder was refused the curve: %v", err)
	}
	if r.Tax.Sign() != 0 {
		t.Fatalf("matured tokens paid %s exit tax — their rate is 0 by definition", r.Tax)
	}
	if got := BalanceOf(s, c, h); got.Cmp(big.NewInt(300)) != 0 {
		t.Fatalf("balance after selling 200 of 500 = %s, want 300", got)
	}
}

// ★ THE DEFECT THIS SPLIT ALMOST SHIPPED. During wind-down the curve is closed,
// so Refund is the ONLY rail. If it reads the maturing family alone, a holder
// whose position has matured has no way out at all.
func TestTwoBucket_MaturedHolderIsNotTrappedInWindDown(t *testing.T) {
	const c, h = "hive:alice", "hive:bob"
	s := tbMarket(t, c)
	at := tbMature(t, s, c, h, 500, 1_000_000)

	if err := Retire(s, c, c, at); err != nil {
		t.Fatalf("retire: %v", err)
	}
	windDown := at + 1

	if _, err := Sell(s, h, c, windDown, big.NewInt(1)); err == nil {
		t.Fatal("setup invalid: the curve rail must be closed during wind-down")
	}
	net, err := Refund(s, h, c, windDown, big.NewInt(500))
	if err != nil {
		t.Fatalf("TRAPPED: matured holder refused both rails — curve closed AND refund said %v", err)
	}
	if net.Sign() <= 0 {
		t.Fatalf("refund paid %s", net)
	}
	if BalanceOf(s, c, h).Sign() != 0 {
		t.Fatal("the whole position should have left")
	}
}

func TestTwoBucket_MaturedHolderCanAsk(t *testing.T) {
	const c, h = "hive:alice", "hive:bob"
	s := tbMarket(t, c)
	at := tbMature(t, s, c, h, 5000, 1_000_000)

	// Asks settle at a rate derived from the curve's own observation ring, which
	// needs observations at distinct blocks. Seed them from a DIFFERENT holder
	// so the holder under test stays wholly matured — the premise of this test.
	// MinObsCount (8) distinct-block observations spanning at least
	// MinObsBlocks (1200), sampled at ShortObsSpacing so each one is recorded.
	seedFrom := at - (MinObsCount+2)*ShortObsSpacing - MinObsBlocks
	tbKeepPaid(t, s, c, seedFrom, at)
	for i := uint64(0); i <= MinObsCount+2; i++ {
		blk := seedFrom + i*ShortObsSpacing
		if blk >= at {
			break
		}
		if _, err := Buy(s, "hive:seeder", c, blk, big.NewInt(50)); err != nil {
			t.Fatalf("seed buy at %d: %v", blk, err)
		}
	}

	face := Face(s, c)
	_, err := Ask(s, h, c, at, big.NewInt(5000), CommissionOwedFor(face), "contenthash", 864000, 0)

	// Scoped deliberately: an Ask also needs a settlement rate, and building the
	// oracle history for one is a fixture concern unrelated to buckets. What
	// this test pins is the property the split could break — that the balance
	// guard SEES a wholly-matured position. A BALANCE refusal here would mean a
	// committed customer is locked out of the product's core loop at exactly the
	// moment they have held long enough to be one.
	if e, ok := err.(*Err); ok && e.Symbol == ErrBalance {
		t.Fatalf("a wholly-matured holder was refused for BALANCE: %v", err)
	}

	// NOT asserted here, deliberately: that an over-spend is refused. Ask
	// consults the settlement oracle BEFORE the balance guard, so on this
	// fixture an over-spend returns an ORACLE error and never reaches the code
	// under test — an assertion there would pass for the wrong reason. The
	// guard itself is pinned directly below, where it is reachable.
	_ = face
}

// The balance arithmetic Ask depends on, tested where it is reachable.
func TestTwoBucket_PositionGuardSeesBothBuckets(t *testing.T) {
	const c, h = "hive:alice", "hive:bob"
	s := tbMarket(t, c)
	tbMature(t, s, c, h, 500, 1_000_000)

	if got := totalBalance(s, c, h); got.Cmp(big.NewInt(500)) != 0 {
		t.Fatalf("totalBalance = %s, want 500 — a wholly-matured position is invisible "+
			"to any guard that reads the maturing family alone", got)
	}
	if err := debitPosition(s, c, h, big.NewInt(501)); err == nil {
		t.Fatal("debitPosition allowed an over-draw — the guard must refuse")
	}
	if err := debitPosition(s, c, h, big.NewInt(500)); err != nil {
		t.Fatalf("debitPosition refused the exact position: %v", err)
	}
	if totalBalance(s, c, h).Sign() != 0 {
		t.Fatal("the whole position should have been drawn")
	}
}

// The escrow clock: a draw taken wholly from matured tokens must come back
// matured, or reclaiming an unanswered ask silently restarts a holder's
// 42-day wait — the same confiscation the ET-2 fix closed, through a new door.
func TestTwoBucket_EscrowClockPreservesMaturity(t *testing.T) {
	const c, h = "hive:alice", "hive:bob"
	s := tbMarket(t, c)
	at := tbMature(t, s, c, h, 500, 1_000_000)

	fromMatured, fromMaturing := splitDraw(s, c, h, big.NewInt(500))
	if fromMaturing.Sign() != 0 {
		t.Fatal("setup: the whole draw should come from the matured bucket")
	}
	acq := escrowAcqBlock(s, c, h, at, fromMatured, fromMaturing)

	// Credit it back exactly as Reclaim/Decline would, then confirm it is
	// immediately matured again rather than starting a fresh window.
	creditInflowAt(s, c, h, big.NewInt(500), acq, at)
	if !maturedNow(s, c, h, at) {
		t.Fatalf("a matured escrow came back UNMATURED (recorded clock %d at block %d) — "+
			"the holder would have to wait another full window for tokens they had "+
			"already held", acq, at)
	}
	if bps := ExitTaxBpsAt(heldBlocksAt(s, c, h, at)); bps != 0 {
		t.Fatalf("returned escrow owes %d bps — it owed nothing when it went in", bps)
	}
}

// A mixed escrow collapses to one clock. It must not be the older of the two,
// which would hand the maturing half free age.
func TestTwoBucket_MixedEscrowClockCannotMintMaturity(t *testing.T) {
	const c, h = "hive:alice", "hive:bob"
	s := tbMarket(t, c)
	at := tbMature(t, s, c, h, 400, 1_000_000)
	if _, err := Buy(s, h, c, at, big.NewInt(400)); err != nil {
		t.Fatalf("buy: %v", err)
	}

	fromMatured, fromMaturing := splitDraw(s, c, h, big.NewInt(800))
	if fromMatured.Sign() == 0 || fromMaturing.Sign() == 0 {
		t.Fatal("setup: the draw should span both buckets")
	}
	acq := escrowAcqBlock(s, c, h, at, fromMatured, fromMaturing)

	// The collapsed clock must sit strictly between the two inputs: older than
	// the fresh purchase, younger than a full window.
	if acq <= maturityFloorBlock(at) {
		t.Fatalf("mixed escrow clock %d is at or past a full window — the fresh half "+
			"would exit tax-free on tokens it never aged", acq)
	}
	if acq > at {
		t.Fatalf("mixed escrow clock %d is in the future (block %d)", acq, at)
	}
	creditInflowAt(s, c, h, big.NewInt(800), acq, at)
	if maturedNow(s, c, h, at) {
		t.Fatal("a half-fresh escrow came back fully matured — maturity was minted")
	}
}

// ---------------------------------------------------------------------------
// THE TAX SPLIT
// ---------------------------------------------------------------------------

// A sale spanning both buckets must pay pro rata — NOT by handing the matured
// tokens the dearest slice of the curve, which is the tax-minimising pairing
// and was measured at −39% of collections.
func TestTwoBucket_MixedSaleIsTaxedProRataNotTopSlice(t *testing.T) {
	const c, h = "hive:alice", "hive:bob"
	s := tbMarket(t, c)
	at := tbMature(t, s, c, h, 400, 1_000_000)

	// Fresh purchase on top of the matured position.
	if _, err := Buy(s, h, c, at, big.NewInt(400)); err != nil {
		t.Fatalf("buy: %v", err)
	}
	if MaturingOf(s, c, h).Cmp(big.NewInt(400)) != 0 {
		t.Fatalf("expected 400 maturing, got %s", MaturingOf(s, c, h))
	}

	// Sell the whole 800: half matured (0%), half fresh (full rate).
	r, err := Sell(s, h, c, at, big.NewInt(800))
	if err != nil {
		t.Fatalf("sell: %v", err)
	}
	if r.TaxBps == 0 {
		t.Fatal("setup invalid: the fresh half should carry a nonzero rate")
	}
	// The taxable base is the maturing half of the gross, ±1 for ceil.
	half := new(big.Int).Div(r.Gross, big.NewInt(2))
	diff := new(big.Int).Sub(r.TaxableGross, half)
	diff.Abs(diff)
	if diff.Cmp(big.NewInt(1)) > 0 {
		t.Fatalf("taxable base %s is not the pro-rata half of gross %s (half=%s) — "+
			"a top-slice apportionment would put it far from here",
			r.TaxableGross, r.Gross, half)
	}
	if r.Tax.Cmp(ExitTaxOn(r.TaxableGross, r.TaxBps)) != 0 {
		t.Fatal("tax is not the exact rate on the taxable base")
	}
	// And it must be strictly less than taxing the whole gross would be.
	if r.Tax.Cmp(ExitTaxOn(r.Gross, r.TaxBps)) >= 0 {
		t.Fatal("matured tokens were taxed — they owe nothing")
	}
}

// A sale draws MATURING tokens first, so the matured bucket — the one the
// marketplace can see, and the one a live listing is backed by — survives a
// partial curve sale.
func TestTwoBucket_SellDrawsMaturingFirstAndSparesTheTradableBucket(t *testing.T) {
	const c, h = "hive:alice", "hive:bob"
	s := tbMarket(t, c)
	at := tbMature(t, s, c, h, 400, 1_000_000)
	if _, err := Buy(s, h, c, at, big.NewInt(400)); err != nil {
		t.Fatalf("buy: %v", err)
	}

	r, err := Sell(s, h, c, at, big.NewInt(400)) // exactly the maturing half
	if err != nil {
		t.Fatalf("sell: %v", err)
	}
	if r.Tax.Sign() == 0 {
		t.Fatal("a sale of wholly-maturing tokens paid no tax")
	}
	if MaturingOf(s, c, h).Sign() != 0 {
		t.Fatal("the maturing bucket should have been drawn first and emptied")
	}
	if MaturedOf(s, c, h).Cmp(big.NewInt(400)) != 0 {
		t.Fatal("the matured bucket must be untouched — it backs listings and allowances")
	}
}

// ★★ THE ET-1 REGRESSION FOR TWO BUCKETS. The two existing chunking guards both
// buy and sell at the same block, so nothing ever graduates and neither can see
// a matured bucket at all — they were structurally blind to this seam, and a
// draw order that made the tax 99.98% avoidable passed them both.
//
// This one advances the clock so a real matured bucket exists, then proves what
// RULING K1 requires: splitting an exit can never cost LESS than making it in
// one sale.
func TestTwoBucket_ChunkingAcrossBucketsCannotEvadeTheTax(t *testing.T) {
	cases := []struct{ matured, fresh int64 }{
		{200, 200}, {1000, 1000}, {10_000, 10_000}, {2000, 200}, {100_000, 100},
	}
	for _, tc := range cases {
		const c, h = "hive:alice", "hive:bob"

		// One sale.
		s1 := tbMarket(t, c)
		at := tbMature(t, s1, c, h, tc.matured, 1_000_000)
		if _, err := Buy(s1, h, c, at, big.NewInt(tc.fresh)); err != nil {
			t.Fatalf("buy: %v", err)
		}
		single, err := Sell(s1, h, c, at, big.NewInt(tc.matured+tc.fresh))
		if err != nil {
			t.Fatalf("single sell: %v", err)
		}

		// The same position, sold in two chunks, split exactly on the bucket
		// boundary — the seam a seller would aim at.
		s2 := tbMarket(t, c)
		at2 := tbMature(t, s2, c, h, tc.matured, 1_000_000)
		if _, err := Buy(s2, h, c, at2, big.NewInt(tc.fresh)); err != nil {
			t.Fatalf("buy: %v", err)
		}
		a, err := Sell(s2, h, c, at2, big.NewInt(tc.matured))
		if err != nil {
			t.Fatalf("chunk 1: %v", err)
		}
		b, err := Sell(s2, h, c, at2, big.NewInt(tc.fresh))
		if err != nil {
			t.Fatalf("chunk 2: %v", err)
		}
		chunked := mAdd(a.Tax, b.Tax)

		if chunked.Cmp(single.Tax) < 0 {
			t.Fatalf("ET-1 REOPENED (matured=%d fresh=%d): two sells paid %s where one paid %s — "+
				"%.2f%% of the exit tax avoided by clicking twice. The draw order is what "+
				"decides this: whichever bucket is consumed first prices its tokens against "+
				"that end of the curve.",
				tc.matured, tc.fresh, chunked, single.Tax,
				100*(1-float64(chunked.Int64())/float64(single.Tax.Int64())))
		}
		// Gross must be identical — only the tax base is at stake here.
		if g := mAdd(a.Gross, b.Gross); g.Cmp(single.Gross) != 0 {
			t.Fatalf("gross differs between one sale (%s) and two (%s) — the curve should "+
				"telescope exactly", single.Gross, g)
		}
	}
}

// ---------------------------------------------------------------------------
// GRADUATE-BEFORE-BUY: the acceleration fix
// ---------------------------------------------------------------------------

// ★★ THE PIN FOR buy.go's graduate() CALL — reached ONLY through Buy.
//
// Scrutiny showed the sibling test below could not see this line at all: its
// fixture calls graduate() directly, so the pile is already in the matured
// bucket before Buy runs and the assertion holds whether or not Buy graduates.
// Deleting the line, and moving it to AFTER the credit, both survived the whole
// suite — and the move costs 99.9% of the fresh purchase's tax.
//
// This test touches nothing but Buy: buy, wait a full window, buy again. If Buy
// does not graduate the first pile before crediting the second, the two blend
// and the fresh tokens inherit an age they never served.
func TestTwoBucket_BuyItselfGraduatesTheOldPile(t *testing.T) {
	const c, h = "hive:alice", "hive:bob"
	s := tbMarket(t, c)
	const t0 = 1_000_000
	if _, err := Buy(s, h, c, t0, big.NewInt(100_000)); err != nil {
		t.Fatalf("first buy: %v", err)
	}
	at := uint64(t0) + tbWindow
	tbKeepPaid(t, s, c, t0, at)

	// The ONLY graduation trigger in this test.
	if _, err := Buy(s, h, c, at, big.NewInt(100)); err != nil {
		t.Fatalf("second buy: %v", err)
	}

	if got := MaturedOf(s, c, h); got.Cmp(big.NewInt(100_000)) != 0 {
		t.Fatalf("matured = %s, want 100000 — Buy did not graduate the aged pile before "+
			"crediting the new purchase", got)
	}
	if got := MaturingOf(s, c, h); got.Cmp(big.NewInt(100)) != 0 {
		t.Fatalf("maturing = %s, want just the 100 fresh tokens", got)
	}
	if bps := ExitTaxBpsAt(heldBlocksAt(s, c, h, at)); bps != MaxExitTaxBps {
		t.Fatalf("the fresh purchase carries %d bps, want the full %d — it inherited age "+
			"from the aged pile, which is the reusable tax shield this line exists to kill",
			bps, MaxExitTaxBps)
	}
}

// ★ The reason graduation runs before the credit in Buy. Without it, a fresh
// purchase lands in the same weighted average as a matured pile and drags the
// whole thing forward — which is what made an aged position a permanent,
// reusable tax shield.
func TestTwoBucket_FreshBuyCannotRideAnAgedPile(t *testing.T) {
	const c, h = "hive:alice", "hive:bob"
	s := tbMarket(t, c)
	at := tbMature(t, s, c, h, 100_000, 1_000_000)

	if _, err := Buy(s, h, c, at, big.NewInt(100)); err != nil {
		t.Fatalf("buy: %v", err)
	}

	// The aged pile is OUT of the average, so the 100 fresh tokens carry the
	// full rate on their own rather than being diluted to nearly zero.
	held := heldBlocksAt(s, c, h, at)
	if held != 0 {
		t.Fatalf("the fresh purchase inherited %d blocks of age from the matured pile — "+
			"graduation must remove matured tokens from the average BEFORE the credit", held)
	}
	if bps := ExitTaxBpsAt(held); bps != MaxExitTaxBps {
		t.Fatalf("fresh tokens carry %d bps, want the full %d", bps, MaxExitTaxBps)
	}
	// Sanity: the matured pile is still there and still owes nothing.
	if MaturedOf(s, c, h).Cmp(big.NewInt(100_000)) != 0 {
		t.Fatal("graduation must not disturb the matured balance")
	}
}

// ---------------------------------------------------------------------------
// WIND-DOWN PUSH
// ---------------------------------------------------------------------------

// The permissionless push must be able to sweep an abandoned matured holder, or
// supply never reaches zero, the market never closes, and the creator can never
// re-register.
func TestTwoBucket_PushSweepsAnAbandonedMaturedHolder(t *testing.T) {
	const c, h = "hive:alice", "hive:bob"
	s := tbMarket(t, c)
	at := tbMature(t, s, c, h, 500, 1_000_000)
	if err := Retire(s, c, c, at); err != nil {
		t.Fatalf("retire: %v", err)
	}
	windDown := at + 1

	payout, err := RefundHolder(s, "hive:stranger", c, h, windDown)
	if err != nil {
		t.Fatalf("the push could not reach a matured holder: %v — supply would be pinned "+
			"above zero forever and the creator could never re-register", err)
	}
	if payout.Sign() <= 0 {
		t.Fatalf("push paid %s", payout)
	}
	if BalanceOf(s, c, h).Sign() != 0 {
		t.Fatal("the holder's whole position must have left")
	}
}

// ...but it must STILL refuse to force-liquidate a holder who is genuinely
// fresh. That gate is what stops a griefer, or the retiring creator, from
// crystallising someone's 20% against their will.
func TestTwoBucket_PushStillRefusesAFreshHolder(t *testing.T) {
	const c, h = "hive:alice", "hive:bob"
	s := tbMarket(t, c)
	if _, err := Buy(s, h, c, 1_000_000, big.NewInt(500)); err != nil {
		t.Fatalf("buy: %v", err)
	}
	if err := Retire(s, c, c, 1_000_000); err != nil {
		t.Fatalf("retire: %v", err)
	}
	windDown := uint64(1_000_000) + 1

	if _, err := RefundHolder(s, "hive:griefer", c, h, windDown); err == nil {
		t.Fatal("a still-taxed holder was force-liquidated — the gate that reads the " +
			"maturing clock is the only thing standing between a griefer and 20% of " +
			"someone else's backing")
	}
}
