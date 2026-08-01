package market

import (
	"fmt"
	"math/big"
	"math/rand"
	"sort"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// PRUNED Phase-1 mechanical search, agent A8.
//
// This file is a scenario runner + property/fuzz harness for the core money
// invariants of the market package:
//
//	(a) SOLVENCY:   Σ(every account's claim) <= pool                (always)
//	(b) ZERO-DUST:  on SETTLED, Σ(winners' claims) == distributable  (exactly)
//	(c) claims are never negative, Claim never panics, losers get 0,
//	    VOID refunds Σ stakes exactly (per-account AND in aggregate).
//
// Three independent search strategies exercise the same runScenario():
//   - TestProperty_SolvencyRandomized: math/rand-driven property loop.
//   - TestAdversarial_Solvency:        hand-picked table of edge configs.
//   - FuzzSolvency:                    native go test -fuzz over raw bytes,
//     decoded into a scenario by scenarioFromBytes (so the fuzzer's byte
//     mutations map onto structural changes: outcome count, stake mode,
//     account count, price).
// ---------------------------------------------------------------------------

type betSpec struct {
	acct    string
	outcome int
	amt     *big.Int
}

type scenario struct {
	n       int
	strikes []uint64
	bets    []betSpec
	feeBps  uint64
	price   uint64
}

func mustBig(s string) *big.Int {
	v, ok := new(big.Int).SetString(s, 10)
	if !ok {
		panic("bad const " + s)
	}
	return v
}

// runScenario does a full Init -> CreateRound(feeBps) -> bets -> Settle ->
// Claim-all pass and asserts the money invariants. tb.Fatalf on any violation
// (including a state-machine error we didn't expect); a real Go panic (index
// out of range, nil deref, div-by-zero) is left to propagate to the caller,
// which wraps this in a recover() to attribute it to the failing scenario.
func runScenario(tb testing.TB, sc scenario) {
	tb.Helper()

	if sc.n < 2 || sc.n > MaxOutcomes || len(sc.strikes) != sc.n-1 {
		tb.Fatalf("malformed scenario (n=%d, len(strikes)=%d): %+v", sc.n, len(sc.strikes), sc)
	}

	s := newMem()
	if err := Init(s, owner); err != nil {
		tb.Fatalf("Init: %v", err)
	}
	if err := SetFeeBps(s, owner, sc.feeBps); err != nil {
		tb.Fatalf("SetFeeBps(%d): %v (scenario=%+v)", sc.feeBps, err, sc)
	}
	id, err := CreateRound(s, owner, 0, CreateParams{
		Asset: AssetHbd, Strikes: sc.strikes, LockBlock: 2000, SettleBlock: 4000, GraceBlocks: 300,
	})
	if err != nil {
		tb.Fatalf("CreateRound: %v (scenario=%+v)", err, sc)
	}

	acctStakeTotal := map[string]*big.Int{}
	acctOutcomeStake := map[string]map[int]*big.Int{}
	expectedPool := big.NewInt(0)

	for _, b := range sc.bets {
		if err := RecordBet(s, b.acct, 10, id, b.outcome, b.amt); err != nil {
			tb.Fatalf("RecordBet(acct=%s outcome=%d amt=%s): %v (scenario=%+v)", b.acct, b.outcome, b.amt, err, sc)
		}
		expectedPool.Add(expectedPool, b.amt)
		if acctStakeTotal[b.acct] == nil {
			acctStakeTotal[b.acct] = big.NewInt(0)
		}
		acctStakeTotal[b.acct].Add(acctStakeTotal[b.acct], b.amt)
		if acctOutcomeStake[b.acct] == nil {
			acctOutcomeStake[b.acct] = map[int]*big.Int{}
		}
		if acctOutcomeStake[b.acct][b.outcome] == nil {
			acctOutcomeStake[b.acct][b.outcome] = big.NewInt(0)
		}
		acctOutcomeStake[b.acct][b.outcome].Add(acctOutcomeStake[b.acct][b.outcome], b.amt)
	}

	pool := getMoney(s, rk(id, "pool"))
	if pool.Cmp(expectedPool) != 0 {
		tb.Fatalf("pool %s != Σbets %s (scenario=%+v)", pool, expectedPool, sc)
	}
	if got := sumOutcomePools(s, id, sc.n); got.Cmp(pool) != 0 {
		tb.Fatalf("Σ outcomePools %s != pool %s (scenario=%+v)", got, pool, sc)
	}

	res, err := Settle(s, "keeper", 4000, id, sc.price, 4000, true)
	if err != nil {
		tb.Fatalf("Settle: %v (scenario=%+v)", err, sc)
	}

	accts := make([]string, 0, len(acctStakeTotal))
	for a := range acctStakeTotal {
		accts = append(accts, a)
	}
	sort.Strings(accts)

	claims := map[string]*big.Int{}
	total := big.NewInt(0)
	for _, a := range accts {
		p, _, err := Claim(s, a, id)
		if err != nil {
			tb.Fatalf("Claim(%s): %v (state=%s scenario=%+v)", a, err, res.State, sc)
		}
		if p.Sign() < 0 {
			tb.Fatalf("NEGATIVE claim for %s: %s (scenario=%+v)", a, p, sc)
		}
		claims[a] = p
		total.Add(total, p)
	}
	// double-claim must always be rejected, regardless of scenario.
	for _, a := range accts {
		if _, _, err := Claim(s, a, id); err == nil {
			tb.Fatalf("DOUBLE CLAIM allowed for %s (scenario=%+v)", a, sc)
		}
	}

	// SOLVENCY, unconditional: the contract must never pay out more than the pool it holds.
	if total.Cmp(pool) > 0 {
		tb.Fatalf("INSOLVENT: Σ claims %s > pool %s (state=%s scenario=%+v)", total, pool, res.State, sc)
	}

	switch res.State {
	case StateVoid:
		// VOID refunds Σ stakes EXACTLY == pool (aggregate zero-dust on void).
		if total.Cmp(pool) != 0 {
			tb.Fatalf("VOID dust leak: Σ claims %s != pool %s (reason=%s scenario=%+v)", total, pool, res.Reason, sc)
		}
		// per-account refund == that account's stakeTotal, exactly.
		for _, a := range accts {
			if claims[a].Cmp(acctStakeTotal[a]) != 0 {
				tb.Fatalf("VOID refund mismatch acct=%s got=%s want=%s (scenario=%+v)", a, claims[a], acctStakeTotal[a], sc)
			}
		}
	case StateSettled:
		fee := mMulBpsDiv(pool, sc.feeBps)
		distributable, derr := mSub(pool, fee)
		if derr != nil {
			tb.Fatalf("mSub(pool,fee) underflow: pool=%s fee=%s (scenario=%+v)", pool, fee, sc)
		}
		// ZERO-DUST: Σ winners' claims == distributable EXACTLY.
		if total.Cmp(distributable) != 0 {
			tb.Fatalf("ZERO-DUST VIOLATED: Σ claims %s != distributable %s (pool=%s fee=%s bps=%d winner=%d scenario=%+v)",
				total, distributable, pool, fee, sc.feeBps, res.Winner, sc)
		}
		// bounty sanity: never dips into stakes, never exceeds fee.
		if res.Bounty.Sign() < 0 || res.Bounty.Cmp(fee) > 0 {
			tb.Fatalf("bounty %s out of range for fee %s (scenario=%+v)", res.Bounty, fee, sc)
		}
		// losers (no stake on the winning outcome) get EXACTLY 0.
		for _, a := range accts {
			winStake := acctOutcomeStake[a][res.Winner]
			if winStake == nil || winStake.Sign() == 0 {
				if claims[a].Sign() != 0 {
					tb.Fatalf("loser %s got nonzero claim %s (winner=%d scenario=%+v)", a, claims[a], res.Winner, sc)
				}
			}
		}
	default:
		tb.Fatalf("unexpected terminal state %q (scenario=%+v)", res.State, sc)
	}
}

// ---------------------------------------------------------------------------
// Strategy 1: randomized property loop (math/rand, reproducible seed).
// ---------------------------------------------------------------------------

func genRandomScenario(rng *rand.Rand) scenario {
	n := 2 + rng.Intn(15) // 2..16 (MaxOutcomes)
	strikes := make([]uint64, n-1)
	prev := uint64(0)
	for i := range strikes {
		prev += uint64(1 + rng.Intn(2000))
		strikes[i] = prev
	}
	feeBps := uint64(rng.Intn(MaxFeeBps + 1)) // 0..MaxFeeBps inclusive
	k := 1 + rng.Intn(20)                     // 1..20 accounts
	minBet := mustBig(MinBet)
	bets := make([]betSpec, 0, k)
	for i := 0; i < k; i++ {
		outcome := rng.Intn(n)
		var amt *big.Int
		switch rng.Intn(5) {
		case 0: // exactly MinBet
			amt = new(big.Int).Set(minBet)
		case 1: // small jitter above MinBet
			amt = new(big.Int).Add(minBet, big.NewInt(rng.Int63n(1_000_000)))
		case 2: // prime-ish stake (maximal floor loss pressure)
			amt = new(big.Int).Add(minBet, big.NewInt(int64(1+rng.Intn(5000))*7919))
		case 3: // huge stake (stresses big.Int, not int64/uint64 truncation)
			digits := 20 + rng.Intn(20)
			bs := make([]byte, digits)
			bs[0] = byte('1' + rng.Intn(9))
			for j := 1; j < digits; j++ {
				bs[j] = byte('0' + rng.Intn(10))
			}
			v, ok := new(big.Int).SetString(string(bs), 10)
			if !ok {
				v = new(big.Int).Set(minBet)
			}
			amt = v
		default: // mid-range jitter
			amt = new(big.Int).Add(minBet, big.NewInt(rng.Int63n(1<<40)))
		}
		bets = append(bets, betSpec{acct: fmt.Sprintf("acct%d", i), outcome: outcome, amt: amt})
	}
	price := uint64(rng.Int63n(int64(prev) + 2000))
	if rng.Intn(4) == 0 {
		price = rng.Uint64() // occasionally stress the price range, far above every strike
	}
	// F-P3 gave the oracle price an explicit legal domain [1, MaxReferenceBps];
	// Settle now REFUSES outside it. This harness fuzzes settlement MATH, not
	// oracle validation (fp3_settle_price_test.go owns that), so model a legal
	// oracle — otherwise every full-range draw is a refusal and the solvency
	// properties below never execute.
	price = price%MaxReferenceBps + 1
	return scenario{n: n, strikes: strikes, bets: bets, feeBps: feeBps, price: price}
}

func TestProperty_SolvencyRandomized(t *testing.T) {
	const iterations = 20000
	const seed = int64(1)
	rng := rand.New(rand.NewSource(seed))
	for i := 0; i < iterations; i++ {
		sc := genRandomScenario(rng)
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("iteration %d PANICKED: %v (seed=%d scenario=%+v)", i, r, seed, sc)
				}
			}()
			runScenario(t, sc)
		}()
		if t.Failed() {
			t.Fatalf("first failure at iteration %d (seed=%d) — see above", i, seed)
		}
	}
	t.Logf("TestProperty_SolvencyRandomized: %d randomized scenarios passed (seed=%d), N in [2,16], K in [1,20] accounts/scenario", iterations, seed)
}

