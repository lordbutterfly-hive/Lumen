package sim

import (
	"math/big"
	"testing"

	"hive-price-market/market"
)

// ---------------------------------------------------------------------------
// Oracle determinism
// ---------------------------------------------------------------------------

func TestOracle_DeterministicGivenSeed(t *testing.T) {
	cfg := DefaultOracleConfig()
	o1 := NewOracle(subRand(7, "oracle-init"), cfg)
	o2 := NewOracle(subRand(7, "oracle-init"), cfg)
	for _, b := range []uint64{0, 50, 100, 250, 10000, 1_000_000} {
		p1, ok1, tb1, f1 := o1.LatestKnownAt(b)
		p2, ok2, tb2, f2 := o2.LatestKnownAt(b)
		if p1 != p2 || ok1 != ok2 || tb1 != tb2 || f1 != f2 {
			t.Fatalf("oracle not deterministic at block %d: (%d,%v,%d,%v) vs (%d,%v,%d,%v)", b, p1, ok1, tb1, f1, p2, ok2, tb2, f2)
		}
	}
}

func TestOracle_OutOfOrderQueriesAreCacheConsistent(t *testing.T) {
	o := NewOracle(subRand(11, "x"), DefaultOracleConfig())
	// Query a far tick FIRST, then earlier ticks — must not perturb earlier
	// cached values (every tick, once generated, is immutable).
	pFar, _, tbFar, _ := o.LatestKnownAt(500_000)
	pEarly, _, tbEarly, _ := o.LatestKnownAt(1000)
	pFar2, _, tbFar2, _ := o.LatestKnownAt(500_000)
	pEarly2, _, tbEarly2, _ := o.LatestKnownAt(1000)
	if pFar != pFar2 || tbFar != tbFar2 {
		t.Fatalf("far tick changed on re-query: (%d,%d) vs (%d,%d)", pFar, tbFar, pFar2, tbFar2)
	}
	if pEarly != pEarly2 || tbEarly != tbEarly2 {
		t.Fatalf("early tick changed after a later query: (%d,%d) vs (%d,%d)", pEarly, tbEarly, pEarly2, tbEarly2)
	}
}

// ---------------------------------------------------------------------------
// Population runs — all three keeper profiles, short + full-year, asserting
// zero invariant violations (the harness halts loudly on the first one, so
// err==nil here already means "every assertion held for the whole run").
// ---------------------------------------------------------------------------

func TestSim_ShortRun_AllProfiles_NoViolations(t *testing.T) {
	for _, kp := range []KeeperProfile{KeeperReliable, KeeperLate, KeeperAbsent} {
		kp := kp
		t.Run(kp.String(), func(t *testing.T) {
			cfg := DefaultConfig()
			cfg.Seed = 1
			cfg.Weeks = 10
			cfg.Keeper = kp
			s := NewSimulator(cfg)
			report, err := s.Run()
			if err != nil {
				t.Fatalf("Run() returned an invariant violation: %v", err)
			}
			if report.RoundsRolled == 0 {
				t.Fatal("no rounds were ever rolled")
			}
			t.Logf("keeper=%s rolled=%d settled=%d void=%d (%.1f%%) staked=%s paid=%s swept=%s",
				kp, report.RoundsRolled, report.RoundsSettled, report.RoundsVoid, report.VoidRate()*100,
				report.TotalStaked, report.TotalPaid, report.TotalSwept)
		})
	}
}

