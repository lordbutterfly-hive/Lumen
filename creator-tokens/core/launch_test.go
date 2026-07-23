package core

import (
	"math/big"
	"sort"
	"testing"
)

// launch_test.go — the LAUNCH: free registration plus the OPTIONAL atomic
// creator first buy (launch.go, RULING H / RULINGS-v2-2026-07-21).
//
// The tests are organised around the three claims launch.go makes, because a
// claim nobody tests is a claim nobody keeps:
//
//	1. EQUIVALENCE — RegisterWithFirstBuy(n) is exactly Register + Buy(n), key
//	   for key. This is what licenses launch.go to have no curve math of its
//	   own, and it is asserted on complete store dumps, not on spot checks.
//	2. ATOMICITY — every rejection mutates NOTHING (RULING G across a
//	   two-part state transition: no half-registered market, ever).
//	3. HONESTY — the first buy is OPTIONAL and therefore does NOT bound the
//	   snipe. The residual advantage is measured and pinned here so the
//	   numbers in launch.go's header cannot silently drift, and so nobody can
//	   quietly start describing this as an anti-snipe device.

// lnDump returns the complete store contents as a sorted key=value slice —
// the strongest available statement of "these two state transitions are the
// same transition".
func lnDump(s *MemStore) []string {
	keys := s.Keys()
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		v, _ := s.Get(k)
		out = append(out, k+"="+v)
	}
	return out
}

func lnAssertSameStore(t *testing.T, a, b *MemStore, what string) {
	t.Helper()
	da, db := lnDump(a), lnDump(b)
	if len(da) != len(db) {
		t.Fatalf("%s: key COUNT differs: %d vs %d\n  A=%v\n  B=%v", what, len(da), len(db), da, db)
	}
	for i := range da {
		if da[i] != db[i] {
			t.Fatalf("%s: state differs at entry %d: %q vs %q", what, i, da[i], db[i])
		}
	}
}

// ---------------------------------------------------------------------------
// 1. EQUIVALENCE
// ---------------------------------------------------------------------------

// TestLaunch_IsExactlyRegisterThenBuy is the load-bearing test of this file.
// If it ever fails, launch.go has grown a second copy of the buy math and the
// invariant R === Area(S) is no longer inherited from buy.go — it is being
// re-derived, which is exactly how a curve implementation drifts.
func TestLaunch_IsExactlyRegisterThenBuy(t *testing.T) {
	const (
		creator      = "launchcreator"
		block        = uint64(500_000)
		face   int64 = 1000
		capVal int64 = 1_000_000
	)
	for _, n := range []int64{1, 2, 7, 100, 1000, 12345} {
		atomicStore := NewMemStore()
		res, err := RegisterWithFirstBuy(atomicStore, creator, creator, block, face, capVal, big.NewInt(n))
		if err != nil {
			t.Fatalf("n=%d: RegisterWithFirstBuy: %v", n, err)
		}

		twoStepStore := NewMemStore()
		if err := Register(twoStepStore, creator, creator, block, face, capVal); err != nil {
			t.Fatalf("n=%d: Register: %v", n, err)
		}
		buyRes, err := Buy(twoStepStore, creator, creator, block, big.NewInt(n))
		if err != nil {
			t.Fatalf("n=%d: Buy: %v", n, err)
		}

		lnAssertSameStore(t, atomicStore, twoStepStore, "launch vs register-then-buy (n="+big.NewInt(n).String()+")")

		// The returned amounts must match too — the wrapper draws off these.
		if res.FirstBuy.Cost.Cmp(buyRes.Cost) != 0 || res.FirstBuy.Fee.Cmp(buyRes.Fee) != 0 ||
			res.FirstBuy.TotalDue.Cmp(buyRes.TotalDue) != 0 || res.TotalDue.Cmp(buyRes.TotalDue) != 0 {
			t.Fatalf("n=%d: launch result differs from Buy's: cost %s/%s fee %s/%s due %s/%s",
				n, res.FirstBuy.Cost, buyRes.Cost, res.FirstBuy.Fee, buyRes.Fee, res.TotalDue, buyRes.TotalDue)
		}
	}
}

