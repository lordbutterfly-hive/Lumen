package core

import (
	"math/big"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// Test harness. errSymbol is already declared package-wide in prepay_test.go;
// reused here rather than redeclared (this package's test files are compiled
// together — ask_test.go's own askErrSymbol exists specifically because it
// needed a second, non-colliding copy at one point, a lesson taken here by
// simply not declaring a second one).
//
// mustRegister drives Register itself (not raw state pokes) to set up a
// market for the Renew/SetFace/SetCap tests below, since those tests are
// about how this file's OWN functions interact with each other over time,
// not isolated unit behaviour against synthetic state (which the Phase()
// table test further down uses instead, deliberately, to pin exact boundary
// arithmetic independent of Register's own defaults).
// ---------------------------------------------------------------------------

func mustRegister(t *testing.T, s Store, creator string, block uint64, face, cap int64) {
	t.Helper()
	if err := Register(s, creator, creator, block, face, cap); err != nil {
		t.Fatalf("Register(%s) at block %d: %v", creator, block, err)
	}
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

func TestRegister_HappyPath(t *testing.T) {
	s := NewMemStore()
	const block = uint64(100000)
	if err := Register(s, "goodcreator", "goodcreator", block, 1000, 5000); err != nil {
		t.Fatalf("Register: %v", err)
	}

	if got := getStr(s, kState("goodcreator")); got != StateActive {
		t.Fatalf("state = %q, want %q", got, StateActive)
	}
	if got := getU64(s, kRegisteredAt("goodcreator")); got != block {
		t.Fatalf("registeredAt = %d, want %d", got, block)
	}
	// (There is no paidUntil assertion here any more: registration writes no
	// subscription clock since 2026-09-12 — core/keys.go's "THERE IS NO
	// kPaidUntil". The phase assertion below is what registration now promises.)
	if got := Phase(s, "goodcreator", block+100*BlocksPerDay); got != StateActive {
		t.Fatalf("phase long after registration = %s, want ACTIVE (registration is one-time)", got)
	}
	if got := getMoney(s, kFace("goodcreator")); got.Cmp(big.NewInt(1000)) != 0 {
		t.Fatalf("face = %s, want 1000 (kFace must be money-typed)", got)
	}
	if got := getU64(s, kFaceSetAt("goodcreator")); got != block {
		t.Fatalf("faceSetAt = %d, want %d (registration starts the anti-rug clock)", got, block)
	}
	if got := getMoney(s, kCap("goodcreator")); got.Cmp(big.NewInt(5000)) != 0 {
		t.Fatalf("cap = %s, want 5000 (kCap must be money-typed, matching prepay.go's getMoney read)", got)
	}
	// UPDATED 2026-07-21 (ruled behaviour changed): this used to assert the
	// 10 HBD RegistrationFee was booked to the treasury. LOCKED-MECHANISM
	// "Revenue" (USER-RULED) makes registration FREE, so the assertion is
	// INVERTED rather than deleted — a fee quietly reappearing would be a
	// revenue grab from every creator, and this is the line that catches it.
	if got := getMoney(s, kTreasury()); !mIsZero(got) {
		t.Fatalf("treasury = %s, want 0 — REGISTRATION IS FREE (LOCKED-MECHANISM Revenue); nothing may be charged at Register", got)
	}
	if got := Phase(s, "goodcreator", block); got != StateActive {
		t.Fatalf("Phase = %q, want ACTIVE", got)
	}
}

// TestRegister_IsFreeAndMovesNoMoney replaces the deleted
// TestRegister_OverpaidFeeBooksFullAmount and
// TestRegister_FeeInsufficientRejected. Registration is FREE (LOCKED-
// MECHANISM "Revenue", USER-RULED 2026-07-21): there is no fee parameter to
// under- or over-pay, and Register must move NO money at all — not to the
// treasury, not to the reserve.
func TestRegister_IsFreeAndMovesNoMoney(t *testing.T) {
	s := NewMemStore()
	if err := Register(s, "freecreator", "freecreator", 100, 1000, 1000); err != nil {
		t.Fatalf("Register with no fee must succeed: %v", err)
	}
	if got := getMoney(s, kTreasury()); !mIsZero(got) {
		t.Fatalf("treasury = %s, want 0 (registration charges nothing)", got)
	}
	if got := getMoney(s, kReserve("freecreator")); !mIsZero(got) {
		t.Fatalf("reserve = %s, want 0 (Register never writes a reserve)", got)
	}
	if got := getMoney(s, kSupply("freecreator")); !mIsZero(got) {
		t.Fatalf("supply = %s, want 0 (no premine — LOCKED-MECHANISM Launch)", got)
	}
	if got := Phase(s, "freecreator", 100); got != StateActive {
		t.Fatalf("phase = %s, want ACTIVE", got)
	}
}

func TestRegister_CallerMustEqualCreator(t *testing.T) {
	s := NewMemStore()
	err := Register(s, "impersonator", "victim", 100, 1000, 1000)
	if err == nil {
		t.Fatal("expected rejection: caller != creator")
	}
	if sym := errSymbol(err); sym != ErrAuth {
		t.Fatalf("want ErrAuth, got %v", err)
	}
	if getStr(s, kState("victim")) != "" {
		t.Fatal("victim's market must not have been created by an impersonated call")
	}
}

func TestRegister_DuplicateRejected(t *testing.T) {
	s := NewMemStore()
	mustRegister(t, s, "dupcreator", 100, 1000, 1000)
	err := Register(s, "dupcreator", "dupcreator", 200, 2000, 2000)
	if err == nil {
		t.Fatal("expected rejection: already registered")
	}
	if sym := errSymbol(err); sym != ErrState {
		t.Fatalf("want ErrState, got %v", err)
	}
	// the second, rejected call must not have perturbed the live market.
	if got := getMoney(s, kFace("dupcreator")); got.Cmp(big.NewInt(1000)) != 0 {
		t.Fatalf("face mutated by a rejected duplicate registration: %s", got)
	}
}

func TestRegister_FaceOutOfRange(t *testing.T) {
	s := NewMemStore()
	cases := []struct {
		name string
		face int64
	}{
		{"below MinFace", MinFace - 1},
		{"above MaxFace", MaxFace + 1},
		{"zero", 0},
		{"negative", -1},
	}
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			creator := "facecreator" + string(rune('a'+i))
			err := Register(s, creator, creator, 100, c.face, 1000)
			if err == nil {
				t.Fatalf("face=%d: expected rejection", c.face)
			}
			if sym := errSymbol(err); sym != ErrInput {
				t.Fatalf("want ErrInput, got %v", err)
			}
			if getStr(s, kState(creator)) != "" {
				t.Fatal("rejected registration must not create a market")
			}
		})
	}
	// boundary values MUST succeed (inclusive range).
	if err := Register(s, "faceboundlo", "faceboundlo", 100, MinFace, 1000); err != nil {
		t.Fatalf("face == MinFace should succeed: %v", err)
	}
	if err := Register(s, "faceboundhi", "faceboundhi", 100, MaxFace, 1000); err != nil {
		t.Fatalf("face == MaxFace should succeed: %v", err)
	}
}

func TestRegister_CapOutOfRange(t *testing.T) {
	s := NewMemStore()
	cases := []struct {
		name string
		cap  int64
	}{
		{"below MinCap", MinCap - 1},
		{"above MaxCap", MaxCap + 1},
		{"zero", 0},
		{"negative", -1},
	}
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			creator := "capcreator" + string(rune('a'+i))
			err := Register(s, creator, creator, 100, 1000, c.cap)
			if err == nil {
				t.Fatalf("cap=%d: expected rejection", c.cap)
			}
			if sym := errSymbol(err); sym != ErrInput {
				t.Fatalf("want ErrInput, got %v", err)
			}
		})
	}
	if err := Register(s, "capboundlo", "capboundlo", 100, 1000, MinCap); err != nil {
		t.Fatalf("cap == MinCap should succeed: %v", err)
	}
	if err := Register(s, "capboundhi", "capboundhi", 100, 1000, MaxCap); err != nil {
		t.Fatalf("cap == MaxCap should succeed: %v", err)
	}
}

// DELETED 2026-07-21: TestRegister_FeeInsufficientRejected. It asserted that
// Register rejects feePaid < RegistrationFee with ErrBalance — behaviour that
// a binding ruling reversed (LOCKED-MECHANISM "Revenue": registration is
// FREE). There is no fee parameter left to be insufficient. The property it
// protected — "nothing is booked to the treasury by a registration" — did not
// disappear with it: it is asserted in TestRegister_HappyPath and in
// TestRegister_IsFreeAndMovesNoMoney above, now as "always zero" rather than
// "zero only when rejected".

func TestRegister_InvalidCreatorAccountRejected(t *testing.T) {
	s := NewMemStore()
	// NOTE: shapes like "ab", "BADCASE" and "has space" are ACCEPTED now, and
	// deliberately so — the chain hands contracts DID-shaped callers such as
	// "hive:blocktrades", so a bare-Hive-name rule rejected every real user.
	// The rule that remains is the one that is a security control: nothing may
	// contain the state-key delimiter. See TestValidAccount_AcceptsRealChainCallerShapes.
	// The over-length case is derived from MaxAccountLen rather than hardcoded:
	// it was a literal 96-x string, which stopped rejecting the moment the bound
	// was raised to fit a taproot-length BTC DID (util.go's own derivation). A
	// fixture pinned to the OLD value of the constant it is testing silently
	// stops testing anything.
	cases := []string{"", "a|b", "hive:al|ice", strings.Repeat("x", MaxAccountLen+1)}
	for _, creator := range cases {
		err := Register(s, creator, creator, 100, 1000, 1000)
		if err == nil {
			t.Fatalf("creator=%q: expected rejection", creator)
		}
		if sym := errSymbol(err); sym != ErrInput {
			t.Fatalf("creator=%q: want ErrInput, got %v", creator, err)
		}
	}
}

func TestRegister_GloballyPausedRejected(t *testing.T) {
	s := NewMemStore()
	setStr(s, kPaused(), "1")
	err := Register(s, "pausedcreator", "pausedcreator", 100, 1000, 1000)
	if err == nil {
		t.Fatal("expected rejection while globally paused")
	}
	if sym := errSymbol(err); sym != ErrPaused {
		t.Fatalf("want ErrPaused, got %v", err)
	}
	if getStr(s, kState("pausedcreator")) != "" {
		t.Fatal("paused registration must not have created a market")
	}
}

