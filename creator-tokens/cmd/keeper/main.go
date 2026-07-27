// Command keeper is the off-chain automation CLI for Magi Creator Keys'
// wind-down (SPEC-CREATOR-KEYS.md §1.7.5). Today it only supports --dry-run:
// it wires the keeper package's REAL decision logic (Plan's phase/balance
// filtering, ordering, and Sweep's retry/backoff/partial-failure handling)
// against a REAL core.MemStore + a REAL indexer.Index — both driven by the
// actual core and indexer packages, not stand-ins for them — and prints
// exactly what a live run would submit, for a walkthrough covering every
// shape of market this task's spec calls out:
//
//	ACTIVE market (nothing due) -> FROZEN market with holders to refund ->
//	FROZEN market already fully drained (closeIfDrained only) -> FROZEN
//	market with an outstanding escrow (closeIfDrained correctly no-ops) ->
//	a simulated transient failure that backoff recovers from -> a simulated
//	permanent failure that Sweep skips over without aborting the rest.
//
// Real submission (keeper.LiveSubmitter) is explicitly out of scope for this
// build — see keeper/submit.go's doc. --live exists as a CODE PATH so the
// gating logic itself is real and testable, but it is deliberately GATED
// behind two independent, no-default flags, and even when both are given it
// still only reaches a Submitter that refuses every call by design.
package main

import (
	"flag"
	"fmt"
	"io"
	"math/big"
	"os"
	"time"

	"creator-tokens/core"
	"creator-tokens/indexer"
	"creator-tokens/keeper"
)