// TestLaunch_NoFirstBuyIsExactlyRegister — the OPTIONAL case, both spellings
// (nil and an explicit zero), must be byte-identical to a plain Register.
func TestLaunch_NoFirstBuyIsExactlyRegister(t *testing.T) {
	const (
		creator      = "plaincreator"
		block        = uint64(9_000)
		face   int64 = 1000 // any valid face; LIVE-1 raised MinFace 500->508, so 500 is no longer registrable
		capVal int64 = 5_000
	)
	plain := NewMemStore()
	if err := Register(plain, creator, creator, block, face, capVal); err != nil {
		t.Fatalf("Register: %v", err)
	}
	for _, fb := range []*big.Int{nil, big.NewInt(0), mZero()} {
		s := NewMemStore()
		res, err := RegisterWithFirstBuy(s, creator, creator, block, face, capVal, fb)
		if err != nil {
			t.Fatalf("firstBuy=%v: %v", fb, err)
		}
		if res.FirstBuy != nil {
			t.Fatalf("firstBuy=%v: FirstBuy must be nil when no launch buy was requested", fb)
		}
		if res.TotalDue.Sign() != 0 {
			t.Fatalf("firstBuy=%v: TotalDue = %s, want 0 — REGISTRATION IS FREE and no buy happened", fb, res.TotalDue)
		}
		lnAssertSameStore(t, s, plain, "no-first-buy vs plain Register")
	}
}

// ---------------------------------------------------------------------------
// 2. THE MONEY: full curve cost, zero premine, R === Area(S)
// ---------------------------------------------------------------------------

func TestLaunch_CreatorPaysFullCurveCost_NoPremine(t *testing.T) {
	const (
		creator      = "paysfull"
		block        = uint64(1_000)
		face   int64 = 1000
		capVal int64 = 1_000_000
	)
	n := big.NewInt(100)
	s := NewMemStore()
	res, err := RegisterWithFirstBuy(s, creator, creator, block, face, capVal, n)
	if err != nil {
		t.Fatalf("RegisterWithFirstBuy: %v", err)
	}

	// The cost is the EXACT area step from an empty market — no discount, no
	// reserved allocation, no separate primary-sale price.
	wantCost := BuyCost(mZero(), n)
	if res.FirstBuy.Cost.Cmp(wantCost) != 0 {
		t.Fatalf("launch cost = %s, want the full curve step area(n)-area(0) = %s (LOCKED-MECHANISM: zero free creator allocation)",
			res.FirstBuy.Cost, wantCost)
	}
	if wantCost.Cmp(Area(n)) != 0 {
		t.Fatalf("sanity: BuyCost(0,n) = %s, want Area(n) = %s", wantCost, Area(n))
	}
	// The 10% trade fee is charged on top, exactly as for any other buyer.
	wantFee, _, _ := tradeFeeOn(wantCost)
	if res.FirstBuy.Fee.Cmp(wantFee) != 0 {
		t.Fatalf("launch fee = %s, want %s (the creator pays the same 10%% as anyone)", res.FirstBuy.Fee, wantFee)
	}
	if res.TotalDue.Cmp(mAdd(wantCost, wantFee)) != 0 {
		t.Fatalf("TotalDue = %s, want cost+fee = %s", res.TotalDue, mAdd(wantCost, wantFee))
	}

	// THE invariant: the reserve holds exactly the curve area and not a unit
	// more — the premise the whole governing theorem rests on.
	if got := getMoney(s, kReserve(creator)); got.Cmp(Area(n)) != 0 {
		t.Fatalf("reserve = %s, want Area(supply) = %s — R === area(S) must hold with EQUALITY out of a launch", got, Area(n))
	}
	if got := getMoney(s, kSupply(creator)); got.Cmp(n) != 0 {
		t.Fatalf("supply = %s, want %s", got, n)
	}
	if got := getMoney(s, kBal(creator, creator)); got.Cmp(n) != 0 {
		t.Fatalf("creator balance = %s, want %s (minted to the payer, nobody else)", got, n)
	}
	// The fee is NOT in the reserve; it went to the pull pots.
	if got := getMoney(s, kReserve(creator)); got.Cmp(res.TotalDue) == 0 {
		t.Fatalf("the trade fee entered the reserve — C-19 forbids it")
	}
	// The hold clock starts at `block` (C-14) — the launch slice is maximally
	// FRESH, i.e. maximally taxed on exit. A creator's own launch buy gets no
	// tax privilege. (RULING K deleted the cost basis, so there is no per-holder
	// basis to assert here any more.)
	if got := holderAcqBlock(s, creator, creator); got != block {
		t.Fatalf("creator hold clock = %d, want %d (a launch buy is as fresh as any buy)", got, block)
	}
	// Registration itself remains free: the ONLY money that moved is the buy.
	if got := getMoney(s, kTreasury()); got.Cmp(res.FirstBuy.FeePlatform) != 0 {
		t.Fatalf("treasury = %s, want just the buy's platform fee half %s (registration charges nothing)", got, res.FirstBuy.FeePlatform)
	}
}

