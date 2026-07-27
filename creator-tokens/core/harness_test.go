package core

import (
	"fmt"
	"math/big"
	"math/rand"
	"sort"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// harness_test.go — the end-to-end lifecycle harness. API.md and
// SPEC-CREATOR-KEYS.md §1 describe six files, written and unit-tested in
// isolation by five different agents. Nothing in the existing 111 tests
// drives them TOGETHER, in the order a real market actually experiences
// them: register -> renew -> prepay -> price discovery -> ask -> answer/
// reclaim -> transfer -> lapse -> freeze -> refund -> close. This file is
// that drive.
//
// Every helper declared here is prefixed hz — the package already has
// unprefixed helpers from five other authors (setupMarket, activateMarket,
// forceFrozen, errSymbol, sumBalances, mustBig, recordConst, ...) and a
// name collision breaks the build for everyone.
//
// This harness drives ONLY the public API (Register, Renew, Buy, Sell, Ask,
// Answer, Reclaim, Refund, RefundHolder, CloseIfDrained, RecordObs, AskRate,
// TransferCredits) — never another file's test-only shortcuts (setupMarket,
// activateMarket, forceFrozen) — because the point is to prove the REAL
// production call sequence composes correctly, including the two seams no
// single module's own test file can see: Ask's own internal SettlementRate
// derivation actually tracking what a standalone AskRate call against the
// same state would return (Ask no longer takes `rate` as a parameter — see
// ask.go's 2026-07-20 fix — so this file cross-checks the two independently
// wherever it matters), and Phase()'s lazy, unstored derivation actually
// gating the right calls at the right block heights over a real,
// multi-market timeline.
// ---------------------------------------------------------------------------

// ---- generic assertion helpers ---------------------------------------------

func hzErrSymbol(err error) string {
	if e, ok := err.(*Err); ok {
		return e.Symbol
	}
	return ""
}

func hzMustOK(t *testing.T, err error, label string) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s: expected success, got error: %v", label, err)
	}
}

func hzMustErr(t *testing.T, err error, wantSymbol, label string) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s: expected error %s, got success", label, wantSymbol)
	}
	if got := hzErrSymbol(err); got != wantSymbol {
		t.Fatalf("%s: expected error symbol %s, got %s (%v)", label, wantSymbol, got, err)
	}
}

// hzCloneStore deep-copies every key/value pair into a brand-new MemStore, so
// I1's shadow full-unwind can simulate draining a market without mutating
// the live harness state the rest of the test still depends on.
func hzCloneStore(s *MemStore) *MemStore {
	clone := NewMemStore()
	for _, k := range s.Keys() {
		v, _ := s.Get(k)
		clone.Set(k, v)
	}
	return clone
}

// hzSnapshotAll captures every key/value pair currently in the store, for a
// full before/after diff.
func hzSnapshotAll(s *MemStore) map[string]string {
	keys := s.Keys()
	m := make(map[string]string, len(keys))
	for _, k := range keys {
		v, _ := s.Get(k)
		m[k] = v
	}
	return m
}

