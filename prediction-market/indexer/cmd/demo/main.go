// Command demo runs indexer.RunDemo against the canonical mock scenario and
// prints the aggregates the Hive Price Weekly Market contract has no read
// entrypoint for (bettors, per-account positions, unclaimed rounds, house
// take). Run it with:
//
//	go run ./indexer/cmd/demo
package main

import (
	"fmt"
	"os"

	"hive-price-market/indexer"
)

func main() {
	if err := indexer.RunDemo(os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "demo failed:", err)
		os.Exit(1)
	}
}
