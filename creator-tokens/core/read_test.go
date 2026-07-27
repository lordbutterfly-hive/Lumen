package core

import (
	"math/big"
	"testing"
)

// read_test.go — read.go's own test file, per API.md's rule ("write a
// _test.go beside your file covering the happy path, every guard, and the
// invariants your module can break"). read.go had no dedicated test file
// before WithdrawTreasury (C2 defect fix, 2026-07-21) — the pure accessors
// (Face/Cap/Supply/Reserve/BalanceOf/PaidUntil/RegisteredAt/EscrowSeq/
// RefundRatioBps) are exercised incidentally throughout every other test
// file in this package (they can't fail and mutate nothing), but
// WithdrawTreasury is a genuine mutator and a genuine attack surface
// (owner-gated fund exit), so it gets its own coverage here.

// ---------------------------------------------------------------------------
// WithdrawTreasury — C2 fix: kTreasury previously had NO exit anywhere in
// this package. 100% of protocol revenue (registration fees, subscription
// fees, commission) was permanently locked from the moment it was
// collected.
// ---------------------------------------------------------------------------

func TestWithdrawTreasury_OwnerWithdrawsWithinBalance(t *testing.T) {
	s := NewMemStore()
	const owner = "hive:platformowner"
	setStr(s, kOwner(), owner)
	setMoney(s, kTreasury(), big.NewInt(10_000))

	amount, err := WithdrawTreasury(s, owner, big.NewInt(4_000))
	if err != nil {
		t.Fatalf("owner withdrawal within balance: %v", err)
	}
	if amount.Cmp(big.NewInt(4_000)) != 0 {
		t.Fatalf("returned amount = %s, want 4000", amount)
	}
	if got := getMoney(s, kTreasury()); got.Cmp(big.NewInt(6_000)) != 0 {
		t.Fatalf("treasury after withdrawal = %s, want 6000 (debited by exactly the withdrawn amount)", got)
	}
}

// TestWithdrawTreasury_NonOwnerRejected is the REGRESSION proof for the
// obvious attack an owner-gated fund exit must resist: anyone who is NOT
// the bound owner must be refused outright, and the call must be a total
// no-op — not even a partial debit.
func TestWithdrawTreasury_NonOwnerRejected(t *testing.T) {
	s := NewMemStore()
	const owner = "hive:platformowner"
	const attacker = "hive:randostranger"
	setStr(s, kOwner(), owner)
	setMoney(s, kTreasury(), big.NewInt(10_000))

	_, err := WithdrawTreasury(s, attacker, big.NewInt(1))
	if err == nil {
		t.Fatal("REGRESSION: a non-owner successfully withdrew from the treasury")
	}
	if sym := errSymbol(err); sym != ErrAuth {
		t.Fatalf("want ErrAuth, got %v", err)
	}
	if got := getMoney(s, kTreasury()); got.Cmp(big.NewInt(10_000)) != 0 {
		t.Fatalf("treasury mutated by a rejected non-owner withdrawal: %s", got)
	}
}

func TestWithdrawTreasury_EmptyCallerRejected(t *testing.T) {
	s := NewMemStore()
	// No owner bound at all (Init never ran) — Owner(s) reads "" (util.go's
	// "missing means the zero value" convention). An empty caller must still
	// be refused, not accidentally match an unset owner.
	setMoney(s, kTreasury(), big.NewInt(500))

	_, err := WithdrawTreasury(s, "", big.NewInt(1))
	if err == nil {
		t.Fatal("REGRESSION: an empty caller matched an unset owner and withdrew")
	}
	if sym := errSymbol(err); sym != ErrAuth {
		t.Fatalf("want ErrAuth, got %v", err)
	}
	if got := getMoney(s, kTreasury()); got.Cmp(big.NewInt(500)) != 0 {
		t.Fatalf("treasury mutated by a rejected empty-caller withdrawal: %s", got)
	}
}

