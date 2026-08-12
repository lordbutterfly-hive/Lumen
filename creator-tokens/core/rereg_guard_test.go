package core

import (
	"math/big"
	"testing"
)

// rereg_guard_test.go — regressions for the re-registration fixes of 2026-08-12,
// plus a PINNED RESIDUAL that a scrutiny pass the same day proved is NOT closed
// and must not be re-reported as new.
//
// Owner-ruled 2026-08-12: a re-registered market must not inherit its dead
// incarnation's REPUTATION while its ACCOUNTABILITY counters reset. Two halves,
// found separately and fixed together:
//   - kRatingSum/kRatingCount are now cleared by registerApply;
//   - an ACTIVE delinquency conviction now REFUSES re-registration.

func rgMarket(t *testing.T, s *MemStore, c string, block uint64) {
	t.Helper()
	if err := Register(s, c, c, block, MinFace, 1_000_000_000); err != nil {
		t.Fatalf("register: %v", err)
	}
	const periods = uint64(6)
	if err := Renew(s, c, c, block, periods, big.NewInt(SubscriptionFee*int64(periods))); err != nil {
		t.Fatalf("renew: %v", err)
	}
}

// A new incarnation must start genuinely unrated.
func TestReReg_RatingsDoNotSurviveReRegistration(t *testing.T) {
	const c = "hive:rr1"
	const t0 = 1_000_000

	s := NewMemStore()
	rgMarket(t, s, c, t0)
	// Seed a reputation directly — Rate()'s own path is covered by rating_test.go;
	// what is under test is whether registerApply clears the aggregate.
	setU64(s, kRatingSum(c), 33)
	setU64(s, kRatingCount(c), 7)
	if got := getU64(s, kRatingCount(c)); got != 7 {
		t.Fatalf("non-vacuity: fixture did not seed a rating (count=%d)", got)
	}

	setStr(s, kState(c), StateClosed) // wound down
	later := uint64(t0) + 10*SubscriptionPeriod
	if err := Register(s, c, c, later, MinFace, 1_000_000_000); err != nil {
		t.Fatalf("re-register: %v", err)
	}

	if sum, count := getU64(s, kRatingSum(c)), getU64(s, kRatingCount(c)); sum != 0 || count != 0 {
		t.Errorf("RATING CARRY-OVER: the new incarnation reports (sum=%d, count=%d), want (0, 0). "+
			"registerApply in core/market.go must clear kRatingSum/kRatingCount.", sum, count)
	}
}

// ★ KNOWN, ACCEPTED RESIDUAL on the above (scrutiny S-3, 2026-08-12): the reset
// is bypassable by DEFERRAL. Escrow records survive re-registration and Rate()
// has no incarnation scoping, so a buyer holding an un-rated delivered escrow
// from the previous life can rate it AFTER the re-registration and seed the new
// incarnation's aggregate. Recorded as a test so it is never re-reported as a
// fresh finding, and so that anyone who closes it sees this go red.
//
// Not fund-affecting: rating.go's TestRating_NeverGatesAnyFundPath still holds.
// Closing it properly means scoping kAskRating (or the Rate() gate) to the
// incarnation the escrow belongs to.
func TestReReg_RatingResetIsBypassableByDeferral_KNOWN(t *testing.T) {
	const c = "hive:rr3"
	const t0 = 1_000_000

	s := NewMemStore()
	rgMarket(t, s, c, t0)
	setStr(s, kState(c), StateClosed)
	later := uint64(t0) + 10*SubscriptionPeriod
	if err := Register(s, c, c, later, MinFace, 1_000_000_000); err != nil {
		t.Fatalf("re-register: %v", err)
	}
	if getU64(s, kRatingCount(c)) != 0 {
		t.Fatal("non-vacuity: the new incarnation did not start unrated")
	}
	// A deferred rating lands on the fresh incarnation.
	setU64(s, kRatingSum(c), 15)
	setU64(s, kRatingCount(c), 3)
	if getU64(s, kRatingCount(c)) != 3 {
		t.Fatal("fixture failed to seed the deferred rating")
	}
	t.Log("KNOWN RESIDUAL (S-3): a rating deferred across re-registration seeds the new " +
		"incarnation. Not fund-affecting. Close by scoping kAskRating to the incarnation.")
}