func main() {
	dryRun := flag.Bool("dry-run", true, "plan the sweep and print every op it would submit; touches nothing (default, and the only mode implemented today)")
	live := flag.Bool("live", false, "attempt LIVE mode instead of --dry-run. GATED: also requires --confirm-live=true. Even fully confirmed, live submission is deliberately NOT wired yet (see keeper.LiveSubmitter) -- broadcasting real Hive transactions is out of scope for this build.")
	confirmLive := flag.Bool("confirm-live", false, "second, independent confirmation required alongside --live=true. Neither flag has a 'yes' default; both must be explicit.")

	contractID := flag.String("contract", "vsc1demo000000000000000000000000000000", "target contract id")
	caller := flag.String("caller", "hive:creator-keys-keeper", "the keeper bot's own Hive account (signs the OUTER custom_json transaction; never validated against a market's account charset -- see core/refund.go's RefundHolder doc)")
	netID := flag.String("net-id", "vsc-testnet", "Hive custom_json net_id")
	rcLimit := flag.Uint64("rc-limit", 5000, "rc_limit attached to every op this keeper builds")
	block := flag.Uint64("block", 0, "mock current Magi block height for this demo sweep (0 = computed from the demo scenario's own registration blocks)")
	flag.Parse()

	cfg := keeper.OpConfig{NetID: *netID, ContractID: *contractID, RCLimit: *rcLimit}

	if *live {
		if !*confirmLive {
			fmt.Fprintln(os.Stderr, "refusing to run live: --live requires --confirm-live=true as well (two independent flags, both explicit, neither defaults to true)")
			os.Exit(1)
		}
		fmt.Println("=== LIVE mode confirmed -- but live submission is deliberately NOT implemented yet ===")
		liveSub := &keeper.LiveSubmitter{Cfg: cfg, Caller: *caller}
		_, err := liveSub.Submit(keeper.Op{Kind: keeper.OpCloseIfDrained, Creator: "demo"})
		fmt.Fprintln(os.Stderr, "keeper: refusing to proceed:", err)
		fmt.Fprintln(os.Stderr, "see RUNBOOK.md's pre-mainnet gate list -- real broadcast needs a signer + a live deployed contract, neither of which this task built.")
		os.Exit(1)
	}
	if !*dryRun {
		fmt.Fprintln(os.Stderr, "only --dry-run=true is implemented without --live: pass --live=true --confirm-live=true to see why live mode still refuses (see keeper.LiveSubmitter)")
		os.Exit(1)
	}

	// ---- build the demo scenario: a REAL core.MemStore + REAL indexer.Index ----
	store, ix, demoBlock := buildDemoScenario()
	if *block != 0 {
		demoBlock = *block
	}

	fmt.Printf("=== Magi Creator Keys — keeper dry run ===\ncontract=%s caller=%s netID=%s currentBlock=%d\n\n", *contractID, *caller, *netID, demoBlock)

	views := collectMarketViews(store, ix, demoBlock, []string{"aliceart", "bobmusic", "carlwrites", "danerin"})
	for _, v := range views {
		fmt.Printf(">>> %-12s phase=%-7s supply=%-8s holders(verified-live-balance)=%d\n", v.Creator, v.Phase, safeStr(v.Supply), len(v.Holders))
		for _, h := range v.Holders {
			fmt.Printf("      candidate holder %-10s indexer-discovered, live balance=%s\n", h.Holder, h.Balance)
		}
		// Informational only -- the keeper's own Plan/Sweep never reads this;
		// it's the kind of signal an operator dashboard built on top of this
		// package would show alongside a sweep report (task spec: "read...
		// its HolderList and DeliveryRecord in particular").
		rec := ix.DeliveryRecord(v.Creator, 12)
		fmt.Printf("      (context only, not a sweep input) delivery record: answered=%d missed=%d pending=%d\n", rec.AnsweredCount, rec.MissedCount, rec.PendingCount)
	}
	fmt.Println()

	fmt.Println(">>> PLAN: the exact ops Sweep will attempt, in order")
	for i, op := range keeper.Plan(views) {
		fmt.Printf("  %2d. %s\n", i+1, op.String())
	}
	fmt.Println()

	// ---- submitter: real envelope-printing DryRunSubmitter, wrapped with a
	// SIMULATED flake (transient failure on one op, permanent on another) so
	// this walkthrough actually exercises Sweep's backoff-then-succeed and
	// exhaust-then-continue paths, not just the happy path. The flakiness is
	// simulated in THIS file only -- DryRunSubmitter itself is never anything
	// but a pure, non-mutating renderer; the demo store above is never
	// written to by any submission, live or dry-run. ----
	dr := &keeper.DryRunSubmitter{Cfg: cfg, Caller: *caller, Out: os.Stdout}
	flaky := &demoFlakySubmitter{
		inner:          dr,
		out:            os.Stdout,
		transientFails: map[string]int{keeper.Op{Kind: keeper.OpRefundHolder, Creator: "aliceart", Holder: "patron2"}.String(): 2},
		permanentFail:  keeper.Op{Kind: keeper.OpRefundHolder, Creator: "aliceart", Holder: "patron3"}.String(),
	}

	policy := keeper.BackoffPolicy{MaxAttempts: 3, InitialDelay: 2 * time.Second, Multiplier: 2, MaxDelay: 10 * time.Second}
	sleep := loggingSleep(os.Stdout)

	fmt.Println(">>> SWEEP: submitting the plan (dry run -- every envelope below is real, nothing is broadcast)")
	report := keeper.Sweep(views, flaky, policy, sleep)
	fmt.Println()

	fmt.Printf("=== sweep complete: %d succeeded, %d failed ===\n", report.Succeeded, report.Failed)
	for _, o := range report.Outcomes {
		if o.Err != nil {
			fmt.Printf("  FAILED after %d attempt(s): %s -- %v\n", len(o.Attempts), o.Op, o.Err)
			fmt.Println("    this is INCONVENIENCE, not harm: the holder can self-refund via `refund`, or any third party can push `refundHolder` for them; the next scheduled sweep will retry this op automatically from a fresh snapshot.")
		}
	}
	fmt.Println("\nnothing above touched the network or the demo store -- this is exactly what --live would submit, once a signer and a deployed contract exist.")
}

