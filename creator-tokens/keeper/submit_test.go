package keeper

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

func TestDryRunSubmitter_TouchesNothingAndPrintsTheOp(t *testing.T) {
	var buf bytes.Buffer
	d := &DryRunSubmitter{Cfg: testOpConfig(), Caller: "hive:keeper-bot", Out: &buf}

	receipt, err := d.Submit(Op{Kind: OpRefundHolder, Creator: "alice", Holder: "bob", Balance: bi(100)})
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if receipt != "dryrun-tx-1" {
		t.Fatalf("receipt = %q, want dryrun-tx-1", receipt)
	}

	out := buf.String()
	for _, want := range []string{"DRY RUN", "vsc.call", "refundHolder", "alice", "bob"} {
		if !strings.Contains(out, want) {
			t.Fatalf("dry-run output missing %q:\n%s", want, out)
		}
	}

	// A second call must produce a distinct, still-deterministic receipt --
	// nothing about DryRunSubmitter is allowed to depend on wall-clock time.
	receipt2, err := d.Submit(Op{Kind: OpCloseIfDrained, Creator: "alice"})
	if err != nil {
		t.Fatalf("Submit (2): %v", err)
	}
	if receipt2 != "dryrun-tx-2" {
		t.Fatalf("receipt2 = %q, want dryrun-tx-2", receipt2)
	}
}

func TestDryRunSubmitter_NilOutIsSafe(t *testing.T) {
	d := &DryRunSubmitter{Cfg: testOpConfig(), Caller: "hive:keeper-bot"}
	if _, err := d.Submit(Op{Kind: OpCloseIfDrained, Creator: "alice"}); err != nil {
		t.Fatalf("Submit with nil Out: %v", err)
	}
}

func TestLiveSubmitter_AlwaysRefusesExplicitly(t *testing.T) {
	l := &LiveSubmitter{Cfg: testOpConfig(), Caller: "hive:keeper-bot"}

	ops := []Op{
		{Kind: OpRefundHolder, Creator: "alice", Holder: "bob", Balance: bi(1)},
		{Kind: OpCloseIfDrained, Creator: "alice"},
	}
	for _, op := range ops {
		receipt, err := l.Submit(op)
		if err == nil {
			t.Fatalf("LiveSubmitter.Submit(%v) succeeded; it must always refuse", op)
		}
		if receipt != "" {
			t.Fatalf("LiveSubmitter.Submit(%v) returned a non-empty receipt %q alongside an error", op, receipt)
		}
		if !errors.Is(err, ErrLiveNotWired) {
			t.Fatalf("err = %v, want ErrLiveNotWired", err)
		}
		if !strings.Contains(err.Error(), "live submission not wired") || !strings.Contains(err.Error(), "deliberate") {
			t.Fatalf("err text %q does not read as a deliberate refusal", err.Error())
		}
	}
}
