// Package scheduler is the off-chain automation for the Hive Price Weekly
// Market: the contract (../contract, ../market) cannot self-schedule — every
// action is an externally-signed Hive transaction (DUMB-QUESTIONS-RESOLVED
// A4) — so a weekly `roll` cycle and a settle/voidStale keeper cycle must
// run off-chain. This package is pure logic: all external I/O (reading the
// live oracle price+tick, reading the live chain height, reading contract
// state, broadcasting to Hive) is behind the PriceSource / BlockSource /
// StateReader / Broadcaster interfaces, with mock implementations for
// tests/dry-run and real (stdlib net/http) or documented stub
// implementations for production.
//
// It deliberately does NOT import ../contract (TinyGo/wasm build-constrained)
// — only ../market, for the protocol constants and enums every decision here
// is validated against.
package scheduler

import (
	"fmt"

	"hive-price-market/market"
)

// Scheduler wires the collaborators together into runnable cycles.
type Scheduler struct {
	Cfg         Config
	Price       PriceSource
	Block       BlockSource
	State       StateReader
	Broadcaster Broadcaster
	Caller      string // the scheduler bot's own Hive account, e.g. "hive:scheduler-bot"
}

// PlannedRoll captures everything RunRollCycle computed, for both
// broadcasting and test/dry-run inspection.
type PlannedRoll struct {
	Skipped          bool
	SkipReason       string
	ObservedPriceBps uint64 // the live price peekPrice returned at decision time — NOT sent on-chain (roll's payload is ignored; see BuildRollOp's doc), purely for operator visibility/logging
	ObservedFeedOK   bool
	Op               CustomJSON
	TxID             string
}

// RunRollCycle runs one weekly round-open cycle:
//  1. overlap guard — skip if a round is still open for this asset (the
//     contract's own one-open-round-per-asset guard would reject this
//     anyway; checking off-chain avoids wasting RC on a doomed broadcast).
//  2. peek the live price purely as a feedOK pre-flight (roll's own
//     execution-time env read is authoritative; skipping here just avoids a
//     broadcast that would revert ORACLE).
//  3. build + broadcast `roll` — an EMPTY payload; the contract derives the
//     reference price, the 7-bucket ±10/20/30% strikes, and the weekly
//     lock/settle/grace timing entirely on-chain (see BuildRollOp's doc).
func (s *Scheduler) RunRollCycle(currentBlock uint64) (*PlannedRoll, error) {
	open, openID, err := IsRoundOpen(s.State, s.Cfg.ContractID, s.Cfg.Asset)
	if err != nil {
		return nil, fmt.Errorf("scheduler: overlap check: %w", err)
	}
	if open {
		return &PlannedRoll{
			Skipped:    true,
			SkipReason: fmt.Sprintf("round %d is still open for asset %q — skipping (the contract's own overlap guard would reject roll anyway)", openID, s.Cfg.Asset),
		}, nil
	}

	priceBps, _, feedOK, err := s.Price.Peek()
	if err != nil {
		return nil, fmt.Errorf("scheduler: price peek: %w", err)
	}
	if !feedOK {
		return &PlannedRoll{
			Skipped:          true,
			SkipReason:       "oracle feed not healthy (feedOK=false) — roll would revert ORACLE on-chain (market.RollRound); wait for the feed to recover",
			ObservedPriceBps: priceBps,
		}, nil
	}

	op, err := BuildRollOp(s.Cfg.opConfig(), s.Caller)
	if err != nil {
		return nil, fmt.Errorf("scheduler: build roll op: %w", err)
	}
	txID, err := s.Broadcaster.Broadcast(op)
	if err != nil {
		return nil, fmt.Errorf("scheduler: broadcast roll: %w", err)
	}
	return &PlannedRoll{
		ObservedPriceBps: priceBps,
		ObservedFeedOK:   true,
		Op:               op,
		TxID:             txID,
	}, nil
}

