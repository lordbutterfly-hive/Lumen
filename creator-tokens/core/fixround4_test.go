package core

import (
	"math/big"
	"testing"
)

// fixround4_test.go — OUTFLOW-CLIFF-1 (adversarial FIX ROUND 4, 2026-07-22).
//
// THE FINDING (reproduced against the real compiled core, /tmp scratchpad
// verify2): the exit-tax RATE is derived from the live per-holder hold clock
// (holdclock.go) and read at execution time on the two least-gated OUTFLOWS
// (Sell, Refund). TransferCredits is permissionless property (transfer.go) that
// correctly re-ages the RECIPIENT toward FRESH (the anti-OTC-laundering rule,
// C-13) — so a third party can force a 1-base-unit inflow onto a victim in the
// SAME block, AFTER the victim signed their quote, nudging the victim's averaged
// clock forward. A holder who patiently held to the six-week 0%-tax mark is
// thereby knocked to the ceil-MINIMUM 1 bps (exittax.go's ExitTaxBpsAt ceil
// floors the rate at 1; creditInflowAt's ceil floors the clock shift at 1
// block) on their ENTIRE proceeds, booked to the treasury. It is the
// producer-ordered front-run ask.go's maxCredits already defends the INFLOW
// credit leg against; Sell/Refund lacked the analogous quote-to-execution
// binding.
//
// SEVERITY, stated honestly (NOT the finding's "CRITICAL / billion-x"): this is
// NOT a solvency defect — R === area(S) is untouched (the rate only moves the
// seller/treasury split; the reserve pays the full slice either way), asserted
// below. The RELATIVE loss is bounded at the ceil-minimum 1 bps (0.01%); the
// "leverage" grows only because the fixed 1-unit attacker cost is divided into
// an arbitrarily large victim position. It is a real, front-runnable griefing /
// value-transfer defect on a value-out door, worth closing at the Magi
// hardening bar (fault + damage, regardless of trigger).
//
// THE FIX (checkMinNet, sell.go): an OPTIONAL caller-signed floor `minNet` on
// the net proceeds, enforced BEFORE any write. A same-block adverse clock move
// makes the exit REVERT CLEANLY (RULING G: nothing mutates) instead of silently
// overcharging; nil/absent opts out so the outflow is NEVER trapped
// (OUTFLOWS-NEVER-PAUSE). These tests (1) reproduce the defect on the real code,
// (2) prove the guard stops the value extraction with nothing mutated, (3) prove
// the holder is never trapped (opt-out still exits), (4) prove an honest exit is
// never blocked, and (5) prove R === area(S) survives every path.

func fr4Setup(t *testing.T, cap int64) *MemStore {
	t.Helper()
	s := NewMemStore()
	if err := Register(s, "alice", "alice", 1000, 1000, cap); err != nil {
		t.Fatalf("Register: %v", err)
	}
	// Keep the market ACTIVE well past ExitTaxDecayBlocks so the curve rail is
	// open at t1 for the Sell subcases (mirrors verify2's extendSub).
	if err := Renew(s, "alice", "alice", 1000, 4, big.NewInt(4*SubscriptionFee)); err != nil {
		t.Fatalf("Renew: %v", err)
	}
	return s
}

// fr4RArea asserts THE invariant: reserve − area(supply) == 0 exactly.
func fr4RArea(t *testing.T, s Store, c string) {
	t.Helper()
	e := new(big.Int).Sub(getMoney(s, kReserve(c)), Area(getMoney(s, kSupply(c))))
	if e.Sign() != 0 {
		t.Fatalf("R === area(S) BROKEN: E = reserve − area = %s (must be exactly 0)", e)
	}
}