func TestSim_FullYear_AllProfiles_NoViolations_AndVoidGradient(t *testing.T) {
	if testing.Short() {
		t.Skip("full-year run skipped in -short mode")
	}
	seed := int64(42)
	var reports []*Report
	for _, kp := range []KeeperProfile{KeeperReliable, KeeperLate, KeeperAbsent} {
		cfg := DefaultConfig()
		cfg.Seed = seed
		cfg.Weeks = 52
		cfg.Keeper = kp
		s := NewSimulator(cfg)
		report, err := s.Run()
		if err != nil {
			t.Fatalf("keeper=%s: Run() returned an invariant violation: %v", kp, err)
		}
		reports = append(reports, report)
		t.Logf("keeper=%-9s rolled=%d settled=%d void=%d (void-rate %.1f%%) via-settle=%d via-voidStale=%d via-reclaim=%d staked=%s paid=%s swept=%s",
			kp, report.RoundsRolled, report.RoundsSettled, report.RoundsVoid, report.VoidRate()*100,
			report.ResolvedViaSettleCall, report.ResolvedViaVoidStale, report.ResolvedViaReclaim,
			report.TotalStaked, report.TotalPaid, report.TotalSwept)
		for reason, n := range report.RoundsVoidByReason {
			t.Logf("  void reason %-20s x%d", reason, n)
		}
	}
	reliable, late, absent := reports[0], reports[1], reports[2]
	// The headline finding this simulator exists to produce: settle
	// timeliness alone (same population, same oracle path, same seed) drives
	// the VOID rate, and an absent keeper is fatal to the market.
	if !(reliable.VoidRate() < late.VoidRate()) {
		t.Fatalf("expected reliable void-rate (%.3f) < late void-rate (%.3f)", reliable.VoidRate(), late.VoidRate())
	}
	if !(late.VoidRate() < absent.VoidRate()) {
		t.Fatalf("expected late void-rate (%.3f) < absent void-rate (%.3f)", late.VoidRate(), absent.VoidRate())
	}
	if absent.VoidRate() < 0.99 {
		t.Fatalf("expected an absent keeper to void essentially every round (zero settle bounty ⇒ nobody else has an incentive to settle); got %.3f", absent.VoidRate())
	}
	if absent.RoundsSettled != 0 {
		t.Fatalf("an absent keeper should never produce a genuine SETTLED round; got %d", absent.RoundsSettled)
	}
	if absent.ResolvedViaReclaim != absent.RoundsRolled {
		t.Fatalf("every round should resolve via the Reclaim fail-safe under an absent keeper; resolvedViaReclaim=%d rolled=%d",
			absent.ResolvedViaReclaim, absent.RoundsRolled)
	}
}

// ---------------------------------------------------------------------------
// Dedicated, deterministic proofs for every VOID path + the fail-safes —
// NOT left to population-run luck. Each drives the real market package
// directly (through this package's own Store/RoundView helpers, exactly as
// the population harness does) and proves conservation to the base unit.
// ---------------------------------------------------------------------------

func newTestStore(t *testing.T) market.Store {
	t.Helper()
	s := NewMemStore()
	if err := market.Init(s, "hive:deployer"); err != nil {
		t.Fatalf("Init: %v", err)
	}
	return s
}

func bigFromStr(t *testing.T, s string) *big.Int {
	t.Helper()
	v, ok := new(big.Int).SetString(s, 10)
	if !ok {
		t.Fatalf("bad amount %q", s)
	}
	return v
}

// assertRoundFullyDrained claims/reclaims for every account with a stake in
// the round, then asserts owed==0 (checkFinalDrain) and Σ paid == pool for a
// void round / == pool for a zero-rake settled round, to the exact base
// unit.
func assertRoundFullyDrainedByClaims(t *testing.T, s market.Store, id uint64, accounts []string) *big.Int {
	t.Helper()
	rv := ReadRound(s, id)
	total := big.NewInt(0)
	for _, acct := range accounts {
		payout, _, err := market.Claim(s, acct, id)
		if err != nil {
			t.Fatalf("claim %s: %v", acct, err)
		}
		total.Add(total, payout)
	}
	if total.Cmp(rv.Pool) != 0 {
		t.Fatalf("Σ claims %s != pool %s (round %d, state %s, reason %q)", total, rv.Pool, id, rv.State, rv.VoidReason)
	}
	if err := checkFinalDrain(s, id); err != nil {
		t.Fatal(err)
	}
	return total
}

