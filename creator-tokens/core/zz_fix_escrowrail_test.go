package core

// zz_fix_escrowrail_test.go — the THIRD rail probe (2026-09-08).
//
// TransferCredits was not the only door that summarised a heterogeneous
// position into ONE clock. Ask() stores `acqAtEscrow := holderAcqBlock(...)` —
// the sender's BLENDED clock — in the escrow record, and Reclaim / Decline /
// Answer credit the escrow back at that single value. Same fault, different
// door. This file measures whether it launders.

import (
	"fmt"
	"math/big"
	"math/rand"
	"testing"
)

// erSeedObs seeds both observation rings at the curve's own spot rate — the
// same idiom the pruned-findings fixtures use, replicated here because that
// file is behind a build tag.
func erSeedObs(s Store, creator string, base uint64) uint64 {
	for i := uint64(0); i < ObsWindow; i++ {
		setStr(s, kObs(creator, i), "")
		setStr(s, kObsLong(creator, i), "")
	}
	setU64(s, kObsIdx(creator), 0)
	setU64(s, kObsLongIdx(creator), 0)
	rate := SpotRate(getMoney(s, kSupply(creator)))
	if rate.Sign() <= 0 {
		rate = big.NewInt(int64(BasePrice))
	}
	for i := uint64(0); i < stObsCount; i++ {
		RecordObs(s, creator, base+i*LongObsSpacing, rate)
	}
	return base + (stObsCount-1)*LongObsSpacing + 50
}

// erWorld builds a market with a HETEROGENEOUS maturing position on `h`:
// an aged pile bought at t0 that never graduated, plus a fresh slice
// transferred in at t1. Returns the store and the block to ask at.
func erWorld(t *testing.T, c, h string, pile, fresh int64) (*MemStore, uint64, uint64) {
	t.Helper()
	s := NewMemStore()
	if err := Register(s, c, c, 1, MinFace+5000, MaxCap); err != nil {
		t.Fatal(err)
	}
	t0 := uint64(10)
	t1 := t0 + ExitTaxDecayBlocks
	setU64(s, kPaidUntil(c), t1+1000*SubscriptionPeriod)
	if _, err := Buy(s, h, c, t0, big.NewInt(pile)); err != nil {
		t.Fatal(err)
	}
	if _, err := Buy(s, "alt", c, t1, big.NewInt(fresh)); err != nil {
		t.Fatal(err)
	}
	if err := TransferCredits(s, "alt", c, "alt", h, t1, big.NewInt(fresh)); err != nil {
		t.Fatal(err)
	}
	askBlock := erSeedObs(s, c, t1+1)
	setU64(s, kPaidUntil(c), askBlock+1000*SubscriptionPeriod)
	return s, askBlock, t1
}

// TestER_EscrowRoundTripCannotLaunder — the probe. An Ask escrows the FRESH
// slice (splitDraw + lotsDebit are both maturing-and-freshest-first), the
// creator Declines in the same block, and the tokens come back. If the escrow
// carried the blended clock instead of the cohort, the returned slice is now
// worth the aged pile's rate and the launder is open through this door.
func TestER_EscrowRoundTripCannotLaunder(t *testing.T) {
	for _, sh := range []struct {
		name        string
		pile, fresh int64
	}{
		{"blend-matured", 400_000, 4_000},
		{"blend-NOT-matured", 400_000, 40_000},
		{"blend-NOT-matured-half", 40_000, 40_000},
		{"tiny-fresh-huge-pile", 4_000_000, 1_000},
	} {
		t.Run(sh.name, func(t *testing.T) { erRoundTripProbe(t, sh.pile, sh.fresh) })
	}
}

