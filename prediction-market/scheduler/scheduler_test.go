package scheduler

import (
	"bytes"
	"encoding/json"
	"errors"
	"math/big"
	"strconv"
	"strings"
	"testing"

	"hive-price-market/market"
)

// countingBroadcaster wraps DryRunBroadcaster to also count calls, so tests
// can assert a cycle did/didn't broadcast without inspecting output.
type countingBroadcaster struct {
	DryRunBroadcaster
	calls int
}

func (c *countingBroadcaster) Broadcast(op CustomJSON) (string, error) {
	c.calls++
	return c.DryRunBroadcaster.Broadcast(op)
}

// failingActionBroadcaster fails Broadcast for one specific action (matched
// by unmarshaling op.JSON and checking VSCCall.Action) and delegates
// everything else to DryRunBroadcaster — used to deterministically exercise
// RunKeeperCycle's voidStale fallback (which only fires when the primary
// settle broadcast itself errors).
type failingActionBroadcaster struct {
	DryRunBroadcaster
	failAction string
	failErr    error
	calls      []string // actions attempted, in order
}

func (f *failingActionBroadcaster) Broadcast(op CustomJSON) (string, error) {
	var call VSCCall
	_ = json.Unmarshal([]byte(op.JSON), &call)
	f.calls = append(f.calls, call.Action)
	if call.Action == f.failAction {
		err := f.failErr
		if err == nil {
			err = errors.New("simulated broadcast failure")
		}
		return "", err
	}
	return f.DryRunBroadcaster.Broadcast(op)
}

func TestRunRollCycle_OverlapGuardSkips(t *testing.T) {
	state := MockStateReader{
		"active|hbd": "1",
		"rd|0|state": market.StateOpen,
	}
	bcast := &countingBroadcaster{}
	s := &Scheduler{
		Cfg:         DefaultConfig("vsc1x"),
		Price:       FixedPriceSource{PriceBps: 2940, FeedOK: true},
		State:       state,
		Broadcaster: bcast,
		Caller:      "hive:scheduler-bot",
	}
	res, err := s.RunRollCycle(1000)
	if err != nil {
		t.Fatalf("RunRollCycle: %v", err)
	}
	if !res.Skipped {
		t.Fatal("expected the roll cycle to be skipped (round still open)")
	}
	if bcast.calls != 0 {
		t.Fatalf("expected NO broadcast while a round is open, got %d", bcast.calls)
	}
}

func TestRunRollCycle_FeedNotOkSkips(t *testing.T) {
	s := &Scheduler{
		Cfg:         DefaultConfig("vsc1x"),
		Price:       FixedPriceSource{PriceBps: 2940, FeedOK: false},
		State:       MockStateReader{},
		Broadcaster: &countingBroadcaster{},
		Caller:      "hive:scheduler-bot",
	}
	res, err := s.RunRollCycle(1000)
	if err != nil {
		t.Fatalf("RunRollCycle: %v", err)
	}
	if !res.Skipped {
		t.Fatal("expected the roll cycle to be skipped (feed not ok)")
	}
}

func TestRunRollCycle_HappyPath(t *testing.T) {
	bcast := &countingBroadcaster{}
	cfg := DefaultConfig("vsc1x")
	if cfg.Asset != market.AssetHbd {
		t.Fatalf("DefaultConfig.Asset = %q, want market.AssetHbd (%q) — must match RollRound's hardcoded stake asset", cfg.Asset, market.AssetHbd)
	}
	s := &Scheduler{
		Cfg:         cfg,
		Price:       FixedPriceSource{PriceBps: 2940, Tick: 1_000_000, FeedOK: true},
		State:       MockStateReader{}, // no round ever created
		Broadcaster: bcast,
		Caller:      "hive:scheduler-bot",
	}
	res, err := s.RunRollCycle(1_000_000)
	if err != nil {
		t.Fatalf("RunRollCycle: %v", err)
	}
	if res.Skipped {
		t.Fatalf("expected NOT skipped, got skip reason %q", res.SkipReason)
	}
	if bcast.calls != 1 {
		t.Fatalf("expected exactly 1 broadcast, got %d", bcast.calls)
	}
	if res.ObservedPriceBps != 2940 || !res.ObservedFeedOK {
		t.Fatalf("observed price/feedOK = (%d,%v), want (2940,true)", res.ObservedPriceBps, res.ObservedFeedOK)
	}
	if res.TxID == "" {
		t.Fatal("expected a non-empty tx id from the (dry-run) broadcaster")
	}
	var call VSCCall
	if err := json.Unmarshal([]byte(res.Op.JSON), &call); err != nil {
		t.Fatalf("op.JSON: %v", err)
	}
	if call.Action != "roll" {
		t.Fatalf("action = %q, want roll", call.Action)
	}

	// Now feed the SAME reference price into the REAL market.RollRound to
	// prove the whole overlap-guard-then-roll pipeline is genuinely
	// contract-acceptable end to end, not just individually shaped.
	ms := newMemStore()
	if err := market.Init(ms, "hive:scheduler-bot"); err != nil {
		t.Fatalf("Init: %v", err)
	}
	if _, err := market.RollRound(ms, 1_000_000, res.ObservedPriceBps, res.ObservedFeedOK); err != nil {
		t.Fatalf("REAL market.RollRound rejected the scheduler's observed price: %v", err)
	}
}