// TestRegister_ReRegisterAfterClosedSucceeds proves SPEC §1.7.5: "a creator
// returning later re-registers and starts fresh." A CLOSED market has
// supply==0 by CloseIfDrained's own contract (refund.go); this test starts
// from that guaranteed post-wind-down shape.
func TestRegister_ReRegisterAfterClosedSucceeds(t *testing.T) {
	s := NewMemStore()
	mustRegister(t, s, "returningcreator", 100, 1000, 1000)
	// Simulate a completed wind-down: refund.go's CloseIfDrained is the only
	// function that ever writes StateClosed, and only once kSupply == 0. That
	// is already true here (nothing minted any credits), so the direct write
	// below is a faithful stand-in for calling CloseIfDrained itself.
	setStr(s, kState("returningcreator"), StateClosed)

	if err := Register(s, "returningcreator", "returningcreator", 500000, 2000, 3000); err != nil {
		t.Fatalf("re-registration after CLOSED should succeed: %v", err)
	}
	if got := getStr(s, kState("returningcreator")); got != StateActive {
		t.Fatalf("state = %q, want ACTIVE after re-registration", got)
	}
	if got := getU64(s, kRegisteredAt("returningcreator")); got != 500000 {
		t.Fatalf("registeredAt = %d, want 500000 (the fresh registration block)", got)
	}
	if got := getMoney(s, kFace("returningcreator")); got.Cmp(big.NewInt(2000)) != 0 {
		t.Fatalf("face = %s, want the NEW face 2000, not the old 1000", got)
	}
	if got := getU64(s, kFaceSetAt("returningcreator")); got != 500000 {
		t.Fatalf("faceSetAt = %d, want the fresh registration block (anti-rug clock must restart, not carry the old market's history)", got)
	}
	// Fresh state must not be haunted by the OLD (closed) market's face: the
	// old face was 1000, whose own band would have been [500, 2000]. The new
	// face is 2000, whose band is [1000, 4000]. 3000 sits inside the NEW
	// band but outside the OLD one — accepting it here proves SetFace (called
	// at the very same re-registration block, so the band is definitely
	// active) is comparing against the freshly-registered face, not a stale
	// value left over from the closed market.
	if err := SetFace(s, "returningcreator", "returningcreator", 500000, 3000); err != nil {
		t.Fatalf("SetFace incorrectly banded against the OLD closed market's face, not the fresh one: %v", err)
	}
}

// TestRegister_ReRegisterAfterAbandonedEscrowResolvedByThirdParty is H1's
// full end-to-end regression proof: "escrow time-bomb" (a PENDING ask that
// nobody ever resolves) used to brick a creator's market FOREVER, because
// Reclaim was asker-only and Ask debits kBal but never kSupply — supply
// stayed > 0 with no legal path to zero it, CloseIfDrained requires
// supply==0, and Register's own duplicate-registration guard refuses a
// market that is not CLOSED. This drives the REAL sequence: register,
// prepay, open an ask, let BOTH the answer window and the asker abandon it
// (nobody ever calls Answer or Reclaim themselves), then prove a totally
// unrelated third party — not the asker, not the creator — can push the
// reclaim once the window opens, draining supply to zero and unblocking
// the entire rest of the lifecycle: CloseIfDrained fires, and the creator
// re-registers successfully.
func TestRegister_ReRegisterAfterAbandonedEscrowResolvedByThirdParty(t *testing.T) {
	s := NewMemStore()
	const creator = "abandonedmkt"
	const asker = "vanishingasker"
	const rescuer = "totallyunrelatedstranger"
	regBlock := uint64(1000)

	// Face 10,000 (was 1000) and a real settlement fixture (RULING C: the
	// PAR fallback is deleted, so the ask below needs a priced market): at
	// S=5000 the curve's average price is ~42,501, so the marker rate must
	// sit in [ceil(avg)/4, 2·face] — 15,000 does; the ask then spends
	// ceil(10,000/15,000) = 1 credit, which is exactly the escrow pin this
	// test is about.
	mustRegister(t, s, creator, regBlock, 10_000, MaxCap)
	// RULING A: Buy on the curve is the only issuance path (the PAR mint is
	// deleted).
	if _, err := Buy(s, asker, creator, regBlock+1, big.NewInt(5000)); err != nil {
		t.Fatalf("Buy: %v", err)
	}

	// Two-ring observation history (the funding Buy's own curve-fed
	// observation is cleared first so the constant marker series owns both
	// windows — resetObsRings/seedSettleObs, ask_test.go).
	askBlock := seedSettleObs(s, creator, regBlock+10, big.NewInt(15_000))
	askRes, err := askAt0(s, asker, creator, askBlock, big.NewInt(1), "abandoned-ask", MinAskDeadline)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if askRes.CreditsSpent.Cmp(big.NewInt(1)) != 0 {
		t.Fatalf("sanity: CreditsSpent = %s, want 1 (ceil(10000/15000))", askRes.CreditsSpent)
	}

	// The market has now lapsed all the way to FROZEN, and the asker has
	// simply vanished — never answered (they're not the creator anyway),
	// never reclaimed. This is exactly the "escrow time-bomb": supply stays
	// pinned at 5000 forever under the OLD asker-only rule, since nobody but
	// the vanished asker could ever legally call Reclaim.
	//
	// EXITTAX-1/NOTICE-1 (2026-07-22): the final RefundHolder push below refuses a
	// still-taxed holder, so the whole wind-down runs a full ExitTaxDecayBlocks
	// past the freeze — the asker's reclaimed credit carries its pre-escrow clock
	// (near regBlock+10, ET-2), which is fully decayed to τ = 0 there. The market
	// is FROZEN and the reclaim window long-open at every block from here on.
	// A1 (2026-08-30): the wind-down (and its Refund rail) opens on Retire, not
	// on a lapse — and since 2026-09-12 there is no lapse at all, so the retire
	// must come a full notice BEFORE the block this fixture needs FROZEN. The
	// escrow time-bomb under test is unchanged by which road opened the wind-down.
	frozenBlock := regBlock + hzLongGap + GraceBlocks + 10 + ExitTaxDecayBlocks
	if err := Retire(s, creator, creator, frozenBlock-GraceBlocks-1); err != nil {
		t.Fatalf("fixture: Retire: %v", err)
	}
	if got := Phase(s, creator, frozenBlock); got != StateFrozen {
		t.Fatalf("sanity: phase = %s, want FROZEN", got)
	}
	if got := Supply(s, creator); got.Cmp(big.NewInt(5000)) != 0 {
		t.Fatalf("sanity: supply = %s, want 5000 (still pinned by the PENDING escrow)", got)
	}

	// Refund the OTHER, non-escrowed 4,999 credits first, exactly as a real
	// wind-down would (self-pull here; irrelevant to the point, just
	// clearing the non-escrow supply so the escrow is the ONLY thing left).
	if _, err := Refund(s, asker, creator, frozenBlock, big.NewInt(4999)); err != nil {
		t.Fatalf("Refund: %v", err)
	}
	if got := Supply(s, creator); got.Cmp(big.NewInt(1)) != 0 {
		t.Fatalf("supply after refunding the non-escrowed balance = %s, want 1 (only the escrow remains)", got)
	}

	// Wind-down cannot complete: the escrow is still open, and the asker is
	// gone. Before H1's fix, this is where the market would be stuck
	// FOREVER — CloseIfDrained refuses (supply != 0), and nobody but the
	// vanished asker could ever call Reclaim.
	if CloseIfDrained(s, creator, frozenBlock) {
		t.Fatal("test setup bug: CloseIfDrained fired with the escrow still outstanding")
	}

	// THE FIX: once the reclaim window opens, a totally unrelated third
	// party pushes the reclaim. The ask's own deadline+grace window
	// (askBlock+MinAskDeadline+ReclaimGrace) opens well before frozenBlock
	// (subscription lapse+grace is ~35 days; the ask's own deadline is
	// capped at 30 — see MinAskDeadline/MaxAskDeadline, params.go), so
	// frozenBlock is comfortably past BOTH windows and lets the rest of
	// this test (the final RefundHolder push, gated to FROZEN/CLOSED by H3)
	// run at a single, consistent block.
	if frozenBlock <= askBlock+MinAskDeadline+ReclaimGrace {
		t.Fatalf("test setup bug: frozenBlock (%d) must be past the ask's own reclaim window (%d)", frozenBlock, askBlock+MinAskDeadline+ReclaimGrace)
	}
	reclaimBlock := frozenBlock
	res, err := Reclaim(s, rescuer, creator, reclaimBlock, askRes.Seq)
	if err != nil {
		t.Fatalf("H1 REGRESSION: a third party could not push the abandoned reclaim: %v", err)
	}
	if res.Asker != asker {
		t.Fatalf("ReclaimResult.Asker = %q, want %q — the ORIGINAL asker, not the rescuer", res.Asker, asker)
	}
	// The money went to the asker, not the rescuer.
	if got := getMoney(s, kBal(creator, asker)); got.Cmp(big.NewInt(1)) != 0 {
		t.Fatalf("asker balance after third-party reclaim = %s, want 1", got)
	}
	if got := getMoney(s, kBal(creator, rescuer)); got.Sign() != 0 {
		t.Fatalf("rescuer balance = %s, want 0 (the caller is never paid)", got)
	}

	// Supply is still 1 (the reclaimed credit are back in the asker's
	// OWN balance, not burned) — the asker (or anyone pushing on their
	// behalf) must still actually refund them to reach zero. This is the
	// REST of a normal wind-down, now unblocked.
	if got := Supply(s, creator); got.Cmp(big.NewInt(1)) != 0 {
		t.Fatalf("supply after reclaim = %s, want 1 (reclaimed, not yet refunded)", got)
	}
	if _, err := RefundHolder(s, rescuer, creator, asker, reclaimBlock); err != nil {
		t.Fatalf("final RefundHolder: %v", err)
	}
	if got := Supply(s, creator); !mIsZero(got) {
		t.Fatalf("supply after final refund = %s, want exactly 0", got)
	}

	// The market can NOW close, and the creator can re-register their own
	// identity-bound market — both were structurally impossible before H1's
	// fix, for as long as the asker chose to stay vanished.
	if !CloseIfDrained(s, creator, reclaimBlock) {
		t.Fatal("H1 REGRESSION: CloseIfDrained still refuses even though supply is fully drained")
	}
	if got := Phase(s, creator, reclaimBlock); got != StateClosed {
		t.Fatalf("phase = %s, want CLOSED", got)
	}
	if err := Register(s, creator, creator, reclaimBlock+1, 1500, MaxCap); err != nil {
		t.Fatalf("H1 REGRESSION: creator could not re-register their own market after the abandoned escrow was resolved: %v", err)
	}
	if got := Phase(s, creator, reclaimBlock+1); got != StateActive {
		t.Fatalf("phase after re-registration = %s, want ACTIVE", got)
	}
}

