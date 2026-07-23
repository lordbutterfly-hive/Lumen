package core

import (
	"fmt"
	"math/big"
	"math/rand"
	"testing"
)

// ---------------------------------------------------------------------------
// NOTE on shared test harness: setupMarket, sumBalances and errSymbol are
// defined once, in prepay_test.go, and reused here rather than redeclared —
// redeclaring any of them in this file would be a package-level name
// collision (Go does not allow two functions with the same name in the same
// package, even across files). Same convention prepay_test.go itself
// documents: exercise this file's functions against the API.md contract by
// writing state directly through the keys.go builders, without depending on
// market.go's (not yet landed) Register/Renew internals.
// ---------------------------------------------------------------------------

// forceFrozen pushes a market (already set up via setupMarket) into a
// FROZEN-shaped state: paidUntil in the past, past its grace window too.
// Mirrors prepay_test.go's TestTransferCredits_WorksRegardlessOfBillingPhase.
func forceFrozen(s Store, creator string) {
	setU64(s, kPaidUntil(creator), 50)
	setU64(s, kFrozenAt(creator), 50+GraceBlocks)
}

// wdNet computes the NET wind-down payout a holder receives under RULING K2:
// the gross pro-rata floor(R·c/S) MINUS the hold-time exit tax the wind-down
// now carries (K2). It reads the PRE-refund state, so call it before the
// Refund/RefundHolder. The raw setMoney fixtures in this file never clock their
// holders, so heldBlocksAt reads 0 (unset == fresh, holdclock.go's convention)
// and τ = MaxExitTaxBps = 2000 — i.e. these fresh holders pay the full 20% on
// the way out, exactly like a fresh curve exit. Returns (net, gross, tax) so a
// test can assert the reserve dropped by gross and the treasury gained tax.
func wdNet(s Store, creator, holder string, block uint64, credits *big.Int) (net, gross, tax *big.Int) {
	gross = refundPayout(getMoney(s, kReserve(creator)), credits, getMoney(s, kSupply(creator)))
	tax = ExitTaxOn(gross, ExitTaxBpsAt(heldBlocksAt(s, creator, holder, block)))
	net = new(big.Int).Sub(gross, tax)
	return net, gross, tax
}

// ---------------------------------------------------------------------------
// RefundPrice
// ---------------------------------------------------------------------------

func TestRefundPrice_ZeroSupply(t *testing.T) {
	s := NewMemStore()
	creator := "pricecreatora"
	// No supply ever set (and even a stray reserve, to prove the zero-supply
	// short-circuit really does skip the division rather than computing 0/0
	// by luck).
	setMoney(s, kReserve(creator), big.NewInt(500))

	price := RefundPrice(s, creator)
	if !mIsZero(price) {
		t.Fatalf("RefundPrice with zero supply = %s, want 0", price)
	}
}

func TestRefundPrice_NormalRatio(t *testing.T) {
	s := NewMemStore()
	creator := "pricecreatorb"

	setMoney(s, kSupply(creator), big.NewInt(1000))
	setMoney(s, kReserve(creator), big.NewInt(700))
	if got := RefundPrice(s, creator); got.Cmp(mZero()) != 0 {
		// floor(700/1000) == 0: a below-par single-credit price legitimately
		// floors to zero. This is NOT a bug — see
		// TestRefund_BulkRefundNotCrippledByPerCreditRounding, which proves a
		// bulk Refund of many credits still pays out correctly even though
		// RefundPrice() itself reads 0 here.
		t.Fatalf("RefundPrice = %s, want 0 (floor(700/1000))", got)
	}

	setMoney(s, kSupply(creator), big.NewInt(9))
	setMoney(s, kReserve(creator), big.NewInt(4))
	if got := RefundPrice(s, creator); got.Cmp(mZero()) != 0 {
		t.Fatalf("RefundPrice = %s, want 0 (floor(4/9))", got)
	}
}

// THE PAR CLAMP IS DELETED (RULING A's hard gate; this test previously
// asserted it and was inverted deliberately, not deleted, so the reversal
// is on the record). RefundPrice used to clamp its answer at ONE base unit
// per token. Under PAR that clamp was dead code — reserve == supply made
// floor(R/S) == 1 exactly. Under the curve it was a CONFISCATION: curve
// backing runs many units per token, so a curve-priced position quoted (and
// refunded) at 1 unit/token loses almost all of its backing to a cap built
// for a mechanism that no longer exists.
func TestRefundPrice_NoParClamp_ReportsTheRealRatio(t *testing.T) {
	s := NewMemStore()
	creator := "pricecreatorc"

	// A ratio far above the deleted PAR=1 cap. Under the curve this is the
	// NORMAL case, not a peg violation: area(S)/S is well above 1 at every
	// supply (BasePrice alone is 1000 units/token).
	setMoney(s, kSupply(creator), big.NewInt(10))
	setMoney(s, kReserve(creator), big.NewInt(35))

	if price := RefundPrice(s, creator); price.Cmp(big.NewInt(3)) != 0 {
		t.Fatalf("RefundPrice = %s, want floor(35/10) = 3 — the real ratio, NOT the deleted PAR clamp of 1", price)
	}

	// And on a genuine curve state: a market whose reserve is exactly
	// area(S) quotes floor(area(S)/S), which is ~the average curve price —
	// hundreds of times above the old cap.
	s2 := NewMemStore()
	setupMarket(s2, "curvemkt", 100, MaxCap)
	if _, err := Buy(s2, "holder", "curvemkt", 200, big.NewInt(100)); err != nil {
		t.Fatal(err)
	}
	want := mMulDiv(Area(big.NewInt(100)), big.NewInt(1), big.NewInt(100))
	if got := RefundPrice(s2, "curvemkt"); got.Cmp(want) != 0 {
		t.Fatalf("RefundPrice on a curve market = %s, want floor(area(100)/100) = %s", got, want)
	}
	if want.Cmp(big.NewInt(ParBaseUnitsPerCredit)) <= 0 {
		t.Fatalf("test is vacuous: the curve ratio %s is not above the deleted PAR cap %d", want, ParBaseUnitsPerCredit)
	}
}

// ---------------------------------------------------------------------------
// Refund — happy path, no commission (I5), exact peg means exact payout.
// ---------------------------------------------------------------------------