func TestRunKeeperCycle_SettlesInsideTheQualifyingTickWindow(t *testing.T) {
	bcast := &countingBroadcaster{}
	s := &Scheduler{
		Cfg:         DefaultConfig("vsc1x"),
		Price:       FixedPriceSource{PriceBps: 2940, Tick: 1000, FeedOK: true}, // tick exactly at settleBlock
		Block:       FixedBlockSource{Block: 1000},
		Broadcaster: bcast,
		Caller:      "hive:keeper-bot",
	}
	round := RoundSchedule{ID: 1, Asset: "hbd", State: market.StateOpen, SettleBlock: 1000, GraceBlocks: 100}
	res, err := s.RunKeeperCycle(round)
	if err != nil {
		t.Fatalf("RunKeeperCycle: %v", err)
	}
	if res.Action != KeeperSettle || res.Skipped {
		t.Fatalf("round (open, at settle, tick+feed ok) = %+v, want Settle", res)
	}
	if res.TxID == "" || res.Err != nil {
		t.Fatalf("expected a successful settle broadcast, got %+v", res)
	}
	if bcast.calls != 1 {
		t.Fatalf("expected exactly 1 broadcast, got %d", bcast.calls)
	}
	var call VSCCall
	if err := json.Unmarshal([]byte(res.Op.JSON), &call); err != nil {
		t.Fatalf("op.JSON: %v", err)
	}
	if call.Action != "settle" {
		t.Fatalf("action = %q, want settle", call.Action)
	}
}

func TestRunKeeperCycle_WaitsBeforeSettleBlock(t *testing.T) {
	bcast := &countingBroadcaster{}
	s := &Scheduler{
		Cfg:         DefaultConfig("vsc1x"),
		Price:       FixedPriceSource{PriceBps: 2940, Tick: 900, FeedOK: true},
		Block:       FixedBlockSource{Block: 990},
		Broadcaster: bcast,
		Caller:      "hive:keeper-bot",
	}
	round := RoundSchedule{ID: 1, Asset: "hbd", State: market.StateOpen, SettleBlock: 1000, GraceBlocks: 100}
	res, err := s.RunKeeperCycle(round)
	if err != nil {
		t.Fatalf("RunKeeperCycle: %v", err)
	}
	if res.Action != KeeperWait || !res.Skipped {
		t.Fatalf("round (well before settle) = %+v, want Wait/Skipped", res)
	}
	if bcast.calls != 0 {
		t.Fatalf("expected NO broadcast before settleBlock, got %d", bcast.calls)
	}
}

func TestRunKeeperCycle_AlreadyResolvedIsHarmlessNoOp(t *testing.T) {
	// Proves the "double-submitted settle must be a harmless no-op"
	// requirement OFF-CHAIN: once a fresh state read shows the round is no
	// longer OPEN (settled by us, by a racing keeper, or voided), the keeper
	// never even attempts a second broadcast.
	bcast := &countingBroadcaster{}
	s := &Scheduler{
		Cfg:         DefaultConfig("vsc1x"),
		Price:       FixedPriceSource{PriceBps: 2940, Tick: 1500, FeedOK: true},
		Block:       FixedBlockSource{Block: 1500},
		Broadcaster: bcast,
		Caller:      "hive:keeper-bot",
	}
	round := RoundSchedule{ID: 1, Asset: "hbd", State: market.StateSettled, SettleBlock: 1000, GraceBlocks: 100}
	res, err := s.RunKeeperCycle(round)
	if err != nil {
		t.Fatalf("RunKeeperCycle: %v", err)
	}
	if res.Action != KeeperWait || !res.Skipped {
		t.Fatalf("round (already settled) = %+v, want Wait/Skipped", res)
	}
	if bcast.calls != 0 {
		t.Fatalf("expected NO broadcast for an already-resolved round, got %d", bcast.calls)
	}
}

