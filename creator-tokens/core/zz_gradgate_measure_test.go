package core

import (
	"math/big"
	"testing"
)

// zz_gradgate_measure_test.go — THE GRADUATION GATE, with graduate() gated on
// the COHORT LEDGER. TestGRAD_1 is the flipped expectation (the ripe cohort
// graduates at t1 instead of up to 42 days later); TestGRAD_3 / TestGRAD_4 are
// the MONEY verdict and are unchanged from the blend-gated tree — every money
// term is identical either way.

// gradForceRipe is EXACTLY what a cohort-gated graduate() would do — the same
// body, with the blend gate replaced by "any ripe cohort". Used to build the
// FIXED side of every A/B below without patching the tree.
func gradForceRipe(s Store, c, h string, block uint64) *big.Int {
	n := getMoney(s, kBal(c, h))
	if n.Sign() == 0 {
		return mZero()
	}
	lots := getLots(s, c, h)
	_, green, ripe := splitLotsByRate(lots, block)
	if ripe.Sign() == 0 {
		return mZero()
	}
	if len(green) == 0 {
		s.Delete(kBal(c, h))
		s.Delete(kAcqBlock(c, h))
		lotsClear(s, c, h)
		setMatured(s, c, h, mAdd(getMatured(s, c, h), n))
		return n
	}
	rest, err := mSub(n, ripe)
	if err != nil || rest.Sign() <= 0 {
		return mZero()
	}
	setMoney(s, kBal(c, h), rest)
	setLots(s, c, h, green)
	setU64(s, kAcqBlock(c, h), lotsBlendAcq(green, block))
	setMatured(s, c, h, mAdd(getMatured(s, c, h), ripe))
	return ripe
}

// gradWorld: an ACTIVE market where `whale` holds a RIPE aged pile plus a FRESH
// slice that landed at t1. Blend is dragged young; the aged pile cannot leave.
func gradWorld(t *testing.T, aged, fresh int64) (s *MemStore, c string, t0, t1 uint64) {
	t.Helper()
	c = "alice"
	t0 = uint64(2_000_000)
	t1 = t0 + ExitTaxDecayBlocks
	s = NewMemStore()
	pfMarket(t, s, c, t1+3*ExitTaxDecayBlocks)
	pfBuy(t, s, "whale", c, t0, aged)
	pfBuy(t, s, "alt", c, t1, fresh)
	if err := TransferCredits(s, "alt", c, "alt", "whale", t1, tk(fresh)); err != nil {
		t.Fatalf("TransferCredits: %v", err)
	}
	return s, c, t0, t1
}

// ---------------------------------------------------------------------------
// G1 — the user-visible effect, reproduced and timed.
// ---------------------------------------------------------------------------
func TestGRAD_1_StuckRipeCohort(t *testing.T) {
	const aged, fresh = int64(1000), int64(999000)
	s, c, _, t1 := gradWorld(t, aged, fresh)

	_, _, ripe := splitLotsByRate(getLots(s, c, "whale"), t1)
	t.Logf("at t1: kBal(maturing)=%s matured=%s ripe cohorts=%s",
		getMoney(s, kBal(c, "whale")), getMatured(s, c, "whale"), ripe)
	t.Logf("  ABI balanceOf (MaturedOf)      = %s", MaturedOf(s, c, "whale"))
	t.Logf("  ABI creatorTokenBalance.matured = %s  .maturing = %s  .maturesAtBlock = %d",
		MaturedOf(s, c, "whale"), MaturingOf(s, c, "whale"), MaturesAtBlock(s, c, "whale"))
	t.Logf("  core BalanceOf (both buckets)  = %s", BalanceOf(s, c, "whale"))
	t.Logf("  maturedNow(blend)=%v  heldBlocksAt=%d  blend rate=%d bps",
		maturedNow(s, c, "whale", t1), heldBlocksAt(s, c, "whale", t1),
		ExitTaxBpsAt(heldBlocksAt(s, c, "whale", t1)))

	// WITH THE COHORT-GATED graduate(): the ripe cohort moves at t1 itself.
	w := holderAcqBlock(s, c, "whale")
	blendWouldBe := w + ExitTaxDecayBlocks
	if got := Graduate(s, c, "whale", t1); got.Cmp(tk(aged)) != 0 {
		t.Fatalf("expected %d to graduate at t1, moved %s", aged, got)
	}
	t.Logf("  Graduate() at t1 -> %d (the ripe cohort)", aged)
	if got := MaturedOf(s, c, "whale"); got.Cmp(tk(aged)) != 0 {
		t.Fatalf("balanceOf still %s after graduating", got)
	}
	if err := TransferMatured(s, c, "whale", "bob", "whale", tk(1)); err != nil {
		t.Fatalf("TransferMatured still refused: %v", err)
	}
	t.Logf("  ABI balanceOf now = %s ; safeTransferFrom(1) SUCCEEDS", MaturedOf(s, c, "whale"))
	t.Logf("  the BLEND would not have released them until t1+%d = %.2f days later",
		blendWouldBe-t1, float64(blendWouldBe-t1)*3.0/86400.0)
	if getMoney(s, kSupply(c)).Cmp(tk(aged+fresh)) != 0 {
		t.Fatalf("supply moved on a graduation: %s", getMoney(s, kSupply(c)))
	}
}