// ---------------------------------------------------------------------------
// 3. ATOMICITY — a rejected launch mutates NOTHING
// ---------------------------------------------------------------------------

func TestLaunch_RejectedLaunchMutatesNothing(t *testing.T) {
	const (
		block        = uint64(1_000)
		face   int64 = 1000
		capVal int64 = 1_000
	)
	cases := []struct {
		name     string
		creator  string
		face     int64
		cap      int64
		firstBuy *big.Int
		block    uint64
		wantSym  string
	}{
		{"negative firstBuy", "negcreator", face, capVal, big.NewInt(-1), block, ErrInput},
		{"firstBuy over cap", "capcreator", face, capVal, big.NewInt(capVal + 1), block, ErrCap},
		{"firstBuy at block 0", "genesiscreator", face, capVal, big.NewInt(1), 0, ErrInput},
		{"face out of range", "facecreator", MinFace - 1, capVal, big.NewInt(1), block, ErrInput},
		{"cap out of range", "capbadcreator", face, MaxCap + 1, big.NewInt(1), block, ErrInput},
		{"invalid creator", "bad|creator", face, capVal, big.NewInt(1), block, ErrInput},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := NewMemStore()
			before := lnDump(s)
			_, err := RegisterWithFirstBuy(s, c.creator, c.creator, c.block, c.face, c.cap, c.firstBuy)
			if err == nil {
				t.Fatalf("expected rejection")
			}
			if sym := errSymbol(err); sym != c.wantSym {
				t.Fatalf("symbol = %q, want %q (err=%v)", sym, c.wantSym, err)
			}
			after := lnDump(s)
			if len(before) != 0 || len(after) != 0 {
				t.Fatalf("a REJECTED launch wrote state: before=%v after=%v — RULING G: nothing mutates on a rejected call, and a half-registered market must not be representable", before, after)
			}
		})
	}
}

// TestLaunch_RejectedLaunchOverExistingStateMutatesNothing — the harder half:
// a rejected launch against a store that ALREADY has content must leave every
// existing key untouched (the empty-store case above cannot catch a
// partial-write that happens to overwrite).
func TestLaunch_RejectedLaunchOverExistingStateMutatesNothing(t *testing.T) {
	s := NewMemStore()
	// A live, unrelated market plus a live market for the SAME creator (which
	// makes the second registration a duplicate).
	mustRegister(t, s, "othercreator", 100, 1000, 1000)
	mustRegister(t, s, "dupe", 100, 1000, 1000)
	if _, err := Buy(s, "someholder", "othercreator", 150, big.NewInt(50)); err != nil {
		t.Fatal(err)
	}
	before := lnDump(s)

	if _, err := RegisterWithFirstBuy(s, "dupe", "dupe", 200, 2000, 2000, big.NewInt(10)); err == nil {
		t.Fatal("expected rejection: duplicate registration")
	}
	if _, err := RegisterWithFirstBuy(s, "impostor", "othercreator", 200, 2000, 2000, big.NewInt(10)); err == nil {
		t.Fatal("expected rejection: caller != creator")
	}
	after := lnDump(s)
	if len(before) != len(after) {
		t.Fatalf("rejected launches changed the key set: %d -> %d", len(before), len(after))
	}
	for i := range before {
		if before[i] != after[i] {
			t.Fatalf("rejected launch mutated state at %q -> %q", before[i], after[i])
		}
	}
}