// TestRunKeeperCycle_AlreadyResolvedIsHarmlessNoOp_OnChain proves the SAME
// requirement at the ON-CHAIN layer: even if two keepers somehow race and
// BOTH broadcast settle for the same round, the second call against the
// REAL market package (imported unmodified) is rejected cleanly, not a
// double-payout.
func TestRunKeeperCycle_AlreadyResolvedIsHarmlessNoOp_OnChain(t *testing.T) {
	ms := newMemStore()
	if err := market.Init(ms, "hive:owner"); err != nil {
		t.Fatalf("Init: %v", err)
	}
	id, err := market.RollRound(ms, 0, 2940, true)
	if err != nil {
		t.Fatalf("RollRound: %v", err)
	}
	// Fund the winning bucket (bucketFor(2940, computeStrikes(2940)) == 3 —
	// the near-flat middle band) plus one other, so the round genuinely
	// SETTLES rather than voiding underfunded/zero_winner — though for THIS
	// test's purpose (proving a second settle call is rejected) either
	// terminal outcome would do, since settle.go's state!=Open gate fires
	// identically either way.
	if err := market.RecordBet(ms, "hive:alice", 1, id, 3, big.NewInt(2000)); err != nil {
		t.Fatalf("RecordBet alice: %v", err)
	}
	if err := market.RecordBet(ms, "hive:bob", 1, id, 0, big.NewInt(2000)); err != nil {
		t.Fatalf("RecordBet bob: %v", err)
	}
	settleRaw, _ := ms.Get("rd|" + strconv.FormatUint(id, 10) + "|settle")
	settleBlock, err := strconv.ParseUint(settleRaw, 10, 64)
	if err != nil {
		t.Fatalf("parse settle block %q: %v", settleRaw, err)
	}
	tick := settleBlock // first qualifying tick

	if _, err := market.Settle(ms, "hive:keeper-a", settleBlock, id, 2940, tick, true); err != nil {
		t.Fatalf("first settle: %v", err)
	}
	_, err = market.Settle(ms, "hive:keeper-b", settleBlock, id, 2940, tick, true)
	if err == nil {
		t.Fatal("expected the SECOND settle call to be rejected, not silently re-resolve")
	}
	merr, ok := err.(*market.Err)
	if !ok || merr.Symbol != market.ErrState {
		t.Fatalf("second settle error = %v, want a *market.Err{Symbol: STATE}", err)
	}
}

func TestRunKeeperCycle_OuterWindowLapsed_SettlesImmediatelyWithoutWaitingForGrace(t *testing.T) {
	// The documented "Keeper note" optimization: once the OUTER window has
	// lapsed (by real block height), settle() alone resolves to VOID with
	// zero oracle dependency — fire it now rather than waiting the extra
	// GraceBlocks for voidStale.
	bcast := &countingBroadcaster{}
	s := &Scheduler{
		Cfg:         DefaultConfig("vsc1x"),
		Price:       FixedPriceSource{PriceBps: 2940, Tick: 500, FeedOK: false}, // feed DOWN — must not matter
		Block:       FixedBlockSource{Block: 1000 + market.SettleWindowBlocks + 1},
		Broadcaster: bcast,
		Caller:      "hive:keeper-bot",
	}
	round := RoundSchedule{ID: 1, Asset: "hbd", State: market.StateOpen, SettleBlock: 1000, GraceBlocks: 5000}
	res, err := s.RunKeeperCycle(round)
	if err != nil {
		t.Fatalf("RunKeeperCycle: %v", err)
	}
	if res.Action != KeeperSettle {
		t.Fatalf("action = %v, want settle (outer window lapsed => auto-void, oracle-independent)", res.Action)
	}
	if res.Fallback != KeeperWait {
		t.Fatalf("fallback = %v, want none (the primary settle succeeded)", res.Fallback)
	}
	if bcast.calls != 1 {
		t.Fatalf("expected exactly 1 broadcast (settle only, no voidStale needed), got %d", bcast.calls)
	}
}