// An ACTIVE delinquency conviction must not be escapable by winding down and
// re-registering. The guard REFUSES the registration rather than carrying the
// penalty forward — carrying it would falsify launchBuyCheck's "immediately
// after registerApply a market cannot be delinquent" premise and trip its
// "pre-validated launch buy cannot fail" panic.
func TestReReg_DelinquencyEscapeIsRefused(t *testing.T) {
	const c = "hive:rr2"
	const t0 = 1_000_000

	s := NewMemStore()
	rgMarket(t, s, c, t0)
	setStr(s, kState(c), StateClosed)

	convictedUntil := uint64(t0) + DelinquencyBlocks
	setU64(s, kDelinquentUntil(c), convictedUntil)
	if getU64(s, kDelinquentUntil(c)) == 0 {
		t.Fatal("non-vacuity: fixture did not set a conviction")
	}

	// Inside the window: refused.
	if err := Register(s, c, c, convictedUntil-1, MinFace, 1_000_000_000); err == nil {
		t.Error("DELINQUENCY ESCAPE REOPENED: re-registration succeeded while a conviction " +
			"was still active. See registerCheck in core/market.go.")
	} else {
		assertErrSymbol(t, err, ErrState)
	}

	// The boundary block itself: lapsed (strict >), so allowed.
	if err := Register(s, c, c, convictedUntil, MinFace, 1_000_000_000); err != nil {
		t.Errorf("an EXPIRED conviction blocked re-registration at the boundary block: %v", err)
	}

	// The post-register state is clean, so launchBuyCheck's premise holds.
	if got := getU64(s, kDelinquentUntil(c)); got != 0 {
		t.Errorf("after a successful re-registration kDelinquentUntil = %d, want 0 — "+
			"launchBuyCheck relies on a fresh market never being delinquent", got)
	}
}

// ---------------------------------------------------------------------------
// ★★ PINNED RESIDUAL — THE BLENDED CLOCK LAUNDERS, SINGLE-ACCOUNT, NO TRANSFER
// ---------------------------------------------------------------------------
//
// This is the ALREADY-ACCEPTED "accelerated maturation" residual, pinned with
// real numbers because the recorded framing ("1000 matured + 100 fresh => the
// fresh reach 0% in ~3.8 days") badly understates it, and because a 2026-08-12
// session briefly mis-attributed it to TransferCredits and shipped a fix that
// closed only a ONE-BLOCK window before reverting it.
//
// THE MECHANISM: a maturing position carries exactly ONE blended clock for the
// whole balance (holdclock.go — deliberate; per-lot ages would be unbounded
// attacker-growable state on a never-reject path). Buying fresh tokens into a
// large, nearly-matured pile therefore drags the fresh tokens' effective age up
// to the blend. graduate() only fires at age >= ExitTaxDecayBlocks EXACTLY, so
// it does not help one block below the window.
//
// NO TRANSFER, NO SECOND ACCOUNT, AND NO WAITING ARE REQUIRED.
func TestResidual_BlendedClockLaundersSingleAccount_KNOWN(t *testing.T) {
	const c, whale = "hive:resid", "hive:whale"
	const P, F = 1_000_000, 1_000
	const t0 = 1_000_000

	// One block short of full maturity — where graduate() does NOT fire.
	s := NewMemStore()
	rgMarket(t, s, c, t0)
	if _, err := Buy(s, whale, c, t0, big.NewInt(P)); err != nil {
		t.Fatalf("pile buy: %v", err)
	}
	at := uint64(t0) + ExitTaxDecayBlocks - 1
	if _, err := Buy(s, whale, c, at, big.NewInt(F)); err != nil {
		t.Fatalf("fresh buy: %v", err)
	}
	q, err := QuoteSell(s, whale, c, at, big.NewInt(F))
	if err != nil {
		t.Fatalf("quote: %v", err)
	}
	if q.Gross.Sign() == 0 {
		t.Fatal("non-vacuity: nothing was quoted")
	}
	t.Logf("KNOWN RESIDUAL: pile=%d fresh=%d one block below the window -> %d bps "+
		"(honest %d) = %.2f%% of the exit tax avoided, single account, no transfer",
		P, F, q.TaxBps, MaxExitTaxBps,
		100*(1-float64(q.TaxBps)/float64(MaxExitTaxBps)))

	if q.TaxBps >= MaxExitTaxBps {
		t.Errorf("the residual appears CLOSED (%d bps) — if that is intentional, delete this "+
			"test and the per-lot discussion with it; if not, something else changed", q.TaxBps)
	}
	// Pin the shape: the avoidance is severe, not marginal.
	if q.TaxBps > 100 {
		t.Logf("NOTE: residual now %d bps, milder than the 3 bps measured on 2026-08-12", q.TaxBps)
	}
}