func TestRegister_StillRejectedWhileActive_EvenIfLapsedIntoOverdueOrFrozen(t *testing.T) {
	// Register does NOT allow re-registration just because a market has
	// lazily lapsed into OVERDUE/FROZEN — only an explicit stored CLOSED
	// permits it (Phase's "only stored state that wins" contract). OVERDUE
	// and FROZEN never touch kState, so the raw stored value stays ACTIVE.
	// (The markets below no longer LAPSE at all since 2026-09-12 — they are
	// simply ACTIVE at every one of these blocks, which makes the refusal even
	// more obviously correct. The loop is kept, at the same block offsets, so the
	// re-registration guard is still exercised at the heights it always was.)
	for _, lapse := range []uint64{1, GraceBlocks, GraceBlocks + 1000} {
		s := NewMemStore()
		mustRegister(t, s, "lapsedcreator", 100, 1000, 1000)
		block := 100 + 30*BlocksPerDay + lapse
		err := Register(s, "lapsedcreator", "lapsedcreator", block, 2000, 2000)
		if err == nil {
			t.Fatalf("lapse=%d: re-registration over a live (if lapsed) market must be rejected", lapse)
		}
		if sym := errSymbol(err); sym != ErrState {
			t.Fatalf("lapse=%d: want ErrState, got %v", lapse, err)
		}
	}
}

// TestRegisterNeverTouchesReserveOrSupply is a light I4/I1 friendliness check
// from this file's own side: kReserve/kSupply are exclusively Buy/Sell/Refund's
// business. Register must never write either key, in any state, including on
// re-registration. (It was "Register AND Renew" until 2026-09-12; Renew is
// gone with the subscription — core/params.go.)
func TestRegisterNeverTouchesReserveOrSupply(t *testing.T) {
	s := NewMemStore()
	mustRegister(t, s, "moneyhandsoff", 100, 1000, 1000)
	if got := getMoney(s, kReserve("moneyhandsoff")); !mIsZero(got) {
		t.Fatalf("kReserve touched by Register: %s (I4 violation)", got)
	}
	if got := getMoney(s, kSupply("moneyhandsoff")); !mIsZero(got) {
		t.Fatalf("kSupply touched by Register: %s", got)
	}
}

// ---------------------------------------------------------------------------
// THE RENEW SUITE IS DELETED (OWNER RULING 2026-09-12)
// ---------------------------------------------------------------------------
//
// Fourteen tests lived here and pinned core.Renew: the happy path from ACTIVE,
// permissionless payment ("a fan can keep a creator alive"), resuming from
// max(now, paidUntil) after a lapse, admission while FROZEN (A1) and refusal
// while RETIRED or CLOSED, the no-such-market / empty-caller / periods-range /
// underpayment rejections, the MaxPrepaidPeriods reach cap, and the treasury
// booking the full paid amount.
//
// The 10 HBD monthly subscription was removed whole — core/params.go's "THERE
// IS NO SubscriptionFee" carries the reasoning — so core.Renew, SubscriptionFee,
// SubscriptionPeriod, MaxPrepaidPeriods and kPaidUntil are all gone and there is
// nothing left for any of those fourteen to call.
//
// ★ WHAT THEY WERE REALLY PROTECTING, AND WHERE IT LIVES NOW. Only one of the
// fourteen guarded a property that outlives the fee: M2's anti-griefing rule,
// that a hostile stranger's prepayment must never be able to block a creator's
// own wind-down. Renew was the griefing lever, so removing it removes the
// attack — but the OVERRIDE that answered it, Retire, is still here and still
// tested, immediately below (TEST A, rewritten for a market nobody can prepay).
// The lapse ladder those tests drove is covered by a1_lapse_test.go, which is
// now its own inverse.

// TEST A — M2's OVERRIDE must still hold, with its attack retired.
//
// The original case was: a hostile stranger renews the victim's market
// MaxPrepaidPeriods into the future (Renew was permissionless), so the market
// can never lapse and the creator can never reach the CLOSED state a
// re-registration needs. Retire was the creator's override — it drives the
// market OVERDUE immediately and FROZEN at retiredAt+GraceBlocks whatever
// paidUntil says, because Phase takes the MAX of the two ladders.
//
// ★ THE ATTACK IS GONE, THE OVERRIDE IS NOT (OWNER RULING 2026-09-12). With no
// subscription there is no Renew to grief with and no paidUntil to push — every
// market is permanently ACTIVE, which is the griefer's goal reached for free and
// harmlessly. What still has to hold, and is what this test now pins, is that
// Retire overrides a market that is ACTIVE and would otherwise stay ACTIVE
// forever: OVERDUE on the mark, FROZEN at the mark plus the notice, never ACTIVE
// again. That is the same assertion with the same mechanism; only the reason the
// market was ACTIVE changed.
func TestRetire_A_OverridesAPermanentlyActiveMarketReachesFrozenNotActive(t *testing.T) {
	s := NewMemStore()
	const creator = "griefedcreator"
	regBlock := uint64(1000)
	mustRegister(t, s, creator, regBlock, 1000, 1000)

	hostileBlock := regBlock + 1
	if got := Phase(s, creator, hostileBlock+100*BlocksPerDay); got != StateActive {
		t.Fatalf("sanity: a market with nothing paid is ACTIVE forever, got %s", got)
	}
	// Confirm the market really is ACTIVE deep into what should have been its
	// own natural lapse window, purely because of the stranger's renewal.
	naturalLapseBlock := regBlock + hzLongGap + 10
	if got := Phase(s, creator, naturalLapseBlock); got != StateActive {
		t.Fatalf("sanity: phase at the natural lapse point = %s, want ACTIVE (griefed by the hostile renewal)", got)
	}

	// THE FIX: the creator retires their own market.
	retireBlock := naturalLapseBlock
	if err := Retire(s, creator, creator, retireBlock); err != nil {
		t.Fatalf("Retire: %v", err)
	}

	// The five-day NOTICE (RULING D): OVERDUE on the retire block and for
	// GraceBlocks after it — never ACTIVE, even though paidUntil is still
	// MaxPrepaidPeriods into the future. OVERDUE is fully functional, which
	// is the point: holders exit on the curve rail during these five days.
	if got := Phase(s, creator, retireBlock); got != StateOverdue {
		t.Fatalf("phase on the retire block = %s, want OVERDUE (the notice; and never ACTIVE on a far-future paidUntil)", got)
	}
	if got := Phase(s, creator, retireBlock+1); got != StateOverdue {
		t.Fatalf("phase one block after Retire = %s, want OVERDUE (inside the notice)", got)
	}
	if got := Phase(s, creator, retireBlock+GraceBlocks-1); got != StateOverdue {
		t.Fatalf("phase on the LAST notice block = %s, want OVERDUE", got)
	}
	// FROZEN begins AT retiredAt+GraceBlocks — the same boundary convention
	// the natural lapse ladder uses.
	if got := Phase(s, creator, retireBlock+GraceBlocks); got != StateFrozen {
		t.Fatalf("phase AT retiredAt+GraceBlocks = %s, want FROZEN", got)
	}
	// And still FROZEN arbitrarily far out — a market that would otherwise be
	// ACTIVE forever must never climb back.
	farFuture := retireBlock + 365*BlocksPerDay
	if got := Phase(s, creator, farFuture-1); got != StateFrozen {
		t.Fatalf("phase a year after the retire = %s, want FROZEN (the retire mark is terminal)", got)
	}
	// The load-bearing negative: ACTIVE is unreachable at every block from
	// the retire onward, which is what "retire may only make a market MORE
	// frozen" means operationally.
	for _, b := range []uint64{retireBlock, retireBlock + 1, retireBlock + GraceBlocks - 1,
		retireBlock + GraceBlocks, farFuture - 1, farFuture, farFuture + 1} {
		if got := Phase(s, creator, b); got == StateActive {
			t.Fatalf("phase at block %d = ACTIVE after Retire — retire must never make a market LESS frozen", b)
		}
	}

	// Retire moves no funds.
	if got := getMoney(s, kTreasury()); got.Sign() != 0 {
		t.Fatalf("treasury changed by Retire itself: %s", got)
	}
}

// TEST B — RETIRE IS MONOTONE: it may only ever make a market MORE frozen.
//
// ★ WHAT THIS TEST USED TO BE. Retire's first implementation expressed the
// freeze as `paidUntil = block`, which for a market that had ALREADY lapsed
// RAISED paidUntil and flipped it straight back to ACTIVE — a creator could
// retire to reset the clock and keep trading for free. RULING D replaced the
// poke with a MAX over two independent ladders (the subscription's and the
// retire mark's), and this test drove a market down the SUBSCRIPTION ladder to
// OVERDUE and to FROZEN and then retired it from each rung, plus a third
// sub-case proving a retired market could not be renewed back to life.
//
// THERE IS ONLY ONE LADDER NOW (OWNER RULING 2026-09-12). With the subscription
// removed, naturalPhase is constant ACTIVE, so "retire from OVERDUE" and
// "retire from FROZEN" are unconstructible states and the renew-dodge has no
// Renew to perform it. What survives, and is what the MAX was really for, is the
// monotonicity itself: from the only reachable starting rung, Retire moves the
// market DOWN and it never comes back. That is asserted here and, across an
// exhaustive block sweep, in TestPhase_RetireIsMonotone_NeverLessFrozen below.
func TestRetire_B_FromActiveGoesOverdueThenFrozenAndNeverBack(t *testing.T) {
	s := NewMemStore()
	const creator = "retirefromactive"
	regBlock := uint64(100)
	mustRegister(t, s, creator, regBlock, 1000, 1000)

	// The only reachable starting rung, at an arbitrary height — a market with
	// nothing paid is ACTIVE at every block until someone retires it.
	retireBlock := regBlock + 30*BlocksPerDay + 10
	if got := Phase(s, creator, retireBlock); got != StateActive {
		t.Fatalf("sanity: phase = %s, want ACTIVE (nothing lapses any more)", got)
	}
	if err := Retire(s, creator, creator, retireBlock); err != nil {
		t.Fatalf("Retire: %v", err)
	}

	if got := Phase(s, creator, retireBlock); got != StateOverdue {
		t.Fatalf("phase on the retire block = %s, want OVERDUE (the notice)", got)
	}
	if got := Phase(s, creator, retireBlock+GraceBlocks-1); got != StateOverdue {
		t.Fatalf("phase on the LAST notice block = %s, want OVERDUE", got)
	}
	if got := Phase(s, creator, retireBlock+GraceBlocks); got != StateFrozen {
		t.Fatalf("phase AT retiredAt+GraceBlocks = %s, want FROZEN", got)
	}
	// NEVER ACTIVE again, at any height — the property the MAX exists to give.
	for _, b := range []uint64{retireBlock, retireBlock + 1, retireBlock + GraceBlocks - 1,
		retireBlock + GraceBlocks, retireBlock + 365*BlocksPerDay} {
		if got := Phase(s, creator, b); got == StateActive {
			t.Fatalf("phase at block %d = ACTIVE after Retire — retire must never make a market LESS frozen", b)
		}
	}
	// Retiring twice is refused, so the notice cannot be restarted to buy more
	// OVERDUE time (the shape the old dodge-loop sub-case was really guarding).
	if err := Retire(s, creator, creator, retireBlock+1); err == nil {
		t.Fatal("a second Retire must be refused — the notice cannot be restarted")
	}
}