// TestRefund_K2_WindDownTaxMatchesCurveExit is RULING K2's headline, worked end
// to end: the wind-down now carries the SAME hold-time exit tax the curve
// charges, so a fresh dominant creator can no longer escape the tax by
// Retiring instead of selling (THM-1's residual whale exit). For a holder who
// owns the WHOLE supply the two exits are the same size — a full curve Sell
// realises area(S) == R, and a full pro-rata Refund pays floor(R·S/S) == R —
// so the tax is IDENTICAL to the base unit. A six-week holder pays 0 on the
// wind-down. And R's trajectory (area(S) → area(0) == 0) is UNAFFECTED by the
// tax: the reserve is debited the full gross, the tax is carved from the
// payout.
func TestRefund_K2_WindDownTaxMatchesCurveExit(t *testing.T) {
	const n = 300
	// --- the CURVE exit: fresh whale buys n, sells all n in the same block ---
	sc := NewMemStore()
	setupMarket(sc, "curvecrea", 100, MaxCap)
	if _, err := Buy(sc, "whale", "curvecrea", 1000, big.NewInt(n)); err != nil {
		t.Fatal(err)
	}
	Rcurve := getMoney(sc, kReserve("curvecrea"))
	sell, err := Sell(sc, "whale", "curvecrea", 1000, big.NewInt(n)) // fresh, τ=2000
	if err != nil {
		t.Fatal(err)
	}
	if sell.TaxBps != MaxExitTaxBps {
		t.Fatalf("curve exit τ = %d bps, want %d (fresh)", sell.TaxBps, MaxExitTaxBps)
	}
	if sell.Gross.Cmp(Rcurve) != 0 {
		t.Fatalf("full curve exit gross %s != the whole reserve %s (area(n) == R)", sell.Gross, Rcurve)
	}

	// --- the WIND-DOWN exit: fresh whale buys n, Retires, winds down ---
	sw := NewMemStore()
	setupMarket(sw, "windcrea", 100, MaxCap)
	if _, err := Buy(sw, "whale", "windcrea", 1000, big.NewInt(n)); err != nil {
		t.Fatal(err)
	}
	Rwind := getMoney(sw, kReserve("windcrea"))
	if Rwind.Cmp(Rcurve) != 0 {
		t.Fatalf("setup: the two markets must start identical (R %s vs %s)", Rwind, Rcurve)
	}
	if err := Retire(sw, "windcrea", "windcrea", 1001); err != nil {
		t.Fatal(err)
	}
	treaBefore := getMoney(sw, kTreasury())
	// Inside the retire notice (RULING K3: inWindDown → Refund open), still
	// fresh (held 2 blocks ⇒ τ=2000). gross = floor(R·n/n) = R.
	gross := refundPayout(Rwind, big.NewInt(n), getMoney(sw, kSupply("windcrea")))
	wdTaxBps := ExitTaxBpsAt(heldBlocksAt(sw, "windcrea", "whale", 1002))
	wdTax := ExitTaxOn(gross, wdTaxBps)
	net, err := Refund(sw, "whale", "windcrea", 1002, big.NewInt(n))
	if err != nil {
		t.Fatal(err)
	}

	// THE HEADLINE: the wind-down tax equals the curve-exit tax to the unit —
	// Retiring buys the whale NO tax advantage.
	if wdTaxBps != MaxExitTaxBps {
		t.Fatalf("wind-down τ = %d bps, want %d (fresh)", wdTaxBps, MaxExitTaxBps)
	}
	if gross.Cmp(Rcurve) != 0 {
		t.Fatalf("full wind-down gross %s != the whole reserve %s (floor(R·S/S) == R)", gross, Rcurve)
	}
	if wdTax.Cmp(sell.Tax) != 0 {
		t.Fatalf("K2: wind-down tax %s != curve-exit tax %s — the Retire escape hatch is not closed", wdTax, sell.Tax)
	}
	// The tax actually landed in the treasury, and net = gross − tax.
	if got := new(big.Int).Sub(getMoney(sw, kTreasury()), treaBefore); got.Cmp(wdTax) != 0 {
		t.Fatalf("treasury delta %s != wind-down tax %s", got, wdTax)
	}
	if net.Cmp(new(big.Int).Sub(gross, wdTax)) != 0 {
		t.Fatalf("net %s != gross %s − tax %s", net, gross, wdTax)
	}
	// R's trajectory is UNAFFECTED by the tax: the reserve drained to exactly 0
	// == area(0) (it was debited the full gross), the same as the curve exit.
	if r := getMoney(sw, kReserve("windcrea")); !mIsZero(r) {
		t.Fatalf("wind-down reserve = %s, want 0 == area(0) (reserve pays the full gross; tax carved from payout)", r)
	}

	// --- and a SIX-WEEK holder pays ZERO on the wind-down ---
	sp := NewMemStore()
	setupMarket(sp, "patientcrea", 100, MaxCap)
	if _, err := Buy(sp, "patient", "patientcrea", 1000, big.NewInt(n)); err != nil {
		t.Fatal(err)
	}
	if err := Retire(sp, "patientcrea", "patientcrea", 1000+ExitTaxDecayBlocks); err != nil {
		t.Fatal(err)
	}
	wdBlock := 1000 + ExitTaxDecayBlocks + 1 // held the full six weeks ⇒ τ=0
	grossP := refundPayout(getMoney(sp, kReserve("patientcrea")), big.NewInt(n), getMoney(sp, kSupply("patientcrea")))
	treaP := getMoney(sp, kTreasury())
	netP, err := Refund(sp, "patient", "patientcrea", wdBlock, big.NewInt(n))
	if err != nil {
		t.Fatal(err)
	}
	if netP.Cmp(grossP) != 0 {
		t.Fatalf("six-week wind-down net %s != gross %s — a fully-decayed holder must pay 0 tax", netP, grossP)
	}
	if got := getMoney(sp, kTreasury()); got.Cmp(treaP) != 0 {
		t.Fatalf("six-week wind-down moved the treasury: %s -> %s, want 0 tax", treaP, got)
	}
}

