package core

import (
	"math/big"
	"testing"
)

// fixround2_test.go — named regression tests for adversarial FIX ROUND 2
// (2026-07-22). One test (or cluster) per finding id.
//
//	EXITTAX-DOS-1  perpetual clock-refresh via transfers bricked market-close
//	               forever (RefundHolder gated on the holder's refreshable clock)
//	               -> FIX: gate the permissionless push on a market-level
//	                  wind-down clock (windDownOpenBlock) no transfer can refresh.
//	NOTICE-1 (r2)  same DoS reached via a 1-token bounce on a natural lapse /
//	               retire notice (distinct from fix-round-1's NOTICE-1, which was
//	               force-taxation DURING the notice — that protection is KEPT
//	               inside the first ExitTaxDecayBlocks of wind-down).
//	OUTFLOW-K-2    a 1-token "poison" transfer flipped a fully-decayed holder to
//	               nonzero tax and refused the sweep -> now bounded by the same
//	               market-level backstop; fresh-holder protection kept in-window.
//	OUTFLOW-K-1    (claimed HIGH fund-theft) REFUTED at exact integers: the
//	               same-block transfer that raises the caller's exit tax ENRICHES
//	               the "victim" far more than the extra tax; the attacker is the
//	               sole loser. No code change; the numbers are the finding.
//
// GUARD: none of these touch the curve math, so R === area(S) in the trading
// phase and the wind-down terminal exactness (C-24: a complete wind-down drains
// the reserve to exactly 0) are unchanged — both asserted below.

// cloneStore is a shallow copy of a MemStore, for "clean-store vs poisoned"
// A/B comparisons.
func cloneStore(s *MemStore) *MemStore {
	c := NewMemStore()
	for _, k := range s.Keys() {
		v, _ := s.Get(k)
		c.Set(k, v)
	}
	return c
}

// bounceRefresh moves `amt` tokens x->y then y->x at `block`, re-aging BOTH
// clocks toward `block` (the griefer's free liveness-poison lever). Requires x
// to hold >= amt at the start.
func bounceRefresh(t *testing.T, s Store, creator, x, y string, block uint64, amt int64) {
	t.Helper()
	if err := TransferCredits(s, creator, x, y, block, big.NewInt(amt)); err != nil {
		t.Fatalf("bounce %s->%s: %v", x, y, err)
	}
	if err := TransferCredits(s, creator, y, x, block, big.NewInt(amt)); err != nil {
		t.Fatalf("bounce %s->%s: %v", y, x, err)
	}
}

// ---------------------------------------------------------------------------
// EXITTAX-DOS-1 — a retired market's close/re-register can no longer be bricked
// by perpetually refreshing a hold clock. The sweep is bounded by a market
// clock: one short of ExitTaxDecayBlocks-in-wind-down it is still refused
// (fresh-holder protection intact); AT the window it fires despite a
// just-refreshed (maximally-fresh) clock, drains supply to 0, closes the
// market, and the identity-bound creator re-registers.
// ---------------------------------------------------------------------------