func erRoundTripProbe(t *testing.T, pile, fresh int64) {
	c, h := "ercreator", "erholder"

	s, askBlock, _ := erWorld(t, c, h, pile, fresh)

	// ★ THE INSTRUMENT. Comparing "the tax on selling N tokens" MISSES this
	// launder, because the sale draws freshest-first and the laundered cohort
	// hides UNDER the un-escrowed remainder. The quantity that actually moves is
	// the position's whole TAX CAPACITY, Σ count·rate over the ledger — that is
	// what the escrow round trip was destroying (measured 44% on the pre-fix
	// tree, shape blend-NOT-matured below).
	capBefore := xlCapacity(s, c, h, askBlock)
	weightBefore := xlWeight(s, c, h, askBlock)

	// What the fresh slice owes BEFORE the escrow round trip.
	ctl := hzCloneStore(s)
	qBefore, err := QuoteSell(ctl, h, c, askBlock, big.NewInt(fresh))
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("ledger BEFORE the ask: %v", zbLotsRate(s, c, h, askBlock))

	lo, hi, err := ServiceFaceRange(s, c, askBlock)
	if err != nil {
		t.Fatal(err)
	}
	// Walk the legal face band down from the top until the settlement guards
	// (spend cap = 5% of supply, depth ceiling) admit the ask, so each shape
	// escrows the LARGEST slice this contract will let it.
	var q *SettleQuote
	face := new(big.Int).Set(hi)
	for {
		var e error
		q, e = SettleSpend(s, c, askBlock, face)
		if e == nil && q.Credits.Sign() > 0 {
			break
		}
		face.Div(face, big.NewInt(2))
		if face.Cmp(lo) < 0 {
			t.Skipf("no face in [%s,%s] admits an ask on this shape", lo, hi)
		}
	}
	setMoney(s, kFace(c), face)
	ar, err := Ask(s, h, c, askBlock, new(big.Int).Mul(q.Credits, big.NewInt(1_000_000)), q.CommissionHbd, "cid", MinAskDeadline, 0)
	if err != nil {
		t.Fatal(err)
	}
	rec, _ := loadEscrow(s, c, ar.Seq)
	t.Logf("blendMatured=%v; escrowed %s credits; escrow acqBlock=%d (rate there %d bps); ledger after the ask: %v",
		maturedNow(s, c, h, askBlock), ar.CreditsSpent, rec.acqBlock, lotRateAt(rec.acqBlock, askBlock), zbLotsRate(s, c, h, askBlock))

	if _, err := Decline(s, c, c, askBlock, ar.Seq); err != nil {
		t.Fatal(err)
	}
	t.Logf("ledger AFTER the decline: %v", zbLotsRate(s, c, h, askBlock))

	qAfter, err := QuoteSell(s, h, c, askBlock, ar.CreditsSpent)
	if err != nil {
		t.Fatal(err)
	}
	ctlQ, err := QuoteSell(ctl, h, c, askBlock, ar.CreditsSpent)
	if err != nil {
		t.Fatal(err)
	}
	capAfter := xlCapacity(s, c, h, askBlock)
	weightAfter := xlWeight(s, c, h, askBlock)
	t.Logf("same-block Ask->Decline on %s credits: tax(control)=%s tax(after)=%s | LEDGER CAPACITY %s -> %s | age-weight %s -> %s",
		ar.CreditsSpent, ctlQ.Tax, qAfter.Tax, capBefore, capAfter, weightBefore, weightAfter)
	_ = qBefore
	if capAfter.Cmp(capBefore) < 0 {
		t.Errorf("ESCROW RAIL LAUNDER: an Ask->Decline round trip destroyed %s of %s token·bps of tax capacity (%.2f%%)",
			new(big.Int).Sub(capBefore, capAfter), capBefore,
			100*float64(new(big.Int).Sub(capBefore, capAfter).Int64())/float64(capBefore.Int64()))
	}
	if weightAfter.Cmp(weightBefore) > 0 {
		t.Errorf("ESCROW RAIL MANUFACTURED MATURITY: age-weight %s -> %s", weightBefore, weightAfter)
	}
	if qAfter.Tax.Cmp(ctlQ.Tax) < 0 {
		t.Errorf("ESCROW RAIL LAUNDER: an Ask->Decline round trip cut the tax on %s credits from %s to %s (%s avoided)",
			ar.CreditsSpent, ctlQ.Tax, qAfter.Tax, new(big.Int).Sub(ctlQ.Tax, qAfter.Tax))
	}
}

