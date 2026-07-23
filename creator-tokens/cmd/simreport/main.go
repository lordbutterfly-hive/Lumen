// Command simreport reads a simulator trace JSON file and prints a
// human-readable report covering all four analyses in sim/analysis: the HBD
// ledger reconciliation, the dead-end scan, state/action coverage, and the
// failure histogram.
//
// Exit code is non-zero when the money identity fails to close, or a
// PERSISTENT dead end (value held with zero legal route, and no structural
// reason to expect it resolves) is found — see sim/analysis.Report.Critical.
// The ReclaimGrace transient window is reported but does not, by itself,
// fail the run.
package main

import (
	"flag"
	"fmt"
	"os"

	"creator-tokens/sim/analysis"
)

func main() {
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "usage: %s <trace.json>\n", os.Args[0])
	}
	flag.Parse()
	if flag.NArg() != 1 {
		flag.Usage()
		os.Exit(2)
	}
	path := flag.Arg(0)

	tr, err := analysis.LoadTrace(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "simreport: %v\n", err)
		os.Exit(2)
	}

	report := analysis.Analyze(tr)
	fmt.Print(report.String())

	if report.Critical() {
		os.Exit(1)
	}
}
