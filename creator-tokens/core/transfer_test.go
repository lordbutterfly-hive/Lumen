package core

import (
	"math/big"
	"math/rand"
	"strings"
	"testing"
)

// transfer_test.go — TransferCredits under RULING A (transfer.go), plus the
// package-wide test helpers that used to live in the deleted prepay_test.go
// (the PAR mint died with its mechanism — RULING A; its tests asserted a
// 1:1 mint that no longer exists and were deleted WITH it, not ported).
// Every minted balance in this file comes through Buy, the only issuance
// path.

// ---------------------------------------------------------------------------
// Shared test harness (kept verbatim from the old prepay_test.go — many
// sibling files use these).
// ---------------------------------------------------------------------------

func setupMarket(s Store, creator string, block uint64, cap int64) {
	setU64(s, kRegisteredAt(creator), block)
	setU64(s, kPaidUntil(creator), block+SubscriptionPeriod) // comfortably ACTIVE
	setMoney(s, kCap(creator), big.NewInt(cap))
}

// sumBalances scans every bal|<creator>|<holder> key and sums it — the
// invariant-sweep helper store.go documents MemStore.Keys() as existing for.
func sumBalances(s *MemStore, creator string) *big.Int {
	// Both buckets — see hzSumMatured (harness_test.go) for why the matured
	// family cannot be reached by a prefix scan on the creator.
	prefix := kBal(creator, "")
	total := hzSumMatured(s, creator)
	for _, k := range s.Keys() {
		if strings.HasPrefix(k, prefix) {
			v, _ := s.Get(k)
			n, ok := new(big.Int).SetString(v, 10)
			if ok {
				total.Add(total, n)
			}
		}
	}
	return total
}

func errSymbol(err error) string {
	if perr, ok := err.(*Err); ok {
		return perr.Symbol
	}
	return ""
}

// ---------------------------------------------------------------------------
// TransferCredits — ownership moves, supply doesn't; clock and settle
// semantics at both legs.
// ---------------------------------------------------------------------------

func TestTransferCredits_HappyPath(t *testing.T) {
	s := NewMemStore()
	creator := "creatorh"
	setupMarket(s, creator, 100, 1000)
	if _, err := Buy(s, "alice", creator, 200, big.NewInt(500)); err != nil {
		t.Fatal(err)
	}

	if err := TransferCredits(s, creator, "alice", "bob", 250, big.NewInt(200)); err != nil {
		t.Fatalf("transfer failed: %v", err)
	}
	if got := getMoney(s, kBal(creator, "alice")); got.Cmp(big.NewInt(300)) != 0 {
		t.Fatalf("alice balance = %s, want 300", got)
	}
	if got := getMoney(s, kBal(creator, "bob")); got.Cmp(big.NewInt(200)) != 0 {
		t.Fatalf("bob balance = %s, want 200", got)
	}
	// I3: a transfer moves ownership, never total supply.
	if got := getMoney(s, kSupply(creator)); got.Cmp(big.NewInt(500)) != 0 {
		t.Fatalf("supply changed by a transfer: %s", got)
	}
	if got := sumBalances(s, creator); got.Cmp(big.NewInt(500)) != 0 {
		t.Fatalf("Σ balances after transfer = %s, want 500", got)
	}
	// The reserve is untouched and still EXACTLY the curve area (RULING A).
	if R, S := getMoney(s, kReserve(creator)), getMoney(s, kSupply(creator)); R.Cmp(Area(S)) != 0 {
		t.Fatalf("R = %s != area(%s) = %s after transfer — the equality invariant broke on a ΔR=0 op", R, S, Area(S))
	}
	// Clock legs. ★ EXPECTATION CHANGED (TOKEN MATURITY, USER-RULED
	// 2026-07-27): the recipient used to be clocked at the TRANSFER block (250),
	// which destroyed the maturity of every moved token. Maturity now belongs to
	// the tokens and travels with them, so bob's 200 tokens arrive carrying
	// alice's own clock — 200, the block she bought them at — and bob's account
	// was empty, so the merge stores it exactly (the oldBal == 0 branch). The
	// SENDER's clock is untouched either way: a debit never re-ages a remainder.
	if w := holderAcqBlock(s, creator, "bob"); w != 200 {
		t.Fatalf("bob's wacq = %d, want alice's own acquisition block 200 (maturity travels WITH the tokens)", w)
	}
	if w := holderAcqBlock(s, creator, "alice"); w != 200 {
		t.Fatalf("alice's wacq = %d, want 200 unchanged (a debit never re-ages the remainder)", w)
	}
}

