package sim

import (
	"fmt"
	"math"
	"math/big"
	"math/rand"
	"sort"
	"strconv"

	"hive-price-market/market"
)

// Role identifies an actor's behavioural profile.
type Role string

const (
	RoleSharp     Role = "sharp"
	RoleCasual    Role = "casual"
	RoleWhale     Role = "whale"
	RoleSpreader  Role = "spreader"
	RoleNoShow    Role = "no_show"
	RoleLatecomer Role = "latecomer"
	RoleKeeper    Role = "keeper"
	RoleSweeper   Role = "sweeper"
)

// actorSpec is one member of the fixed simulated population.
type actorSpec struct {
	Name        string
	Role        Role
	SubAccounts []string // len>1 only for spreaders; every other role bets from Name itself
}

func buildRoster(cfg Config) []actorSpec {
	var roster []actorSpec
	for i := 1; i <= cfg.NumSharp; i++ {
		roster = append(roster, actorSpec{Name: fmt.Sprintf("sharp%d", i), Role: RoleSharp})
	}
	for i := 1; i <= cfg.NumCasual; i++ {
		roster = append(roster, actorSpec{Name: fmt.Sprintf("casual%d", i), Role: RoleCasual})
	}
	for i := 1; i <= cfg.NumWhale; i++ {
		roster = append(roster, actorSpec{Name: fmt.Sprintf("whale%d", i), Role: RoleWhale})
	}
	for i := 1; i <= cfg.NumSpreader; i++ {
		name := fmt.Sprintf("spreader%d", i)
		subs := make([]string, cfg.SpreaderBucketsPerActor)
		for j := 0; j < cfg.SpreaderBucketsPerActor; j++ {
			subs[j] = fmt.Sprintf("%s_sub%d", name, j)
		}
		roster = append(roster, actorSpec{Name: name, Role: RoleSpreader, SubAccounts: subs})
	}
	for i := 1; i <= cfg.NumNoShow; i++ {
		roster = append(roster, actorSpec{Name: fmt.Sprintf("noshow%d", i), Role: RoleNoShow})
	}
	for i := 1; i <= cfg.NumLatecomer; i++ {
		roster = append(roster, actorSpec{Name: fmt.Sprintf("latecomer%d", i), Role: RoleLatecomer})
	}
	return roster
}

var minBetAmount = mustParseMoney(market.MinBet)

func mustParseMoney(s string) *big.Int {
	v, ok := new(big.Int).SetString(s, 10)
	if !ok {
		panic("sim: cannot parse market.MinBet")
	}
	return v
}

func mulMinBet(mult uint64) *big.Int {
	return new(big.Int).Mul(minBetAmount, new(big.Int).SetUint64(mult))
}

// weightedMiddleBucket samples a bucket index in [0,n) with weight decaying
// by distance from the middle bucket — models real-world "crowd anchors on
// the near-current / flat outcome" bias (a known dynamic the README flags as
// v0's E-1 fairness gap), used for casual bettors, no-shows, and whales
// (whales get NO informational edge in this model — see BetPlan comments).
func weightedMiddleBucket(rng *rand.Rand, n int) int {
	if n <= 1 {
		return 0
	}
	mid := float64(n-1) / 2.0
	weights := make([]float64, n)
	total := 0.0
	for k := 0; k < n; k++ {
		d := math.Abs(float64(k) - mid)
		w := 1.0 / math.Pow(1+d, 1.5)
		weights[k] = w
		total += w
	}
	r := rng.Float64() * total
	cum := 0.0
	for k := 0; k < n; k++ {
		cum += weights[k]
		if r <= cum {
			return k
		}
	}
	return n - 1
}

