// Package analysis consumes the simulator engine's trace output (sim/trace.go
// — sim/engine.go, sim/actors.go, sim/actions.go drive the real core) and
// produces four reports: a full HBD ledger reconciliation, a dead-end
// (stuck-value) scan, state/action coverage, and a failure histogram with a
// correct-vs-usability classification.
//
// # Why this package does not import "sim"
//
// The two halves of this simulator are built in parallel by two different
// agents against one another's OUTPUT, not each other's code — this package
// reads the JSON a Trace serializes to, never the sim.Trace/sim.Event Go
// types directly. Event and Trace below are this package's OWN copy of that
// wire shape. As of this package's initial build, sim/trace.go exists and
// was read (not imported) to confirm the exact field names, JSON shape, and
// the following load-bearing details:
//
//   - Action is a fixed, documented set of lowercase strings: "register",
//     "renew", "setFace", "setCap", "prepay", "transfer", "ask", "answer",
//     "reclaim", "refund", "refundHolder", "closeIfDrained", "recordObs" —
//     see knownActions below, copied verbatim from sim/trace.go's Event.Action
//     doc comment.
//   - Args holds every INPUT to the call, base-10 decimal strings, keyed by
//     parameter name — this is a fully documented, stable contract (mirrors
//     core/API.md's function signatures exactly), so this package treats Args
//     as authoritative and leans on it heavily.
//   - Deltas holds "before -> after" strings for state values the call
//     changed, keyed by short labels whose exact per-action naming is left to
//     sim/actions.go — NOT YET WRITTEN as of this build. This package
//     therefore does NOT depend on Deltas for anything money-critical: every
//     HBD-moving computation below is an INDEPENDENT reimplementation of
//     core's own documented formulas (core/API.md, core/money.go,
//     core/refund.go, core/ask.go, core/market.go, core/prepay.go), replayed
//     purely from Args + OK, the same way core/ itself would compute it. This
//     is deliberate and stronger than trusting the engine's own
//     instrumentation: it catches a bug in what the engine SAYS happened, not
//     just an internal inconsistency in the engine's own bookkeeping. Deltas
//     is consulted only for the one thing Args structurally cannot carry —
//     the TWAP-derived credits-per-ask conversion, which this package does
//
// /    not reimplement (see journey.go's doc on why) — and every value sourced
//
//	  that way is labeled approximate in the report.
//	- Deltas is guaranteed non-nil and empty on a failed call (sim/trace.go:
//	  "Empty (never nil) when a call failed... this simulator actively
//	  verifies that claim"). This package cross-checks that claim itself
//	  (see AnalyzeFailures) rather than assuming it.
//
// See the report filed alongside this build for the precise, numbered list
// of what would need confirming once sim/actions.go lands.
package analysis

import (
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"strconv"
	"strings"
)

// ---------------------------------------------------------------------------
// Wire types — this package's own copy of sim/trace.go's Event/Trace shape.

// Event is one attempted call against core, successful or not, exactly as
// sim/trace.go documents it.
type Event struct {
	Block   uint64
	Day     int
	Actor   string
	Role    string
	Action  string
	Creator string
	Args    map[string]string
	OK      bool
	ErrSym  string
	ErrMsg  string
	Deltas  map[string]string
}

// Trace is the full JSON record of one simulation run.
type Trace struct {
	Seed   int64
	Events []Event
	Config map[string]string
}

// LoadTrace reads and parses a trace JSON file written by sim.Trace.WriteJSON.
func LoadTrace(path string) (*Trace, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read trace %q: %w", path, err)
	}
	var tr Trace
	if err := json.Unmarshal(data, &tr); err != nil {
		return nil, fmt.Errorf("parse trace JSON %q: %w", path, err)
	}
	return &tr, nil
}

// knownActions is the canonical action set, copied verbatim from
// sim/trace.go's Event.Action doc comment (2026-07-21 read). Fourteen entries
// as of the Upgrade-1 (C2 treasury exit) sim enhancement, which added
// "withdrawTreasury" — kept as a live list rather than a rounded number so
// coverage.go's "which actions were exercised" question has one unambiguous
// denominator.
//
// "withdrawTreasury" is a GLOBAL, phaseless action (it targets kTreasury,
// never a per-market key — see knownGlobalActions in coverage.go): it is
// counted in the action tally but deliberately excluded from the
// phase x action combo grid, since a treasury withdrawal is never scoped to
// any single market's lifecycle phase.
var knownActions = []string{
	"register", "renew", "setFace", "setCap", "prepay", "transfer",
	"ask", "answer", "reclaim", "refund", "refundHolder", "closeIfDrained",
	"recordObs", "withdrawTreasury",
}