func TestRefundHolder_EXITTAXDOS1_TwoAccountBounceBounded(t *testing.T) {
	s := NewMemStore()
	const c, g, a = "advcreator", "griefer", "accomplice"
	if err := Register(s, c, c, 1000, 1000, MaxCap); err != nil {
		t.Fatal(err)
	}
	if _, err := Buy(s, g, c, 1000, big.NewInt(2)); err != nil {
		t.Fatal(err)
	}
	if _, err := Buy(s, a, c, 1000, big.NewInt(2)); err != nil {
		t.Fatal(err)
	}
	// R === area(S) holds after the buys (the trading invariant the fix must not
	// disturb — it doesn't; the fix only changes the push GATE).
	if got, want := getMoney(s, kReserve(c)), Area(big.NewInt(4)); got.Cmp(want) != 0 {
		t.Fatalf("R === area(S) broken after buys: R=%s area=%s", got, want)
	}
	if err := Retire(s, c, c, 1000); err != nil {
		t.Fatal(err)
	}
	const open = uint64(1000)

	// (1) ONE SHORT of the window: a fresh bounce keeps the push REFUSED — the
	// EXITTAX-1 fresh-holder protection is intact inside the first six weeks.
	short := open + ExitTaxDecayBlocks - 1
	bounceRefresh(t, s, c, a, g, short, 2)
	if bps := ExitTaxBpsAt(heldBlocksAt(s, c, g, short)); bps == 0 {
		t.Fatalf("fixture: griefer clock should be fresh after the bounce, got 0 bps")
	}
	if _, err := RefundHolder(s, "keeper", c, g, short); errSymbol(err) != ErrState {
		t.Fatalf("one short of the window a fresh push must still be REFUSED, got err=%v", err)
	}
	if CloseIfDrained(s, c, short) {
		t.Fatal("market must not be closeable one short of the backstop window")
	}

	// (2) AT the window: the SAME fresh bounce cannot stop the sweep any more.
	at := open + ExitTaxDecayBlocks
	bounceRefresh(t, s, c, a, g, at, 2) // both clocks now maximally fresh again
	if bps := ExitTaxBpsAt(heldBlocksAt(s, c, a, at)); bps == 0 {
		t.Fatalf("fixture: accomplice clock should be fresh at the window, got 0 bps")
	}
	if _, err := RefundHolder(s, "keeper", c, g, at); err != nil {
		t.Fatalf("AT the window the push must fire despite a fresh clock: %v", err)
	}
	if _, err := RefundHolder(s, "keeper", c, a, at); err != nil {
		t.Fatalf("AT the window the second push must fire despite a fresh clock: %v", err)
	}
	if sup := getMoney(s, kSupply(c)); sup.Sign() != 0 {
		t.Fatalf("supply after the two forced sweeps = %s, want 0", sup)
	}
	// C-24 preserved: a complete wind-down drains the reserve to EXACTLY 0, even
	// though the forced pushes were TAXED (the tax is carved from each payout,
	// never a second reserve debit).
	if res := getMoney(s, kReserve(c)); res.Sign() != 0 {
		t.Fatalf("reserve after complete wind-down = %s, want 0 (C-24)", res)
	}
	if !CloseIfDrained(s, c, at) {
		t.Fatal("EXITTAX-DOS-1: market must CLOSE once drained — the DoS is bounded")
	}
	// The identity-bound creator can finally re-register — the whole point.
	if err := Register(s, c, c, at, 1000, MaxCap); err != nil {
		t.Fatalf("EXITTAX-DOS-1: creator must be able to re-register after close: %v", err)
	}
}

// ---------------------------------------------------------------------------
// NOTICE-1 (FIX ROUND 2) — the SAME liveness DoS reached on a NATURAL lapse
// (no Retire) via a single-token bounce, which exercises the
// paidUntil+GraceBlocks branch of windDownOpenBlock. Also pins that the
// fresh-holder protection is preserved INSIDE the window (a genuinely fresh fan
// cannot be force-pushed there — the fix-round-1 property).
// ---------------------------------------------------------------------------