// TestLaunch_GloballyPausedRejected — the pause gates registration, and the
// launch buy inherits that (it is an inflow).
func TestLaunch_GloballyPausedRejected(t *testing.T) {
	s := NewMemStore()
	setStr(s, kPaused(), "1")
	if _, err := RegisterWithFirstBuy(s, "pausedlaunch", "pausedlaunch", 100, 1000, 1000, big.NewInt(5)); err == nil || errSymbol(err) != ErrPaused {
		t.Fatalf("err = %v, want PAUSED", err)
	}
	if got := getMoney(s, kSupply("pausedlaunch")); !mIsZero(got) {
		t.Fatalf("a paused launch minted %s tokens", got)
	}
}

// TestLaunch_FirstBuyMayTakeTheWholeCap — no artificial ceiling on the
// creator's own slice: they pay the full curve area for it, which is the only
// deterrent that exists (and the only honest one).
func TestLaunch_FirstBuyMayTakeTheWholeCap(t *testing.T) {
	s := NewMemStore()
	const capVal int64 = 250
	res, err := RegisterWithFirstBuy(s, "wholecap", "wholecap", 1000, 1000, capVal, big.NewInt(capVal))
	if err != nil {
		t.Fatalf("taking the whole cap must be allowed (at full price): %v", err)
	}
	if res.FirstBuy.Cost.Cmp(Area(big.NewInt(capVal))) != 0 {
		t.Fatalf("cost = %s, want the full area %s", res.FirstBuy.Cost, Area(big.NewInt(capVal)))
	}
	// And the market is then full: nobody else can mint.
	if _, err := Buy(s, "latecomer", "wholecap", 1001, big.NewInt(1)); errSymbol(err) != ErrCap {
		t.Fatalf("buy into a capped-out market: err = %v, want CAP", err)
	}
}

// ---------------------------------------------------------------------------
// 4. HONESTY — what the atomic first buy does and does NOT bound
// ---------------------------------------------------------------------------

// TestLaunch_IsNotAntiSnipe_OptionalMeansTheBottomIsStillTakeable is the test
// that keeps the documentation honest. The atomic first buy is OPTIONAL, so
// at n == 0 a bot takes the bottom of the curve outright in the very next
// transaction — this test PROVES that and must never be "fixed".
//
// What actually holds the floor is BasePrice (params.go): the bot pays
// area(1) = 1,007 base units for that first token, not dust. Under a zero
// intercept the same token would cost a handful of units — RULING H's
// 100,000x free ride.
func TestLaunch_IsNotAntiSnipe_OptionalMeansTheBottomIsStillTakeable(t *testing.T) {
	s := NewMemStore()
	const creator = "declinedlaunch"
	// The creator registers and declines the first buy (the DEFAULT).
	if err := Register(s, creator, creator, 1000, 1000, 1_000_000); err != nil {
		t.Fatalf("Register: %v", err)
	}
	// A bot takes the bottom in the next transaction. This SUCCEEDS.
	bot, err := Buy(s, "snipebot", creator, 1000, big.NewInt(1))
	if err != nil {
		t.Fatalf("the bottom-of-curve snipe is NOT prevented and this test asserts so: %v", err)
	}
	if bot.Cost.Cmp(big.NewInt(1007)) != 0 {
		t.Fatalf("first-token cost = %s, want 1007 base units (BasePrice=1000 plus the curve's first step). "+
			"If this changed, the snipe economics in launch.go's header are stale and MUST be recomputed", bot.Cost)
	}
	if got := getMoney(s, kBal(creator, "snipebot")); got.Cmp(big.NewInt(1)) != 0 {
		t.Fatalf("the sniper holds %s, want 1", got)
	}
}