func TestVoidPath_Underfunded_EveryoneMadeWhole(t *testing.T) {
	s := newTestStore(t)
	id, err := market.RollRound(s, 1000, 2940, true)
	if err != nil {
		t.Fatal(err)
	}
	rv := ReadRound(s, id)
	// Only ONE outcome ever gets staked — <2 funded outcomes ⇒ VoidUnderfunded.
	if err := market.RecordBet(s, "alice", rv.Lock-1, id, 3, bigFromStr(t, "50000")); err != nil {
		t.Fatal(err)
	}
	if err := market.RecordBet(s, "bob", rv.Lock-1, id, 3, bigFromStr(t, "25000")); err != nil {
		t.Fatal(err)
	}
	tick := 3474 // arbitrary; underfunded is checked before the winner lookup
	res, err := market.Settle(s, "keeper", rv.Settle, id, uint64(tick), rv.Settle, true)
	if err != nil {
		t.Fatal(err)
	}
	if res.State != market.StateVoid || res.Reason != market.VoidUnderfunded {
		t.Fatalf("expected VOID(underfunded), got state=%s reason=%s", res.State, res.Reason)
	}
	total := assertRoundFullyDrainedByClaims(t, s, id, []string{"alice", "bob"})
	if total.Cmp(bigFromStr(t, "75000")) != 0 {
		t.Fatalf("total refund %s, want 75000", total)
	}
}

func TestVoidPath_ZeroWinner_EveryoneMadeWhole(t *testing.T) {
	s := newTestStore(t)
	id, err := market.RollRound(s, 1000, 2940, true)
	if err != nil {
		t.Fatal(err)
	}
	rv := ReadRound(s, id)
	// Fund buckets 0..2 and 4..6, but leave bucket 3 (the middle, which will
	// win) completely empty.
	accts := []string{}
	amt := bigFromStr(t, "9000")
	for _, k := range []int{0, 1, 2, 4, 5, 6} {
		acct := "staker" + string(rune('A'+k))
		if err := market.RecordBet(s, acct, rv.Lock-1, id, k, amt); err != nil {
			t.Fatal(err)
		}
		accts = append(accts, acct)
	}
	// price inside [strikes[2], strikes[3]) → bucket 3, which nobody staked.
	mid := (rv.Strikes[2] + rv.Strikes[3]) / 2
	res, err := market.Settle(s, "keeper", rv.Settle, id, mid, rv.Settle, true)
	if err != nil {
		t.Fatal(err)
	}
	if res.State != market.StateVoid || res.Reason != market.VoidZeroWinner {
		t.Fatalf("expected VOID(zero_winner), got state=%s reason=%s winner=%d", res.State, res.Reason, res.Winner)
	}
	total := assertRoundFullyDrainedByClaims(t, s, id, accts)
	want := new(big.Int).Mul(amt, big.NewInt(int64(len(accts))))
	if total.Cmp(want) != 0 {
		t.Fatalf("total refund %s, want %s", total, want)
	}
}

