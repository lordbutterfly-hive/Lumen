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
// ★★ WAS "PINNED RESIDUAL", NOW A REGRESSION PIN — THE BLENDED CLOCK NO LONGER
// LAUNDERS, AND NO LONGER MIS-REPORTS (single account, no transfer)
// ---------------------------------------------------------------------------
//
// THE HISTORY, KEPT IN FULL because this test has been wrong twice and the
// record is the point of it:
//
//  1. It began as the ALREADY-ACCEPTED "accelerated maturation" residual, pinned
//     with real numbers because the recorded framing ("1000 matured + 100 fresh
//     => the fresh reach 0% in ~3.8 days") badly understated it, and because a
//     2026-08-12 session briefly mis-attributed it to TransferCredits and
//     shipped a fix that closed only a ONE-BLOCK window before reverting it.
//  2. THE MECHANISM it recorded: a maturing position carried exactly ONE blended
//     clock for the whole balance (holdclock.go), so buying fresh tokens into a
//     large, nearly-matured pile dragged the fresh tokens' effective age up to
//     the blend. graduate() only fires at age >= ExitTaxDecayBlocks EXACTLY, so
//     it did not help one block below the window. No transfer, no second
//     account, no waiting were required.
//  3. PRICE-1 (2026-09-08) CLOSED THE MONEY with the per-cohort `lots|` ledger:
//     the fresh cohort is taxed at ITS OWN rate on ITS OWN marginal top slice,
//     so the aged pile can no longer pull it down. Measured on the fixed tree by
//     zz_residual_check_test.go: the charge is 395,326,266,413 base units,
//     EXACTLY ExitTaxOn(taxableGross, MaxExitTaxBps).
//  4. TAXBPS-DISPLAY (2026-09-08, this change) CLOSED THE LABEL. Step 3 left the
//     REPORTED rate on the stale blended summary, so this exact position quoted
//     TaxBps == 2 beside a Tax that was the full 1500 bps — a ~750x
//     understatement of the rate next to an exactly-correct amount, carried into
//     the event log, the quoteSell preview and every integrator.
//     SellResult.TaxBps is now the slice-weighted EFFECTIVE rate
//     (holdclock_lots.go maturingCohortTax).
//
// So this test is INVERTED rather than deleted: it now fails if either half ever
// comes back. Deleting it would have thrown away the only pin on a defect that
// has already been "fixed" and un-fixed once.
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

	// NON-VACUITY: the blended clock really is still diluted here — this position
	// IS the laundering shape, and the test would prove nothing if it were not.
	blendBps := ExitTaxBpsAt(heldBlocksAt(s, c, whale, at))
	if blendBps >= MaxExitTaxBps {
		t.Fatalf("non-vacuity: the blended clock reads %d bps, so the pile is NOT diluting it "+
			"and this fixture no longer exercises the laundering shape", blendBps)
	}

	// HALF 1 — THE MONEY. The whole draw comes from the fresh cohort, so the
	// charge is the FULL rate on the whole taxable base, to the base unit.
	wantTax := ExitTaxOn(q.TaxableGross, MaxExitTaxBps)
	if q.Tax.Cmp(wantTax) != 0 {
		t.Errorf("PRICE-1 REGRESSION: tax %s, want %s (full %d bps on taxableGross %s); "+
			"the aged pile is diluting the fresh cohort's charge again",
			q.Tax, wantTax, MaxExitTaxBps, q.TaxableGross)
	}

	// HALF 2 — THE LABEL. The reported rate must describe that charge, not the
	// blended summary it used to be read from.
	if q.TaxBps != MaxExitTaxBps {
		t.Errorf("TAXBPS-DISPLAY REGRESSION: reported TaxBps %d, want %d — the whole draw is "+
			"one maximally-fresh cohort, so the effective rate IS the full rate. "+
			"(blended clock reads %d bps; if TaxBps has gone back to reading THAT, "+
			"the quote and the event are lying next to a correct amount again)",
			q.TaxBps, MaxExitTaxBps, blendBps)
	}

	t.Logf("CLOSED, both halves: pile=%d fresh=%d one block below the window -> "+
		"tax=%s on taxableGross=%s (full %d bps), reported TaxBps=%d, "+
		"while the stale blended clock still reads %d bps",
		P, F, q.Tax, q.TaxableGross, MaxExitTaxBps, q.TaxBps, blendBps)
}