// TestLaunch_ResidualSnipeAdvantage_Pinned pins the exact numbers quoted in
// launch.go's header. They are the honest statement of what being first is
// worth on this curve; if the curve constants ever move, this fails and the
// documented claims must be recomputed rather than left to rot.
func TestLaunch_ResidualSnipeAdvantage_Pinned(t *testing.T) {
	cases := []struct {
		n, endSupply int64
		wantCost     int64
		wantProceeds int64
	}{
		{1, 1000, 1007, 11500},
		{1, 3000, 1007, 48250},
		{100, 1000, 140656, 1085893},
		{100, 3000, 140656, 4708918},
	}
	for _, c := range cases {
		n := big.NewInt(c.n)
		cost := Area(n) // the first n tokens, bought from an empty market
		if cost.Cmp(big.NewInt(c.wantCost)) != 0 {
			t.Fatalf("area(%d) = %s, want %d — launch.go's documented snipe economics are now WRONG and must be recomputed", c.n, cost, c.wantCost)
		}
		end := big.NewInt(c.endSupply)
		proceeds, err := SellProceeds(end, n)
		if err != nil {
			t.Fatal(err)
		}
		if proceeds.Cmp(big.NewInt(c.wantProceeds)) != 0 {
			t.Fatalf("sellProceeds(%d, %d) = %s, want %d — recompute launch.go's header", c.endSupply, c.n, proceeds, c.wantProceeds)
		}
		// The multiple is > 1 by a wide margin. Being early IS worth a lot
		// here; that is the RULED design (RULING I), not a defect.
		if proceeds.Cmp(cost) <= 0 {
			t.Fatalf("sanity: being first is not profitable at all — the curve constants have changed shape")
		}
	}
}

// TestLaunch_UnFrontRunnable_NoStateBetween documents (and pins) the ONE
// property the atomic first buy really has: there is no state in which the
// market is buyable and the creator's slice has not been taken. It rests on
// two guards in two different files, so it is asserted rather than assumed.
func TestLaunch_UnFrontRunnable_NoStateBetween(t *testing.T) {
	s := NewMemStore()
	const creator = "atomiccreator"
	// (a) Before the creator's transaction, the market is not buyable at all.
	if _, err := Buy(s, "frontrunner", creator, 1000, big.NewInt(1)); errSymbol(err) != ErrNotFound {
		t.Fatalf("pre-registration buy: err = %v, want NOT_FOUND — if a market is buyable before it is registered, the whole atomicity argument collapses", err)
	}
	// (b) Only the creator can register, so nobody else can open the window.
	if _, err := RegisterWithFirstBuy(s, "frontrunner", creator, 1000, 1000, 1_000_000, big.NewInt(1)); errSymbol(err) != ErrAuth {
		t.Fatalf("stranger registering someone else's market: err = %v, want AUTH", err)
	}
	// (c) The creator's own call registers AND mints in one transition: the
	// very first observable state already contains the creator's slice.
	res, err := RegisterWithFirstBuy(s, creator, creator, 1000, 1000, 1_000_000, big.NewInt(100))
	if err != nil {
		t.Fatalf("RegisterWithFirstBuy: %v", err)
	}
	if getU64(s, kRegisteredAt(creator)) == 0 {
		t.Fatal("market not registered")
	}
	if got := getMoney(s, kBal(creator, creator)); got.Cmp(big.NewInt(100)) != 0 {
		t.Fatalf("creator balance = %s, want 100 in the SAME transition as the registration", got)
	}
	if res.FirstBuy.Minted.Cmp(big.NewInt(100)) != 0 {
		t.Fatalf("minted = %s, want 100", res.FirstBuy.Minted)
	}
}