// Phase constants — mirror core/params.go's StateActive/StateOverdue/
// StateFrozen/StateClosed string values exactly (params.go:120-125), so a
// phase this package derives and a phase core itself would report read
// identically.
const (
	PhaseActive  = "ACTIVE"
	PhaseOverdue = "OVERDUE"
	PhaseFrozen  = "FROZEN"
	PhaseClosed  = "CLOSED"
)

var knownPhases = []string{PhaseActive, PhaseOverdue, PhaseFrozen, PhaseClosed}

// ---------------------------------------------------------------------------
// Protocol constants this package independently mirrors from core/params.go,
// so ledger.go/journey.go/coverage.go can replay core's own arithmetic
// without importing core. Each is overridable via Trace.Config, in case a
// fast-devnet-style config (shortened grace/subscription windows, the same
// pattern this codebase's own memory notes call "bespoke devnet=FAST
// config") produced the trace being analyzed — see cfgU64.
const (
	defaultBlocksPerDay        uint64 = 28800
	defaultSubscriptionPeriod  uint64 = 30 * defaultBlocksPerDay // params.go SubscriptionPeriod
	defaultGraceBlocks         uint64 = 5 * defaultBlocksPerDay  // params.go GraceBlocks
	defaultReclaimGrace        uint64 = 1200                     // params.go ReclaimGrace
	defaultCommissionBps       uint64 = 1200                     // params.go CommissionBps
	defaultParBaseUnitsPerCred int64  = 1                        // params.go ParBaseUnitsPerCredit
)

func cfgU64(tr *Trace, key string, fallback uint64) uint64 {
	if tr == nil || tr.Config == nil {
		return fallback
	}
	if v, ok := tr.Config[key]; ok {
		if n, err := strconv.ParseUint(v, 10, 64); err == nil {
			return n
		}
	}
	return fallback
}

func subscriptionPeriodFor(tr *Trace) uint64 {
	return cfgU64(tr, "subscriptionPeriod", defaultSubscriptionPeriod)
}
func graceBlocksFor(tr *Trace) uint64   { return cfgU64(tr, "graceBlocks", defaultGraceBlocks) }
func reclaimGraceFor(tr *Trace) uint64  { return cfgU64(tr, "reclaimGrace", defaultReclaimGrace) }
func commissionBpsFor(tr *Trace) uint64 { return cfgU64(tr, "commissionBps", defaultCommissionBps) }

// ---------------------------------------------------------------------------
// Shared pure-math helpers, mirroring core/money.go exactly (documented
// there as "division ALWAYS rounds in the reserve's favour"). Reimplemented
// here rather than imported so this package never depends on core's
// internals — only on the public formulas API.md commits to.

func zeroBig() *big.Int { return big.NewInt(0) }

// mulDivFloor = floor(a*b/c). Returns zero (never panics) when c<=0 — a
// defensive departure from core/money.go's mMulDiv, which requires the
// caller to guarantee c>0: this package replays a TRACE, not a trusted
// call chain, so a malformed or adversarial trace must be reported as an
// anomaly, never crash the report.
func mulDivFloor(a, b, c *big.Int) *big.Int {
	if c == nil || c.Sign() <= 0 {
		return zeroBig()
	}
	p := new(big.Int).Mul(a, b)
	return p.Div(p, c)
}

// bpsFloor = floor(total*bps/10000), mirroring core/money.go's mMulBpsDiv.
func bpsFloor(total *big.Int, bps uint64) *big.Int {
	if total == nil {
		return zeroBig()
	}
	p := new(big.Int).Mul(total, new(big.Int).SetUint64(bps))
	return p.Div(p, big.NewInt(10000))
}

// refundPayout mirrors core/refund.go's refundPayout exactly: floor(reserve*
// credits/supply), capped at credits (PAR == 1, so credits*PAR == credits).
func refundPayout(reserve, credits, supply *big.Int) *big.Int {
	payout := mulDivFloor(reserve, credits, supply)
	if payout.Cmp(credits) > 0 {
		return new(big.Int).Set(credits)
	}
	return payout
}