// The exit-tax laundering bypass is CLOSED (was a live Wave-A gap, proven by
// the old TestCurveFuzz_TransferInheritsRecipientAgedClock_WAVE_A_GAP, which
// documented its own deletion once the recipient leg got clocked): routing
// 100 fresh tokens through an account holding 1 aged token now RE-AVERAGES
// the recipient's clock toward the transfer block, so the position pays
// ~maximum tax instead of inheriting 0%.
func TestTransferCredits_RecipientClockReAverages_LaunderingClosed(t *testing.T) {
	s := NewMemStore()
	c := "creatora"
	b := uint64(1_000_000)
	setupMarket(s, c, 1, MaxCap)
	setU64(s, kPaidUntil(c), b+200*SubscriptionPeriod)

	// The parked account: one token, bought six weeks + 1 block ago.
	if _, err := Buy(s, "aged.acct", c, b, big.NewInt(1)); err != nil {
		t.Fatal(err)
	}
	later := b + ExitTaxDecayBlocks + 1
	setU64(s, kPaidUntil(c), later+200*SubscriptionPeriod)

	// A fresh sniper buys 100 tokens at `later` and routes them through the
	// aged account.
	if _, err := Buy(s, "sniper", c, later, big.NewInt(100)); err != nil {
		t.Fatal(err)
	}
	if err := TransferCredits(s, c, "sniper", "aged.acct", later, big.NewInt(100)); err != nil {
		t.Fatal(err)
	}
	// wNew = ceil((1·b + 100·later)/101) — dominated by the fresh size, so
	// heldBlocks is tiny and the tax is within a few bps of the maximum.
	q, err := QuoteSell(s, "aged.acct", c, later, big.NewInt(101))
	if err != nil {
		t.Fatal(err)
	}
	if q.TaxBps < MaxExitTaxBps-100 {
		t.Fatalf("laundered position quotes %d bps — the transfer-in clock re-average is not biting "+
			"(want within 100 bps of the %d max; one transfer must never convert 20%% into ~0%%)", q.TaxBps, MaxExitTaxBps)
	}
}

// ★ RENAMED AND RE-AIMED (TOKEN MATURITY, USER-RULED 2026-07-27). This test was
// TestTransferCredits_ReAgesRecipientClockToFresh and asserted that a transfer
// re-ages the recipient to the transfer block. That behaviour was PROVEN DEFECT
// 2 — the mirror image of the age sponge — because it destroyed the maturity of
// every moved token, so an honest holder moving their own position between their
// own accounts paid the full 20% on tokens the protocol had already agreed owed
// nothing. Every assertion below is KEPT (nothing was deleted to make the fix
// pass); only the recipient's expected clock changes, from the transfer block to
// the sender's own — which is the ruling.
//
// What still holds, and is what the old test was really protecting: a whale
// splitting a position across accounts before a dump gains nothing. Maturity is
// size-weighted and conserved (properties P1/P2), so splitting moves the rate
// around without creating any, and under K1 every slice pays τ × its own gross
// proceeds with no gain cap to exploit — splitting a sale strictly over-pays by
// ceil superadditivity.
func TestTransferCredits_RecipientInheritsSenderClock_MaturityTravels(t *testing.T) {
	s := NewMemStore()
	creator := "creatorb"
	setupMarket(s, creator, 100, 1_000_000)
	if _, err := Buy(s, "alice", creator, 200, big.NewInt(300)); err != nil {
		t.Fatal(err)
	}
	if err := TransferCredits(s, creator, "alice", "bob", 250, big.NewInt(100)); err != nil {
		t.Fatal(err)
	}
	if got := getMoney(s, kBal(creator, "bob")); got.Cmp(big.NewInt(100)) != 0 {
		t.Fatalf("bob balance = %s, want 100 (the transferred tokens)", got)
	}
	if got := getMoney(s, kBal(creator, "alice")); got.Cmp(big.NewInt(200)) != 0 {
		t.Fatalf("alice balance = %s, want 200 (kept)", got)
	}
	// bob's inherited tokens carry ALICE's clock (block 200) — the maturity she
	// earned moves with the tokens she sent, and is gone from what she kept.
	if w := holderAcqBlock(s, creator, "bob"); w != 200 {
		t.Fatalf("bob wacq = %d, want alice's acquisition block 200 (maturity travels with the tokens)", w)
	}
	// alice's remainder keeps its own clock — the debit does not re-age it.
	if w := holderAcqBlock(s, creator, "alice"); w != 200 {
		t.Fatalf("alice wacq = %d, want unchanged 200 (a send does not re-age the remainder)", w)
	}
	// The two now read the SAME rate at every block: 300 tokens' worth of
	// maturity was neither created nor destroyed by moving 100 of them.
	for _, q := range []uint64{250, 250 + ExitTaxDecayBlocks/2, 250 + ExitTaxDecayBlocks} {
		if a, b := ExitTaxBpsAt(heldBlocksAt(s, creator, "alice", q)), ExitTaxBpsAt(heldBlocksAt(s, creator, "bob", q)); a != b {
			t.Fatalf("at block %d alice pays %d bps and bob %d bps on tokens of identical provenance", q, a, b)
		}
	}
}

