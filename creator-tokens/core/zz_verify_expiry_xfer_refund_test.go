package core

import (
	"math/big"
	"testing"
)

// SCENARIO 4 — TRANSFER + REFUND AFTER EXPIRY.
//   (a) a matured position transferred out (both matured-transfer rails)
//   (b) a matured position refunded on the wind-down rail
// Assert: 0 exit tax, correct payout, no orphan `lots|`, conservation holds.

// (a1) TransferMatured of a wholly-matured (graduated) position.
func TestZZVerifyExpiry_TransferMaturedAfterExpiry(t *testing.T) {
	const c, h, h2 = "hive:alice", "hive:bob", "hive:carol"
	s := tbMarket(t, c)
	b1 := uint64(1_000_000)
	at := zvMature(t, s, c, h, 500, b1)
	if Graduate(s, c, h, at).Cmp(big.NewInt(500)) != 0 {
		t.Fatal("graduate 500")
	}

	supplyBefore := new(big.Int).Set(Supply(s, c))
	reserveBefore := new(big.Int).Set(Reserve(s, c))

	if err := TransferMatured(s, c, h, h2, h, big.NewInt(200)); err != nil {
		t.Fatalf("TransferMatured refused: %v", err)
	}
	// Matured tokens stay matured for the recipient; no tax, no clock, no lots.
	if MaturedOf(s, c, h).Cmp(big.NewInt(300)) != 0 {
		t.Fatalf("sender matured=%s want 300", MaturedOf(s, c, h))
	}
	if MaturedOf(s, c, h2).Cmp(big.NewInt(200)) != 0 {
		t.Fatalf("recipient matured=%s want 200", MaturedOf(s, c, h2))
	}
	if zvHasLots(s, c, h) || zvHasLots(s, c, h2) {
		t.Fatalf("ORPHAN: matured transfer created/kept a lots| ledger (h=%q h2=%q)", zvLotsStr(s, c, h), zvLotsStr(s, c, h2))
	}
	if MaturingOf(s, c, h2).Sign() != 0 {
		t.Fatalf("recipient maturing=%s want 0 (matured stays matured)", MaturingOf(s, c, h2))
	}
	// Supply/reserve are untouched by a transfer (no curve leg).
	if Supply(s, c).Cmp(supplyBefore) != 0 || Reserve(s, c).Cmp(reserveBefore) != 0 {
		t.Fatalf("transfer moved supply/reserve: supply %s->%s reserve %s->%s", supplyBefore, Supply(s, c), reserveBefore, Reserve(s, c))
	}
	zvAssertNoOrphanLots(t, s, "after matured transfer")
	zvAssertPositionsSumToSupply(t, s, c, "after matured transfer")
}

// (a2) TransferCredits of a wholly-matured (graduated) position: the matured
// leg crosses as matured, no lots ledger is created on either side.
func TestZZVerifyExpiry_TransferCreditsOfMaturedAfterExpiry(t *testing.T) {
	const c, h, h2 = "hive:alice", "hive:bob", "hive:carol"
	s := tbMarket(t, c)
	b1 := uint64(1_000_000)
	at := zvMature(t, s, c, h, 500, b1)
	if Graduate(s, c, h, at).Cmp(big.NewInt(500)) != 0 {
		t.Fatal("graduate 500")
	}

	if err := TransferCredits(s, h, c, h, h2, at, big.NewInt(200)); err != nil {
		t.Fatalf("TransferCredits refused: %v", err)
	}
	if MaturedOf(s, c, h).Cmp(big.NewInt(300)) != 0 {
		t.Fatalf("sender matured=%s want 300", MaturedOf(s, c, h))
	}
	if MaturedOf(s, c, h2).Cmp(big.NewInt(200)) != 0 {
		t.Fatalf("recipient matured=%s want 200 (matured leg stays matured)", MaturedOf(s, c, h2))
	}
	if MaturingOf(s, c, h2).Sign() != 0 {
		t.Fatalf("recipient maturing=%s want 0", MaturingOf(s, c, h2))
	}
	if zvHasLots(s, c, h) || zvHasLots(s, c, h2) {
		t.Fatalf("ORPHAN: TransferCredits of matured tokens touched a lots| ledger (h=%q h2=%q)", zvLotsStr(s, c, h), zvLotsStr(s, c, h2))
	}
	zvAssertNoOrphanLots(t, s, "after TransferCredits of matured")
	zvAssertPositionsSumToSupply(t, s, c, "after TransferCredits of matured")
}