// derivePhase mirrors core/market.go's Phase() exactly: a stored CLOSED is
// the only stored state that wins; everything else derives lazily from
// paidUntil and the grace window.
func derivePhase(closed bool, paidUntil, block, graceBlocks uint64) string {
	if closed {
		return PhaseClosed
	}
	if block <= paidUntil {
		return PhaseActive
	}
	if block < paidUntil+graceBlocks {
		return PhaseOverdue
	}
	return PhaseFrozen
}

// ---------------------------------------------------------------------------
// Arg/delta parsing helpers. Args is documented as "every INPUT... as base-10
// decimal strings" (sim/trace.go), so a missing key on an action that should
// carry it is treated as a data-quality anomaly (recorded, never silently
// defaulted to zero — a silent zero could hide a real accounting gap behind
// a false-green report).

func argBig(ev Event, key string) (*big.Int, bool) {
	v, ok := ev.Args[key]
	if !ok || v == "" {
		return nil, false
	}
	n, ok2 := new(big.Int).SetString(v, 10)
	if !ok2 || n.Sign() < 0 {
		return nil, false
	}
	return n, true
}

func argU64(ev Event, key string) (uint64, bool) {
	v, ok := ev.Args[key]
	if !ok || v == "" {
		return 0, false
	}
	n, err := strconv.ParseUint(v, 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

func argStr(ev Event, key string) (string, bool) {
	v, ok := ev.Args[key]
	return v, ok && v != ""
}

// deltaBeforeAfter parses a Deltas entry in sim/trace.go's documented
// "before -> after" format. Falls back to treating the whole string as a
// bare "after" value (before=nil) if it doesn't contain the separator, so
// this package tolerates either convention actions.go ends up using.
func deltaBeforeAfter(ev Event, key string) (before, after *big.Int, ok bool) {
	v, present := ev.Deltas[key]
	if !present || v == "" {
		return nil, nil, false
	}
	if i := strings.Index(v, "->"); i >= 0 {
		b, ok1 := new(big.Int).SetString(strings.TrimSpace(v[:i]), 10)
		a, ok2 := new(big.Int).SetString(strings.TrimSpace(v[i+2:]), 10)
		if ok1 && ok2 {
			return b, a, true
		}
		return nil, nil, false
	}
	a, ok2 := new(big.Int).SetString(strings.TrimSpace(v), 10)
	if !ok2 {
		return nil, nil, false
	}
	return nil, a, true
}

// resolveCreditsSpent makes a best-effort attempt to read how many credits
// an "ask" event spent. Confirmed against sim/actions.go's doAskExecute
// (2026-07-21 read, after this package's initial build): the engine puts the
// authoritative value directly in Args (Args["creditsSpent"] = bigStr(res.
// CreditsSpent) — a return value core.Ask hands back, echoed into Args for
// exactly this reason), NOT in Deltas — so that is tried first. The
// remaining fallbacks stay in place for robustness against a differently
// written engine (or a hand-built synthetic trace, as this package's own
// tests use): a dedicated "creditsSpent" Deltas key, then the engine's real
// per-actor-keyed balance delta ("balance:"+ev.Actor, confirmed against
// doAskExecute's own ev.Deltas["balance:"+asker] = deltaStr(...)), then a
// bare "balance" key for a hypothetical engine that never suffixes it.
// Returns ok=false only if none of the above are present.
//
// Shared by ledger.go (to keep its shadow balances consistent across
// ask/answer/reclaim, for the per-actor credits-held-value figure) and
// journey.go (to describe, not detect, a dead end — see journey.go's doc on
// why this is never load-bearing for dead-end DETECTION itself).
func resolveCreditsSpent(ev Event) (*big.Int, bool) {
	if v, ok := argBig(ev, "creditsSpent"); ok {
		return v, true
	}
	if before, after, ok := deltaBeforeAfter(ev, "creditsSpent"); ok {
		if before == nil {
			return after, true
		}
		return new(big.Int).Sub(after, before), true
	}
	if before, after, ok := deltaBeforeAfter(ev, "balance:"+ev.Actor); ok && before != nil {
		d := new(big.Int).Sub(before, after)
		if d.Sign() >= 0 {
			return d, true
		}
	}
	if before, after, ok := deltaBeforeAfter(ev, "balance"); ok && before != nil {
		d := new(big.Int).Sub(before, after)
		if d.Sign() >= 0 {
			return d, true
		}
	}
	return nil, false
}

// ---------------------------------------------------------------------------
// Top-level report.

// Report bundles all four analyses over one trace.
type Report struct {
	Trace    *Trace
	Ledger   LedgerReport
	DeadEnds DeadEndReport
	Coverage CoverageReport
	Failures FailureReport
}

// Analyze runs all four analyses over tr.
func Analyze(tr *Trace) Report {
	return Report{
		Trace:    tr,
		Ledger:   AnalyzeLedger(tr),
		DeadEnds: AnalyzeDeadEnds(tr),
		Coverage: AnalyzeCoverage(tr),
		Failures: AnalyzeFailures(tr),
	}
}

// Critical reports whether cmd/simreport should exit non-zero. Four gates,
// each an actual funds/liveness failure the sim exists to catch:
//   - the money identity failed to close (ledger.go);
//   - a PERSISTENT per-actor dead end — value held with zero legal route and
//     no structural resolution (journey.go);
//   - the TREASURY-FROZEN flag — protocol revenue sits with NO exit ever
//     exercised in the whole trace (C2). Pre-fix this is exactly the state a
//     conservation-only check rendered identically to an idle reserve; the
//     reachable-exit check now FLAGS it instead of counting it clean
//     (Upgrade 1). Post-fix the owner drives WithdrawTreasury, so the flag
//     clears;
//   - a MARKET dead end — a FROZEN market pinned by an unresolved PENDING
//     escrow past its reclaim window, so CloseIfDrained can never fire and
//     the creator can never re-register (H1, Upgrade 2). Post-fix any third
//     party can push the permissionless Reclaim, so this set must be empty.
//
// The ReclaimGrace gap is a real, reportable dead end but is TRANSIENT and
// resolves automatically at a known block; it is reported prominently but
// does not fail the build on its own — see journey.go's doc comment for the
// reasoning and DeadEndReport.Persistent for the field that does.
func (r Report) Critical() bool {
	return !r.Ledger.Closes ||
		r.Ledger.TreasuryFrozenFlag ||
		len(r.DeadEnds.Persistent) > 0 ||
		len(r.DeadEnds.MarketDeadEnds) > 0
}

// String renders the full human-readable report.
func (r Report) String() string {
	var b strings.Builder
	fmt.Fprintf(&b, "=== SIMULATION REPORT ===\n")
	if r.Trace != nil {
		fmt.Fprintf(&b, "seed=%d events=%d\n", r.Trace.Seed, len(r.Trace.Events))
	}
	b.WriteString("\n")
	r.Ledger.render(&b)
	b.WriteString("\n")
	r.DeadEnds.render(&b)
	b.WriteString("\n")
	r.Coverage.render(&b)
	b.WriteString("\n")
	r.Failures.render(&b)
	b.WriteString("\n")
	fmt.Fprintf(&b, "=== VERDICT ===\n")
	if r.Critical() {
		fmt.Fprintf(&b, "CRITICAL: ")
		if !r.Ledger.Closes {
			fmt.Fprintf(&b, "money identity does not close. ")
		}
		if r.Ledger.TreasuryFrozenFlag {
			fmt.Fprintf(&b, "treasury frozen forever (C2): %s locked with no exit ever exercised. ", r.Ledger.TreasuryFinal)
		}
		if len(r.DeadEnds.Persistent) > 0 {
			fmt.Fprintf(&b, "%d persistent dead end(s) found holding value. ", len(r.DeadEnds.Persistent))
		}
		if len(r.DeadEnds.MarketDeadEnds) > 0 {
			fmt.Fprintf(&b, "%d FROZEN market(s) bricked by an unresolved escrow (H1). ", len(r.DeadEnds.MarketDeadEnds))
		}
		b.WriteString("\n")
	} else {
		fmt.Fprintf(&b, "clean: money identity closes, treasury is drainable by the owner, no persistent per-actor dead ends, no FROZEN market bricked by an unresolved escrow.\n")
	}
	return b.String()
}