// hzChangedKeys returns every key whose value differs between before and
// after (added, removed or modified), sorted for deterministic output.
func hzChangedKeys(before, after map[string]string) []string {
	seen := map[string]bool{}
	var out []string
	for k, av := range after {
		seen[k] = true
		if bv, ok := before[k]; !ok || bv != av {
			out = append(out, k)
		}
	}
	for k := range before {
		if !seen[k] {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

func hzAssertExactChangedKeys(t *testing.T, changed, want []string, label string) {
	t.Helper()
	wantSet := map[string]bool{}
	for _, k := range want {
		wantSet[k] = true
	}
	gotSet := map[string]bool{}
	for _, k := range changed {
		gotSet[k] = true
	}
	for k := range gotSet {
		if !wantSet[k] {
			t.Fatalf("%s: unexpected key changed: %q (full changed set: %v)", label, k, changed)
		}
	}
	for k := range wantSet {
		if !gotSet[k] {
			t.Fatalf("%s: expected key %q to change, it did not (full changed set: %v)", label, k, changed)
		}
	}
}

func hzAssertPhase(t *testing.T, s Store, creator string, block uint64, want, label string) {
	t.Helper()
	if got := Phase(s, creator, block); got != want {
		t.Fatalf("%s: Phase(%s, %d) = %s, want %s", label, creator, block, got, want)
	}
}

// ---- I3 (supply == balances + escrow) --------------------------------------

// hzHoldersOf scans every bal|<creator>|<holder> key and returns the
// distinct holder names, sorted for deterministic iteration.
func hzHoldersOf(s *MemStore, creator string) []string {
	prefix := "bal|" + creator + "|"
	seen := map[string]bool{}
	var out []string
	for _, k := range s.Keys() {
		if !strings.HasPrefix(k, prefix) {
			continue
		}
		h := k[len(prefix):]
		if !seen[h] {
			seen[h] = true
			out = append(out, h)
		}
	}
	sort.Strings(out)
	return out
}

// hzSumBalances totals every bal|<creator>|<holder> value.
func hzSumBalances(s *MemStore, creator string) *big.Int {
	prefix := "bal|" + creator + "|"
	total := big.NewInt(0)
	for _, k := range s.Keys() {
		if !strings.HasPrefix(k, prefix) {
			continue
		}
		v, _ := s.Get(k)
		n, ok := new(big.Int).SetString(v, 10)
		if ok {
			total.Add(total, n)
		}
	}
	return total
}

// hzSumEscrowedCredits totals the credits of every e|<creator>|<seq> record
// still in PENDING status — the "credits currently held in escrow" half of
// I3. Reads ask.go's own unpackEscrow/askPending so this file never guesses
// the packed record format.
func hzSumEscrowedCredits(s *MemStore, creator string) *big.Int {
	prefix := "e|" + creator + "|"
	total := big.NewInt(0)
	for _, k := range s.Keys() {
		if !strings.HasPrefix(k, prefix) {
			continue
		}
		v, _ := s.Get(k)
		rec, ok := unpackEscrow(v)
		if !ok {
			continue
		}
		if rec.status == askPending {
			total.Add(total, rec.credits)
		}
	}
	return total
}

// hzSumEscrowedCommission is hzSumEscrowedCredits's twin for the HBD
// commission leg (2026-07-20 defect fix): Ask now HOLDS the commission in
// the escrow record rather than booking it to the treasury immediately —
// Answer books it, Reclaim returns it (see ask.go's Ask/Answer/Reclaim
// doc). This is a THIRD resting state for HBD, alongside a market's reserve
// and the global treasury, that hzAssertConservation below must account for
// or an outstanding, unanswered ask looks like unaccounted-for HBD.
func hzSumEscrowedCommission(s *MemStore, creator string) *big.Int {
	prefix := "e|" + creator + "|"
	total := big.NewInt(0)
	for _, k := range s.Keys() {
		if !strings.HasPrefix(k, prefix) {
			continue
		}
		v, _ := s.Get(k)
		rec, ok := unpackEscrow(v)
		if !ok {
			continue
		}
		if rec.status == askPending {
			total.Add(total, rec.commissionHbd)
		}
	}
	return total
}

// hzAssertI3 — supply(c) == Σ bal(c, holder) + credits currently escrowed.
func hzAssertI3(t *testing.T, s *MemStore, creator, label string) {
	t.Helper()
	supply := Supply(s, creator)
	bal := hzSumBalances(s, creator)
	esc := hzSumEscrowedCredits(s, creator)
	total := new(big.Int).Add(bal, esc)
	if supply.Cmp(total) != 0 {
		t.Fatalf("%s: I3 VIOLATED for %s — supply=%s but Σbalances(%s)+escrowed(%s)=%s",
			label, creator, supply, bal, esc, total)
	}
}

// ---- I1 (solvency: a full unwind never pays more than the reserve) --------

// hzAssertI1Solvency proves reserve(c) >= what a full unwind would actually
// pay out, by running that unwind against a CLONE of the store (never the
// live one) and summing every RefundHolder payout. It additionally proves
// the stronger claim API.md states — "a full unwind pays exactly the
// reserve" — whenever that claim is actually testable: reserve exactly
// pegged to supply AND nothing currently sitting in escrow.
//
// The escrow qualifier matters and is not optional: an escrowed credit is
// counted in supply (I3) but is NOT reachable by Refund/RefundHolder — it
// only becomes a holder's spendable balance again via Answer (to the
// creator) or Reclaim (back to the asker). So immediately after an Ask,
// supply can equal reserve exactly while a RefundHolder-only sweep over
// every CURRENT balance still falls short by precisely the escrowed
// amount — that is correct behaviour, not a solvency violation, and the
// inequality check below (never more than the reserve) is what actually
// matters at that moment. The equality check only applies once escrow is
// empty, per refund.go's own solvency proof: the peg reproduces itself
// across every refund once established by Prepay's lockstep bookkeeping.
func hzAssertI1Solvency(t *testing.T, s *MemStore, creator string, block uint64, label string, wantEquality bool) {
	t.Helper()
	reserve := Reserve(s, creator)
	supply := Supply(s, creator)
	heldBalance := hzSumBalances(s, creator) // supply minus whatever is escrowed (I3)

	// Shadow full-unwind computed with refundPayout DIRECTLY, not by calling
	// Refund against a clone.
	//
	// WHY THE CHANGE (RULING A): this proof must hold at EVERY point in a
	// market's lifecycle, but under the curve BOTH wind-down rails are
	// phase-gated to FROZEN/CLOSED — Refund included (refund.go's rail
	// reconciliation: during ACTIVE/OVERDUE the holder's exit is Sell, at
	// strictly better pricing; an ungated pro-rata while buys are live is a
	// tax-and-fee bypass that also breaks the equality invariant). Calling
	// Refund here would therefore make a phase-INDEPENDENT solvency proof
	// depend on the phase. refundPayout is the single source of truth both
	// rails compute through (refund.go), so driving it directly gives
	// numerically identical results with no phase coupling and no clone.
	total := big.NewInt(0)
	rc, sc := new(big.Int).Set(reserve), new(big.Int).Set(supply)
	for _, h := range hzHoldersOf(s, creator) {
		bal := getMoney(s, kBal(creator, h))
		if bal.Sign() <= 0 || sc.Sign() <= 0 {
			continue
		}
		payout := refundPayout(rc, bal, sc)
		total.Add(total, payout)
		rc = new(big.Int).Sub(rc, payout)
		sc = new(big.Int).Sub(sc, bal)
	}
	if total.Cmp(reserve) > 0 {
		t.Fatalf("%s: I1 VIOLATED for %s — a full unwind would pay %s but reserve holds only %s",
			label, creator, total, reserve)
	}
	// THE equality invariant (RULING A, C-9): the reserve holds EXACTLY the
	// curve area — not more (an ownerless pot a fresh buyer could dilute
	// into at wind-down, the whole SA-1 drain class) and not less (holders
	// under-backed).
	//
	// SCOPE, corrected 2026-07-21: the EQUALITY is the TRADING-phase
	// invariant. A wind-down refund pays the flat pro-rata average
	// floor(R·c/S) while the burn un-backs the MARGINAL slice, and on a
	// rising curve the average is BELOW the marginal — so every partial
	// refund legitimately leaves R above area(S'), by design (C-22: the
	// surplus flows FORWARD to the remaining claimants and C-24 drains it to
	// exactly 0 on the last claim). That surplus is not a drainable pot:
	// buys are structurally dead in FROZEN/CLOSED, so nobody can dilute into
	// it. Callers therefore assert the equality via the wantEquality flag
	// while the market still trades, and the inequality (never UNDER the
	// curve) always.
	if area := Area(supply); reserve.Cmp(area) < 0 {
		t.Fatalf("%s: RESERVE UNDER THE CURVE for %s — reserve %s < area(supply=%s) = %s",
			label, creator, reserve, supply, area)
	}
	if wantEquality {
		if area := Area(supply); reserve.Cmp(area) != 0 {
			t.Fatalf("%s: EQUALITY INVARIANT VIOLATED for %s — reserve %s != area(supply=%s) = %s",
				label, creator, reserve, supply, area)
		}
	}
	// With nothing escrowed, a full unwind pays out the WHOLE reserve, to
	// the unit (refund.go C-24 terminal exactness — the PAR cap that used to
	// clamp this at 1 unit per token is deleted).
	if heldBalance.Cmp(supply) == 0 && supply.Sign() > 0 && total.Cmp(reserve) != 0 {
		t.Fatalf("%s: I1 — %s has nothing in escrow, so a full unwind must pay EXACTLY the reserve (%s); got %s",
			label, creator, reserve, total)
	}
}

// ---- I4 (reserve moves ONLY via Prepay/Refund/RefundHolder) ---------------

// hzReserves snapshots reserve(c) for every creator in creators.
func hzReserves(s Store, creators []string) map[string]*big.Int {
	m := make(map[string]*big.Int, len(creators))
	for _, c := range creators {
		m[c] = Reserve(s, c)
	}
	return m
}

// hzAssertReserveDeltas is I4: reserve(c) may move ONLY by deltas[c] (0 if
// absent) since `before` was captured. Called with a nil/empty deltas map
// after every non-Prepay, non-Refund/RefundHolder call — "snapshot it
// around every OTHER call and assert it is unchanged" — and with an
// explicit nonzero delta for the one creator a Prepay/Refund/RefundHolder
// call just legitimately moved, which simultaneously proves every OTHER
// market sharing the same store was completely undisturbed.
func hzAssertReserveDeltas(t *testing.T, s Store, creators []string, before map[string]*big.Int, deltas map[string]*big.Int, label string) {
	t.Helper()
	for _, c := range creators {
		want := deltas[c]
		if want == nil {
			want = mZero()
		}
		got := new(big.Int).Sub(Reserve(s, c), before[c])
		if got.Cmp(want) != 0 {
			t.Fatalf("%s: I4 VIOLATED — reserve(%s) moved by %s, want %s", label, c, got, want)
		}
	}
}

// ---- I5 (no commission on a reclaim) ---------------------------------------

// hzReclaimNoCommission wraps Reclaim with the I5 proof: treasury (the ONLY
// place a commission could land, per ask.go) must not move by a single unit
// across a Reclaim call. Also returns the commission Reclaim handed back
// (2026-07-20 defect fix) so callers that track a real HBD-out ledger
// (TestHarness_FullLifecycle_EndToEnd's hzAssertConservation) can record it
// as the genuine outflow it is — see contract/main.go's `reclaim`
// entrypoint, which sdk.HiveTransfers this exact amount back to the asker.
func hzReclaimNoCommission(t *testing.T, s Store, caller, creator string, block, seq uint64, label string) (credits, commission *big.Int) {
	t.Helper()
	treasuryBefore := getMoney(s, kTreasury())
	res, err := Reclaim(s, caller, creator, block, seq)
	hzMustOK(t, err, label+" (Reclaim)")
	treasuryAfter := getMoney(s, kTreasury())
	if treasuryAfter.Cmp(treasuryBefore) != 0 {
		t.Fatalf("%s: I5 VIOLATED — treasury moved %s -> %s on a Reclaim (commission charged on non-delivery)",
			label, treasuryBefore, treasuryAfter)
	}
	return res.CreditsReturned, res.CommissionHbd
}

// ---- money-conservation identity -------------------------------------------

// hzAssertConservation: Σ HBD in (registration + subscription + prepay +
// commission) == Σ HBD out (refunds) + Σ reserve(c) across every market in
// creators + the single global treasury + Σ commission currently HELD in
// escrow (2026-07-20 defect fix: Ask no longer books the commission to the
// treasury immediately — see hzSumEscrowedCommission's doc, and ask.go's
// Ask/Answer/Reclaim). Without that fourth term, any market with an
// outstanding, unanswered ask would look like it had lost HBD that is
// actually just held, not gone. hbdIn/hbdOut are accumulated by the caller
// from the actual amounts passed into/returned by each real call, so this
// checks live state against an independently-tracked ledger — it is not a
// tautology.
// The identity gained ONE resting bucket when the money core was rewritten
// and it is load-bearing: the pull-claimable trade-fee pot per creator
// (kFeeBal — the 5% creator half of every trade fee, earned but unclaimed,
// neither reserve nor treasury). Without it, a market that has traded at
// all looks like it lost the fee.
//
// RULING J (2026-07-21) REMOVED the second bucket this comment used to
// name: the per-creator exit-tax pot (kTaxPot) is DELETED with the holder
// distribution — the exit tax now goes straight to kTreasury() at the
// instant it is paid, which the `treasury` term below already counts. So
// global solvency simplifies to:
//
//	ledger HBD >= Σ reserves + treasury + Σ unclaimed trade fees
//
// asserted here as an EQUALITY against an independently-tracked in/out
// ledger.
func hzAssertConservation(t *testing.T, s Store, creators []string, hbdIn, hbdOut *big.Int, label string) {
	t.Helper()
	ms, ok := s.(*MemStore)
	if !ok {
		t.Fatalf("%s: hzAssertConservation requires a *MemStore (to scan escrow records), got %T", label, s)
	}
	reserves := big.NewInt(0)
	heldCommission := big.NewInt(0)
	feePots := big.NewInt(0)
	for _, c := range creators {
		reserves.Add(reserves, Reserve(s, c))
		heldCommission.Add(heldCommission, hzSumEscrowedCommission(ms, c))
		feePots.Add(feePots, getMoney(s, kFeeBal(c)))
	}
	treasury := getMoney(s, kTreasury())
	rhs := new(big.Int).Add(hbdOut, reserves)
	rhs.Add(rhs, treasury)
	rhs.Add(rhs, heldCommission)
	rhs.Add(rhs, feePots)
	if hbdIn.Cmp(rhs) != 0 {
		t.Fatalf("%s: MONEY CONSERVATION VIOLATED — Σin=%s != Σout(%s)+Σreserves(%s)+treasury(%s)+heldCommission(%s)+feePots(%s)=%s",
			label, hbdIn, hbdOut, reserves, treasury, heldCommission, feePots, rhs)
	}
}

// hzResetObs clears a market's TWAP observation ring to a known-empty
// state.
//
// WHY IT IS NEEDED, AND WHY IT IS NOT CHEATING: under the curve, Buy and
// Sell THEMSELVES feed the price ring (RULINGS "WIRING" — the curve is the
// price source), at the marginal curve rate. The PAR-era fixtures below
// seed hand-picked marker rates (1500 / 2000 / 7777 / 1234) chosen to be
// distinguishable in assertions, and those markers are nowhere near the
// curve's own rate for the funded supply — so a funding Buy leaves a real
// observation in the ring that the marker series then deviates from, and
// AskRate correctly refuses (MaxRateDeviationBps against the window
// MEDIAN — the manipulation guard doing exactly its job).
//
// The fixtures' SUBJECT is settlement/leak logic, not the feed, so the ring
// is reset to empty after funding and the marker series is written into a
// clean ring. Nothing about the assertions is weakened: the curve feed's
// own correctness is covered where it belongs (buy_test/sell_test assert
// the exact recorded rates; twap_test owns the ring semantics).
func hzResetObs(s Store, creator string) {
	// BOTH rings (RULING C1 added the long one): a funding Buy feeds the
	// long ring too, and a marker series must not deviate from ITS median
	// either.
	for i := uint64(0); i < ObsWindow; i++ {
		setStr(s, kObs(creator, i), "")
		setStr(s, kObsLong(creator, i), "")
	}
	setU64(s, kObsIdx(creator), 0)
	setU64(s, kObsLongIdx(creator), 0)
}

// hzBuy is the RULING-A replacement for every `Prepay` call site in this
// file: Buy on the curve is the only issuance path now (the PAR mint is
// deleted — transfer.go's header has the autopsy). It returns the full
// BuyResult so call sites assert reserve deltas against res.Cost (the curve
// leg — the ONLY part that enters kReserve, C-19) and feed hbdIn from
// res.TotalDue (cost + the 10% trade fee the buyer actually pays).
//
// `tokens` is a TOKEN count, not an HBD amount — the units changed with the
// mechanism, and every call site below was re-denominated deliberately
// rather than by dividing the old HBD figure by anything.
func hzBuy(t *testing.T, s Store, holder, creator string, block uint64, tokens int64) *BuyResult {
	t.Helper()
	res, err := Buy(s, holder, creator, block, big.NewInt(tokens))
	hzMustOK(t, err, fmt.Sprintf("Buy(%s -> %s, %d tokens)", holder, creator, tokens))
	if res.Minted.Cmp(big.NewInt(tokens)) != 0 {
		t.Fatalf("Buy(%s->%s): minted %s, want exactly %d", holder, creator, res.Minted, tokens)
	}
	if mAdd(res.Cost, res.Fee).Cmp(res.TotalDue) != 0 {
		t.Fatalf("Buy(%s->%s): TotalDue %s != Cost %s + Fee %s", holder, creator, res.TotalDue, res.Cost, res.Fee)
	}
	return res
}

// ===========================================================================
// TestHarness_FullLifecycle_EndToEnd
//
// Drives TWO markets (alice, bob) through the real production call sequence
// in the order the task lays out: register -> renew -> prepay (several
// holders) -> record observations -> ask -> answer AND reclaim -> transfer
// credits -> subscription lapses -> OVERDUE -> FROZEN -> refund/RefundHolder
// -> CloseIfDrained. alice's market runs the FULL path to CLOSED; bob's
// market is registered once and never touched again, so every invariant
// check on bob throughout alice's entire wind-down doubles as a
// cross-market isolation proof: nothing that happens to alice's reserve,
// supply, escrow or balances is ever observable on bob's.
// ===========================================================================
func TestHarness_FullLifecycle_EndToEnd(t *testing.T) {
	s := NewMemStore()

	const (
		alice = "alicecreates"
		bob   = "bobcreates"
	)
	creators := []string{alice, bob}

	hbdIn := big.NewInt(0)
	hbdOut := big.NewInt(0)

	// ---- REGISTER ----
	const (
		// face raised 1000 -> 10,000 (RULING C): alice's market trades to
		// S=2000, where the curve's average price is ~12,382 and spot is
		// 27,250 base units per token. A 1.000 HBD face against a ~12-27 HBD
		// token is EXACTLY what the C4 minimum-price guard refuses (the
		// smallest possible spend, one token, would overcharge >2x), and a
		// marker rate low enough to pass C4 at face 1000 would trip the C5
		// divergence tripwire (ceil(R/S) > 4·rate) instead. A coherent
		// post-RULING-C fixture needs a face in the same order of magnitude
		// as the token — 10 HBD.
		face   int64 = 10_000  // 10.000 HBD
		capVal int64 = 1000000 // generous; alice's supply peaks at 510,000
	)
	// REGISTRATION IS FREE (LOCKED-MECHANISM "Revenue", USER-RULED
	// 2026-07-21): no fee is charged, so no HBD enters the system here and
	// hbdIn is deliberately NOT advanced by a registration.
	regBlock := uint64(1_000_000)
	for _, c := range creators {
		before := hzReserves(s, creators)
		hzMustOK(t, Register(s, c, c, regBlock, face, capVal), "Register("+c+")")
		hzAssertReserveDeltas(t, s, creators, before, nil, "post-Register("+c+")")
		hzAssertI3(t, s, c, "post-Register("+c+")")
		hzAssertI1Solvency(t, s, c, regBlock, "post-Register("+c+")", true)
		hzAssertPhase(t, s, c, regBlock, StateActive, "post-Register("+c+")")
	}
	hzAssertConservation(t, s, creators, hbdIn, hbdOut, "post-Register(both)")

	// ---- RENEW (a fan pays for alice; anyone may) ----
	renewBlock := regBlock + 10
	renewPaid := big.NewInt(SubscriptionFee)
	beforeRenew := hzReserves(s, creators)
	hzMustOK(t, Renew(s, "fanrenews1", alice, renewBlock, 1, renewPaid), "Renew(alice)")
	hbdIn.Add(hbdIn, renewPaid)
	hzAssertReserveDeltas(t, s, creators, beforeRenew, nil, "post-Renew")
	hzAssertI3(t, s, alice, "post-Renew")
	hzAssertConservation(t, s, creators, hbdIn, hbdOut, "post-Renew")

	// alice's paid_until is now regBlock+SubscriptionPeriod (from Register)
	// extended by one more period (Renew's base = max(cur, block) = cur here).
	alicePaidUntil := regBlock + 2*SubscriptionPeriod

	// ---- BUY (several holders, both markets) ----
	// RULING A: the PAR mint is deleted; Buy on the curve is the only
	// issuance path. Amounts are TOKEN counts now (re-denominated
	// deliberately, not converted): alice's market reaches 2,000 tokens and
	// bob's 800, which at the compiled 21/2 slope means alice holds
	// area(2000) = 21,010,500 base units of backing — a realistically deep
	// market, and enough that the later ask/answer/wind-down steps all have
	// room to move.
	type buyStep struct {
		holder  string
		creator string
		tokens  int64
	}
	buys := []buyStep{
		{"holderone", alice, 1000},
		{"holdertwo", alice, 600},
		{"holderthree", alice, 400},
		{"holderfour", bob, 500},
		{"holderone", bob, 300},
	}
	pb := regBlock + 20
	for _, p := range buys {
		before := hzReserves(s, creators)
		res := hzBuy(t, s, p.holder, p.creator, pb, p.tokens)
		// The buyer's wallet pays cost + fee; ONLY the cost enters the
		// reserve (C-19 — the fee accrues to the pull pots, which
		// hzAssertConservation now counts as their own resting buckets).
		hbdIn.Add(hbdIn, res.TotalDue)
		hzAssertReserveDeltas(t, s, creators, before, map[string]*big.Int{p.creator: res.Cost}, "post-Buy("+p.holder+"->"+p.creator+")")
		hzAssertI3(t, s, p.creator, "post-Buy")
		hzAssertI1Solvency(t, s, p.creator, pb, "post-Buy", true)
		pb++
	}
	hzAssertConservation(t, s, creators, hbdIn, hbdOut, "post-Buy(all)")

	// ---- RECORD OBSERVATIONS (alice only; needed to Ask against alice) ----
	// RULING C re-shape: 12 markers spaced LongObsSpacing (6300) apart so the
	// series satisfies BOTH rings (the long/7-day window needs >= 8 samples
	// spanning >= 2 days; the old 8-at-300-blocks series landed exactly ONE
	// long sample and settlement refused — the young-market refusal working
	// as ruled). Marker rate 2000 -> 12,500: at alice's S=2000 the C5
	// tripwire needs rate >= ceil(Area(2000)/2000)/4 = 3096, and 12,500 sits
	// plausibly between the average (12,382) and spot (27,250), so
	// min(short, long, spot) resolves to the marker itself.
	hzResetObs(s, alice)          // see hzResetObs: the funding Buys already fed both rings
	obsRate := big.NewInt(12_500) // a marker rate, distinguishable in assertions
	obsBlocks := make([]uint64, stObsCount)
	for i := range obsBlocks {
		obsBlocks[i] = regBlock + 30030 + uint64(i)*LongObsSpacing
	}
	for i, ob := range obsBlocks {
		before := hzReserves(s, creators)
		RecordObs(s, alice, ob, obsRate)
		hzAssertReserveDeltas(t, s, creators, before, nil, fmt.Sprintf("post-RecordObs#%d", i))
		hzAssertI3(t, s, alice, "post-RecordObs")
	}
	askQueryBlock := obsBlocks[len(obsBlocks)-1] + 50
	rate, err := AskRate(s, alice, askQueryBlock)
	hzMustOK(t, err, "AskRate(alice) after 12 observations")
	if rate.Cmp(obsRate) != 0 {
		t.Fatalf("AskRate = %s, want exactly %s (constant history)", rate, obsRate)
	}
	// Cross-check the FULL settlement derivation too (RULING C1): with a
	// constant history in both windows and spot(2000) = 27,250 above the
	// marker, min(short, long, spot) == the marker.
	settleRate, err := SettlementRate(s, alice, askQueryBlock)
	hzMustOK(t, err, "SettlementRate(alice)")
	if settleRate.Cmp(obsRate) != 0 {
		t.Fatalf("SettlementRate = %s, want exactly %s (min of constant windows and higher spot)", settleRate, obsRate)
	}

	// ---- ASK (four asks: two will be Answered, two will be Reclaimed) ----
	faceBig := big.NewInt(face)
	commission := commissionOwedFor(faceBig)
	wantCredits := creditsForAsk(faceBig, rate)

	type askRec struct {
		asker string
		res   *AskResult
	}
	mkAsk := func(asker string, block uint64, deadlineBlocks uint64, tag string) askRec {
		before := hzReserves(s, creators)
		// maxCredits = wantCredits, exactly: Ask no longer takes `rate` as a
		// parameter (2026-07-20 fix — it derives it internally via
		// SettlementRate); wantCredits is what that derivation independently
		// computes too (constant-rate observation history, so
		// SettlementRate == rate at every block this loop asks at — see the
		// RECORD OBSERVATIONS step above), making this the tightest
		// legitimate cap, not a generous one.
		res, err := askAt0(s, asker, alice, block, wantCredits, commission, tag, deadlineBlocks)
		hzMustOK(t, err, "Ask("+tag+")")
		if res.CreditsSpent.Cmp(wantCredits) != 0 {
			t.Fatalf("Ask(%s): spent %s credits, want %s", tag, res.CreditsSpent, wantCredits)
		}
		if res.CommissionHbd.Cmp(commission) != 0 {
			t.Fatalf("Ask(%s): commission %s, want %s", tag, res.CommissionHbd, commission)
		}
		hbdIn.Add(hbdIn, res.CommissionHbd)
		// Ask never touches ANY market's reserve — only credits (bal->escrow)
		// and the HBD commission leg into the global treasury.
		hzAssertReserveDeltas(t, s, creators, before, nil, "post-Ask("+tag+")")
		hzAssertI3(t, s, alice, "post-Ask("+tag+")")
		hzAssertI1Solvency(t, s, alice, block, "post-Ask("+tag+")", true)
		return askRec{asker: asker, res: res}
	}

	askBlock := askQueryBlock + 20
	ask1 := mkAsk("holderone", askBlock, 2*BlocksPerDay, "content-ask-1")      // -> Answered
	ask2 := mkAsk("holdertwo", askBlock+10, 2*BlocksPerDay, "content-ask-2")   // -> Answered
	ask3 := mkAsk("holderthree", askBlock+20, MinAskDeadline, "content-ask-3") // -> Reclaimed
	ask4 := mkAsk("holderone", askBlock+30, MinAskDeadline, "content-ask-4")   // -> Reclaimed
	hzAssertConservation(t, s, creators, hbdIn, hbdOut, "post-Ask(all four)")

	// ---- ANSWER (creator answers before deadline; pays in CREDITS only) ----
	answerBlock := askBlock + 100
	for _, a := range []askRec{ask1, ask2} {
		before := hzReserves(s, creators)
		res, err := Answer(s, alice, alice, answerBlock, a.res.Seq, "answer-for-"+a.asker)
		hzMustOK(t, err, fmt.Sprintf("Answer(seq=%d)", a.res.Seq))
		if res.CreditsToCreator.Cmp(a.res.CreditsSpent) != 0 {
			t.Fatalf("Answer(seq=%d): paid creator %s credits, want %s", a.res.Seq, res.CreditsToCreator, a.res.CreditsSpent)
		}
		// I4, emphasised: Answer pays the creator in CREDITS. It must NEVER
		// touch the reserve, for alice OR bob.
		hzAssertReserveDeltas(t, s, creators, before, nil, fmt.Sprintf("post-Answer(seq=%d)", a.res.Seq))
		hzAssertI3(t, s, alice, "post-Answer")
	}
	hzAssertConservation(t, s, creators, hbdIn, hbdOut, "post-Answer(both)")

	// ---- RECLAIM (past deadline+grace; I5: no commission; 100% back) ----
	reclaimBlock := askBlock + 30 + MinAskDeadline + ReclaimGrace + 1
	for _, a := range []askRec{ask3, ask4} {
		got, gotCommission := hzReclaimNoCommission(t, s, a.asker, alice, reclaimBlock, a.res.Seq, fmt.Sprintf("post-Reclaim(seq=%d)", a.res.Seq))
		if got.Cmp(a.res.CreditsSpent) != 0 {
			t.Fatalf("Reclaim(seq=%d): returned %s credits, want exactly %s (100%% back, I5)", a.res.Seq, got, a.res.CreditsSpent)
		}
		if gotCommission.Cmp(a.res.CommissionHbd) != 0 {
			t.Fatalf("Reclaim(seq=%d): returned commission %s, want exactly %s (DEFECT 1 FIX, SPEC §1.7.2 rule 4)", a.res.Seq, gotCommission, a.res.CommissionHbd)
		}
		// The commission is a REAL HBD outflow a real `reclaim` entrypoint
		// pays back to the asker (contract/main.go) — track it in the same
		// ledger every other HBD-out call in this test uses.
		hbdOut.Add(hbdOut, gotCommission)
		hzAssertI3(t, s, alice, "post-Reclaim")
	}
	hzAssertConservation(t, s, creators, hbdIn, hbdOut, "post-Reclaim(both)")

	// ---- TRANSFER CREDITS (pre-lapse) ----
	beforeTransfer := hzReserves(s, creators)
	hzMustOK(t, TransferCredits(s, alice, "holdertwo", "holderfour", pb, big.NewInt(200)), "TransferCredits")
	hzAssertReserveDeltas(t, s, creators, beforeTransfer, nil, "post-TransferCredits")
	hzAssertI3(t, s, alice, "post-TransferCredits")

	// ---- SUBSCRIPTION LAPSES: ACTIVE -> OVERDUE ----
	overdueBlock := alicePaidUntil + 1000
	hzAssertPhase(t, s, alice, overdueBlock, StateOverdue, "lapse")

	// OVERDUE is still fully functional — prove a NEW buy still lands.
	beforeODBuy := hzReserves(s, creators)
	odRes := hzBuy(t, s, "holderfive", alice, overdueBlock, 200)
	hbdIn.Add(hbdIn, odRes.TotalDue)
	hzAssertReserveDeltas(t, s, creators, beforeODBuy, map[string]*big.Int{alice: odRes.Cost}, "post-Buy(OVERDUE)")
	hzAssertI3(t, s, alice, "post-Buy(OVERDUE)")
	hzAssertConservation(t, s, creators, hbdIn, hbdOut, "post-Buy(OVERDUE)")

	// ---- OVERDUE -> FROZEN ----
	// EXITTAX-1/NOTICE-1 (2026-07-22): the wind-down sweep below uses the
	// permissionless RefundHolder push, which now refuses a still-taxed holder,
	// so the freeze/wind-down block is placed a full ExitTaxDecayBlocks past the
	// lapse+grace boundary — by which point every holder (incl. the OVERDUE-era
	// buyer holderfive) has decayed to τ = 0 and every push is a 0-tax sweep. The
	// market is FROZEN for every block from the boundary onward, so this only
	// moves WHEN the frozen-phase assertions and the sweep run, not whether.
	frozenBlock := alicePaidUntil + GraceBlocks + ExitTaxDecayBlocks
	hzAssertPhase(t, s, alice, frozenBlock, StateFrozen, "freeze")

	// A NEW buy is now rejected (inflows blocked) — and nothing is mutated.
	beforeRejBuy := hzReserves(s, creators)
	snapBefore := hzSnapshotAll(s)
	_, err = Buy(s, "holdersix", alice, frozenBlock, big.NewInt(10))
	hzMustErr(t, err, ErrState, "Buy while FROZEN must be rejected")
	hzAssertReserveDeltas(t, s, creators, beforeRejBuy, nil, "post-rejected-Buy")
	snapAfter := hzSnapshotAll(s)
	if changed := hzChangedKeys(snapBefore, snapAfter); len(changed) != 0 {
		t.Fatalf("rejected Buy while FROZEN mutated state: %v", changed)
	}

	// bob is never touched by any of this — spot-check now, before the
	// wind-down. Under the curve bob's reserve is the exact area of his own
	// 800 tokens (500 + 300 across two buys), computed here from the curve
	// rather than hard-coded, so the isolation claim survives recalibration.
	if got, want := Reserve(s, bob), Area(big.NewInt(800)); got.Cmp(want) != 0 {
		t.Fatalf("bob's reserve drifted before alice's wind-down even started: %s, want area(800) = %s", got, want)
	}

	// CloseIfDrained must refuse while supply > 0, even though FROZEN.
	if CloseIfDrained(s, alice, frozenBlock) {
		t.Fatal("CloseIfDrained fired while supply > 0")
	}

	// ---- WIND-DOWN: Refund (pull) and RefundHolder (push), mixed ----
	// RULING K2: the wind-down carries the exit tax. The RESERVE is debited the
	// full GROSS pro-rata slice; the holder RECEIVES net = gross − τ(h)·gross;
	// the tax goes to kTreasury(), where hzAssertConservation already counts it.
	// So hbdOut tracks the NET that actually left the contract, the reserve
	// delta is the GROSS, and conservation still balances.
	refundSelf := func(caller string, credits int64, label string) {
		t.Helper()
		before := hzReserves(s, creators)
		supply := Supply(s, alice)
		reserve := Reserve(s, alice)
		gross := refundPayout(reserve, big.NewInt(credits), supply)
		wantNet := new(big.Int).Sub(gross, ExitTaxOn(gross, ExitTaxBpsAt(heldBlocksAt(s, alice, caller, frozenBlock))))
		payout, err := Refund(s, caller, alice, frozenBlock, big.NewInt(credits))
		hzMustOK(t, err, label)
		if payout.Cmp(wantNet) != 0 {
			t.Fatalf("%s: payout %s, want net %s (gross %s − K2 tax)", label, payout, wantNet, gross)
		}
		hbdOut.Add(hbdOut, payout)
		hzAssertReserveDeltas(t, s, creators, before, map[string]*big.Int{alice: new(big.Int).Neg(gross)}, label)
		hzAssertI3(t, s, alice, label)
		hzAssertI1Solvency(t, s, alice, frozenBlock, label, false) // wind-down: pro-rata leaves R >= area(S)
		hzAssertConservation(t, s, creators, hbdIn, hbdOut, label)
	}
	refundPush := func(pusher, holder string, label string) {
		t.Helper()
		before := hzReserves(s, creators)
		bal := BalanceOf(s, alice, holder)
		supply := Supply(s, alice)
		reserve := Reserve(s, alice)
		gross := refundPayout(reserve, bal, supply)
		wantNet := new(big.Int).Sub(gross, ExitTaxOn(gross, ExitTaxBpsAt(heldBlocksAt(s, alice, holder, frozenBlock))))
		payout, err := RefundHolder(s, pusher, alice, holder, frozenBlock)
		hzMustOK(t, err, label)
		if payout.Cmp(wantNet) != 0 {
			t.Fatalf("%s: payout %s, want net %s (gross %s − K2 tax)", label, payout, wantNet, gross)
		}
		hbdOut.Add(hbdOut, payout)
		hzAssertReserveDeltas(t, s, creators, before, map[string]*big.Int{alice: new(big.Int).Neg(gross)}, label)
		hzAssertI3(t, s, alice, label)
		hzAssertI1Solvency(t, s, alice, frozenBlock, label, false) // wind-down: pro-rata leaves R >= area(S)
		hzAssertConservation(t, s, creators, hbdIn, hbdOut, label)
	}

	refundSelf("holderone", 400, "wind-down: Refund(holderone, partial 400 of 1000)")
	refundPush("hzkeeper", "holdertwo", "wind-down: RefundHolder(holdertwo, full)")
	refundPush("hzkeeper", "holderthree", "wind-down: RefundHolder(holderthree, full)")
	refundSelf("holderfour", BalanceOf(s, alice, "holderfour").Int64(), "wind-down: Refund(holderfour, full)")
	refundPush("hzkeeper", "holderfive", "wind-down: RefundHolder(holderfive, full)")
	refundPush("hzkeeper", alice, "wind-down: RefundHolder(alice's own earned credits)")
	refundPush("hzkeeper", "holderone", "wind-down: RefundHolder(holderone, remainder)")

	// ---- CLOSE ----
	if !CloseIfDrained(s, alice, frozenBlock) {
		t.Fatal("CloseIfDrained returned false with supply == 0 while FROZEN")
	}
	hzAssertPhase(t, s, alice, frozenBlock, StateClosed, "post-close")
	if !CloseIfDrained(s, alice, frozenBlock) {
		t.Fatal("CloseIfDrained is not idempotent")
	}
	if got := Reserve(s, alice); !mIsZero(got) {
		t.Fatalf("alice's reserve after full wind-down = %s, want exactly 0", got)
	}
	if got := Supply(s, alice); !mIsZero(got) {
		t.Fatalf("alice's supply after full wind-down = %s, want exactly 0", got)
	}

	// bob's MONEY is completely untouched by alice's entire lifecycle — this
	// is the actual cross-market isolation claim, and it holds exactly.
	if got, want := Reserve(s, bob), Area(big.NewInt(800)); got.Cmp(want) != 0 {
		t.Fatalf("bob's reserve after alice's wind-down = %s, want untouched area(800) = %s", got, want)
	}
	if got := Supply(s, bob); got.Cmp(big.NewInt(800)) != 0 {
		t.Fatalf("bob's supply after alice's wind-down = %s, want untouched 800 tokens", got)
	}
	// bob's PHASE, unlike his money, is not "untouched" — Phase() is lazily
	// derived from block height alone (API.md rule 1), never stored, so it
	// drifts forward for EVERY market as blocks pass, independent of
	// whether anyone ever calls anything against that market again. bob was
	// registered at the same block as alice but never renewed, so by
	// alice's frozenBlock — 1,008,000 blocks after bob's own paid_until —
	// bob has independently lapsed all the way to FROZEN too, purely from
	// elapsed height, with zero state ever written to bob's market. That is
	// the correct, intended behaviour (not a bug): it is what proves Phase
	// is genuinely computed per-call from (block, paidUntil), never copied
	// or influenced by another creator's activity.
	hzAssertPhase(t, s, bob, frozenBlock, StateFrozen, "bob's own lapse, purely from elapsed blocks, zero state written")

	hzAssertConservation(t, s, creators, hbdIn, hbdOut, "FINAL")
	t.Logf("FULL LIFECYCLE OK: Σin=%s Σout=%s reserve(alice)=0 reserve(bob)=%s treasury=%s — conserved, alice CLOSED, bob untouched.",
		hbdIn, hbdOut, Reserve(s, bob), getMoney(s, kTreasury()))
}

// ===========================================================================
// TestHarness_Guardrail_FrozenNeverGatesFunds
//
// THE single most important property in the system (API.md rule 4, SPEC
// §1.7.2 guardrail #1): once a market is FROZEN, billing state must never
// gate funds. Every outflow keeps working; every NEW inflow is blocked.
// Each of the five outflow paths is proven to work INDIVIDUALLY, with an
// explicit Phase() assertion immediately before each proof so it is
// unambiguous the call succeeded WHILE frozen, not before.
// ===========================================================================
func TestHarness_Guardrail_FrozenNeverGatesFunds(t *testing.T) {
	s := NewMemStore()
	const creator = "frozentester"
	creators := []string{creator}

	const (
		// face raised 1000 -> 30,000 (RULING C): this market trades to
		// S=6000, where the curve's average price is ~56,139 — a coherent
		// fixture needs face and marker in the token's own order of
		// magnitude (C4: face·2 >= rate; C5: rate >= average/4). Same
		// reasoning as the lifecycle test's face change above.
		// 30,000 -> 34,000 (commission carve-out, USER RULING 2026-07-27):
		// C4 measures the TOKEN LEG, not the posted face, and the leg is
		// 34,000-4,080 = 29,920, so 2·leg = 59,840 still clears the 56,000
		// marker below. At the old 30,000 the leg was 26,400 and 2·leg =
		// 52,800 < 56,000 — the fixture, not the guard, was what broke.
		face   int64 = 34_000 // 34.000 HBD
		capVal int64 = 1000000
	)
	regBlock := uint64(2_000_000)
	hzMustOK(t, Register(s, creator, creator, regBlock, face, capVal), "Register")
	paidUntil := regBlock + SubscriptionPeriod
	frozenStart := paidUntil + GraceBlocks

	// Funded on the CURVE (Buy is the only issuance path). Token counts,
	// re-denominated deliberately from the deleted PAR amounts.
	hzBuy(t, s, "holdera", creator, regBlock+10, 3000)
	hzBuy(t, s, "holderb", creator, regBlock+20, 2000)
	hzBuy(t, s, "holderc", creator, regBlock+30, 1000)

	// Price history, placed to end just before FROZEN — the realistic case:
	// a market stays actively used right up until the subscription lapses.
	// RULING C re-shape: stObsCount (12) markers spaced LongObsSpacing
	// (6300) apart so BOTH windows price (the old 8-at-300-blocks series
	// left the 7-day ring below its minimum count and settlement refused).
	// The series starts ~68,400 blocks before lastObs — inside ACTIVE — and
	// ends in early OVERDUE, which RecordObs permits (no phase gate at all).
	// Marker 56,000: between average (56,139: C5 quiet, 56,139 <= 224,000)
	// and spot(6000) = 142,750 (the min resolves to the marker); C4 passes
	// (face·2 = 60,000 >= 56,000).
	hzResetObs(s, creator) // see hzResetObs: the funding Buys already fed both rings
	obsRate := big.NewInt(56_000)
	lastObs := paidUntil + 900 // early OVERDUE; RecordObs has no phase gate at all
	obsBlocks := make([]uint64, stObsCount)
	for i := range obsBlocks {
		obsBlocks[i] = lastObs - uint64(stObsCount-1-i)*LongObsSpacing
	}
	for _, ob := range obsBlocks {
		RecordObs(s, creator, ob, obsRate)
	}

	commission := commissionOwedFor(big.NewInt(face))

	// An ask whose deadline reaches well past the FROZEN block we'll test at
	// — this is the "creator mid-answer when the subscription lapses" case
	// from SPEC §1.7.5.
	inFlightBlock := lastObs + 100
	// AskRate called directly here purely to cross-check Ask's OWN internal
	// SettlementRate derivation (2026-07-20 fix removed `rate` as an Ask
	// parameter — see ask.go's doc) against a standalone read of the same
	// state, then used to compute the tightest legitimate maxCredits.
	inFlightRate, err := AskRate(s, creator, inFlightBlock)
	hzMustOK(t, err, "AskRate (in-flight ask)")
	askInFlight, err := askAt0(s, "holdera", creator, inFlightBlock, creditsForAsk(big.NewInt(face), inFlightRate), commission, "inflight-1", MaxAskDeadline)
	hzMustOK(t, err, "Ask(inflight)")

	// A second ask whose window will already have closed by the time we
	// test FROZEN — this is the one we'll reclaim.
	toReclaimBlock := inFlightBlock + 10
	toReclaimRate, err := AskRate(s, creator, toReclaimBlock)
	hzMustOK(t, err, "AskRate (to-reclaim ask)")
	askToReclaim, err := askAt0(s, "holderb", creator, toReclaimBlock, creditsForAsk(big.NewInt(face), toReclaimRate), commission, "reclaim-me-1", MinAskDeadline)
	hzMustOK(t, err, "Ask(to-reclaim)")

	frozenTestBlock := frozenStart + 2000
	hzAssertPhase(t, s, creator, frozenTestBlock, StateFrozen, "precondition")
	// Sanity: askInFlight's deadline must still be open at frozenTestBlock,
	// and askToReclaim's deadline+grace must already have passed.
	if frozenTestBlock > inFlightBlock+MaxAskDeadline {
		t.Fatal("test setup bug: in-flight ask's deadline already passed by frozenTestBlock")
	}
	if frozenTestBlock <= toReclaimBlock+MinAskDeadline+ReclaimGrace {
		t.Fatal("test setup bug: to-reclaim ask's reclaim window not yet open at frozenTestBlock")
	}

	t.Run("NewBuy_isBlocked", func(t *testing.T) {
		hzAssertPhase(t, s, creator, frozenTestBlock, StateFrozen, "precondition")
		before := hzSnapshotAll(s)
		_, err := Buy(s, "wouldbeholder", creator, frozenTestBlock, big.NewInt(50))
		hzMustErr(t, err, ErrState, "Buy while FROZEN")
		after := hzSnapshotAll(s)
		if changed := hzChangedKeys(before, after); len(changed) != 0 {
			t.Fatalf("rejected Buy mutated state: %v", changed)
		}
	})

	// THE OUTFLOW HALF OF THE SAME GUARDRAIL, curve edition: the FROZEN
	// market's exit rail is Refund (proved below), and Sell — the ACTIVE
	// rail — is correctly ROUTED away rather than being a funds gate. This
	// is the pairing sell.go/refund.go prove structurally; assert it here
	// so "FROZEN never gates funds" is not read as "Sell must work while
	// FROZEN", which would re-open the tax-and-fee bypass.
	t.Run("Sell_isRoutedToRefund_notGated", func(t *testing.T) {
		hzAssertPhase(t, s, creator, frozenTestBlock, StateFrozen, "precondition")
		bal := BalanceOf(s, creator, "holdera")
		if bal.Sign() <= 0 {
			t.Fatal("test setup: holdera must still hold tokens here")
		}
		before := hzSnapshotAll(s)
		_, err := Sell(s, "holdera", creator, frozenTestBlock, big.NewInt(1))
		hzMustErr(t, err, ErrState, "Sell while FROZEN routes to Refund")
		if changed := hzChangedKeys(before, hzSnapshotAll(s)); len(changed) != 0 {
			t.Fatalf("rejected Sell mutated state: %v", changed)
		}
	})

	t.Run("NewAsk_isBlocked", func(t *testing.T) {
		hzAssertPhase(t, s, creator, frozenTestBlock, StateFrozen, "precondition")
		before := hzSnapshotAll(s)
		// maxCredits=1500 is an arbitrary valid (positive) cap — this call is
		// rejected by RequireInflowOpen (FROZEN) before it ever reaches the
		// maxCredits guard, so its exact value doesn't matter here.
		_, err := askAt0(s, "holderc", creator, frozenTestBlock, big.NewInt(1500), commission, "should-be-rejected", MinAskDeadline)
		hzMustErr(t, err, ErrState, "Ask while FROZEN")
		after := hzSnapshotAll(s)
		if changed := hzChangedKeys(before, after); len(changed) != 0 {
			t.Fatalf("rejected Ask mutated state: %v", changed)
		}
	})

	t.Run("Refund_stillWorks", func(t *testing.T) {
		hzAssertPhase(t, s, creator, frozenTestBlock, StateFrozen, "precondition")
		supply := Supply(s, creator)
		reserve := Reserve(s, creator)
		gross := refundPayout(reserve, big.NewInt(400), supply)
		wantNet := new(big.Int).Sub(gross, ExitTaxOn(gross, ExitTaxBpsAt(heldBlocksAt(s, creator, "holderc", frozenTestBlock))))
		before := BalanceOf(s, creator, "holderc")
		payout, err := Refund(s, "holderc", creator, frozenTestBlock, big.NewInt(400))
		hzMustOK(t, err, "Refund while FROZEN")
		if payout.Cmp(wantNet) != 0 {
			t.Fatalf("Refund while FROZEN paid %s, want net %s (gross %s − K2 tax)", payout, wantNet, gross)
		}
		after := BalanceOf(s, creator, "holderc")
		if new(big.Int).Sub(before, after).Cmp(big.NewInt(400)) != 0 {
			t.Fatalf("holderc balance moved by %s, want -400", new(big.Int).Sub(after, before))
		}
	})

	t.Run("RefundHolder_stillWorks", func(t *testing.T) {
		// EXITTAX-1/NOTICE-1 (2026-07-22): the permissionless push refuses a
		// still-taxed holder, so it must land past holdera's decay. This subtest
		// uses a LATER block than the shared frozenTestBlock (which the sibling
		// answer/reclaim subtests keep, because the in-flight ask must not have
		// expired) — the market is still FROZEN, holdera (funded near market
		// creation) is fully decayed to τ = 0, and the push is a 0-tax sweep.
		pushBlock := frozenTestBlock + ExitTaxDecayBlocks
		hzAssertPhase(t, s, creator, pushBlock, StateFrozen, "precondition")
		supply := Supply(s, creator)
		reserve := Reserve(s, creator)
		holderaBal := BalanceOf(s, creator, "holdera") // 300000 - 1 (spent on the in-flight ask)
		gross := refundPayout(reserve, holderaBal, supply)
		wantNet := new(big.Int).Sub(gross, ExitTaxOn(gross, ExitTaxBpsAt(heldBlocksAt(s, creator, "holdera", pushBlock))))
		payout, err := RefundHolder(s, "hzpusher", creator, "holdera", pushBlock)
		hzMustOK(t, err, "RefundHolder while FROZEN")
		if payout.Cmp(wantNet) != 0 {
			t.Fatalf("RefundHolder while FROZEN paid %s, want net %s (gross %s − K2 tax)", payout, wantNet, gross)
		}
		if got := BalanceOf(s, creator, "holdera"); !mIsZero(got) {
			t.Fatalf("holdera balance after full RefundHolder = %s, want 0 (was %s)", got, holderaBal)
		}
	})

	t.Run("Reclaim_stillWorks", func(t *testing.T) {
		hzAssertPhase(t, s, creator, frozenTestBlock, StateFrozen, "precondition")
		got, gotCommission := hzReclaimNoCommission(t, s, "holderb", creator, frozenTestBlock, askToReclaim.Seq, "Reclaim while FROZEN")
		if got.Cmp(askToReclaim.CreditsSpent) != 0 {
			t.Fatalf("Reclaim while FROZEN returned %s, want exactly %s (100%% back)", got, askToReclaim.CreditsSpent)
		}
		if gotCommission.Cmp(askToReclaim.CommissionHbd) != 0 {
			t.Fatalf("Reclaim while FROZEN returned commission %s, want exactly %s (DEFECT 1 FIX)", gotCommission, askToReclaim.CommissionHbd)
		}
	})

	t.Run("TransferCredits_stillWorks", func(t *testing.T) {
		hzAssertPhase(t, s, creator, frozenTestBlock, StateFrozen, "precondition")
		before := BalanceOf(s, creator, "holderc") // remainder after the 400 refund above
		hzMustOK(t, TransferCredits(s, creator, "holderc", "holderd", frozenTestBlock, big.NewInt(100)), "TransferCredits while FROZEN")
		after := BalanceOf(s, creator, "holderc")
		if new(big.Int).Sub(before, after).Cmp(big.NewInt(100)) != 0 {
			t.Fatalf("holderc balance moved by %s, want -10000", new(big.Int).Sub(after, before))
		}
		if got := BalanceOf(s, creator, "holderd"); got.Cmp(big.NewInt(100)) != 0 {
			t.Fatalf("holderd received %s, want 10000", got)
		}
	})

	t.Run("Answer_stillWorks", func(t *testing.T) {
		hzAssertPhase(t, s, creator, frozenTestBlock, StateFrozen, "precondition")
		before := hzReserves(s, creators)
		res, err := Answer(s, creator, creator, frozenTestBlock, askInFlight.Seq, "answered-while-frozen")
		hzMustOK(t, err, "Answer while FROZEN")
		if res.CreditsToCreator.Cmp(askInFlight.CreditsSpent) != 0 {
			t.Fatalf("Answer while FROZEN paid creator %s, want %s", res.CreditsToCreator, askInFlight.CreditsSpent)
		}
		// I4, emphasised exactly as the task calls out: Answer pays in
		// CREDITS and must never touch the reserve, even while FROZEN.
		hzAssertReserveDeltas(t, s, creators, before, nil, "Answer while FROZEN must not touch reserve")
	})

	hzAssertI3(t, s, creator, "guardrail final")
	t.Logf("GUARDRAIL PROVEN: Refund, RefundHolder, Reclaim, TransferCredits and Answer all succeeded while Phase()==FROZEN; new Buy and new Ask were both rejected with zero state mutation, and Sell was ROUTED to Refund (not gated).")
}

// ===========================================================================
// TestHarness_FullWindDown_RandomOrderMixedRefundStyles
//
// 12 holders, refunded in a randomized order (fixed seed — deterministic,
// never flaky), mixing self-pull (Refund) and permissionless push
// (RefundHolder), plus two holders who split their own redemption across
// two partial calls. Ends at reserve == 0, supply == 0, market CLOSED, and
// zero dust: Σ payouts == Σ prepaid, exactly.
// ===========================================================================
func TestHarness_FullWindDown_RandomOrderMixedRefundStyles(t *testing.T) {
	s := NewMemStore()
	const creator = "winddown1"
	regBlock := uint64(4_000_000)
	hzMustOK(t, Register(s, creator, creator, regBlock, 1000, 10_000_000), "Register")

	type holderAmt struct {
		holder string
		amount int64
	}
	holders := []holderAmt{
		{"wdholder01", 12000},
		{"wdholder02", 7500},
		{"wdholder03", 23000},
		{"wdholder04", 5000},
		{"wdholder05", 18750},
		{"wdholder06", 9999},
		{"wdholder07", 31000},
		{"wdholder08", 2222},
		{"wdholder09", 14500},
		{"wdholder10", 6000},
		{"wdholder11", 27300},
		{"wdholder12", 4444},
	}

	// Funded on the CURVE. totalCost sums the CURVE LEGS only (the fee
	// never enters the reserve — C-19), so it is exactly what a complete
	// wind-down must pay back out (C-24 terminal exactness).
	totalCost := big.NewInt(0)
	block := regBlock + 10
	for _, h := range holders {
		res := hzBuy(t, s, h.holder, creator, block, h.amount)
		totalCost.Add(totalCost, res.Cost)
		block++
	}
	hzAssertI3(t, s, creator, "post-Buy(all 12)")
	hzAssertI1Solvency(t, s, creator, block, "post-Buy(all 12)", true)
	if got := Reserve(s, creator); got.Cmp(totalCost) != 0 {
		t.Fatalf("reserve = %s, want Σ curve costs = %s", got, totalCost)
	}
	if got, want := Reserve(s, creator), Area(Supply(s, creator)); got.Cmp(want) != 0 {
		t.Fatalf("reserve = %s, want area(supply) = %s (equality invariant)", got, want)
	}

	// Wind down while FROZEN (realistic — this is when a wind-down actually
	// happens), well past the lapse+grace boundary. EXITTAX-1/NOTICE-1
	// (2026-07-22): the mixed sweep below uses the permissionless push, which now
	// refuses a still-taxed holder, so this is placed a full ExitTaxDecayBlocks
	// beyond the freeze — every holder (all bought near regBlock+10) has decayed
	// to τ = 0 and every push is a 0-tax sweep. Reserve bookkeeping under test
	// (Σgross drained == Σcurve costs, zero dust) is on the GROSS and so is
	// tax-independent.
	refundBlock := regBlock + SubscriptionPeriod + GraceBlocks + ExitTaxDecayBlocks
	hzAssertPhase(t, s, creator, refundBlock, StateFrozen, "wind-down precondition")

	// RULING K2: the wind-down is taxed, so a holder receives net (gross − tax)
	// while the RESERVE is debited the full gross. The C-24 terminal-exactness
	// property (Σ drained == Σ curve costs, reserve → 0) is on the GROSS, which
	// is the reserve delta each call; totalGrossDrained tracks that.
	totalGrossDrained := big.NewInt(0)
	doSelf := func(holder string, credits int64, label string) {
		t.Helper()
		reserveBefore := Reserve(s, creator)
		_, err := Refund(s, holder, creator, refundBlock, big.NewInt(credits))
		hzMustOK(t, err, label)
		totalGrossDrained.Add(totalGrossDrained, new(big.Int).Sub(reserveBefore, Reserve(s, creator)))
		hzAssertI3(t, s, creator, label)
		hzAssertI1Solvency(t, s, creator, refundBlock, label, false) // wind-down: pro-rata leaves R >= area(S)
	}
	doPush := func(holder string, label string) {
		t.Helper()
		reserveBefore := Reserve(s, creator)
		_, err := RefundHolder(s, "wdkeeper", creator, holder, refundBlock)
		hzMustOK(t, err, label)
		totalGrossDrained.Add(totalGrossDrained, new(big.Int).Sub(reserveBefore, Reserve(s, creator)))
		hzAssertI3(t, s, creator, label)
		hzAssertI1Solvency(t, s, creator, refundBlock, label, false) // wind-down: pro-rata leaves R >= area(S)
	}

	// Two holders split their own redemption across two calls: one
	// self-then-push, one self-then-self — proving partial pulls converge
	// correctly and mixing styles WITHIN a single holder's own wind-down,
	// not just across holders. (RefundHolder always pays a holder's FULL
	// current balance — refund.go: "there is no partial push, only partial
	// pull via Refund" — so "push a partial amount" is not an operation
	// that exists; the push below drains exactly what the prior partial
	// self-Refund left behind.)
	doSelf("wdholder01", 7000, "split#1 self-partial(wdholder01, 7000 of 12000)")
	doPush("wdholder01", "split#1 push-remainder(wdholder01, 5000)")
	doSelf("wdholder02", 3000, "split#2 self-partial(wdholder02, 3000 of 7500)")
	doSelf("wdholder02", 4500, "split#2 self-partial(wdholder02, remaining 4500)")

	remaining := []string{
		"wdholder03", "wdholder04", "wdholder05", "wdholder06", "wdholder07",
		"wdholder08", "wdholder09", "wdholder10", "wdholder11", "wdholder12",
	}
	rng := rand.New(rand.NewSource(20260720))
	rng.Shuffle(len(remaining), func(i, j int) { remaining[i], remaining[j] = remaining[j], remaining[i] })

	for _, h := range remaining {
		bal := BalanceOf(s, creator, h)
		if rng.Intn(2) == 0 {
			doSelf(h, bal.Int64(), "random-order self-refund("+h+")")
		} else {
			doPush(h, "random-order pushed-refund("+h+")")
		}
	}

	if got := Reserve(s, creator); !mIsZero(got) {
		t.Fatalf("reserve after full wind-down = %s, want exactly 0", got)
	}
	if got := Supply(s, creator); !mIsZero(got) {
		t.Fatalf("supply after full wind-down = %s, want exactly 0", got)
	}
	if totalGrossDrained.Cmp(totalCost) != 0 {
		t.Fatalf("Σ gross drained = %s, Σ curve costs = %s — dust or over-payment in a random-order full unwind", totalGrossDrained, totalCost)
	}
	if !CloseIfDrained(s, creator, refundBlock) {
		t.Fatal("CloseIfDrained returned false with supply == 0 while FROZEN")
	}
	hzAssertPhase(t, s, creator, refundBlock, StateClosed, "final")

	t.Logf("FULL WIND-DOWN OK: 12 holders, random order + mixed self/push + 2 split redemptions, Σgross drained=%s == Σcurve costs=%s, zero dust, market CLOSED.",
		totalGrossDrained, totalCost)
}

// ===========================================================================
// TestHarness_RefundHolder_PaysHolderNeverCaller
//
// A full before/after key-diff over the ENTIRE store proves RefundHolder
// changes NOTHING but the three keys the holder's payout legitimately
// touches (their balance, supply, reserve) — not the caller's own balance,
// even when the caller happens to independently hold unrelated credits in
// the SAME market. This module has no per-account HBD ledger of its own
// (HBD only ever lives in the two pool keys kReserve/kTreasury — the actual
// HBD wire transfer to `holder` is the wasm layer's job, out of this
// package's scope), so a full key-diff is the strongest proof available at
// this level that the caller receives nothing, directly or indirectly.
// ===========================================================================
func TestHarness_RefundHolder_PaysHolderNeverCaller(t *testing.T) {
	s := NewMemStore()
	const creator = "pushtest1"
	const target = "pushtarget1"
	const caller = "pushercaller1"

	regBlock := uint64(7_000_000)
	hzMustOK(t, Register(s, creator, creator, regBlock, 1000, 1_000_000), "Register")

	hzBuy(t, s, target, creator, regBlock+10, 800)
	// The pusher independently holds UNRELATED credits in the SAME market —
	// this is what makes the "caller untouched" proof non-trivial: it is
	// not merely that the caller never had anything to lose.
	hzBuy(t, s, caller, creator, regBlock+20, 50)

	// H3 defect fix (2026-07-21): RefundHolder now requires Phase==FROZEN or
	// CLOSED, so this push must land well past the subscription's lapse+
	// grace boundary, not shortly after registration.
	//
	// EXITTAX-1/NOTICE-1 (2026-07-22): the permissionless push additionally
	// refuses while the pushed holder's exit tax is still nonzero, so it lands a
	// full ExitTaxDecayBlocks further out — target (bought regBlock+10) is fully
	// decayed to τ = 0 there and the sweep is untaxed. This test proves WHICH
	// keys the push touches; the fresh-holder-rejected case is
	// TestRefundHolder_EXITTAX1_FreshPushRefused (refund_test.go).
	pushBlock := regBlock + SubscriptionPeriod + GraceBlocks + 100 + ExitTaxDecayBlocks
	hzAssertPhase(t, s, creator, pushBlock, StateFrozen, "precondition")
	reserve := Reserve(s, creator)
	supply := Supply(s, creator)
	targetBal := BalanceOf(s, creator, target)
	// The push is allowed only at full decay (below), so the K2 tax is 0 and the
	// holder receives the full gross. Compute the (zero) tax from the state anyway
	// so the assertions read the real value rather than assuming it.
	grossPayout := refundPayout(reserve, targetBal, supply)
	targetTaxBps := ExitTaxBpsAt(heldBlocksAt(s, creator, target, pushBlock))
	targetTax := ExitTaxOn(grossPayout, targetTaxBps)
	wantNet := new(big.Int).Sub(grossPayout, targetTax)
	treaBefore := getMoney(s, kTreasury())

	before := hzSnapshotAll(s)
	payout, err := RefundHolder(s, caller, creator, target, pushBlock)
	hzMustOK(t, err, "RefundHolder(caller pushes target's refund)")
	after := hzSnapshotAll(s)

	if payout.Cmp(wantNet) != 0 {
		t.Fatalf("payout = %s, want %s (gross %s − K2 tax %s)", payout, wantNet, grossPayout, targetTax)
	}
	// EXITTAX-1/NOTICE-1 (2026-07-22): the permissionless push only fires once the
	// holder's exit tax has fully decayed, so targetTax is 0 here and the push is
	// a pure pass-through (net == gross). A fresh holder's push would have been
	// REFUSED, not taxed — see TestRefundHolder_EXITTAX1_FreshPushRefused.
	if targetTax.Sign() != 0 {
		t.Fatalf("precondition: target must be fully decayed for the push to be allowed, tax = %s", targetTax)
	}
	// Treasury is therefore UNTOUCHED by the push (no wind-down tax to collect).
	if got := new(big.Int).Sub(getMoney(s, kTreasury()), treaBefore); got.Sign() != 0 {
		t.Fatalf("treasury moved %s on a 0-tax push, want 0", got)
	}

	changed := hzChangedKeys(before, after)
	// A fully-decayed (0-tax) push touches exactly holder-bal / supply / reserve
	// — NOT the caller's own balance (the subject of this proof) and NOT the
	// treasury (no tax at full decay; the taxed key set is covered by the
	// pull-side K2 tests). RULING K deleted kBasis, so it is absent here too.
	want := []string{kBal(creator, target), kSupply(creator), kReserve(creator)}
	hzAssertExactChangedKeys(t, changed, want, "RefundHolder (0-tax) must touch ONLY holder-bal/supply/reserve")

	// Explicitly: the caller's OWN balance in this exact market is untouched.
	if got := BalanceOf(s, creator, caller); got.Cmp(big.NewInt(50)) != 0 {
		t.Fatalf("caller's own unrelated balance = %s, want untouched 50", got)
	}
	// And the holder really did get paid in full (their balance -> 0).
	if got := BalanceOf(s, creator, target); !mIsZero(got) {
		t.Fatalf("target's balance after full RefundHolder = %s, want 0", got)
	}

	// Sanity: the caller CAN be paid by this function — but only by naming
	// THEMSELVES as the holder argument, never as a side effect of pushing
	// someone else's refund.
	selfPayout, err := RefundHolder(s, caller, creator, caller, pushBlock+1)
	hzMustOK(t, err, "RefundHolder(caller pushes their OWN refund)")
	if selfPayout.Sign() <= 0 {
		t.Fatal("caller self-push paid 0")
	}
	if got := BalanceOf(s, creator, caller); !mIsZero(got) {
		t.Fatalf("caller's own balance after self-push = %s, want 0", got)
	}

	t.Logf("PROVEN: RefundHolder touched exactly %v; caller's unrelated 5000 stayed untouched until they pushed their OWN name.", changed)
}

// ===========================================================================
// TestHarness_ReRegistration_AfterClosed
//
// SPEC §1.7.5: "a creator returning later re-registers and starts fresh."
// Two required sub-tests plus one documented defect this harness found
// while proving them:
//
//  1. SupplyReserveBalancesStartFresh — PASSES. Confirms supply/reserve/
//     balances/escrow genuinely start at zero. This is not because Register
//     resets them (it does not touch kSupply/kReserve at all — see
//     market.go's own comment on Register); it holds because CloseIfDrained
//     already required supply==0 to fire, and refund.go's solvency proof
//     (reserve <= supply always, exact peg reproduces itself) guarantees
//     reserve==0 followed in lockstep. See OldEscrowIsInertNotReplayable for
//     the escrow-sequence continuation, which is cosmetic, not a fund leak.
//
//  2. DEFECT_TwapObservationsLeakAcrossReregistration — PASSES, but as a
//     documented characterization of a real bug (per instructions: found,
//     not fixed, here). See the comment on that subtest for file:line,
//     the exact sequence, and the money impact.
//
// ===========================================================================
func TestHarness_ReRegistration_AfterClosed(t *testing.T) {
	s := NewMemStore()
	const creator = "rebornmkt1"
	const oldHolder = "oldholder1"

	regBlock := uint64(5_000_000)
	hzMustOK(t, Register(s, creator, creator, regBlock, 1000, 1_000_000), "Register (old life)")
	paidUntil := regBlock + SubscriptionPeriod
	frozenStart := paidUntil + GraceBlocks

	hzBuy(t, s, oldHolder, creator, regBlock+10, 1000)

	// Old-life price history, deliberately placed to END just before
	// FROZEN — the realistic case: a market stays actively asked right up
	// until the subscription lapses.
	// RULING C re-shape: 12 markers spaced LongObsSpacing apart (both rings
	// must price — see the lifecycle test), and the marker moved 7777 ->
	// 1900: at S=1000 the C5 tripwire needs rate >= ceil(Area(1000)/1000)/4
	// = 1455 and the C4 min-price guard needs rate <= 2·tokenLeg(1000) = 1760
	// (the commission carve-out, USER RULING 2026-07-27: C4 measures the token
	// leg, and 1000-120 = 880), so the old distinct marker must sit in
	// [1455, 1760] — it was 1900 when C4 still measured the full posted face.
	hzResetObs(s, creator) // see hzResetObs: the funding Buy already fed both rings
	const oldRate = 1700   // an obviously old/distinct marker value
	lastOldObs := frozenStart - 100
	oldObsBlocks := make([]uint64, stObsCount)
	for i := range oldObsBlocks {
		oldObsBlocks[i] = lastOldObs - uint64(stObsCount-1-i)*LongObsSpacing
	}
	for _, ob := range oldObsBlocks {
		RecordObs(s, creator, ob, big.NewInt(oldRate))
	}

	// One ask+answer in old life too, so the escrow-sequence-continuity
	// question below has real data to check against.
	oldAskBlock := lastOldObs + 50 // still OVERDUE: paidUntil < oldAskBlock < frozenStart
	oldRateGot, err := AskRate(s, creator, oldAskBlock)
	hzMustOK(t, err, "AskRate (old life)")
	oldAsk, err := askAt0(s, oldHolder, creator, oldAskBlock, creditsForAsk(big.NewInt(1000), oldRateGot), commissionOwedFor(big.NewInt(1000)), "old-life-ask", MinAskDeadline)
	hzMustOK(t, err, "Ask (old life)")
	if oldAsk.Seq != 0 {
		t.Fatalf("old life's first ask got seq %d, want 0", oldAsk.Seq)
	}
	_, err = Answer(s, creator, creator, oldAskBlock+10, oldAsk.Seq, "old-life-answer")
	hzMustOK(t, err, "Answer (old life)")

	// Wind down to CLOSED: refund oldHolder's remaining balance AND the
	// creator's own answered credit — I3 forces BOTH to zero before
	// CloseIfDrained can fire. EXITTAX-1/NOTICE-1 (2026-07-22): the two
	// permissionless pushes below refuse a still-taxed holder, so the wind-down
	// runs a full ExitTaxDecayBlocks past the freeze — oldHolder (bought
	// regBlock+10) and the creator's own answered credit (earned just before the
	// freeze) are both fully decayed to τ = 0 there. The old-life obs history and
	// asks above still sit near frozenStart (unchanged); only the sweep moves.
	closeBlock := frozenStart + ExitTaxDecayBlocks
	hzAssertPhase(t, s, creator, closeBlock, StateFrozen, "old life, precondition")
	_, err = RefundHolder(s, "hzkeeper", creator, oldHolder, closeBlock)
	hzMustOK(t, err, "wind-down RefundHolder(oldHolder)")
	_, err = RefundHolder(s, "hzkeeper", creator, creator, closeBlock)
	hzMustOK(t, err, "wind-down RefundHolder(creator's own earned credit)")
	if !CloseIfDrained(s, creator, closeBlock) {
		t.Fatal("CloseIfDrained failed to close a fully-drained FROZEN market")
	}
	hzAssertPhase(t, s, creator, closeBlock, StateClosed, "old life, closed")

	oldObsIdx := getU64(s, kObsIdx(creator))
	if oldObsIdx != stObsCount {
		t.Fatalf("sanity: old-life kObsIdx = %d, want %d", oldObsIdx, stObsCount)
	}

	// ---- RE-REGISTER, immediately, with genuinely different config ----
	reRegBlock := closeBlock + 1
	hzMustOK(t, Register(s, creator, creator, reRegBlock, 2000, 500000), "Register (new life)")

	t.Run("SupplyReserveBalancesStartFresh", func(t *testing.T) {
		if got := Supply(s, creator); !mIsZero(got) {
			t.Fatalf("new life supply = %s, want 0", got)
		}
		if got := Reserve(s, creator); !mIsZero(got) {
			t.Fatalf("new life reserve = %s, want 0", got)
		}
		if got := BalanceOf(s, creator, oldHolder); !mIsZero(got) {
			t.Fatalf("old holder's balance leaked into new life: %s", got)
		}
		if got := BalanceOf(s, creator, creator); !mIsZero(got) {
			t.Fatalf("creator's own old earned balance leaked into new life: %s", got)
		}
		if got := hzSumEscrowedCredits(s, creator); !mIsZero(got) {
			t.Fatalf("escrowed credits leaked into new life: %s (I3 guarantees this is structurally impossible at a legitimate CloseIfDrained)", got)
		}
		if got := Face(s, creator); got.Cmp(big.NewInt(2000)) != 0 {
			t.Fatalf("new life face = %s, want the NEW 2000, not stale old 1000", got)
		}
	})

	t.Run("OldEscrowIsInertNotReplayable", func(t *testing.T) {
		// Cosmetic-only, NOT a fund leak: kSeq continues from old life
		// rather than restarting at 0 (neither market.go nor refund.go ever
		// reset it). No collision is possible — Ask's seq is always the
		// NEXT unused index at close, and old resolved records are checked
		// for askPending, so they cannot be replayed.
		if got := EscrowSeq(s, creator); got != 1 {
			t.Fatalf("new-life kSeq starting point = %d, want 1 (continued from old life, not reset to 0)", got)
		}
		_, err := Answer(s, creator, creator, reRegBlock+10, 0, "replay-attempt")
		hzMustErr(t, err, ErrState, "re-Answering old life's resolved seq 0 in new life")
		_, err = Reclaim(s, oldHolder, creator, reRegBlock+10, 0)
		hzMustErr(t, err, ErrState, "Reclaiming old life's resolved seq 0 in new life")
	})

	t.Run("Regression_TwapObservationsDoNotLeakAcrossReregistration", func(t *testing.T) {
		// --------------------------------------------------------------
		// REGRESSION TEST for a HIGH defect this harness originally found
		// and documented, now FIXED in core/market.go Register.
		//
		// The defect: neither Register nor CloseIfDrained cleared the TWAP
		// ring, so a creator who wound down and re-registered ("starts
		// fresh", SPEC §1.7.5) could have their brand-new market's very
		// first ask priced ENTIRELY off the previous incarnation's
		// observations — zero new RecordObs calls needed, as long as
		// re-registration happened within MaxStaleBlocks of the old
		// market's last observation. AskRate returned no error; it
		// returned a confident, fully-validated, stale price. That
		// silently reinstated the manipulation surface twap.go exists to
		// close, and the loser was whichever creator answered that ask.
		//
		// The fix: Register zeroes kObsIdx. AskRate derives its live set
		// from that counter alone, so a fresh market sees no observations
		// and refuses to price until MinObsCount new ones arrive.
		//
		// This test asserts the FIX. If it ever fails again, the leak is
		// back — do not "fix" it by relaxing these assertions.
		// --------------------------------------------------------------
		if got := getU64(s, kObsIdx(creator)); got != 0 {
			t.Fatalf("re-registration must reset the observation counter: kObsIdx = %d, want 0 (old life had %d)", got, oldObsIdx)
		}

		queryBlock := reRegBlock + 50
		if _, err := AskRate(s, creator, queryBlock); err == nil {
			t.Fatalf("AskRate must REFUSE on a freshly re-registered market with no new observations, but it returned a price")
		} else {
			hzMustErr(t, err, ErrOracle, "AskRate immediately after re-registration")
		}

		// THE LONG RING'S HALF OF THE SAME LEAK (RULING C1, 2026-07-21):
		// Register does NOT reset the long ring's write counter (the twl|
		// family postdates Register's reset list), so the old life's long
		// samples are still PHYSICALLY present — assert that premise, then
		// assert the epoch filter (askRateLong drops every sample older
		// than the current kRegisteredAt) refuses to price off them. If
		// this ever fails, a re-registered market's first services would be
		// priced by its DEAD incarnation's rates.
		if got := getU64(s, kObsLongIdx(creator)); got == 0 {
			t.Fatal("test premise broken: expected the old life's long-ring samples to survive re-registration physically (Register must not have learned to clear twl| without this test being updated)")
		}
		if _, err := askRateLong(s, creator, queryBlock); err == nil {
			t.Fatal("askRateLong must REFUSE on a freshly re-registered market whose long ring holds only previous-incarnation samples")
		} else {
			hzMustErr(t, err, ErrOracle, "askRateLong immediately after re-registration")
		}

		// End-to-end: the new market cannot transact on stale prices at
		// all — an ask that tries is refused rather than silently settled.
		hzBuy(t, s, "newholder1", creator, reRegBlock+10, 500)
		hzResetObs(s, creator) // see hzResetObs: the funding Buy fed the ring

		// Once genuinely fresh observations exist, pricing resumes normally
		// and reflects ONLY the new life's data.
		const freshRate = 1234
		for i := uint64(0); i < MinObsCount; i++ {
			RecordObs(s, creator, reRegBlock+20+i*200, big.NewInt(freshRate))
		}
		freshQuery := reRegBlock + 20 + MinObsCount*200 + MinObsBlocks
		rate, err := AskRate(s, creator, freshQuery)
		hzMustOK(t, err, "AskRate after MinObsCount fresh observations")
		if rate.Cmp(big.NewInt(freshRate)) != 0 {
			t.Fatalf("new life's TWAP = %s, want %d from its OWN observations (old marker rate was %d)", rate, freshRate, oldRate)
		}

		// FULL settlement, however, must STILL refuse here (RULING C1): the
		// 200-spaced fresh series lands only ONE sample in the 7-day ring,
		// far below LongMinObsCount — a re-registered market re-earns its
		// service pricing with ~2 days of genuine trading history, exactly
		// like a brand-new one. Refusal gates only new service inflows.
		if _, err := SettlementRate(s, creator, freshQuery); err == nil {
			t.Fatal("SettlementRate must still REFUSE until the new life accumulates a real long-window history")
		} else {
			hzMustErr(t, err, ErrOracle, "SettlementRate before the new life's long window fills")
		}
	})
}

// askAt0 is the pre-offering-catalogue Ask, pinned at offering id 0 — the
// legacy single `face` price (offerings.go, 2026-07-27). Every test written
// before the catalogue existed calls this, which is exactly the point: id 0 is
// specified to be the byte-for-byte old behaviour, so the whole pre-existing
// ask suite passing UNCHANGED through this shim is the evidence for that claim.
// Offering-specific behaviour is tested against nonzero ids in offerings_test.go.
func askAt0(s Store, caller, creator string, block uint64, maxCredits, commissionHbdPaid *big.Int, contentHash string, deadlineBlocks uint64) (*AskResult, error) {
	return Ask(s, caller, creator, block, maxCredits, commissionHbdPaid, contentHash, deadlineBlocks, 0)
}

// exitTaxSplit mirrors accrueExitTax's destination rule (exittax.go, USER
// RULING 2026-07-27) for tests: the exit tax is split 50/50, creator half to
// kFeeBal (the pull-claimable trade-fee rail), platform half to kTreasury —
// EXCEPT when the seller is the creator, where the whole tax goes to treasury
// so a creator cannot refund half their own exit tax to themselves.
//
// creatorHalf = floor(tax/2) and platform takes the REMAINDER, so the two
// always re-sum to tax exactly. Tests assert both halves AND the sum: the
// property that matters is not where the tax lands but that every assessed
// unit lands SOMEWHERE — a split that lost a base unit to rounding would be a
// leak, which is precisely what the pre-split "all to treasury" assertions
// were protecting.
func exitTaxSplit(creator, seller string, tax *big.Int) (creatorHalf, platformHalf *big.Int) {
	if tax == nil || tax.Sign() <= 0 {
		return mZero(), mZero()
	}
	if seller == creator {
		return mZero(), new(big.Int).Set(tax)
	}
	creatorHalf = new(big.Int).Div(tax, big.NewInt(2))
	platformHalf = new(big.Int).Sub(tax, creatorHalf)
	return creatorHalf, platformHalf
}
