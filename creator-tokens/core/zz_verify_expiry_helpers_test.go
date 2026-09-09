package core

// zz_verify_expiry_helpers_test.go — shared harness for the exit-tax EXPIRY
// verification suite (VERIFY-EXIT-TAX-EXPIRY). ADDITIVE: no production symbol is
// touched; every helper here is test-only and zv-prefixed to avoid collision
// with the existing tb*/hz* harnesses (which this file also reuses).
//
// The single question this whole suite answers: once a position is held PAST
// ExitTaxDecayBlocks with the per-cohort `lots|` ledger in place, does the
// system behave normally — 0 tax after maturity, ledger cleared, no orphan key,
// no double-count, no stuck position, correct fee/proceeds/conservation?

import (
	"math/big"
	"strings"
	"testing"
)

// zvLotsStr returns the raw serialized cohort ledger for (c,h). "" == absent.
func zvLotsStr(s Store, c, h string) string { return getStr(s, kLots(c, h)) }

// zvHasLots reports whether a `lots|` key is present (non-empty) for (c,h).
func zvHasLots(s Store, c, h string) bool { return getStr(s, kLots(c, h)) != "" }

// zvNumCohorts is the number of cohorts actually stored (RAW — no synthesis).
func zvNumCohorts(s Store, c, h string) int { return len(getLotsRaw(s, c, h)) }

// zvSumLotsRaw sums the token counts across the RAW stored cohorts.
func zvSumLotsRaw(s Store, c, h string) *big.Int {
	total := mZero()
	for _, l := range getLotsRaw(s, c, h) {
		total = mAdd(total, l.count)
	}
	return total
}

// zvParseLotsKey splits a "lots|<c>|<h>" key back into (c,h). validAccount
// forbids '|' in either name, so exactly two parts follow the prefix.
func zvParseLotsKey(key string) (c, h string, ok bool) {
	if !strings.HasPrefix(key, "lots|") {
		return "", "", false
	}
	rest := key[len("lots|"):]
	parts := strings.Split(rest, "|")
	if len(parts) != 2 {
		return "", "", false
	}
	return parts[0], parts[1], true
}

// zvAssertNoOrphanLots is THE anti-orphan / anti-double-count invariant sweep.
// For EVERY `lots|` key currently in state it requires:
//   - the corresponding maturing balance kBal(c,h) is NON-ZERO (an orphan
//     ledger with no maturing balance behind it is exactly the "weird state"
//     the owner is worried about after graduation), and
//   - Σ cohort counts == kBal(c,h) EXACTLY (no double-count, no shortfall).
func zvAssertNoOrphanLots(t *testing.T, s *MemStore, label string) {
	t.Helper()
	for _, key := range s.Keys() {
		c, h, ok := zvParseLotsKey(key)
		if !ok {
			continue
		}
		bal := getMoney(s, kBal(c, h))
		if bal.Sign() == 0 {
			t.Fatalf("%s: ORPHAN LEDGER — %q exists (=%q) but kBal(%s,%s) is zero", label, key, getStr(s, key), c, h)
		}
		sum := zvSumLotsRaw(s, c, h)
		if sum.Cmp(bal) != 0 {
			t.Fatalf("%s: DOUBLE-COUNT — Σlots(%s,%s)=%s != kBal=%s", label, c, h, sum, bal)
		}
	}
}

// zvAssertReserveEqualsArea asserts THE equality invariant R == Area(S) for the
// market, the conservation backbone (C-9). After a full exit both sides are 0.
func zvAssertReserveEqualsArea(t *testing.T, s Store, c, label string) {
	t.Helper()
	res := Reserve(s, c)
	area := Area(Supply(s, c))
	if res.Cmp(area) != 0 {
		t.Fatalf("%s: R != Area(S) — reserve=%s area(supply=%s)=%s", label, res, Supply(s, c), area)
	}
}

// zvAssertSellShape asserts a Sell's money identities against the pre-trade
// supply: gross is the exact curve slice, fee is the trade fee on gross, and
// net + tax + fee re-sum to gross to the unit (C-18 / C-19). Returns gross.
func zvAssertSellShape(t *testing.T, r *SellResult, supplyBefore, deltaS *big.Int, label string) *big.Int {
	t.Helper()
	wantGross, err := SellProceeds(supplyBefore, deltaS)
	if err != nil {
		t.Fatalf("%s: SellProceeds(%s,%s) err %v", label, supplyBefore, deltaS, err)
	}
	if r.Gross.Cmp(wantGross) != 0 {
		t.Fatalf("%s: gross=%s want exact curve slice %s", label, r.Gross, wantGross)
	}
	wantFee, _, _ := tradeFeeOn(wantGross)
	if r.Fee.Cmp(wantFee) != 0 {
		t.Fatalf("%s: fee=%s want %s (5%% of gross)", label, r.Fee, wantFee)
	}
	sum := mAdd(mAdd(r.Net, r.Tax), r.Fee)
	if sum.Cmp(r.Gross) != 0 {
		t.Fatalf("%s: net(%s)+tax(%s)+fee(%s)=%s != gross(%s)", label, r.Net, r.Tax, r.Fee, sum, r.Gross)
	}
	if r.Net.Sign() < 0 {
		t.Fatalf("%s: net negative (%s)", label, r.Net)
	}
	return wantGross
}

// zvAssertPositionsSumToSupply asserts Σ_holders (maturing + matured) == supply,
// i.e. no tokens are lost or duplicated across the two buckets. The suite uses
// no escrow, so this is the full I3 accounting for these markets.
func zvAssertPositionsSumToSupply(t *testing.T, s *MemStore, c, label string) {
	t.Helper()
	total := mZero()
	for _, h := range hzHoldersOf(s, c) {
		total = mAdd(total, totalBalance(s, c, h))
	}
	if total.Cmp(Supply(s, c)) != 0 {
		t.Fatalf("%s: Σpositions=%s != supply=%s", label, total, Supply(s, c))
	}
}

// zvMature buys `n` tokens for h at buyAt, keeps the subscription paid across the
// maturity window, and returns the block (buyAt+window) at which the position is
// exactly matured. It does NOT graduate — the caller decides how graduation is
// triggered (standalone Graduate, or as a side effect of Sell/Buy/Refund).
func zvMature(t *testing.T, s *MemStore, c, h string, n int64, buyAt uint64) uint64 {
	t.Helper()
	if _, err := Buy(s, h, c, buyAt, big.NewInt(n)); err != nil {
		t.Fatalf("zvMature buy: %v", err)
	}
	at := buyAt + tbWindow
	tbKeepPaid(t, s, c, buyAt, at)
	return at
}
