// Command scheduler is the off-chain automation CLI for the Hive Price
// Weekly Market. Today it only supports --dry-run: it wires the scheduler
// package's real logic (the overlap guard, the low-latency tick-window
// settle-keeper decision, the voidStale fallback) against MOCK I/O
// (FixedPriceSource, FixedBlockSource, MockStateReader, DryRunBroadcaster)
// and prints exactly what a live run would broadcast, for one full weekly
// cycle:
//
//	roll -> (overlap guard demo) -> settle keeper (wait / settle / void-fallback)
//
// The contract's export set is roll/bet/claim/settle/voidStale/reclaim/
// sweepUnclaimed/peekPrice (contract/main.go) — no createRound, no
// withdrawFees; the market is zero-rake and fully permissionless by
// construction (contract/main.go's "NO PRIVILEGED OPERATIONS" section). This
// scheduler only automates the two things nothing else can do
// permissionlessly-but-promptly: rolling the next round and settling inside
// the ~100-block oracle-tick window.
//
// Real broadcast (scheduler.HiveBroadcaster) and real reads
// (scheduler.GQLPriceSource / GQLStateReader / GQLBlockSource) are separate,
// already-real (stdlib net/http) implementations — see ../../scheduler/*.go
// — but wiring them here needs signing keys + a live deployed contract,
// neither of which exist yet (DUMB-QUESTIONS-RESOLVED E1). --live is a
// DELIBERATE dead end until then: it exists so the flag surface is honest
// about what "live" will look like, not to sneak broadcast code in early.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"hive-price-market/market"
	"hive-price-market/scheduler"
)