func TestRefundHolder_NOTICE1DoS_NaturalFreezeRefreshBounded(t *testing.T) {
	s := NewMemStore()
	const c, g, sybil = "lapsecreator", "griefer", "sybil"
	if err := Register(s, c, c, 1000, 1000, MaxCap); err != nil {
		t.Fatal(err)
	}
	// paidUntil = 1000 + SubscriptionPeriod; the natural freeze is at
	// paidUntil + GraceBlocks — the value windDownOpenBlock must anchor to.
	paidUntil := 1000 + SubscriptionPeriod
	freezeAt := paidUntil + GraceBlocks
	if _, err := Buy(s, g, c, 1000, big.NewInt(1)); err != nil {
		t.Fatal(err)
	}
	if _, err := Buy(s, sybil, c, 1000, big.NewInt(1)); err != nil {
		t.Fatal(err)
	}
	if Phase(s, c, freezeAt) != StateFrozen {
		t.Fatalf("fixture: phase at freezeAt = %s, want FROZEN", Phase(s, c, freezeAt))
	}

	// Inside the window: the griefer bounces 1 token to keep its clock fresh, and
	// a still-taxed (fresh-clock) holder cannot be force-pushed there — the
	// fix-round-1 EXITTAX-1/NOTICE-1 fresh-holder protection is preserved.
	inside := freezeAt + ExitTaxDecayBlocks - 1
	bounceRefresh(t, s, c, sybil, g, inside, 1)
	if bps := ExitTaxBpsAt(heldBlocksAt(s, c, g, inside)); bps == 0 {
		t.Fatal("fixture: griefer clock should be fresh after the bounce")
	}
	if _, err := RefundHolder(s, "keeper", c, g, inside); errSymbol(err) != ErrState {
		t.Fatalf("inside window: a refreshed (fresh-clock) holder push must be REFUSED, got %v", err)
	}

	// AT the window (measured from the natural freeze block, NOT the holder's
	// refreshable clock): the sweep fires despite the refresh. Drain and close.
	at := freezeAt + ExitTaxDecayBlocks
	bounceRefresh(t, s, c, sybil, g, at, 1)
	for _, h := range []string{g, sybil} {
		if _, err := RefundHolder(s, "keeper", c, h, at); err != nil {
			t.Fatalf("AT the window: push of %s must fire: %v", h, err)
		}
	}
	if sup := getMoney(s, kSupply(c)); sup.Sign() != 0 {
		t.Fatalf("supply after sweeps = %s, want 0", sup)
	}
	if res := getMoney(s, kReserve(c)); res.Sign() != 0 {
		t.Fatalf("reserve after complete wind-down = %s, want 0 (C-24)", res)
	}
	if !CloseIfDrained(s, c, at) {
		t.Fatal("NOTICE-1 (r2): natural-lapse market must CLOSE once drained")
	}
}

// ---------------------------------------------------------------------------
// OUTFLOW-K-2 — a 1-base-unit "poison" transfer (the finding's cheapest lever)
// flips a fully-decayed holder to nonzero tax. It still (correctly) refuses the
// push INSIDE the window (that IS the fresh-holder protection), but it can no
// longer keep the position un-sweepable forever: exactly at the window boundary
// the sweep fires regardless of the poison. This pins the boundary at
// windDownOpen + ExitTaxDecayBlocks.
// ---------------------------------------------------------------------------

func TestRefundHolder_OUTFLOWK2_TinyPoisonWindowBoundary(t *testing.T) {
	build := func() (*MemStore, string, string, uint64) {
		s := NewMemStore()
		const c, bob, mallory = "alice", "bob", "mallory"
		if err := Register(s, c, c, 1000, 1000, MaxCap); err != nil {
			t.Fatal(err)
		}
		t0 := uint64(2000)
		if _, err := Buy(s, bob, c, t0, big.NewInt(50000)); err != nil {
			t.Fatal(err)
		}
		if _, err := Buy(s, mallory, c, t0, big.NewInt(1)); err != nil {
			t.Fatal(err)
		}
		if err := Retire(s, c, c, t0); err != nil { // wind-down opens at t0
			t.Fatal(err)
		}
		return s, c, bob, t0
	}

	// Boundary: at open+ExitTaxDecayBlocks-1 the poison keeps the push refused;
	// at open+ExitTaxDecayBlocks it cannot.
	sShort, c, bob, open := build()
	shortBlk := open + ExitTaxDecayBlocks - 1
	if err := TransferCredits(sShort, c, "mallory", bob, shortBlk, big.NewInt(1)); err != nil {
		t.Fatal(err)
	}
	if bps := ExitTaxBpsAt(heldBlocksAt(sShort, c, bob, shortBlk)); bps == 0 {
		t.Fatal("fixture: the 1-unit poison should have flipped bob's tax nonzero")
	}
	if _, err := RefundHolder(sShort, "keeper", c, bob, shortBlk); errSymbol(err) != ErrState {
		t.Fatalf("one short of the window, the poison must still refuse the push, got %v", err)
	}

	sAt, c2, bob2, open2 := build()
	atBlk := open2 + ExitTaxDecayBlocks
	if err := TransferCredits(sAt, c2, "mallory", bob2, atBlk, big.NewInt(1)); err != nil {
		t.Fatal(err)
	}
	if bps := ExitTaxBpsAt(heldBlocksAt(sAt, c2, bob2, atBlk)); bps == 0 {
		t.Fatal("fixture: the 1-unit poison should have flipped bob's tax nonzero at the boundary too")
	}
	if _, err := RefundHolder(sAt, "keeper", c2, bob2, atBlk); err != nil {
		t.Fatalf("AT the window the poison must NOT block the sweep: %v", err)
	}
	if bal := getMoney(sAt, kBal(c2, bob2)); bal.Sign() != 0 {
		t.Fatalf("bob balance after the forced sweep = %s, want 0", bal)
	}
}