func TestRefund_HappyPath_NoCommission(t *testing.T) {
	s := NewMemStore()
	creator := "refundcreatora"
	setupMarket(s, creator, 100, MaxCap)

	// A synthetic 1:1 fixture (reserve == supply) chosen so the pro-rata
	// arithmetic is checkable by eye; refundPayout's proof is scale-free, so
	// the ratio is a test convenience, not a claim about the live curve
	// (where reserve == area(supply), far above supply).
	setMoney(s, kSupply(creator), big.NewInt(1000))
	setMoney(s, kReserve(creator), big.NewInt(1000))
	setMoney(s, kBal(creator, "alice"), big.NewInt(300))
	forceFrozen(s, creator)

	// WIND-DOWN BLOCK. Refund is the wind-down rail and is phase-routed to
	// FROZEN/CLOSED (refund.go's rail reconciliation — during ACTIVE/OVERDUE
	// the holder's exit is Sell, at strictly better pricing; an ungated
	// pro-rata while buys are live is a tax-and-fee bypass). These fixtures
	// never Register, so kPaidUntil reads 0 and any block past GraceBlocks
	// derives to FROZEN — which is the phase a refund test should have been
	// running in all along.
	const wdBlock = 50 + GraceBlocks + 1
	treaBefore := getMoney(s, kTreasury())
	// I5: no COMMISSION ever taken from a refund (a 12% commission would make
	// the gross 88). RULING K2: the wind-down DOES carry the exit tax — this
	// fresh (unclocked) holder pays the full 20%, so gross 100 → tax 20 → net
	// 80. The reserve still drops by the full gross 100; the tax goes to
	// treasury.
	wantNet, gross, tax := wdNet(s, creator, "alice", wdBlock, big.NewInt(100))
	payout, err := Refund(s, "alice", creator, wdBlock, big.NewInt(100))
	if err != nil {
		t.Fatalf("Refund: %v", err)
	}
	if gross.Cmp(big.NewInt(100)) != 0 || tax.Cmp(big.NewInt(20)) != 0 || wantNet.Cmp(big.NewInt(80)) != 0 {
		t.Fatalf("K2 split = gross %s tax %s net %s, want 100/20/80", gross, tax, wantNet)
	}
	if payout.Cmp(wantNet) != 0 {
		t.Fatalf("payout = %s, want net %s (gross 100 − K2 tax 20; no commission)", payout, wantNet)
	}
	if got := getMoney(s, kBal(creator, "alice")); got.Cmp(big.NewInt(200)) != 0 {
		t.Fatalf("alice balance = %s, want 200", got)
	}
	if got := getMoney(s, kSupply(creator)); got.Cmp(big.NewInt(900)) != 0 {
		t.Fatalf("supply = %s, want 900", got)
	}
	if got := getMoney(s, kReserve(creator)); got.Cmp(big.NewInt(900)) != 0 {
		t.Fatalf("reserve = %s, want 900 (decremented by exactly the GROSS payout)", got)
	}
	if got := new(big.Int).Sub(getMoney(s, kTreasury()), treaBefore); got.Cmp(tax) != 0 {
		t.Fatalf("treasury delta = %s, want the K2 tax %s", got, tax)
	}
}

func TestRefund_FullBalanceDrainsToZero(t *testing.T) {
	s := NewMemStore()
	creator := "refundcreatorb"
	setMoney(s, kSupply(creator), big.NewInt(250))
	setMoney(s, kReserve(creator), big.NewInt(250))
	setMoney(s, kBal(creator, "alice"), big.NewInt(250))
	forceFrozen(s, creator)

	// WIND-DOWN BLOCK. Refund is the wind-down rail and is phase-routed to
	// FROZEN/CLOSED (refund.go's rail reconciliation — during ACTIVE/OVERDUE
	// the holder's exit is Sell, at strictly better pricing; an ungated
	// pro-rata while buys are live is a tax-and-fee bypass). These fixtures
	// never Register, so kPaidUntil reads 0 and any block past GraceBlocks
	// derives to FROZEN — which is the phase a refund test should have been
	// running in all along.
	const wdBlock = 50 + GraceBlocks + 1
	// RULING K2: fresh holder → net = gross 250 − tax 50 = 200; the RESERVE
	// still drains to exactly 0 (it is debited the full gross).
	wantNet, _, _ := wdNet(s, creator, "alice", wdBlock, big.NewInt(250))
	payout, err := Refund(s, "alice", creator, wdBlock, big.NewInt(250))
	if err != nil {
		t.Fatalf("Refund: %v", err)
	}
	if payout.Cmp(wantNet) != 0 || wantNet.Cmp(big.NewInt(200)) != 0 {
		t.Fatalf("payout = %s, want net %s (== 200: gross 250 − K2 tax 50)", payout, wantNet)
	}
	if got := getMoney(s, kSupply(creator)); !mIsZero(got) {
		t.Fatalf("supply = %s, want 0", got)
	}
	if got := getMoney(s, kReserve(creator)); !mIsZero(got) {
		t.Fatalf("reserve = %s, want exactly 0 (zero dust)", got)
	}
}

// TestRefund_BulkRefundNotCrippledByPerCreditRounding proves Refund computes
// its own floor(reserve*credits/supply) directly on the FULL credits amount
// rather than (incorrectly) multiplying credits by RefundPrice()'s already-
// floored per-credit price. RefundPrice legitimately rounds to 0 whenever
// reserve < supply by less than one credit's worth of ratio; if Refund were
// implemented as credits*RefundPrice(), every refund in that regime would pay
// out 0, which would be a much harsher (and undocumented) rounding rule than
// API.md specifies. API.md gives Refund its OWN formula
// (mMulDiv(reserve, credits, supply)) precisely to avoid this.
func TestRefund_BulkRefundNotCrippledByPerCreditRounding(t *testing.T) {
	s := NewMemStore()
	creator := "refundcreatorc"
	setMoney(s, kSupply(creator), big.NewInt(1000))
	setMoney(s, kReserve(creator), big.NewInt(999)) // ratio 0.999
	setMoney(s, kBal(creator, "alice"), big.NewInt(1000))
	forceFrozen(s, creator)

	if price := RefundPrice(s, creator); !mIsZero(price) {
		t.Fatalf("test setup assumption broken: RefundPrice = %s, want 0 (floor(999/1000))", price)
	}

	// WIND-DOWN BLOCK. Refund is the wind-down rail and is phase-routed to
	// FROZEN/CLOSED (refund.go's rail reconciliation — during ACTIVE/OVERDUE
	// the holder's exit is Sell, at strictly better pricing; an ungated
	// pro-rata while buys are live is a tax-and-fee bypass). These fixtures
	// never Register, so kPaidUntil reads 0 and any block past GraceBlocks
	// derives to FROZEN — which is the phase a refund test should have been
	// running in all along.
	const wdBlock = 50 + GraceBlocks + 1
	// The bulk payout reads the whole reserve as GROSS (999, not 0 — the point
	// of this test). RULING K2 then carves the fresh holder's tax: net = 999 −
	// ceil(999·0.2) = 999 − 200 = 799. The bulk formula is what makes gross 999
	// instead of credits×floor(999/1000)=0.
	wantNet, gross, _ := wdNet(s, creator, "alice", wdBlock, big.NewInt(1000))
	payout, err := Refund(s, "alice", creator, wdBlock, big.NewInt(1000))
	if err != nil {
		t.Fatalf("Refund: %v", err)
	}
	if gross.Cmp(big.NewInt(999)) != 0 {
		t.Fatalf("bulk gross = %s, want 999 (full reserve, not 0 — the per-credit-rounding trap)", gross)
	}
	if payout.Cmp(wantNet) != 0 || wantNet.Cmp(big.NewInt(799)) != 0 {
		t.Fatalf("bulk payout = %s, want net %s (== 799: gross 999 − K2 tax 200)", payout, wantNet)
	}
}

// ---------------------------------------------------------------------------
// Refund — must work in every phase, including FROZEN, and while paused.
// ---------------------------------------------------------------------------

