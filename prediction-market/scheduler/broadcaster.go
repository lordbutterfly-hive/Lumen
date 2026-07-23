package scheduler

import (
	"encoding/json"
	"fmt"
	"io"
)

// Broadcaster sends a fully-built Hive custom_json "vsc.call" operation to
// Hive L1 and returns the resulting Hive transaction id.
type Broadcaster interface {
	Broadcast(op CustomJSON) (txID string, err error)
}

// DryRunBroadcaster is a Broadcaster double: it never touches the network,
// just pretty-prints every op it's handed to Out (if set) and returns a
// deterministic fake tx id. Used by tests and the --dry-run CLI.
type DryRunBroadcaster struct {
	Out io.Writer
	n   int
}

func (d *DryRunBroadcaster) Broadcast(op CustomJSON) (string, error) {
	d.n++
	if d.Out != nil {
		pretty, err := json.MarshalIndent(op, "", "  ")
		if err != nil {
			return "", fmt.Errorf("scheduler: dry-run render op: %w", err)
		}
		fmt.Fprintf(d.Out, "--- DRY RUN broadcast #%d (custom_json id=%q) ---\n%s\n", d.n, op.ID, pretty)
		var call VSCCall
		if err := json.Unmarshal([]byte(op.JSON), &call); err == nil {
			fmt.Fprintf(d.Out, "  -> action=%s payload=%s\n\n", call.Action, call.Payload)
		}
	}
	return fmt.Sprintf("dryrun-tx-%d", d.n), nil
}

// HiveBroadcaster is the REAL Broadcaster — deliberately NOT implemented.
// Live submission is explicitly out of scope for this package (same
// discipline as the creator-tokens keeper): wiring a real signer/broadcaster
// is a separate, deliberate step, not something to bolt on silently. Real
// broadcast needs:
//  1. A signed Hive transaction: a secp256k1 signature over the serialized
//     op, e.g. via hivego.HiveRpcNode.BroadcastJson (~/hivego/hive_ops.go:153-156),
//     which needs the scheduler bot's Hive key material. Per buildCustomJSON's
//     auth routing (ops.go), every op this package builds — roll, settle,
//     voidStale, reclaim — needs only a POSTING key (none carry a
//     transfer.allow intent) — cheaper to provision than an active key.
//  2. A live deployed contract to point at (DUMB-QUESTIONS-RESOLVED E1: not
//     deployed as of 2026-07-19).
//
// This stub exists so a Scheduler can be constructed against the REAL
// Broadcaster interface today, without either prerequisite — swap in a real
// implementation (signing + hivego broadcast) once keys + deploy exist, and
// only behind an explicit, non-default flag (see cmd/scheduler/main.go's
// --live gate).
type HiveBroadcaster struct {
	NodeURL    string
	PostingKey string // WIF; never logged, never given a default
}

func (h *HiveBroadcaster) Broadcast(op CustomJSON) (string, error) {
	return "", fmt.Errorf("scheduler: HiveBroadcaster.Broadcast not implemented — needs a signed Hive tx (posting key material) plus a live deployed contract; use DryRunBroadcaster until both exist")
}
