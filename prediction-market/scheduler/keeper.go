package scheduler

import "hive-price-market/market"

// KeeperAction is what the settle keeper should do (if anything) for one
// round on a given poll.
type KeeperAction int

const (
	KeeperWait KeeperAction = iota
	KeeperSettle
	KeeperVoidStale
)

func (a KeeperAction) String() string {
	switch a {
	case KeeperSettle:
		return "settle"
	case KeeperVoidStale:
		return "void_stale"
	default:
		return "wait"
	}
}

// RecommendedPollIntervalSeconds is the suggested settle-keeper poll cadence
// for a live daemon (the actual loop/timer is NOT built here — broadcasting
// is out of scope, see broadcaster.go's HiveBroadcaster). It must be well
// under one pendulum tick interval (market.MaxSettleTickLag=100 blocks *
// ~3s/block ≈ 300s, per market/params.go) so multiple polls land inside the
// narrow qualifying-tick window even under normal network/RPC jitter — e.g.
// 15s gives on the order of 20 polls per window.
const RecommendedPollIntervalSeconds = 15

// RoundSchedule is what the keeper needs to know about one round to decide
// its next action. ALWAYS read fresh via ReadRoundSchedule/
// ReadActiveRoundSchedule (state.go) at the top of every poll — never cached
// or carried over from a previous cycle (statelessness / crash-safety: a
// restarted keeper, or two independent keeper bots racing each other, must
// converge on the same decision from the same on-chain truth every time).
type RoundSchedule struct {
	ID          uint64
	Asset       string
	State       string // market.StateOpen / StateSettled / StateVoid
	SettleBlock uint64
	GraceBlocks uint64
}

// DecideKeeperAction decides the PRIMARY action for one round from a fresh,
// stateless read of two independent clocks:
//
//   - `block` is the REAL current Hive L1 chain height (BlockSource, backed
//     by go-vsc-node's localNodeInfo.last_processed_block) — the SAME clock
//     settle()/voidStale() gate on via env "block.height"
//     (contract/main.go currentBlock(), settle.go:36,41,129).
//   - `tick`/`feedOK` are peekPrice's pendulum tick_block_height and
//     (hive_ma_ok && trusted_hive_mean_ok) — the SAME two fields settle()
//     itself reads fresh at execution time (contract/main.go Settle,
//     settle.go:44-60).
//
// `block` (never `tick`) drives every FUND-SAFETY-CRITICAL boundary — has
// settleBlock been reached, has the outer settle window + grace fully
// lapsed — because the oracle tick can freeze indefinitely if the pendulum
// feed itself goes fully dark (a dead oracle never advances
// tick_block_height again), and the keeper's ultimate liveness backstop must
// never depend on oracle health. `tick`+`feedOK` only sharpen the
// LOW-LATENCY happy path: they let the keeper recognize the narrow
// ~100-block qualifying-tick window (settle.go:47-60, market.MaxSettleTickLag)
// instead of firing settle blindly on every poll once block>=settleBlock,
// which would mostly just burn RC on predictable ErrOracle reverts before
// the qualifying tick lands.
func DecideKeeperAction(block uint64, tick uint64, feedOK bool, r RoundSchedule) KeeperAction {
	if r.State != market.StateOpen {
		return KeeperWait // already resolved (by us or a racing keeper) — no-op
	}
	if block < r.SettleBlock {
		return KeeperWait // too early — mirrors settle.go:36 ("too early to settle")
	}

	windowEnd := r.SettleBlock + market.SettleWindowBlocks
	if block > windowEnd {
		// The OUTER settle window has lapsed by REAL block height. settle.go:41
		// checks block>settleBlock+SettleWindowBlocks BEFORE it ever reads
		// feedOK, so a bare settle() call here ALWAYS resolves to VOID
		// (VoidWindowLapsed) with ZERO oracle dependency — fire immediately,
		// regardless of feedOK, rather than waiting the extra GraceBlocks for
		// voidStale to become available (DEPLOY-RUNBOOK's "Keeper note": "a
		// plain settle() past the window always resolves to VOID with zero
		// oracle dependency"). This is strictly lower latency for the
		// identical safe outcome. voidStale remains available as
		// RunKeeperCycle's own SEPARATE fallback if this settle attempt's
		// broadcast itself fails for an unrelated (non-oracle) reason.
		return KeeperSettle
	}

	// Still inside the outer window (by real block height).
	if !feedOK {
		// The feed reads unhealthy off-chain right now — settle() would
		// revert ErrOracle (settle.go:44-45), a real, EXPECTED, RETRIABLE
		// condition (DEPLOY-RUNBOOK's "Keeper note"). Skip this poll rather
		// than spend RC on a call known to fail; the tight poll interval
		// (RecommendedPollIntervalSeconds) means the next poll's fresh peek
		// re-decides within seconds, not the next tick.
		return KeeperWait
	}
	if tick < r.SettleBlock {
		// Feed's healthy but the oracle hasn't ticked past settleBlock yet —
		// the same ErrOracle condition (settle.go:56, "oracle tick precedes
		// settle block"), same retriable skip.
		return KeeperWait
	}

	// tick>=settleBlock and feed healthy: either we're inside the ~100-block
	// qualifying-tick window (settle.go:58-60) — the real low-latency
	// SETTLED happy path — or the qualifying tick has already been missed
	// (tick >= settleBlock+MaxSettleTickLag) and settle() will instead
	// resolve to VOID (VoidTickWindowMissed) — still a safe, immediate
	// terminal outcome worth firing now rather than waiting out the rest of
	// the outer window. Either way: fire.
	return KeeperSettle
}
