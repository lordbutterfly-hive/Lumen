// Command marketsim runs the hive-price-market population simulator
// (../../sim) — driving the REAL market package against a real in-memory
// Store over a simulated population of bettors, a keeper, and an oracle
// price path, for a configurable number of weekly rounds.
//
// Usage:
//
//	go run ./cmd/marketsim -weeks 52 -keeper all -seed 42 -out /tmp/marketsim
//
// -keeper reliable|late|absent runs one profile; -keeper all (default) runs
// all three with the SAME seed (so the population/oracle path are identical
// across profiles — only settle timing differs) and prints a comparison
// table, which is the primary thing this tool exists to produce: the VOID
// rate by keeper behaviour.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"sort"

	"hive-price-market/sim"
)

func main() {
	seed := flag.Int64("seed", 42, "master RNG seed (reproducible)")
	weeks := flag.Int("weeks", 52, "number of weekly rounds to simulate (52 = one simulated year)")
	keeperFlag := flag.String("keeper", "all", "keeper profile: reliable | late | absent | all")
	outDir := flag.String("out", "", "if set, write per-profile JSON trace + report files into this directory")
	quiet := flag.Bool("quiet", false, "suppress the per-profile detailed section (comparison table only)")
	flag.Parse()

	profiles, err := parseProfiles(*keeperFlag)
	if err != nil {
		fmt.Fprintln(os.Stderr, "marketsim:", err)
		os.Exit(2)
	}

	if *outDir != "" {
		if err := os.MkdirAll(*outDir, 0o755); err != nil {
			fmt.Fprintln(os.Stderr, "marketsim: mkdir -out:", err)
			os.Exit(2)
		}
	}

	var reports []*sim.Report
	for _, kp := range profiles {
		cfg := sim.DefaultConfig()
		cfg.Seed = *seed
		cfg.Weeks = *weeks
		cfg.Keeper = kp

		s := sim.NewSimulator(cfg)
		report, runErr := s.Run()

		if *outDir != "" {
			base := filepath.Join(*outDir, "marketsim-"+kp.String())
			if werr := s.Tracer().WriteJSON(base + ".trace.json"); werr != nil {
				fmt.Fprintln(os.Stderr, "marketsim: write trace:", werr)
			}
			if report != nil {
				if b, jerr := json.MarshalIndent(report, "", "  "); jerr == nil {
					_ = os.WriteFile(base+".report.json", b, 0o644)
				}
			}
		}

		if runErr != nil {
			fmt.Fprintln(os.Stderr, "=====================================================================")
			fmt.Fprintln(os.Stderr, "MARKETSIM HALTED — INVARIANT VIOLATION (fund-safety check failed)")
			fmt.Fprintln(os.Stderr, "=====================================================================")
			fmt.Fprintln(os.Stderr, runErr)
			if *outDir != "" {
				fmt.Fprintln(os.Stderr, "\nFull trace up to the halt was written under", *outDir)
			}
			os.Exit(1)
		}

		if !*quiet {
			printReport(report)
		}
		reports = append(reports, report)
	}

	if len(reports) > 1 {
		printComparison(reports)
	}
}

func parseProfiles(s string) ([]sim.KeeperProfile, error) {
	switch s {
	case "reliable":
		return []sim.KeeperProfile{sim.KeeperReliable}, nil
	case "late":
		return []sim.KeeperProfile{sim.KeeperLate}, nil
	case "absent":
		return []sim.KeeperProfile{sim.KeeperAbsent}, nil
	case "all", "":
		return []sim.KeeperProfile{sim.KeeperReliable, sim.KeeperLate, sim.KeeperAbsent}, nil
	default:
		return nil, fmt.Errorf("unknown -keeper %q (want reliable|late|absent|all)", s)
	}
}

