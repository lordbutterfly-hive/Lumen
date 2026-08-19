//go:build pruned_findings

// ════ AUDIT FINDING-DETECTOR, NOT A UNIT TEST ════
//
// This file FAILS ON PURPOSE. Each test asserts the ABSENCE of a defect the PRUNED audit
// of 2026-08-19 proved is PRESENT, so a failure here is the finding reproducing itself,
// not a regression.
//
// ★ IT IS BEHIND A BUILD TAG SO THE DEFAULT SUITE STAYS GREEN. Left untagged, `go test
// ./...` was red for reasons that are all known and documented - which destroys the one
// thing a suite is for: telling you when something NEW broke. A permanently-red suite is
// a suite nobody reads.
//
//   run the detectors:  go test -tags pruned_findings ./...
//   run the real suite: go test ./...
//
// When a finding is FIXED, its detector here starts passing. That is the intended signal:
// delete the test then, or move it into the real suite as a regression guard.
//
// Findings, artifacts and twins: /mnt/o/LUMEN-DOCS/audits/creator-tokens/2026-08-19/

package core

// ===========================================================================
// zz_pruned_phase1_maturity_test.go — PRUNED PHASE 1 (MATURITY).
//
// OWNS: H-12 ("an escrow round trip can DESTROY a position's maturity
// outright"), core INV-7 (the acq-block bounds at every write), core INV-9
// (the age-weight ledger is never INCREASED by a round trip) and the
// question INV-9 is silent about — whether it can be DECREASED.
//
// H-12's falsifiable statement, verbatim from hypotheses.md:
//
//	IF block < ExitTaxDecayBlocks at the moment of an Ask, THEN the escrow
//	stores acqBlock == 0, and on Decline or Reclaim the returned credits are
//	credited at wacq = resolutionBlock rather than at the asker's original
//	clock ... AND at block > ExitTaxDecayBlocks the identical sequence
//	preserves the clock exactly.
//
// The hypothesis names its own kill switch: "or the chain height already
// exceeds ExitTaxDecayBlocks at the deployment block, making the path
// unreachable forever (record it as STRUCTURAL, not exploitable, and say so
// plainly)". This file settles the REACHABILITY question inside the contract
// itself, which is stronger than a chain-height read: it asks whether the
// precondition (a non-empty MATURED bucket at block <= Dt) can be produced by
// the public API at all.
// ===========================================================================

import (
	"fmt"
	"math/big"
	"math/rand"
	"testing"
)

const (
	zp3Creator = "zp3c"
	zp3Holder  = "zp3h"
)

// zp3Market builds an ACTIVE market with `supply` outstanding and the reserve
// at exactly area(supply).
func zp3Market(s Store, supply int64, block uint64) {
	setU64(s, kRegisteredAt(zp3Creator), 1)
	setStr(s, kState(zp3Creator), StateActive)
	setU64(s, kPaidUntil(zp3Creator), block+1000*SubscriptionPeriod)
	setMoney(s, kCap(zp3Creator), big.NewInt(MaxCap))
	setMoney(s, kFace(zp3Creator), big.NewInt(MinFace))
	setMoney(s, kSupply(zp3Creator), big.NewInt(supply))
	setMoney(s, kReserve(zp3Creator), Area(big.NewInt(supply)))
}

// zp3Position describes what a holder owns and what it is worth in tax terms.
type zp3Position struct {
	maturing, matured *big.Int
	wacq              uint64
	heldBlocks        uint64
	taxBps            uint64
	// TaxOnFullExit is the exit tax this holder would owe if they sold their
	// ENTIRE position right now, computed exactly the way sellCompute does.
	// It is the single number that says whether maturity was destroyed:
	// maturity IS the right not to pay this.
	taxOnFullExit *big.Int
	// Tradable is the matured balance — the half that can leave the holder,
	// be listed on magi-market, and be spent through an allowance.
	tradable *big.Int
}

func zp3Read(t *testing.T, s Store, block uint64) zp3Position {
	t.Helper()
	p := zp3Position{
		maturing:   getMoney(s, kBal(zp3Creator, zp3Holder)),
		matured:    getMatured(s, zp3Creator, zp3Holder),
		wacq:       holderAcqBlock(s, zp3Creator, zp3Holder),
		heldBlocks: heldBlocksAt(s, zp3Creator, zp3Holder, block),
	}
	p.taxBps = ExitTaxBpsAt(p.heldBlocks)
	p.tradable = p.matured
	total := totalBalance(s, zp3Creator, zp3Holder)
	p.taxOnFullExit = big.NewInt(0)
	if total.Sign() > 0 {
		supply := getMoney(s, kSupply(zp3Creator))
		gross, err := SellProceeds(supply, total)
		if err != nil {
			t.Fatalf("SellProceeds(%s,%s): %v", supply, total, err)
		}
		_, fromMaturing := splitDraw(s, zp3Creator, zp3Holder, total)
		p.taxOnFullExit = ExitTaxOn(maturingGrossShare(gross, fromMaturing, total), p.taxBps)
	}
	return p
}

func (p zp3Position) String() string {
	return fmt.Sprintf("maturing=%s matured(tradable)=%s wacq=%d held=%d tau=%dbps taxOnFullExit=%s",
		p.maturing, p.matured, p.wacq, p.heldBlocks, p.taxBps, p.taxOnFullExit)
}

// zp3EscrowRoundTrip performs the EXACT sequence Ask does on its write path
// (ask.go:490-505) and then the exact sequence Decline/Reclaim do
// (ask.go:770-778 / :686-692), against a real store. It is the composition
// under test; the end-to-end public-API test below proves this composition is
// what production actually runs.
func zp3EscrowRoundTrip(t *testing.T, s Store, credits *big.Int, askBlock, resolveBlock uint64) uint64 {
	t.Helper()
	// --- Ask's write phase ---
	graduate(s, zp3Creator, zp3Holder, askBlock)
	fromMatured, _ := splitDraw(s, zp3Creator, zp3Holder, credits)
	acqAtEscrow := holderAcqBlock(s, zp3Creator, zp3Holder)
	if err := debitPosition(s, zp3Creator, zp3Holder, credits); err != nil {
		t.Fatalf("debitPosition: %v", err)
	}
	// UPDATED 2026-08-19 with the F2/F17 fix: Ask no longer blends the two
	// buckets into one clock, it records the matured leg beside the escrow and
	// clocks only the maturing leg. This helper claims to run "the EXACT
	// sequence Ask does", so it has to move with it — a helper still running the
	// old sequence would be measuring code that production no longer executes.
	zp3Seq := zp3NextSeq(s)
	if fromMatured.Sign() > 0 {
		setMoney(s, kEscrowMaturedLeg(zp3Creator, zp3Seq), fromMatured)
	}
	// --- the escrow record's round trip through pack/unpack, because the
	// stored acqBlock is what Decline actually reads back ---
	rec := escrowRec{
		asker: zp3Holder, credits: credits, deadline: askBlock + MinAskDeadline,
		status: askPending, commissionHbd: big.NewInt(0), acqBlock: acqAtEscrow,
	}
	packed := packEscrow(rec)
	back, ok := unpackEscrow(packed)
	if !ok {
		t.Fatalf("escrow record did not round-trip through pack/unpack: %q", packed)
	}
	if back.acqBlock != acqAtEscrow {
		t.Fatalf("acqBlock did not survive pack/unpack: wrote %d read %d", acqAtEscrow, back.acqBlock)
	}
	// --- Decline's / Reclaim's write phase ---
	graduate(s, zp3Creator, zp3Holder, resolveBlock)
	returnEscrowToOwner(s, zp3Creator, zp3Holder, zp3Seq, back.credits, back.acqBlock, resolveBlock)
	return acqAtEscrow
}

