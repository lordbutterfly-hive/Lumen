package core

import (
	"math/big"
	"strings"
	"testing"
)

// SCENARIO 6 — NO ORPHAN KEYS / NO DOUBLE COUNT. Drive a composite multi-holder
// lifecycle through maturity, graduation, fresh buys, and both transfer rails,
// then sweep ALL state and confirm: no dangling `lots|` entry, Σlots == kBal
// wherever a ledger exists, matured totals correct, Σpositions == supply, and
// R == Area(S).
func TestZZVerifyExpiry_NoOrphanNoDoubleCount(t *testing.T) {
	const c, h1, h2, h3 = "hive:alice", "hive:bob", "hive:carol", "hive:dave"
	s := tbMarket(t, c)

	b1 := uint64(1_000_000)
	t1 := b1 + tbWindow      // h1,h2 matured here; h3 not yet
	t2 := t1 + tbWindow      // h1's fresh cohort + h3 matured here
	tbKeepPaid(t, s, c, b1, t2)

	// ---- Phase A: initial buys ----
	mustBuy(t, s, c, h1, b1, 500)
	mustBuy(t, s, c, h2, b1, 300)
	mustBuy(t, s, c, h3, b1+100_000, 100)

	// ---- Phase B (@ t1): graduate the matured, fresh buy, both transfer rails ----
	if Graduate(s, c, h1, t1).Cmp(big.NewInt(500)) != 0 {
		t.Fatal("graduate h1")
	}
	if Graduate(s, c, h2, t1).Cmp(big.NewInt(300)) != 0 {
		t.Fatal("graduate h2")
	}
	mustBuy(t, s, c, h1, t1, 200) // fresh cohort on h1's cleared ledger
	if err := TransferMatured(s, c, h1, h3, h1, big.NewInt(100)); err != nil {
		t.Fatalf("h1 TransferMatured -> h3: %v", err)
	}
	if err := TransferCredits(s, h2, c, h2, h3, t1, big.NewInt(150)); err != nil { // matured leg
		t.Fatalf("h2 TransferCredits -> h3: %v", err)
	}

	// Mid-flight sweep: the invariants must already hold.
	zvAssertNoOrphanLots(t, s, "phase B")
	zvAssertPositionsSumToSupply(t, s, c, "phase B")
	// Ledger presence is exactly the set of holders WITH a nonzero maturing balance.
	assertLedgerMatchesMaturing(t, s, c, []string{h1, h2, h3}, "phase B")

	// ---- Phase C (@ t2): everyone else matures; graduate all; verify totals ----
	if Graduate(s, c, h1, t2).Cmp(big.NewInt(200)) != 0 {
		t.Fatal("graduate h1 fresh cohort")
	}
	if Graduate(s, c, h3, t2).Cmp(big.NewInt(100)) != 0 {
		t.Fatal("graduate h3")
	}
	// Matured bucket totals correct: h1=500-100+200=600, h2=300-150=150,
	// h3=100(buy)+100(from h1)+150(from h2)=350.
	for _, w := range []struct {
		h    string
		want int64
	}{{h1, 600}, {h2, 150}, {h3, 350}} {
		if got := MaturedOf(s, c, w.h); got.Cmp(big.NewInt(w.want)) != 0 {
			t.Fatalf("matured[%s]=%s want %d", w.h, got, w.want)
		}
	}
	// No `lots|` key anywhere now — every position graduated.
	for _, k := range s.Keys() {
		if strings.HasPrefix(k, "lots|") {
			t.Fatalf("ORPHAN: dangling ledger key after all graduations: %q=%q", k, getStr(s, k))
		}
	}
	zvAssertNoOrphanLots(t, s, "phase C")
	zvAssertPositionsSumToSupply(t, s, c, "phase C")

	// ---- Final: sell everyone out; all zero-tax; clean full drain ----
	for _, w := range []struct {
		h    string
		amt  int64
	}{{h1, 600}, {h2, 150}, {h3, 350}} {
		supplyBefore := new(big.Int).Set(Supply(s, c))
		r, err := Sell(s, w.h, c, t2, big.NewInt(w.amt))
		if err != nil {
			t.Fatalf("final sell %s: %v", w.h, err)
		}
		if r.Tax.Sign() != 0 || r.TaxBps != 0 {
			t.Fatalf("final sell %s tax=%s taxBps=%d MUST be 0", w.h, r.Tax, r.TaxBps)
		}
		zvAssertSellShape(t, r, supplyBefore, big.NewInt(w.amt), "final sell "+w.h)
	}
	if Supply(s, c).Sign() != 0 || Reserve(s, c).Sign() != 0 {
		t.Fatalf("after full drain supply=%s reserve=%s want 0/0", Supply(s, c), Reserve(s, c))
	}
	zvAssertReserveEqualsArea(t, s, c, "final")
	zvAssertNoOrphanLots(t, s, "final")
	// No lots|, no mb| (maturing) keys should remain for this creator.
	for _, k := range s.Keys() {
		if strings.HasPrefix(k, "lots|"+c+"|") || strings.HasPrefix(k, "mb|"+c+"|") {
			t.Fatalf("leftover maturing-family key after full exit: %q=%q", k, getStr(s, k))
		}
	}
	t.Log("composite lifecycle: no orphan lots|, Σlots==kBal throughout, matured totals correct, full drain to R==Area(S)==0")
}

func mustBuy(t *testing.T, s Store, c, h string, block uint64, n int64) {
	t.Helper()
	if _, err := Buy(s, h, c, block, big.NewInt(n)); err != nil {
		t.Fatalf("Buy(%s, %d @ %d): %v", h, n, block, err)
	}
}

// assertLedgerMatchesMaturing verifies the ledger EXISTS iff the holder has a
// nonzero maturing balance, and Σlots == that balance — the precise "no orphan,
// no missing ledger, no double-count" statement per holder.
func assertLedgerMatchesMaturing(t *testing.T, s Store, c string, holders []string, label string) {
	t.Helper()
	for _, h := range holders {
		maturing := MaturingOf(s, c, h)
		has := zvHasLots(s, c, h)
		if maturing.Sign() > 0 && !has {
			t.Fatalf("%s: holder %s has maturing=%s but NO ledger (would force synthesis)", label, h, maturing)
		}
		if maturing.Sign() == 0 && has {
			t.Fatalf("%s: ORPHAN — holder %s has zero maturing but a ledger %q", label, h, zvLotsStr(s, c, h))
		}
		if has {
			if got := zvSumLotsRaw(s, c, h); got.Cmp(maturing) != 0 {
				t.Fatalf("%s: DOUBLE-COUNT — Σlots(%s)=%s != maturing=%s", label, h, got, maturing)
			}
		}
	}
}
