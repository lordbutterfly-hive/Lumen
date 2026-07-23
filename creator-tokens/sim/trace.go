// Package sim is a POPULATION SIMULATOR for the Magi Creator Keys money
// contract (core/API.md), not a test suite. It plays out realistic daily and
// weekly usage against a REAL core.Store, driven by a population of named,
// seeded actors with distinct behaviour profiles, and records everything
// that happens into a structured, stable trace.
//
// It drives the real code directly: core.Register/Renew/SetFace/SetCap/
// Prepay/TransferCredits/Ask/Answer/Reclaim/Refund/RefundHolder/
// CloseIfDrained/RecordObs are all called against a real *core.MemStore —
// nothing in this package mocks or reimplements core's fund logic. Where
// this package HAS to duplicate a small piece of arithmetic (the commission
// calculation, a credits-per-ask preview), it duplicates the same public,
// caller-side formula contract/main.go's own wasm wrapper already
// duplicates (see actions.go) — never a private core key or algorithm.
//
// See engine.go for the event-driven scheduler and the invariant sweep,
// actors.go for the population and behaviour profiles, and actions.go for
// the core.* call wrappers.
package sim

import (
	"encoding/json"
	"math/big"
	"os"
)

// Event is one attempted call against core, successful or not. The schema is
// intentionally stable: a second agent writes the analysis layer against
// this exact shape, so field names and meaning must not drift once this
// simulator starts producing traces anyone depends on.
//
//   - Args holds every INPUT to the call, as base-10 decimal strings (never
//     floats — matches core/money.go's own convention exactly).
//   - Deltas holds every STATE VALUE this call changed, as base-10 decimal
//     strings, keyed by a short, human-readable label (see actions.go's
//     deltaStr/setDelta for the exact key conventions used per action).
//     Empty (never nil) when a call failed, since a failed call must not
//     have mutated anything — this simulator actively verifies that claim
//     (see engine.go's coreCall) rather than assuming it.
//   - ErrSym/ErrMsg mirror core.Err's own Symbol/Msg fields exactly (see
//     core/errors.go) whenever OK is false and the failure came from core
//     itself. A failure this package's own bookkeeping detects (e.g. an
//     invariant violation) is never reported as an Event; see engine.go's
//     InvariantViolation instead — that is a HALT, not a recorded outcome.
type Event struct {
	Block   uint64
	Day     int
	Actor   string
	Role    string // the behaviour profile, e.g. "creator_reliable", "fan", "keeper"
	Action  string // "register", "renew", "setFace", "setCap", "prepay", "transfer", "ask", "answer", "reclaim", "refund", "refundHolder", "closeIfDrained", "recordObs", "withdrawTreasury"
	Creator string
	Args    map[string]string
	OK      bool
	ErrSym  string
	ErrMsg  string
	Deltas  map[string]string
}

// Trace is the full, JSON-serializable record of one simulation run. Seed
// alone is enough to replay it exactly: every actor's RNG is derived
// deterministically from Seed at population-construction time (actors.go),
// and every scheduling decision thereafter draws only from that actor's own
// RNG plus the fully-deterministic block clock — see engine.go's package doc
// for the determinism argument in full.
type Trace struct {
	Seed   int64
	Events []Event
	Config map[string]string
}

// NewTrace starts an empty trace for the given seed and config, ready to
// have events appended via AddEvent.
func NewTrace(seed int64, config map[string]string) *Trace {
	if config == nil {
		config = map[string]string{}
	}
	return &Trace{Seed: seed, Events: make([]Event, 0, 4096), Config: config}
}

// AddEvent appends ev to the trace in call order. The trace is append-only
// and never reordered — Block/Day on each event is the authoritative
// timestamp; Events themselves are always already in non-decreasing Block
// order because the engine's scheduler processes strictly in block order
// (engine.go's eventHeap).
func (t *Trace) AddEvent(ev Event) {
	t.Events = append(t.Events, ev)
}

// WriteJSON writes the trace to path as indented JSON, so the analysis layer
// (and a human) can read it without importing this package.
func (t *Trace) WriteJSON(path string) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	return enc.Encode(t)
}

// ---------------------------------------------------------------------------
// Money/formatting helpers shared by actions.go and engine.go. No floats
// anywhere, matching core/money.go's own rule — every amount that reaches
// Args or Deltas is a base-10 *big.Int string, exactly as core itself stores
// them.

// bigStr renders v as a base-10 string, "0" for nil — matches
// contract/main.go's own bigStr helper (main.go:307) exactly, so a value
// copied out of a trace and a value logged by the real wasm wrapper read
// identically.
func bigStr(v *big.Int) string {
	if v == nil {
		return "0"
	}
	return v.String()
}

// deltaStr renders "before -> after" for a Deltas entry. Kept as one string
// (rather than two separate map entries) so the analysis layer never has to
// reconstruct which before/after pair belongs together.
func deltaStr(before, after *big.Int) string {
	return bigStr(before) + " -> " + bigStr(after)
}

func zeroBig() *big.Int { return big.NewInt(0) }

func addBig(a, b *big.Int) *big.Int { return new(big.Int).Add(a, b) }

// subBig returns a-b. Callers in this package only ever subtract an amount
// already proven <= a (a wallet/ledger check performed before the
// subtraction, never after) — see actions.go's affordability guards — so
// this never needs an error return the way core/money.go's mSub does.
func subBig(a, b *big.Int) *big.Int { return new(big.Int).Sub(a, b) }

func cmpBig(a, b *big.Int) int { return a.Cmp(b) }