// sharpBucket models a bettor with better (but imperfect) information: it
// reads the LATEST already-observed oracle tick (no lookahead — a real
// bettor can never see the future settle tick either) as of the bet block,
// extrapolates the trend since the round's recorded reference price with a
// random gain + multiplicative noise, and buckets the resulting guess. This
// gives sharp bettors a genuine, but noisy, statistical edge that should
// show up as positive expected P&L across many rounds — never a perfect
// prediction.
func sharpBucket(rng *rand.Rand, oracle *Oracle, rv RoundView, betBlock uint64) int {
	cur, feedOK, _, found := oracle.LatestKnownAt(betBlock)
	if !found || !feedOK || cur == 0 {
		return weightedMiddleBucket(rng, rv.N)
	}
	ref := rv.RefPrice
	if ref == 0 {
		ref = cur
	}
	trend := float64(cur) - float64(ref)
	gain := 0.5 + rng.Float64() // 0.5..1.5
	guess := float64(cur) + trend*gain
	guess *= 1 + rng.NormFloat64()*0.03 // ~3% multiplicative noise
	if guess < 1 {
		guess = 1
	}
	return bucketFor(uint64(math.Round(guess)), rv.Strikes)
}

// BetPlan is one scheduled bet: which account, when, on which outcome, how
// much, and whether that account will ever claim its entitlement.
type BetPlan struct {
	Account     string
	Logical     string
	Role        Role
	Block       uint64
	Outcome     int
	Amount      *big.Int
	NeverClaims bool
}

// planBets decides, for the whole roster, who bets this round, when, on
// which bucket, and how much — entirely from the per-week "bets" RNG stream
// (see subRand), so it is byte-identical across keeper-profile runs sharing
// a seed.
func (sim *Simulator) planBets(rng *rand.Rand, rv RoundView) []BetPlan {
	cfg := sim.cfg
	windowWidth := uint64(market.RollBettingBlocks)
	windowStart := rv.Lock - windowWidth

	var plans []BetPlan
	for _, a := range sim.roster {
		switch a.Role {
		case RoleSharp:
			if rng.Float64() > cfg.SharpParticipation {
				continue
			}
			block := rv.Lock - 1 - uint64(rng.Int63n(int64(windowWidth/10)+1))
			outcome := sharpBucket(rng, sim.oracle, rv, block)
			plans = append(plans, BetPlan{
				Account: a.Name, Logical: a.Name, Role: a.Role, Block: block,
				Outcome: outcome, Amount: mulMinBet(10 + uint64(rng.Intn(41))),
			})

		case RoleCasual:
			if rng.Float64() > cfg.CasualParticipation {
				continue
			}
			block := windowStart + uint64(rng.Int63n(int64(windowWidth/4)+1))
			outcome := weightedMiddleBucket(rng, rv.N)
			plans = append(plans, BetPlan{
				Account: a.Name, Logical: a.Name, Role: a.Role, Block: block,
				Outcome: outcome, Amount: mulMinBet(1 + uint64(rng.Intn(5))),
			})

		case RoleWhale:
			if rng.Float64() > cfg.WhaleParticipation {
				continue
			}
			block := windowStart + uint64(rng.Int63n(int64(windowWidth)))
			// No informational edge, deliberately — a classic real-world
			// whale mistake: big confident money on the consensus/obvious
			// bucket, not necessarily the informed one.
			outcome := weightedMiddleBucket(rng, rv.N)
			plans = append(plans, BetPlan{
				Account: a.Name, Logical: a.Name, Role: a.Role, Block: block,
				Outcome: outcome, Amount: mulMinBet(200 + uint64(rng.Intn(601))),
			})

		case RoleSpreader:
			if rng.Float64() > cfg.SpreaderParticipation {
				continue
			}
			k := cfg.SpreaderBucketsPerActor
			if k > rv.N {
				k = rv.N
			}
			buckets := rng.Perm(rv.N)[:k]
			total := mulMinBet(30)
			per := new(big.Int).Div(total, big.NewInt(int64(k)))
			remainder := new(big.Int).Sub(total, new(big.Int).Mul(per, big.NewInt(int64(k))))
			for i, bkt := range buckets {
				block := windowStart + uint64(rng.Int63n(int64(windowWidth/2)+1))
				amt := new(big.Int).Set(per)
				if i == 0 {
					amt.Add(amt, remainder) // dust goes to the first sub-bet
				}
				plans = append(plans, BetPlan{
					Account: a.SubAccounts[i], Logical: a.Name, Role: a.Role, Block: block,
					Outcome: bkt, Amount: amt,
				})
			}

		case RoleNoShow:
			if rng.Float64() > cfg.NoShowParticipation {
				continue
			}
			block := windowStart + uint64(rng.Int63n(int64(windowWidth/4)+1))
			outcome := weightedMiddleBucket(rng, rv.N)
			plans = append(plans, BetPlan{
				Account: a.Name, Logical: a.Name, Role: a.Role, Block: block,
				Outcome: outcome, Amount: mulMinBet(1 + uint64(rng.Intn(5))), NeverClaims: true,
			})

		case RoleLatecomer:
			// Handled separately in executeLatecomerAttempts — these bets
			// are EXPECTED to be rejected (block >= lock), so they never
			// join the pool and never become participants.
		}
	}
	sort.Slice(plans, func(i, j int) bool { return plans[i].Block < plans[j].Block })
	return plans
}