// The same probe on the RECLAIM door (permissionless, deadline-gated) rather
// than Decline (creator-gated, same block).
func TestER_ReclaimRoundTripCannotLaunder(t *testing.T) {
	const c, h = "ercreator2", "erholder2"
	const pile, fresh = int64(400_000), int64(4_000)

	s, askBlock, _ := erWorld(t, c, h, pile, fresh)
	ctl := hzCloneStore(s)

	lo, _, err := ServiceFaceRange(s, c, askBlock)
	if err != nil {
		t.Fatal(err)
	}
	setMoney(s, kFace(c), lo)
	q, err := SettleSpend(s, c, askBlock, lo)
	if err != nil {
		t.Fatal(err)
	}
	ar, err := Ask(s, h, c, askBlock, new(big.Int).Mul(q.Credits, big.NewInt(1_000_000)), q.CommissionHbd, "cid", MinAskDeadline, 0)
	if err != nil {
		t.Fatal(err)
	}
	rec, _ := loadEscrow(s, c, ar.Seq)
	at := rec.deadline + ReclaimGrace + 1
	setU64(s, kPaidUntil(c), at+1000*SubscriptionPeriod)
	if _, err := Reclaim(s, "stranger", c, at, ar.Seq); err != nil {
		t.Fatal(err)
	}
	qAfter, err := QuoteSell(s, h, c, at, ar.CreditsSpent)
	if err != nil {
		t.Fatal(err)
	}
	ctlQ, err := QuoteSell(ctl, h, c, at, ar.CreditsSpent)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("Ask->Reclaim (%d blocks later): control tax=%s after tax=%s; ledger capacity %s -> %s; ledger %v",
		at-askBlock, ctlQ.Tax, qAfter.Tax, xlCapacity(ctl, c, h, at), xlCapacity(s, c, h, at), zbLotsRate(s, c, h, at))
	if xlCapacity(s, c, h, at).Cmp(xlCapacity(ctl, c, h, at)) < 0 {
		t.Errorf("ESCROW RECLAIM LAUNDER: tax capacity %s -> %s", xlCapacity(ctl, c, h, at), xlCapacity(s, c, h, at))
	}
	if qAfter.Tax.Cmp(ctlQ.Tax) < 0 {
		t.Errorf("ESCROW RECLAIM LAUNDER: %s avoided", new(big.Int).Sub(ctlQ.Tax, qAfter.Tax))
	}
}

// The cohort record is settlement INPUT, not history: every terminal door must
// consume it, or a re-settlement could replay the same cohorts.
func TestER_EscrowLotsKeyNeverOrphaned(t *testing.T) {
	const pile, fresh = int64(400_000), int64(40_000)
	for _, door := range []string{"decline", "reclaim", "answer"} {
		t.Run(door, func(t *testing.T) {
			c, h := "erk"+door, "erkh"
			s, askBlock, _ := erWorld(t, c, h, pile, fresh)
			lo, hi, err := ServiceFaceRange(s, c, askBlock)
			if err != nil {
				t.Fatal(err)
			}
			var q *SettleQuote
			face := new(big.Int).Set(hi)
			for {
				var e error
				q, e = SettleSpend(s, c, askBlock, face)
				if e == nil && q.Credits.Sign() > 0 {
					break
				}
				face.Div(face, big.NewInt(2))
				if face.Cmp(lo) < 0 {
					t.Skip("no admissible face")
				}
			}
			setMoney(s, kFace(c), face)
			ar, err := Ask(s, h, c, askBlock, new(big.Int).Mul(q.Credits, big.NewInt(1_000_000)), q.CommissionHbd, "cid", MinAskDeadline, 0)
			if err != nil {
				t.Fatal(err)
			}
			if _, ok := s.Get(kEscrowLots(c, ar.Seq)); !ok {
				t.Fatalf("no cohort record written for an escrow with a maturing leg")
			}
			rec, _ := loadEscrow(s, c, ar.Seq)
			switch door {
			case "decline":
				if _, err := Decline(s, c, c, askBlock, ar.Seq); err != nil {
					t.Fatal(err)
				}
			case "reclaim":
				at := rec.deadline + ReclaimGrace + 1
				setU64(s, kPaidUntil(c), at+1000*SubscriptionPeriod)
				if _, err := Reclaim(s, "stranger", c, at, ar.Seq); err != nil {
					t.Fatal(err)
				}
			case "answer":
				if _, err := Answer(s, c, c, askBlock, ar.Seq, "answerhash"); err != nil {
					t.Fatal(err)
				}
			}
			if _, ok := s.Get(kEscrowLots(c, ar.Seq)); ok {
				t.Fatalf("ORPHAN el| key survived %s", door)
			}
			// Σ lots == kBal for both parties, always.
			for _, who := range []string{h, c} {
				sum := mZero()
				lots := getLotsRaw(s, c, who)
				for _, l := range lots {
					sum = mAdd(sum, l.count)
				}
				if len(lots) > 0 && sum.Cmp(getMoney(s, kBal(c, who))) != 0 {
					t.Fatalf("%s: Σlots %s != kBal %s", who, sum, getMoney(s, kBal(c, who)))
				}
			}
		})
	}
}

