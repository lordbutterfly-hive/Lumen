package market

import (
	"fmt"
	"math/big"
	"math/rand"
	"testing"
)

// ---------------------------------------------------------------------------
// PRUNED Phase-1 mechanical search, agent A8 — FEE-MATH property.
//
// Two layers:
//   - TestProperty_FeeMath: pure-math identities over random (pool, bps),
//     computed against an INDEPENDENT reference implementation (not just
//     re-calling the function under test), asserting:
//       fee == floor(pool*bps/10000)
//       0 <= fee <= pool
//       distributable == pool-fee >= 0 (no underflow)
//       bounty == min(SettleBounty, fee)
//       feeRest == fee-bounty >= 0
//   - TestProperty_FeeAccrualAcrossRounds: integration-level — runs many
//     rounds through CreateRound/RecordBet/Settle with random fee bps each
//     round, and asserts the on-chain accrued-fee balance equals the running
//     Σ(feeRest) exactly, then WithdrawFees drains exactly that amount and
//     never more.
// ---------------------------------------------------------------------------

func randomBigInt(rng *rand.Rand) *big.Int {
	switch rng.Intn(5) {
	case 0:
		return big.NewInt(0)
	case 1:
		return big.NewInt(rng.Int63n(1_000_000))
	case 2:
		return big.NewInt(rng.Int63n(1 << 62))
	case 3:
		// exactly some multiple of 10000 (clean fee division, floor should be exact)
		return big.NewInt(rng.Int63n(100_000) * 10000)
	default:
		// huge: up to ~10^40, stresses big.Int beyond int64/uint64 range entirely
		digits := 1 + rng.Intn(40)
		bs := make([]byte, digits)
		bs[0] = byte('1' + rng.Intn(9))
		for i := 1; i < digits; i++ {
			bs[i] = byte('0' + rng.Intn(10))
		}
		v, ok := new(big.Int).SetString(string(bs), 10)
		if !ok {
			return big.NewInt(0)
		}
		return v
	}
}

func TestProperty_FeeMath(t *testing.T) {
	const iterations = 20000
	const seed = int64(42)
	rng := rand.New(rand.NewSource(seed))
	sb := mustBig(SettleBounty)

	for i := 0; i < iterations; i++ {
		pool := randomBigInt(rng)
		bps := uint64(rng.Intn(MaxFeeBps + 1)) // [0, MaxFeeBps]

		fee := mMulBpsDiv(pool, bps)

		// Independent reference computation of floor(pool*bps/10000), NOT
		// calling mMulBpsDiv again, to catch a bug in the function itself.
		want := new(big.Int).Mul(pool, new(big.Int).SetUint64(bps))
		want.Quo(want, big.NewInt(10000)) // Quo == truncating division; operands are non-negative so Quo==Div (floor)

		if fee.Cmp(want) != 0 {
			t.Fatalf("iter %d: fee mismatch pool=%s bps=%d got=%s want=%s (seed=%d)", i, pool, bps, fee, want, seed)
		}
		if fee.Sign() < 0 {
			t.Fatalf("iter %d: NEGATIVE fee pool=%s bps=%d fee=%s (seed=%d)", i, pool, bps, fee, seed)
		}
		if fee.Cmp(pool) > 0 {
			t.Fatalf("iter %d: fee %s EXCEEDS pool %s (bps=%d, seed=%d)", i, fee, pool, bps, seed)
		}

		distributable, err := mSub(pool, fee)
		if err != nil {
			t.Fatalf("iter %d: mSub(pool,fee) underflow pool=%s fee=%s (seed=%d)", i, pool, fee, seed)
		}
		if distributable.Sign() < 0 {
			t.Fatalf("iter %d: NEGATIVE distributable pool=%s fee=%s distributable=%s (seed=%d)", i, pool, fee, distributable, seed)
		}
		// distributable + fee must reconstruct pool exactly (no leak, no create).
		recon := new(big.Int).Add(distributable, fee)
		if recon.Cmp(pool) != 0 {
			t.Fatalf("iter %d: distributable+fee %s != pool %s (seed=%d)", i, recon, pool, seed)
		}

		bounty := computeBounty(pool, fee)
		// wantBounty = min(fee, max(SettleBounty, pool*SettleBountyBps/10000))
		wantBounty := mMulBpsDiv(pool, SettleBountyBps)
		if wantBounty.Cmp(sb) < 0 {
			wantBounty = new(big.Int).Set(sb)
		}
		if fee.Cmp(wantBounty) < 0 {
			wantBounty = new(big.Int).Set(fee)
		}
		if bounty.Cmp(wantBounty) != 0 {
			t.Fatalf("iter %d: bounty mismatch fee=%s got=%s want=%s (seed=%d)", i, fee, bounty, wantBounty, seed)
		}
		if bounty.Sign() < 0 || bounty.Cmp(fee) > 0 {
			t.Fatalf("iter %d: bounty %s out of [0,fee=%s] range (seed=%d)", i, bounty, fee, seed)
		}

		feeRest, err := mSub(fee, bounty)
		if err != nil {
			t.Fatalf("iter %d: mSub(fee,bounty) underflow fee=%s bounty=%s (seed=%d)", i, fee, bounty, seed)
		}
		if feeRest.Sign() < 0 {
			t.Fatalf("iter %d: NEGATIVE feeRest fee=%s bounty=%s feeRest=%s (seed=%d)", i, fee, bounty, feeRest, seed)
		}
		reconFee := new(big.Int).Add(feeRest, bounty)
		if reconFee.Cmp(fee) != 0 {
			t.Fatalf("iter %d: feeRest+bounty %s != fee %s (seed=%d)", i, reconFee, fee, seed)
		}
	}
	t.Logf("TestProperty_FeeMath: %d iterations, pool in {0, small, ~2^62, exact-10000-multiples, ~10^40}, bps in [0,%d], all identities held (seed=%d)", iterations, MaxFeeBps, seed)
}