func TestRefund_WorksWhileFrozenAndGloballyPaused(t *testing.T) {
	s := NewMemStore()
	creator := "refundcreatord"
	setupMarket(s, creator, 100, MaxCap)
	forceFrozen(s, creator)
	setStr(s, kState(creator), StateFrozen)
	setStr(s, kPaused(), "1") // global inbound pause set

	setMoney(s, kSupply(creator), big.NewInt(500))
	setMoney(s, kReserve(creator), big.NewInt(500))
	setMoney(s, kBal(creator, "alice"), big.NewInt(500))

	wantNet, _, _ := wdNet(s, creator, "alice", 50+GraceBlocks+1, big.NewInt(500))
	payout, err := Refund(s, "alice", creator, 50+GraceBlocks+1, big.NewInt(500))
	if err != nil {
		t.Fatalf("Refund must succeed while FROZEN and globally paused: %v", err)
	}
	// RULING K2: fresh holder → net = 500 − 100 = 400; reserve still drains to 0.
	if payout.Cmp(wantNet) != 0 || wantNet.Cmp(big.NewInt(400)) != 0 {
		t.Fatalf("payout = %s, want net %s (== 400: gross 500 − K2 tax 100)", payout, wantNet)
	}
	if got := getMoney(s, kReserve(creator)); !mIsZero(got) {
		t.Fatalf("reserve = %s, want 0", got)
	}
}

// TestRefundHolder_RegressionActiveRevertsFrozenPays is H3's dedicated
// proof, driven through a REAL Register (not a direct-state-write trick),
// exactly as the task requires: "RefundHolder in ACTIVE reverts; in FROZEN
// it still pays the holder." Before the fix, RefundHolder worked in EVERY
// phase — a permissionless third party could force-liquidate any holder's
// live, ACTIVE-market position at will, with zero consent, defeating the
// entire point of the supply cap as a "speculation switch" (SPEC §1.3):
// holders were never safe from an unwanted forced exit until the market
// itself actually wound down.
func TestRefundHolder_RegressionActiveRevertsFrozenPays(t *testing.T) {
	s := NewMemStore()
	const creator = "h3activereverts"
	const holder = "h3holder"
	const pusher = "h3thirdparty"
	regBlock := uint64(1000)

	mustRegister(t, s, creator, regBlock, 1000, MaxCap)
	if _, err := Buy(s, holder, creator, regBlock+1, big.NewInt(2000)); err != nil {
		t.Fatalf("Buy: %v", err)
	}

	activeBlock := regBlock + 2
	if got := Phase(s, creator, activeBlock); got != StateActive {
		t.Fatalf("sanity: phase = %s, want ACTIVE", got)
	}

	before := getMoney(s, kBal(creator, holder))
	_, err := RefundHolder(s, pusher, creator, holder, activeBlock)
	if err == nil {
		t.Fatal("H3 REGRESSION: RefundHolder succeeded in ACTIVE — a live holder position was force-liquidated without consent")
	}
	if sym := errSymbol(err); sym != ErrState {
		t.Fatalf("want ErrState, got %v", err)
	}
	if got := getMoney(s, kBal(creator, holder)); got.Cmp(before) != 0 {
		t.Fatalf("holder balance mutated by a rejected ACTIVE-phase RefundHolder: %s -> %s", before, got)
	}

	// THE RAIL RECONCILIATION (updated 2026-07-21 — this block previously
	// asserted that the holder's own Refund still worked in ACTIVE, which
	// was correct under PAR and is now WRONG under the curve): Refund is the
	// WIND-DOWN rail and is phase-routed to FROZEN/CLOSED, because an
	// ungated pro-rata while buys are live is a tax-and-fee bypass that also
	// strands excess in the reserve (refund.go's rail reconciliation). The
	// guarantee it used to encode — "self-exit is always available" — is
	// UNCHANGED and is what is asserted here instead: in ACTIVE the holder's
	// self-exit is Sell, and it works. What H3 gates is the PUSH (a stranger
	// force-liquidating a live position), never the holder's own exit.
	if _, err := Refund(s, holder, creator, activeBlock, big.NewInt(500)); errSymbol(err) != ErrState {
		t.Fatalf("Refund in ACTIVE: err=%v, want %s (routed to the Sell rail, not open)", err, ErrState)
	}
	rs, err := Sell(s, holder, creator, activeBlock, big.NewInt(500))
	if err != nil {
		t.Fatalf("the holder's OWN exit must always work — Sell in ACTIVE: %v", err)
	}
	if rs.Net.Sign() <= 0 {
		t.Fatalf("self-Sell net = %s, want > 0", rs.Net)
	}

	// OVERDUE — the grace window — is also still refused; the fix is a
	// FROZEN-or-CLOSED allowlist, not merely "not ACTIVE".
	overdueBlock := regBlock + SubscriptionPeriod + 10
	if got := Phase(s, creator, overdueBlock); got != StateOverdue {
		t.Fatalf("sanity: phase = %s, want OVERDUE", got)
	}
	if _, err := RefundHolder(s, pusher, creator, holder, overdueBlock); err == nil || errSymbol(err) != ErrState {
		t.Fatalf("RefundHolder in OVERDUE: err=%v, want ErrState", err)
	}

	// FROZEN: RefundHolder now works — but only for a FULLY-DECAYED holder
	// (EXITTAX-1/NOTICE-1, 2026-07-22): the permissionless push refuses while the
	// holder's exit tax is still nonzero. This holder bought via a genuine Buy at
	// regBlock+1, so the push lands a full ExitTaxDecayBlocks past the lapse+grace
	// freeze, by which point their hold clock has decayed to τ = 0 and the sweep
	// is a harmless, untaxed pro-rata. (A push at the earlier, still-taxable block
	// is rejected — see TestRefundHolder_EXITTAX1_FreshPushRefused.)
	frozenBlock := regBlock + SubscriptionPeriod + GraceBlocks + 10 + ExitTaxDecayBlocks
	if got := Phase(s, creator, frozenBlock); got != StateFrozen {
		t.Fatalf("sanity: phase = %s, want FROZEN", got)
	}
	remaining := getMoney(s, kBal(creator, holder))
	// Under the curve, TOKENS and HBD are different units — the payout is
	// the flat pro-rata floor(R·bal/S), NOT the token count (which is what
	// this line compared under the deleted 1:1 PAR mint). The holder here
	// owns the entire remaining supply, so pro-rata pays them the WHOLE
	// reserve as GROSS (C-24 terminal exactness); their hold clock has fully
	// decayed by this block, so the RULING K2 wind-down tax is 0 and net == gross
	// (computed from the clock via wdNet, not assumed).
	wantNet, _, _ := wdNet(s, creator, holder, frozenBlock, remaining)
	payout, err := RefundHolder(s, pusher, creator, holder, frozenBlock)
	if err != nil {
		t.Fatalf("RefundHolder must succeed once FROZEN: %v", err)
	}
	if payout.Cmp(wantNet) != 0 {
		t.Fatalf("payout = %s, want the net pro-rata share %s (gross − K2 tax) for the holder's %s tokens", payout, wantNet, remaining)
	}
	if got := getMoney(s, kBal(creator, holder)); !mIsZero(got) {
		t.Fatalf("holder balance after FROZEN RefundHolder = %s, want 0", got)
	}
}