func TestRunKeeperCycle_SettleBroadcastFailsPastGrace_FallsBackToVoidStale(t *testing.T) {
	fb := &failingActionBroadcaster{failAction: "settle"}
	s := &Scheduler{
		Cfg:         DefaultConfig("vsc1x"),
		Price:       FixedPriceSource{PriceBps: 2940, Tick: 500, FeedOK: false},
		Block:       FixedBlockSource{Block: 1000 + market.SettleWindowBlocks + 100 + 1}, // past window AND past grace
		Broadcaster: fb,
		Caller:      "hive:keeper-bot",
	}
	round := RoundSchedule{ID: 1, Asset: "hbd", State: market.StateOpen, SettleBlock: 1000, GraceBlocks: 100}
	res, err := s.RunKeeperCycle(round)
	if err != nil {
		t.Fatalf("RunKeeperCycle: %v", err)
	}
	if res.Action != KeeperSettle || res.Err == nil {
		t.Fatalf("expected the primary settle attempt to be tried and fail, got %+v", res)
	}
	if res.Fallback != KeeperVoidStale {
		t.Fatalf("fallback = %v, want void_stale", res.Fallback)
	}
	if res.FallbackTxID == "" || res.FallbackErr != nil {
		t.Fatalf("expected the voidStale fallback to succeed, got %+v", res)
	}
	if got := strings.Join(fb.calls, ","); got != "settle,voidStale" {
		t.Fatalf("broadcast call order = %q, want settle,voidStale", got)
	}
}

func TestRunKeeperCycle_SettleBroadcastFailsBeforeGrace_NoFallbackYet(t *testing.T) {
	// If the primary settle attempt fails but we're NOT yet past the settle
	// deadline, voidStale would itself be rejected on-chain (settle.go:129) —
	// the correct behavior is to do nothing further and let the next poll
	// retry settle fresh, not to prematurely reach for voidStale.
	fb := &failingActionBroadcaster{failAction: "settle"}
	s := &Scheduler{
		Cfg:         DefaultConfig("vsc1x"),
		Price:       FixedPriceSource{PriceBps: 2940, Tick: 1000, FeedOK: true},
		Block:       FixedBlockSource{Block: 1000}, // inside the qualifying window, well before window+grace
		Broadcaster: fb,
		Caller:      "hive:keeper-bot",
	}
	round := RoundSchedule{ID: 1, Asset: "hbd", State: market.StateOpen, SettleBlock: 1000, GraceBlocks: 100}
	res, err := s.RunKeeperCycle(round)
	if err != nil {
		t.Fatalf("RunKeeperCycle: %v", err)
	}
	if res.Err == nil {
		t.Fatal("expected the primary settle attempt to be tried and fail")
	}
	if res.Fallback != KeeperWait {
		t.Fatalf("fallback = %v, want none (not yet past the settle deadline)", res.Fallback)
	}
	if got := strings.Join(fb.calls, ","); got != "settle" {
		t.Fatalf("broadcast call order = %q, want settle only (no premature voidStale)", got)
	}
}

func TestDryRunBroadcaster_PrintsOp(t *testing.T) {
	var buf bytes.Buffer
	b := &DryRunBroadcaster{Out: &buf}
	op, err := BuildSettleOp(testCfg(), "hive:keeper-bot", 42)
	if err != nil {
		t.Fatalf("BuildSettleOp: %v", err)
	}
	txID, err := b.Broadcast(op)
	if err != nil {
		t.Fatalf("Broadcast: %v", err)
	}
	if txID != "dryrun-tx-1" {
		t.Fatalf("txID = %q, want dryrun-tx-1", txID)
	}
	out := buf.String()
	if !strings.Contains(out, "vsc.call") || !strings.Contains(out, "settle") || !strings.Contains(out, "42") {
		t.Fatalf("dry-run output missing expected content: %s", out)
	}
}

func TestHiveBroadcaster_NotImplemented(t *testing.T) {
	h := &HiveBroadcaster{}
	op, _ := BuildSettleOp(testCfg(), "hive:keeper-bot", 1)
	if _, err := h.Broadcast(op); err == nil {
		t.Fatal("expected HiveBroadcaster.Broadcast to return an explicit not-implemented error")
	}
}