// ---------------------------------------------------------------------------
// OUTFLOW-K-1 — REFUTED at exact integers. A third party's same-block transfer
// that re-ages the caller's hold clock UP does raise the caller's exit tax, but
// it does so by GIVING the caller tokens whose value dwarfs the extra tax. The
// "victim" ends strictly RICHER; the attacker (mallory) is the sole party who
// loses value; the tax merely routes a fraction of mallory's gift to the
// treasury. This holds on BOTH the (entrypoint-less) Sell and the live Refund
// rail, so no output-protection parameter is warranted for it.
// ---------------------------------------------------------------------------

func TestSell_OUTFLOWK1_RefutedVictimEnriched(t *testing.T) {
	// --- Sell variant (curve rail; market kept ACTIVE) ---
	sellTotals := func(attack bool) (realizedNet, remainingGross *big.Int) {
		s := NewMemStore()
		const c, bob, mallory, carol = "alice", "bob", "mallory", "carol"
		if err := Register(s, c, c, 1000, 1000, MaxCap); err != nil {
			t.Fatal(err)
		}
		t0 := uint64(2000)
		t1 := t0 + ExitTaxDecayBlocks
		setU64(s, kPaidUntil(c), t1+SubscriptionPeriod) // stay ACTIVE through t1
		if _, err := Buy(s, bob, c, t0, big.NewInt(50000)); err != nil {
			t.Fatal(err)
		}
		if attack {
			if _, err := Buy(s, mallory, c, t1, big.NewInt(50000)); err != nil {
				t.Fatal(err)
			}
			if err := TransferCredits(s, c, mallory, bob, t1, big.NewInt(50000)); err != nil {
				t.Fatal(err)
			}
		} else {
			if _, err := Buy(s, carol, c, t1, big.NewInt(50000)); err != nil {
				t.Fatal(err)
			}
		}
		r, err := Sell(s, bob, c, t1, big.NewInt(50000))
		if err != nil {
			t.Fatal(err)
		}
		realizedNet = r.Net
		remainingGross = mZero()
		if rem := getMoney(s, kBal(c, bob)); rem.Sign() > 0 {
			q, err := QuoteSell(s, bob, c, t1, rem)
			if err != nil {
				t.Fatal(err)
			}
			remainingGross = q.Gross // a floor on what bob's kept tokens are worth
		}
		return
	}
	baseNet, baseRem := sellTotals(false)
	atkNet, atkRem := sellTotals(true)
	baseTotal := new(big.Int).Add(baseNet, baseRem)
	atkTotal := new(big.Int).Add(atkNet, atkRem)
	t.Logf("SELL  baseline: net=%s + remaining=%s = %s", baseNet, baseRem, baseTotal)
	t.Logf("SELL  attack  : net=%s + remaining=%s = %s", atkNet, atkRem, atkTotal)
	// The finding's own "loss": baseNet - atkNet == 79,521,629,065.
	if drop := new(big.Int).Sub(baseNet, atkNet); drop.Cmp(big.NewInt(79_521_629_065)) != 0 {
		t.Fatalf("Sell net drop = %s, want the finding's 79,521,629,065", drop)
	}
	// The refutation: bob's TOTAL wealth is strictly higher under the attack.
	if atkTotal.Cmp(baseTotal) <= 0 {
		t.Fatalf("OUTFLOW-K-1 NOT refuted on Sell: attack total %s <= baseline %s", atkTotal, baseTotal)
	}

	// --- Refund variant (the LIVE wind-down rail) ---
	// bob and mallory both buy, then the market retires; mallory transfers their
	// whole position to bob same-block as bob's Refund. bob's Refund tax rises,
	// but bob inherits mallory's entire stake and can Refund it too — bob ends up
	// controlling nearly the whole reserve.
	refundTotal := func(attack bool) *big.Int {
		s := NewMemStore()
		const c, bob, mallory = "alice2", "bob", "mallory"
		if err := Register(s, c, c, 1000, 1000, MaxCap); err != nil {
			t.Fatal(err)
		}
		t0 := uint64(2000)
		if _, err := Buy(s, bob, c, t0, big.NewInt(50000)); err != nil {
			t.Fatal(err)
		}
		if _, err := Buy(s, mallory, c, t0, big.NewInt(50000)); err != nil {
			t.Fatal(err)
		}
		t1 := t0 + ExitTaxDecayBlocks
		if err := Retire(s, c, c, t1); err != nil {
			t.Fatal(err)
		}
		if attack {
			if err := TransferCredits(s, c, mallory, bob, t1, big.NewInt(50000)); err != nil {
				t.Fatal(err)
			}
		}
		total := mZero()
		net1, err := Refund(s, bob, c, t1, big.NewInt(50000))
		if err != nil {
			t.Fatal(err)
		}
		total.Add(total, net1)
		// bob refunds whatever he still holds (his kept gift, in the attack).
		if rem := getMoney(s, kBal(c, bob)); rem.Sign() > 0 {
			net2, err := Refund(s, bob, c, t1, rem)
			if err != nil {
				t.Fatal(err)
			}
			total.Add(total, net2)
		}
		return total
	}
	baseR := refundTotal(false)
	atkR := refundTotal(true)
	t.Logf("REFUND baseline bob total net=%s", baseR)
	t.Logf("REFUND attack   bob total net=%s", atkR)
	if atkR.Cmp(baseR) <= 0 {
		t.Fatalf("OUTFLOW-K-1 NOT refuted on Refund: attack %s <= baseline %s", atkR, baseR)
	}
	t.Log("OUTFLOW-K-1 REFUTED: on both rails the 'victim' nets strictly MORE under the attack; mallory is the sole loser")
}