// ---------------------------------------------------------------------------
// Strategy 2: hand-picked adversarial table.
// ---------------------------------------------------------------------------

func TestAdversarial_Solvency(t *testing.T) {
	minBet := mustBig(MinBet)
	huge := mustBig(strings.Repeat("9", 30)) // 10^30 - 1

	cases := []struct {
		name string
		sc   scenario
	}{
		{
			name: "prime_stakes",
			sc: scenario{
				n: 2, strikes: []uint64{10000}, feeBps: 200, price: 12000,
				bets: []betSpec{
					{"a", 1, big.NewInt(1009)},
					{"b", 1, big.NewInt(1013)},
					{"c", 1, big.NewInt(7919)},
					{"loser", 0, big.NewInt(5000)},
				},
			},
		},
		{
			name: "min_bet_exact",
			sc: scenario{
				n: 2, strikes: []uint64{10000}, feeBps: 500, price: 12000,
				bets: []betSpec{
					{"a", 1, new(big.Int).Set(minBet)},
					{"b", 1, new(big.Int).Set(minBet)},
					{"loser", 0, new(big.Int).Set(minBet)},
				},
			},
		},
		{
			name: "huge_stake_plus_many_tiny",
			sc: func() scenario {
				bets := []betSpec{{"whale", 1, new(big.Int).Set(huge)}}
				for i := 0; i < 30; i++ {
					bets = append(bets, betSpec{fmt.Sprintf("tiny%d", i), 1, new(big.Int).Set(minBet)})
				}
				bets = append(bets, betSpec{"loser", 0, big.NewInt(999999)})
				return scenario{n: 2, strikes: []uint64{10000}, feeBps: 200, price: 12000, bets: bets}
			}(),
		},
		{
			name: "single_winner",
			sc: scenario{
				n: 2, strikes: []uint64{10000}, feeBps: 200, price: 12000,
				bets: []betSpec{
					{"sole_winner", 1, big.NewInt(12345)},
					{"loser1", 0, big.NewInt(40000)},
					{"loser2", 0, big.NewInt(60000)},
				},
			},
		},
		{
			name: "all_on_one_outcome_underfunded_void",
			sc: scenario{
				n: 3, strikes: []uint64{5000, 10000}, feeBps: 300, price: 15000,
				bets: []betSpec{
					{"a", 0, big.NewInt(10000)},
					{"b", 0, big.NewInt(20000)},
					{"c", 0, big.NewInt(30000)},
				},
			},
		},
		{
			name: "equal_stakes_max_floor_loss",
			sc: scenario{
				n: 2, strikes: []uint64{10000}, feeBps: 333, price: 15000,
				bets: []betSpec{
					{"a", 1, big.NewInt(1000000)},
					{"b", 1, big.NewInt(1000000)},
					{"c", 1, big.NewInt(1000000)},
					{"loser", 0, big.NewInt(5000000)},
				},
			},
		},
		{
			name: "zero_winner_void",
			sc: scenario{
				// n=3, strikes=[5000,10000]; bets fund outcomes 0 and 2 only, so
				// outcome 1 (the middle bucket) is unfunded. price=7000 -> bucketFor
				// returns 1 (winner bucket), which has ZERO stake -> VoidZeroWinner,
				// even though funded==2 overall (not the underfunded path).
				n: 3, strikes: []uint64{5000, 10000}, feeBps: 200, price: 7000,
				bets: []betSpec{
					{"a", 0, big.NewInt(10000)},
					{"b", 2, big.NewInt(20000)},
				},
			},
		},
		{
			name: "max_outcomes_16_disjoint_singletons",
			sc: func() scenario {
				strikes := make([]uint64, 15)
				for i := range strikes {
					strikes[i] = uint64(1000 * (i + 1))
				}
				bets := make([]betSpec, 0, 16)
				for i := 0; i < 16; i++ {
					bets = append(bets, betSpec{fmt.Sprintf("acct%d", i), i, big.NewInt(int64(1000 + i*137))})
				}
				// price above the top strike (15000) -> winner bucket 15 (last), funded singly.
				return scenario{n: 16, strikes: strikes, feeBps: 500, price: 16000, bets: bets}
			}(),
		},
		{
			name: "zero_fee",
			sc: scenario{
				n: 2, strikes: []uint64{10000}, feeBps: 0, price: 12000,
				bets: []betSpec{
					{"a", 1, big.NewInt(7000)},
					{"b", 1, big.NewInt(11000)},
					{"loser", 0, big.NewInt(50000)},
				},
			},
		},
		{
			name: "max_fee",
			sc: scenario{
				n: 2, strikes: []uint64{10000}, feeBps: MaxFeeBps, price: 12000,
				bets: []betSpec{
					{"a", 1, big.NewInt(7000)},
					{"b", 1, big.NewInt(11000)},
					{"loser", 0, big.NewInt(50000)},
				},
			},
		},
		{
			name: "acct_bets_both_winning_and_losing_outcome",
			sc: scenario{
				n: 2, strikes: []uint64{10000}, feeBps: 200, price: 12000,
				bets: []betSpec{
					{"a", 1, big.NewInt(10000)}, // winning
					{"a", 0, big.NewInt(40000)}, // losing (same acct, different outcome)
					{"b", 0, big.NewInt(10000)},
				},
			},
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			runScenario(t, c.sc)
		})
	}
}