// zp3NextSeq hands out a fresh escrow sequence per round trip, exactly as
// kSeq does in production, so two round trips in one store cannot collide on
// the same matured-leg key.
func zp3NextSeq(s Store) uint64 {
	n := getU64(s, kSeq(zp3Creator))
	setU64(s, kSeq(zp3Creator), n+1)
	return n
}

// ---------------------------------------------------------------------------
// TEST 1 — H-12's REACHABILITY GATE, settled inside the contract.
//
// H-12 needs a non-empty MATURED bucket at a block below one decay window,
// because escrowAcqBlock only returns maturityFloorBlock(block) (== 0 there)
// when fromMaturing is zero, i.e. when the draw is wholly matured.
// This test asks whether that state can exist at all below Dt.
// ---------------------------------------------------------------------------

func TestZP1_H12_MaturedBucketIsUnreachableBelowOneDecayWindow(t *testing.T) {
	const seeds = 25
	const steps = 400
	rng := rand.New(rand.NewSource(31337))
	holders := []string{"zp3a", "zp3b", "zp3c2", "zp3d"}
	graduateAttempts, transferOps, buyOps, sellOps := 0, 0, 0, 0

	for seed := 0; seed < seeds; seed++ {
		s := NewMemStore()
		c := "zp3rc"
		if err := Register(s, c, c, 1, MinFace+5000, MaxCap); err != nil {
			t.Fatalf("Register: %v", err)
		}
		// Every block used below is <= ExitTaxDecayBlocks. That is the whole
		// premise: can ANY sequence confined to the first decay window put a
		// token into the matured (tradable) bucket?
		block := uint64(1)
		for i := 0; i < steps; i++ {
			h := holders[rng.Intn(len(holders))]
			switch rng.Intn(6) {
			case 0, 1:
				if _, err := Buy(s, h, c, block, big.NewInt(int64(1+rng.Intn(500)))); err == nil {
					buyOps++
				}
			case 2:
				to := holders[rng.Intn(len(holders))]
				bal := getMoney(s, kBal(c, h))
				if bal.Sign() > 0 && to != h {
					amt := big.NewInt(1 + rng.Int63n(bal.Int64()))
					if err := TransferCredits(s, h, c, h, to, block, amt); err == nil {
						transferOps++
					}
				}
			case 3:
				graduateAttempts++
				if n := Graduate(s, c, h, block); n.Sign() > 0 {
					t.Fatalf("REACHED: Graduate moved %s tokens into the MATURED bucket at block %d, "+
						"which is <= ExitTaxDecayBlocks (%d). H-12's precondition is REACHABLE.",
						n, block, ExitTaxDecayBlocks)
				}
			case 4:
				bal := totalBalance(s, c, h)
				if bal.Sign() > 0 {
					amt := big.NewInt(1 + rng.Int63n(bal.Int64()))
					if _, err := Sell(s, h, c, block, amt); err == nil {
						sellOps++
					}
				}
			case 5:
				// Advance, but NEVER past the window.
				step := uint64(1 + rng.Intn(60_000))
				if block+step > ExitTaxDecayBlocks {
					block = ExitTaxDecayBlocks
				} else {
					block += step
				}
			}
			// The invariant under test, checked after EVERY op, store-wide.
			for _, k := range s.Keys() {
				if len(k) > 4 && k[:4] == "bal|" {
					v, _ := s.Get(k)
					t.Fatalf("REACHED: a MATURED-bucket key %q exists at block %d (<= Dt=%d) holding %q. "+
						"H-12's precondition is REACHABLE.", k, block, ExitTaxDecayBlocks, v)
				}
			}
			// INV-7 at every write: 0 or maturityFloorBlock(block) <= wacq <= block.
			for _, hh := range holders {
				w := holderAcqBlock(s, c, hh)
				if w == 0 {
					continue
				}
				if lo := maturityFloorBlock(block); w < lo || w > block {
					t.Fatalf("INV-7 VIOLATED: wacq=%d outside [%d, %d] for %s at block %d", w, lo, block, hh, block)
				}
			}
		}
	}
	if graduateAttempts < 100 || buyOps < 100 {
		t.Fatalf("VACUOUS: only %d Graduate attempts and %d Buys — the walk did not exercise the path",
			graduateAttempts, buyOps)
	}
	t.Logf("SEARCH SPACE: %d seeds x %d ops, every block confined to [1, Dt=%d].\n"+
		"  ops that succeeded: buys=%d sells=%d transfers=%d; Graduate attempted %d times and moved ZERO tokens.\n"+
		"  VERDICT: the MATURED bucket cannot be non-empty at any block <= ExitTaxDecayBlocks.\n"+
		"  WHY, structurally: graduate() fires only on maturedNow(), which needs heldBlocksAt >= Dt;\n"+
		"  heldBlocksAt is block-wacq with wacq >= 1 for any clocked balance, so it needs block >= Dt+1.\n"+
		"  TransferMatured is the only other writer of bal| and it can only move tokens that are ALREADY there.\n"+
		"  H-12 ARM A IS THEREFORE STRUCTURALLY UNREACHABLE, not merely unreachable at the current chain height.",
		seeds, steps, ExitTaxDecayBlocks, buyOps, sellOps, transferOps, graduateAttempts)
}

// ---------------------------------------------------------------------------
// TEST 2 — H-12's MECHANISM, forced open with a fixture, both arms.
//
// Test 1 proves the public API cannot produce Arm A's precondition. This test
// FORCES it (planting a matured balance directly) purely to establish what
// WOULD happen, so the severity of any future change that makes it reachable
// is on record — and to run Arm B, which IS reachable, as the control.
// ---------------------------------------------------------------------------

