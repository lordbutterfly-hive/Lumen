// Command sim runs the Magi Creator Keys population simulator (sim/) against
// a real core.Store for a configurable number of simulated days, then prints
// a readable summary and writes the full structured trace as JSON.
//
// This is NOT a test suite — it plays out a population of named, seeded
// actors with distinct behaviour profiles (reliable/flaky/abandoner/
// price-mover creators; fans/one-shot askers/speculators/traders; a keeper;
// synthetic oracle feeds) against the real core.Register/Renew/SetFace/
// SetCap/Buy/TransferCredits/Ask/Answer/Reclaim/Refund/RefundHolder/
// CloseIfDrained/RecordObs/WithdrawTreasury, asserting a set of fund
// invariants after every single call and halting loudly (with the seed and
// the exact triggering event) the instant any of them breaks.
//
// ★ FIXED: this list used to say "Prepay" — deleted along with the PAR-mint
// mechanism (RULING A, RULINGS-v2-2026-07-21; core.Buy on the bonding curve
// is the only issuance path now, verified against sim/actions.go and
// sim/engine.go, which call core.Buy, never core.Prepay) — and was missing
// WithdrawTreasury, which sim/ does call. NOT YET exercised by sim/ as of
// this pass (verified the same way): Sell, Decline, CreateOffering/
// SetOfferingPrice/SetOfferingTitle/DeleteOffering, ClaimTradeFees, Retire —
// flagged in the handoff report as a coverage gap in sim/ itself (out of
// this fix's ownership), not claimed as exercised here.
//
// Usage:
//
//	go run ./cmd/sim --seed 1 --days 7  --creators 8 --actors 24 --out week.json
//	go run ./cmd/sim --seed 1 --days 90 --creators 8 --actors 24 --out quarter.json
package main

import (
	"flag"
	"fmt"
	"os"

	"creator-tokens/sim"
)

func main() {
	seed := flag.Int64("seed", 1, "master seed -- the whole run replays exactly from this")
	days := flag.Int("days", 7, "simulated span, in days (a day, a week, a quarter -- e.g. 1, 7, 90)")
	numCreators := flag.Int("creators", 8, "number of creator actors, split round-robin across reliable/flaky/abandoner/price_mover")
	numActors := flag.Int("actors", 24, "number of non-creator actors, split round-robin across fan/one_shot/speculator/trader")
	out := flag.String("out", "sim-trace.json", "path to write the JSON trace")
	verbose := flag.Bool("verbose", false, "print progress detail (currently: nothing extra beyond the final summary; reserved)")
	keeperProfile := flag.String("keeper", "reliable", "keeper behaviour: reliable | absent (absent proves the fund fail-safes hold with no keeper)")
	adversarialOrder := flag.Bool("adversarial-order", false, "producer-adversarial intra-block order (creator/oracle moves front-run ask executions) instead of strict FIFO")
	flag.Parse()

	cfg := sim.Config{
		Seed:             *seed,
		Days:             *days,
		NumCreators:      *numCreators,
		NumActors:        *numActors,
		Verbose:          *verbose,
		KeeperProfile:    *keeperProfile,
		AdversarialOrder: *adversarialOrder,
	}

	fmt.Printf("running: seed=%d days=%d creators=%d actors=%d keeper=%s adversarialOrder=%v -> %s\n",
		cfg.Seed, cfg.Days, cfg.NumCreators, cfg.NumActors, cfg.KeeperProfile, cfg.AdversarialOrder, *out)

	eng := sim.NewEngine(cfg)
	runErr := eng.Run(cfg.Days)

	fmt.Println()
	fmt.Println(eng.Summary())

	if writeErr := eng.Trace.WriteJSON(*out); writeErr != nil {
		fmt.Fprintf(os.Stderr, "FATAL: failed to write trace to %s: %v\n", *out, writeErr)
		os.Exit(2)
	}
	fmt.Printf("trace written: %s (%d events)\n", *out, len(eng.Trace.Events))

	if runErr != nil {
		fmt.Fprintf(os.Stderr, "\n*** SIMULATION HALTED ON INVARIANT VIOLATION ***\n%v\n", runErr)
		os.Exit(1)
	}
}