// TestWithdrawTreasury_OverWithdrawRejected proves the balance bound is
// enforced exactly, not silently clamped — mirroring every other guard in
// this package's "reject, never silently short-change" convention (see
// Renew's own MaxPrepaidPeriods bound).
func TestWithdrawTreasury_OverWithdrawRejected(t *testing.T) {
	s := NewMemStore()
	const owner = "hive:platformowner"
	setStr(s, kOwner(), owner)
	setMoney(s, kTreasury(), big.NewInt(1_000))

	_, err := WithdrawTreasury(s, owner, big.NewInt(1_001))
	if err == nil {
		t.Fatal("REGRESSION: an over-withdrawal (balance+1) succeeded")
	}
	if sym := errSymbol(err); sym != ErrBalance {
		t.Fatalf("want ErrBalance, got %v", err)
	}
	if got := getMoney(s, kTreasury()); got.Cmp(big.NewInt(1_000)) != 0 {
		t.Fatalf("treasury mutated by a rejected over-withdrawal: %s", got)
	}

	// Exactly the full balance must still be accepted — the fix must not
	// have tightened the bound into rejecting a legitimate full drain too.
	amount, err := WithdrawTreasury(s, owner, big.NewInt(1_000))
	if err != nil {
		t.Fatalf("withdrawing exactly the full balance: %v", err)
	}
	if amount.Cmp(big.NewInt(1_000)) != 0 {
		t.Fatalf("amount = %s, want 1000", amount)
	}
	if got := getMoney(s, kTreasury()); !mIsZero(got) {
		t.Fatalf("treasury after full withdrawal = %s, want exactly 0", got)
	}
}

func TestWithdrawTreasury_InvalidAmountGuards(t *testing.T) {
	s := NewMemStore()
	const owner = "hive:platformowner"
	setStr(s, kOwner(), owner)
	setMoney(s, kTreasury(), big.NewInt(1_000))

	cases := []struct {
		name   string
		amount *big.Int
	}{
		{"nil amount", nil},
		{"zero amount", big.NewInt(0)},
		{"negative amount", big.NewInt(-1)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := WithdrawTreasury(s, owner, c.amount)
			if err == nil {
				t.Fatal("expected an error, got none")
			}
			if sym := errSymbol(err); sym != ErrInput {
				t.Fatalf("want ErrInput, got %v", err)
			}
		})
	}
	if got := getMoney(s, kTreasury()); got.Cmp(big.NewInt(1_000)) != 0 {
		t.Fatalf("treasury mutated by rejected calls: %s", got)
	}
}

// TestWithdrawTreasury_NoPathToMarketReserve proves the fix's explicit
// scope boundary: WithdrawTreasury touches kTreasury alone. A market's own
// reserve — the money backing its holders' credits — must be completely
// untouched by any owner withdrawal, however large, matching I4 ("no admin
// path exists to [a market's reserve], in any state").
func TestWithdrawTreasury_NoPathToMarketReserve(t *testing.T) {
	s := NewMemStore()
	const owner = "hive:platformowner"
	const creator = "somecreator"
	setStr(s, kOwner(), owner)
	setMoney(s, kTreasury(), big.NewInt(5_000))
	setMoney(s, kReserve(creator), big.NewInt(999_999))
	setMoney(s, kSupply(creator), big.NewInt(999_999))

	if _, err := WithdrawTreasury(s, owner, big.NewInt(5_000)); err != nil {
		t.Fatalf("WithdrawTreasury: %v", err)
	}
	if got := getMoney(s, kReserve(creator)); got.Cmp(big.NewInt(999_999)) != 0 {
		t.Fatalf("REGRESSION: a market's reserve moved on a treasury withdrawal: %s, want untouched 999999", got)
	}
	if got := getMoney(s, kSupply(creator)); got.Cmp(big.NewInt(999_999)) != 0 {
		t.Fatalf("REGRESSION: a market's supply moved on a treasury withdrawal: %s, want untouched 999999", got)
	}
}