func TestRefundHolder_WorksWhileFrozenAndGloballyPaused(t *testing.T) {
	s := NewMemStore()
	creator := "refundcreatore"
	setupMarket(s, creator, 100, MaxCap)
	forceFrozen(s, creator)
	setStr(s, kState(creator), StateFrozen)
	setStr(s, kPaused(), "1")

	setMoney(s, kSupply(creator), big.NewInt(300))
	setMoney(s, kReserve(creator), big.NewInt(300))
	setMoney(s, kBal(creator, "bob"), big.NewInt(300))

	// EXITTAX-1/NOTICE-1 (2026-07-22): the permissionless push now refuses while
	// the holder's exit tax is still nonzero. bob is seeded via a raw setMoney
	// with no hold clock, so heldBlocksAt reads 0 (unset == maximally fresh,
	// holdclock.go) and a push of a FRESH bob is rejected — proving the gate
	// fires even while globally paused (it is an ErrState, not the pause).
	if _, err := RefundHolder(s, "anyone_at_all", creator, "bob", 50+GraceBlocks+1); errSymbol(err) != ErrState {
		t.Fatalf("fresh-holder push must be refused (EXITTAX-1), got err=%v", err)
	}

	// Age bob past the decay (clock at block 1, push a full ExitTaxDecayBlocks
	// later): a harmless 0-tax sweep — THAT is what this test proves still works
	// while FROZEN and globally paused (the outflow-never-pauses subject).
	setU64(s, kAcqBlock(creator, "bob"), 1)
	pushBlock := ExitTaxDecayBlocks + 2
	wantNet, _, _ := wdNet(s, creator, "bob", pushBlock, big.NewInt(300))
	payout, err := RefundHolder(s, "anyone_at_all", creator, "bob", pushBlock)
	if err != nil {
		t.Fatalf("RefundHolder must succeed while FROZEN and globally paused: %v", err)
	}
	// Fully-decayed holder → 0 tax, so net == gross == 300 (full pro-rata slice).
	if payout.Cmp(wantNet) != 0 || wantNet.Cmp(big.NewInt(300)) != 0 {
		t.Fatalf("payout = %s, want net %s (== 300: gross 300, 0 tax on a fully-decayed hold)", payout, wantNet)
	}
}

// ---------------------------------------------------------------------------
// Refund — guards, and proof that a rejected call leaves state untouched.
// ---------------------------------------------------------------------------

func TestRefund_Guards(t *testing.T) {
	s := NewMemStore()
	creator := "refundcreatorf"
	setMoney(s, kSupply(creator), big.NewInt(1000))
	setMoney(s, kReserve(creator), big.NewInt(1000))
	setMoney(s, kBal(creator, "alice"), big.NewInt(100))

	cases := []struct {
		name    string
		caller  string
		creator string
		credits *big.Int
		wantSym string
	}{
		{"empty caller", "", creator, big.NewInt(10), ErrAuth},
		{"invalid caller (key delimiter)", "ALI|CE", creator, big.NewInt(10), ErrAuth},
		{"invalid caller (empty)", "", creator, big.NewInt(10), ErrAuth},
		{"invalid creator (key delimiter)", "alice", "X|Y", big.NewInt(10), ErrInput},
		{"nil credits", "alice", creator, nil, ErrInput},
		{"zero credits", "alice", creator, big.NewInt(0), ErrInput},
		{"negative credits", "alice", creator, big.NewInt(-5), ErrInput},
		{"insufficient balance", "alice", creator, big.NewInt(101), ErrBalance},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// Wind-down block: the guards under test are the input/auth ones,
			// which all run BEFORE the phase gate, but using a phase-legal
			// block keeps every rejection attributable to its own guard.
			_, err := Refund(s, c.caller, c.creator, 50+GraceBlocks+1, c.credits)
			if err == nil {
				t.Fatalf("expected an error, got none")
			}
			if sym := errSymbol(err); sym != c.wantSym {
				t.Fatalf("want symbol %s, got %v", c.wantSym, err)
			}
		})
	}

	// Every rejected call above must have left state completely untouched.
	if got := getMoney(s, kBal(creator, "alice")); got.Cmp(big.NewInt(100)) != 0 {
		t.Fatalf("alice balance mutated by a rejected Refund: %s", got)
	}
	if got := getMoney(s, kSupply(creator)); got.Cmp(big.NewInt(1000)) != 0 {
		t.Fatalf("supply mutated by a rejected Refund: %s", got)
	}
	if got := getMoney(s, kReserve(creator)); got.Cmp(big.NewInt(1000)) != 0 {
		t.Fatalf("reserve mutated by a rejected Refund: %s", got)
	}
}

func TestRefund_CorruptStateSupplyZeroButBalancePositive(t *testing.T) {
	s := NewMemStore()
	creator := "refundcreatorg"
	// Deliberately I3-violating: a balance with no supply behind it at all.
	// Unreachable if the rest of the system maintains I3, but this file must
	// not panic (division by zero) if it somehow happens.
	setMoney(s, kBal(creator, "alice"), big.NewInt(50))
	setMoney(s, kReserve(creator), big.NewInt(50))
	// kSupply(creator) left completely unset => 0.
	forceFrozen(s, creator)

	_, err := Refund(s, "alice", creator, 50+GraceBlocks+1, big.NewInt(10))
	if err == nil {
		t.Fatal("expected an error rather than a division-by-zero panic")
	}
	if sym := errSymbol(err); sym != ErrState {
		t.Fatalf("want ErrState, got %v", err)
	}
}

func TestRefund_LargeAmountsBeyondInt64(t *testing.T) {
	s := NewMemStore()
	creator := "refundcreatorh"
	big1, _ := new(big.Int).SetString("123456789012345678901234567890", 10)
	big2, _ := new(big.Int).SetString("98765432109876543210", 10)

	setMoney(s, kSupply(creator), big1)
	setMoney(s, kReserve(creator), big1) // 1:1 fixture, arbitrary magnitude
	setMoney(s, kBal(creator, "alice"), big1)
	forceFrozen(s, creator)

	wantNet, gross, _ := wdNet(s, creator, "alice", 50+GraceBlocks+1, big2)
	payout, err := Refund(s, "alice", creator, 50+GraceBlocks+1, big2)
	if err != nil {
		t.Fatalf("Refund: %v", err)
	}
	// 1:1 fixture: gross == big2 exactly (no int64 truncation). RULING K2 then
	// carves the fresh holder's 20% tax, all in big.Int — the beyond-int64
	// point is that gross and net are BOTH exact multi-word values.
	if gross.Cmp(big2) != 0 {
		t.Fatalf("gross = %s, want exactly %s (1:1 fixture, no int64 truncation)", gross, big2)
	}
	if payout.Cmp(wantNet) != 0 {
		t.Fatalf("payout = %s, want net %s (gross − K2 tax, exact big.Int)", payout, wantNet)
	}
}

