package core

import (
	"math/big"
	"math/rand"
	"testing"
)

// zz_gradfix_prop_test.go — the STRICTLY-SAFER property behind the cohort-gated
// graduate(): the new gate fires everywhere the old blend gate fired, so no
// graduation that used to happen can stop happening.
//
//	maturedNow(blend) == true  =>  some cohort is ripe
//
// (the converse is exactly the fix: a ripe cohort with a young blend now moves).
// Checked over randomized reachable histories — buys, transfers in, transfers
// out, partial sells — at randomized observation blocks.
func TestGRADFIX_NeverGraduatesLess(t *testing.T) {
	rng := rand.New(rand.NewSource(20260908))
	const c = "alice"
	checked, blendRipe, cohortOnly := 0, 0, 0
	for iter := 0; iter < 300; iter++ {
		s := NewMemStore()
		t0 := uint64(1_000_000 + rng.Intn(1_000_000))
		horizon := t0 + 4*ExitTaxDecayBlocks
		pfMarket(t, s, c, horizon)
		blk := t0
		h := "holder"
		for step := 0; step < 1+rng.Intn(6); step++ {
			blk += uint64(rng.Intn(int(ExitTaxDecayBlocks)))
			if blk > horizon {
				break
			}
			n := int64(1 + rng.Intn(5000))
			switch rng.Intn(4) {
			case 0:
				if _, err := Buy(s, h, c, blk, tk(n)); err != nil {
					continue
				}
			case 1: // transfer IN (does not graduate the recipient)
				if _, err := Buy(s, "src", c, blk, tk(n)); err != nil {
					continue
				}
				_ = TransferCredits(s, "src", c, "src", h, blk, tk(n))
			case 2: // transfer OUT (freshest-first debit, no graduation)
				bal := totalBalance(s, c, h)
				if bal.Sign() == 0 {
					continue
				}
				k := new(big.Int).Div(bal, big.NewInt(int64(1+rng.Intn(4))))
				if k.Sign() == 0 {
					continue
				}
				_ = TransferCredits(s, h, c, h, "sink", blk, k)
			case 3: // partial sell
				bal := getMoney(s, kBal(c, h))
				if bal.Sign() == 0 {
					continue
				}
				k := new(big.Int).Div(bal, big.NewInt(int64(2+rng.Intn(4))))
				if k.Sign() == 0 {
					continue
				}
				_, _ = Sell(s, h, c, blk, k)
			}
		}
		for probe := 0; probe < 6; probe++ {
			at := blk + uint64(rng.Intn(int(3*ExitTaxDecayBlocks)))
			_, _, ripe := splitLotsByRate(getLots(s, c, h), at)
			old := maturedNow(s, c, h, at)
			checked++
			if old {
				blendRipe++
				if ripe.Sign() == 0 {
					t.Fatalf("iter %d: the OLD blend gate fired where the cohort gate would not "+
						"(blend ripe, no ripe cohort) — the fix would graduate LESS. "+
						"kBal=%s acq=%d lots=%v", iter, getMoney(s, kBal(c, h)),
						holderAcqBlock(s, c, h), zbLotsRate(s, c, h, at))
				}
			} else if ripe.Sign() > 0 {
				cohortOnly++
			}
		}
	}
	t.Logf("%d probes: %d had a ripe BLEND (every one also had a ripe cohort — never graduates less); "+
		"%d had a ripe COHORT with a young blend (exactly the states the fix releases)",
		checked, blendRipe, cohortOnly)
	if cohortOnly == 0 {
		t.Fatalf("vacuous: the fix released nothing on the random grid")
	}
}