func TestProperty_FeeAccrualAcrossRounds(t *testing.T) {
	const rounds = 500
	const seed = int64(7)
	rng := rand.New(rand.NewSource(seed))

	s := newMem()
	if err := Init(s, owner); err != nil {
		t.Fatal(err)
	}
	expectedAccrued := big.NewInt(0)
	settledCount, voidCount := 0, 0

	for r := 0; r < rounds; r++ {
		bps := uint64(rng.Intn(MaxFeeBps + 1))
		if err := SetFeeBps(s, owner, bps); err != nil {
			t.Fatalf("round %d: SetFeeBps(%d): %v", r, bps, err)
		}
		n := 2 + rng.Intn(4)
		strikes := make([]uint64, n-1)
		prev := uint64(0)
		for i := range strikes {
			prev += uint64(1 + rng.Intn(1000))
			strikes[i] = prev
		}
		id, err := CreateRound(s, owner, 0, CreateParams{
			Asset: AssetHbd, Strikes: strikes, LockBlock: 2000, SettleBlock: 4000, GraceBlocks: 300,
		})
		if err != nil {
			t.Fatalf("round %d: CreateRound: %v", r, err)
		}
		k := 2 + rng.Intn(6)
		for i := 0; i < k; i++ {
			outcome := rng.Intn(n)
			amt := big.NewInt(1000 + rng.Int63n(1_000_000))
			if err := RecordBet(s, fmt.Sprintf("r%d-a%d", r, i), 10, id, outcome, amt); err != nil {
				t.Fatalf("round %d: RecordBet: %v", r, err)
			}
		}
		pool := getMoney(s, rk(id, "pool"))
		price := uint64(rng.Int63n(int64(prev) + 2000))
		res, err := Settle(s, "keeper", 4000, id, price, 4000, true)
		if err != nil {
			t.Fatalf("round %d: Settle: %v", r, err)
		}
		if res.State == StateSettled {
			settledCount++
			fee := mMulBpsDiv(pool, bps)
			bounty := computeBounty(pool, fee)
			feeRest, err := mSub(fee, bounty)
			if err != nil {
				t.Fatalf("round %d: mSub(fee,bounty): %v", r, err)
			}
			expectedAccrued.Add(expectedAccrued, feeRest)
			if res.Bounty.Cmp(bounty) != 0 {
				t.Fatalf("round %d: SettleResult.Bounty %s != computed bounty %s", r, res.Bounty, bounty)
			}
		} else {
			voidCount++
			// VOID must accrue ZERO fee — no fee is ever taken on a voided round.
		}
		got := getMoney(s, kFeeAccrued(AssetHbd))
		if got.Cmp(expectedAccrued) != 0 {
			t.Fatalf("round %d (state=%s): fee accrued %s != running ΣfeeRest %s (seed=%d)", r, res.State, got, expectedAccrued, seed)
		}
	}

	// The accrued balance must never exceed the running Σ of per-round fees
	// (trivially true here since it EQUALS it, but assert both directions).
	finalAccrued := getMoney(s, kFeeAccrued(AssetHbd))
	if finalAccrued.Cmp(expectedAccrued) != 0 {
		t.Fatalf("final accrued %s != expected ΣfeeRest %s", finalAccrued, expectedAccrued)
	}

	amt, _, err := WithdrawFees(s, owner, AssetHbd)
	withdrawn := "0 (no accrued balance)"
	if expectedAccrued.Sign() == 0 {
		if err == nil {
			t.Fatal("WithdrawFees succeeded with zero accrued balance")
		}
	} else {
		if err != nil {
			t.Fatalf("WithdrawFees: %v", err)
		}
		if amt.Cmp(expectedAccrued) != 0 {
			t.Fatalf("withdrew %s, want exactly the accrued %s", amt, expectedAccrued)
		}
		if got := getMoney(s, kFeeAccrued(AssetHbd)); got.Sign() != 0 {
			t.Fatalf("accrued balance not zeroed after withdraw: %s", got)
		}
		if _, _, err := WithdrawFees(s, owner, AssetHbd); err == nil {
			t.Fatal("second WithdrawFees succeeded against a zeroed balance")
		}
		withdrawn = amt.String()
	}
	t.Logf("TestProperty_FeeAccrualAcrossRounds: %d rounds (%d settled, %d void), random bps in [0,%d], final accrued=%s, withdrawn=%s (seed=%d)",
		rounds, settledCount, voidCount, MaxFeeBps, expectedAccrued, withdrawn, seed)
}