// ---------------------------------------------------------------------------
// RefundHolder — pays the holder, never the caller; zero-balance no-op.
// ---------------------------------------------------------------------------

func TestRefundHolder_PaysHolderNotCaller(t *testing.T) {
	s := NewMemStore()
	creator := "refundcreatori"
	setMoney(s, kSupply(creator), big.NewInt(700))
	setMoney(s, kReserve(creator), big.NewInt(700))
	setMoney(s, kBal(creator, "holderx"), big.NewInt(400))
	// The caller ALSO holds a balance in the same market, specifically to
	// prove no cross-contamination: pushing holderx's refund must not touch
	// callerz's own credits, even though both keys share the same "bal|
	// creator|" prefix.
	setMoney(s, kBal(creator, "callerz"), big.NewInt(300))

	// H3 defect fix (2026-07-21): RefundHolder requires Phase==FROZEN/
	// CLOSED. This creator was never Registered, so kPaidUntil defaults to
	// 0 and Phase(block) is FROZEN for any block >= GraceBlocks.
	//
	// EXITTAX-1/NOTICE-1 (2026-07-22): the push refuses a still-taxed holder, so
	// age holderx (clock at block 1) and push a full decay window later — a
	// harmless 0-tax sweep. The subject here (pays holderx, never callerz) is
	// orthogonal to the tax; the fresh-holder-rejected case is covered in
	// TestRefundHolder_EXITTAX1_FreshPushRefused.
	setU64(s, kAcqBlock(creator, "holderx"), 1)
	pushBlock := ExitTaxDecayBlocks + GraceBlocks
	wantNet, _, _ := wdNet(s, creator, "holderx", pushBlock, big.NewInt(400))
	payout, err := RefundHolder(s, "callerz", creator, "holderx", pushBlock)
	if err != nil {
		t.Fatalf("RefundHolder: %v", err)
	}
	// Fully-decayed holder → 0 tax; gross = holderx's full pro-rata 400 → net 400.
	if payout.Cmp(wantNet) != 0 || wantNet.Cmp(big.NewInt(400)) != 0 {
		t.Fatalf("payout = %s, want net %s (== 400: gross 400, 0 tax on a fully-decayed hold)", payout, wantNet)
	}
	if got := getMoney(s, kBal(creator, "holderx")); !mIsZero(got) {
		t.Fatalf("holderx balance = %s, want 0 (fully drained)", got)
	}
	if got := getMoney(s, kBal(creator, "callerz")); got.Cmp(big.NewInt(300)) != 0 {
		t.Fatalf("callerz balance = %s, want untouched 300 (caller must never be paid)", got)
	}
	if got := getMoney(s, kSupply(creator)); got.Cmp(big.NewInt(300)) != 0 {
		t.Fatalf("supply = %s, want 300 (only holderx's 400 burned)", got)
	}
	if got := getMoney(s, kReserve(creator)); got.Cmp(big.NewInt(300)) != 0 {
		t.Fatalf("reserve = %s, want 300", got)
	}
}

func TestRefundHolder_ZeroBalanceNoop(t *testing.T) {
	s := NewMemStore()
	creator := "refundcreatorj"
	setMoney(s, kSupply(creator), big.NewInt(1000))
	setMoney(s, kReserve(creator), big.NewInt(1000))
	setMoney(s, kBal(creator, "someoneelse"), big.NewInt(1000))
	// "unheldholder" (12 chars, valid) has no balance key set at all.

	// H3 defect fix: RefundHolder now gates on Phase==FROZEN/CLOSED even for
	// the zero-balance no-op path (the phase check runs before the balance
	// read) — see GraceBlocks note in TestRefundHolder_PaysHolderNotCaller.
	payout, err := RefundHolder(s, "pusher1", creator, "unheldholder", GraceBlocks)
	if err != nil {
		t.Fatalf("RefundHolder on a zero balance should not error: %v", err)
	}
	if !mIsZero(payout) {
		t.Fatalf("payout = %s, want 0", payout)
	}
	if got := getMoney(s, kSupply(creator)); got.Cmp(big.NewInt(1000)) != 0 {
		t.Fatalf("supply mutated by a zero-balance push: %s", got)
	}
	if got := getMoney(s, kReserve(creator)); got.Cmp(big.NewInt(1000)) != 0 {
		t.Fatalf("reserve mutated by a zero-balance push: %s", got)
	}
}

func TestRefundHolder_Guards(t *testing.T) {
	s := NewMemStore()
	creator := "refundcreatork"
	setMoney(s, kBal(creator, "holdery"), big.NewInt(100))
	setMoney(s, kSupply(creator), big.NewInt(100))
	setMoney(s, kReserve(creator), big.NewInt(100))

	cases := []struct {
		name    string
		caller  string
		creator string
		holder  string
		wantSym string
	}{
		{"empty caller", "", creator, "holdery", ErrAuth},
		{"invalid creator (key delimiter)", "pusher", "X|Y", "holdery", ErrInput},
		{"invalid holder charset", "pusher", creator, "holder|y", ErrInput},
		{"invalid holder (empty)", "pusher", creator, "", ErrInput},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := RefundHolder(s, c.caller, c.creator, c.holder, 1)
			if err == nil {
				t.Fatalf("expected an error, got none")
			}
			if sym := errSymbol(err); sym != c.wantSym {
				t.Fatalf("want symbol %s, got %v", c.wantSym, err)
			}
		})
	}
	if got := getMoney(s, kBal(creator, "holdery")); got.Cmp(big.NewInt(100)) != 0 {
		t.Fatalf("holdery balance mutated by a rejected RefundHolder: %s", got)
	}
}

// ---------------------------------------------------------------------------
// CloseIfDrained — depends on Phase() (market.go, [AGENT 1], not yet in this
// tree at the time this file was written). Written to the documented
// contract; see the report for the current compile status.
// ---------------------------------------------------------------------------

func TestCloseIfDrained_ClosesWhenFrozenAndSupplyZero(t *testing.T) {
	s := NewMemStore()
	creator := "closecreatora"
	setupMarket(s, creator, 100, MaxCap)
	forceFrozen(s, creator)

	block := uint64(50 + GraceBlocks + 1)
	if !CloseIfDrained(s, creator, block) {
		t.Fatal("expected CloseIfDrained to close a FROZEN, zero-supply market")
	}
	if got := getStr(s, kState(creator)); got != StateClosed {
		t.Fatalf("kState = %q, want %q", got, StateClosed)
	}
}