// ---------------------------------------------------------------------------
// windDownOpenBlock — the market-level anchor. Retire pins it to retiredAt;
// a natural lapse pins it to paidUntil+GraceBlocks; ACTIVE / recoverable
// natural-OVERDUE report not-in-wind-down.
// ---------------------------------------------------------------------------

func TestWindDownOpenBlock_Sources(t *testing.T) {
	// Retire path.
	s := NewMemStore()
	const c = "creA"
	if err := Register(s, c, c, 1000, 1000, MaxCap); err != nil {
		t.Fatal(err)
	}
	if _, ok := windDownOpenBlock(s, c, 5000); ok {
		t.Fatal("ACTIVE market must report not-in-wind-down")
	}
	if err := Retire(s, c, c, 7000); err != nil {
		t.Fatal(err)
	}
	if open, ok := windDownOpenBlock(s, c, 7001); !ok || open != 7000 {
		t.Fatalf("retired windDownOpen = (%d,%v), want (7000,true)", open, ok)
	}

	// Natural-lapse path (no retire).
	s2 := NewMemStore()
	const c2 = "creB"
	if err := Register(s2, c2, c2, 1000, 1000, MaxCap); err != nil {
		t.Fatal(err)
	}
	paidUntil := getU64(s2, kPaidUntil(c2))
	freezeAt := paidUntil + GraceBlocks
	// OVERDUE (recoverable) is NOT wind-down.
	if _, ok := windDownOpenBlock(s2, c2, paidUntil+1); ok {
		t.Fatal("natural-lapse OVERDUE must report not-in-wind-down (recoverable)")
	}
	if open, ok := windDownOpenBlock(s2, c2, freezeAt); !ok || open != freezeAt {
		t.Fatalf("natural-freeze windDownOpen = (%d,%v), want (%d,true)", open, ok, freezeAt)
	}
}