func TestZP1_H12_PureMaturedEscrowRoundTrip_BothArms(t *testing.T) {
	run := func(askBlock uint64) (before, after zp3Position, storedAcq uint64) {
		s := NewMemStore()
		zp3Market(s, 100_000, askBlock)
		setMatured(s, zp3Creator, zp3Holder, big.NewInt(10_000))
		before = zp3Read(t, s, askBlock)
		storedAcq = zp3EscrowRoundTrip(t, s, big.NewInt(10_000), askBlock, askBlock+1)
		after = zp3Read(t, s, askBlock+1)
		return
	}

	// ---- ARM A: below one decay window (STRUCTURALLY UNREACHABLE, per test 1)
	aBefore, aAfter, aAcq := run(1_000)
	t.Logf("ARM A  askBlock=1000 (< Dt=%d), maturityFloorBlock=%d, escrow stored acqBlock=%d",
		ExitTaxDecayBlocks, maturityFloorBlock(1_000), aAcq)
	t.Logf("  before: %s", aBefore)
	t.Logf("  after : %s", aAfter)

	// ---- ARM B: past one decay window (the live-chain regime)
	bBlock := ExitTaxDecayBlocks + 1_000
	bBefore, bAfter, bAcq := run(bBlock)
	t.Logf("ARM B  askBlock=%d (> Dt), maturityFloorBlock=%d, escrow stored acqBlock=%d",
		bBlock, maturityFloorBlock(bBlock), bAcq)
	t.Logf("  before: %s", bBefore)
	t.Logf("  after : %s", bAfter)

	// Arm B is the control and MUST preserve the maturity — if it does not,
	// H-12 is live on the real chain and this is no longer a latent finding.
	if bAfter.taxOnFullExit.Sign() != 0 {
		t.Errorf("ARM B (REACHABLE, live-chain regime): a pure-matured escrow round trip left the "+
			"holder owing %s base units of exit tax on a position that owed 0 before. taxBps went %d -> %d.",
			bAfter.taxOnFullExit, bBefore.taxBps, bAfter.taxBps)
	}
	if bAfter.heldBlocks != ExitTaxDecayBlocks {
		t.Errorf("ARM B: heldBlocksAt after the round trip = %d, want the full window %d",
			bAfter.heldBlocks, ExitTaxDecayBlocks)
	}

	// Arm A is the forced arm. Report what it does; do NOT fail on it, because
	// test 1 proved the state cannot be built through the public API.
	if aAfter.taxBps > aBefore.taxBps {
		t.Logf("H-12 MECHANISM CONFIRMED (Arm A, FORCED STATE ONLY): escrowAcqBlock stored %d, which "+
			"unpackEscrow reads back as 0; creditInflowAt treats a stored 0 as UNSET and degrades it to "+
			"`block` (holdclock.go's zero-value convention), so the returned tokens come back MAXIMALLY "+
			"FRESH. tau went %d bps -> %d bps and the tax owed on a full exit went %s -> %s base units.\n"+
			"  REACHABILITY: STRUCTURALLY UNREACHABLE — see "+
			"TestZP1_H12_MaturedBucketIsUnreachableBelowOneDecayWindow. The matured bucket cannot be "+
			"non-empty below Dt, so escrowAcqBlock's fromMaturing==0 branch cannot be entered there.",
			aAcq, aBefore.taxBps, aAfter.taxBps, aBefore.taxOnFullExit, aAfter.taxOnFullExit)
	} else {
		t.Logf("H-12 Arm A: the clock was PRESERVED even in the forced state (tau %d -> %d). "+
			"The hypothesis's mechanism does not reproduce.", aBefore.taxBps, aAfter.taxBps)
	}

	// The tradable-bucket consequence, which applies to BOTH arms and IS
	// reachable: the returned tokens land in the MATURING family.
	t.Logf("BUCKET MIGRATION (both arms, and Arm B IS reachable): before the round trip the holder had "+
		"%s tradable tokens; after Decline/Reclaim they have %s tradable and %s maturing. The tokens "+
		"return to the MATURING family and are invisible to magi-market (which reads bal|) until someone "+
		"calls Graduate again.", bBefore.tradable, bAfter.tradable, bAfter.maturing)
}

// ---------------------------------------------------------------------------
// TEST 3 — the REACHABLE half of H-12: a MIXED escrow round trip.
//
// A holder who straddles both buckets and escrows MORE than their maturing
// balance draws from both. escrowAcqBlock then collapses the two clocks to a
// size-weighted mean, and the whole draw comes back into the MATURING family
// at that mean. This IS reachable at live-chain heights. The question is what
// it costs the holder — in tax, and in tradability.
// ---------------------------------------------------------------------------

func TestZP1_H12_MixedEscrowRoundTrip_TaxAndTradability(t *testing.T) {
	block := ExitTaxDecayBlocks + 2_000_000
	type cell struct {
		maturing, matured, escrow int64
		held                      uint64
	}
	cells := []cell{
		{1_000, 9_000, 10_000, 0},
		{1_000, 9_000, 5_000, 0},
		{5_000, 5_000, 7_500, ExitTaxDecayBlocks / 2},
		{100, 100_000, 100_100, 0},
		{9_000, 1_000, 10_000, ExitTaxDecayBlocks - 1},
		{1, 99_999, 100_000, 0},
	}
	var lines []string
	worstTaxIncrease := big.NewInt(0)
	worstTradableLoss := big.NewInt(0)
	var worstAt string

	for _, c := range cells {
		s := NewMemStore()
		zp3Market(s, 500_000, block)
		setMoney(s, kBal(zp3Creator, zp3Holder), big.NewInt(c.maturing))
		setU64(s, kAcqBlock(zp3Creator, zp3Holder), block-c.held)
		setMatured(s, zp3Creator, zp3Holder, big.NewInt(c.matured))

		before := zp3Read(t, s, block)
		acq := zp3EscrowRoundTrip(t, s, big.NewInt(c.escrow), block, block+1)
		after := zp3Read(t, s, block+1)

		taxDelta := new(big.Int).Sub(after.taxOnFullExit, before.taxOnFullExit)
		tradableDelta := new(big.Int).Sub(before.tradable, after.tradable)
		// How long until the returned tokens are tradable again?
		var blocksToRegraduate uint64
		if after.heldBlocks < ExitTaxDecayBlocks && after.wacq > 0 {
			blocksToRegraduate = after.wacq + ExitTaxDecayBlocks - (block + 1)
		}
		lines = append(lines, fmt.Sprintf(
			"    M=%-7d T=%-7d escrow=%-7d held=%-8d | storedAcq=%-9d | tax %s -> %s (delta %s) | "+
				"tradable %s -> %s (lost %s) | re-graduates in %d blocks (%.1f days)",
			c.maturing, c.matured, c.escrow, c.held, acq,
			before.taxOnFullExit, after.taxOnFullExit, taxDelta,
			before.tradable, after.tradable, tradableDelta,
			blocksToRegraduate, float64(blocksToRegraduate)/float64(BlocksPerDay)))

		if taxDelta.Cmp(worstTaxIncrease) > 0 {
			worstTaxIncrease = taxDelta
			worstAt = fmt.Sprintf("M=%d T=%d escrow=%d held=%d", c.maturing, c.matured, c.escrow, c.held)
		}
		if tradableDelta.Cmp(worstTradableLoss) > 0 {
			worstTradableLoss = tradableDelta
		}

		// INV-7 at the write.
		if w := after.wacq; w != 0 {
			if lo := maturityFloorBlock(block + 1); w < lo || w > block+1 {
				t.Errorf("INV-7 VIOLATED after a mixed round trip: wacq=%d outside [%d,%d]", w, lo, block+1)
			}
		}
	}

	t.Logf("MIXED ESCROW ROUND TRIP (Ask then Decline/Reclaim), live-chain block %d:\n%s\n"+
		"  WORST TAX INCREASE: %s base units (%s)\n"+
		"  WORST TRADABLE-BUCKET LOSS: %s tokens\n"+
		"  READING: the tax is (near) NEUTRAL — escrowAcqBlock's size-weighted mean is exact against the\n"+
		"  affine rate schedule, so the blended clock charges what the two buckets charged separately.\n"+
		"  What the round trip DOES destroy is TRADABILITY: matured tokens come back in the MATURING\n"+
		"  family, invisible to magi-market and unmovable through doors.go, until the whole blended\n"+
		"  position clears the window again.",
		block, joinLines(lines), worstTaxIncrease, worstAt, worstTradableLoss)
}