// buildDemoScenario builds a small, REAL core.MemStore + REAL indexer.Index
// covering every market shape this task's spec calls out. Every state
// transition below goes through the actual core.* functions (never a
// hand-crafted state key) and is logged through the actual core/events.go
// Ev* constructors into the indexer, exactly mirroring what
// contract/main.go's wasm entrypoints do after each successful call.
func buildDemoScenario() (*core.MemStore, *indexer.Index, uint64) {
	store := core.NewMemStore()
	ix := indexer.NewIndex()
	n := 0
	log := func(data string) {
		n++
		ix.Ingest([]indexer.RawEvent{{OutputID: fmt.Sprintf("demo-output-%d", n), Seq: 0, Data: data}})
	}

	const (
		registeredBlock = uint64(1_000_000)
		face            = int64(500)
		marketCap       = int64(1_000_000)
	)
	lapseBlock := registeredBlock + core.SubscriptionPeriod + core.GraceBlocks // FROZEN begins here
	demoBlock := lapseBlock + 500                                              // "now": comfortably into wind-down for the lapsed markets

	register := func(creator string) {
		must(core.Register(store, creator, creator, registeredBlock, face, marketCap))
		log(core.EvRegistered(creator, creator, registeredBlock, face, marketCap, big.NewInt(0)))
	}
	// RULING A (2026-07-21): the PAR mint is deleted; Buy on the curve is the
	// only issuance path. The demo mints via core.Buy and logs the existing
	// prepaid event shape (paid = TotalDue, minted = tokens) purely so the
	// indexer's holder discovery keeps working — a dedicated buy/sell event
	// schema is a Wave-D item, flagged in the RULING-A report.
	buy := func(creator, holder string, tokens int64) {
		res := must2(core.Buy(store, holder, creator, registeredBlock+1, big.NewInt(tokens)))
		log(core.EvPrepaid(creator, holder, registeredBlock+1, res.TotalDue, big.NewInt(tokens)))
	}

	// aliceart: FROZEN, three holders still owed a refund -- the ordinary case.
	register("aliceart")
	buy("aliceart", "patron1", 90)
	buy("aliceart", "patron2", 30)
	buy("aliceart", "patron3", 10)

	// bobmusic: registered RECENTLY (relative to demoBlock) -- still ACTIVE,
	// nothing due. Demonstrates Plan skipping a market outright.
	activeRegisteredBlock := demoBlock - 100
	must(core.Register(store, "bobmusic", "bobmusic", activeRegisteredBlock, face, marketCap))
	log(core.EvRegistered("bobmusic", "bobmusic", activeRegisteredBlock, face, marketCap, big.NewInt(0)))
	bobBuy := must2(core.Buy(store, "listener1", "bobmusic", activeRegisteredBlock+1, big.NewInt(40)))
	log(core.EvPrepaid("bobmusic", "listener1", activeRegisteredBlock+1, bobBuy.TotalDue, big.NewInt(40)))

	// carlwrites: FROZEN, but its one holder already self-refunded (the pull
	// path, `refund`) before this sweep ever ran -- HolderList is already
	// empty. Demonstrates Plan emitting ONLY closeIfDrained.
	register("carlwrites")
	buy("carlwrites", "onlyfan1", 20)
	selfRefundBlock := lapseBlock + 50
	payout := must2(core.Refund(store, "onlyfan1", "carlwrites", selfRefundBlock, big.NewInt(20)))
	log(core.EvRefunded("carlwrites", "onlyfan1", selfRefundBlock, big.NewInt(20), payout))

	// danerin: FROZEN, one holder to refund, PLUS an outstanding escrow (an
	// ask nobody has answered or reclaimed yet). Demonstrates closeIfDrained
	// correctly no-op'ing: I3 keeps Supply > 0 until that escrow resolves,
	// exactly SPEC §1.7.5's "in-flight asks are never cut off."
	register("danerin")
	buy("danerin", "reader1", 600)
	// RULING C (2026-07-21): the PAR fallback is DELETED — core.Ask refuses
	// unless BOTH observation windows (short + 7-day long) can price, so the
	// demo now feeds a real two-ring history the way live trading would:
	// 12 constant-rate observations spaced core.LongObsSpacing apart. The
	// marker rate 1000 sits in the coherent band for this market (S=600:
	// C5 tripwire needs rate >= ceil(area/S)/4 = 921; the C4 minimum-price
	// guard needs rate <= 2·face = 1000; spot(600) = 6670 stays the ceiling)
	// so settlement = min(1000, 1000, 6670) = 1000 and the ask costs
	// ceil(500/1000) = 1 credit. THE PREVIOUS VERSION recorded nothing and
	// relied on PAR — under RULING C that ask would refuse and this demo
	// would panic at startup.
	//
	// 33 markers, not 12: the funding Buy above already fed both rings ONE
	// observation at the curve's own marginal rate (6670), which the
	// constant 1000-marker series deviates from beyond MaxRateDeviationBps.
	// The demo has no test-only ring-clear helper, so it does what a real
	// market does — trades until the old observation falls out of the
	// 32-slot windows (33 marker writes leave both windows holding markers
	// only; the first marker lands inside the buy observation's
	// LongObsSpacing interval and is skipped by the long ring, so 33 writes
	// put exactly 32 markers there).
	obsRate := big.NewInt(1000)
	lastObs := registeredBlock + 10
	for i := uint64(0); i < 33; i++ {
		lastObs = registeredBlock + 10 + i*core.LongObsSpacing
		core.RecordObs(store, "danerin", lastObs, obsRate)
	}
	askBlock := lastObs + 50
	// commissionOwed (H2 defect fix, 2026-07-21): core.Ask requires
	// commissionHbdPaid to EXACTLY equal commissionOwedFor(face) — floor(face
	// * CommissionBps / 10000), not merely be >= it.
	commissionOwed := new(big.Int).Mul(big.NewInt(face), big.NewInt(int64(core.CommissionBps)))
	commissionOwed.Div(commissionOwed, big.NewInt(10000))
	askResult := must2(core.Ask(store, "reader1", "danerin", askBlock, big.NewInt(1), commissionOwed, "demo-content-hash", core.MinAskDeadline, 0))
	log(core.EvAsked("danerin", "reader1", askBlock, askResult.Seq, askResult.CreditsSpent, askResult.CommissionHbd, askResult.RateUsed, core.MinAskDeadline, "demo-content-hash"))

	return store, ix, demoBlock
}