// (b) Refund of a matured position — both the already-graduated case and the
// matured-but-not-yet-graduated case. Both must pay ZERO exit tax.
func TestZZVerifyExpiry_RefundMaturedAfterExpiry(t *testing.T) {
	run := func(t *testing.T, graduateFirst bool) {
		const c, h = "hive:alice", "hive:bob"
		s := tbMarket(t, c)
		b1 := uint64(1_000_000)
		at := zvMature(t, s, c, h, 500, b1)

		if graduateFirst {
			if Graduate(s, c, h, at).Cmp(big.NewInt(500)) != 0 {
				t.Fatal("graduate 500")
			}
		}

		// Retire to open the wind-down (Refund) rail.
		if err := Retire(s, c, c, at); err != nil {
			t.Fatalf("retire: %v", err)
		}
		windDown := at + 1
		if !inWindDown(s, c, windDown) {
			t.Fatal("market must be winding down after retire")
		}
		// Sell must be closed in wind-down (proves we exercise the Refund rail).
		if _, err := Sell(s, h, c, windDown, big.NewInt(1)); err == nil {
			t.Fatal("curve rail must be closed during wind-down")
		}

		// Snapshot tax sinks so we can prove NO exit tax was accrued.
		treasuryBefore := new(big.Int).Set(getMoney(s, kTreasury()))
		feeBalBefore := new(big.Int).Set(getMoney(s, kFeeBal(c)))
		// gross the holder is owed (flat pro-rata); with a lone full holder this
		// is the whole reserve.
		wantGross := refundPayout(Reserve(s, c), big.NewInt(500), Supply(s, c))

		net, err := Refund(s, h, c, windDown, big.NewInt(500))
		if err != nil {
			t.Fatalf("TRAPPED / refund refused: %v", err)
		}
		// net == gross  <=>  tax == 0.
		if net.Cmp(wantGross) != 0 {
			t.Fatalf("refund net=%s != gross=%s — a matured position was taxed (tax=%s)", net, wantGross, new(big.Int).Sub(wantGross, net))
		}
		if got := getMoney(s, kTreasury()); got.Cmp(treasuryBefore) != 0 {
			t.Fatalf("treasury moved by %s — matured refund must accrue 0 exit tax", new(big.Int).Sub(got, treasuryBefore))
		}
		if got := getMoney(s, kFeeBal(c)); got.Cmp(feeBalBefore) != 0 {
			t.Fatalf("creator fee pot moved by %s — matured refund must accrue 0 exit tax", new(big.Int).Sub(got, feeBalBefore))
		}
		t.Logf("graduateFirst=%v: refund 500 gross=%s net=%s tax=0", graduateFirst, wantGross, net)

		// Full exit: position, supply, reserve all zero; no orphan ledger.
		if totalBalance(s, c, h).Sign() != 0 {
			t.Fatalf("position=%s want 0 after full refund", totalBalance(s, c, h))
		}
		if Supply(s, c).Sign() != 0 || Reserve(s, c).Sign() != 0 {
			t.Fatalf("supply=%s reserve=%s want 0/0 after full refund", Supply(s, c), Reserve(s, c))
		}
		if zvHasLots(s, c, h) {
			t.Fatalf("ORPHAN: lots| survived a full matured refund: %q", zvLotsStr(s, c, h))
		}
		zvAssertNoOrphanLots(t, s, "after matured refund")
	}

	t.Run("graduated_first", func(t *testing.T) { run(t, true) })
	t.Run("matured_not_graduated", func(t *testing.T) { run(t, false) })
}