func main() {
	dryRun := flag.Bool("dry-run", true, "print planned ops instead of broadcasting (the only mode implemented today)")
	live := flag.Bool("live", false, "broadcast for real — NOT WIRED (deliberate); see scheduler.HiveBroadcaster's doc comment")
	contractID := flag.String("contract", "vsc1demo000000000000000000000000000000", "target contract id")
	caller := flag.String("caller", "hive:scheduler-bot", "the scheduler bot's Hive account")
	priceBps := flag.Uint64("price", 2940, "mock live oracle price (HBD/HIVE bps) to plan this cycle against")
	tick := flag.Uint64("tick", 0, "mock pendulum tick_block_height (0 = derive a sane demo value per step)")
	feedOK := flag.Bool("feed-ok", true, "mock oracle feedOK (hive_ma_ok && trusted_hive_mean_ok) for the roll + early keeper steps")
	block := flag.Uint64("block", 100_000_000, "mock current Hive L1 block height to start this cycle at")
	flag.Parse()

	if *live || !*dryRun {
		fmt.Fprintln(os.Stderr, "live broadcast is not wired — deliberate (see scheduler.HiveBroadcaster's doc comment): needs a signer + a live deployed contract; only --dry-run=true is implemented today")
		os.Exit(1)
	}

	cfg := scheduler.DefaultConfig(*contractID) // Asset defaults to market.AssetHbd — must match RollRound's hardcoded stake asset
	state := scheduler.MockStateReader{}
	bcast := &scheduler.DryRunBroadcaster{Out: os.Stdout}

	s := &scheduler.Scheduler{
		Cfg:         cfg,
		Price:       scheduler.FixedPriceSource{PriceBps: *priceBps, Tick: *tick, FeedOK: *feedOK},
		Block:       scheduler.FixedBlockSource{Block: *block},
		State:       state,
		Broadcaster: bcast,
		Caller:      *caller,
	}

	fmt.Printf("=== Hive Price Weekly Market — scheduler dry run ===\n")
	fmt.Printf("contract=%s caller=%s currentBlock=%d mockPriceBps=%d asset=%s\n", *contractID, *caller, *block, *priceBps, cfg.Asset)
	fmt.Printf("recommended live poll interval: %ds (must stay well under one ~100-block/~300s pendulum tick)\n\n", scheduler.RecommendedPollIntervalSeconds)

	fmt.Println(">>> STEP 1: weekly roll cycle (no round open yet)")
	created, err := s.RunRollCycle(*block)
	if err != nil {
		fmt.Fprintln(os.Stderr, "roll cycle failed:", err)
		os.Exit(1)
	}
	if created.Skipped {
		fmt.Println("SKIPPED:", created.SkipReason)
		os.Exit(1)
	}
	fmt.Printf("planned: observedPriceBps=%d (NOT sent on-chain — roll's payload is ignored; the contract derives strikes+timing itself)\n  txID=%s\n\n", created.ObservedPriceBps, created.TxID)

	fmt.Println(">>> STEP 2: overlap guard demo — run the SAME cycle again with that round now OPEN on-chain")
	state["active|"+cfg.Asset] = "1" // round id 0 (stored as id+1)
	state["rd|0|state"] = market.StateOpen
	created2, err := s.RunRollCycle(*block + 10)
	if err != nil {
		fmt.Fprintln(os.Stderr, "roll cycle (2) failed:", err)
		os.Exit(1)
	}
	if !created2.Skipped {
		fmt.Fprintln(os.Stderr, "UNEXPECTED: second roll cycle was not skipped by the overlap guard")
		os.Exit(1)
	}
	fmt.Println("SKIPPED (expected — overlap guard held):", created2.SkipReason)
	fmt.Println()

	// The contract computed the round's real lock/settle/grace on-chain
	// (market.RollRound, from protocol constants) — this demo mirrors that
	// SAME deterministic math purely so the keeper steps below have a
	// realistic settleBlock to poll against; a live scheduler would instead
	// read rd|<id>|settle/grace back off-chain (scheduler.ReadRoundSchedule).
	lockBlock := *block + market.RollBettingBlocks
	settleBlock := lockBlock + market.RollSettleGapBlocks
	graceBlocks := uint64(market.RollGraceBlocks)
	round := scheduler.RoundSchedule{ID: 0, Asset: cfg.Asset, State: market.StateOpen, SettleBlock: settleBlock, GraceBlocks: graceBlocks}
	fmt.Printf("(demo only — mirrors the contract's own RollRound math) round 0: lock=%d settle=%d grace=%d\n\n", lockBlock, settleBlock, graceBlocks)

	fmt.Println(">>> STEP 3: settle keeper poll — round still open, well before settleBlock")
	s.Block = scheduler.FixedBlockSource{Block: settleBlock - 500}
	early, err := s.RunKeeperCycle(round)
	if err != nil {
		fmt.Fprintln(os.Stderr, "keeper cycle (early) failed:", err)
		os.Exit(1)
	}
	fmt.Printf("round %d -> action=%s (skipped=%v)\n\n", early.RoundID, early.Action, early.Skipped)

	fmt.Println(">>> STEP 4: settle keeper poll — the qualifying oracle tick has landed AT settleBlock, feed healthy (the low-latency happy path)")
	s.Block = scheduler.FixedBlockSource{Block: settleBlock}
	s.Price = scheduler.FixedPriceSource{PriceBps: *priceBps, Tick: settleBlock, FeedOK: true}
	atSettle, err := s.RunKeeperCycle(round)
	if err != nil {
		fmt.Fprintln(os.Stderr, "keeper cycle (settle) failed:", err)
		os.Exit(1)
	}
	fmt.Printf("round %d -> action=%s txID=%s\n\n", atSettle.RoundID, atSettle.Action, atSettle.TxID)

	fmt.Println(">>> STEP 5: settle keeper poll — outer window has lapsed, feed DOWN — settle() alone still resolves it via auto-VOID (zero oracle dependency; no need to wait for voidStale's extra grace)")
	pastWindow := settleBlock + market.SettleWindowBlocks + 1
	s.Block = scheduler.FixedBlockSource{Block: pastWindow}
	s.Price = scheduler.FixedPriceSource{PriceBps: *priceBps, Tick: 0, FeedOK: false}
	roundStillOpen := round // in this demo nobody settled it yet, so it's still OPEN
	autoVoid, err := s.RunKeeperCycle(roundStillOpen)
	if err != nil {
		fmt.Fprintln(os.Stderr, "keeper cycle (auto-void) failed:", err)
		os.Exit(1)
	}
	fmt.Printf("round %d -> action=%s txID=%s fallback=%s\n\n", autoVoid.RoundID, autoVoid.Action, autoVoid.TxID, autoVoid.Fallback)

	fmt.Println(">>> STEP 6: settle keeper poll — voidStale FALLBACK demo: the primary settle broadcast itself fails past the settle deadline")
	failing := &failingSettleBroadcaster{Out: os.Stdout}
	s.Broadcaster = failing
	pastGrace := settleBlock + market.SettleWindowBlocks + graceBlocks + 1
	s.Block = scheduler.FixedBlockSource{Block: pastGrace}
	fallback, err := s.RunKeeperCycle(roundStillOpen)
	if err != nil {
		fmt.Fprintln(os.Stderr, "keeper cycle (fallback) failed:", err)
		os.Exit(1)
	}
	fmt.Printf("round %d -> action=%s err=%v\n  fallback=%s fallbackTxID=%s fallbackErr=%v\n\n",
		fallback.RoundID, fallback.Action, fallback.Err, fallback.Fallback, fallback.FallbackTxID, fallback.FallbackErr)
	s.Broadcaster = bcast

	fmt.Println(">>> STEP 7: reclaim op shape demo — the user self-serve fail-safe (not broadcast by the keeper itself; any staker can send this)")
	reclaimCfg := scheduler.OpConfig{NetID: cfg.NetID, ContractID: cfg.ContractID, RCLimit: cfg.RCLimit}
	reclaimOp, err := scheduler.BuildReclaimOp(reclaimCfg, "hive:some-staker", 0)
	if err != nil {
		fmt.Fprintln(os.Stderr, "build reclaim op failed:", err)
		os.Exit(1)
	}
	if _, err := (&scheduler.DryRunBroadcaster{Out: os.Stdout}).Broadcast(reclaimOp); err != nil {
		fmt.Fprintln(os.Stderr, "print reclaim op failed:", err)
		os.Exit(1)
	}

	fmt.Println("=== dry run complete: full weekly cycle planned (roll -> settle-window -> void-fallback), nothing broadcast to a live chain ===")
}

// failingSettleBroadcaster fails only the "settle" action and delegates
// everything else (voidStale) to a real DryRunBroadcaster print — used to
// demonstrate RunKeeperCycle's fallback path in the dry-run output without
// needing any real network/broadcast code.
type failingSettleBroadcaster struct {
	Out io.Writer
	dry scheduler.DryRunBroadcaster
	n   int
}

func (f *failingSettleBroadcaster) Broadcast(op scheduler.CustomJSON) (string, error) {
	f.n++
	if f.dry.Out == nil {
		f.dry.Out = f.Out
	}
	if strings.Contains(op.JSON, `"action":"settle"`) {
		fmt.Fprintf(f.Out, "--- DRY RUN broadcast #%d (custom_json id=%q) SIMULATED FAILURE (e.g. RC exhaustion / network hiccup) ---\n\n", f.n, op.ID)
		return "", fmt.Errorf("simulated broadcast failure for settle (demonstrating the voidStale fallback)")
	}
	return f.dry.Broadcast(op)
}