// TestOUTFLOWCLIFF1_SellClockFrontRun_GuardStops is the core regression: a
// dust TransferCredits front-run flips a fully-decayed seller's rate 0 -> 1 bps,
// and the signed minNet floor turns that silent overcharge into a clean revert.
func TestOUTFLOWCLIFF1_SellClockFrontRun_GuardStops(t *testing.T) {
	const B int64 = 50_000
	t0 := uint64(2_000_000)
	t1 := t0 + ExitTaxDecayBlocks // bob EXACTLY fully decayed => 0% tax

	s := fr4Setup(t, MaxCap)
	// mallory's poison stash: 1 token bought cheap at genesis. A one-time SUNK
	// cost; its own age is irrelevant — the transfer re-ages the RECEIVED slice
	// to `block` regardless of how long mallory held it.
	if _, err := Buy(s, "mallory", "alice", 1000, big.NewInt(1)); err != nil {
		t.Fatalf("mallory Buy: %v", err)
	}
	if _, err := Buy(s, "bob", "alice", t0, big.NewInt(B)); err != nil {
		t.Fatalf("bob Buy: %v", err)
	}
	fr4RArea(t, s, "alice")

	// ---- baseline quote, BEFORE the poison: bob is exactly at 0% ----
	qBase, err := QuoteSell(s, "bob", "alice", t1, big.NewInt(B))
	if err != nil {
		t.Fatalf("baseline QuoteSell: %v", err)
	}
	if qBase.TaxBps != 0 {
		t.Fatalf("baseline taxBps = %d, want 0 (bob held exactly ExitTaxDecayBlocks)", qBase.TaxBps)
	}

	// ---- the front-run: mallory forces 1 unit onto bob in the SAME block as
	// bob's pre-quoted sell, re-aging bob's clock forward. ----
	if err := TransferCredits(s, "alice", "mallory", "bob", t1, big.NewInt(1)); err != nil {
		t.Fatalf("poison TransferCredits: %v", err)
	}
	qAtk, err := QuoteSell(s, "bob", "alice", t1, big.NewInt(B))
	if err != nil {
		t.Fatalf("post-poison QuoteSell: %v", err)
	}
	// The defect, reproduced: a 1-unit gift flipped the rate off 0.
	if qAtk.TaxBps != 1 {
		t.Fatalf("post-poison taxBps = %d, want the ceil-minimum 1 (the 0->1 cliff)", qAtk.TaxBps)
	}
	// Supply is identical pre/post (a transfer moves no supply), so Gross and Fee
	// are identical and the ONLY delta is the tax — this isolates the clock
	// effect with no supply confound.
	if qAtk.Gross.Cmp(qBase.Gross) != 0 {
		t.Fatalf("gross changed across the transfer (%s -> %s): the confound must be zero", qBase.Gross, qAtk.Gross)
	}
	drop := new(big.Int).Sub(qBase.Net, qAtk.Net)
	if drop.Sign() <= 0 {
		t.Fatalf("post-poison net not reduced (drop=%s): the front-run must lower net", drop)
	}
	// Bound it honestly: the extracted tax is exactly ceil(gross * 1bps) — 0.01%,
	// NOT the invariant-breaking class.
	wantTax := ExitTaxOn(qAtk.Gross, 1)
	if qAtk.Tax.Cmp(wantTax) != 0 {
		t.Fatalf("attack tax = %s, want ceil(gross*1/1e4) = %s", qAtk.Tax, wantTax)
	}

	// ---- THE FIX: bob's signed sell carries minNet = his honest quoted net.
	// The front-run makes execution net fall below it, so the call REVERTS
	// CLEANLY — nothing mutates (RULING G), R === area(S) untouched. ----
	before := hzSnapshotAll(s)
	if _, err := Sell(s, "bob", "alice", t1, big.NewInt(B), qBase.Net); errSymbol(err) != ErrInput {
		t.Fatalf("guarded Sell: err = %v, want ErrInput (minNet floor must trip on the front-run)", err)
	}
	if changed := hzChangedKeys(before, hzSnapshotAll(s)); len(changed) != 0 {
		t.Fatalf("a REFUSED guarded Sell mutated state: %v (RULING G: nothing mutates on a rejected call)", changed)
	}
	if got := BalanceOf(s, "alice", "bob"); got.Cmp(big.NewInt(B+1)) != 0 {
		t.Fatalf("bob balance after refused Sell = %s, want %d (B + the gift, untouched)", got, B+1)
	}
	fr4RArea(t, s, "alice")

	// ---- NEVER TRAPPED: bob can still exit by opting out (nil floor). The
	// outflow is always available; the guard only converts a silent loss into a
	// caller-visible re-quote. ----
	rOut, err := Sell(s, "bob", "alice", t1, big.NewInt(B), nil)
	if err != nil {
		t.Fatalf("opt-out Sell (nil floor) must always succeed: %v", err)
	}
	if rOut.TaxBps != 1 {
		t.Fatalf("opt-out Sell taxBps = %d, want 1 (bob's informed choice to eat the 1 bps)", rOut.TaxBps)
	}
	fr4RArea(t, s, "alice")
}

