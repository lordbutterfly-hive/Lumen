package sim

import (
	"fmt"
	"math/rand"
	"strconv"

	"hive-price-market/market"
)

// maxRollRetries bounds how many oracle-bad-feed retries a roll attempt
// takes before the simulator gives up on rolling a round for the week
// (recorded as a skipped week) rather than looping forever on a
// pathological oracle configuration.
const maxRollRetries = 60

// keeperRoll opens the next round the instant the oracle reads healthy,
// retrying at the next tick on a bad feed. Roll promptness is IDENTICAL
// across all three keeper profiles by design (see KeeperProfile doc) — only
// settle/void timing varies, which is the one variable this simulator
// measures.
func (sim *Simulator) keeperRoll(week int, rng *rand.Rand) (uint64, bool, error) {
	block := sim.block
	for attempt := 0; attempt < maxRollRetries; attempt++ {
		price, feedOK, _, found := sim.oracle.LatestKnownAt(block)
		if found && feedOK && price > 0 {
			id, err := market.RollRound(sim.store, block, price, feedOK)
			sim.trace(week, block, id, "keeper", string(RoleKeeper), "roll",
				map[string]string{"refPrice": strconv.FormatUint(price, 10)}, err)
			if err == nil {
				sim.advanceTo(block)
				return id, true, nil
			}
			// feedOK && price>0 should always be accepted by RollRound here —
			// runWeek only ever calls keeperRoll once the prior round for this
			// asset has already fully resolved, so the one-open-round guard
			// cannot be the cause. Any error is a genuine break.
			return 0, false, sim.violation(week, 0, "roll unexpectedly rejected despite feedOK=true price=%d: %v", price, err)
		}
		sim.trace(week, block, 0, "keeper", string(RoleKeeper), "roll_retry_bad_feed", nil, fmt.Errorf("oracle feed not ready/healthy"))
		block = sim.oracle.NextTickAtOrAfter(block + 1)
	}
	sim.advanceTo(block)
	return 0, false, nil
}

// pollOnce is a single settle-keeper decision + action at pollBlock,
// mirroring scheduler.DecideKeeperAction's literal, spec'd boundary
// (settle once block>=SettleBlock && feedOK; voidStale once past
// SettleBlock+SettleWindowBlocks+GraceBlocks) — reimplemented here (not
// imported from scheduler/, which is off-limits to touch) against only the
// exported market.* surface + this package's own RoundView reader.
func (sim *Simulator) pollOnce(week int, id uint64, pollBlock uint64, actor string) (terminal bool, method string, err error) {
	rv := ReadRound(sim.store, id)
	if rv.State != market.StateOpen {
		return true, "", nil
	}
	if pollBlock >= rv.Settle {
		price, feedOK, tick, found := sim.oracle.LatestKnownAt(pollBlock)
		if found && feedOK {
			res, callErr := market.Settle(sim.store, actor, pollBlock, id, price, tick, feedOK)
			sim.trace(week, pollBlock, id, actor, string(RoleKeeper), "settle",
				map[string]string{"price": strconv.FormatUint(price, 10), "tick": strconv.FormatUint(tick, 10)}, callErr)
			if callErr == nil {
				sim.advanceTo(pollBlock)
				_ = res
				return true, "settle", nil
			}
			// A live env read can land AFTER settleBlock while the most
			// recently OBSERVED oracle tick still precedes it (settleBlock is
			// not generally aligned to the 100-block tick grid, so there is a
			// real gap — up to one tick interval — between "block>=settleBlock"
			// and "the qualifying tick has actually landed"). market.Settle
			// correctly rejects that as ErrOracle. This is the exact scenario
			// DEPLOY-RUNBOOK.md's "Keeper note" documents as retriable ("costs
			// the caller RC, not funds; the keeper simply retries next
			// cycle") — NOT a fund-safety violation, so treat it as
			// non-terminal and let the caller retry/move on, instead of
			// halting. Any OTHER error symbol here would be a genuine break.
			if merr, ok := callErr.(*market.Err); ok && merr.Symbol == market.ErrOracle {
				return false, "", nil
			}
			return false, "", sim.violation(week, id, "settle unexpectedly errored with feedOK=true at block %d: %v", pollBlock, callErr)
		}
	}
	if pollBlock > rv.Settle+market.SettleWindowBlocks+rv.Grace {
		_, callErr := market.VoidStale(sim.store, actor, pollBlock, id)
		sim.trace(week, pollBlock, id, actor, string(RoleKeeper), "voidStale", nil, callErr)
		if callErr == nil {
			sim.advanceTo(pollBlock)
			return true, "voidStale", nil
		}
		return false, "", sim.violation(week, id, "voidStale unexpectedly errored past window+grace at block %d: %v", pollBlock, callErr)
	}
	return false, "", nil
}

