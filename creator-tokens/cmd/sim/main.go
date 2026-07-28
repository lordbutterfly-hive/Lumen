// Command sim runs the Magi Creator Keys population simulator (sim/) against
// a real core.Store for a configurable number of simulated days, then prints
// a readable summary and writes the full structured trace as JSON.
//
// This is NOT a test suite — it plays out a population of named, seeded
// actors with distinct behaviour profiles (reliable/flaky/abandoner/
// price-mover creators; fans/one-shot askers/speculators/traders; a keeper;
// synthetic oracle feeds) against the real core.Register/Renew/SetFace/
// SetCap/Buy/Sell/TransferCredits/Ask/Answer/Decline/Reclaim/Refund/
// RefundHolder/CloseIfDrained/RecordObs/WithdrawTreasury/Retire/
// ClaimTradeFees/CreateOffering/SetOfferingPrice/SetOfferingTitle/
// DeleteOffering, asserting a set of fund invariants after every single call
// and halting loudly (with the seed and the exact triggering event) the
// instant any of them breaks.
//
// ★ FIXED (2026-07-28, gap-hunt closure — re-verified directly against
// sim/actions.go and sim/engine.go, not copied from any prior note): this
// list used to say "Prepay" — deleted along with the PAR-mint mechanism
// (RULING A, RULINGS-v2-2026-07-21; core.Buy on the bonding curve is the
// only issuance path now) — and used to claim Sell, Decline, the offering
// catalogue (CreateOffering/SetOfferingPrice/SetOfferingTitle/
// DeleteOffering), ClaimTradeFees and Retire were NOT YET exercised. All of
// those are now driven: doSell/doDecline/doRetire/doClaimTradeFees/
// doCreateOffering/doSetOfferingPrice/doSetOfferingTitle/doDeleteOffering
// (sim/actions.go) are each wired into the engine's own scheduling logic —
// verified by call site, not just by existing as a function — and
// pickAskTarget/doAskExecute (sim/actions.go) route some asks at a named
// offering (OfferingID != 0, core.Ask's offeringID branch), not only the
// legacy single face price. The delivery-gate standing guardrail
// (core/delivery.go / engine.go's checkDelinquencyGuardrail) is now proven
// non-vacuous by a permanent, CI-enforced test —
// TestDenseRunProvesDelinquencyGuardrailNonVacuous (sim/upgrades_test.go) —
// rather than resting on a manual run that once happened to show good
// counters.
//
// STILL a real, un-driven gap, left honestly rather than claimed away: this
// package has never observed a Retire call against a creator that is
// ALREADY delinquent at that exact moment. Retire itself IS exercised, on
// two separate paths (creatorTick, engine.go) — RetireOnAbandon (an
// abandoning/flaky creator's formal wind-down notice, fired once at its own
// pre-scheduled AbandonBlock) and VoluntaryRetireBlock (a healthy
// RoleCreatorReliable creator's late, clean shutdown, explicitly "never
// delinquent" by this package's own construction, engine.go) — but neither
// path is COUPLED to a live core.DeliveryStanding read: AbandonBlock is
// chosen once at population setup, independently of whatever delinquency
// state a creator later happens to accrue, so the two conditions coinciding
// on the same tick is a low-probability intersection of two largely
// independent draws, not something this simulator deliberately drives. That
// makes it structurally rare rather than actively exercised — a real
// coverage gap in the population/timing model, not a fixed one.
//
// Usage:
//
//	go run ./cmd/sim --seed 1 --days 7  --creators 8 --actors 24 --out week.json
//	go run ./cmd/sim --seed 1 --days 90 --creators 8 --actors 24 --out quarter.json
//
// ★ THE SHIPPED DEFAULTS (creators=8, actors=24) DO NOT RELIABLY EXERCISE THE
// DELIVERY-GATE STANDING GUARDRAIL (F3, an adversarial review — verified
// directly: guardrailExercised=false at both --days 7 and --days 90 at these
// defaults, seed=1). This is a DELIBERATE, DOCUMENTED choice, not an
// oversight left unfixed: settlement.go's MaxSpendSupplyBps (a fixed-size ask
// must clear 5% of the CURRENT supply) means a broad population spread across
// many creators grows each individual market's supply too slowly for asks —
// and therefore misses, and therefore delinquency — to happen at all within a
// short-to-medium run, which is realistic default behaviour for exploring a
// population's overall shape, not a guardrail-focused run. This command now
// REFUSES TO STAY SILENT about that: it checks
// eng.DeliveryGuardrailExercised() after every run and prints an unmissable
// banner, exiting 3 (distinct from 1=invariant violation, 2=trace-write
// failure) whenever the guardrail proof is vacuous. To actually EXERCISE the
// guardrail, concentrate the same population onto fewer, deeper markets over
// a longer horizon — the exact config sim/upgrades_test.go's own
// TestDenseRunProvesDelinquencyGuardrailNonVacuous pins as CI-enforced proof
// this is reachable, not just theorized:
//
//	go run ./cmd/sim --seed 2 --days 180 --creators 2 --actors 40 --out dense.json
//
// Report honestly, per this same finding: even at that CI config, 2 creators
// only cover 2 of the 4 creator roles (round-robin assignment, actors.go) —
// no price_mover (so no oracle feed, no recordObs, no legacy setFace changes
// at all) and no abandoner. The one config where the delivery-gate guardrail
// IS proven non-vacuous has no price-mover coverage and no Retire coverage
// (Retire only fires from an abandoner's AbandonBlock or a reliable
// creator's VoluntaryRetireBlock roll — see the package-doc note above on
// Retire's own coverage gap). Neither run alone is a complete proof of
// everything this simulator can exercise; that is why sim/upgrades_test.go
// runs BOTH a broad config (this command's own defaults, via the other
// upgrade tests) and this dense one, not one in place of the other.
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
	numCreators := flag.Int("creators", 8, "number of creator actors, split round-robin across reliable/flaky/abandoner/price_mover (NOTE: at the default 8/24 split, the delivery-gate standing guardrail is NOT reliably exercised -- see this command's own package doc, F3)")
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

	// F3 (an adversarial review): sim/engine.go names cmd/sim as the
	// intended caller of DeliveryGuardrailExercised() ("so a caller outside
	// this package -- cmd/sim, a CI gate, a test -- can... treat a vacuous
	// proof as a hard failure instead of a string buried in Summary()'s
	// text") but until this fix nothing under cmd/ ever called it -- a
	// vacuous run (the shipped defaults, per this command's own package
	// doc) printed a clean "trace written" line and exited 0, with the
	// vacuity readable only if a human happened to scroll up and read
	// Summary()'s own header. This is now impossible to miss: an unmissable
	// banner on EVERY vacuous run, and a distinct non-zero exit code (3 --
	// never 1, which this command already uses for a genuine invariant
	// violation, and never 2, already used for a trace-write failure) so a
	// script or CI step notices without parsing Summary()'s prose.
	guardrailVacuous := !eng.DeliveryGuardrailExercised()
	if guardrailVacuous {
		fmt.Fprintf(os.Stderr, "\n*******************************************************************\n")
		fmt.Fprintf(os.Stderr, "*** DELIVERY-GATE STANDING GUARDRAIL: VACUOUS THIS RUN          ***\n")
		fmt.Fprintf(os.Stderr, "*** DQ=%+v\n", eng.DQ)
		fmt.Fprintf(os.Stderr, "*** Neither half was exercised (or only one half was) -- this run\n")
		fmt.Fprintf(os.Stderr, "*** proves NOTHING about the delivery-gate guardrail either way.\n")
		fmt.Fprintf(os.Stderr, "*** The shipped defaults (creators=8, actors=24) do not reliably\n")
		fmt.Fprintf(os.Stderr, "*** reach it -- see this command's own package doc (F3) for the\n")
		fmt.Fprintf(os.Stderr, "*** dense config that does, and for what THAT config gives up.\n")
		fmt.Fprintf(os.Stderr, "*******************************************************************\n")
	}

	if runErr != nil {
		fmt.Fprintf(os.Stderr, "\n*** SIMULATION HALTED ON INVARIANT VIOLATION ***\n%v\n", runErr)
		os.Exit(1)
	}
	if guardrailVacuous {
		os.Exit(3)
	}
}