func TestTransferCredits_Guards(t *testing.T) {
	s := NewMemStore()
	creator := "creatori"
	setupMarket(s, creator, 100, 1000)
	if _, err := Buy(s, "alice", creator, 200, big.NewInt(500)); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name     string
		from, to string
		amount   *big.Int
		wantSym  string
	}{
		{"zero amount", "alice", "bob", big.NewInt(0), ErrInput},
		{"negative amount", "alice", "bob", big.NewInt(-5), ErrInput},
		{"nil amount", "alice", "bob", nil, ErrInput},
		{"insufficient balance", "alice", "bob", big.NewInt(10000), ErrBalance},
		{"from equals to", "alice", "alice", big.NewInt(10), ErrInput},
		{"invalid from account (key delimiter)", "a|b", "bob", big.NewInt(10), ErrInput},
		{"invalid to account (key delimiter)", "alice", "BO|B", big.NewInt(10), ErrInput},
		{"invalid to account (empty)", "alice", "", big.NewInt(10), ErrInput},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := TransferCredits(s, creator, c.from, c.to, 300, c.amount)
			if err == nil {
				t.Fatalf("expected an error, got none")
			}
			if sym := errSymbol(err); sym != c.wantSym {
				t.Fatalf("want symbol %s, got %v", c.wantSym, err)
			}
		})
	}
	// none of the rejected transfers should have moved any balance.
	if got := getMoney(s, kBal(creator, "alice")); got.Cmp(big.NewInt(500)) != 0 {
		t.Fatalf("alice balance mutated by a rejected transfer: %s", got)
	}
}

// TransferCredits must work in EVERY billing phase, including FROZEN — API.md
// rule 4: credits already owned are the holder's property and billing state
// must never gate them. TransferCredits never consults Phase or
// RequireInflowOpen at all.
func TestTransferCredits_WorksRegardlessOfBillingPhase(t *testing.T) {
	s := NewMemStore()
	creator := "creatorj"
	setupMarket(s, creator, 100, 1000)
	if _, err := Buy(s, "alice", creator, 200, big.NewInt(500)); err != nil {
		t.Fatal(err)
	}

	// Force the market into a lapsed/FROZEN-shaped state: naturalPhase
	// (market.go) derives FROZEN lazily from paidUntil+GraceBlocks alone, so
	// this one write is sufficient for any query block >= 50+GraceBlocks.
	setU64(s, kPaidUntil(creator), 50)

	if err := TransferCredits(s, creator, "alice", "bob", 50+GraceBlocks+10, big.NewInt(100)); err != nil {
		t.Fatalf("transfer must work even when the market is FROZEN/lapsed: %v", err)
	}
	if got := getMoney(s, kBal(creator, "bob")); got.Cmp(big.NewInt(100)) != 0 {
		t.Fatalf("bob balance = %s, want 100", got)
	}

	// It must also work against a creator that was NEVER registered at all —
	// TransferCredits has no market-existence gate (an unfunded balance simply
	// fails on "insufficient balance", not on "no such market").
	if err := TransferCredits(s, "neverregistered", "alice", "bob", 300, big.NewInt(1)); err == nil {
		t.Fatal("expected insufficient-balance, not a silent success, against an unfunded holder")
	} else if sym := errSymbol(err); sym != ErrBalance {
		t.Fatalf("want ErrBalance (not a market-existence gate), got %v", err)
	}
}