// ---------------------------------------------------------------------------
// TEST 4 — INV-9, BOTH directions, over a random search.
//
//	INV-9 as stated: the age-weight ledger is never INCREASED by a transfer,
//	an escrow round trip, or an Answer.
//	The model records that INV-9 is SILENT about a DECREASE. This test
//	measures both.
// ---------------------------------------------------------------------------

// zp3AgeWeight is W = Σ_h [ maturing(h)·min(age(h), Dt) + matured(h)·Dt ].
//
// ★ THE MATURED TERM IS LOAD-BEARING AND I GOT IT WRONG FIRST. My first version
// summed the MATURING family only. That produced 400+ apparent INV-9
// "violations" in this very test, every one of them an artifact: an escrow
// round trip moves matured tokens back INTO the maturing family, so a ledger
// that measures only the maturing family sees weight appear from nowhere.
// A matured token has served the full window, so its contribution is bal·Dt,
// frozen there — counting only one bucket makes "no operation increases W"
// trivially satisfiable by moving tokens out of the thing being measured.
// (maturity_property_test.go's mpAgeWeight makes the identical argument for
// the identical reason; this is an independent implementation of the same
// predicate, not a call into theirs.)
func zp3AgeWeight(s Store, c string, holders []string, block uint64) *big.Int {
	w := big.NewInt(0)
	for _, h := range holders {
		m := getMoney(s, kBal(c, h))
		if m.Sign() > 0 {
			acq := holderAcqBlock(s, c, h)
			var age uint64
			if acq != 0 && block > acq {
				age = block - acq
			}
			if age > ExitTaxDecayBlocks {
				age = ExitTaxDecayBlocks
			}
			w.Add(w, new(big.Int).Mul(m, new(big.Int).SetUint64(age)))
		}
		if md := getMatured(s, c, h); md.Sign() > 0 {
			w.Add(w, new(big.Int).Mul(md, new(big.Int).SetUint64(ExitTaxDecayBlocks)))
		}
	}
	return w
}

// zp3Capacity is the market's total tax CAPACITY, Sigma bal*tau, read through the
// real rate path. Matured tokens contribute exactly zero, which is what
// "matured" means. Same predicate maturity_property_test.go's mpTotals uses.
func zp3Capacity(s Store, c string, holders []string, block uint64) (bal, capacity *big.Int) {
	bal, capacity = big.NewInt(0), big.NewInt(0)
	for _, h := range holders {
		m := getMoney(s, kBal(c, h))
		if m.Sign() > 0 {
			bal.Add(bal, m)
			tau := ExitTaxBpsAt(heldBlocksAt(s, c, h, block))
			capacity.Add(capacity, new(big.Int).Mul(m, new(big.Int).SetUint64(tau)))
		}
		bal.Add(bal, getMatured(s, c, h))
	}
	return bal, capacity
}