// ---------------------------------------------------------------------------
// Strategy 3: native go test -fuzz over raw bytes, decoded into a scenario.
// ---------------------------------------------------------------------------

type byteCursor struct {
	data []byte
	pos  int
}

// filler once the byte stream is exhausted; non-zero so a short seed still
// drives varied downstream fields instead of decaying into all-zero.
func (c *byteCursor) byte() byte {
	if c.pos >= len(c.data) {
		return 0xAA
	}
	b := c.data[c.pos]
	c.pos++
	return b
}

func (c *byteCursor) u16() uint16 { return uint16(c.byte()) | uint16(c.byte())<<8 }

func (c *byteCursor) u64() uint64 {
	var v uint64
	for i := 0; i < 8; i++ {
		v |= uint64(c.byte()) << (8 * uint(i))
	}
	return v
}

// scenarioFromBytes deterministically decodes a fuzzer byte string into a
// scenario: outcome count, strikes, fee bps, account count, per-account
// outcome/amount (four amount "modes" covering MinBet-exact, jitter,
// prime-ish, and huge/big.Int-stress), and a settle price. Returns ok=false
// only when there isn't enough entropy to even pick a mode (data too short);
// any decoded scenario is passed to runScenario unconditionally, so amounts
// exactly at MinBet or well below it will legitimately hit RecordBet's
// min-bet rejection via runScenario -> tb.Fatalf — that's intended since our
// generator always adds MinBet as a floor, so RecordBet should never reject.
func scenarioFromBytes(data []byte) (scenario, bool) {
	if len(data) < 4 {
		return scenario{}, false
	}
	c := &byteCursor{data: data}
	n := 2 + int(c.byte())%15 // 2..16
	feeBps := uint64(c.u16()) % (MaxFeeBps + 1)
	strikes := make([]uint64, n-1)
	prev := uint64(0)
	for i := range strikes {
		prev += uint64(c.byte())%200 + 1
		strikes[i] = prev
	}
	k := 1 + int(c.byte())%20
	minBet := mustBig(MinBet)
	bets := make([]betSpec, 0, k)
	for i := 0; i < k; i++ {
		outcome := int(c.byte()) % n
		mode := c.byte() % 4
		var amt *big.Int
		switch mode {
		case 0:
			amt = new(big.Int).Set(minBet)
		case 1:
			amt = new(big.Int).Add(minBet, big.NewInt(int64(c.u16())))
		case 2:
			amt = new(big.Int).Add(minBet, big.NewInt(int64(c.u16())*7919))
		default:
			hugeBase := new(big.Int).Exp(big.NewInt(10), big.NewInt(24), nil)
			amt = new(big.Int).Add(hugeBase, big.NewInt(int64(c.u16())))
		}
		bets = append(bets, betSpec{acct: fmt.Sprintf("acct%d", i), outcome: outcome, amt: amt})
	}
	price := c.u64() % (prev + 100)
	if c.byte()%2 == 0 {
		price = c.u64() // occasionally unbounded by the strikes
	}
	// Same reason as the randomized generator above: keep the fuzzed price
	// inside the oracle domain F-P3 made explicit, so these bytes keep
	// exercising settlement math instead of bouncing off the new guard.
	price = price%MaxReferenceBps + 1
	return scenario{n: n, strikes: strikes, bets: bets, feeBps: feeBps, price: price}, true
}