// resolveRound dispatches to the configured keeper profile's settle
// behaviour for one round.
func (sim *Simulator) resolveRound(week int, id uint64, rng *rand.Rand) (terminal bool, method string, err error) {
	switch sim.cfg.Keeper {
	case KeeperReliable:
		return sim.reliableResolve(week, id, rng)
	case KeeperLate:
		return sim.lateResolve(week, id, rng)
	case KeeperAbsent:
		return false, "", nil // never calls settle or voidStale — Reclaim is the only way out
	default:
		return false, "", fmt.Errorf("sim: unknown keeper profile %v", sim.cfg.Keeper)
	}
}

// reliableResolve polls at EVERY oracle tick from the qualifying settle tick
// onward (small realistic latency after each), through settle+window+grace —
// the diligent-automation ideal. It always reaches a terminal state itself
// (never needs the Reclaim fail-safe), because its very last poll, past
// window+grace, always succeeds via VoidStale.
func (sim *Simulator) reliableResolve(week int, id uint64, rng *rand.Rand) (bool, string, error) {
	rv := ReadRound(sim.store, id)
	tick := sim.oracle.NextTickAtOrAfter(rv.Settle)
	outer := rv.Settle + market.SettleWindowBlocks + rv.Grace
	for {
		latency := uint64(1 + rng.Int63n(int64(sim.cfg.ReliablePollLatencyMaxBlocks)))
		pollBlock := tick + latency
		last := false
		if pollBlock > outer+1 {
			pollBlock = outer + 1
			last = true
		}
		terminal, method, err := sim.pollOnce(week, id, pollBlock, "keeper-reliable")
		if err != nil {
			return false, "", err
		}
		if terminal {
			return true, method, nil
		}
		if last {
			return false, "", sim.violation(week, id, "reliable keeper poll at %d (past window+grace) did not resolve the round", pollBlock)
		}
		tick += TickIntervalBlocks
	}
}

// lateResolve makes at most two, widely (and often heavily) delayed
// settle-keeper attempts, and gives up entirely if neither lands on a
// terminal state — a flaky/lazy off-chain script rather than a tight retry
// loop. This is the profile expected to show a materially higher VOID rate
// than reliable (more of its attempts miss the single qualifying oracle
// tick) while still resolving MOST rounds itself; the rounds it fails to
// resolve fall through to the Reclaim fail-safe.
func (sim *Simulator) lateResolve(week int, id uint64, rng *rand.Rand) (bool, string, error) {
	rv := ReadRound(sim.store, id)
	delay1 := foldedDelay(rng, sim.cfg.LateDelayMean1, sim.cfg.LateDelayStdev1)
	block1 := rv.Settle + delay1
	terminal, method, err := sim.pollOnce(week, id, block1, "keeper-late")
	if err != nil {
		return false, "", err
	}
	if terminal {
		return true, method, nil
	}
	if rng.Float64() >= sim.cfg.LateSecondAttemptProb {
		return false, "", nil
	}
	delay2 := delay1 + foldedDelay(rng, sim.cfg.LateDelayExtraMean2, sim.cfg.LateDelayExtraStdev2)
	block2 := rv.Settle + delay2
	terminal2, method2, err2 := sim.pollOnce(week, id, block2, "keeper-late")
	if err2 != nil {
		return false, "", err2
	}
	return terminal2, method2, nil
}