// TestZP1_INV9_EscrowRoundTripManufacturesAgeWeight
//
// core INV-9: "The age-weight ledger Sigma_h (M(c,h) * min(age, Dt)) is never
// INCREASED by a transfer, an ESCROW ROUND TRIP (Ask then Reclaim/Decline), or
// an Answer. P2, maturity_property_test.go:413."
//
// WHY THIS TEST EXISTS: TestP2_NoManufacture_AgeWeightLedger drives Buy,
// TransferCredits and Sell ONLY. It never calls Ask, Reclaim, Decline or
// Answer. So the escrow-round-trip half of INV-9 has never been executed by
// anything. This runs it.
//
// The escrow round trip differs from every op P2 covers in one way that
// matters: it has a DURATION. escrowAcqBlock collapses the two buckets to a
// size-weighted mean AT ASK TIME, using maturityFloorBlock(askBlock) to stand
// for the matured portion. That representation is exact only at askBlock. The
// escrow then sits, and the stored mean keeps aging with the block, so the
// matured portion's age runs past Dt inside the blend instead of being clipped
// at it — and the excess is shared with the maturing portion when the credits
// come back.
//
// Both the ledger delta and the ECONOMIC delta (tax capacity against an
// honest control that merely waits the same number of blocks) are measured.
func TestZP1_INV9_EscrowRoundTripManufacturesAgeWeight(t *testing.T) {
	const iters = 6000
	rng := rand.New(rand.NewSource(90210))
	holders := []string{zp3Holder}
	block := ExitTaxDecayBlocks + 5_000_000

	wIncreases, wDecreases, wExact := 0, 0, 0
	maxWIncrease := big.NewInt(0)
	var maxWAt string
	// capacity delta < 0 == the holder owes LESS tax than if they had simply
	// waited the same number of blocks without escrowing.
	capCheaper, capDearer, capSame := 0, 0, 0
	worstCapPct := int64(0) // basis points of the control capacity
	worstCapAbs := big.NewInt(0)
	var worstCapAt string
	unitTieBreaks := 0

	for i := 0; i < iters; i++ {
		m := int64(rng.Intn(50_000))
		tk := int64(rng.Intn(50_000))
		if m+tk < 2 {
			continue
		}
		held := uint64(rng.Int63n(int64(ExitTaxDecayBlocks) + 1))
		escrow := int64(1 + rng.Int63n(m+tk))
		// Gaps as production actually produces them:
		//   Decline  legal for gap in [0, deadline], deadline in [1d, 30d]
		//   Reclaim  legal only for gap > deadline + ReclaimGrace
		var gap uint64
		switch rng.Intn(3) {
		case 0:
			gap = uint64(rng.Int63n(int64(MinAskDeadline) + 1)) // prompt Decline
		case 1:
			gap = MinAskDeadline + uint64(rng.Int63n(int64(MaxAskDeadline-MinAskDeadline))) // late Decline
		default:
			gap = MaxAskDeadline + ReclaimGrace + uint64(rng.Int63n(int64(BlocksPerDay))) // Reclaim
		}
		measureAt := block + gap

		build := func() *MemStore {
			st := NewMemStore()
			zp3Market(st, 500_000, block)
			if m > 0 {
				setMoney(st, kBal(zp3Creator, zp3Holder), big.NewInt(m))
				setU64(st, kAcqBlock(zp3Creator, zp3Holder), block-held)
			}
			if tk > 0 {
				setMatured(st, zp3Creator, zp3Holder, big.NewInt(tk))
			}
			return st
		}

		// CONTROL: the holder does nothing at all and simply waits `gap`.
		control := build()
		wBefore := zp3AgeWeight(control, zp3Creator, holders, measureAt)
		_, capControl := zp3Capacity(control, zp3Creator, holders, measureAt)

		// ARM: the holder escrows at `block` and gets the credits back at
		// `measureAt` (Decline or Reclaim — both take the identical path).
		arm := build()
		zp3EscrowRoundTrip(t, arm, big.NewInt(escrow), block, measureAt)
		wAfter := zp3AgeWeight(arm, zp3Creator, holders, measureAt)
		balArm, capArm := zp3Capacity(arm, zp3Creator, holders, measureAt)

		switch wAfter.Cmp(wBefore) {
		case 1:
			wIncreases++
			if d := new(big.Int).Sub(wAfter, wBefore); d.Cmp(maxWIncrease) > 0 {
				maxWIncrease = d
				maxWAt = fmt.Sprintf("M=%d T=%d held=%d escrow=%d gap=%d: W %s -> %s", m, tk, held, escrow, gap, wBefore, wAfter)
			}
		case -1:
			wDecreases++
		default:
			wExact++
		}

		// P2's unit tie, re-checked on the arm: capacity*Dt >= MaxExitTaxBps*(bal*Dt - W).
		lhs := new(big.Int).Mul(capArm, new(big.Int).SetUint64(ExitTaxDecayBlocks))
		rhs := new(big.Int).Sub(new(big.Int).Mul(balArm, new(big.Int).SetUint64(ExitTaxDecayBlocks)), wAfter)
		rhs.Mul(rhs, new(big.Int).SetUint64(MaxExitTaxBps))
		if lhs.Cmp(rhs) < 0 {
			unitTieBreaks++
		}

		switch capArm.Cmp(capControl) {
		case -1:
			capCheaper++
			abs := new(big.Int).Sub(capControl, capArm)
			if capControl.Sign() > 0 {
				pct := new(big.Int).Div(new(big.Int).Mul(abs, big.NewInt(10000)), capControl)
				if pct.Int64() > worstCapPct {
					worstCapPct = pct.Int64()
					worstCapAbs = abs
					worstCapAt = fmt.Sprintf("M=%d T=%d held=%d escrow=%d gap=%d (%.1f days): capacity %s -> %s token*bps",
						m, tk, held, escrow, gap, float64(gap)/float64(BlocksPerDay), capControl, capArm)
				}
			}
		case 1:
			capDearer++
		default:
			capSame++
		}
	}

	total := wIncreases + wDecreases + wExact
	if total < 3000 {
		t.Fatalf("VACUOUS: only %d comparisons ran", total)
	}
	t.Logf("SEARCH SPACE: %d randomized escrow round trips.\n"+
		"  generators: M,T ~ U[0,50000); held ~ U[0,Dt]; escrow ~ U[1,M+T]; resolution gap drawn from the\n"+
		"  THREE windows production allows (prompt Decline, late Decline, Reclaim past deadline+grace).\n"+
		"  Both arms are read at the SAME block, so time passing is not what is being measured.\n"+
		"\n"+
		"  AGE-WEIGHT LEDGER W = Sigma[maturing*min(age,Dt) + matured*Dt]:\n"+
		"    INCREASED %d   DECREASED %d   EXACTLY PRESERVED %d\n"+
		"    largest increase: %s token*blocks  (%s)\n"+
		"\n"+
		"  TAX CAPACITY (Sigma bal*tau) vs an honest control that waits the same blocks and does NOT escrow:\n"+
		"    escrow arm CHEAPER for the holder: %d    dearer: %d    identical: %d\n"+
		"    worst holder-favouring reduction: %d.%02d%% (%s token*bps) at %s\n"+
		"    P2 unit-tie (capacity*Dt >= MaxBps*(bal*Dt - W)) broken in %d of %d cases",
		iters, wIncreases, wDecreases, wExact, maxWIncrease, maxWAt,
		capCheaper, capDearer, capSame, worstCapPct/100, worstCapPct%100, worstCapAbs, worstCapAt,
		unitTieBreaks, total)

	if wIncreases > 0 {
		t.Errorf("INV-9 VIOLATED: an escrow round trip INCREASED the age-weight ledger in %d of %d cases "+
			"(largest +%s token*blocks). INV-9 names the escrow round trip explicitly, and "+
			"TestP2_NoManufacture_AgeWeightLedger — the test INV-9 cites — drives only Buy, "+
			"TransferCredits and Sell, so this arm of the invariant had never been executed.",
			wIncreases, total, maxWIncrease)
	}
}

// ---------------------------------------------------------------------------
// TEST 5 — END-TO-END through the PUBLIC API, so tests 2-4 are not merely
// testing a composition of helpers that production might not actually run.
// ---------------------------------------------------------------------------

