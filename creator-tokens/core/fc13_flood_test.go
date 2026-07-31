package core

import (
	"math/big"
	"testing"
)

// fc13_flood_test.go — F-C13 pin (LATENT · LOW).
//
// THE FINDING. A hostile asker (a rival creator, say) can FLOOD a creator with
// junk asks, ignore their own asks, and reclaim them — driving up the miss
// count until the delivery gate convicts the creator and REFUSES their market's
// inflows for a penalty window (delivery.go / RequireInflowOpen). Three junk
// asks are enough to freeze someone else's storefront for a week. That griefing
// nuisance is real and is why F-C13 exists.
//
// WHY IT IS ONLY LOW, PINNED HERE. The gate is documented to touch INFLOWS ONLY
// and never an outflow ("delivery standing is deliberately checked ONLY inside
// RequireInflowOpen" — delivery.go). So the flood:
//
//  1. does NOT touch the flooded creator's funds — the reserve, the creator's
//     claimable fee pot, and the creator's own token balance are byte-identical
//     before and after the whole flood+conviction;
//  2. costs the ATTACKER, not the victim — each manufactured miss retains a
//     slice of the attacker's own commission to the treasury (RULING 1);
//  3. leaves every OUTFLOW rail open while frozen (answer an in-flight ask,
//     sell, claim fees) — the creator is never trapped; and
//  4. SELF-RESTORES: inflows reopen automatically at the end of the penalty
//     window with a clean sheet, with no renewal, no admin action, nothing —
//     purely the passage of block height.
//
// If any of those four ever stops holding, F-C13 is no longer LOW and this test
// says so loudly.
func TestFC13_FloodedCreatorFundsUntouched(t *testing.T) {
	s, at := dgSetup(t)

	// Give the flooded creator real, money-bearing state the flood could be
	// accused of touching: a claimable trade-fee pot and their own token
	// holding. (dgSetup already set the curve reserve via curveMarket.)
	setMoney(s, kFeeBal(creator1), big.NewInt(4242))
	setMoney(s, kBal(creator1, creator1), big.NewInt(7777))

	// A genuine paying customer's ask, placed BEFORE the flood, that will still
	// be in flight when the creator is frozen — the realistic straddle. It is an
	// inflow, so it must be accepted here, while the creator is still in good
	// standing.
	commission := commissionOwedFor(big.NewInt(9090))
	inflight, err := askAt0(s, asker1, creator1, at, big.NewInt(1000), commission, "realcustomer", MaxAskDeadline)
	if err != nil {
		t.Fatalf("in-flight customer ask (pre-flood): %v", err)
	}

	// Snapshot the creator's funds the instant before the flood. A pending ask
	// (the in-flight one above) does not touch any of these.
	reserveBefore := getMoney(s, kReserve(creator1))
	feeBefore := getMoney(s, kFeeBal(creator1))
	ownBalBefore := getMoney(s, kBal(creator1, creator1))
	treasuryBefore := getMoney(s, kTreasury())

	// THE FLOOD. Three junk asks by the hostile asker, each ignored to deadline
	// and reclaimed — the cheapest attack that trips the gate (MinMissesForDelinquency).
	for i := 0; i < 3; i++ {
		at = dgMiss(t, s, at) + 1
	}

	// The grief SUCCEEDED at what it can do: the creator is convicted and their
	// inflows are shut for the penalty window.
	delinquent, until := DeliveryStanding(s, creator1, at)
	if !delinquent {
		t.Fatal("setup failed: the flood did not convict the creator")
	}
	if err := RequireInflowOpen(s, creator1, at); err == nil {
		t.Fatal("setup failed: inflows are still open on a convicted creator")
	}

	// (1) FUNDS UNTOUCHED. The flood moved none of the creator's money.
	if got := getMoney(s, kReserve(creator1)); got.Cmp(reserveBefore) != 0 {
		t.Fatalf("flood moved the creator's RESERVE: %s -> %s", reserveBefore, got)
	}
	if got := getMoney(s, kFeeBal(creator1)); got.Cmp(feeBefore) != 0 {
		t.Fatalf("flood moved the creator's claimable FEE pot: %s -> %s", feeBefore, got)
	}
	if got := getMoney(s, kBal(creator1, creator1)); got.Cmp(ownBalBefore) != 0 {
		t.Fatalf("flood moved the creator's OWN token balance: %s -> %s", ownBalBefore, got)
	}

	// (2) THE ATTACKER BORE THE COST. Each manufactured miss retained a slice of
	// the ATTACKER's commission to the treasury — the treasury strictly grew, and
	// not one unit of it reached the creator (checked via the untouched fee pot
	// above). The flood is a self-funded nuisance, not an extraction.
	if got := getMoney(s, kTreasury()); got.Cmp(treasuryBefore) <= 0 {
		t.Fatalf("treasury did not grow (%s -> %s) — a flood that costs the attacker nothing would make this cheaper than LOW", treasuryBefore, got)
	}

	// CLEAN SHEET ON CONVICTION. The penalty is served once, not re-triggered by
	// the same three misses: crossing the threshold zeroes the counters. Asserted
	// HERE, before the outflow demonstration below (answering the in-flight ask
	// legitimately adds a delivery and would move the record off 0/0).
	if misses, delivered := DeliveryRecord(s, creator1); misses != 0 || delivered != 0 {
		t.Fatalf("conviction did not reset the record to a clean sheet: %d misses / %d delivered", misses, delivered)
	}

	// (3) NOT TRAPPED — every outflow rail is open while frozen. These DO change
	// balances (they are the creator's own voluntary exits), which is exactly the
	// point: the frozen creator can still get their money and serve real
	// customers. Run them only after the funds-untouched snapshot above.
	if _, err := Answer(s, creator1, creator1, at, inflight.Seq, "ans"); err != nil {
		t.Fatalf("frozen creator could not ANSWER the in-flight paying customer — the flood trapped a live escrow: %v", err)
	}
	if _, err := Sell(s, asker1, creator1, at, big.NewInt(10)); err != nil {
		t.Fatalf("frozen creator's market refused a holder's SELL — an outflow was gated by delinquency: %v", err)
	}
	if _, err := ClaimTradeFees(s, creator1); err != nil {
		t.Fatalf("frozen creator could not CLAIM their fee pot — an outflow was gated by delinquency: %v", err)
	}

	// (4) SELF-RESTORE. The subscription stays paid across the whole window
	// (dgSetup paid it far into the future), so nothing but block height changes:
	// at the window's own end block the gate lifts on its own with a clean sheet.
	paidUntil := getU64(s, kPaidUntil(creator1))
	if until >= paidUntil {
		t.Fatalf("test premise broken: penalty window end %d is not strictly before the subscription expiry %d, so self-restore would be confounded by a lapse", until, paidUntil)
	}
	// One block before the end: still frozen.
	if delinquent, _ := DeliveryStanding(s, creator1, until-1); !delinquent {
		t.Fatalf("penalty lifted early at %d (window ends %d)", until-1, until)
	}
	// At the end block: reopened, automatically, with nobody doing anything.
	if delinquent, _ := DeliveryStanding(s, creator1, until); delinquent {
		t.Fatalf("penalty still in force at its own end block %d — the freeze is not self-limiting", until)
	}
	if err := RequireInflowOpen(s, creator1, until); err != nil {
		t.Fatalf("inflows did not self-restore at the window end: %v", err)
	}
}