// TestWithdrawTreasury_EndToEnd_RevenueNoLongerPermanentlyLocked is the
// end-to-end regression proof for C2 itself: before this fix, revenue
// collected by Register/Renew/Ask+Answer had NO exit at all — this test
// drives all three real accrual paths through the real core functions, then
// proves the owner can withdraw every unit of it, down to exactly zero.
func TestWithdrawTreasury_EndToEnd_RevenueNoLongerPermanentlyLocked(t *testing.T) {
	s := NewMemStore()
	const owner = "hive:platformowner"
	const creator = "revenuecreator"
	setStr(s, kOwner(), owner)

	regBlock := uint64(1000)
	if err := Register(s, creator, creator, regBlock, 1000, MaxCap); err != nil {
		t.Fatalf("Register: %v", err)
	}
	if err := Renew(s, "afan", creator, regBlock+1, 1, big.NewInt(SubscriptionFee)); err != nil {
		t.Fatalf("Renew: %v", err)
	}
	// RULING A: Buy on the curve is the only issuance path. The buy's 10%
	// trade fee splits 5/5, and the PLATFORM half accrues to kTreasury()
	// (RULING F8 — one platform-revenue pot, one audited exit), so it is a
	// third treasury source alongside the registration and subscription
	// fees and must be counted below.
	buyRes, err := Buy(s, "asker", creator, regBlock+2, big.NewInt(5000))
	if err != nil {
		t.Fatalf("Buy: %v", err)
	}
	// RULING C: the PAR fallback is deleted, so the commission-bearing ask
	// needs a genuinely priced market — a two-ring marker history at 15,000
	// (at S=5000: >= ceil(avg 42,574)/4 for C5, <= 2·face for C4), against
	// a face of 10,000 set below. ceil(10,000/15,000) = 1 credit.
	setMoney(s, kFace(creator), big.NewInt(10_000))
	askBlock := seedSettleObs(s, creator, regBlock+10, big.NewInt(15_000))
	commission := commissionOwedFor(big.NewInt(10_000))
	askRes, err := askAt0(s, "asker", creator, askBlock, big.NewInt(1), commission, "cid", MinAskDeadline)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if _, err := Answer(s, creator, creator, askBlock+1, askRes.Seq, "ans"); err != nil {
		t.Fatalf("Answer: %v", err)
	}

	// Registration is FREE (LOCKED-MECHANISM "Revenue"): the treasury's
	// inflows here are the subscription renewal, the service commission and
	// the platform half of the buy's trade fee — no registration fee exists.
	wantTreasury := big.NewInt(SubscriptionFee)
	wantTreasury.Add(wantTreasury, commission)
	wantTreasury.Add(wantTreasury, buyRes.FeePlatform) // the buy's platform fee half (F8)
	if got := getMoney(s, kTreasury()); got.Cmp(wantTreasury) != 0 {
		t.Fatalf("sanity: treasury = %s, want %s (SubscriptionFee+commission+platform trade-fee half; registration is FREE)", got, wantTreasury)
	}

	// Before C2's fix, this revenue had no exit anywhere in the package —
	// now the owner can drain it completely.
	amount, err := WithdrawTreasury(s, owner, wantTreasury)
	if err != nil {
		t.Fatalf("REGRESSION: owner could not withdraw the full accrued treasury: %v", err)
	}
	if amount.Cmp(wantTreasury) != 0 {
		t.Fatalf("withdrawn amount = %s, want %s", amount, wantTreasury)
	}
	if got := getMoney(s, kTreasury()); !mIsZero(got) {
		t.Fatalf("treasury after full withdrawal = %s, want exactly 0 — revenue still stuck", got)
	}

	// The market's own reserve (the asker's still-outstanding credits'
	// backing) is completely unaffected — the treasury and a market's
	// reserve are, and remain, disjoint pools.
	if got := Reserve(s, creator); got.Cmp(buyRes.Cost) != 0 {
		t.Fatalf("market reserve = %s, want the untouched curve leg %s", got, buyRes.Cost)
	}
}

// ---------------------------------------------------------------------------
// CommissionOwedFor — DEFECT 5 fix: the exported helper the wasm wrapper's
// `ask`/`quote` entrypoints now call instead of hand-copying the commission
// formula. core.Ask requires commissionHbdPaid to EXACTLY equal this, so it
// must never drift from what Ask itself enforces.
// ---------------------------------------------------------------------------

// TestCommissionOwedFor_MatchesAskGuardAcrossFaceRange proves the exported
// helper is byte-for-byte identical to (a) ask.go's private commissionOwedFor
// — the value core.Ask's exact-equality guard checks against — and (b) the
// underlying money.go formula mMulBpsDiv(face, CommissionBps), across the whole
// [MinFace, MaxFace] band plus the rounding-sensitive boundaries. If a future
// edit ever forks these, this test fails before an ask ever bricks on-chain.
func TestCommissionOwedFor_MatchesAskGuardAcrossFaceRange(t *testing.T) {
	faces := []int64{
		MinFace, MinFace + 1, 100, 101, 999, 1000, 1001,
		8333, 8334, // floor boundaries around 12% (1200 bps)
		MaxFace - 1, MaxFace,
	}
	for _, f := range faces {
		face := big.NewInt(f)
		want := mMulBpsDiv(face, CommissionBps) // the formula core.Ask's guard uses
		if got := CommissionOwedFor(face); got.Cmp(want) != 0 {
			t.Fatalf("CommissionOwedFor(%d) = %s, want %s (mMulBpsDiv) — a drift from core.Ask's exact-match guard would brick every ask at this face", f, got, want)
		}
		if got := CommissionOwedFor(face); got.Cmp(commissionOwedFor(face)) != 0 {
			t.Fatalf("CommissionOwedFor(%d) diverged from ask.go's own commissionOwedFor", f)
		}
	}

	// Spot value: 12% of 1000 base units floors to 120.
	if got := CommissionOwedFor(big.NewInt(1000)); got.Cmp(big.NewInt(120)) != 0 {
		t.Fatalf("CommissionOwedFor(1000) = %s, want 120", got)
	}
}