// TestOUTFLOWCLIFF1_RefundClockFrontRun_GuardStops is the wind-down twin: the
// same dust front-run against the K2-taxed pro-rata Refund, and the same signed
// floor closes it.
func TestOUTFLOWCLIFF1_RefundClockFrontRun_GuardStops(t *testing.T) {
	const B int64 = 50_000
	t0 := uint64(2_000_000)
	t1 := t0 + ExitTaxDecayBlocks

	s := fr4Setup(t, MaxCap)
	if _, err := Buy(s, "mallory", "alice", 1000, big.NewInt(1)); err != nil {
		t.Fatalf("mallory Buy: %v", err)
	}
	if _, err := Buy(s, "bob", "alice", t0, big.NewInt(B)); err != nil {
		t.Fatalf("bob Buy: %v", err)
	}
	// Retire so the wind-down (flat pro-rata Refund) rail is open at t1.
	if err := Retire(s, "alice", "alice", t0); err != nil {
		t.Fatalf("Retire: %v", err)
	}
	fr4RArea(t, s, "alice")

	// Baseline net for a fully-decayed refund of B == the gross pro-rata slice
	// (tax 0). refundPayout is exactly what Refund uses internally.
	reserve := getMoney(s, kReserve("alice"))
	supply := getMoney(s, kSupply("alice"))
	if bps := ExitTaxBpsAt(heldBlocksAt(s, "alice", "bob", t1)); bps != 0 {
		t.Fatalf("baseline refund taxBps = %d, want 0", bps)
	}
	grossBase := refundPayout(reserve, big.NewInt(B), supply) // == baseline net (tax 0)

	// Front-run: mallory forces 1 unit onto bob (TransferCredits works in
	// wind-down — it is property, not gated by inWindDown).
	if err := TransferCredits(s, "alice", "mallory", "bob", t1, big.NewInt(1)); err != nil {
		t.Fatalf("poison TransferCredits: %v", err)
	}
	if bps := ExitTaxBpsAt(heldBlocksAt(s, "alice", "bob", t1)); bps != 1 {
		t.Fatalf("post-poison refund taxBps = %d, want the ceil-minimum 1", bps)
	}

	// THE FIX: guarded Refund with minNet = baseline net reverts cleanly.
	before := hzSnapshotAll(s)
	if _, err := Refund(s, "bob", "alice", t1, big.NewInt(B), grossBase); errSymbol(err) != ErrInput {
		t.Fatalf("guarded Refund: err = %v, want ErrInput (minNet floor must trip)", err)
	}
	if changed := hzChangedKeys(before, hzSnapshotAll(s)); len(changed) != 0 {
		t.Fatalf("a REFUSED guarded Refund mutated state: %v (RULING G)", changed)
	}
	fr4RArea(t, s, "alice")

	// Never trapped: opt-out Refund (nil floor) still exits.
	net, err := Refund(s, "bob", "alice", t1, big.NewInt(B), nil)
	if err != nil {
		t.Fatalf("opt-out Refund (nil floor) must always succeed: %v", err)
	}
	// Net is the gross for B less the 1 bps tax — strictly below the baseline.
	if net.Cmp(grossBase) >= 0 {
		t.Fatalf("opt-out Refund net = %s, want < baseline gross %s (the 1 bps was charged)", net, grossBase)
	}
	// NOTE: R === area(S) is the TRADING-phase equality; a flat pro-rata
	// wind-down refund deliberately leaves R > area(S) (floor dust accrues
	// forward, C-22 — the reserve-per-token weakly RISES). The fix touches no
	// wind-down money math, so the correct post-refund safety check is solvency:
	// the reserve still covers at least the curve area (excess non-negative, no
	// over-draw).
	if excess := new(big.Int).Sub(getMoney(s, kReserve("alice")), Area(getMoney(s, kSupply("alice")))); excess.Sign() < 0 {
		t.Fatalf("post-wind-down solvency BROKEN: reserve − area(supply) = %s (< 0, over-drawn)", excess)
	}
}

