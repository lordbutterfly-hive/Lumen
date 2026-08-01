package market

import "testing"

// F-P3 — the settlement price must be bounded by the SAME range RollRound
// applies to the reference price. Before the fix, `settle` trusted whatever
// pendulum.hive_moving_avg_bps held as long as the feed's liveness flags were
// set, and bucketFor(0, strikes) resolves to bucket 0 — so a healthy-looking
// feed emitting a degenerate value paid the entire pool to the "-30% or worse"
// outcome, silently and irreversibly.
//
// The harness round (market_test.go setup) has strikes [10000] and settleBlock
// 4000, so a real price of 12000 wins outcome 1 while a garbage 0 wins outcome
// 0 — the flip is the whole finding, which is why the control case below runs
// the same round with a sane price.

func TestFP3_ZeroPriceDoesNotSettle(t *testing.T) {
	s, id := setup(t)
	bet(t, s, "a", id, 1, "10000")
	bet(t, s, "b", id, 0, "10000")

	// feedOK is TRUE here — this is the case the old code had no answer for.
	if _, err := Settle(s, "k", 4000, id, 0, 4000, true); err == nil {
		t.Fatal("settle accepted a zero oracle price — the whole pool would pay bucket 0")
	}
	if roundState(s, id) != StateOpen {
		t.Fatal("round must stay OPEN so a later tick (or voidStale) can resolve it")
	}
}

func TestFP3_OutOfRangePriceDoesNotSettle(t *testing.T) {
	s, id := setup(t)
	bet(t, s, "a", id, 1, "10000")
	bet(t, s, "b", id, 0, "10000")

	if _, err := Settle(s, "k", 4000, id, MaxReferenceBps+1, 4000, true); err == nil {
		t.Fatal("settle accepted a price above MaxReferenceBps")
	}
	if roundState(s, id) != StateOpen {
		t.Fatal("round must stay OPEN after an out-of-range price")
	}
}

// Control: the guard must not have narrowed the legitimate settlement path.
// MaxReferenceBps is ~HIVE at $10,000, so every real price still settles — and
// it settles to the OTHER outcome than the degenerate cases above.
func TestFP3_SanePriceStillSettles(t *testing.T) {
	s, id := setup(t)
	bet(t, s, "a", id, 1, "10000")
	bet(t, s, "b", id, 0, "10000")

	res, err := Settle(s, "k", 4000, id, 12000, 4000, true)
	if err != nil {
		t.Fatalf("a sane price must still settle: %v", err)
	}
	if res.State != StateSettled {
		t.Fatalf("expected SETTLED, got %q", res.State)
	}
	if res.Winner != 1 {
		t.Fatalf("price 12000 is above strike 10000 → outcome 1, got %d", res.Winner)
	}
}

// The upper bound itself must remain settleable — an exclusive-vs-inclusive
// slip here would silently void real rounds at the boundary.
func TestFP3_BoundaryPriceIsAccepted(t *testing.T) {
	s, id := setup(t)
	bet(t, s, "a", id, 1, "10000")
	bet(t, s, "b", id, 0, "10000")

	if _, err := Settle(s, "k", 4000, id, MaxReferenceBps, 4000, true); err != nil {
		t.Fatalf("MaxReferenceBps itself must settle (bound is inclusive): %v", err)
	}
}