func TestZP1_H12_EndToEnd_AskDeclineThroughPublicAPI(t *testing.T) {
	s := NewMemStore()
	const c = "zp3e2ec"
	const h = "zp3e2eh"
	if err := Register(s, c, c, 1, MinFace+5000, MaxCap); err != nil {
		t.Fatalf("Register: %v", err)
	}
	// Buy, then wait a full decay window so the position GRADUATES for real.
	if _, err := Buy(s, h, c, 10, big.NewInt(1_000)); err != nil {
		t.Fatalf("Buy: %v", err)
	}
	matureBlock := ExitTaxDecayBlocks + 100
	setU64(s, kPaidUntil(c), matureBlock+1000*SubscriptionPeriod)
	if n := Graduate(s, c, h, matureBlock); n.Cmp(big.NewInt(1_000)) != 0 {
		t.Fatalf("Graduate moved %s, want 1000 — the position did not mature as expected", n)
	}
	// Now buy a small FRESH slice so the position straddles both buckets.
	if _, err := Buy(s, h, c, matureBlock, big.NewInt(50)); err != nil {
		t.Fatalf("second Buy: %v", err)
	}
	if got := getMatured(s, c, h); got.Cmp(big.NewInt(1_000)) != 0 {
		t.Fatalf("matured = %s, want 1000", got)
	}
	if got := getMoney(s, kBal(c, h)); got.Cmp(big.NewInt(50)) != 0 {
		t.Fatalf("maturing = %s, want 50", got)
	}

	// Drive a REAL Ask -> Decline.
	askBlock := zp1SeedObs(s, c, matureBlock+1)
	setU64(s, kPaidUntil(c), askBlock+1000*SubscriptionPeriod)
	lo, _, err := ServiceFaceRange(s, c, askBlock)
	if err != nil {
		t.Fatalf("ServiceFaceRange: %v", err)
	}
	setMoney(s, kFace(c), lo)
	q, err := SettleSpend(s, c, askBlock, lo)
	if err != nil {
		t.Fatalf("SettleSpend: %v", err)
	}
	maturingBefore := getMoney(s, kBal(c, h))
	maturedBefore := getMatured(s, c, h)
	heldBefore := heldBlocksAt(s, c, h, askBlock)

	ar, err := Ask(s, h, c, askBlock, new(big.Int).Mul(q.Credits, big.NewInt(10)), q.CommissionHbd, "cid", MinAskDeadline, 0)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	rec, ok := loadEscrow(s, c, ar.Seq)
	if !ok {
		t.Fatalf("escrow not found")
	}
	t.Logf("END-TO-END: credits escrowed=%s, escrow acqBlock stored=%d (maturityFloorBlock(%d)=%d, "+
		"holder wacq before=%d)", ar.CreditsSpent, rec.acqBlock, askBlock, maturityFloorBlock(askBlock),
		holderAcqBlock(s, c, h))

	if _, err := Decline(s, c, c, askBlock+1, ar.Seq); err != nil {
		t.Fatalf("Decline: %v", err)
	}
	maturingAfter := getMoney(s, kBal(c, h))
	maturedAfter := getMatured(s, c, h)
	heldAfter := heldBlocksAt(s, c, h, askBlock+1)

	t.Logf("  before Ask : maturing=%s matured=%s held=%d tau=%d bps",
		maturingBefore, maturedBefore, heldBefore, ExitTaxBpsAt(heldBefore))
	t.Logf("  after Decline: maturing=%s matured=%s held=%d tau=%d bps",
		maturingAfter, maturedAfter, heldAfter, ExitTaxBpsAt(heldAfter))

	if rec.acqBlock == 0 {
		t.Errorf("END-TO-END H-12 CONFIRMED: the escrow stored acqBlock == 0 at block %d, which "+
			"creditInflowAt reads as UNSET and degrades to maximally fresh", askBlock)
	}
	// The composition tested in tests 2-4 must be the one production runs.
	if maturedBefore.Sign() > 0 && ar.CreditsSpent.Cmp(maturingBefore) > 0 && maturedAfter.Cmp(maturedBefore) >= 0 {
		t.Errorf("the end-to-end draw did not touch the matured bucket as splitDraw says it must")
	}
	if maturedBefore.Sign() > 0 && ar.CreditsSpent.Cmp(maturingBefore) <= 0 {
		t.Logf("  (this ask drew wholly from the maturing bucket — credits=%s <= maturing=%s — so the "+
			"matured bucket was untouched, which is splitDraw's maturing-first rule doing its job)",
			ar.CreditsSpent, maturingBefore)
	}
}

// ---------------------------------------------------------------------------
// TEST 6 — THE MONEY SHOT. Drive the whole thing through the PUBLIC API,
// under the REAL settlement caps, and price it.
//
// Tests 3-5 exercise the same helper composition production runs, but a
// composition test can always be accused of running a sequence production
// never assembles. This one uses nothing but Register / Buy / Graduate /
// Ask / Reclaim, obeys the 5%-of-supply spend cap and the depth ceiling that
// settleSpend enforces, and compares the holder's exit tax against a CONTROL
// holder who owns the identical position and simply waits the same blocks.
//
// If the escrow arm owes less than the control, an escrow round trip bought
// maturity that time alone would not have.
// ---------------------------------------------------------------------------