func TestCloseIfDrained_NotFrozenIsNoop(t *testing.T) {
	s := NewMemStore()
	creator := "closecreatorb"
	setupMarket(s, creator, 100, MaxCap) // comfortably ACTIVE, supply 0

	if CloseIfDrained(s, creator, 100) {
		t.Fatal("expected no-op: market is ACTIVE, not FROZEN")
	}
	if got := getStr(s, kState(creator)); got == StateClosed {
		t.Fatal("kState was set to CLOSED on an ACTIVE market")
	}
}

func TestCloseIfDrained_FrozenButSupplyNonzeroIsNoop(t *testing.T) {
	s := NewMemStore()
	creator := "closecreatorc"
	setupMarket(s, creator, 100, MaxCap)
	forceFrozen(s, creator)
	setMoney(s, kSupply(creator), big.NewInt(1)) // still owes somebody

	block := uint64(50 + GraceBlocks + 1)
	if CloseIfDrained(s, creator, block) {
		t.Fatal("expected no-op: supply is not zero, wind-down is not complete")
	}
	if got := getStr(s, kState(creator)); got == StateClosed {
		t.Fatal("kState was set to CLOSED while supply was still outstanding")
	}
}

func TestCloseIfDrained_Idempotent(t *testing.T) {
	s := NewMemStore()
	creator := "closecreatord"
	setupMarket(s, creator, 100, MaxCap)
	forceFrozen(s, creator)
	block := uint64(50 + GraceBlocks + 1)

	if !CloseIfDrained(s, creator, block) {
		t.Fatal("first call should close the market")
	}
	if !CloseIfDrained(s, creator, block+1) {
		t.Fatal("second call should report CLOSED (idempotent), not false")
	}
}

// TestCloseIfDrained_ExactFrozenBoundary pins the precise boundary Phase()
// documents (market.go): FROZEN begins AT block == paidUntil+GraceBlocks, not
// strictly after it. One block earlier must still be OVERDUE (no-op); the
// boundary block itself must already be FROZEN (closes).
func TestCloseIfDrained_ExactFrozenBoundary(t *testing.T) {
	s := NewMemStore()
	creator := "closecreatore"
	setupMarket(s, creator, 100, MaxCap)
	forceFrozen(s, creator) // kPaidUntil = 50

	boundary := uint64(50 + GraceBlocks)
	if CloseIfDrained(s, creator, boundary-1) {
		t.Fatal("one block before the boundary must still be OVERDUE, not FROZEN")
	}
	if !CloseIfDrained(s, creator, boundary) {
		t.Fatal("exactly at paidUntil+GraceBlocks must already be FROZEN")
	}
}

func TestCloseIfDrained_NeverRegisteredIsNoop(t *testing.T) {
	s := NewMemStore()
	// No setupMarket call at all — this creator string never registered.
	if CloseIfDrained(s, "nosuchcreatorxx", 100_000_000) {
		t.Fatal("expected no-op for a creator that never registered a market")
	}
}

// ---------------------------------------------------------------------------
// I1 solvency — the property test. Random balances, random refund order,
// random partial/full amounts, mixing Refund (pull) and RefundHolder (push).
// Asserts after EVERY single step that:
//
//	Σ paid <= initial reserve
//	reserve == initial reserve - Σ paid
//
// and at the end, once supply is fully drained, that reserve == 0 exactly
// whenever the run started at reserve <= supply — which is every run here,
// deliberately: reserve <= supply is not an arbitrary test choice, it is the
// invariant every OTHER module in this package actually maintains under a
// PAR-shaped fixture (Ask/Answer/Reclaim never touch kReserve at all — see
// the solvency comment in refund.go). NOTE the fixture is deliberately
// SYNTHETIC: the real system's reserve is area(supply), far above supply,
// and refundPayout's proof is scale-free — it is proven for any
// (reserve, supply) pair, which is exactly why these trials sweep the
// bound rather than the shipped ratio. Some trials start at reserve ==
// supply; others
// start strictly below it (the general bound the formula is proven to hold
// under, in case a future change ever legitimately draws the reserve down
// without a matching supply decrease).
// ---------------------------------------------------------------------------