//	refused — no free perpetual service — and the wind-down is terminal.
func TestRetire_C_RevenueBypassClosed(t *testing.T) {
	s := NewMemStore()
	const creator = "retirebypass"
	regBlock := uint64(1000)
	mustRegister(t, s, creator, regBlock, 1000, 1000)
	// Buy some supply BEFORE retiring so the market has holders to wind down —
	// and so the "inflows closed during the notice" assertions below are about
	// a live market, not an empty one.
	if _, err := Buy(s, "earlyfan", creator, regBlock+1, big.NewInt(200)); err != nil {
		t.Fatalf("pre-retire Buy: %v", err)
	}
	// Retire while still comfortably ACTIVE (paidUntil far ahead), to prove
	// the natural ladder does not matter — the mark alone drives it down.
	retireBlock := regBlock + 10
	if err := Retire(s, creator, creator, retireBlock); err != nil {
		t.Fatalf("Retire: %v", err)
	}

	// ---- during the notice ----
	inNotice := retireBlock + 1
	if got := Phase(s, creator, inNotice); got != StateOverdue {
		t.Fatalf("phase inside the notice = %s, want OVERDUE (Phase still ladders through the notice)", got)
	}
	// RULING K3: a retired market is winding down for BOTH rails — inflows are
	// refused even though Phase() is OVERDUE.
	if !inWindDown(s, creator, inNotice) {
		t.Fatal("inWindDown = false inside the retire notice — the curve rail should be dropped (K3)")
	}
	if err := RequireInflowOpen(s, creator, inNotice); err == nil || errSymbol(err) != ErrState {
		t.Fatalf("RequireInflowOpen inside the notice: err=%v, want ErrState (K3 closes inflows the instant a market retires)", err)
	}
	if _, err := Buy(s, "buyer", creator, inNotice, big.NewInt(500)); err == nil || errSymbol(err) != ErrState {
		t.Fatalf("Buy inside the notice: err=%v, want ErrState (K3 drops the curve rail; exits route through Refund)", err)
	}
	// (Three Renew refusals used to sit here — the creator's, a fan's, and the
	// treasury-books-nothing check — proving a retired market could never be
	// bought back to life. Renew was deleted with the subscription on 2026-09-12;
	// there is no payment that can lift a retire mark because there is no payment
	// at all. The Buy and RequireInflowOpen refusals above are what close that
	// door now.)
	// And the exit rail IS open during the notice: earlyfan can Refund now.
	if _, err := Refund(s, "earlyfan", creator, inNotice, big.NewInt(100)); err != nil {
		t.Fatalf("Refund inside the notice: %v — the flat pro-rata exit must be open while a retired market winds down (K3)", err)
	}

	// ---- after the notice expires ----
	probe := retireBlock + GraceBlocks
	if got := Phase(s, creator, probe); got != StateFrozen {
		t.Fatalf("phase at retiredAt+GraceBlocks = %s, want FROZEN", got)
	}
	if err := RequireInflowOpen(s, creator, probe); err == nil || errSymbol(err) != ErrState {
		t.Fatalf("RequireInflowOpen after the notice: err=%v, want ErrState", err)
	}
	// Buy refuses (routes through RequireInflowOpen) — no funding a dead
	// market. (RULING A: Buy replaced the deleted PAR mint as the inflow.)
	if _, err := Buy(s, "buyer", creator, probe, big.NewInt(400)); err == nil || errSymbol(err) != ErrState {
		t.Fatalf("Buy after the notice: err=%v, want ErrState", err)
	}
	// Ask refuses (the inflow gate is the only phase check in ask.go).
	if _, err := askAt0(s, "buyer", creator, probe, big.NewInt(1000), "cid", MinAskDeadline); err == nil || errSymbol(err) != ErrState {
		t.Fatalf("Ask after the notice: err=%v, want ErrState", err)
	}
}

// TestRetire_ReRegisterAfterWindDownClearsMarker proves the wind-down is
// TERMINAL-then-fresh, exactly as SPEC §1.7.5 rules: a retired market with no
// outstanding supply drains to CLOSED via CloseIfDrained, after which the
// creator may re-register and start a brand-new ACTIVE incarnation — Register
// clears the forced-freeze marker so the fresh market is not stuck FROZEN.
func TestRetire_ReRegisterAfterWindDownClearsMarker(t *testing.T) {
	s := NewMemStore()
	const creator = "retirethenreturn"
	regBlock := uint64(1000)
	mustRegister(t, s, creator, regBlock, 1000, 1000)

	if err := Retire(s, creator, creator, regBlock+10); err != nil {
		t.Fatalf("Retire: %v", err)
	}
	// RULING D: CloseIfDrained requires FROZEN, which the retire ladder
	// reaches at retiredAt+GraceBlocks — not on the retire block.
	if CloseIfDrained(s, creator, regBlock+20) {
		t.Fatalf("CloseIfDrained fired INSIDE the retire notice — the notice window must still be OVERDUE, not FROZEN")
	}
	// Supply is zero (nothing was ever bought), so once the notice expires the
	// market drains straight to CLOSED — the mark-forced FROZEN feeds
	// CloseIfDrained just like a natural freeze does.
	closeBlock := regBlock + 10 + GraceBlocks
	if !CloseIfDrained(s, creator, closeBlock) {
		t.Fatalf("CloseIfDrained on a drained retired market returned false, want true")
	}
	if got := Phase(s, creator, closeBlock); got != StateClosed {
		t.Fatalf("phase after CloseIfDrained = %s, want CLOSED", got)
	}

	// The returning creator re-registers. Register's duplicate guard admits a
	// CLOSED market, and the fresh incarnation must be ACTIVE — NOT dragged
	// back to FROZEN by the stale marker.
	reRegBlock := closeBlock + 100
	if err := Register(s, creator, creator, reRegBlock, 2000, 2000); err != nil {
		t.Fatalf("re-Register after wind-down: %v", err)
	}
	if got := Phase(s, creator, reRegBlock); got != StateActive {
		t.Fatalf("phase of the re-registered market = %s, want ACTIVE (Register must clear the retired marker)", got)
	}
	if marketRetired(s, creator) {
		t.Fatalf("the retire mark survived re-registration — the fresh market is still flagged retired")
	}
	if at, ok := RetiredAt(s, creator); ok {
		t.Fatalf("RetiredAt still reports a retire height (%d) after re-registration", at)
	}
}

func TestRetire_NonCreatorRejected(t *testing.T) {
	s := NewMemStore()
	const creator = "retirecreatoronly"
	mustRegister(t, s, creator, 100, 1000, 1000)

	err := Retire(s, "someoneelse", creator, 200)
	if err == nil || errSymbol(err) != ErrAuth {
		t.Fatalf("non-creator Retire: err=%v, want ErrAuth", err)
	}
	// A rejected Retire must not have set the marker: the market stays as it
	// was (ACTIVE), not FROZEN.
	if marketRetired(s, creator) {
		t.Fatalf("a rejected non-creator Retire set the marker anyway")
	}
	if got := Phase(s, creator, 200); got != StateActive {
		t.Fatalf("phase after a rejected Retire = %s, want ACTIVE (unchanged)", got)
	}
}

func TestRetire_NoSuchMarketRejected(t *testing.T) {
	s := NewMemStore()
	err := Retire(s, "nobody", "nobody", 100)
	if err == nil || errSymbol(err) != ErrNotFound {
		t.Fatalf("Retire on a never-registered market: err=%v, want ErrNotFound", err)
	}
}

func TestRetire_ClosedMarketRejected(t *testing.T) {
	s := NewMemStore()
	const creator = "retireclosed"
	mustRegister(t, s, creator, 100, 1000, 1000)
	setStr(s, kState(creator), StateClosed)

	err := Retire(s, creator, creator, 200)
	if err == nil || errSymbol(err) != ErrState {
		t.Fatalf("Retire on a CLOSED market: err=%v, want ErrState", err)
	}
}

// ---------------------------------------------------------------------------
// SetFace — the 2x/7-day band, both directions, and the window boundary.
// ---------------------------------------------------------------------------