func TestGRAD_2_DelayCurve(t *testing.T) {
	var maxDelay uint64
	for _, r := range [][2]int64{{999000, 1000}, {9000, 1000}, {5000, 5000}, {1000, 9000}, {1000, 99000}, {1000, 999000}, {1, 999999}} {
		s, c, _, t1 := gradWorld(t, r[0], r[1])
		w := holderAcqBlock(s, c, "whale")
		delay := w + ExitTaxDecayBlocks - t1
		_, _, ripe := splitLotsByRate(getLots(s, c, "whale"), t1)
		t.Logf("aged=%7d fresh=%7d -> ripe-but-stuck=%s  delay=%7d blocks = %.2f days  (Dt=%d)",
			r[0], r[1], ripe, delay, float64(delay)*3.0/86400.0, ExitTaxDecayBlocks)
		if delay > maxDelay {
			maxDelay = delay
		}
	}
	t.Logf("MAX DELAY on the grid = %d blocks = %.3f days; theoretical sup = Dt = %d blocks = %.3f days",
		maxDelay, float64(maxDelay)*3.0/86400.0, ExitTaxDecayBlocks, float64(ExitTaxDecayBlocks)*3.0/86400.0)
}

// ---------------------------------------------------------------------------
// G3 — THE MONEY CLAIM. Same position, same block: does having the ripe cohort
// stuck in the maturing bucket change ANY base unit on any rail?
// ---------------------------------------------------------------------------
func gradMoneyDiff(t *testing.T, label string, aged, fresh int64, run func(t *testing.T, s *MemStore, c string, blk uint64) []*big.Int) {
	t.Helper()
	s, c, _, t1 := gradWorld(t, aged, fresh)
	stuck := hzCloneStore(s)
	fixed := hzCloneStore(s)
	moved := gradForceRipe(fixed, c, "whale", t1)
	if moved.Sign() == 0 {
		t.Fatalf("%s: fixture did not graduate anything", label)
	}
	a := run(t, stuck, c, t1)
	b := run(t, fixed, c, t1)
	if len(a) != len(b) {
		t.Fatalf("%s: arity mismatch", label)
	}
	diff := false
	for i := range a {
		if a[i].Cmp(b[i]) != 0 {
			diff = true
			name := "term " + big.NewInt(int64(i)).String()
			if i < len(gradNames) {
				name = gradNames[i]
			}
			t.Errorf("%s: MONEY TERM %s DIFFERS: stuck=%s fixed=%s (delta=%s)",
				label, name, a[i], b[i], new(big.Int).Sub(b[i], a[i]))
		}
	}
	if !diff {
		t.Logf("%-42s IDENTICAL on every money term (%d compared)", label, len(a))
	}
}

// gradTerms — MONEY ONLY. Bucket placement (kBal vs matured) is deliberately NOT
// here: moving ripe tokens between the two buckets IS the change under test, and
// it is not money. Every term below is either HBD or a token TOTAL.
func gradTerms(s *MemStore, c string) []*big.Int {
	return []*big.Int{
		getMoney(s, kReserve(c)), getMoney(s, kSupply(c)),
		getMoney(s, kTreasury()), getMoney(s, kFeeBal(c)),
		totalBalance(s, c, "whale"), totalBalance(s, c, "bob"),
	}
}