// executeBets runs every planned bet against the real market package,
// asserting pool conservation after each one, and returns the list of
// accounts that successfully joined the round (for the later claim pass).
func (sim *Simulator) executeBets(week int, plans []BetPlan, rv RoundView) ([]participant, error) {
	var participants []participant
	expectedPool := big.NewInt(0)
	for _, p := range plans {
		err := market.RecordBet(sim.store, p.Account, p.Block, rv.ID, p.Outcome, p.Amount)
		sim.trace(week, p.Block, rv.ID, p.Account, string(p.Role), "bet",
			map[string]string{"outcome": strconv.Itoa(p.Outcome), "amount": p.Amount.String()}, err)
		if err != nil {
			return nil, sim.violation(week, rv.ID, "bet by %s (%s, outcome %d, amount %s) unexpectedly rejected: %v",
				p.Account, p.Role, p.Outcome, p.Amount, err)
		}
		sim.ledger.RecordStake(p.Account, p.Amount)
		expectedPool.Add(expectedPool, p.Amount)
		sim.advanceTo(p.Block)
		if err := checkPoolConservation(sim.store, rv.ID, rv.N); err != nil {
			return nil, sim.violation(week, rv.ID, "%s", err.Error())
		}
		participants = append(participants, participant{
			Account: p.Account, Logical: p.Logical, Role: p.Role, NeverClaims: p.NeverClaims,
		})
	}
	got := ReadRound(sim.store, rv.ID).Pool
	if got.Cmp(expectedPool) != 0 {
		return nil, sim.violation(week, rv.ID, "post-bet pool %s != Σ bets executed %s", got, expectedPool)
	}
	return participants, nil
}

// executeLatecomerAttempts drives every participating latecomer's
// bet-after-lock attempt. The design's fund-safety guarantee here is
// absolute (a DIRECT block check, not a best-effort one) — ANY success is a
// critical invariant violation and halts the run immediately.
func (sim *Simulator) executeLatecomerAttempts(week int, rng *rand.Rand, rv RoundView) error {
	for _, a := range sim.roster {
		if a.Role != RoleLatecomer {
			continue
		}
		if rng.Float64() > sim.cfg.LatecomerParticipation {
			continue
		}
		block := rv.Lock + uint64(rng.Int63n(int64(market.SettleWindowBlocks/2)+1))
		outcome := rng.Intn(rv.N)
		amt := mulMinBet(1 + uint64(rng.Intn(5)))
		err := market.RecordBet(sim.store, a.Name, block, rv.ID, outcome, amt)
		sim.trace(week, block, rv.ID, a.Name, string(a.Role), "bet_after_lock",
			map[string]string{"outcome": strconv.Itoa(outcome)}, err)
		if err == nil {
			return sim.violation(week, rv.ID,
				"CRITICAL: bet after lock by %s SUCCEEDED (block=%d >= lock=%d) — betting-closed invariant broken",
				a.Name, block, rv.Lock)
		}
		sim.rejectedLateBets++
		sim.advanceTo(block)
	}
	return nil
}