func TestSolvency_FullUnwind(t *testing.T) {
	const trials = 40
	rng := rand.New(rand.NewSource(7))

	for trial := 0; trial < trials; trial++ {
		s := NewMemStore()
		creator := fmt.Sprintf("solvcreator%d", trial%10)

		numHolders := 2 + rng.Intn(12) // 2..13
		holders := make([]string, numHolders)
		balances := make([]*big.Int, numHolders)
		totalSupply := big.NewInt(0)
		for i := range holders {
			holders[i] = fmt.Sprintf("holder%02d", i)
			bal := big.NewInt(int64(1 + rng.Intn(100000)))
			balances[i] = new(big.Int).Set(bal)
			setMoney(s, kBal(creator, holders[i]), bal)
			// EXITTAX-1/NOTICE-1 (2026-07-22): the permissionless push refuses a
			// still-taxed holder, so clock every holder at block 1 and run the
			// whole unwind a full ExitTaxDecayBlocks later (windDownBlock below) —
			// every holder is then fully decayed (τ = 0) and every push is a
			// harmless 0-tax sweep. The solvency bookkeeping under test is on the
			// GROSS reserve delta (which is tax-independent — the reserve is always
			// debited the full pro-rata slice), so 0 tax does not weaken it.
			setU64(s, kAcqBlock(creator, holders[i]), 1)
			totalSupply.Add(totalSupply, bal)
		}
		setMoney(s, kSupply(creator), totalSupply)

		// initialReserve in [0, totalSupply]: covers both the exact peg
		// (today's real system) and the strictly-below case (the general
		// bound) across trials.
		deficit := int64(0)
		if totalSupply.IsInt64() && totalSupply.Int64() > 0 {
			deficit = rng.Int63n(totalSupply.Int64() + 1)
		}
		initialReserve := new(big.Int).Sub(totalSupply, big.NewInt(deficit))
		setMoney(s, kReserve(creator), initialReserve)

		// The whole unwind runs at this single block: creator never Registered
		// (kPaidUntil == 0) so it is FROZEN for any block >= GraceBlocks, and it
		// is a full ExitTaxDecayBlocks past each holder's clock (block 1) so every
		// permissionless push is a fully-decayed 0-tax sweep (EXITTAX-1 gate).
		windDownBlock := ExitTaxDecayBlocks + GraceBlocks

		totalPaid := big.NewInt(0)

		remaining := func() []int {
			var idx []int
			for i, b := range balances {
				if b.Sign() > 0 {
					idx = append(idx, i)
				}
			}
			return idx
		}

		steps := 0
		for {
			live := remaining()
			if len(live) == 0 {
				break
			}
			steps++
			if steps > 10000 {
				t.Fatalf("trial %d: unwind did not terminate", trial)
			}
			i := live[rng.Intn(len(live))]
			bal := balances[i]

			var amt *big.Int
			usePush := rng.Intn(2) == 0
			if usePush {
				amt = new(big.Int).Set(bal) // RefundHolder always drains the full balance
			} else if bal.Int64() == 1 || !bal.IsInt64() {
				amt = new(big.Int).Set(bal) // avoid Int63n(0)/overflow edge cases; full refund is still a valid random choice
			} else {
				amt = big.NewInt(1 + rng.Int63n(bal.Int64()))
			}

			reserveBefore := getMoney(s, kReserve(creator))

			var payout *big.Int
			var err error
			if usePush {
				// H3 defect fix (2026-07-21): RefundHolder requires
				// Phase==FROZEN/CLOSED — FROZEN here (see windDownBlock). The
				// EXITTAX-1 decay gate is satisfied because every holder is
				// clocked at block 1 and windDownBlock is a full
				// ExitTaxDecayBlocks later, so every push is a 0-tax sweep.
				pusher := holders[rng.Intn(numHolders)]
				payout, err = RefundHolder(s, pusher, creator, holders[i], windDownBlock)
			} else {
				// Same wind-down block as the push leg above: Refund is
				// phase-routed to FROZEN/CLOSED too (refund.go), and this
				// loop IS a wind-down sweep.
				payout, err = Refund(s, holders[i], creator, windDownBlock, amt)
			}
			if err != nil {
				t.Fatalf("trial %d step %d: unexpected error: %v", trial, steps, err)
			}

			balances[i] = new(big.Int).Sub(bal, amt)
			// RULING K2: the RESERVE is debited the GROSS pro-rata slice; the
			// holder RECEIVES the net (gross − tax), the tax goes to treasury.
			// So the solvency bookkeeping (reserve trajectory, no-overdraw,
			// full-drain) is on the GROSS, which is the reserve delta this step.
			gotReserve := getMoney(s, kReserve(creator))
			gross := new(big.Int).Sub(reserveBefore, gotReserve)
			if payout.Cmp(gross) > 0 {
				t.Fatalf("trial %d step %d: net payout %s > gross reserve debit %s (tax cannot be negative)", trial, steps, payout, gross)
			}
			totalPaid.Add(totalPaid, gross) // totalPaid now tracks GROSS drained from the reserve

			// Invariant 1: never overdraw the reserve.
			if totalPaid.Cmp(initialReserve) > 0 {
				t.Fatalf("trial %d step %d: OVERDRAWN: total gross %s > initial reserve %s",
					trial, steps, totalPaid, initialReserve)
			}
			// Invariant 2: reserve bookkeeping is exact at every step.
			wantReserve := new(big.Int).Sub(initialReserve, totalPaid)
			if gotReserve.Cmp(wantReserve) != 0 {
				t.Fatalf("trial %d step %d: reserve = %s, want %s (initial %s - gross %s)",
					trial, steps, gotReserve, wantReserve, initialReserve, totalPaid)
			}
		}

		// Full drain: supply must be exactly 0 (all balances refunded)...
		finalSupply := getMoney(s, kSupply(creator))
		if !mIsZero(finalSupply) {
			t.Fatalf("trial %d: supply not fully drained: %s", trial, finalSupply)
		}
		// ...and per the solvency proof (refund.go), starting from
		// reserve <= supply, the reserve is left at EXACTLY zero — no dust.
		finalReserve := getMoney(s, kReserve(creator))
		if !mIsZero(finalReserve) {
			t.Fatalf("trial %d: dust left after full unwind: reserve = %s (initial reserve %s, initial supply %s) — expected exactly 0",
				trial, finalReserve, initialReserve, totalSupply)
		}
		if totalPaid.Cmp(initialReserve) != 0 {
			t.Fatalf("trial %d: total gross drained %s != initial reserve %s at full drain (C-24 terminal exactness)", trial, totalPaid, initialReserve)
		}
	}
}

// THE PAR CAP IS DELETED, and this test is its INVERSION — kept rather than
// removed so the reversal stays on the record with its reasoning. It used
// to prove that the cap stranded (reserve − supply·PAR) in kReserve forever
// on an over-collateralized market. That "abnormal" 3.5x ratio is the
// NORMAL curve state (area(S)/S is always far above 1), so under the curve
// the cap would have confiscated essentially the entire backing of every
// position, every time. Now a full unwind pays the WHOLE reserve — C-24
// terminal exactness — and strands exactly zero.
func TestSolvency_NoParCap_FullUnwindDrainsTheWholeReserve(t *testing.T) {
	s := NewMemStore()
	creator := "strandedcreator"
	holder := "onlyholder01"
	forceFrozen(s, creator) // the wind-down rail (refund.go's phase routing)

	supply := big.NewInt(10)
	reserve := big.NewInt(35)
	setMoney(s, kBal(creator, holder), supply)
	setMoney(s, kSupply(creator), supply)
	setMoney(s, kReserve(creator), reserve)

	treaBefore := getMoney(s, kTreasury())
	wantNet, gross, tax := wdNet(s, creator, holder, 50+GraceBlocks+1, supply)
	payout, err := Refund(s, holder, creator, 50+GraceBlocks+1, supply) // full unwind in one call
	if err != nil {
		t.Fatalf("Refund: %v", err)
	}
	// The UNCAPPED gross floor(35·10/10) == 35 — the whole reserve, the point of
	// this test (the deleted PAR cap would have paid 10 and stranded 25). RULING
	// K2 then carves the fresh holder's tax (ceil(35·0.2)=7) to treasury, so the
	// holder receives net 28 — but the RESERVE still drains to exactly 0.
	if gross.Cmp(big.NewInt(35)) != 0 || tax.Cmp(big.NewInt(7)) != 0 || wantNet.Cmp(big.NewInt(28)) != 0 {
		t.Fatalf("K2 split = gross %s tax %s net %s, want 35/7/28", gross, tax, wantNet)
	}
	if payout.Cmp(wantNet) != 0 {
		t.Fatalf("payout = %s, want net %s (gross 35 − K2 tax 7)", payout, wantNet)
	}
	if got := getMoney(s, kSupply(creator)); !mIsZero(got) {
		t.Fatalf("supply = %s, want 0 (fully drained)", got)
	}
	if got := getMoney(s, kReserve(creator)); !mIsZero(got) {
		t.Fatalf("stranded residual = %s, want exactly 0 (C-24: a complete wind-down drains the reserve)", got)
	}
	if got := new(big.Int).Sub(getMoney(s, kTreasury()), treaBefore); got.Cmp(tax) != 0 {
		t.Fatalf("treasury delta = %s, want the K2 tax %s", got, tax)
	}

	// Still inert afterwards: supply is 0, no balance remains to present,
	// and this package defines no admin/withdraw path to kReserve at all (I4).
	if _, err := Refund(s, holder, creator, 50+GraceBlocks+1, big.NewInt(1)); err == nil {
		t.Fatal("expected insufficient-balance: the holder's balance is fully drained")
	} else if sym := errSymbol(err); sym != ErrBalance {
		t.Fatalf("want ErrBalance, got %v", err)
	}
}