// KeeperResult is one round's outcome from a RunKeeperCycle poll, including
// the voidStale fallback if the primary settle attempt itself failed to
// broadcast.
type KeeperResult struct {
	RoundID uint64
	Action  KeeperAction // primary decision (Wait or Settle — see DecideKeeperAction's doc for why VoidStale is never the primary action)
	Op      *CustomJSON
	TxID    string
	// Err is set (non-nil) only when Action==KeeperSettle and the broadcast
	// itself failed. This is treated as NON-FATAL by design: RunKeeperCycle
	// is stateless and side-effect-free beyond the Broadcaster calls, so the
	// caller retrying on the next poll (with a fresh block/tick/feedOK read)
	// is always safe — a transient ErrOracle-causing timing skew between
	// this peek and tx execution simply resolves itself next poll.
	Err error

	// Fallback/FallbackOp/FallbackTxID/FallbackErr are populated ONLY when
	// the primary settle attempt errored AND the round is already past its
	// settle deadline (settleBlock+SettleWindowBlocks+GraceBlocks — the same
	// threshold voidStale itself enforces): a second, independent line of
	// defense so a persistently-failing settle path (a broadcast/RC problem,
	// not a predictable oracle condition — those are already skipped by
	// DecideKeeperAction) still can't strand funds.
	Fallback     KeeperAction
	FallbackOp   *CustomJSON
	FallbackTxID string
	FallbackErr  error

	Skipped    bool
	SkipReason string
}

// RunKeeperCycle is ONE stateless settle-keeper poll for ONE round. `round`
// should be read FRESH this cycle (ReadActiveRoundSchedule/ReadRoundSchedule
// in state.go) — RunKeeperCycle does not cache or re-discover it itself, to
// keep the read and the decision visibly separate for callers/tests, but the
// intended usage is: every poll, re-read, then call this. Combined with a
// fresh Block.CurrentHeight() + Price.Peek() read on every call, this makes
// the whole cycle stateless: a crashed-and-restarted keeper, or two
// independent keeper bots racing each other, always converge on the same
// decision from the same on-chain truth, and a double-submitted settle is a
// harmless no-op both off-chain (a fresh state read shows the round already
// resolved, so the keeper never re-attempts —
// TestRunKeeperCycle_AlreadyResolvedIsHarmlessNoOp) and on-chain
// (market.Settle's own `roundState(s,id)!=StateOpen` gate, settle.go:32 —
// proven directly against the real market package in
// TestRunKeeperCycle_AlreadyResolvedIsHarmlessNoOp_OnChain).
//
// settle() is ALWAYS the primary action once DecideKeeperAction says
// KeeperSettle — never voidStale directly (see that function's doc for why a
// bare settle() call already covers every terminal outcome, including both
// auto-VOID paths, at lower latency than waiting for voidStale's grace
// delay). voidStale is reserved as a SEPARATE fallback: only if the settle
// broadcast attempt ITSELF errors and the round is already past its full
// settle deadline, this same poll also attempts voidStale — see
// KeeperResult's doc.
func (s *Scheduler) RunKeeperCycle(round RoundSchedule) (KeeperResult, error) {
	block, err := s.Block.CurrentHeight()
	if err != nil {
		return KeeperResult{RoundID: round.ID}, fmt.Errorf("scheduler: keeper block height read: %w", err)
	}
	_, tick, feedOK, err := s.Price.Peek()
	if err != nil {
		return KeeperResult{RoundID: round.ID}, fmt.Errorf("scheduler: keeper price peek: %w", err)
	}

	action := DecideKeeperAction(block, tick, feedOK, round)
	res := KeeperResult{RoundID: round.ID, Action: action}
	if action == KeeperWait {
		res.Skipped = true
		res.SkipReason = "not yet actionable this poll (see DecideKeeperAction: too early, or feed/tick not yet past settleBlock)"
		return res, nil
	}

	op, err := BuildSettleOp(s.Cfg.opConfig(), s.Caller, round.ID)
	if err != nil {
		return res, fmt.Errorf("scheduler: build settle op for round %d: %w", round.ID, err)
	}
	res.Op = &op
	txID, bcastErr := s.Broadcaster.Broadcast(op)
	if bcastErr == nil {
		res.TxID = txID
		return res, nil
	}
	res.Err = bcastErr // non-fatal — see KeeperResult's doc

	graceEnd := round.SettleBlock + market.SettleWindowBlocks + round.GraceBlocks
	if block > graceEnd {
		vop, vErr := BuildVoidStaleOp(s.Cfg.opConfig(), s.Caller, round.ID)
		if vErr != nil {
			return res, fmt.Errorf("scheduler: build voidStale fallback op for round %d: %w", round.ID, vErr)
		}
		res.Fallback = KeeperVoidStale
		res.FallbackOp = &vop
		vTxID, vBcastErr := s.Broadcaster.Broadcast(vop)
		if vBcastErr == nil {
			res.FallbackTxID = vTxID
		} else {
			res.FallbackErr = vBcastErr
		}
	}
	return res, nil
}
