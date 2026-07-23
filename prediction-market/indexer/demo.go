package indexer

import (
	"fmt"
	"io"
)

// RunDemo builds the canonical scenario (scenario.go), drains it through a
// fresh Index via Poll (exercising the real cursor/pagination path, not just
// Ingest), and prints every aggregate the contract itself has no read
// entrypoint for (package doc). Exercised by both `go run ./indexer/cmd/demo`
// and TestRunDemo, so the output pasted into the build report is
// reproducible with `go test -run TestRunDemo -v`.
func RunDemo(w io.Writer) error {
	src := BuildCanonicalScenario()
	ix := NewIndex()

	// Drain in small batches (limit=3) specifically so this demo exercises
	// MockEventSource's short-read/pagination path, not just "hand back
	// everything in one call" — a real GQL source will always be paginated.
	for {
		n, err := ix.Poll(src, 3)
		if err != nil {
			return err
		}
		if n == 0 {
			break
		}
	}

	stats := ix.Stats()
	fmt.Fprintf(w, "ingested=%d unknown=%d malformed=%d cursor=%s\n",
		stats.Ingested, stats.Unknown, stats.Malformed, stats.LastCursor)

	summary, ok := ix.RoundSummary(1)
	if !ok {
		return fmt.Errorf("round 1 missing from index after ingest")
	}
	fmt.Fprintf(w, "\nRound 1 summary:\n")
	fmt.Fprintf(w, "  creator:      %s\n", summary.Creator)
	fmt.Fprintf(w, "  resolved:     %v\n", summary.Resolved)
	fmt.Fprintf(w, "  state:        %s\n", summary.State)
	fmt.Fprintf(w, "  winner:       %d (valid=%v)\n", summary.Winner, summary.WinnerValid)
	fmt.Fprintf(w, "  bettors:      %d\n", summary.Bettors)
	fmt.Fprintf(w, "  totalBets:    %s\n", summary.TotalBets.String())

	fmt.Fprintf(w, "\nPer-account positions:\n")
	for _, acct := range []string{"hive:alice", "hive:bob", "hive:carol", "hive:dave", "hive:erin"} {
		positions := ix.MyPositions(acct)
		for _, p := range positions {
			claimStr := "not claimed"
			if p.Claimed {
				claimStr = fmt.Sprintf("claimed payout=%s asset=%s", p.ClaimPayout.String(), p.ClaimAsset)
			}
			fmt.Fprintf(w, "  %-11s round=%d stake=%s state=%s -> %s\n",
				acct, p.RoundID, p.TotalStaked.String(), p.RoundState, claimStr)
		}
	}

	fmt.Fprintf(w, "\nMyUnclaimed (SETTLED/VOID rounds bet-in-but-not-claimed):\n")
	for _, acct := range []string{"hive:alice", "hive:bob", "hive:carol", "hive:dave", "hive:erin"} {
		fmt.Fprintf(w, "  %-11s %v\n", acct, ix.MyUnclaimed(acct))
	}

	fmt.Fprintf(w, "\nHouseTaken(hive): %s\n", ix.HouseTaken("hive").String())
	fmt.Fprintf(w, "HouseTaken(hbd):  %s (never appeared -> zero, not nil)\n", ix.HouseTaken("hbd").String())

	// api.go's frontend-shaped DTOs, JSON-marshaled, to show exactly what a
	// VscMarketDataSource would receive.
	fmt.Fprintf(w, "\nJSON DTOs (api.go, shapes aligned to prediction-market/types.ts):\n")
	bettorsView, _ := ix.RoundBettorsView(1)
	fmt.Fprintf(w, "  RoundBettorsView: %+v\n", bettorsView)
	posView, _ := ix.MyPositionView(1, "hive:dave")
	fmt.Fprintf(w, "  MyPositionView(dave, unclaimed):  roundId=%s stakeByBucket=%v totalStaked=%s claimed=%v claimable=%v\n",
		posView.RoundID, posView.StakeByBucket, posView.TotalStaked, posView.Claimed, posView.Claimable)
	posView2, _ := ix.MyPositionView(1, "hive:alice")
	payout := "<nil>"
	if posView2.Payout != nil {
		payout = *posView2.Payout
	}
	fmt.Fprintf(w, "  MyPositionView(alice, claimed):   roundId=%s stakeByBucket=%v totalStaked=%s claimed=%v claimable=%v payout=%s\n",
		posView2.RoundID, posView2.StakeByBucket, posView2.TotalStaked, posView2.Claimed, posView2.Claimable, payout)

	return nil
}
