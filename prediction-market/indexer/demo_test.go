package indexer

import (
	"bytes"
	"strings"
	"testing"
)

// TestRunDemo just proves the demo path (which uses Poll's pagination loop,
// not a raw Ingest shortcut) runs end-to-end without error and prints the
// key numbers. Run with `go test -run TestRunDemo -v` to see the same output
// pasted in the build report.
func TestRunDemo(t *testing.T) {
	var buf bytes.Buffer
	if err := RunDemo(&buf); err != nil {
		t.Fatalf("RunDemo failed: %v", err)
	}
	out := buf.String()
	t.Log("\n" + out)

	for _, want := range []string{
		"ingested=12 unknown=0 malformed=0",
		"bettors:      5",
		"totalBets:    15000",
		"HouseTaken(hive): 350",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("demo output missing %q\nfull output:\n%s", want, out)
		}
	}
}