func TestSetFace_BandBothDirectionsAndWindowBoundary(t *testing.T) {
	cases := []struct {
		name    string
		elapsed uint64 // block - faceSetAt at the moment of the SetFace call
		oldFace int64
		newFace int64
		wantOK  bool
		wantSym string
	}{
		{"inside window, at upper boundary (old*2) succeeds", FaceBandWindow - 1, 1000, 2000, true, ""},
		{"inside window, one past upper boundary fails", FaceBandWindow - 1, 1000, 2001, false, ErrInput},
		{"inside window, at MinFace floor (old/2=500 is below it post-LIVE-1 and post-commission-carve-out) succeeds", FaceBandWindow - 1, 1000, 577, true, ""},
		{"inside window, one below lower boundary fails", FaceBandWindow - 1, 1000, 499, false, ErrInput},
		{"at the window boundary: anchor refreshes, so exactly 2x succeeds", FaceBandWindow, 1000, 2000, true, ""},
		{"at the window boundary: the band still binds — 9x is refused", FaceBandWindow, 1000, 9000, false, ErrInput},
		{"at the window boundary: a drop below half is still refused", FaceBandWindow, 1000, 100, false, ErrInput},
		{"just inside the window (window-1) still bands a large jump", FaceBandWindow - 1, 1000, 9000, false, ErrInput},
		{"well outside the window: MinFace still applies", FaceBandWindow + 500000, 1000, 5, false, ErrInput}, // 5 < MinFace: rejected by the range check before the band is even consulted
	}
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := NewMemStore()
			creator := "facebandcreator" + string(rune('a'+i))
			const registeredAt = uint64(1000)
			mustRegister(t, s, creator, registeredAt, c.oldFace, 1000)
			// Register itself set faceSetAt = registeredAt; call SetFace at
			// registeredAt + elapsed so "block - faceSetAt" equals c.elapsed exactly.
			block := registeredAt + c.elapsed

			err := SetFace(s, creator, creator, block, c.newFace)
			if c.wantOK {
				if err != nil {
					t.Fatalf("expected success, got %v", err)
				}
				if got := getMoney(s, kFace(creator)); got.Cmp(big.NewInt(c.newFace)) != 0 {
					t.Fatalf("face = %s, want %d", got, c.newFace)
				}
				if got := getU64(s, kFaceSetAt(creator)); got != block {
					t.Fatalf("faceSetAt = %d, want %d", got, block)
				}
			} else {
				if err == nil {
					t.Fatal("expected rejection")
				}
				if sym := errSymbol(err); sym != c.wantSym {
					t.Fatalf("want symbol %s, got %v", c.wantSym, err)
				}
				if got := getMoney(s, kFace(creator)); got.Cmp(big.NewInt(c.oldFace)) != 0 {
					t.Fatalf("face mutated by a rejected SetFace: %s != %d", got, c.oldFace)
				}
			}
		})
	}
}

// TestSetFace_WindowAnchoredBand proves the band anchors to the WINDOW, not to
// the last change.
//
// The original implementation re-anchored on every call, so the 2x limit
// compounded with no required spacing — 1000 -> 2000 -> 4000 -> 8000 in three
// consecutive blocks, ~100,000x within seventeen. An exploiter scrutinizer
// showed the consequence: because creditsForAsk reads `face` live at execution
// time and intra-block order is producer-chosen on this chain, a creator could
// stack SetFace calls ahead of a victim's pending ask and settle it at the
// inflated price. "2x per 7 days" has to mean 2x of TOTAL excursion per window.
func TestSetFace_WindowAnchoredBand(t *testing.T) {
	s := NewMemStore()
	const block0 = uint64(1000)
	mustRegister(t, s, "rollingface", block0, 1000, 1000)

	// A doubling is allowed: it is exactly the band.
	if err := SetFace(s, "rollingface", "rollingface", block0+10, 2000); err != nil {
		t.Fatalf("first SetFace (1000 -> 2000, exactly 2x): %v", err)
	}

	// THE ATTACK: a second doubling one block later must NOT compound. The
	// anchor is still 1000, so 4000 is 4x the anchor and is refused.
	if err := SetFace(s, "rollingface", "rollingface", block0+11, 4000); err == nil {
		t.Fatal("compounding within the window must be rejected: the band anchors to the window, not to the previous change")
	}
	// Seventeen back-to-back calls must not walk it to the moon either.
	for i := uint64(0); i < 17; i++ {
		_ = SetFace(s, "rollingface", "rollingface", block0+12+i, 2000+int64(i))
	}
	if got := Face(s, "rollingface"); got.Cmp(big.NewInt(2000+16)) > 0 {
		t.Fatalf("face walked past the band via repeated calls: %s", got)
	}

	// Once the window elapses a fresh 2x of headroom opens, anchored at the
	// face in effect then — but it is still a band, not a free jump.
	after := block0 + 10 + FaceBandWindow
	if err := SetFace(s, "rollingface", "rollingface", after, 9000); err == nil {
		t.Fatal("a >2x jump must still be refused after the window elapses — the anchor refreshes, the limit does not lift")
	}
	cur := Face(s, "rollingface")
	legal := new(big.Int).Mul(cur, big.NewInt(int64(FaceBandNumerator)))
	if err := SetFace(s, "rollingface", "rollingface", after, legal.Int64()); err != nil {
		t.Fatalf("exactly 2x of the refreshed anchor must be allowed: %v", err)
	}
}

func TestSetFace_OutOfMinMaxRangeRejectedEvenOutsideBand(t *testing.T) {
	s := NewMemStore()
	mustRegister(t, s, "facerangecreator", 100, 1000, 1000)
	block := 100 + FaceBandWindow + 1 // well outside the band window

	if err := SetFace(s, "facerangecreator", "facerangecreator", block, MinFace-1); err == nil || errSymbol(err) != ErrInput {
		t.Fatalf("below MinFace: want ErrInput, got %v", err)
	}
	if err := SetFace(s, "facerangecreator", "facerangecreator", block, MaxFace+1); err == nil || errSymbol(err) != ErrInput {
		t.Fatalf("above MaxFace: want ErrInput, got %v", err)
	}
}

func TestSetFace_CreatorOnlyRejected(t *testing.T) {
	s := NewMemStore()
	mustRegister(t, s, "facecreatoronly", 100, 1000, 1000)
	err := SetFace(s, "notthecreator", "facecreatoronly", 100+FaceBandWindow+1, 2000)
	if err == nil || errSymbol(err) != ErrAuth {
		t.Fatalf("want ErrAuth, got %v", err)
	}
}

