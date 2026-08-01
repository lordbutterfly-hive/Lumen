package market

import (
	"os"
	"regexp"
	"testing"
)

// F-P8 — the frontend watched `active|hive` while RollRound opens rounds on
// `active|hbd`, so on deploy the market would have rendered "no round" forever:
// nobody can bet, and anyone already holding a position cannot reach claim or
// reclaim in-app. It is a total product denial, and it was invisible to both
// sides' test suites because each one was internally consistent.
//
// scheduler/plan_test.go already pins the SCHEDULER's copy of this constant
// against RollRound. This pins the FRONTEND's copy the same way — the two
// constants are one fact stored in two languages, and the only durable fix for
// that is a test that reads both.
//
// Skips (never fails) when the frontend tree is absent, so the Go module still
// tests standalone.

const feMarketDataSource = "../../frontend/apps/blog/features/prediction-market/lib/vsc-market-data-source.ts"

func TestFP8_FrontendPointerAssetMatchesRollRound(t *testing.T) {
	b, err := os.ReadFile(feMarketDataSource)
	if err != nil {
		t.Skipf("frontend tree not present (%v) — pin not applicable in a standalone checkout", err)
	}

	m := regexp.MustCompile(`DEFAULT_POINTER_ASSET:\s*ContractAsset\s*=\s*'(\w+)'`).FindSubmatch(b)
	if m == nil {
		t.Fatal("could not find DEFAULT_POINTER_ASSET in the frontend data source — " +
			"if it was renamed, update this pin rather than deleting it: the constant it " +
			"guards is what makes rounds discoverable at all")
	}

	got := string(m[1])
	if got != AssetHbd {
		t.Fatalf("frontend DEFAULT_POINTER_ASSET = %q but RollRound opens rounds with %q "+
			"(create.go: Asset: AssetHbd) — the frontend would watch a key the contract "+
			"never writes and show no round, permanently", got, AssetHbd)
	}
}

// F-P10 — the frontend's bucket table is a fixed 7 entries and indexes every
// pool/stake/winner read positionally. That is correct only while the contract
// opens 7-outcome rounds. computeStrikes returns 6 strikes ⇒ 7 outcomes, and
// createRound is not exported (see fp1_round_creation_test.go), so today they
// agree — but nothing checked. The frontend now also refuses to render a round
// whose on-chain `n` disagrees; this pins the other end.
func TestFP10_FrontendBucketCountMatchesComputeStrikes(t *testing.T) {
	// The contract's own answer, from the function that actually builds them.
	outcomes := len(computeStrikes(10000)) + 1

	b, err := os.ReadFile("../../frontend/apps/blog/features/prediction-market/lib/bucket-defs.ts")
	if err != nil {
		t.Skipf("frontend tree not present (%v)", err)
	}
	// Count the entries in the BUCKET_DEFS array literal.
	defs := regexp.MustCompile(`\{\s*id:\s*'`).FindAll(b, -1)
	if len(defs) == 0 {
		t.Fatal("could not count BUCKET_DEFS entries — update this pin rather than deleting it")
	}
	if len(defs) != outcomes {
		t.Fatalf("frontend renders %d buckets but computeStrikes yields %d outcomes — "+
			"the UI would drop outcomes, show shares that do not sum to 100, and can "+
			"label the wrong winner", len(defs), outcomes)
	}
}

// The other half of the same fact: RollRound must keep opening rounds on the
// asset the pin above compares against. If someone changes RollRound, this
// fails next to the frontend pin instead of silently re-opening F-P8.
func TestFP8_RollRoundOpensOnAssetHbd(t *testing.T) {
	b, err := os.ReadFile("create.go")
	if err != nil {
		t.Fatalf("read create.go: %v", err)
	}
	if !regexp.MustCompile(`Asset:\s*AssetHbd`).Match(b) {
		t.Fatal("RollRound no longer opens rounds with AssetHbd — the frontend pointer " +
			"default and scheduler default must move with it")
	}
}