// gradNames labels the fixed prefix of every term list.
var gradNames = []string{"reserve", "supply", "treasury", "feeBal", "whaleTotal", "bobTotal"}

func TestGRAD_3_MoneyUnchangedOnEveryRail(t *testing.T) {
	shapes := [][2]int64{{1000, 999000}, {5000, 5000}, {9000, 1000}, {4000, 4000}}
	for _, sh := range shapes {
		aged, fresh := sh[0], sh[1]
		total := aged + fresh
		sizes := []int64{1, aged / 2, aged, fresh / 2, fresh, fresh + 1, total - 1, total}
		for _, k := range sizes {
			if k <= 0 || k > total {
				continue
			}
			k := k
			gradMoneyDiff(t, "SELL k="+big.NewInt(k).String()+" shape "+big.NewInt(aged).String(),
				aged, fresh, func(t *testing.T, s *MemStore, c string, blk uint64) []*big.Int {
					r, err := Sell(s, "whale", c, blk, tk(k))
					if err != nil {
						t.Fatalf("Sell: %v", err)
					}
					// r.TaxableGross and r.TaxBps are DISPLAY fields, reported
					// separately below — they describe the same money differently.
					t.Logf("      [display] k=%d TaxableGross=%s TaxBps=%d", k, r.TaxableGross, r.TaxBps)
					return append(gradTerms(s, c), r.Gross, r.Tax, r.Fee, r.Net)
				})
			gradMoneyDiff(t, "TRANSFER k="+big.NewInt(k).String()+" shape "+big.NewInt(aged).String(),
				aged, fresh, func(t *testing.T, s *MemStore, c string, blk uint64) []*big.Int {
					if err := TransferCredits(s, "whale", c, "whale", "bob", blk, tk(k)); err != nil {
						t.Fatalf("TransferCredits: %v", err)
					}
					// and what bob then owes selling all of it
					q, err := QuoteSell(s, "bob", c, blk, tk(k))
					if err != nil {
						t.Fatalf("QuoteSell(bob): %v", err)
					}
					return append(gradTerms(s, c), q.Gross, q.Tax, q.Fee, q.Net)
				})
			gradMoneyDiff(t, "REFUND k="+big.NewInt(k).String()+" shape "+big.NewInt(aged).String(),
				aged, fresh, func(t *testing.T, s *MemStore, c string, blk uint64) []*big.Int {
					if err := Retire(s, c, c, blk); err != nil {
						t.Fatalf("Retire: %v", err)
					}
					net, err := Refund(s, "whale", c, blk, tk(k))
					if err != nil {
						t.Fatalf("Refund: %v", err)
					}
					return append(gradTerms(s, c), net)
				})
		}
		gradMoneyDiff(t, "REFUNDHOLDER shape "+big.NewInt(aged).String(),
			aged, fresh, func(t *testing.T, s *MemStore, c string, blk uint64) []*big.Int {
				if err := Retire(s, c, c, blk); err != nil {
					t.Fatalf("Retire: %v", err)
				}
				at := blk + 2*ExitTaxDecayBlocks // backstop wide open, everything ripe
				net, err := RefundHolder(s, "keeper", c, "whale", at)
				if err != nil {
					t.Fatalf("RefundHolder: %v", err)
				}
				return append(gradTerms(s, c), net)
			})
	}
}

// ---------------------------------------------------------------------------
// G4 — THE ESCROW RAIL. Ask draws maturing-first through debitPosition, so
// whether the ripe cohort has graduated changes WHICH tokens get escrowed.
// Does any base unit move on the ask, the decline (return leg), the answer
// (delivery leg) or the reclaim?
// ---------------------------------------------------------------------------
func gradEscrowWorld(t *testing.T, aged, fresh int64) (*MemStore, string, string, uint64) {
	t.Helper()
	c, h := "ercreator", "erholder"
	s := NewMemStore()
	if err := Register(s, c, c, 1, MinFace+5000, MaxCap); err != nil {
		t.Fatal(err)
	}
	t0 := uint64(10)
	t1 := t0 + ExitTaxDecayBlocks
	if _, err := Buy(s, h, c, t0, tk(aged)); err != nil {
		t.Fatal(err)
	}
	if _, err := Buy(s, "alt", c, t1, tk(fresh)); err != nil {
		t.Fatal(err)
	}
	if err := TransferCredits(s, "alt", c, "alt", h, t1, tk(fresh)); err != nil {
		t.Fatal(err)
	}
	askBlock := erSeedObs(s, c, t1+1)
	return s, c, h, askBlock
}