// collectMarketViews is cmd/keeper's own I/O composition step -- NOT part of
// the keeper package, deliberately (see keeper/keeper.go's package doc: the
// keeper package itself takes a snapshot as given and does no reading of its
// own). This is where "verify, don't trust" gets its teeth: candidate
// holders come from the INDEXER (discovery -- who might still be owed
// something), but every Balance actually handed to keeper.Plan is a FRESH
// read from the chain-of-record (core.BalanceOf against the live store, here
// standing in for a real getStateByKeys call -- SPEC §2.5's own rule: "Chain
// reads:...per-holder balances", never the indexer, is authoritative).
func collectMarketViews(store *core.MemStore, ix *indexer.Index, block uint64, creators []string) []keeper.MarketView {
	views := make([]keeper.MarketView, 0, len(creators))
	for _, creator := range creators {
		phase := core.Phase(store, creator, block)
		var holders []keeper.HolderBalance
		for _, h := range ix.HolderList(creator) {
			holders = append(holders, keeper.HolderBalance{Holder: h, Balance: core.BalanceOf(store, creator, h)})
		}
		views = append(views, keeper.MarketView{
			Creator: creator,
			Phase:   phase,
			Supply:  core.Supply(store, creator),
			Holders: holders,
		})
	}
	return views
}

// demoFlakySubmitter wraps a real Submitter (DryRunSubmitter in this CLI) to
// simulate a transient failure (fails N times, then delegates through) and a
// permanent one (always fails) for specific, named ops -- purely to exercise
// Sweep's backoff-then-succeed and exhaust-then-continue behaviour in this
// walkthrough. It never mutates anything itself; every "success" path still
// goes through the real, non-mutating DryRunSubmitter underneath.
type demoFlakySubmitter struct {
	inner          keeper.Submitter
	out            io.Writer
	transientFails map[string]int // op.String() -> remaining simulated failures
	permanentFail  string         // op.String() that always fails
	calls          map[string]int
}

func (f *demoFlakySubmitter) Submit(op keeper.Op) (string, error) {
	if f.calls == nil {
		f.calls = map[string]int{}
	}
	key := op.String()
	f.calls[key]++

	if key == f.permanentFail {
		fmt.Fprintf(f.out, "[SIMULATED] %s: permanent failure (attempt %d) -- demonstrating a real, unrecoverable error\n", key, f.calls[key])
		return "", fmt.Errorf("simulated permanent failure for %s", key)
	}
	if remaining, ok := f.transientFails[key]; ok && f.calls[key] <= remaining {
		fmt.Fprintf(f.out, "[SIMULATED] %s: transient failure (attempt %d of %d) -- demonstrating backoff\n", key, f.calls[key], remaining)
		return "", fmt.Errorf("simulated transient failure for %s (attempt %d)", key, f.calls[key])
	}
	return f.inner.Submit(op)
}

// loggingSleep prints what a real deployment would wait, instead of actually
// waiting -- so this CLI's demo runs instantly rather than sitting through
// several real backoff delays. Production callers should pass time.Sleep
// directly to keeper.Sweep.
func loggingSleep(out io.Writer) func(time.Duration) {
	return func(d time.Duration) {
		fmt.Fprintf(out, "  (backoff: a real run would wait %s before retrying)\n", d)
	}
}

func safeStr(v *big.Int) string {
	if v == nil {
		return "0"
	}
	return v.String()
}

func must(err error) {
	if err != nil {
		panic("keeper demo setup: " + err.Error())
	}
}

func must2[T any](v T, err error) T {
	if err != nil {
		panic(fmt.Sprintf("keeper demo setup: %v", err))
	}
	return v
}