// TestOUTFLOWCLIFF1_HonestExitNeverBlocked proves the guard is a floor, not a
// ceiling: an honest exit whose net meets or exceeds minNet succeeds, so the
// fix imposes no cost on the common, un-front-run path.
func TestOUTFLOWCLIFF1_HonestExitNeverBlocked(t *testing.T) {
	const B int64 = 50_000
	t0 := uint64(2_000_000)
	t1 := t0 + ExitTaxDecayBlocks

	s := fr4Setup(t, MaxCap)
	if _, err := Buy(s, "bob", "alice", t0, big.NewInt(B)); err != nil {
		t.Fatalf("bob Buy: %v", err)
	}
	q, err := QuoteSell(s, "bob", "alice", t1, big.NewInt(B))
	if err != nil {
		t.Fatalf("QuoteSell: %v", err)
	}
	if q.TaxBps != 0 {
		t.Fatalf("taxBps = %d, want 0", q.TaxBps)
	}
	// minNet == the quoted net (boundary: net == floor is NOT below, so it must
	// pass) — no front-run, so execution matches the quote exactly.
	r, err := Sell(s, "bob", "alice", t1, big.NewInt(B), q.Net)
	if err != nil {
		t.Fatalf("honest guarded Sell (minNet == quoted net) must succeed: %v", err)
	}
	if r.Net.Cmp(q.Net) != 0 {
		t.Fatalf("executed net %s != quoted net %s (quote must bind execution when unmolested)", r.Net, q.Net)
	}
	fr4RArea(t, s, "alice")
}

// TestOUTFLOWCLIFF1_CheckMinNetEdges pins checkMinNet's contract directly.
func TestOUTFLOWCLIFF1_CheckMinNetEdges(t *testing.T) {
	net := big.NewInt(1000)

	// No guard: absent, or a single nil.
	if err := checkMinNet(net, nil); err != nil {
		t.Fatalf("absent floor must be no-guard, got %v", err)
	}
	if err := checkMinNet(net, []*big.Int{}); err != nil {
		t.Fatalf("empty floor must be no-guard, got %v", err)
	}
	if err := checkMinNet(net, []*big.Int{nil}); err != nil {
		t.Fatalf("nil floor must be no-guard (the opt-out escape hatch), got %v", err)
	}
	// Equal is allowed (floor, not ceiling); strictly below refuses.
	if err := checkMinNet(net, []*big.Int{big.NewInt(1000)}); err != nil {
		t.Fatalf("net == floor must pass, got %v", err)
	}
	if err := checkMinNet(net, []*big.Int{big.NewInt(999)}); err != nil {
		t.Fatalf("net > floor must pass, got %v", err)
	}
	if err := checkMinNet(net, []*big.Int{big.NewInt(1001)}); errSymbol(err) != ErrInput {
		t.Fatalf("net < floor must be ErrInput, got %v", err)
	}
	// More than one floor is a programming error, refused pre-write (not a panic).
	if err := checkMinNet(net, []*big.Int{big.NewInt(1), big.NewInt(2)}); errSymbol(err) != ErrInput {
		t.Fatalf("len(opt) > 1 must be ErrInput, got %v", err)
	}
}