func printReport(r *sim.Report) {
	fmt.Printf("\n================ keeper=%s  seed=%d  weeks=%d ================\n", r.KeeperProfile, r.Seed, r.Weeks)
	fmt.Printf("rounds rolled:            %d  (skipped, no roll: %d)\n", r.RoundsRolled, r.RoundsSkippedNoRoll)
	fmt.Printf("rounds settled:           %d\n", r.RoundsSettled)
	fmt.Printf("rounds voided:            %d  (VOID rate: %.1f%%)\n", r.RoundsVoid, r.VoidRate()*100)
	if len(r.RoundsVoidByReason) > 0 {
		reasons := make([]string, 0, len(r.RoundsVoidByReason))
		for k := range r.RoundsVoidByReason {
			reasons = append(reasons, k)
		}
		sort.Strings(reasons)
		for _, reason := range reasons {
			fmt.Printf("  - %-18s %d\n", reason, r.RoundsVoidByReason[reason])
		}
	}
	fmt.Printf("resolved via settle():    %d\n", r.ResolvedViaSettleCall)
	fmt.Printf("resolved via voidStale(): %d\n", r.ResolvedViaVoidStale)
	fmt.Printf("resolved via reclaim():   %d  (fail-safe — no keeper ever acted)\n", r.ResolvedViaReclaim)
	fmt.Printf("unresolved at end:        %d\n", r.UnresolvedRoundsAtEnd)
	fmt.Println()
	fmt.Printf("total staked:             %s\n", r.TotalStaked)
	fmt.Printf("total paid to actors:     %s\n", r.TotalPaid)
	fmt.Printf("total swept to DHF:       %s\n", r.TotalSwept)
	fmt.Printf("rejected late bets:       %d (all correctly rejected)\n", r.RejectedLateBets)
	fmt.Printf("rejected double-claims:   %d (all correctly rejected)\n", r.RejectedDoubleClaims)
	fmt.Printf("trace events recorded:    %d\n", r.TraceEvents)

	fmt.Println("\nper-actor P&L (net of stake; DOES NOT include still-pending balances, there are none — every round drains to 0):")
	names := make([]string, 0, len(r.ActorPnL))
	for n := range r.ActorPnL {
		names = append(names, n)
	}
	sort.Slice(names, func(i, j int) bool {
		ri, rj := r.ActorRole[names[i]], r.ActorRole[names[j]]
		if ri != rj {
			return ri < rj
		}
		return names[i] < names[j]
	})
	roleAgg := map[string]*bigIntAgg{}
	for _, n := range names {
		role := r.ActorRole[n]
		agg, ok := roleAgg[role]
		if !ok {
			agg = &bigIntAgg{sum: big.NewInt(0)}
			roleAgg[role] = agg
		}
		agg.add(r.ActorPnL[n])
	}
	roles := make([]string, 0, len(roleAgg))
	for role := range roleAgg {
		roles = append(roles, role)
	}
	sort.Strings(roles)
	for _, role := range roles {
		fmt.Printf("  role=%-10s  n=%-3d  Σ P&L=%s\n", role, roleAgg[role].n, roleAgg[role].sum.String())
	}
}

func printComparison(reports []*sim.Report) {
	fmt.Println("\n================ VOID RATE BY KEEPER BEHAVIOUR (same seed, same population, same oracle path) ================")
	fmt.Printf("%-10s %8s %8s %8s %10s %10s %10s %10s\n", "keeper", "rolled", "settled", "voided", "void-rate", "via-settle", "via-void", "via-reclaim")
	for _, r := range reports {
		fmt.Printf("%-10s %8d %8d %8d %9.1f%% %10d %10d %10d\n",
			r.KeeperProfile, r.RoundsRolled, r.RoundsSettled, r.RoundsVoid, r.VoidRate()*100,
			r.ResolvedViaSettleCall, r.ResolvedViaVoidStale, r.ResolvedViaReclaim)
	}
	fmt.Println()
	for _, r := range reports {
		fmt.Printf("%-10s total staked=%-14s total paid=%-14s total swept=%-10s unresolved-at-end=%d\n",
			r.KeeperProfile, r.TotalStaked, r.TotalPaid, r.TotalSwept, r.UnresolvedRoundsAtEnd)
	}
}

type bigIntAgg struct {
	n   int
	sum *big.Int
}

func (a *bigIntAgg) add(v *big.Int) {
	a.n++
	a.sum.Add(a.sum, v)
}
