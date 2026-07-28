package keeper

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// Submitter sends one Op somewhere and reports back a receipt or an error.
// This is the ONE I/O seam in this package — Plan and Sweep never touch the
// network, a clock, or a filesystem themselves; every side effect happens
// inside whatever Submitter a caller injects. Mirrors hive-price-market/
// scheduler/broadcaster.go's Broadcaster interface exactly, renamed because
// this package submits contract actions (Ops), not pre-built Hive
// operations — DryRunSubmitter below is where the two meet.
type Submitter interface {
	Submit(op Op) (receipt string, err error)
}

// DryRunSubmitter is a Submitter double: it builds the REAL broadcastable
// envelope (via BuildOp) but never sends it anywhere — it only pretty-prints
// it to Out (if set) and returns a deterministic fake receipt. This is what
// backs cmd/keeper's --dry-run (the only mode this task implements) and
// every test in this package that does not specifically exercise failure
// handling.
type DryRunSubmitter struct {
	Cfg    OpConfig
	Caller string
	Out    io.Writer
	n      int
}

func (d *DryRunSubmitter) Submit(op Op) (string, error) {
	d.n++
	envelope, err := BuildOp(d.Cfg, d.Caller, op)
	if err != nil {
		return "", fmt.Errorf("keeper: dry-run build op: %w", err)
	}
	if d.Out != nil {
		pretty, mErr := json.MarshalIndent(envelope, "", "  ")
		if mErr != nil {
			return "", fmt.Errorf("keeper: dry-run render op: %w", mErr)
		}
		fmt.Fprintf(d.Out, "--- DRY RUN submit #%d: %s ---\n%s\n\n", d.n, op.String(), pretty)
	}
	return fmt.Sprintf("dryrun-tx-%d", d.n), nil
}

// ErrLiveNotWired is returned by every LiveSubmitter.Submit call, always,
// regardless of op. Its text is deliberately explicit rather than a generic
// "not implemented," per this task's own instruction.
var ErrLiveNotWired = errors.New("keeper: live submission not wired — deliberate: needs a signed Hive tx (ACTIVE key material — see BuildOp's auth-routing doc) plus a live deployed contract; use DryRunSubmitter until both exist")

// LiveSubmitter is the REAL Submitter — deliberately NOT implemented.
// Broadcasting real Hive transactions is explicitly out of scope for this
// build (see RUNBOOK.md's pre-mainnet gate list): a real implementation
// needs a signed Hive transaction (this bot account's ACTIVE key material —
// see BuildOp's auth-routing doc for why ACTIVE is required: contract/main.go's
// requireActiveAuth refuses posting-only auth on both ops this package
// builds) plus a live deployed contract, and
// this task deliberately does not write that code.
//
// Constructing a Keeper against this interface today, and having it fail
// LOUDLY and EXPLICITLY the moment it is asked to actually do anything, is
// the deliberate design: it lets cmd/keeper's --live code path exist, be
// gated, and be tested, without either prerequisite existing yet, and
// without a silent no-op Submitter that could be mistaken for a working one.
// Swap in a real implementation (signing + broadcast, mirroring
// hive-price-market/scheduler/broadcaster.go's own HiveBroadcaster stub —
// which is in the identical, still-unimplemented state as of this writing)
// once both prerequisites exist.
type LiveSubmitter struct {
	Cfg        OpConfig
	Caller     string
	NodeURL    string
	ActiveKey string // WIF, ACTIVE (not posting — see BuildOp's auth-routing doc); never logged, never given a default
}

func (l *LiveSubmitter) Submit(op Op) (string, error) {
	return "", ErrLiveNotWired
}