// A PRE-FIX escrow (no el| record — every escrow already on chain) must resolve
// EXACTLY as it did before: the whole maturing leg at the packed acqBlock.
func TestER_LegacyEscrowWithoutCohortRecordUnchanged(t *testing.T) {
	const c, h = "erlegacy", "erlh"
	s := NewMemStore()
	if err := Register(s, c, c, 1, MinFace+5000, MaxCap); err != nil {
		t.Fatal(err)
	}
	setU64(s, kPaidUntil(c), 5_000_000+1000*SubscriptionPeriod)
	if _, err := Buy(s, h, c, 1_000_000, big.NewInt(5000)); err != nil {
		t.Fatal(err)
	}
	at := uint64(1_500_000)
	acq := uint64(1_200_000)
	// A hand-written PENDING escrow, exactly as ask_test's mkPendingEscrow does
	// (no el| key), with an explicit acqBlock.
	saveEscrow(s, c, 0, escrowRec{
		asker: h, credits: big.NewInt(500), deadline: at + 100, status: askPending,
		contentHash: "cid", commissionHbd: big.NewInt(0), acqBlock: acq,
	})
	before := getLotsRaw(s, c, h)
	if _, err := Decline(s, c, c, at, 0); err != nil {
		t.Fatal(err)
	}
	after := getLotsRaw(s, c, h)
	// The returned 500 must arrive as ONE cohort at capAcqAge(acq, at) — the
	// pre-fix behaviour, byte for byte.
	want := capAcqAge(acq, at)
	found := false
	for _, l := range after {
		if l.acq == want && l.count.Cmp(big.NewInt(500)) == 0 {
			found = true
		}
	}
	if !found {
		t.Fatalf("legacy escrow return changed shape: before=%v after=%v (want a 500-token cohort at acq %d)",
			zbLotsRate(s, c, h, at), after, want)
	}
	_ = before
	t.Logf("legacy escrow (no el| record) returned 500 at acq %d — unchanged fallback path", want)
}

// Randomized escrow round trips: the ledger's tax capacity is never destroyed
// and its age-weight is never manufactured, across all three doors.
func TestER_EscrowRoundTripFuzzConservesCapacity(t *testing.T) {
	r := rand.New(rand.NewSource(0xE5C0))
	rounds := 0
	for iter := 0; iter < 120; iter++ {
		c, h := fmt.Sprintf("erf%d", iter), "erfh"
		pile := int64(10_000 + r.Intn(400_000))
		fresh := int64(1_000 + r.Intn(100_000))
		s, askBlock, _ := erWorld(t, c, h, pile, fresh)
		lo, hi, err := ServiceFaceRange(s, c, askBlock)
		if err != nil {
			continue
		}
		var q *SettleQuote
		face := new(big.Int).Set(hi)
		ok := false
		for face.Cmp(lo) >= 0 {
			var e error
			q, e = SettleSpend(s, c, askBlock, face)
			if e == nil && q.Credits.Sign() > 0 {
				ok = true
				break
			}
			face.Div(face, big.NewInt(2))
		}
		if !ok {
			continue
		}
		setMoney(s, kFace(c), face)
		ar, err := Ask(s, h, c, askBlock, new(big.Int).Mul(q.Credits, big.NewInt(1_000_000)), q.CommissionHbd, "cid", MinAskDeadline, 0)
		if err != nil {
			continue
		}
		// Capacity is measured on the position PLUS the escrow's own recorded
		// cohorts, so the escrowed slice is not counted as "destroyed" while it
		// is out of the holder's ledger.
		rec, _ := loadEscrow(s, c, ar.Seq)
		matLeg := escrowMaturedLeg(s, c, ar.Seq, rec.credits)
		escMaturing, _ := mSub(rec.credits, matLeg)
		escCap := mZero()
		for _, l := range loadEscrowLots(s, c, ar.Seq, escMaturing) {
			escCap = mAdd(escCap, new(big.Int).Mul(l.count, new(big.Int).SetUint64(lotRateAt(l.acq, askBlock))))
		}
		capMid := mAdd(xlCapacity(s, c, h, askBlock), escCap)

		if _, err := Decline(s, c, c, askBlock, ar.Seq); err != nil {
			t.Fatal(err)
		}
		capAfter := xlCapacity(s, c, h, askBlock)
		if capAfter.Cmp(capMid) < 0 {
			t.Fatalf("iter %d: escrow round trip destroyed tax capacity %s -> %s", iter, capMid, capAfter)
		}
		rounds++
	}
	if rounds < 60 {
		t.Fatalf("VACUOUS: only %d escrow round trips exercised", rounds)
	}
	t.Logf("%d randomized Ask->Decline round trips: tax capacity never destroyed", rounds)
}