func TestSetFace_NoSuchMarketRejected(t *testing.T) {
	s := NewMemStore()
	err := SetFace(s, "ghost", "ghost", 100, 2000)
	if err == nil || errSymbol(err) != ErrNotFound {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestSetFace_ClosedMarketRejected(t *testing.T) {
	s := NewMemStore()
	mustRegister(t, s, "faceclosed", 100, 1000, 1000)
	setStr(s, kState("faceclosed"), StateClosed)

	err := SetFace(s, "faceclosed", "faceclosed", 100+FaceBandWindow+1, 2000)
	if err == nil || errSymbol(err) != ErrState {
		t.Fatalf("want ErrState, got %v", err)
	}
}

// TestSetFace_WorksWhileOverdueOrFrozen proves config changes are NOT gated
// by billing phase (only funds are, per API.md rule 4) — a creator catching
// up on a lapsed subscription can still adjust price.
func TestSetFace_WorksWhileOverdueOrFrozen(t *testing.T) {
	for _, lapse := range []uint64{1, GraceBlocks} { // OVERDUE, FROZEN
		s := NewMemStore()
		mustRegister(t, s, "faceduringlapse", 100, 1000, 1000)
		block := 100 + 30*BlocksPerDay + lapse + FaceBandWindow + 1 // clear of the face band
		if err := SetFace(s, "faceduringlapse", "faceduringlapse", block, 2000); err != nil {
			t.Fatalf("lapse=%d: SetFace should work regardless of billing phase: %v", lapse, err)
		}
	}
}

// ---------------------------------------------------------------------------
// H4 — face-band anchor must not survive re-registration (defect fix,
// 2026-07-21). Register reset kFace/kFaceSetAt/kObsIdx/kPaidUntil/kState but
// NOT kFaceAnchor/kFaceAnchorAt, so a returning creator's 2x/7d anti-rug band
// (SetFace, above) could be measured against a stale anchor left over from a
// PREVIOUS incarnation — defeating the guarantee entirely for exactly the
// creator SPEC §1.7.5 says should "start fresh".
// ---------------------------------------------------------------------------

// TestSetFace_RegressionAnchorDoesNotSurviveReregistration is the direct
// regression proof: an old-life anchor that would bless an 80x jump away
// from the FRESH registered face (were it allowed to survive) must instead
// be cleared, so that jump is correctly rejected against the new anchor.
func TestSetFace_RegressionAnchorDoesNotSurviveReregistration(t *testing.T) {
	s := NewMemStore()
	const creator = "h4reanchor"

	// Old life: register at a HIGH face, then move it once so a non-zero
	// anchor window opens and is persisted.
	regBlock := uint64(1000)
	mustRegister(t, s, creator, regBlock, 10000, MaxCap)
	if err := SetFace(s, creator, creator, regBlock+1, 15000); err != nil { // within 2x of 10000
		t.Fatalf("old-life SetFace: %v", err)
	}
	if anchor := getMoney(s, kFaceAnchor(creator)); anchor.Cmp(big.NewInt(10000)) != 0 {
		t.Fatalf("test setup: old-life anchor = %s, want 10000", anchor)
	}
	if anchorAt := getU64(s, kFaceAnchorAt(creator)); anchorAt != regBlock {
		t.Fatalf("test setup: old-life anchor block = %d, want %d", anchorAt, regBlock)
	}

	// Wind the market down to CLOSED. A direct state write is fine here —
	// this test's subject is Register's anchor-clearing, not the wind-down
	// path itself (covered end-to-end elsewhere, e.g.
	// TestHarness_ReRegistration_AfterClosed).
	setStr(s, kState(creator), StateClosed)
	setMoney(s, kSupply(creator), mZero())

	// Re-register SHORTLY after (well within FaceBandWindow of the OLD
	// anchor's block — the realistic, and most dangerous, case) at a tiny,
	// unrelated face.
	reRegBlock := regBlock + 10
	if reRegBlock-regBlock >= FaceBandWindow {
		t.Fatalf("test setup bug: reRegBlock must land inside the OLD anchor's FaceBandWindow to actually exercise the leak")
	}
	if err := Register(s, creator, creator, reRegBlock, MinFace, MaxCap); err != nil {
		t.Fatalf("re-Register: %v", err)
	}

	if anchor := getMoney(s, kFaceAnchor(creator)); anchor.Sign() != 0 {
		t.Fatalf("H4 REGRESSION: kFaceAnchor survived re-registration: %s, want 0 (cleared)", anchor)
	}
	if anchorAt := getU64(s, kFaceAnchorAt(creator)); anchorAt != 0 {
		t.Fatalf("H4 REGRESSION: kFaceAnchorAt survived re-registration: %d, want 0 (cleared)", anchorAt)
	}

	// THE ATTACK, now proven closed: a 16x jump (MinFace=500 -> 8000) that
	// the OLD, stale anchor (10000, band [5000,20000]) would have blessed as
	// "within band" must be rejected against the FRESH anchor (500, band
	// [250,1000]).
	err := SetFace(s, creator, creator, reRegBlock+1, 8000)
	if err == nil {
		t.Fatal("H4 REGRESSION FAILED: an 80x face jump was accepted after re-registration — a stale anchor from the previous incarnation leaked through")
	}
	if sym := errSymbol(err); sym != ErrInput {
		t.Fatalf("want ErrInput (face band), got %v", err)
	}
	if got := Face(s, creator); got.Cmp(big.NewInt(MinFace)) != 0 {
		t.Fatalf("face changed by a rejected SetFace: %s, want unchanged %d", got, MinFace)
	}

	// Prove the fix is doing genuine, correctly-scoped work, not just
	// coincidentally rejecting everything: a legitimate in-band change
	// against the FRESH face must still succeed.
	if err := SetFace(s, creator, creator, reRegBlock+2, 750); err != nil { // within [250,1000] of the fresh 500
		t.Fatalf("legitimate in-band SetFace after re-registration was rejected: %v", err)
	}
	if got := Face(s, creator); got.Cmp(big.NewInt(750)) != 0 {
		t.Fatalf("face after legitimate change = %s, want 750", got)
	}
}

// ---------------------------------------------------------------------------
// SetCap
// ---------------------------------------------------------------------------

func TestSetCap_HappyPath(t *testing.T) {
	s := NewMemStore()
	mustRegister(t, s, "capcreatorhp", 100, 1000, 1000)
	if err := SetCap(s, "capcreatorhp", "capcreatorhp", 200, 5000); err != nil {
		t.Fatalf("SetCap: %v", err)
	}
	if got := getMoney(s, kCap("capcreatorhp")); got.Cmp(big.NewInt(5000)) != 0 {
		t.Fatalf("cap = %s, want 5000", got)
	}
}

// TestSetCap_BelowSupplyRejected is the explicit guard the task calls out:
// a cap may not strand outstanding credits. Supply is written directly
// (rather than via Prepay) to isolate SetCap's own guard.
func TestSetCap_BelowSupplyRejected(t *testing.T) {
	s := NewMemStore()
	mustRegister(t, s, "capsupplycreator", 100, 1000, 5000)
	setMoney(s, kSupply("capsupplycreator"), big.NewInt(3000))

	if err := SetCap(s, "capsupplycreator", "capsupplycreator", 200, 2999); err == nil {
		t.Fatal("expected rejection: cap below current supply")
	} else if sym := errSymbol(err); sym != ErrCap {
		t.Fatalf("want ErrCap, got %v", err)
	}
	if got := getMoney(s, kCap("capsupplycreator")); got.Cmp(big.NewInt(5000)) != 0 {
		t.Fatalf("cap mutated by a rejected SetCap: %s", got)
	}

	// exactly AT current supply is allowed (only strictly BELOW is rejected).
	if err := SetCap(s, "capsupplycreator", "capsupplycreator", 200, 3000); err != nil {
		t.Fatalf("cap == current supply should succeed: %v", err)
	}
}

func TestSetCap_OutOfMinMaxRangeRejected(t *testing.T) {
	s := NewMemStore()
	mustRegister(t, s, "capfrangecreator", 100, 1000, 1000)
	if err := SetCap(s, "capfrangecreator", "capfrangecreator", 200, MinCap-1); err == nil || errSymbol(err) != ErrInput {
		t.Fatalf("below MinCap: want ErrInput, got %v", err)
	}
	if err := SetCap(s, "capfrangecreator", "capfrangecreator", 200, MaxCap+1); err == nil || errSymbol(err) != ErrInput {
		t.Fatalf("above MaxCap: want ErrInput, got %v", err)
	}
}

func TestSetCap_CreatorOnlyRejected(t *testing.T) {
	s := NewMemStore()
	mustRegister(t, s, "capcreatoronly", 100, 1000, 1000)
	err := SetCap(s, "notthecreator", "capcreatoronly", 200, 5000)
	if err == nil || errSymbol(err) != ErrAuth {
		t.Fatalf("want ErrAuth, got %v", err)
	}
}

func TestSetCap_NoSuchMarketRejected(t *testing.T) {
	s := NewMemStore()
	err := SetCap(s, "ghost2", "ghost2", 100, 5000)
	if err == nil || errSymbol(err) != ErrNotFound {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestSetCap_ClosedMarketRejected(t *testing.T) {
	s := NewMemStore()
	mustRegister(t, s, "capclosed", 100, 1000, 1000)
	setStr(s, kState("capclosed"), StateClosed)
	err := SetCap(s, "capclosed", "capclosed", 200, 5000)
	if err == nil || errSymbol(err) != ErrState {
		t.Fatalf("want ErrState, got %v", err)
	}
}

func TestSetCap_WorksWhileOverdueOrFrozen(t *testing.T) {
	for _, lapse := range []uint64{1, GraceBlocks} {
		s := NewMemStore()
		mustRegister(t, s, "capduringlapse", 100, 1000, 1000)
		block := 100 + 30*BlocksPerDay + lapse
		if err := SetCap(s, "capduringlapse", "capduringlapse", block, 5000); err != nil {
			t.Fatalf("lapse=%d: SetCap should work regardless of billing phase: %v", lapse, err)
		}
	}
}

// ---------------------------------------------------------------------------
// Phase — table-driven boundary walk over the RETIRE notice, plus StateClosed's
// override and the never-registered fallthrough.
//
// ★ THE WALK MOVED LADDERS (OWNER RULING 2026-09-12). It used to walk the
// SUBSCRIPTION ladder around a stored paid_until: ACTIVE at paid_until
// inclusive, OVERDUE for the next GraceBlocks, FROZEN from paid_until+GraceBlocks
// on. That ladder is gone — naturalPhase is constant ACTIVE — and the identical
// boundary convention now hangs off the retire mark instead: OVERDUE from the
// mark inclusive, FROZEN AT mark+GraceBlocks. The five block points, the
// inclusive/exclusive edges and the off-by-one they exist to catch are all
// preserved; only what starts the clock changed.
// ---------------------------------------------------------------------------

func TestPhase_BlockBoundaries(t *testing.T) {
	const regBlock = uint64(900_000)
	const retiredAt = uint64(1_000_000)

	cases := []struct {
		name  string
		block uint64
		want  string
	}{
		// (No "one block before the retire" case: Phase is a pure function of
		// CURRENT state, so querying a past height against a market that is
		// already retired reads the retired ladder — retiredAt-1 is inside
		// retiredAt+GraceBlocks and therefore OVERDUE. That is pre-existing and
		// correct; a market's ACTIVE past is asserted by
		// TestPhase_AdditionalBoundaryCoverage on a market that never retired.)
		{"at the retire mark: OVERDUE begins (inclusive)", retiredAt, StateOverdue},
		{"retiredAt + GraceBlocks - 1: last OVERDUE block", retiredAt + GraceBlocks - 1, StateOverdue},
		{"retiredAt + GraceBlocks: notice fully consumed, FROZEN begins", retiredAt + GraceBlocks, StateFrozen},
		{"retiredAt + GraceBlocks + 1: still FROZEN", retiredAt + GraceBlocks + 1, StateFrozen},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := NewMemStore()
			mustRegister(t, s, "phasecreator", regBlock, 1000, 1000)
			if err := Retire(s, "phasecreator", "phasecreator", retiredAt); err != nil {
				t.Fatalf("Retire: %v", err)
			}
			got := Phase(s, "phasecreator", c.block)
			if got != c.want {
				t.Fatalf("Phase at block %d (retiredAt=%d) = %q, want %q", c.block, retiredAt, got, c.want)
			}
		})
	}
}

// Extra boundary coverage beyond the 5 points above: a market that was never
// retired is ACTIVE at every height, including absurdly large ones. That is the
// inverse of what this test used to assert (deep into FROZEN) and is the single
// most consequential behaviour change of the 2026-09-12 ruling.
func TestPhase_AdditionalBoundaryCoverage(t *testing.T) {
	s := NewMemStore()
	mustRegister(t, s, "phasecreator2", 100, 1000, 1000)

	for _, b := range []uint64{0, 100, 1_000_000, 1_000_000 + GraceBlocks + 10_000_000} {
		if got := Phase(s, "phasecreator2", b); got != StateActive {
			t.Fatalf("never-retired market at block %d: got %q, want ACTIVE", b, got)
		}
	}
}

// TestPhase_ClosedIsTheOnlyStoredStateThatWins: a stored CLOSED overrides
// even a paid_until comfortably in the future — the API.md contract's exact
// words.
func TestPhase_ClosedIsTheOnlyStoredStateThatWins(t *testing.T) {
	s := NewMemStore()
	setStr(s, kState("closedwins"), StateClosed)

	if got := Phase(s, "closedwins", 100); got != StateClosed {
		t.Fatalf("Phase = %q, want CLOSED regardless of a future paid_until", got)
	}
}

// TestPhase_NeverRegisteredReadsActive documents the behaviour refund.go's
// CloseIfDrained relies on (and guards against with its own kRegisteredAt
// check): Phase has only 4 legal return values by its own signature, so a
// creator whose kState was never written is NOT a special 5th "unknown" case.
//
// ★ IT NOW FALLS THROUGH TO ACTIVE, NOT FROZEN (OWNER RULING 2026-09-12). With
// the paid_until ladder gone, an unknown creator has no retire mark either, so
// naturalPhase's constant ACTIVE is what it reads — at every height, where it
// used to read FROZEN past GraceBlocks because paidUntil defaulted to 0.
//
// THIS IS THE MORE PERMISSIVE DIRECTION, AND IT IS WHY THE kRegisteredAt CHECKS
// MATTER MORE THAN BEFORE. Any caller that used Phase() as a proxy for "does
// this market exist" and relied on an unknown creator eventually reading FROZEN
// would now admit it instead. Every such caller in this package checks
// kRegisteredAt directly — CloseIfDrained, Renew (deleted), registerCheck — and
// that is what this test exists to keep true.
func TestPhase_NeverRegisteredReadsActive(t *testing.T) {
	s := NewMemStore()
	for _, b := range []uint64{0, GraceBlocks + 1, 10_000_000} {
		if got := Phase(s, "totallyunknown", b); got != StateActive {
			t.Fatalf("Phase for a never-registered creator at block %d = %q, want ACTIVE", b, got)
		}
	}
	// ...and the guard that actually answers "does this market exist" still says no.
	if RegisteredAt(s, "totallyunknown") != 0 {
		t.Fatal("an unregistered creator must have no registration block")
	}
}

// ---------------------------------------------------------------------------
// RequireInflowOpen
// ---------------------------------------------------------------------------

func TestRequireInflowOpen_ActiveAndOverdueOpen(t *testing.T) {
	s := NewMemStore()
	mustRegister(t, s, "inflowcreator", 100, 1000, 1000)

	if err := RequireInflowOpen(s, "inflowcreator", 100+30*BlocksPerDay); err != nil {
		t.Fatalf("ACTIVE should be open: %v", err)
	}
	// The OVERDUE rung is reachable only through Retire since 2026-09-12, and a
	// retired market has inflows CLOSED from the mark (K3) — so the "OVERDUE is
	// open to inflows" clause that used to sit here is now self-contradictory and
	// is asserted in its true form by the retire-notice tests above. ACTIVE, the
	// rung every live market sits on, is what this test pins.
}

func TestRequireInflowOpen_FrozenAndClosedBlocked(t *testing.T) {
	s := NewMemStore()
	mustRegister(t, s, "inflowcreator2", 100, 1000, 1000)
	// FROZEN is reached by Retire + the notice (the only road since 2026-09-12).
	retireAt := uint64(100 + 30*BlocksPerDay)
	if err := Retire(s, "inflowcreator2", "inflowcreator2", retireAt); err != nil {
		t.Fatalf("Retire: %v", err)
	}
	if err := RequireInflowOpen(s, "inflowcreator2", retireAt+GraceBlocks); err == nil {
		t.Fatal("FROZEN should be closed to inflow")
	} else if sym := errSymbol(err); sym != ErrState {
		t.Fatalf("want ErrState, got %v", err)
	}

	setStr(s, kState("inflowcreator2"), StateClosed)
	if err := RequireInflowOpen(s, "inflowcreator2", 200); err == nil {
		t.Fatal("CLOSED should be closed to inflow")
	} else if sym := errSymbol(err); sym != ErrState {
		t.Fatalf("want ErrState, got %v", err)
	}
}

func TestRequireInflowOpen_GlobalPauseBlocksEvenActive(t *testing.T) {
	s := NewMemStore()
	mustRegister(t, s, "pausedinflow", 100, 1000, 1000)
	setStr(s, kPaused(), "1")

	err := RequireInflowOpen(s, "pausedinflow", 100)
	if err == nil {
		t.Fatal("global pause should block inflow even on an otherwise-ACTIVE market")
	}
	if sym := errSymbol(err); sym != ErrPaused {
		t.Fatalf("want ErrPaused, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// RULING D — the phase MAX, and the re-incarnation guards (2026-07-21)
// ---------------------------------------------------------------------------

// TestPhase_RetireIsMonotone_NeverLessFrozen is the direct statement of the
// load-bearing property: for EVERY (natural phase, retire timing) combination,
// the phase with a retire mark is at least as frozen as without it. This is
// what "the MAX is load-bearing" means, tested exhaustively rather than by
// example — it is the property that keeps the DEFECT-1 fix alive under the
// new height-based mark.
func TestPhase_RetireIsMonotone_NeverLessFrozen(t *testing.T) {
	rank := map[string]int{StateActive: 0, StateOverdue: 1, StateFrozen: 2, StateClosed: 3}
	const regBlock = uint64(100_000)

	// Probe blocks spanning ACTIVE, OVERDUE and FROZEN on the natural ladder.
	probes := []uint64{
		regBlock,
		regBlock + 1,
		regBlock + hzLongGap,
		regBlock + hzLongGap + 1,
		regBlock + hzLongGap + GraceBlocks - 1,
		regBlock + hzLongGap + GraceBlocks,
		regBlock + hzLongGap + 10*GraceBlocks,
	}
	// Retire heights spanning "before the lapse" to "long after the freeze".
	retires := []uint64{
		regBlock,
		regBlock + 10,
		regBlock + hzLongGap,
		regBlock + hzLongGap + GraceBlocks,
		regBlock + hzLongGap + 5*GraceBlocks,
	}

	for _, retireAt := range retires {
		// Baseline: an identical market that was NEVER retired.
		base := NewMemStore()
		mustRegister(t, base, "basecreator", regBlock, 1000, 1000)

		ret := NewMemStore()
		mustRegister(t, ret, "basecreator", regBlock, 1000, 1000)
		if err := Retire(ret, "basecreator", "basecreator", retireAt); err != nil {
			t.Fatalf("Retire at %d: %v", retireAt, err)
		}

		for _, b := range probes {
			without := Phase(base, "basecreator", b)
			with := Phase(ret, "basecreator", b)
			if rank[with] < rank[without] {
				t.Fatalf("retireAt=%d block=%d: retiring made the market LESS frozen (%s -> %s) — the MAX is broken",
					retireAt, b, without, with)
			}
			// And at/after retireAt+GraceBlocks it is FROZEN unconditionally.
			if b >= retireAt+GraceBlocks && with != StateFrozen && with != StateClosed {
				t.Fatalf("retireAt=%d block=%d: phase = %s, want FROZEN (the notice has expired)", retireAt, b, with)
			}
			// Inside the notice it is at least OVERDUE.
			if b >= retireAt && b < retireAt+GraceBlocks && rank[with] < rank[StateOverdue] {
				t.Fatalf("retireAt=%d block=%d: phase = %s, want at least OVERDUE (inside the notice)", retireAt, b, with)
			}
		}
	}
}

// TestPhase_ClosedStillWinsOverTheRetireMark — CLOSED is terminal and is the
// only stored state that wins; the retire mark must not resurrect a closed
// market into OVERDUE via the MAX.
func TestPhase_ClosedStillWinsOverTheRetireMark(t *testing.T) {
	s := NewMemStore()
	const creator = "closedretired"
	mustRegister(t, s, creator, 100, 1000, 1000)
	if err := Retire(s, creator, creator, 200); err != nil {
		t.Fatal(err)
	}
	setStr(s, kState(creator), StateClosed)
	for _, b := range []uint64{200, 201, 200 + GraceBlocks} {
		if got := Phase(s, creator, b); got != StateClosed {
			t.Fatalf("phase at %d = %s, want CLOSED (terminal beats the retire mark)", b, got)
		}
	}
}

// TestRetire_OnceOnly_NoticeCannotBeRestarted. Under the old instant-freeze
// marker a second Retire was a harmless re-write of "1". With a HEIGHT it is
// not: re-arming would move the notice window forward, and on a market a fan
// has renewed (natural ACTIVE) that would take an already-FROZEN market back
// to OVERDUE — retire making a market LESS frozen, the exact thing RULING D
// forbids. The second call must be refused, mutating nothing.
func TestRetire_OnceOnly_NoticeCannotBeRestarted(t *testing.T) {
	s := NewMemStore()
	const creator = "onceonly"
	regBlock := uint64(1000)
	mustRegister(t, s, creator, regBlock, 1000, 1000)
	// A fan renews far ahead, so the NATURAL ladder stays ACTIVE and only the
	// retire mark drives the phase — the configuration where a re-arm would
	// actually un-freeze the market. (A hostile far-future Renew used to be the
	// setup here; with no subscription the market is ACTIVE forever on its own,
	// which is the same configuration reached for free.)
	if err := Retire(s, creator, creator, regBlock+2); err != nil {
		t.Fatalf("Retire: %v", err)
	}
	frozenAt := regBlock + 2 + GraceBlocks
	if got := Phase(s, creator, frozenAt); got != StateFrozen {
		t.Fatalf("sanity: phase at %d = %s, want FROZEN", frozenAt, got)
	}

	// The re-arm attempt, long after the notice expired.
	err := Retire(s, creator, creator, frozenAt+1000)
	if err == nil || errSymbol(err) != ErrState {
		t.Fatalf("second Retire: err=%v, want ErrState (the notice cannot be restarted)", err)
	}
	// The mark is unchanged and the market is still FROZEN — NOT back to the
	// OVERDUE notice.
	if at, ok := RetiredAt(s, creator); !ok || at != regBlock+2 {
		t.Fatalf("RetiredAt = (%d,%v), want (%d,true) — a refused Retire must not move the mark", at, ok, regBlock+2)
	}
	if got := Phase(s, creator, frozenAt+1001); got != StateFrozen {
		t.Fatalf("phase after the refused re-arm = %s, want FROZEN — a re-armed notice would have UN-FROZEN this market", got)
	}
}

// TestRetiredAt_ExportedForTheNotice — the notice is only a notice if it is
// observable. A wallet must be able to say "this market freezes at block X".
func TestRetiredAt_ExportedForTheNotice(t *testing.T) {
	s := NewMemStore()
	const creator = "noticeable"
	mustRegister(t, s, creator, 100, 1000, 1000)
	if at, ok := RetiredAt(s, creator); ok {
		t.Fatalf("RetiredAt on a live market = (%d,true), want (0,false)", at)
	}
	if err := Retire(s, creator, creator, 12345); err != nil {
		t.Fatal(err)
	}
	at, ok := RetiredAt(s, creator)
	if !ok || at != 12345 {
		t.Fatalf("RetiredAt = (%d,%v), want (12345,true)", at, ok)
	}
	if at+GraceBlocks != 12345+GraceBlocks {
		t.Fatal("unreachable")
	}
	if got := Phase(s, creator, at+GraceBlocks); got != StateFrozen {
		t.Fatalf("the advertised freeze block %d reads %s, want FROZEN — the notice would be a lie", at+GraceBlocks, got)
	}
}

// TestRetire_AtBlockZeroIsStillRetired — the ENCODING regression guard. The
// mark stores block+1 precisely so that a retire height of 0 is not
// indistinguishable from "never retired": a bare height would read back as
// not-retired and silently un-freeze the market, a fail-OPEN on the one
// mechanism whose entire job is to force a market DOWN the ladder.
//
// Note on reachability, stated rather than assumed: a market REGISTERED at
// block 0 is unaddressable by every existence check in the package
// (kRegisteredAt == 0 reads as "never registered" — market.go's documented,
// pre-existing genesis edge), so Retire cannot even be called on one. The
// reachable form of the property is therefore this: a retire MARK whose
// height is 0 must round-trip as retired-at-0, not as absent.
func TestRetire_AtBlockZeroIsStillRetired(t *testing.T) {
	s := NewMemStore()
	const creator = "genesisretire"
	mustRegister(t, s, creator, 1, 1000, 1000) // block 1: addressable
	if err := Retire(s, creator, creator, 0); err != nil {
		t.Fatalf("Retire with block 0: %v", err)
	}
	if !marketRetired(s, creator) {
		t.Fatal("a retire mark at height 0 reads as NOT retired — the +1 encoding is broken (fail-OPEN)")
	}
	if at, ok := RetiredAt(s, creator); !ok || at != 0 {
		t.Fatalf("RetiredAt = (%d,%v), want (0,true)", at, ok)
	}
	if got := Phase(s, creator, 0); got != StateOverdue {
		t.Fatalf("phase at block 0 = %s, want OVERDUE (inside the notice)", got)
	}
	if got := Phase(s, creator, GraceBlocks); got != StateFrozen {
		t.Fatalf("phase at GraceBlocks = %s, want FROZEN", got)
	}
	// The raw stored value is the +1 encoding, asserted directly so a future
	// "simplification" to a bare height fails here rather than in production.
	if raw := getU64(s, kRetiredAt(creator)); raw != 1 {
		t.Fatalf("stored retire mark = %d, want 1 (block+1 encoding; 0 is reserved for NEVER RETIRED)", raw)
	}
}

// ---------------------------------------------------------------------------
// Re-registration must not inherit money, clocks, basis or offer prices
// ---------------------------------------------------------------------------

// TestRegister_RefusesToInheritReserveOrSupply is the fix for a MEASURED
// defect: a CLOSED market whose reserve had not actually been paid out was
// re-registered, and the first buyer of ONE token in the new incarnation
// owned 100% of a supply backed by the DEAD incarnation's reserve —
// floor(R*c/S) handed them all of it at wind-down. That is an unallocated pot
// existing at a market's first block, which is exactly what the governing
// theorem forbids (R === area(S), with equality).
//
// The fix REFUSES rather than clearing: zeroing kReserve here would be an
// admin path to a market's reserve (I4) and would destroy real HBD.
func TestRegister_RefusesToInheritReserveOrSupply(t *testing.T) {
	t.Run("stranded reserve", func(t *testing.T) {
		s := NewMemStore()
		const creator = "strandedreserve"
		mustRegister(t, s, creator, 100, 1000, 1_000_000)
		// A real buy, then the market is (incorrectly) marked closed with the
		// reserve still funded — the exact shape the defect was measured on.
		if _, err := Buy(s, "holder", creator, 150, big.NewInt(100)); err != nil {
			t.Fatal(err)
		}
		reserveBefore := getMoney(s, kReserve(creator))
		setStr(s, kState(creator), StateClosed)

		err := Register(s, creator, creator, 500_000, 2000, 2000)
		if err == nil {
			t.Fatal("re-registration over a funded reserve must be REFUSED — the new market would inherit the money")
		}
		if sym := errSymbol(err); sym != ErrState {
			t.Fatalf("want ErrState, got %v", err)
		}
		// The money is untouched and still visible on the wind-down rail: the
		// refusal must not confiscate or move a single unit.
		if got := getMoney(s, kReserve(creator)); got.Cmp(reserveBefore) != 0 {
			t.Fatalf("reserve = %s, want unchanged %s — Register must never write a reserve, not even to zero it", got, reserveBefore)
		}
		if got := getU64(s, kRegisteredAt(creator)); got != 100 {
			t.Fatalf("registeredAt = %d, want the ORIGINAL 100 (a refused registration mutates nothing)", got)
		}
		if got := getStr(s, kState(creator)); got != StateClosed {
			t.Fatalf("state = %q, want CLOSED (unchanged)", got)
		}
	})

	t.Run("stranded supply", func(t *testing.T) {
		s := NewMemStore()
		const creator = "strandedsupply"
		mustRegister(t, s, creator, 100, 1000, 1_000_000)
		setMoney(s, kSupply(creator), big.NewInt(42)) // tokens outstanding
		setStr(s, kState(creator), StateClosed)

		err := Register(s, creator, creator, 500_000, 2000, 2000)
		if err == nil || errSymbol(err) != ErrState {
			t.Fatalf("re-registration over outstanding supply: err=%v, want ErrState", err)
		}
		if got := getMoney(s, kSupply(creator)); got.Cmp(big.NewInt(42)) != 0 {
			t.Fatalf("supply = %s, want unchanged 42", got)
		}
	})

	t.Run("clean wind-down still re-registers", func(t *testing.T) {
		// The guard must not block the LEGITIMATE returning creator: a real,
		// complete wind-down leaves R == 0 and S == 0 (C-24).
		s := NewMemStore()
		const creator = "cleanreturn"
		regBlock := uint64(1000)
		mustRegister(t, s, creator, regBlock, 1000, 1_000_000)
		if _, err := Buy(s, "holder", creator, regBlock+1, big.NewInt(100)); err != nil {
			t.Fatal(err)
		}
		if err := Retire(s, creator, creator, regBlock+2); err != nil {
			t.Fatal(err)
		}
		windDown := regBlock + 2 + GraceBlocks
		if _, err := Refund(s, "holder", creator, windDown, big.NewInt(100)); err != nil {
			t.Fatalf("wind-down refund: %v", err)
		}
		if !CloseIfDrained(s, creator, windDown) {
			t.Fatal("CloseIfDrained: not closed")
		}
		if err := Register(s, creator, creator, windDown+10, 2000, 2000); err != nil {
			t.Fatalf("a genuinely wound-down market must re-register: %v", err)
		}
	})
}

// TestRegister_DoesNotResetTheEscrowSequence — a DELIBERATE non-clear, and
// the reason is safety, not laziness: escrow records at kEscrow(c, seq) are
// never deleted (ask.go flips status and leaves the record), so a reset
// counter would make the new incarnation's first Ask overwrite the old
// incarnation's record at seq 0, destroying settlement history. kSeq is
// neither money, nor a clock, nor a price.
func TestRegister_DoesNotResetTheEscrowSequence(t *testing.T) {
	s := NewMemStore()
	const creator = "seqcreator"
	mustRegister(t, s, creator, 100, 1000, 1000)
	setU64(s, kSeq(creator), 7) // stand-in for seven resolved asks
	setStr(s, kState(creator), StateClosed)

	if err := Register(s, creator, creator, 500_000, 2000, 2000); err != nil {
		t.Fatalf("re-Register: %v", err)
	}
	if got := EscrowSeq(s, creator); got != 7 {
		t.Fatalf("escrow seq = %d, want 7 — resetting it would overwrite the previous incarnation's escrow records", got)
	}
}

// TestRetire_NoticeDropsTheCurveRail_WindDownRailOpenThroughout is the
// RULING-K3 rail property, asserted end to end across the boundary block: the
// instant a market retires it is winding down for BOTH rails — the CURVE rail
// (Sell) is CLOSED and the flat pro-rata WIND-DOWN rail (Refund) is OPEN, from
// the retire block onward, through the OVERDUE notice and past the freeze.
// inWindDown is the single switch: exactly one rail is open at every block —
// no gap where a holder is trapped, no overlap (the tax/fee bypass). This
// REVERSES RULING D's notice (which kept the curve rail open — THM-1's race).
func TestRetire_NoticeDropsTheCurveRail_WindDownRailOpenThroughout(t *testing.T) {
	s := NewMemStore()
	const creator = "railswitch"
	regBlock := uint64(1000)
	mustRegister(t, s, creator, regBlock, 1000, 1_000_000)
	if _, err := Buy(s, "holderA", creator, regBlock+1, big.NewInt(200)); err != nil {
		t.Fatal(err)
	}
	if _, err := Buy(s, "holderB", creator, regBlock+2, big.NewInt(200)); err != nil {
		t.Fatal(err)
	}
	retireBlock := regBlock + 3
	// Only curve trades happened up to retire, so equality holds here.
	if got, want := getMoney(s, kReserve(creator)), Area(getMoney(s, kSupply(creator))); got.Cmp(want) != 0 {
		t.Fatalf("pre-retire R = %s != area(S) = %s", got, want)
	}
	if err := Retire(s, creator, creator, retireBlock); err != nil {
		t.Fatal(err)
	}
	freeze := retireBlock + GraceBlocks

	// --- inside the notice: the WIND-DOWN rail is the open one (K3) ---
	inside := freeze - 1
	if got := Phase(s, creator, inside); got != StateOverdue {
		t.Fatalf("phase inside the notice = %s, want OVERDUE (Phase still ladders)", got)
	}
	if _, err := Sell(s, "holderA", creator, inside, big.NewInt(100)); err == nil {
		t.Fatal("the curve rail must be CLOSED during the retire notice (K3 drops it) — Sell should route to Refund")
	}
	payoutInside, err := Refund(s, "holderA", creator, inside, big.NewInt(100))
	if err != nil {
		t.Fatalf("wind-down Refund inside the notice failed: %v — K3 opens the flat pro-rata rail the instant a market retires", err)
	}
	if payoutInside.Sign() <= 0 {
		t.Fatalf("notice refund payout = %s, want positive", payoutInside)
	}
	// Flat pro-rata does NOT preserve equality — it strands excess, which is
	// UNRAIDABLE because inflows are closed (Retire is irreversible): R >=
	// area(S) after the notice exit.
	if got, want := getMoney(s, kReserve(creator)), Area(getMoney(s, kSupply(creator))); got.Cmp(want) < 0 {
		t.Fatalf("after a notice Refund: R = %s < area(S) = %s — the wind-down paid more than owed", got, want)
	}

	// --- at the boundary block: still the WIND-DOWN rail, same as the notice ---
	if _, err := Sell(s, "holderA", creator, freeze, big.NewInt(1)); err == nil {
		t.Fatal("the curve rail must stay closed AT retiredAt+GraceBlocks")
	}
	payout, err := Refund(s, "holderA", creator, freeze, big.NewInt(50))
	if err != nil {
		t.Fatalf("wind-down Refund at the freeze block failed: %v — a holder must never be trapped", err)
	}
	if payout.Sign() <= 0 {
		t.Fatalf("wind-down payout = %s, want positive", payout)
	}

	// --- no gap, no overlap: a RETIRED market is inWindDown at every block
	//     from the retire block on (curve closed, Refund open) ---
	for _, b := range []uint64{retireBlock, retireBlock + 1, freeze - 1, freeze, freeze + 1, freeze + 100_000} {
		if !inWindDown(s, creator, b) {
			t.Fatalf("block %d: a retired market must be inWindDown (curve closed, Refund open)", b)
		}
	}
	// The complementary half, so the partition is real and not vacuous: a fresh
	// NON-retired ACTIVE market is NOT inWindDown (the curve rail is open there).
	s2 := NewMemStore()
	mustRegister(t, s2, "livemkt", 1000, 1000, 1_000_000)
	if inWindDown(s2, "livemkt", 1001) {
		t.Fatal("a fresh ACTIVE market must NOT be inWindDown (the curve rail is open)")
	}
}