func gradEscrowTerms(s *MemStore, c, h string) []*big.Int {
	return []*big.Int{
		getMoney(s, kReserve(c)), getMoney(s, kSupply(c)),
		getMoney(s, kTreasury()), getMoney(s, kFeeBal(c)),
		totalBalance(s, c, h), totalBalance(s, c, c),
	}
}

func TestGRAD_4_EscrowRailMoney(t *testing.T) {
	for _, sh := range [][2]int64{{400_000, 4_000}, {40_000, 40_000}, {4_000, 400_000}, {1_000, 400_000}} {
		aged, fresh := sh[0], sh[1]
		s, c, h, askBlock := gradEscrowWorld(t, aged, fresh)
		_, _, ripe := splitLotsByRate(getLots(s, c, h), askBlock)
		if ripe.Sign() == 0 {
			t.Fatalf("fixture: nothing ripe for aged=%d fresh=%d", aged, fresh)
		}
		blendStuck := !maturedNow(s, c, h, askBlock)
		for _, leg := range []string{"decline", "answer", "reclaim"} {
			stuck := hzCloneStore(s)
			fixed := hzCloneStore(s)
			if moved := gradForceRipe(fixed, c, h, askBlock); moved.Sign() == 0 {
				t.Fatalf("fixture: cohort-gated graduate moved nothing")
			}
			run := func(st *MemStore) []*big.Int {
				lo, hi, err := ServiceFaceRange(st, c, askBlock)
				if err != nil {
					t.Fatal(err)
				}
				var q *SettleQuote
				face := new(big.Int).Set(hi)
				for {
					var e error
					q, e = SettleSpend(st, c, askBlock, face)
					if e == nil && q.Credits.Sign() > 0 {
						break
					}
					face.Div(face, big.NewInt(2))
					if face.Cmp(lo) < 0 {
						t.Skipf("no face admits an ask on shape %d/%d", aged, fresh)
					}
				}
				setMoney(st, kFace(c), face)
				ar, err := Ask(st, h, c, askBlock, new(big.Int).Mul(q.Credits, tk(1_000_000)), "cid", MinAskDeadline, 0)
				if err != nil {
					t.Fatal(err)
				}
				switch leg {
				case "decline":
					if _, err := Decline(st, c, c, askBlock, ar.Seq); err != nil {
						t.Fatal(err)
					}
				case "answer":
					if _, err := Answer(st, c, c, askBlock+1, ar.Seq, "ans"); err != nil {
						t.Fatal(err)
					}
				case "reclaim":
					if _, err := Reclaim(st, h, c, askBlock+MinAskDeadline+ReclaimGrace+2, ar.Seq); err != nil {
						t.Fatal(err)
					}
				}
				out := append(gradEscrowTerms(st, c, h), ar.CreditsSpent)
				// and the tax capacity both sides carry afterwards
				obs := askBlock + MinAskDeadline + ReclaimGrace + 3
				out = append(out, xlCapacity(st, c, h, obs), xlCapacity(st, c, c, obs))
				return out
			}
			a, b := run(stuck), run(fixed)
			names := []string{"reserve", "supply", "treasury", "feeBal", "holderTotal", "creatorTotal", "creditsSpent", "holderTaxCapacity", "creatorTaxCapacity"}
			same := true
			for i := range a {
				if a[i].Cmp(b[i]) != 0 {
					same = false
					t.Logf("  aged=%d fresh=%d leg=%-8s %-18s stuck=%s fixed=%s (delta=%s)",
						aged, fresh, leg, names[i], a[i], b[i], new(big.Int).Sub(b[i], a[i]))
				}
			}
			if same {
				t.Logf("  aged=%7d fresh=%7d leg=%-8s IDENTICAL (blendStuck=%v, ripe=%s)", aged, fresh, leg, blendStuck, ripe)
			}
		}
	}
}