// ---------------------------------------------------------------------------
// Fuzz-style property loop: random Buy/TransferCredits sequences across
// several creators and holders, asserting after EVERY single step that
//
//	supply(c)  == Σ balances(c)     (I3; no escrow in play here)
//	reserve(c) == area(supply(c))   (RULING A equality — transfers ΔR=0,
//	                                 buys move R exactly along the area)
// ---------------------------------------------------------------------------

func TestFuzz_BuyTransferInvariants(t *testing.T) {
	const iterations = 3000
	rng := rand.New(rand.NewSource(42))

	s := NewMemStore()
	creators := []string{"alicecreator", "bobcreator", "carolcreator"}
	holders := []string{"holder1", "holder2", "holder3", "holder4", "holder5"}

	for _, c := range creators {
		cap := int64(1000 + rng.Intn(9000))
		setupMarket(s, c, 100, cap)
		setU64(s, kPaidUntil(c), 100+100*SubscriptionPeriod)
	}

	for i := 0; i < iterations; i++ {
		c := creators[rng.Intn(len(creators))]

		if rng.Intn(2) == 0 {
			// --- Buy ---
			h := holders[rng.Intn(len(holders))]
			n := big.NewInt(int64(1 + rng.Intn(500)))

			supplyBefore := getMoney(s, kSupply(c))
			capV := getMoney(s, kCap(c))
			wantSupply := new(big.Int).Add(supplyBefore, n)

			_, err := Buy(s, h, c, 200, n)

			if wantSupply.Cmp(capV) > 0 {
				if sym := errSymbol(err); sym != ErrCap {
					t.Fatalf("iter %d: want ErrCap (supplyBefore=%s n=%s cap=%s), got %v", i, supplyBefore, n, capV, err)
				}
			} else if err != nil {
				t.Fatalf("iter %d: Buy failed unexpectedly: %v", i, err)
			}
		} else {
			// --- TransferCredits ---
			from := holders[rng.Intn(len(holders))]
			to := holders[rng.Intn(len(holders))]
			for to == from {
				to = holders[rng.Intn(len(holders))]
			}
			bal := getMoney(s, kBal(c, from))

			var amt *big.Int
			switch rng.Intn(3) {
			case 0: // within balance when possible
				if bal.Sign() > 0 {
					amt = big.NewInt(1 + rng.Int63n(bal.Int64()))
				} else {
					amt = big.NewInt(int64(1 + rng.Intn(100)))
				}
			case 1: // deliberately exceeds balance
				amt = new(big.Int).Add(bal, big.NewInt(int64(1+rng.Intn(1000))))
			default: // small, possibly zero (exercises the amount>0 guard too)
				amt = big.NewInt(int64(rng.Intn(50)))
			}

			fromBefore := getMoney(s, kBal(c, from))
			toBefore := getMoney(s, kBal(c, to))

			err := TransferCredits(s, c, from, to, 200, amt)

			switch {
			case amt.Sign() <= 0:
				if sym := errSymbol(err); sym != ErrInput {
					t.Fatalf("iter %d: zero amount: want ErrInput, got %v", i, err)
				}
			case amt.Cmp(fromBefore) > 0:
				if sym := errSymbol(err); sym != ErrBalance {
					t.Fatalf("iter %d: overdraw: want ErrBalance, got %v", i, err)
				}
				// rejected — nothing moved
				if getMoney(s, kBal(c, from)).Cmp(fromBefore) != 0 || getMoney(s, kBal(c, to)).Cmp(toBefore) != 0 {
					t.Fatalf("iter %d: rejected transfer moved balances", i)
				}
			default:
				if err != nil {
					t.Fatalf("iter %d: legal transfer failed: %v", i, err)
				}
			}
		}

		// ---- after EVERY step ----
		for _, cc := range creators {
			S := getMoney(s, kSupply(cc))
			if S.Cmp(sumBalances(s, cc)) != 0 {
				t.Fatalf("iter %d: I3 violated on %s: supply %s != Σ balances %s", i, cc, S, sumBalances(s, cc))
			}
			if R := getMoney(s, kReserve(cc)); R.Cmp(Area(S)) != 0 {
				t.Fatalf("iter %d: equality invariant violated on %s: R %s != area(%s) %s", i, cc, R, S, Area(S))
			}
		}
	}
}