// TestLaunch_PerAccountNotPerOwner_SybilRingCanCornerALaunch is a
// DOCUMENTATION test (RULING H, binding: "say so, never claim otherwise").
// There is no per-account launch cap in this codebase; even if one is added
// later it will be per-ACCOUNT, and Hive accounts are cheap and unlimited. A
// ring of accounts corners the launch at full curve price, and this test
// exists so nobody can claim otherwise without a red build.
func TestLaunch_PerAccountNotPerOwner_SybilRingCanCornerALaunch(t *testing.T) {
	s := NewMemStore()
	const creator = "sybiltarget"
	if err := Register(s, creator, creator, 1000, 1000, 1_000_000); err != nil {
		t.Fatalf("Register: %v", err)
	}
	ring := []string{"sybil1", "sybil2", "sybil3", "sybil4", "sybil5"}
	spent := mZero()
	for i, acct := range ring {
		r, err := Buy(s, acct, creator, uint64(1000+i), big.NewInt(100))
		if err != nil {
			t.Fatalf("%s: %v", acct, err)
		}
		spent = mAdd(spent, r.TotalDue)
	}
	if got := getMoney(s, kSupply(creator)); got.Cmp(big.NewInt(500)) != 0 {
		t.Fatalf("supply = %s, want 500 — one owner behind five accounts took the first 500 tokens and NOTHING stopped them", got)
	}
	// The ONLY deterrent is the price they paid: the full curve area, plus
	// the full trade fee. State it, don't dress it up as an access control.
	wantCurve := Area(big.NewInt(500))
	if got := getMoney(s, kReserve(creator)); got.Cmp(wantCurve) != 0 {
		t.Fatalf("reserve = %s, want the full curve area %s — the ring paid full price (the only real deterrent)", got, wantCurve)
	}
	if spent.Cmp(wantCurve) <= 0 {
		t.Fatalf("the ring spent %s, which is not more than the curve area %s — the fee leg is missing", spent, wantCurve)
	}
}

// TestLaunch_ReRegistrationCanLaunchAgainOnACleanMarket — a returning creator
// gets the same optional launch on their fresh incarnation, and the fresh
// market starts from a genuinely empty curve (S=0, R=0) rather than
// inheriting anything.
func TestLaunch_ReRegistrationCanLaunchAgainOnACleanMarket(t *testing.T) {
	s := NewMemStore()
	const creator = "returninglaunch"
	regBlock := uint64(1000)
	if _, err := RegisterWithFirstBuy(s, creator, creator, regBlock, 1000, 10_000, big.NewInt(50)); err != nil {
		t.Fatalf("first launch: %v", err)
	}
	// Wind the market all the way down: retire, wait out the notice, refund.
	if err := Retire(s, creator, creator, regBlock+10); err != nil {
		t.Fatal(err)
	}
	windDown := regBlock + 10 + GraceBlocks
	if _, err := Refund(s, creator, creator, windDown, big.NewInt(50)); err != nil {
		t.Fatalf("wind-down refund: %v", err)
	}
	if !CloseIfDrained(s, creator, windDown) {
		t.Fatalf("CloseIfDrained: market not closed; supply=%s reserve=%s",
			getMoney(s, kSupply(creator)), getMoney(s, kReserve(creator)))
	}
	if got := getMoney(s, kReserve(creator)); !mIsZero(got) {
		t.Fatalf("reserve after a complete wind-down = %s, want 0 (C-24)", got)
	}

	// The fresh incarnation, with its own launch buy.
	reReg := windDown + 100
	res, err := RegisterWithFirstBuy(s, creator, creator, reReg, 2000, 20_000, big.NewInt(10))
	if err != nil {
		t.Fatalf("re-registration with a launch buy: %v", err)
	}
	if res.FirstBuy.Cost.Cmp(Area(big.NewInt(10))) != 0 {
		t.Fatalf("the new incarnation priced its launch off a non-empty curve: cost = %s, want area(10) = %s",
			res.FirstBuy.Cost, Area(big.NewInt(10)))
	}
	if got := getMoney(s, kSupply(creator)); got.Cmp(big.NewInt(10)) != 0 {
		t.Fatalf("supply = %s, want exactly the new launch's 10 (no inherited supply)", got)
	}
	if got := getMoney(s, kReserve(creator)); got.Cmp(Area(big.NewInt(10))) != 0 {
		t.Fatalf("reserve = %s, want area(10) = %s — R === area(S) must hold on a fresh incarnation", got, Area(big.NewInt(10)))
	}
}