func TestZP1_H12_EndToEnd_EscrowRoundTripAcceleratesMaturity(t *testing.T) {
	const (
		c        = "zp3m6c"
		attacker = "zp3m6a" // straddles both buckets, escrows, reclaims
		control  = "zp3m6b" // identical position, does nothing at all
		aged     = int64(100_000)
		fresh    = int64(5_000)
	)
	s := NewMemStore()
	if err := Register(s, c, c, 1, MinFace+5000, MaxCap); err != nil {
		t.Fatalf("Register: %v", err)
	}
	for _, h := range []string{attacker, control} {
		if _, err := Buy(s, h, c, 10, big.NewInt(aged)); err != nil {
			t.Fatalf("Buy(%s): %v", h, err)
		}
	}
	matureBlock := ExitTaxDecayBlocks + 100
	setU64(s, kPaidUntil(c), matureBlock+100_000*SubscriptionPeriod)
	for _, h := range []string{attacker, control} {
		if n := Graduate(s, c, h, matureBlock); n.Cmp(big.NewInt(aged)) != 0 {
			t.Fatalf("Graduate(%s) moved %s, want %d", h, n, aged)
		}
		if _, err := Buy(s, h, c, matureBlock, big.NewInt(fresh)); err != nil {
			t.Fatalf("fresh Buy(%s): %v", h, err)
		}
	}

	askBlock := zp1SeedObs(s, c, matureBlock+1)
	setU64(s, kPaidUntil(c), askBlock+100_000*SubscriptionPeriod)

	// Post the LARGEST legal face, so the ask escrows as many credits as the
	// depth ceiling and the 5%-of-supply spend cap allow. That cap is what
	// bounds this whole finding, so it must bind here rather than be dodged.
	lo, hi, err := ServiceFaceRange(s, c, askBlock)
	if err != nil {
		t.Fatalf("ServiceFaceRange: %v", err)
	}
	var face, quoteCredits *big.Int
	// Walk the posted face down from the ceiling until settleSpend accepts it.
	for f := new(big.Int).Set(hi); f.Cmp(lo) >= 0; f.Div(f, big.NewInt(2)) {
		if q, err := SettleSpend(s, c, askBlock, f); err == nil {
			face, quoteCredits = new(big.Int).Set(f), q.Credits
			break
		}
	}
	if face == nil {
		t.Fatalf("no legal face in [%s,%s] settled at supply %s", lo, hi, getMoney(s, kSupply(c)))
	}
	setMoney(s, kFace(c), face)
	q, err := SettleSpend(s, c, askBlock, face)
	if err != nil {
		t.Fatalf("SettleSpend: %v", err)
	}
	supply := getMoney(s, kSupply(c))
	spendCapPct := new(big.Int).Div(new(big.Int).Mul(q.Credits, big.NewInt(10000)), supply)
	t.Logf("SETUP: supply=%s, posted face=%s (legal window [%s,%s]), rate=%s, "+
		"escrow size=%s credits = %d.%02d%% of supply (spend cap is %d bps)",
		supply, face, lo, hi, q.Rate, q.Credits,
		spendCapPct.Int64()/100, spendCapPct.Int64()%100, MaxSpendSupplyBps)
	_ = quoteCredits

	maturingBefore := getMoney(s, kBal(c, attacker))
	if q.Credits.Cmp(maturingBefore) <= 0 {
		t.Fatalf("the ask (%s credits) does not exceed the maturing balance (%s), so the draw would not "+
			"straddle both buckets and this test would be vacuous", q.Credits, maturingBefore)
	}

	ar, err := Ask(s, attacker, c, askBlock, new(big.Int).Mul(q.Credits, big.NewInt(2)), q.CommissionHbd, "cid", MaxAskDeadline, 0)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	rec, _ := loadEscrow(s, c, ar.Seq)
	t.Logf("ASK at block %d: escrowed %s credits (maturing before = %s, so %s came out of the MATURED "+
		"bucket). escrow acqBlock stored = %d; maturityFloorBlock(askBlock) = %d; holder wacq was %d",
		askBlock, ar.CreditsSpent, maturingBefore,
		new(big.Int).Sub(ar.CreditsSpent, maturingBefore), rec.acqBlock, maturityFloorBlock(askBlock),
		holderAcqBlock(s, c, attacker))

	// The creator never answers. The asker reclaims their OWN escrow the first
	// block it is legal — permissionless, so nobody's cooperation is needed.
	reclaimBlock := rec.deadline + ReclaimGrace + 1
	rr, err := Reclaim(s, attacker, c, reclaimBlock, ar.Seq)
	if err != nil {
		t.Fatalf("Reclaim at %d: %v", reclaimBlock, err)
	}
	gap := reclaimBlock - askBlock

	// ---- price both holders at the SAME block ----
	tauA := ExitTaxBpsAt(heldBlocksAt(s, c, attacker, reclaimBlock))
	tauC := ExitTaxBpsAt(heldBlocksAt(s, c, control, reclaimBlock))
	balA := totalBalance(s, c, attacker)
	balC := totalBalance(s, c, control)

	exitTaxFor := func(h string) (*big.Int, *big.Int) {
		bal := totalBalance(s, c, h)
		sup := getMoney(s, kSupply(c))
		gross, err := SellProceeds(sup, bal)
		if err != nil {
			t.Fatalf("SellProceeds: %v", err)
		}
		_, fromMaturing := splitDraw(s, c, h, bal)
		tau := ExitTaxBpsAt(heldBlocksAt(s, c, h, reclaimBlock))
		return gross, ExitTaxOn(maturingGrossShare(gross, fromMaturing, bal), tau)
	}
	grossA, taxA := exitTaxFor(attacker)
	grossC, taxC := exitTaxFor(control)

	t.Logf("RECLAIM at block %d (gap = %d blocks = %.1f days; commission returned %s, retained %s):",
		reclaimBlock, gap, float64(gap)/float64(BlocksPerDay), rr.CommissionHbd, rr.CommissionRetainedHbd)
	t.Logf("  ESCROWER : total=%s maturing=%s matured=%s wacq=%d held=%d tau=%d bps  full-exit gross=%s TAX=%s",
		balA, getMoney(s, kBal(c, attacker)), getMatured(s, c, attacker),
		holderAcqBlock(s, c, attacker), heldBlocksAt(s, c, attacker, reclaimBlock), tauA, grossA, taxA)
	t.Logf("  CONTROL  : total=%s maturing=%s matured=%s wacq=%d held=%d tau=%d bps  full-exit gross=%s TAX=%s",
		balC, getMoney(s, kBal(c, control)), getMatured(s, c, control),
		holderAcqBlock(s, c, control), heldBlocksAt(s, c, control, reclaimBlock), tauC, grossC, taxC)

	if balA.Cmp(balC) != 0 {
		t.Fatalf("the two holders no longer own the same number of tokens (%s vs %s) — the comparison is invalid", balA, balC)
	}
	if taxA.Cmp(taxC) < 0 {
		saved := new(big.Int).Sub(taxC, taxA)
		pct := new(big.Int).Div(new(big.Int).Mul(saved, big.NewInt(10000)), taxC)
		t.Errorf("H-12 CONFIRMED END-TO-END, through Register/Buy/Graduate/Ask/Reclaim only, under the "+
			"5%%-of-supply spend cap and the depth ceiling.\n"+
			"  Two holders, IDENTICAL positions (%d aged + %d fresh tokens), priced at the SAME block %d.\n"+
			"  The one who opened ONE ask and reclaimed it owes %s base units of exit tax.\n"+
			"  The one who did nothing owes %s.\n"+
			"  SAVED: %s base units = %d.%02d%% of the tax owed, for the cost of one unanswered ask.\n"+
			"  MECHANISM: escrowAcqBlock (matured.go:235) represents the MATURED leg of a mixed draw by\n"+
			"  maturityFloorBlock(askBlock) and collapses both legs to a size-weighted mean. That mean is\n"+
			"  exactly tax-neutral AT askBlock, because the rate is affine in age there — but it is stored\n"+
			"  as an ABSOLUTE block and then ages for the whole escrow. Over a gap of g blocks the blended\n"+
			"  pool of A tokens decays at A*slope while the honest M maturing tokens decay at M*slope, so\n"+
			"  the matured leg donates (A-M)*g*MaxExitTaxBps/Dt of decay it was never entitled to spend\n"+
			"  (its own age was already at the cap and therefore free).\n"+
			"  The clamp in creditInflowAt does NOT catch it: capAcqAge only RAISES a clock that is older\n"+
			"  than one window, and one window of age is exactly tau == 0.",
			aged, fresh, reclaimBlock, taxA, taxC, saved, pct.Int64()/100, pct.Int64()%100)
	} else {
		t.Logf("  the escrow arm owes %s, the control %s — no acceleration at this size; the 5%%-of-supply "+
			"spend cap held the matured leg of the draw to %s tokens.",
			taxA, taxC, new(big.Int).Sub(ar.CreditsSpent, maturingBefore))
	}
}

// ---------------------------------------------------------------------------
// TEST 7 — THE ZERO-COST VARIANT.
//
// Test 6 proves the mechanism but pays for it: Reclaim retains
// MissReclaimSliceBps (25%) of the held commission, and at the maximum posted
// face that retention exceeded the tax saved. A finding is only a finding if
// the attacker comes out ahead, so this test closes the cost side.
//
// Two costless doors exist and both are ordinary, ruled behaviour:
//
//	(a) DECLINE returns 100% of the commission — "a creator's free, honest no"
//	    (ask.go:757). The asker pays nothing.
//	(b) Reclaim's retention is SKIPPED entirely when rec.asker == creator
//	    (ask.go:710, `if rec.asker != creator`), because a self-dealt escrow is
//	    not a miss.
//
// A creator holding their own market's tokens can therefore run (a)+(b)
// unilaterally: open an ask against themselves, decline it (or reclaim it),
// and pay ZERO. This test does exactly that and prices the result.
// ---------------------------------------------------------------------------