func TestVoidPath_WindowLapsed_EveryoneMadeWhole(t *testing.T) {
	s := newTestStore(t)
	id, err := market.RollRound(s, 1000, 2940, true)
	if err != nil {
		t.Fatal(err)
	}
	rv := ReadRound(s, id)
	if err := market.RecordBet(s, "alice", rv.Lock-1, id, 2, bigFromStr(t, "10000")); err != nil {
		t.Fatal(err)
	}
	if err := market.RecordBet(s, "bob", rv.Lock-1, id, 5, bigFromStr(t, "20000")); err != nil {
		t.Fatal(err)
	}
	// Nobody settles in the window at all; the FIRST call ever made is past
	// settle+SettleWindowBlocks — the auto-void fires unconditionally,
	// needing NO oracle read at all (proves the "zero oracle dependency"
	// property DEPLOY-RUNBOOK.md's Keeper note documents).
	late := rv.Settle + market.SettleWindowBlocks + 1
	res, err := market.Settle(s, "anyone", late, id, 0, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.State != market.StateVoid || res.Reason != market.VoidWindowLapsed {
		t.Fatalf("expected VOID(window_lapsed), got state=%s reason=%s", res.State, res.Reason)
	}
	total := assertRoundFullyDrainedByClaims(t, s, id, []string{"alice", "bob"})
	if total.Cmp(bigFromStr(t, "30000")) != 0 {
		t.Fatalf("total refund %s, want 30000", total)
	}
}

func TestVoidPath_TickWindowMissed_EveryoneMadeWhole(t *testing.T) {
	s := newTestStore(t)
	id, err := market.RollRound(s, 1000, 2940, true)
	if err != nil {
		t.Fatal(err)
	}
	rv := ReadRound(s, id)
	if err := market.RecordBet(s, "alice", rv.Lock-1, id, 1, bigFromStr(t, "12000")); err != nil {
		t.Fatal(err)
	}
	if err := market.RecordBet(s, "bob", rv.Lock-1, id, 4, bigFromStr(t, "8000")); err != nil {
		t.Fatal(err)
	}
	// Still inside the outer window, but the reported tick is past the
	// single qualifying tick — a genuinely healthy feed that simply wasn't
	// read in time.
	callBlock := rv.Settle + 50
	tick := rv.Settle + market.MaxSettleTickLag // first DISqualified tick
	res, err := market.Settle(s, "keeper", callBlock, id, 3300, tick, true)
	if err != nil {
		t.Fatal(err)
	}
	if res.State != market.StateVoid || res.Reason != market.VoidTickWindowMissed {
		t.Fatalf("expected VOID(tick_window_missed), got state=%s reason=%s", res.State, res.Reason)
	}
	total := assertRoundFullyDrainedByClaims(t, s, id, []string{"alice", "bob"})
	if total.Cmp(bigFromStr(t, "20000")) != 0 {
		t.Fatalf("total refund %s, want 20000", total)
	}
}

func TestVoidPath_StaleFeed_EveryoneMadeWhole(t *testing.T) {
	s := newTestStore(t)
	id, err := market.RollRound(s, 1000, 2940, true)
	if err != nil {
		t.Fatal(err)
	}
	rv := ReadRound(s, id)
	if err := market.RecordBet(s, "alice", rv.Lock-1, id, 0, bigFromStr(t, "5000")); err != nil {
		t.Fatal(err)
	}
	if err := market.RecordBet(s, "bob", rv.Lock-1, id, 6, bigFromStr(t, "7000")); err != nil {
		t.Fatal(err)
	}
	// The oracle is down the ENTIRE window — every settle attempt during the
	// window itself errors (never resolves the round); only VoidStale, past
	// window+grace, can move it — proving the fail-safe is reachable even
	// with a persistently dead feed and zero genuine ticks.
	if _, err := market.Settle(s, "keeper", rv.Settle, id, 3474, rv.Settle, false); err == nil {
		t.Fatal("settle with a persistently dead feed inside the window should error, not resolve")
	}
	deadline := rv.Settle + market.SettleWindowBlocks + rv.Grace
	if _, err := market.VoidStale(s, "keeper", deadline, id); err == nil {
		t.Fatal("voidStale at exactly the deadline boundary must be refused (strictly after only)")
	}
	res, err := market.VoidStale(s, "keeper", deadline+1, id)
	if err != nil {
		t.Fatal(err)
	}
	if res.State != market.StateVoid || res.Reason != market.VoidStaleFeed {
		t.Fatalf("expected VOID(stale_feed), got state=%s reason=%s", res.State, res.Reason)
	}
	total := assertRoundFullyDrainedByClaims(t, s, id, []string{"alice", "bob"})
	if total.Cmp(bigFromStr(t, "12000")) != 0 {
		t.Fatalf("total refund %s, want 12000", total)
	}
}

func TestVoidPath_DeadlineReclaim_FailSafe_EveryoneMadeWhole(t *testing.T) {
	s := newTestStore(t)
	id, err := market.RollRound(s, 1000, 2940, true)
	if err != nil {
		t.Fatal(err)
	}
	rv := ReadRound(s, id)
	accts := []string{"alice", "bob", "carol", "dave"}
	amounts := []string{"4000", "9000", "1500", "22000"}
	buckets := []int{0, 3, 5, 6}
	pool := big.NewInt(0)
	for i, acct := range accts {
		amt := bigFromStr(t, amounts[i])
		if err := market.RecordBet(s, acct, rv.Lock-1, id, buckets[i], amt); err != nil {
			t.Fatal(err)
		}
		pool.Add(pool, amt)
	}
	// NOTHING ever calls settle or voidStale — the oracle is simply never
	// consulted again. Every staker independently rescues their own stake
	// via Reclaim, past the same hard deadline voidStale would use.
	deadline := rv.Settle + market.SettleWindowBlocks + rv.Grace
	if _, _, err := market.Reclaim(s, accts[0], deadline, id); err == nil {
		t.Fatal("reclaim at exactly the deadline boundary must be refused (strictly after only)")
	}
	total := big.NewInt(0)
	for i, acct := range accts {
		refund, asset, err := market.Reclaim(s, acct, deadline+1+uint64(i), id)
		if err != nil {
			t.Fatalf("reclaim %s: %v", acct, err)
		}
		if asset != market.AssetHbd {
			t.Fatalf("reclaim %s asset=%q want hbd", acct, asset)
		}
		want := bigFromStr(t, amounts[i])
		if refund.Cmp(want) != 0 {
			t.Fatalf("reclaim %s got %s want %s", acct, refund, want)
		}
		total.Add(total, refund)
	}
	rv2 := ReadRound(s, id)
	if rv2.State != market.StateVoid || rv2.VoidReason != market.VoidDeadlineReclaim {
		t.Fatalf("expected VOID(deadline_reclaim), got state=%s reason=%s", rv2.State, rv2.VoidReason)
	}
	if total.Cmp(pool) != 0 {
		t.Fatalf("Σ reclaims %s != pool %s (fail-safe left funds stuck or over-paid)", total, pool)
	}
	if err := checkFinalDrain(s, id); err != nil {
		t.Fatal(err)
	}
	// No double reclaim, and claim() after reclaim() also refuses.
	if _, _, err := market.Reclaim(s, accts[0], deadline+100, id); err == nil {
		t.Fatal("double reclaim allowed")
	}
	if _, _, err := market.Claim(s, accts[0], id); err == nil {
		t.Fatal("claim after reclaim allowed (double payout)")
	}
}

// TestSweepPath_UnclaimedWinningsAndAbandonedRefunds_ToDHF_Conserved proves
// the sweep path for BOTH a settled round with an unclaimed winner AND a
// void round with an abandoned refund, using the exact key/read surface the
// population harness relies on (RoundView, checkFinalDrain).
func TestSweepPath_UnclaimedWinningsAndAbandonedRefunds_ToDHF_Conserved(t *testing.T) {
	t.Run("settled_unclaimed_winnings", func(t *testing.T) {
		s := newTestStore(t)
		id, err := market.RollRound(s, 1000, 2940, true)
		if err != nil {
			t.Fatal(err)
		}
		rv := ReadRound(s, id)
		if err := market.RecordBet(s, "winA", rv.Lock-1, id, 3, bigFromStr(t, "10000")); err != nil {
			t.Fatal(err)
		}
		if err := market.RecordBet(s, "winB", rv.Lock-1, id, 3, bigFromStr(t, "10000")); err != nil {
			t.Fatal(err) // winB never claims
		}
		if err := market.RecordBet(s, "loser", rv.Lock-1, id, 0, bigFromStr(t, "10000")); err != nil {
			t.Fatal(err)
		}
		rv = ReadRound(s, id) // re-read: pool/strikes as of after all bets
		mid := (rv.Strikes[2] + rv.Strikes[3]) / 2
		res, err := market.Settle(s, "keeper", rv.Settle, id, mid, rv.Settle, true)
		if err != nil || res.State != market.StateSettled {
			t.Fatalf("settle: %v %+v", err, res)
		}
		pWinA, _, err := market.Claim(s, "winA", id)
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err := market.Claim(s, "loser", id); err != nil {
			t.Fatal(err)
		}
		if _, _, err := market.SweepUnclaimed(s, rv.Settle+market.ClaimWindowBlocks, id); err == nil {
			t.Fatal("sweep at the window boundary must be refused (strictly after only)")
		}
		amt, dhf, err := market.SweepUnclaimed(s, rv.Settle+market.ClaimWindowBlocks+1, id)
		if err != nil {
			t.Fatal(err)
		}
		if dhf != market.DHFAccount {
			t.Fatalf("swept to %q, want %q", dhf, market.DHFAccount)
		}
		total := new(big.Int).Add(pWinA, amt)
		if total.Cmp(rv.Pool) != 0 {
			t.Fatalf("claimed %s + swept %s != pool %s", pWinA, amt, rv.Pool)
		}
		if err := checkFinalDrain(s, id); err != nil {
			t.Fatal(err)
		}
		if _, _, err := market.Claim(s, "winB", id); err == nil {
			t.Fatal("claim after sweep succeeded (would double-spend the DHF payout)")
		}
	})

	t.Run("void_abandoned_refund", func(t *testing.T) {
		s := newTestStore(t)
		id, err := market.RollRound(s, 1000, 2940, true)
		if err != nil {
			t.Fatal(err)
		}
		rv := ReadRound(s, id)
		if err := market.RecordBet(s, "a", rv.Lock-1, id, 2, bigFromStr(t, "6000")); err != nil {
			t.Fatal(err)
		}
		if err := market.RecordBet(s, "b", rv.Lock-1, id, 2, bigFromStr(t, "9000")); err != nil {
			t.Fatal(err) // b abandons this refund
		}
		rv = ReadRound(s, id) // re-read: pool as of after all bets
		late := rv.Settle + market.SettleWindowBlocks + 1
		res, err := market.Settle(s, "anyone", late, id, 0, 0, false)
		if err != nil || res.State != market.StateVoid {
			t.Fatalf("settle: %v %+v", err, res)
		}
		refA, _, err := market.Claim(s, "a", id)
		if err != nil {
			t.Fatal(err)
		}
		amt, _, err := market.SweepUnclaimed(s, rv.Settle+market.ClaimWindowBlocks+1, id)
		if err != nil {
			t.Fatal(err)
		}
		total := new(big.Int).Add(refA, amt)
		if total.Cmp(rv.Pool) != 0 {
			t.Fatalf("claimed %s + swept %s != pool %s", refA, amt, rv.Pool)
		}
		if err := checkFinalDrain(s, id); err != nil {
			t.Fatal(err)
		}
	})
}

// TestSpreaderPattern_MultiAccountMultiBucket_InvariantsHold exercises the
// explicitly-noted workaround (several buckets via SEPARATE accounts, since
// one bet == one bucket) and proves it does not break pool conservation or
// let the spreader's own aggregate stake exceed what it actually paid in.
func TestSpreaderPattern_MultiAccountMultiBucket_InvariantsHold(t *testing.T) {
	s := newTestStore(t)
	id, err := market.RollRound(s, 1000, 2940, true)
	if err != nil {
		t.Fatal(err)
	}
	rv := ReadRound(s, id)
	subAccounts := []string{"spreader1_sub0", "spreader1_sub1", "spreader1_sub2"}
	buckets := []int{1, 3, 5}
	amounts := []string{"10000", "10000", "10000"}
	for i, acct := range subAccounts {
		if err := market.RecordBet(s, acct, rv.Lock-1, id, buckets[i], bigFromStr(t, amounts[i])); err != nil {
			t.Fatal(err)
		}
	}
	if err := checkPoolConservation(s, id, rv.N); err != nil {
		t.Fatal(err)
	}
	// Also seed a normal bettor on the eventual winning bucket so the round
	// can genuinely settle (one of the spreader's own buckets wins).
	if err := market.RecordBet(s, "other", rv.Lock-1, id, 3, bigFromStr(t, "5000")); err != nil {
		t.Fatal(err)
	}
	mid := (rv.Strikes[2] + rv.Strikes[3]) / 2 // bucket 3 wins — the spreader's sub1
	res, err := market.Settle(s, "keeper", rv.Settle, id, mid, rv.Settle, true)
	if err != nil || res.State != market.StateSettled || res.Winner != 3 {
		t.Fatalf("settle: %v %+v", err, res)
	}
	pSub1, _, err := market.Claim(s, "spreader1_sub1", id)
	if err != nil {
		t.Fatal(err)
	}
	if pSub1.Sign() <= 0 {
		t.Fatal("the spreader's winning sub-account got a zero payout")
	}
	pSub0, _, _ := market.Claim(s, "spreader1_sub0", id)
	pSub2, _, _ := market.Claim(s, "spreader1_sub2", id)
	if pSub0.Sign() != 0 || pSub2.Sign() != 0 {
		t.Fatalf("the spreader's LOSING sub-accounts got paid: sub0=%s sub2=%s (must be 0)", pSub0, pSub2)
	}
	pOther, _, err := market.Claim(s, "other", id)
	if err != nil {
		t.Fatal(err)
	}
	total := new(big.Int).Add(pSub1, pOther)
	finalPool := ReadRound(s, id).Pool // re-read: post-bet pool (rv was snapshotted before any bets)
	if total.Cmp(finalPool) != 0 {
		t.Fatalf("Σ claims %s != pool %s (spreader pattern broke conservation)", total, finalPool)
	}
}

func TestLatecomer_AlwaysRejected(t *testing.T) {
	s := newTestStore(t)
	id, err := market.RollRound(s, 1000, 2940, true)
	if err != nil {
		t.Fatal(err)
	}
	rv := ReadRound(s, id)
	for _, block := range []uint64{rv.Lock, rv.Lock + 1, rv.Lock + market.SettleWindowBlocks} {
		if err := market.RecordBet(s, "latecomer", block, id, 3, bigFromStr(t, "5000")); err == nil {
			t.Fatalf("CRITICAL: bet accepted at block %d >= lock %d", block, rv.Lock)
		}
	}
}

// ---------------------------------------------------------------------------
// Ledger / invariant-helper unit tests
// ---------------------------------------------------------------------------

func TestLedger_PnLAndGlobalConservation(t *testing.T) {
	l := NewLedger()
	l.RegisterActor("spreader1", "spreader", "spreader1_sub0", "spreader1_sub1")
	l.RegisterActor("alice", "casual")

	l.RecordStake("spreader1_sub0", big.NewInt(1000))
	l.RecordStake("spreader1_sub1", big.NewInt(2000))
	l.RecordStake("alice", big.NewInt(500))
	// sub1 is the SOLE winner of a 2-way pool against sub0 (zero-rake ⇒ it
	// takes the whole pool: its own 2000 + sub0's forfeited 1000 = 3000).
	// alice's round voided and she never claimed — her 500 is later swept.
	l.RecordReceived("spreader1_sub1", big.NewInt(3000))
	l.RecordReceived("alice", big.NewInt(0))
	l.RecordSwept(big.NewInt(500)) // alice's stake, abandoned, swept to the DHF

	if got := l.PnL("spreader1"); got.Sign() != 0 { // -1000-2000+3000 == 0
		t.Fatalf("spreader1 PnL = %s, want 0", got)
	}
	if got := l.PnL("alice"); got.Cmp(big.NewInt(-500)) != 0 {
		t.Fatalf("alice PnL = %s, want -500", got)
	}
	if err := l.GlobalConservationCheck(); err != nil {
		t.Fatal(err)
	}
	l.RecordReceived("alice", big.NewInt(1)) // now over-paid by 1 unit somewhere
	if err := l.GlobalConservationCheck(); err == nil {
		t.Fatal("expected the global conservation check to catch the induced imbalance")
	}
}

func TestState_RoundView_MatchesDirectStoreReads(t *testing.T) {
	s := newTestStore(t)
	id, err := market.RollRound(s, 1000, 2940, true)
	if err != nil {
		t.Fatal(err)
	}
	rv := ReadRound(s, id)
	if !rv.Exists || rv.State != market.StateOpen {
		t.Fatalf("unexpected fresh round view: %+v", rv)
	}
	if rv.N != 7 {
		t.Fatalf("N = %d, want 7 (RollRound always opens 7 %%-move buckets)", rv.N)
	}
	if rv.Asset != market.AssetHbd {
		t.Fatalf("asset = %q, want hbd", rv.Asset)
	}
	if len(rv.Strikes) != 6 {
		t.Fatalf("len(Strikes) = %d, want 6", len(rv.Strikes))
	}
	if _, ok := ActiveRoundID(s, market.AssetHbd); !ok {
		t.Fatal("active round pointer not published")
	}
}

// ---------------------------------------------------------------------------
// Reproducibility of the full harness itself
// ---------------------------------------------------------------------------

// TestThinPopulation_UnderfundedAndZeroWinnerEmergeNaturally surveys a
// LOW-LIQUIDITY population (a handful of bettors, no spreaders, so bucket
// coverage is genuinely thin) across many seeds under a RELIABLE keeper —
// isolating liquidity as the cause, not keeper behaviour. underfunded and
// zero_winner are real, structural risks a thin weekly market hits even
// with perfect settle diligence; the default (larger) population used
// elsewhere in this suite essentially never produces them (broad coverage,
// especially from spreaders touching many buckets, makes them vanishingly
// rare) — that gap is intentional and documented in the final report, not
// hidden. Every one of these runs still passes through the exact same
// invariant checks as every other run (Run() returning nil error already
// proves conservation held on every voided round, including these).
func TestThinPopulation_UnderfundedAndZeroWinnerEmergeNaturally(t *testing.T) {
	if testing.Short() {
		t.Skip("multi-seed survey skipped in -short mode")
	}
	reasons := map[string]int{}
	for seed := int64(1); seed <= 20; seed++ {
		cfg := DefaultConfig()
		cfg.Seed = seed
		cfg.Weeks = 52
		cfg.Keeper = KeeperReliable
		cfg.NumSharp = 2
		cfg.NumCasual = 6
		cfg.NumWhale = 1
		cfg.NumSpreader = 0
		cfg.NumNoShow = 2
		s := NewSimulator(cfg)
		r, err := s.Run()
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		for reason, n := range r.RoundsVoidByReason {
			reasons[reason] += n
		}
	}
	t.Logf("thin-population void reasons across 20 seeds x 52 weeks (reliable keeper): %+v", reasons)
	if reasons[market.VoidUnderfunded] == 0 {
		t.Error("expected at least one underfunded void across the thin-population survey")
	}
	if reasons[market.VoidZeroWinner] == 0 {
		t.Error("expected at least one zero_winner void across the thin-population survey")
	}
}

func TestSim_SameSeedSameReport(t *testing.T) {
	run := func() *Report {
		cfg := DefaultConfig()
		cfg.Seed = 99
		cfg.Weeks = 6
		cfg.Keeper = KeeperLate
		s := NewSimulator(cfg)
		r, err := s.Run()
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
		return r
	}
	r1, r2 := run(), run()
	if r1.TotalStaked.Cmp(r2.TotalStaked) != 0 || r1.RoundsVoid != r2.RoundsVoid || r1.RoundsSettled != r2.RoundsSettled {
		t.Fatalf("same seed produced different results: %+v vs %+v", r1, r2)
	}
}