func bytesRepeat(b byte, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = b
	}
	return out
}

func FuzzSolvency(f *testing.F) {
	// Adversarial seed corpus: hand-crafted byte streams chosen to decode into
	// edge-case scenarios (small n, all-zero/all-max bytes, escalating
	// patterns) so the fuzzer starts from structurally interesting points
	// rather than pure noise.
	f.Add([]byte{0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x02, 0xFF, 0xFF, 0x00, 0x01, 0x03, 0xFF, 0xFF})
	f.Add([]byte{0x00, 0xC4, 0x01, 0x0A, 0x01, 0x00, 0x01, 0x01, 0x00, 0x01, 0x01, 0x01, 0x00})
	f.Add(bytesRepeat(0xFF, 40))
	f.Add(bytesRepeat(0x00, 40))
	f.Add([]byte{0x00, 0x00, 0x00, 0x01, 0x00, 0x03, 0x01, 0x00, 0x03, 0x01, 0x00, 0x03})
	for i := byte(0); i < 10; i++ {
		f.Add([]byte{i, i * 3, i * 7, i * 13, i * 17, i * 19, i * 23})
	}

	f.Fuzz(func(t *testing.T, data []byte) {
		sc, ok := scenarioFromBytes(data)
		if !ok {
			return
		}
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("PANIC on scenario=%+v: %v", sc, r)
			}
		}()
		runScenario(t, sc)
	})
}