// processClaims lets every participant who WILL claim (excludes declared
// no-shows and the random ForgetProb dropout) collect their entitlement,
// asserting the running paid total never exceeds the payable ceiling and
// that a deliberately-repeated claim is always rejected.
func (sim *Simulator) processClaims(week int, id uint64, participants []participant, rng *rand.Rand) error {
	rv := ReadRound(sim.store, id)
	ceiling := new(big.Int).Set(rv.Pool) // zero-rake ⇒ distributable == pool (settled) or pool (void)
	paidSoFar := big.NewInt(0)
	seen := map[string]bool{}
	for _, p := range participants {
		if seen[p.Account] {
			continue
		}
		seen[p.Account] = true
		if IsClaimed(sim.store, id, p.Account) {
			continue // already paid via the reclaim fail-safe
		}
		if p.NeverClaims || rng.Float64() < sim.cfg.ForgetProb {
			continue // becomes a sweep target
		}
		block := sim.block + uint64(rng.Int63n(2000)+1)
		payout, _, err := market.Claim(sim.store, p.Account, id)
		sim.trace(week, block, id, p.Account, string(p.Role), "claim", nil, err)
		if err != nil {
			return sim.violation(week, id, "claim by %s unexpectedly rejected: %v", p.Account, err)
		}
		sim.advanceTo(block)
		if payout.Sign() > 0 {
			sim.ledger.RecordReceived(p.Account, payout)
			paidSoFar.Add(paidSoFar, payout)
			if err := checkNoOverpay(ceiling, paidSoFar, id); err != nil {
				return sim.violation(week, id, "%s", err.Error())
			}
		}
		if rng.Float64() < 0.1 {
			_, _, err2 := market.Claim(sim.store, p.Account, id)
			sim.trace(week, block, id, p.Account, string(p.Role), "claim_again", nil, err2)
			if err2 == nil {
				return sim.violation(week, id, "CRITICAL: double-claim by %s SUCCEEDED — no-double-claim invariant broken", p.Account)
			}
			sim.rejectedDoubleClaim++
		}
	}
	return nil
}

// reclaimFallback is the fund-safety FAIL-SAFE path: once a round is stuck
// OPEN past its hard deadline (no keeper ever settled or void-staled it),
// every staker independently notices (at a random delay after the deadline)
// and pulls their own stake back via Reclaim. Returns whether anyone
// actually reclaimed (false only if the round had zero participants).
func (sim *Simulator) reclaimFallback(week int, id uint64, participants []participant, rng *rand.Rand) (bool, error) {
	rv := ReadRound(sim.store, id)
	if rv.State != market.StateOpen {
		return false, nil
	}
	deadline := rv.Settle + market.SettleWindowBlocks + rv.Grace
	any := false
	seen := map[string]bool{}
	order := rng.Perm(len(participants))
	for _, idx := range order {
		p := participants[idx]
		if seen[p.Account] {
			continue
		}
		seen[p.Account] = true
		block := deadline + 1 + uint64(rng.Int63n(int64(sim.cfg.ReclaimDelayMaxBlocks)+1))
		refund, _, err := market.Reclaim(sim.store, p.Account, block, id)
		sim.trace(week, block, id, p.Account, string(p.Role), "reclaim", nil, err)
		if err != nil {
			return any, sim.violation(week, id, "reclaim by %s (past deadline %d, at block %d) unexpectedly rejected: %v",
				p.Account, deadline, block, err)
		}
		if refund.Sign() > 0 {
			sim.ledger.RecordReceived(p.Account, refund)
		}
		sim.advanceTo(block)
		any = true

		if rng.Float64() < 0.15 {
			_, _, err2 := market.Claim(sim.store, p.Account, id)
			sim.trace(week, block, id, p.Account, string(p.Role), "claim_after_reclaim", nil, err2)
			if err2 == nil {
				return any, sim.violation(week, id, "CRITICAL: claim after reclaim by %s SUCCEEDED — double-payout", p.Account)
			}
			sim.rejectedDoubleClaim++
		}
	}
	return any, nil
}