func TestZP1_H12_EndToEnd_ZeroCostSelfAskLaunder(t *testing.T) {
	const (
		c       = "zp3m7c"
		control = "zp3m7b"
		aged    = int64(100_000)
		fresh   = int64(5_000)
	)
	s := NewMemStore()
	if err := Register(s, c, c, 1, MinFace+5000, MaxCap); err != nil {
		t.Fatalf("Register: %v", err)
	}
	for _, h := range []string{c, control} {
		if _, err := Buy(s, h, c, 10, big.NewInt(aged)); err != nil {
			t.Fatalf("Buy(%s): %v", h, err)
		}
	}
	matureBlock := ExitTaxDecayBlocks + 100
	setU64(s, kPaidUntil(c), matureBlock+100_000*SubscriptionPeriod)
	for _, h := range []string{c, control} {
		if n := Graduate(s, c, h, matureBlock); n.Cmp(big.NewInt(aged)) != 0 {
			t.Fatalf("Graduate(%s) moved %s", h, n)
		}
		if _, err := Buy(s, h, c, matureBlock, big.NewInt(fresh)); err != nil {
			t.Fatalf("fresh Buy(%s): %v", h, err)
		}
	}

	askBlock := zp1SeedObs(s, c, matureBlock+1)
	setU64(s, kPaidUntil(c), askBlock+100_000*SubscriptionPeriod)
	lo, hi, err := ServiceFaceRange(s, c, askBlock)
	if err != nil {
		t.Fatalf("ServiceFaceRange: %v", err)
	}
	maturingBefore := getMoney(s, kBal(c, c))

	// Find the CHEAPEST legal face whose ask still straddles both buckets —
	// the commission is 12% of the face, so a smaller face is a smaller
	// exposure even before the two zero-cost doors are used.
	var face *big.Int
	for f := new(big.Int).Set(lo); f.Cmp(hi) <= 0; f.Mul(f, big.NewInt(2)) {
		q, err := SettleSpend(s, c, askBlock, f)
		if err != nil {
			continue
		}
		if q.Credits.Cmp(maturingBefore) > 0 {
			face = new(big.Int).Set(f)
			break
		}
	}
	if face == nil {
		t.Fatalf("no legal face straddles both buckets in [%s,%s]", lo, hi)
	}
	setMoney(s, kFace(c), face)
	q, err := SettleSpend(s, c, askBlock, face)
	if err != nil {
		t.Fatalf("SettleSpend: %v", err)
	}

	treasuryBefore := getMoney(s, kTreasury())
	// The CREATOR is the asker. Legal — ask.go's own self-deal filters exist
	// precisely because this case is expected.
	ar, err := Ask(s, c, c, askBlock, new(big.Int).Mul(q.Credits, big.NewInt(2)), q.CommissionHbd, "cid", MaxAskDeadline, 0)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	rec, _ := loadEscrow(s, c, ar.Seq)

	// Reclaim at the first legal block: rec.asker == creator, so the miss slice
	// is skipped and the commission comes back WHOLE.
	reclaimBlock := rec.deadline + ReclaimGrace + 1
	rr, err := Reclaim(s, c, c, reclaimBlock, ar.Seq)
	if err != nil {
		t.Fatalf("Reclaim: %v", err)
	}
	treasuryAfter := getMoney(s, kTreasury())
	hbdCost := new(big.Int).Sub(treasuryAfter, treasuryBefore)

	exitTaxFor := func(h string) *big.Int {
		bal := totalBalance(s, c, h)
		sup := getMoney(s, kSupply(c))
		gross, err := SellProceeds(sup, bal)
		if err != nil {
			t.Fatalf("SellProceeds: %v", err)
		}
		_, fromMaturing := splitDraw(s, c, h, bal)
		return ExitTaxOn(maturingGrossShare(gross, fromMaturing, bal),
			ExitTaxBpsAt(heldBlocksAt(s, c, h, reclaimBlock)))
	}
	taxSelf := exitTaxFor(c)
	taxControl := exitTaxFor(control)

	t.Logf("ZERO-COST SELF-ASK: face=%s (cheapest legal face that straddles both buckets; window [%s,%s]), "+
		"escrow=%s credits, maturing before=%s", face, lo, hi, ar.CreditsSpent, maturingBefore)
	t.Logf("  commission held=%s, returned on Reclaim=%s, RETAINED BY THE PROTOCOL=%s",
		q.CommissionHbd, rr.CommissionHbd, rr.CommissionRetainedHbd)
	t.Logf("  NET HBD COST OF THE WHOLE MANOEUVRE (treasury delta) = %s base units", hbdCost)
	t.Logf("  at block %d:  self-asker tau=%d bps, full-exit TAX=%s", reclaimBlock,
		ExitTaxBpsAt(heldBlocksAt(s, c, c, reclaimBlock)), taxSelf)
	t.Logf("                control   tau=%d bps, full-exit TAX=%s",
		ExitTaxBpsAt(heldBlocksAt(s, c, control, reclaimBlock)), taxControl)

	if totalBalance(s, c, c).Cmp(totalBalance(s, c, control)) != 0 {
		t.Fatalf("positions diverged; comparison invalid")
	}
	if taxSelf.Cmp(taxControl) < 0 {
		saved := new(big.Int).Sub(taxControl, taxSelf)
		pct := new(big.Int).Div(new(big.Int).Mul(saved, big.NewInt(10000)), taxControl)
		net := new(big.Int).Sub(saved, hbdCost)
		t.Errorf("H-12 CONFIRMED AT ZERO COST.\n"+
			"  A creator holding their own market's tokens opened ONE ask against themselves and "+
			"reclaimed it %d blocks (%.0f days) later.\n"+
			"  HBD cost: %s base units (Reclaim's %d-bps miss slice is skipped when rec.asker == creator, "+
			"ask.go:710).\n"+
			"  Exit tax avoided: %s base units = %d.%02d%% of what the identical control holder owes.\n"+
			"  NET GAIN: %s base units.\n"+
			"  A non-creator asker reaches the same zero cost through Decline, which returns 100%% of the "+
			"commission (ask.go:757) and is free for the creator to grant.",
			reclaimBlock-askBlock, float64(reclaimBlock-askBlock)/float64(BlocksPerDay),
			hbdCost, MissReclaimSliceBps, saved, pct.Int64()/100, pct.Int64()%100, net)
	} else {
		t.Logf("  no acceleration at this size — the cheapest straddling face drew only %s tokens from the "+
			"matured bucket.", new(big.Int).Sub(ar.CreditsSpent, maturingBefore))
	}
}
