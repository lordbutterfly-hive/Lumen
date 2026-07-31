// Magi Creator Tokens — thin VSC/TinyGo wasm wrapper.
//
// All fund-critical logic (state machine, solvency math, invariants) lives in
// the pure-Go `core` package (../core/*.go) and is NOT touched here. This
// file's only jobs are: read the VSC SDK env (caller/block), parse the
// flat-JSON action payload, call into `core`, and move real HBD via
// sdk.HiveDraw/HiveTransfer around it. Spec: SPEC-CREATOR-KEYS.md §1;
// function contracts: ../core/API.md.
//
// Build (Docker, tinygo not installed locally):
//
//	docker run --rm -v "/mnt/o/CREATOR-TOKENS":/work -w /work tinygo/tinygo:0.39.0 \
//	    tinygo build -gc=custom -scheduler=none -panic=trap -no-debug -target=wasm-unknown \
//	    -o bin/main.wasm ./contract
//
// Error convention: a *core.Err (typed, symbol-tagged) is surfaced via
// sdk.Revert(err.Msg, err.Symbol) so callers/wallets can branch on the symbol
// (AUTH/INPUT/STATE/ARITH/BALANCE/PAUSED/NOT_FOUND/ORACLE/CAP, see
// ../core/errors.go). Any other error, and every wasm-layer-detected input
// problem this wrapper itself constructs as a *core.Err (see inputErr/
// authErr below), goes through the same path for a single consistent error
// surface. A narrowing overflow at the *big.Int->int64 SDK boundary
// (nativeInt64) is the one case that Aborts directly, matching
// hive-price-market/contract/main.go's nativeInt64 (which itself mirrors
// magi-market's nativeAmountInt64) exactly.
//
// TWO deliberate departures from "just trust the payload," both load-bearing:
//
//  1. `ask`'s settlement rate is NEVER read from the payload, and — as of
//     the 2026-07-20 defect fix — is not even a parameter this wrapper
//     chooses: core.Ask derives it internally (RULING C, 2026-07-21:
//     core.SettlementRate is now min(TWAP_short, TWAP_long, spot) and
//     REFUSES with a typed error when no safe rate exists — the old
//     TWAP-or-PAR fallback is deleted; see core/settlement.go's autopsy.
//     The rings are fed by the trade path itself: core.Buy/core.Sell call
//     core.RecordObs with the curve's marginal rate, so no DEX integration
//     is needed for settlement to leave refusal). core.Ask used to take
//     `rate *big.Int` as a bare parameter, which meant any caller could
//     silently defeat SPEC §1.3b's manipulation defense by mis-binding it.
//     See the Ask entrypoint
//     below, and its sibling guard: `maxCredits`, the asker's own signed
//     cap on the credits leg, closing a SEPARATE manipulation surface
//     (creator-controlled `face`, via SetFace) that none of §1.3b's
//     oracle-only mitigations touch.
//  2. `transfer`'s `from` is ALWAYS the env caller, never the payload.
//     core.TransferCredits takes `from` as a bare string with no internal
//     authorization check of its own (unlike Refund/RefundHolder, whose
//     authority comes from which balance key they read/burn) — the entire
//     "you can only move your own credits" guarantee is this wrapper's
//     responsibility to enforce by construction. See the Transfer entrypoint.
//
// TESTING NOTE: this package cannot be built or tested by plain `go build`/
// `go test` under any GOOS/GOARCH/tag combination — it unconditionally
// imports creator-tokens/sdk, which imports creator-tokens/runtime, whose
// only file is guarded by `//go:build gc.custom` and, even with that tag
// forced, uses TinyGo-only compiler intrinsics the mainline Go compiler
// rejects (verified directly: both a native build and a forced
// `GOOS=wasip1 GOARCH=wasm -tags gc.custom` build fail before compiling a
// single test). Because Go compiles every non-test file in a directory as
// one unit, this is true for the WHOLE contract/ directory, not just this
// file — no test file placed here, however sdk-free itself, could ever run.
// The payload parser (jsonStr/jsonU64/parseBigDecimal/nativeInt64/
// jsonEscape below) is therefore not duplicated into a same-directory test
// file that could never execute; it has been extracted into
// contract/parse/parse.go — a real, sdk-free package this file now calls
// into as its actual implementation — with its tests at
// contract/parse/parse_test.go, runnable via plain `go test
// ./contract/parse/...`. See that package's own file doc for the full
// investigation.
package main

import (
	"math"
	"math/big"
	"strconv"

	"creator-tokens/contract/parse"
	"creator-tokens/core"
	"creator-tokens/sdk"
)

func main() {}

// ===================================
// core.Store adapter
// ===================================

// sdkStore adapts the VSC SDK's per-contract state
// (StateGetObject/StateSetObject/StateDeleteObject) to the core.Store
// interface the pure core operates on. No caching, no batching — every
// Get/Set/Delete is a direct host call. A missing key and a key explicitly
// set to "" both read back as ("", false)/("", true) respectively, which
// matches how core/util.go's typed accessors already treat "" as the
// zero/default value either way (see getStr/getU64/getMoney).
type sdkStore struct{}

func (sdkStore) Get(key string) (string, bool) {
	v := sdk.StateGetObject(key)
	if v == nil {
		return "", false
	}
	return *v, true
}

func (sdkStore) Set(key, value string) {
	sdk.StateSetObject(key, value)
}

func (sdkStore) Delete(key string) {
	sdk.StateDeleteObject(key)
}

var store sdkStore

// ===================================
// Error helpers
// ===================================

// handleErr maps a core-layer error to the wasm host. Every call site MUST
// treat this as terminal (`handleErr(err); return nil`) — sdk.Abort halts via
// its own trailing panic() (fatal under -panic=trap), but sdk.Revert does NOT
// panic internally, so falling through after it would keep executing wrapper
// code on top of a reverted-but-still-live Go call stack (e.g. attempting a
// second, unrelated HiveTransfer on top of an already-reverted transaction).
// The explicit `return nil` after every call site below is the defense
// against that.
func handleErr(err error) {
	if cerr, ok := err.(*core.Err); ok {
		sdk.Revert(cerr.Msg, cerr.Symbol)
		return
	}
	sdk.Abort(err.Error())
}

func inputErr(msg string) *core.Err { return &core.Err{Symbol: core.ErrInput, Msg: msg} }
func authErr(msg string) *core.Err  { return &core.Err{Symbol: core.ErrAuth, Msg: msg} }
func stateErr(msg string) *core.Err { return &core.Err{Symbol: core.ErrState, Msg: msg} }

// notFoundErr mirrors the three above for the offering catalogue: asking
// against an id that was never created (or has been deleted) is a NOT_FOUND,
// not a malformed input and not a market-state problem.
func notFoundErr(msg string) *core.Err { return &core.Err{Symbol: core.ErrNotFound, Msg: msg} }

// nativeInt64 narrows a *big.Int to int64 for the native HiveDraw/HiveTransfer
// SDK calls (which take int64, not *big.Int). Mirrors
// hive-price-market/contract/main.go's nativeInt64 exactly: abort — not
// revert — on overflow, since an amount that doesn't fit int64 is an
// encoding/usage error at the SDK boundary, not a recoverable business
// rejection. The narrowing DECISION (does v fit, nil->0) is
// parse.NarrowInt64 — a pure, sdk-free function with its own test proving it
// refuses an out-of-range amount rather than silently truncating it; only
// the sdk.Abort side effect on refusal needs the live sdk and stays here.
func nativeInt64(v *big.Int) int64 {
	n, ok := parse.NarrowInt64(v)
	if !ok {
		sdk.Abort("native amount overflows int64")
	}
	return n
}

// i64FromU64 narrows a JSON-parsed uint64 payload field (face/cap/newFace/
// newCap) to the int64 core.Register/SetFace/SetCap signatures actually take.
// A wrapped-negative value would incidentally still get rejected by core's
// own MinFace/MinCap range checks (a wrapped int64 is always < the protocol
// minimum), but this guard makes the rejection explicit and INPUT-typed
// rather than relying on that fact — same "don't rely on an implicit proof at
// an encoding boundary" discipline CLAUDE.md flags for this codebase.
func i64FromU64(u uint64) (int64, bool) {
	if u > uint64(math.MaxInt64) {
		return 0, false
	}
	return int64(u), true
}

// ===================================
// Env helpers
// ===================================

func currentCaller() string {
	return string(sdk.GetEnv().Caller)
}

// requireActiveAuth is the C1 defect fix (PRUNED-ADJUDICATION-2026-07-21):
// currentCaller() alone (sdk.GetEnv().Caller / msg.caller) cannot distinguish
// an ACTIVE-authority tx from a POSTING-only one. go-vsc-node derives
// `caller` as RequiredAuths[0] when RequiredAuths is non-empty, else
// RequiredPostingAuths[0] (transactions.go:124-126) — so a posting-key-only
// transaction still yields a non-empty, perfectly valid `caller`. A Hive
// posting key is exactly the key every user delegates to every dApp,
// including this project's own frontend, so without this gate a leaked or
// merely-delegated posting key could authorize `transfer`/`refund`/
// `reclaim`/etc and steal a holder's credits and their backing HBD.
//
// The predicate: the tx must carry ACTIVE authority — sdk.GetEnv().Sender.
// RequiredAuths (sourced from Env2.Auths, json:"msg.required_auths",
// sdk/env.go + sdk/sdk.go's GetEnv) must be non-empty, AND caller must be
// its first element (defense-in-depth belt-and-suspenders check: the host
// already derives caller as RequiredAuths[0] whenever that array is
// non-empty, so this second comparison can never legitimately fail on a
// genuine active-auth tx — it only ever catches a caller value this wrapper
// computed some other way in the future). An empty RequiredAuths array
// (posting-only or no active signer at all) is REFUSED with an AUTH error.
//
// Called at the TOP of every state-changing entrypoint (everything except
// the read-only `quote`).
func requireActiveAuth(caller string) error {
	auths := sdk.GetEnv().Sender.RequiredAuths
	if len(auths) == 0 || string(auths[0]) != caller {
		return authErr("active authority required: posting-only (or missing) auth refused")
	}
	return nil
}

// currentBlock reads block.height from the env, never from the payload — a
// payload-supplied block would let a caller fake the chain height a Phase/
// deadline/TWAP-window decision is made against.
//
// DEFECT 2 FIX (2026-07-21): a missing/empty/unparseable block.height ABORTS,
// it does NOT return 0. Returning 0 was a silent lie: every time-based
// transition (Phase, escrow deadlines, TWAP windows) would then be computed
// against block 0 — a fresh market always ACTIVE, every deadline maximally in
// the future — so a contract that cannot know its own block height would keep
// acting on a fabricated one. A contract that cannot know the block must
// refuse to act. sdk.Abort halts via a trailing panic (fatal under
// -panic=trap); the unreachable `return 0` after each Abort both satisfies the
// compiler and guarantees the nil `h` in the first branch is never
// dereferenced by the ParseUint below.
func currentBlock() uint64 {
	h := sdk.GetEnvKey("block.height")
	if h == nil || *h == "" {
		sdk.Abort("block.height missing or unparseable")
		return 0
	}
	n, err := strconv.ParseUint(*h, 10, 64)
	if err != nil {
		sdk.Abort("block.height missing or unparseable")
		return 0
	}
	return n
}

// ===================================
// Minimal flat-JSON payload reader (TinyGo-safe, no encoding/json/reflection)
// ===================================
//
// Originally copied verbatim from hive-price-market/contract/main.go — a
// generic, core-agnostic flat-object scanner. The actual scanning logic now
// lives in contract/parse/parse.go (see this file's header TESTING NOTE for
// why: it is the only sdk-free part of this package, and moving it out is
// what makes it possible to run ANY test against it at all). jsonStr/jsonU64/
// parseBigDecimal below are thin wrappers kept under their original names so
// every call site in this file (including the four entrypoints owned by the
// other concurrently-running agent) needed zero changes. Every action below
// documents its exact payload shape. These readers assume a single flat JSON
// object (no nesting) and scan for the FIRST occurrence of `"key":`, so a
// value elsewhere in the payload that happens to contain that exact
// substring could in principle mis-locate a field — not a concern for the
// fixed, narrow payload shapes used here, and every field read only ever
// affects the CALLER'S OWN transaction (their own ask/transfer/amount
// choice), never another account's funds or state, except where a field is
// deliberately a target account (to/holder/creator) — see the file-level
// comment on why `from` is a field this wrapper refuses to read from the
// payload at all, and why `ask`'s settlement rate isn't even a value this
// wrapper chooses anymore (core.Ask derives it internally as of the
// 2026-07-20 fix). Not a general-purpose JSON parser.

func payloadStr(a *string) string {
	if a == nil {
		return ""
	}
	return *a
}

// jsonStr extracts a quoted string field's raw contents. No backslash-escape
// decoding is performed beyond skipping past an escaped character while
// scanning for the closing quote. Missing/malformed (including an unquoted
// value) ⇒ "" — see parse.Str's own doc and
// contract/parse/parse_test.go's TestStr_RejectsUnquotedValue.
func jsonStr(payload, key string) string { return parse.Str(payload, key) }

// jsonU64 extracts an unquoted decimal integer field's value. Missing,
// malformed, or negative (a leading '-' simply fails to match any digit)
// defaults to 0 — every caller below either lets core's own validation reject
// the resulting zero/short value, or (face/cap) narrows it via i64FromU64
// first.
func jsonU64(payload, key string) uint64 { return parse.U64(payload, key) }

// jsonU64Field — see parse.U64Field: use this, never jsonU64, for any field
// where 0 is a meaningful value a caller could reach by sending garbage.
func jsonU64Field(payload, key string) (uint64, bool) { return parse.U64Field(payload, key) }

// parseBigDecimal parses a base-10, non-negative big.Int money string exactly
// like core/money.go's (unexported) parseMoney. Duplicated here because this
// wrapper cannot import unexported core helpers and must not modify core/ —
// keep in sync with core.parseMoney if that ever changes. Same duplication
// this wrapper's template (hive-price-market/contract/main.go) already
// established for the identical reason.
func parseBigDecimal(s string) (*big.Int, bool) { return parse.BigDecimal(s) }

// ===================================
// Duplicated core internals (read-only, display/pricing preview ONLY)
// ===================================
//
// core/keys.go's mk()/kFace() key builder and core/money.go's mMulDivCeil
// (used by ask.go's creditsForAsk) are unexported. `quote` needs face and the
// derived credits-per-ask number to give a frontend a pre-signing cost
// preview, and cannot reach either. Reproduced here at the narrowest possible
// scope — exactly the same accepted pattern as hive-price-market/contract/
// main.go's roundAsset() (duplicates market/keys.go's rk()) and
// parseBigDecimal() above. COUPLING WARNING: keep in sync with core/keys.go's
// mk("face") and core/ask.go's creditsForAsk if those ever change.
//
// DEFECT 5 FIX (2026-07-21): the commission-formula duplicate that used to
// live here (bpsFloor, hand-copying core/money.go's mMulBpsDiv) has been
// DELETED. core.Ask (H2 fix) now requires commissionHbdPaid to EXACTLY equal
// commissionOwedFor(face), so a drift between a wrapper copy and core's own
// math would brick every ask — not merely stale a preview. Both `ask` and
// `quote` now call the exported core.CommissionOwedFor (core/read.go), the
// single formula core.Ask's own guard uses.
//
// RULING C (2026-07-21): the last remaining duplicate — quote's local
// ceilDiv creditsForAsk preview — is DELETED too: core now exports
// core.SettleSpend (settlement.go), the exact rate+credits derivation Ask
// binds internally, so `quote` previews with shared code instead
// of a copy, refusals included.
//
// SAFETY NOTE: nothing remaining here is on a fund-moving path. `ask` itself
// lets core.Ask compute the REAL, binding creditsSpent internally from core's
// own private helpers.

// ★ THE LAST DUPLICATE IS GONE TOO (2026-07-27). coreFaceKey/readFace —
// a hand-copied "m|"+creator+"|face" key builder — are DELETED. The comment
// above justified them as "the one field quote needs that core exposes no
// getter for", and that was already untrue (core.Face, core/read.go), but the
// offering catalogue is what makes the duplicate actively unsafe: an offering's
// key carries a per-incarnation EPOCH, so any wrapper-side key copy would read
// a dead incarnation's price the moment a creator re-registers.
//
// Both former call sites (`ask` and `quote`) now go through
// core.OfferingPrice(store, creator, offeringID), which returns the `face`
// price for id 0 and the named offering's own banded price otherwise — the
// same single accessor core.Ask itself binds, so a wrapper preview and the
// binding execution can never disagree about what a service costs.
func readPrice(creator string, offeringID uint64) *big.Int {
	return core.OfferingPrice(store, creator, offeringID)
}

// ceilDiv DELETED (RULING C, 2026-07-21): its one consumer was quote's
// creditsPerAsk preview, which now calls core.SettleSpend — the same
// exported derivation core.Ask binds — instead of a wrapper copy.

// ===================================
// Response helpers
// ===================================

func strPtr(s string) *string { return &s }

func bigStr(v *big.Int) string {
	if v == nil {
		return "0"
	}
	return v.String()
}

func u64s(v uint64) string { return strconv.FormatUint(v, 10) }
func i64s(v int64) string  { return strconv.FormatInt(v, 10) }

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

// jsonEscape minimally escapes backslash and double-quote characters for
// embedding a value in the hand-built JSON responses below. Not a general
// JSON string escaper — sufficient for the account-name/hash strings echoed
// here. See parse.Escape's own doc for the proof this cannot break out of
// the JSON string context it is embedded in, and for a related, separately
// reported finding (contentHash/answerHash accept raw control bytes that
// this escaper does not encode).
func jsonEscape(s string) string { return parse.Escape(s) }

// ===================================
// Entrypoints
// ===================================

// Payload: {} (ignored). Caller MUST equal contract.owner (the deployer
// recorded by the VSC runtime at contract registration). `core` has no
// Init/Owner concept of its own — core/keys.go's kOwner() is a documented key
// builder ("platform owner (bound to contract.owner at init)") but no core
// function anywhere reads or writes it; nothing in the 14 exported actions
// needs an owner today. This wrapper still bootstraps and one-time-guards it
// (matching the template and leaving a hook for any future owner-gated
// action) using the SAME literal key ("owner") kOwner() would produce. Since
// kOwner() is unexported it cannot be called from this package, but the
// literal is safe to duplicate: no core market key ever collides with a bare
// "owner" string (every per-market key is prefixed "m|", "mb|", "e|", or
// "tw|" — see core/keys.go).
//
// ⚠ 2026-07-30: the bare "owner" key is ALSO what magi-market reads to identify
// this contract's collection admin (magi-market/contract/internal.go:976-982).
// Whoever it names can set the royalty on secondary sales for every creator at
// once. It must stay a plain account string under our control.
//
//go:wasmexport init
func Init(a *string) *string {
	caller := currentCaller()
	if err := requireActiveAuth(caller); err != nil {
		handleErr(err)
		return nil
	}
	ownerEnv := sdk.GetEnvKey("contract.owner")
	if ownerEnv == nil || caller != *ownerEnv {
		handleErr(authErr("init: caller must be contract.owner"))
		return nil
	}
	if v, ok := store.Get("owner"); ok && v != "" {
		handleErr(stateErr("already initialized"))
		return nil
	}
	store.Set("owner", caller)
	// GAP CLOSED (2026-07-28): this used to be a hand-built sdk.Log, not a
	// core.Ev* constructor call — exactly the class of defect events.go's own
	// file doc warns about ("no schema test can pin them"). core.EvInit now
	// exists (core/events.go) and is pinned by core/schema_contract_test.go's
	// TestSchemaContract_Init; the emitted JSON is byte-identical to what this
	// hand-built line used to produce. magi-indexer/creator_tokens_mappings.yaml's ParseEvent still
	// documents "init" as deliberately out of its tracked event kinds (the
	// owner-bootstrap log carries no fund-relevant state), so this remains
	// LOW severity by design — unlike treasuryWithdrawn/tradeFeesClaimed
	// below, which move real money and ARE tracked by the indexer.
	sdk.Log(core.EvInit(caller))
	// ★ THE DISCOVERY TRIGGER (2026-07-30). The Magi indexer finds a token
	// contract by scanning every contract's logs for this one event name, then
	// folds its standard events into the shared tables every wallet and explorer
	// already read. WITHOUT THIS LINE THERE IS NO REGISTRY ROW, and every
	// downstream view — balances, transfers, token info, the collection
	// overview — is EMPTY for us rather than wrong. Emitted once, at init.
	sdk.Log(core.EvInitMagiNft(caller, "Lumen Creator Tokens", "LUMEN"))
	return strPtr(`{"owner":"` + jsonEscape(caller) + `"}`)
}

// Payload: {} (ignored). Owner-only. SPEC-CREATOR-KEYS.md §1.4 rules "Pause:
// Inbound pausable, outbound never. No admin path to reserves." — until this
// entrypoint existed, that ruled capability had no reachable toggle anywhere
// in the delivered system: core/market.go's RequireInflowOpen already reads
// the global pause key correctly (globalInflowPaused), but nothing ever SET
// it, and Init's own stored owner (above) was never read again by anything.
// This is the fix for both halves at once — core.Owner/core.SetPaused
// (core/read.go's "Owner / global-pause accessors" section — relocated there
// from the now-DELETED core/prepay.go when the PAR mint was removed, RULING
// A, RULINGS-v2-2026-07-21) give this entrypoint a real accessor rather than
// a second hand-duplicated literal key.
//
// Blocks ONLY Register/Renew/Buy/Ask — every path routed through
// RequireInflowOpen (core/market.go, core/buy.go, core/ask.go). Refund,
// RefundHolder, Reclaim, Answer, Decline and TransferCredits never consult
// this switch at all (see core/refund.go's, core/transfer.go's and
// core/ask.go's own file-level comments: "outflows never pause"), so pausing
// can never freeze a holder's ability to exit, a creator's ability to
// finish answering an outstanding ask, or a transfer of already-owned
// credits — this is the user's
// non-negotiable rule and it holds structurally, not by convention, because
// this entrypoint touches only the one global switch those functions never
// read.
//
//go:wasmexport pause
func Pause(a *string) *string {
	caller := currentCaller()
	if err := requireActiveAuth(caller); err != nil {
		handleErr(err)
		return nil
	}
	owner := core.Owner(store)
	if owner == "" || caller != owner {
		handleErr(authErr("pause: caller must be contract owner"))
		return nil
	}
	core.SetPaused(store, true)
	// GAP CLOSED (2026-07-28): hand-built sdk.Log replaced by core.EvPaused
	// (core/events.go), pinned by TestSchemaContract_Paused — see Init's
	// identical note above. Emitted JSON is byte-identical to the line it
	// replaces.
	sdk.Log(core.EvPaused(caller))
	return strPtr(`{"paused":true}`)
}

// Payload: {} (ignored). Owner-only, the exact inverse of Pause above —
// restores new registrations, renewals, buys and asks. See Pause's
// doc for the full reasoning; nothing here needs repeating beyond noting
// this entrypoint is what makes the pause temporary rather than a one-way
// switch with no way back for a market not yet FROZEN/CLOSED.
//
//go:wasmexport unpause
func Unpause(a *string) *string {
	caller := currentCaller()
	if err := requireActiveAuth(caller); err != nil {
		handleErr(err)
		return nil
	}
	owner := core.Owner(store)
	if owner == "" || caller != owner {
		handleErr(authErr("unpause: caller must be contract owner"))
		return nil
	}
	core.SetPaused(store, false)
	// GAP CLOSED (2026-07-28): hand-built sdk.Log replaced by core.EvUnpaused
	// (core/events.go), pinned by TestSchemaContract_Unpaused — see Init's
	// identical note above. Emitted JSON is byte-identical to the line it
	// replaces.
	sdk.Log(core.EvUnpaused(caller))
	return strPtr(`{"paused":false}`)
}

// Payload: {"face":<int64 HBD base units>,"cap":<int64 credits>,"firstBuy":
// "<decimal big.Int token count, optional>"}. `creator` is NEVER read from
// the payload: core.Register enforces caller==creator internally (SPEC §1.4
// identity binding — impersonation is structurally impossible), so this
// wrapper simply never gives a payload the chance to disagree with the
// caller in the first place.
//
// REGISTRATION IS FREE (LOCKED-MECHANISM "Revenue", USER-RULED 2026-07-21):
// the old "feePaid" field and its unconditional HiveDraw are DELETED along
// with core.RegistrationFee. The ONLY HBD this entrypoint can now draw is
// the OPTIONAL creator first buy (core.RegisterWithFirstBuy, launch.go),
// which is an ordinary Buy at full curve cost executed in the same state
// transition as the registration — never a discount, never a premine, and
// explicitly NOT an anti-snipe device (see launch.go's header before
// describing it as one anywhere).
//
// ORDERING: state FIRST, draw SECOND — core.Buy's own documented convention
// (buy.go: "the wrapper draws TotalDue ... after this call mutates state
// (CEI, state-first; a failed draw reverts the whole transaction, state
// included)"). The caller's signed transfer.allow intent is their own
// slippage cap on that draw; with n fixed by the payload and the curve
// deterministic in supply, a launch buy's cost is exact and knowable before
// signing. A plain registration (no firstBuy, or "0") draws NOTHING.
//
//go:wasmexport register
func Register(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	if err := requireActiveAuth(caller); err != nil {
		handleErr(err)
		return nil
	}
	block := currentBlock()

	face, ok := i64FromU64(jsonU64(payload, "face"))
	if !ok {
		handleErr(inputErr("face overflows int64"))
		return nil
	}
	capVal, ok := i64FromU64(jsonU64(payload, "cap"))
	if !ok {
		handleErr(inputErr("cap overflows int64"))
		return nil
	}
	// firstBuy is OPTIONAL: an absent or empty field is a plain registration.
	// A present-but-malformed one is an ERROR, never silently treated as
	// zero — a creator who meant to take the first slice must not be told
	// "registered" while quietly getting nothing.
	var firstBuy *big.Int
	if raw := jsonStr(payload, "firstBuy"); raw != "" {
		firstBuy, ok = parseBigDecimal(raw)
		if !ok {
			handleErr(inputErr("invalid firstBuy"))
			return nil
		}
	}

	res, err := core.RegisterWithFirstBuy(store, caller, caller, block, face, capVal, firstBuy)
	if err != nil {
		handleErr(err)
		return nil
	}
	if res.TotalDue.Sign() > 0 {
		sdk.HiveDraw(nativeInt64(res.TotalDue), sdk.AssetHbd) // state-first, then draw
	}
	// feePaid is logged as ZERO, structurally and forever — registration is
	// free. The event field is kept for schema stability (every other
	// EvRegistered call site in this file still carries it).
	// Declares this creator's token id to the standard tables.
	sdk.Log(core.EvTokenCreated(caller, uint64(capVal)))
	sdk.Log(core.EvRegistered(caller, caller, block, face, capVal, big.NewInt(0)))
	minted := "0"
	if res.FirstBuy != nil {
		minted = res.FirstBuy.Minted.String()
		// GAP CLOSED (2026-07-28): the atomic first buy moves real money and
		// real tokens — core.RegisterWithFirstBuy calls core.Buy internally,
		// which mutates kReserve, kFeeBal(creator) and kBal(creator,creator)
		// (buy.go) — but until now only EvRegistered was ever logged here, so
		// a creator's own initial holding was invisible to any indexer
		// forever, and that indexer's balance for the creator was wrong from
		// the very first block. res.FirstBuy is the SAME *core.BuyResult an
		// ordinary Buy would have returned (launch.go's own doc: "so the
		// wrapper's event log and the indexer can treat a launch buy as what
		// it is — a buy"), so this logs the ordinary `bought` event, with the
		// ordinary fields, through the SAME EvBought constructor the `buy`
		// entrypoint below uses — no special-cased shape for an indexer to
		// learn.
		sdk.Log(core.EvBought(caller, caller, block, res.FirstBuy.Minted, res.FirstBuy.Cost, res.FirstBuy.Fee, res.FirstBuy.TotalDue))
	}
	return strPtr(`{"creator":"` + jsonEscape(caller) + `","face":` + i64s(face) + `,"cap":` + i64s(capVal) +
		`,"firstBuyMinted":"` + minted + `","totalDue":"` + res.TotalDue.String() + `"}`)
}

// Payload: {"creator":"<hive-account>","periods":<uint64>,"paid":"<decimal
// big.Int HBD string>"}. PERMISSIONLESS — "a fan can keep a creator alive"
// (SPEC §1.7.5), so unlike register/setFace/setCap, `creator` here is
// legitimate payload data (which market's subscription to extend), not an
// identity claim about the caller: core.Renew itself never requires
// caller==creator. Draws paid (MONEY IN) BEFORE calling core.Renew.
//
//go:wasmexport renew
func Renew(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	if err := requireActiveAuth(caller); err != nil {
		handleErr(err)
		return nil
	}
	block := currentBlock()

	creator := jsonStr(payload, "creator")
	periods := jsonU64(payload, "periods")
	paid, ok := parseBigDecimal(jsonStr(payload, "paid"))
	if !ok {
		handleErr(inputErr("invalid paid"))
		return nil
	}
	// F-C9(9b): bound the raw payload amount with a CLEAN TYPED rejection BEFORE
	// the pull, mirroring Buy's BUY-INT64 guard. `paid` is a caller-supplied
	// amount that flows straight into nativeInt64 at the SDK boundary; without
	// this, an int64-overflowing `paid` hits nativeInt64's hard Abort (a
	// host-level crash, not a recoverable business rejection) and a non-positive
	// `paid` would attempt a ≤0 HiveDraw. core.Renew still re-validates the exact
	// fee below; this only keeps a malformed amount from ever reaching the draw.
	if paid.Sign() <= 0 || !paid.IsInt64() {
		handleErr(inputErr("paid must be a positive amount within int64 range"))
		return nil
	}

	sdk.HiveDraw(nativeInt64(paid), sdk.AssetHbd) // pull FIRST
	if err := core.Renew(store, caller, creator, block, periods, paid); err != nil {
		handleErr(err)
		return nil
	}
	sdk.Log(core.EvRenewed(creator, caller, block, periods, paid))
	return strPtr(`{"creator":"` + jsonEscape(creator) + `","periods":` + u64s(periods) + `}`)
}

// Payload: {"newFace":<int64 HBD base units>}. Creator-only (core.SetFace
// checks caller==creator via requireOpenCreatorMarket), so — same reasoning
// as register — `creator` is never read from the payload; it is always the
// env caller. No money movement.
//
//go:wasmexport setFace
func SetFace(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	if err := requireActiveAuth(caller); err != nil {
		handleErr(err)
		return nil
	}
	block := currentBlock()

	newFace, ok := i64FromU64(jsonU64(payload, "newFace"))
	if !ok {
		handleErr(inputErr("newFace overflows int64"))
		return nil
	}
	oldFace := nativeInt64(core.Face(store, caller)) // pre-read: SetFace returns only an error, so the event needs the old value captured here
	if err := core.SetFace(store, caller, caller, block, newFace); err != nil {
		handleErr(err)
		return nil
	}
	sdk.Log(core.EvFaceChanged(caller, caller, block, oldFace, newFace))
	return strPtr(`{"creator":"` + jsonEscape(caller) + `","face":` + i64s(newFace) + `}`)
}

// Payload: {"newCap":<int64 credits>}. Creator-only, same reasoning as
// setFace. No money movement.
//
//go:wasmexport setCap
func SetCap(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	if err := requireActiveAuth(caller); err != nil {
		handleErr(err)
		return nil
	}
	block := currentBlock()

	newCap, ok := i64FromU64(jsonU64(payload, "newCap"))
	if !ok {
		handleErr(inputErr("newCap overflows int64"))
		return nil
	}
	oldCap := nativeInt64(core.Cap(store, caller)) // pre-read, same reason as setFace
	if err := core.SetCap(store, caller, caller, block, newCap); err != nil {
		handleErr(err)
		return nil
	}
	sdk.Log(core.EvCapChanged(caller, caller, block, oldCap, newCap))
	return strPtr(`{"creator":"` + jsonEscape(caller) + `","cap":` + i64s(newCap) + `}`)
}

// THE `prepay` ENTRYPOINT IS DELETED (RULING A, RULINGS-v2-2026-07-21):
// core.Prepay minted tokens 1:1 against HBD while the curve redeems them at
// ~10.5 units per token-index — an instant mint-cheap/redeem-dear drain
// (pay 1,000, redeem 504,360 at the measured point), and every PAR-minted
// token broke the R === area(S) equality the whole mechanism now rests on.
// Buy on the curve is the ONLY issuance path; its entrypoint lands with
// Wave D's quote/entrypoint work (sell.go's sequencing requirement — the
// Sell entrypoint must land in the same wave). Any wallet still calling
// `prepay` gets the runtime's standard unknown-entrypoint failure, which is
// the honest outcome: the operation it names no longer exists.

// Payload: {"creator":"<hive-account>","to":"<hive-account>","amount":
// "<decimal big.Int credits string>"}. `from` is ALWAYS the env caller, NEVER
// the payload — see the file-level comment (departure #2). core.TransferCredits
// takes `from` as a bare string with no authorization check of its own; this
// wrapper is the entire enforcement boundary for "you can only move your own
// credits." No SDK money call: credits are an internal per-market ledger
// balance, never HBD/HIVE, so nothing here ever touches HiveDraw/HiveTransfer.
//
//go:wasmexport transfer
func Transfer(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	if err := requireActiveAuth(caller); err != nil {
		handleErr(err)
		return nil
	}

	block := currentBlock()
	creator := jsonStr(payload, "creator")
	to := jsonStr(payload, "to")
	// M6: reject a malformed destination before core.TransferCredits ever
	// credits it — core.TransferCredits takes `to` as a bare string with no
	// validation of its own, so an unsignable/malformed `to` would strand
	// the moved credits at a dead key forever with no HiveTransfer/refund
	// path able to reach them (credits are an internal ledger balance, not
	// HBD — there is no separate outbound transfer call here to gate; this
	// IS the fund-moving call for this entrypoint).
	if !isPayableAddress(to) {
		handleErr(inputErr("invalid destination address"))
		return nil
	}
	amount, ok := parseBigDecimal(jsonStr(payload, "amount"))
	if !ok {
		handleErr(inputErr("invalid amount"))
		return nil
	}

	// `block` (RULING A): TransferCredits re-averages the RECIPIENT's hold
	// clock toward now — LOCKED-MECHANISM's "reset on any inflow/transfer" —
	// which closed a test-proven exit-tax laundering bypass. The clock leg
	// needs the chain block, so the core signature carries it since the
	// money-core rewrite.
	if err := core.TransferCredits(store, creator, caller, to, block, amount); err != nil {
		handleErr(err)
		return nil
	}
	sdk.Log(core.EvTransferred(creator, caller, to, block, amount))
	return strPtr(`{"creator":"` + jsonEscape(creator) + `","from":"` + jsonEscape(caller) + `","to":"` + jsonEscape(to) + `","amount":"` + amount.String() + `"}`)
}

// isPayableAddress is the payee gate: a recognised address form that can also
// actually RECEIVE a payout.
//
// ★ IsValid() alone is not enough (scrutiny F1, 2026-07-30). It classifies
// `system:` as a valid form — and go-vsc's ledger refuses every transfer to one,
// so a balance parked there can be burned by the wind-down push and then revert
// the payout, pinning supply above zero forever: the market can never close and
// the creator can never re-register. Domain() already distinguishes them; the
// gate just has to consult it.
func isPayableAddress(a string) bool {
	addr := sdk.Address(a)
	return addr.IsValid() && addr.Domain() != sdk.AddressDomainSystem && addr.Domain() != sdk.AddressDomainContract
}

// emitMaturedDelta emits the standard and flat transfer events for whatever the
// matured bucket did across a call, given its balance beforehand.
//
// It exists because Refund and RefundHolder can BOTH graduate a position (a
// mint into the tradable bucket) and draw from it (a burn out), and neither
// returns those figures. Measuring the delta at the wrapper is the honest way
// to emit without threading two more values through core's money signatures.
// A zero delta emits nothing.
func emitMaturedDelta(creator, holder, operator string, block uint64, before *big.Int) {
	after := core.MaturedOf(store, creator, holder)
	switch after.Cmp(before) {
	case 1: // grew — a graduation into the tradable bucket
		d := new(big.Int).Sub(after, before)
		sdk.Log(core.EvTransferSingle(operator, "", holder, creator, d))
		sdk.Log(core.EvMaturedMoved(creator, operator, "", holder, block, d))
	case -1: // shrank — tokens left the tradable supply
		d := new(big.Int).Sub(before, after)
		sdk.Log(core.EvTransferSingle(operator, holder, "", creator, d))
		sdk.Log(core.EvMaturedMoved(creator, operator, holder, "", block, d))
	}
}

// ---------------------------------------------------------------------------
// THE MARKET-FACING DOORS (2026-07-30). See core/doors.go for the model.
//
// These exist so a MATURED creator token can be traded on magi-market using
// Magi's own token interface rather than a dialect of our own. Only matured
// tokens pass through them: a token still inside the exit-tax window owes an
// amount that depends on its own age, so it is not interchangeable with
// anything and it does not leave.
// ---------------------------------------------------------------------------

// Payload: {"from":"<acct>","to":"<acct>","id":"<creator>","amount":<NUMBER>,"data":"<ignored>"}
//
// ★★ `amount` IS A BARE JSON NUMBER, NOT A QUOTED STRING. This is the ONE place
// in this contract where that is true, and it is not our choice: magi-market
// builds this payload itself and emits an unquoted number
// (magi-market/contract/internal.go:943-949). Our house rule is "money is a
// string, always" — and a faithful application of it here would parse the amount
// as zero, compile, pass every local test, deploy, and then fail EVERY market
// purchase. Hence jsonU64Field (a bare-number parse with an explicit validity
// flag) rather than jsonStr + parseBigDecimal.
//
// A token count is safe in uint64 by scope: it is bounded by supply, which is
// bounded by MaxCap = 1e9. HBD never passes through here.
//
// AUTH — deliberately NOT requireActiveAuth. The caller may be a contract (the
// marketplace settling a sale), and the active-auth gate structurally refuses
// every contract caller. The authority is the ALLOWANCE, granted earlier by the
// owner under their own active key at the `approve` door. See core/doors.go for
// why authorising on the transaction's signers instead would be a gate that
// always passes.
//
//go:wasmexport safeTransferFrom
func SafeTransferFrom(a *string) *string {
	payload := payloadStr(a)
	spender := currentCaller() // msg.caller — the immediate caller, contract or human

	from := jsonStr(payload, "from")
	to := jsonStr(payload, "to")
	creator := jsonStr(payload, "id") // the token id IS the creator
	amountU64, ok := jsonU64Field(payload, "amount")
	if !ok {
		handleErr(inputErr("invalid amount (expected a bare JSON number)"))
		return nil
	}
	if amountU64 == 0 {
		handleErr(inputErr("amount must be positive"))
		return nil
	}
	// The owner moving their own tokens must still prove active authority —
	// otherwise a delegated posting key could move a holder's balance, which is
	// the exact defect requireActiveAuth exists to close. A third-party spender
	// is authorised by the allowance instead, inside core.
	if spender == from {
		if err := requireActiveAuth(spender); err != nil {
			handleErr(err)
			return nil
		}
	}
	if !isPayableAddress(to) {
		handleErr(inputErr("invalid destination address"))
		return nil
	}

	amount := new(big.Int).SetUint64(amountU64)
	if err := core.TransferMatured(store, creator, from, to, spender, amount); err != nil {
		handleErr(err)
		return nil
	}
	// The derived balance views are inflow minus outflow over these events, so
	// every matured-bucket movement must emit one.
	sdk.Log(core.EvTransferSingle(spender, from, to, creator, amount))
	sdk.Log(core.EvMaturedMoved(creator, spender, from, to, currentBlock(), amount))
	return strPtr(`{"success":true}`)
}

// Payload: {"spender":"<acct>","id":"<creator>","amount":<NUMBER>,"expected":<NUMBER>}
//
// The GRANT door. Caller is always the owner and always a human, so the active
// auth requirement is discharged here, once. An ungated approve would let a
// delegated posting key hand a spender authority over the owner's tokens — the
// same critical one indirection later.
//
// `expected` is our addition to the standard shape: the allowance is set only if
// it currently equals that value. Intra-block ordering on this chain is chosen
// by the block producer rather than won in a fee auction, which makes the
// classic re-approve race a decision rather than a gamble. Setting to zero
// always succeeds, so revoking authority is never blocked.
//
//go:wasmexport approve
func ApproveAllowance(a *string) *string {
	payload := payloadStr(a)
	owner := currentCaller()
	if err := requireActiveAuth(owner); err != nil {
		handleErr(err)
		return nil
	}

	spender := jsonStr(payload, "spender")
	creator := jsonStr(payload, "id")
	amountU64, ok := jsonU64Field(payload, "amount")
	if !ok {
		handleErr(inputErr("invalid amount (expected a bare JSON number)"))
		return nil
	}
	// A malformed `expected` must NOT silently read as zero: a client following
	// the house money-is-a-string convention would send "500", parse to 0, and
	// get "allowance changed since it was read" for a perfectly well-formed
	// intent (scrutiny F13). Absent is legitimate only when revoking.
	expectedU64, expectedOK := jsonU64Field(payload, "expected")
	if !expectedOK && amountU64 > 0 {
		handleErr(inputErr("expected current allowance required as a bare JSON number (compare-and-set)"))
		return nil
	}

	if err := core.Approve(store, owner, spender, creator,
		new(big.Int).SetUint64(expectedU64), new(big.Int).SetUint64(amountU64)); err != nil {
		handleErr(err)
		return nil
	}
	return strPtr(`{"success":true}`)
}

// Payload: {"id":"<creator>"}
//
// Moves the caller's own cleared position into the tradable bucket. The holder's
// own act, under their own active key — deliberately not permissionless: an
// arbitrary caller able to top up someone's tradable balance at a moment of
// their choosing can re-arm a listing or an allowance the holder had left
// unbacked, at a stale price.
//
// A no-op when nothing has cleared, so a client can call it unconditionally
// before listing without first reading the chain.
//
//go:wasmexport graduate
func GraduateMatured(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	if err := requireActiveAuth(caller); err != nil {
		handleErr(err)
		return nil
	}
	creator := jsonStr(payload, "id")
	moved := core.Graduate(store, creator, caller, currentBlock())
	if moved.Sign() > 0 {
		// Mint shape (from == ""): tokens entering the tradable supply.
		sdk.Log(core.EvTransferSingle(caller, "", caller, creator, moved))
		sdk.Log(core.EvMaturedMoved(creator, caller, "", caller, currentBlock(), moved))
	}
	return strPtr(`{"graduated":"` + moved.String() + `"}`)
}

// Payload: {"owner":"<acct>","spender":"<acct>","id":"<creator>"} — read-only.
//
//go:wasmexport allowance
func AllowanceRead(a *string) *string {
	payload := payloadStr(a)
	v := core.AllowanceOf(store,
		jsonStr(payload, "owner"), jsonStr(payload, "spender"), jsonStr(payload, "id"))
	// `amount`, not `allowance` — the standard's own response key
	// (magi_nft's AllowanceResponse). Speaking the standard is the whole point
	// of these doors; a dialect here defeats it (scrutiny F5).
	return strPtr(`{"amount":` + v.String() + `}`)
}

// Payload: {"account":"<acct>","id":"<creator>"} — read-only.
//
// Returns the MATURED balance only, because that is what this interface means to
// every consumer of it: the tokens that can move. The maturing half is real and
// spendable on the curve, but it is not transferable, and reporting it here
// would promise liquidity that does not exist. `creatorTokenBalance` reports
// both for our own UI.
//
//go:wasmexport balanceOf
func BalanceOfMatured(a *string) *string {
	payload := payloadStr(a)
	v := core.MaturedOf(store, jsonStr(payload, "id"), jsonStr(payload, "account"))
	return strPtr(`{"balance":` + v.String() + `}`)
}

// Payload: {"account":"<acct>","id":"<creator>"} — read-only, OUR shape.
//
// The honest full picture for our own screens: what can move today, what is
// still maturing, and when it graduates. One call rather than three, because at
// a thousand creators a per-creator round trip is the cost model the whole
// design exists to avoid.
//
//go:wasmexport creatorTokenBalance
func CreatorTokenBalance(a *string) *string {
	payload := payloadStr(a)
	creator := jsonStr(payload, "id")
	account := jsonStr(payload, "account")
	return strPtr(`{"matured":"` + core.MaturedOf(store, creator, account).String() +
		`","maturing":"` + core.MaturingOf(store, creator, account).String() +
		`","maturesAtBlock":` + u64s(core.MaturesAtBlock(store, creator, account)) + `}`)
}

// Payload: {"creator":"<hive-account>","contentHash":"<string>",
// "deadlineBlocks":<uint64>,"maxCredits":"<decimal big.Int credits
// string>"}.
//
// TWO legs, per SPEC §1.7.3: the credit spend (internal ledger, computed by
// core.Ask itself from the on-chain face/rate — never sent as a payload
// amount) and the 12% commission in HBD (drawn here). The contract never
// holds a creator's credits — Ask moves them straight from the asker's
// balance into the escrow record inside core; no token-side SDK call exists
// for this action at all.
//
// The settlement rate is NEVER read from the payload, and — as of the
// 2026-07-20 defect fix — is no longer even something THIS wrapper binds:
// core.Ask derives it internally (RULING C, 2026-07-21: settleSpend =
// min(TWAP_short, TWAP_long, spot) + the depth/spend/min-price guards,
// REFUSING with a typed error when no safe rate exists — the TWAP-or-PAR
// fallback is deleted; core/settlement.go has the full autopsy of why PAR
// was a 100x asker-robbing default, and core.Buy/core.Sell now feed the
// observation rings from the curve itself). Previously this entrypoint
// called core.AskRate itself and passed the result as core.Ask's `rate`
// parameter — a footgun no caller should ever hold; a refused settlement
// simply surfaces here as the same typed revert every other core error does.
//
// `maxCredits` IS read from the payload — it is the asker's own signed cap
// on how many credits this ask may cost (an exploiter-scrutinizer finding,
// 2026-07-20): `face` is creator-controlled via SetFace and can move
// between signing and execution under producer-chosen intra-block
// ordering, a manipulation surface none of SPEC §1.3b's rate-only
// mitigations touch. See core.Ask's own doc for the attack and the guard.
//
// `commissionHbdPaid` is NO LONGER read from the payload at all (H2 defect
// fix, 2026-07-21 — PRUNED-ADJUDICATION-2026-07-21.md). core.Ask now
// requires commissionHbdPaid to be EXACTLY commissionOwedFor(face) at
// execution, not merely >=, so trusting a payload amount here could only
// ever cause a spurious reject (too high/low) — never a legitimate reason
// to draw anything other than the true owed amount. This entrypoint computes
// `owed` itself using the exported core.CommissionOwedFor (core/read.go,
// DEFECT 5 fix) — the SINGLE formula core.Ask's own exact-equality guard uses,
// the same one `quote` now previews with — so the wrapper can no longer drift
// from core's floor math and brick a legitimate ask. It draws exactly that via
// HiveDraw and passes `owed` — not any caller-supplied number — into core.Ask.
// The asker's own signed transfer.allow limit still bounds this draw: a face
// rise past their limit fails the draw (asker protected); a face drop charges
// less (asker saves), exactly the guarantee H2's fix requires. It also guards
// face<=0 BEFORE the draw (DEFECT 4 fix) so a market with no posted face
// surfaces core.Ask's precise "creator has no face price set" STATE error,
// never an opaque HiveDraw(0) revert.
//
//go:wasmexport ask
func Ask(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	if err := requireActiveAuth(caller); err != nil {
		handleErr(err)
		return nil
	}
	block := currentBlock()

	creator := jsonStr(payload, "creator")
	contentHash := jsonStr(payload, "contentHash")
	deadlineBlocks := jsonU64(payload, "deadlineBlocks")
	maxCredits, ok := parseBigDecimal(jsonStr(payload, "maxCredits"))
	if !ok {
		handleErr(inputErr("invalid maxCredits"))
		return nil
	}

	// DEFECT 4 FIX (2026-07-21): guard face<=0 BEFORE drawing anything. A
	// market whose creator never set a face (or a `creator` naming no market
	// at all) reads face==0, so `owed` below is 0 and the HiveDraw(0) reverts
	// with an opaque SDK error instead of core.Ask's precise "creator has no
	// face price set". Mirror quote's own face<=0 guard so the asker gets that
	// exact clear STATE error and no zero-amount draw is ever attempted.
	// offeringId (2026-07-27): absent ⇒ 0 ⇒ the legacy single `face` price, so
	// every existing client payload keeps its exact meaning. A nonzero id names
	// one of the creator's posted services and prices this ask at THAT
	// offering's own banded price. A deleted or never-created id reads 0 and is
	// refused right here, before any HBD is drawn.
	// PRESENT-BUT-UNPARSEABLE is refused rather than defaulted (parse.U64Field,
	// 2026-07-27): 0 names the legacy face price, so silently falling back to
	// it would settle against the WRONG, cheaper service and underpay the
	// creator, with nothing in the receipt to show why. `quote` refuses it too
	// — a preview that answers a malformed id with a price is worse than the
	// refusal the ask itself will give.
	offeringID, idOK := jsonU64Field(payload, "offeringId")
	if !idOK {
		handleErr(inputErr("offeringId must be an unquoted non-negative integer"))
		return nil
	}
	face := readPrice(creator, offeringID)
	if face.Sign() <= 0 {
		if offeringID == 0 {
			handleErr(stateErr("creator has no face price set"))
		} else {
			handleErr(notFoundErr("no such offering"))
		}
		return nil
	}
	// H2 + DEFECT 5 FIX (2026-07-21): draw only the EXACT commission owed on
	// the face in effect right now — never a payload-supplied amount —
	// computed via core.CommissionOwedFor, the ONE formula core.Ask's own
	// exact-equality guard (ask.go's commissionOwedFor) uses. This replaces a
	// hand-copied bpsFloor duplicate: since core.Ask requires commissionHbdPaid
	// to EXACTLY equal commissionOwedFor(face), any drift between a wrapper
	// copy and core's math would brick every ask outright.
	owed := core.CommissionOwedFor(face)

	sdk.HiveDraw(nativeInt64(owed), sdk.AssetHbd) // commission leg, pull FIRST, EXACTLY owed
	maturedBefore := core.MaturedOf(store, creator, caller)
	res, err := core.Ask(store, caller, creator, block, maxCredits, owed, contentHash, deadlineBlocks, offeringID)
	if err != nil {
		handleErr(err)
		return nil
	}
	// An ask draws from the MATURED bucket once maturing tokens are exhausted,
	// and every change to that bucket must emit or the shared explorer tables
	// overstate the holder's tradable balance permanently (scrutiny F2).
	emitMaturedDelta(creator, caller, caller, block, maturedBefore)
	sdk.Log(core.EvAsked(creator, caller, block, res.Seq, res.CreditsSpent, res.CommissionHbd, res.RateUsed, deadlineBlocks, contentHash, offeringID))
	return strPtr(`{"creator":"` + jsonEscape(creator) + `","seq":` + u64s(res.Seq) + `,"creditsSpent":"` + bigStr(res.CreditsSpent) + `","commissionHbd":"` + bigStr(res.CommissionHbd) + `","rate":"` + res.RateUsed.String() + `"}`)
}

// Payload: {"seq":<uint64>,"answerHash":"<string>"}. Creator-only
// (core.Answer checks caller==creator), so `creator` is never read from the
// payload — always the env caller, same reasoning as setFace/setCap. No SDK
// money call: Answer credits the creator's OWN internal token balance
// (kBal(creator,creator)) — an internal ledger bump, never a transfer.
//
//go:wasmexport answer
func Answer(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	if err := requireActiveAuth(caller); err != nil {
		handleErr(err)
		return nil
	}
	block := currentBlock()

	// seq is STRICT: escrow #0 is a real, live escrow, so a malformed seq must
	// never silently default to it (parse.U64Field, 2026-07-27 — the same
	// 0-is-meaningful hazard closed for offeringId; a code review caught that
	// the escrow rails still had it).
	seq, seqOK := jsonU64Field(payload, "seq")
	if !seqOK {
		handleErr(inputErr("seq must be an unquoted non-negative integer"))
		return nil
	}
	answerHash := jsonStr(payload, "answerHash")

	// F-C1/F-C8: measure the caller's matured bucket across the call so the
	// graduation core.Answer now performs (banking the creator's aged position
	// before the answer credit lands) is emitted. Recipient == caller here, so the
	// wrapper measures the delta directly (like Refund/Buy).
	maturedBefore := core.MaturedOf(store, caller, caller)
	res, err := core.Answer(store, caller, caller, block, seq, answerHash)
	if err != nil {
		handleErr(err)
		return nil
	}
	emitMaturedDelta(caller, caller, caller, block, maturedBefore)
	// M4: EvAnswered now also carries the commission booked to treasury
	// (AnswerResult.CommissionHbd), so the indexer's event stream can
	// reconstruct the HBD money model.
	sdk.Log(core.EvAnswered(caller, caller, block, seq, res.CreditsToCreator, res.CommissionHbd, answerHash))
	return strPtr(`{"creator":"` + jsonEscape(caller) + `","seq":` + u64s(seq) + `,"creditsToCreator":"` + bigStr(res.CreditsToCreator) + `"}`)
}

// Payload: {"creator":"<hive-account>","seq":<uint64>}. `creator` IS payload
// data here — an asker can hold pending asks against many different
// creators' markets, and `caller` alone doesn't say which escrow they mean.
//
// H1 DEFECT FIX (2026-07-21 — PRUNED-ADJUDICATION-2026-07-21.md):
// core.Reclaim is now PERMISSIONLESS once the reclaim window is open —
// `caller` is checked non-empty only and is no longer required to be the
// escrow's own asker (this is the fix for the "abandoned PENDING escrow
// bricks the creator's market forever" bug: anyone, e.g. a keeper, can now
// resolve it). The payout ALWAYS lands on the escrow's own stored asker,
// now exposed as ReclaimResult.Asker — `caller` MUST NEVER be paid here,
// since now that this action is permissionless `caller` can be a
// completely unrelated third party who would otherwise steal the credits'
// backing HBD commission out of a stranger's abandoned escrow. Credits
// return to the asker's OWN internal balance inside core (an internal
// ledger bump, never HBD, and always correctly targeted at rec.asker
// regardless of who calls) — only the HBD commission leg below is this
// wrapper's responsibility to aim correctly.
//
// MONEY OUT (defect fix, 2026-07-20; beneficiary fixed 2026-07-21 alongside
// H1 above): core.Reclaim also returns the HBD commission that was held
// against this escrow (SPEC §1.7.2 rule 4: "when an ask is reclaimed
// unanswered, the asker gets 100% back... we are paid for delivered service
// only"). core itself never moves HBD, so THIS wrapper must: state is
// mutated FIRST (core.Reclaim, which burns nothing — it only credits the
// asker's ledger balance and flips the escrow to RECLAIMED), THEN
// sdk.HiveTransfer pays the commission back to sdk.Address(res.Asker) —
// CEI ordering, the same pattern `refund`/`refundHolder` already use for
// their own HBD payouts, and the same "pay the rightful owner, never the
// pusher" shape `refundHolder` already established.
//
// decline — the creator's free "no" (RULING E's delivery gate, 2026-07-27).
// Returns the asker's credits AND the whole commission inside the same window
// an answer would be legal in, and does NOT count as a missed delivery.
//
// This is what makes the delivery gate fair: without it, a creator asked for
// something they cannot do must either answer badly or take a black mark for
// ignoring it. It is also the anti-griefing rail — junk asks aimed at
// manufacturing misses can be cleared out for free.
//
// Payment ordering mirrors `reclaim` exactly: state first, HBD second, and the
// commission goes to res.Asker, never to the caller (here they are the same
// account only because Decline is creator-only — the ask's asker is a
// different party entirely, and paying `caller` would send the refund to the
// creator instead of the customer).
//
//go:wasmexport decline
func Decline(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	if err := requireActiveAuth(caller); err != nil {
		handleErr(err)
		return nil
	}
	block := currentBlock()

	creator := jsonStr(payload, "creator")
	// seq is STRICT: escrow #0 is a real, live escrow, so a malformed seq must
	// never silently default to it (parse.U64Field, 2026-07-27 — the same
	// 0-is-meaningful hazard closed for offeringId; a code review caught that
	// the escrow rails still had it).
	seq, seqOK := jsonU64Field(payload, "seq")
	if !seqOK {
		handleErr(inputErr("seq must be an unquoted non-negative integer"))
		return nil
	}

	res, err := core.Decline(store, caller, creator, block, seq) // state mutated FIRST
	if err != nil {
		handleErr(err)
		return nil
	}
	if res.CommissionHbd != nil && res.CommissionHbd.Sign() > 0 {
		sdk.HiveTransfer(sdk.Address(res.Asker), nativeInt64(res.CommissionHbd), sdk.AssetHbd) // THEN pay the commission back to the ASKER
	}
	// F-C1/F-C8: if core.Decline banked the asker's aged position into MATURED
	// before returning the credits, emit the mint. The recipient is the asker —
	// which this wrapper's caller is NOT (the caller is the creator) — so we emit
	// from the returned figure rather than measuring a delta. operator == caller.
	if res.Graduated != nil && res.Graduated.Sign() > 0 {
		sdk.Log(core.EvTransferSingle(caller, "", res.Asker, creator, res.Graduated))
		sdk.Log(core.EvMaturedMoved(creator, caller, "", res.Asker, block, res.Graduated))
	}
	sdk.Log(core.EvDeclined(creator, caller, block, seq, res.CreditsReturned, res.CommissionHbd, res.Asker))
	return strPtr(`{"creator":"` + jsonEscape(creator) + `","seq":` + u64s(seq) + `,"asker":"` + jsonEscape(res.Asker) + `","creditsReturned":"` + bigStr(res.CreditsReturned) + `","commissionRefundedHbd":"` + bigStr(res.CommissionHbd) + `"}`)
}

//go:wasmexport rate
func Rate(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	if err := requireActiveAuth(caller); err != nil {
		handleErr(err)
		return nil
	}
	block := currentBlock()

	creator := jsonStr(payload, "creator")
	// STRICT, same 0-is-meaningful reasoning as decline/answer/reclaim above:
	// escrow #0 is a real escrow, and a malformed seq silently defaulting to it
	// would attach this buyer's score to somebody else's job.
	seq, seqOK := jsonU64Field(payload, "seq")
	if !seqOK {
		handleErr(inputErr("seq must be an unquoted non-negative integer"))
		return nil
	}
	// score is likewise strict — a missing or malformed score defaulting to 0
	// would be silently rejected by core's 1-5 bound anyway, but with a
	// misleading "score must be 1-5" instead of "you sent nothing".
	score, scoreOK := jsonU64Field(payload, "score")
	if !scoreOK {
		handleErr(inputErr("score must be an unquoted non-negative integer"))
		return nil
	}

	if err := core.Rate(store, caller, creator, seq, score); err != nil {
		handleErr(err)
		return nil
	}
	// NO fund movement here, deliberately and permanently: a rating is
	// reputation, and this entrypoint must never grow a transfer.
	sdk.Log(core.EvRated(creator, caller, block, seq, score))
	return strPtr(`{"creator":"` + jsonEscape(creator) + `","seq":` + u64s(seq) + `,"score":` + u64s(score) + `}`)
}

//go:wasmexport reclaim
func Reclaim(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	if err := requireActiveAuth(caller); err != nil {
		handleErr(err)
		return nil
	}
	block := currentBlock()

	creator := jsonStr(payload, "creator")
	// seq is STRICT: escrow #0 is a real, live escrow, so a malformed seq must
	// never silently default to it (parse.U64Field, 2026-07-27 — the same
	// 0-is-meaningful hazard closed for offeringId; a code review caught that
	// the escrow rails still had it).
	seq, seqOK := jsonU64Field(payload, "seq")
	if !seqOK {
		handleErr(inputErr("seq must be an unquoted non-negative integer"))
		return nil
	}

	res, err := core.Reclaim(store, caller, creator, block, seq) // state mutated FIRST
	if err != nil {
		handleErr(err)
		return nil
	}
	if res.CommissionHbd != nil && res.CommissionHbd.Sign() > 0 {
		// CRITICAL: pay res.Asker, NEVER caller — reclaim is permissionless
		// (H1), so caller may be an unrelated third party pushing someone
		// else's abandoned escrow. Paying caller here would let a stranger
		// steal the commission out of an escrow they have no claim to.
		sdk.HiveTransfer(sdk.Address(res.Asker), nativeInt64(res.CommissionHbd), sdk.AssetHbd) // THEN pay the commission back to the ASKER
	}
	// M4: EvReclaimed now also carries the commission returned to the
	// asker, so the indexer's event stream can reconstruct the HBD money
	// model. `caller` is logged as actor (the permissionless pusher/keeper,
	// matching EvRefundPushed's identical actor-vs-recipient shape), never
	// as who was paid.
	// CommissionRetainedHbd (USER RULING 1, 2026-07-28) is NOT transferred here
	// — core already booked it to the treasury. It is logged so the money model
	// still balances: held == paid-to-asker + retained.
	// F-C1/F-C8: if core.Reclaim banked the asker's aged position into MATURED
	// before returning the credits, emit the mint from the returned figure.
	// Reclaim is permissionless, so caller may be a third-party keeper — the
	// recipient is res.Asker, never caller. operator == caller (the actor).
	if res.Graduated != nil && res.Graduated.Sign() > 0 {
		sdk.Log(core.EvTransferSingle(caller, "", res.Asker, creator, res.Graduated))
		sdk.Log(core.EvMaturedMoved(creator, caller, "", res.Asker, block, res.Graduated))
	}
	sdk.Log(core.EvReclaimed(creator, caller, block, seq, res.CreditsReturned, res.CommissionHbd, res.CommissionRetainedHbd, res.Asker))
	return strPtr(`{"creator":"` + jsonEscape(creator) + `","seq":` + u64s(seq) + `,"asker":"` + jsonEscape(res.Asker) + `","creditsReturned":"` + bigStr(res.CreditsReturned) + `","commissionRefundedHbd":"` + bigStr(res.CommissionHbd) + `","commissionRetainedHbd":"` + bigStr(res.CommissionRetainedHbd) + `"}`)
}

// Payload: {"creator":"<hive-account>","credits":"<decimal big.Int credits
// string>","minNet":"<optional decimal big.Int HBD floor>"}. The optional
// minNet is the caller's signed net-proceeds floor (OUTFLOW-CLIFF-1); see the
// parse block below for its full semantics (absent = no guard = current
// behavior). Pull-based (API.md rule 2): the caller burns credits out of
// THEIR OWN balance and is paid THEMSELVES — core.Refund reads/burns
// kBal(creator,caller), so there is no `holder`/`to` field to misdirect here
// at all. MONEY OUT: core.Refund mutates state (burns credits, debits the
// reserve) FIRST; sdk.HiveTransfer only runs after it returns successfully —
// CEI ordering, matching the template's Claim/Reclaim pattern at
// main.go:534-551 exactly.
//
// PHASE, corrected 2026-07-21 (this comment used to say "callable in every
// phase ... consults no Phase/pause state at all", which is no longer true
// and was never true of the shipped curve): core.Refund is the WIND-DOWN
// rail and is ROUTED to FROZEN/CLOSED. It still consults no PAUSE state —
// OUTFLOWS NEVER PAUSE holds verbatim — and it never removes the holder's
// exit: in ACTIVE/OVERDUE the exit is `sell` (the curve rail, at strictly
// better pricing), in FROZEN/CLOSED it is this one, and Phase() is total, so
// every phase has exactly one open rail and no state leaves a holder
// trapped (refund.go's rail reconciliation carries the case proof). An
// ungated pro-rata while buys are live would be a tax-and-fee bypass AND
// would strand excess in the reserve for a fresh buyer to dilute into.
//
// STALE-CLAIM CORRECTION (2026-07-28): this paragraph used to end here with
// "NOTE the `sell` entrypoint is still UNBUILT ... until Wave D wires
// `buy`/`sell`, an ACTIVE-phase holder has NO on-chain exit at the wrapper
// layer. That is a WRAPPER gap ... and it is a hard blocker for shipping."
// That is no longer true and directly contradicted the paragraph's own
// opening sentence above it even at the time it was written. Wave D shipped:
// both `buy` and `sell` (their export directives are on the funcs below,
// spelled out here would inflate any naive export count) are fully
// implemented below, CEI-ordered (state mutated first, HBD moved second) and
// event-logged (EvBought/EvSold) exactly like every other fund-moving
// entrypoint in this file. The rail reconciliation above is the CURRENT,
// accurate picture: `sell` is the live ACTIVE/OVERDUE exit, `refund` here is
// the FROZEN/CLOSED exit, and no wrapper-layer gap remains — every phase has
// exactly one open, reachable rail today, not merely in this comment.
//
//go:wasmexport refund
func Refund(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	if err := requireActiveAuth(caller); err != nil {
		handleErr(err)
		return nil
	}
	block := currentBlock()

	creator := jsonStr(payload, "creator")
	credits, ok := parseBigDecimal(jsonStr(payload, "credits"))
	if !ok {
		handleErr(inputErr("invalid credits"))
		return nil
	}

	// minNet is OPTIONAL (OUTFLOW-CLIFF-1 close, FIX ROUND 4 — the enforcement
	// half of RULING F's mandatory signed quote). It is the caller's signed
	// floor on the NET HBD they receive, enforced by core.Refund's checkMinNet
	// BEFORE any write (RULING G — a tripped guard mutates nothing, so R ===
	// area(S) and every C-22/C-23/C-24 wind-down property are untouched). The K2
	// wind-down tax rate reads the live, transfer-refreshable hold clock, so a
	// same-block forced dust TransferCredits can knock a six-week 0%-tax holder
	// to the ceil-minimum 1 bps on their whole pro-rata slice; a supplied floor
	// makes that front-run REVERT cleanly instead of silently overcharging.
	//
	// Absent/empty => NO guard, threaded as an empty variadic — current behavior
	// preserved verbatim, and the escape hatch that keeps this OUTFLOW ALWAYS
	// available (OUTFLOWS-NEVER-PAUSE / RULING G: an exit is never trapped). A
	// present-but-MALFORMED value is an ERROR, never silently dropped to zero — a
	// caller who meant to bind their exit must not be paid at a rate they did not
	// sign (exactly the `register` optional-firstBuy discipline at main.go:522).
	// The permissionless push (refundHolder) deliberately takes NO minNet — the
	// pusher is not the holder and cannot sign the holder's slippage; it is
	// instead protected by core.RefundHolder's own K2 tax gate + wind-down
	// backstop.
	var minNet []*big.Int
	if raw := jsonStr(payload, "minNet"); raw != "" {
		mn, mnOk := parseBigDecimal(raw)
		if !mnOk {
			handleErr(inputErr("invalid minNet"))
			return nil
		}
		minNet = []*big.Int{mn}
	}

	// Matured-bucket delta, measured across the call. A Refund graduates the
	// caller's cleared position and may then draw from the matured bucket, and
	// EVERY change to that bucket must emit — the indexer's derived balances are
	// inflow minus outflow over those events, so a silent change is a balance
	// that stays wrong for that holder forever. Measured here rather than
	// threaded through core's signature because the wrapper is the only layer
	// that can emit at all.
	maturedBefore := core.MaturedOf(store, creator, caller)
	payout, err := core.Refund(store, caller, creator, block, credits, minNet...) // state mutated FIRST
	if err != nil {
		handleErr(err)
		return nil
	}
	if payout != nil && payout.Sign() > 0 {
		sdk.HiveTransfer(sdk.Address(caller), nativeInt64(payout), sdk.AssetHbd) // THEN pay
	}
	emitMaturedDelta(creator, caller, caller, block, maturedBefore)
	sdk.Log(core.EvRefunded(creator, caller, block, credits, payout))
	return strPtr(`{"creator":"` + jsonEscape(creator) + `","creditsBurned":"` + credits.String() + `","payoutHbd":"` + bigStr(payout) + `"}`)
}

// Payload: {"creator":"<hive-account>","tokens":"<decimal big.Int token
// amount>"}. Buy mints `tokens` new tokens along the creator's curve to the
// caller — the curve ON-RAMP (WAVE D). Buy is the one INFLOW curve side and is
// gated to phase ACTIVE/OVERDUE + not-globally-paused inside core.Buy
// (RequireInflowOpen). The single HBD leg — TotalDue = curve cost + trade fee —
// is COMPUTED by core.Buy and drawn AFTER it mutates state (CEI, state-first; a
// failed draw reverts the whole tx, state included), mirroring `register`
// (main.go's HiveDraw-after-core). Slippage is the buyer's OWN signed
// transfer.allow on that draw: the HBD allowance already bounds the variable
// leg, so — unlike ask's credits leg — no separate in-payload cost cap is
// needed (buy.go).
//
//go:wasmexport buy
func Buy(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	if err := requireActiveAuth(caller); err != nil {
		handleErr(err)
		return nil
	}
	block := currentBlock()

	creator := jsonStr(payload, "creator")
	tokens, ok := parseBigDecimal(jsonStr(payload, "tokens"))
	if !ok {
		handleErr(inputErr("invalid tokens"))
		return nil
	}

	res, err := core.Buy(store, caller, creator, block, tokens) // state mutated FIRST
	if err != nil {
		handleErr(err)
		return nil
	}
	if res.TotalDue.Sign() > 0 {
		sdk.HiveDraw(nativeInt64(res.TotalDue), sdk.AssetHbd) // THEN draw cost+fee from the buyer
	}
	if res.Graduated != nil && res.Graduated.Sign() > 0 {
		// A buy graduates the caller's cleared position before crediting the new
		// tokens; mint shape, because those tokens enter the tradable supply.
		sdk.Log(core.EvTransferSingle(caller, "", caller, creator, res.Graduated))
		sdk.Log(core.EvMaturedMoved(creator, caller, "", caller, block, res.Graduated))
	}
	sdk.Log(core.EvBought(creator, caller, block, res.Minted, res.Cost, res.Fee, res.TotalDue))
	return strPtr(`{"creator":"` + jsonEscape(creator) + `","minted":"` + bigStr(res.Minted) +
		`","cost":"` + bigStr(res.Cost) + `","fee":"` + bigStr(res.Fee) +
		`","totalDue":"` + bigStr(res.TotalDue) + `"}`)
}

// Payload: {"creator":"<hive-account>","tokens":"<decimal big.Int token
// amount>","minNet":"<optional decimal big.Int HBD floor>"}. Sell redeems
// `tokens` of the caller's balance on the curve — the holder's curve EXIT
// (WAVE D). Sell is an OUTFLOW: gated on NEITHER the pause NOR the subscription,
// so the exit is always open in ACTIVE/OVERDUE (sell.go's rail asymmetry; the
// FROZEN/CLOSED wind-down exit is `refund`). core.Sell mutates state FIRST; the
// single Net payout is transferred to the seller AFTER (CEI, mirroring
// `refund`). minNet is the caller's OPTIONAL signed floor on Net — the
// OUTFLOW-CLIFF-1 front-run/slippage guard core.Sell's checkMinNet enforces
// BEFORE any write (RULING F/G; a tripped guard mutates nothing). Absent/empty
// => NO guard (the escape hatch that keeps OUTFLOWS-NEVER-PAUSE / an-exit-never-
// trapped intact); present-but-MALFORMED => an ERROR, never silently dropped to
// zero — a seller must not be paid at a rate they did not sign.
//
//go:wasmexport sell
func Sell(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	if err := requireActiveAuth(caller); err != nil {
		handleErr(err)
		return nil
	}
	block := currentBlock()

	creator := jsonStr(payload, "creator")
	tokens, ok := parseBigDecimal(jsonStr(payload, "tokens"))
	if !ok {
		handleErr(inputErr("invalid tokens"))
		return nil
	}

	var minNet []*big.Int
	if raw := jsonStr(payload, "minNet"); raw != "" {
		mn, mnOk := parseBigDecimal(raw)
		if !mnOk {
			handleErr(inputErr("invalid minNet"))
			return nil
		}
		minNet = []*big.Int{mn}
	}

	res, err := core.Sell(store, caller, creator, block, tokens, minNet...) // state mutated FIRST
	if err != nil {
		handleErr(err)
		return nil
	}
	if res.Net != nil && res.Net.Sign() > 0 {
		sdk.HiveTransfer(sdk.Address(caller), nativeInt64(res.Net), sdk.AssetHbd) // THEN pay the seller
	}
	if res.Graduated != nil && res.Graduated.Sign() > 0 {
		sdk.Log(core.EvTransferSingle(caller, "", caller, creator, res.Graduated))
		sdk.Log(core.EvMaturedMoved(creator, caller, "", caller, block, res.Graduated))
	}
	// Burn shape (to == ""): whatever left the MATURED bucket has left the
	// tradable supply. A sale draws maturing tokens first, so this fires only
	// once those are exhausted.
	if res.MaturedBurned != nil && res.MaturedBurned.Sign() > 0 {
		sdk.Log(core.EvTransferSingle(caller, caller, "", creator, res.MaturedBurned))
		sdk.Log(core.EvMaturedMoved(creator, caller, caller, "", block, res.MaturedBurned))
	}
	sdk.Log(core.EvSold(creator, caller, block, res.Sold, res.Gross, res.Tax, res.Fee, res.Net, res.TaxableGross, res.TaxBps, res.HeldBlocks))
	return strPtr(`{"creator":"` + jsonEscape(creator) + `","sold":"` + bigStr(res.Sold) +
		`","gross":"` + bigStr(res.Gross) + `","tax":"` + bigStr(res.Tax) +
		`","net":"` + bigStr(res.Net) + `","taxBps":` + u64s(res.TaxBps) + `}`)
}

// Payload: {"creator":"<hive-account>","holder":"<hive-account>"}.
// PERMISSIONLESS PUSH (API.md rule 2's one exception): `caller` may be
// ANYONE — a keeper walking every holder at wind-down, or any third party —
// and core.RefundHolder structurally cannot pay anyone but `holder`: `caller`
// never participates in any key core.RefundHolder reads or writes. This
// wrapper mirrors that guarantee at the transfer site: the HiveTransfer below
// pays sdk.Address(holder), NEVER sdk.Address(caller). This is what lets our
// keeper refund everyone at wind-down while remaining a pure optimisation —
// if the keeper never runs, anyone (including the holder themselves via
// `refund`) can still trigger it. MONEY OUT: CEI, same ordering as `refund`.
//
// PHASE, corrected 2026-07-21 (this comment used to say "callable in every
// phase"): core.RefundHolder is gated to FROZEN/CLOSED — the H3 fix, which
// stopped a stranger force-liquidating a live position — and under the
// curve that gate now coincides with the wind-down rail routing `refund`
// itself takes. It consults no pause state. It carries a SECOND gate
// (EXITTAX-1/NOTICE-1, 2026-07-22): core.RefundHolder refuses while the
// pushed holder's K2 exit tax is still nonzero, so this permissionless push
// can only ever sweep a fully-aged (0-tax) holder — never crystallize a
// fresh holder's tax to the treasury against their will. A still-taxed
// holder exits by their own `refund` pull; that ErrState is surfaced here.
//
//go:wasmexport refundHolder
func RefundHolder(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	if err := requireActiveAuth(caller); err != nil {
		handleErr(err)
		return nil
	}
	block := currentBlock()

	creator := jsonStr(payload, "creator")
	holder := jsonStr(payload, "holder")

	creditsBurned := core.BalanceOf(store, creator, holder) // pre-read: RefundHolder burns the WHOLE balance and returns only the payout
	maturedBefore := core.MaturedOf(store, creator, holder)
	payout, err := core.RefundHolder(store, caller, creator, holder, block) // state mutated FIRST
	if err != nil {
		handleErr(err)
		return nil
	}
	if payout != nil && payout.Sign() > 0 {
		// M6: reject a malformed holder before paying into a dead key —
		// the burn above already happened in core's state, but a rejection
		// here reverts the WHOLE transaction (handleErr -> sdk.Revert),
		// rolling that burn back too, so nothing is stranded.
		if !isPayableAddress(holder) {
			handleErr(inputErr("invalid holder address"))
			return nil
		}
		sdk.HiveTransfer(sdk.Address(holder), nativeInt64(payout), sdk.AssetHbd) // THEN pay the HOLDER, never caller
	}
	// ★ GATE ON THE BURN, NOT THE PAYOUT (Phase-0 model, 2026-07-30). The gate
	// used to read `payout > 0`, to stop anyone spamming the audit log with a
	// documented (0, nil) no-op. But the payout is a FLOORED pro-rata slice, so
	// a dust holder yields net = 0 while `debitPosition` has ALREADY burned
	// their whole position and decremented supply. On that path the old gate
	// emitted nothing at all: the tokens were gone and no event said so, so
	// lumen_ct_balances — which is the wind-down keeper's own holder-discovery
	// source — kept that holder forever and the keeper retried them on every
	// sweep.
	//
	// creditsBurned is the honest trigger: these events describe TOKEN
	// movement, which happened whether or not any HBD did. The original
	// anti-spam intent is preserved, because a true no-op burns nothing.
	if creditsBurned != nil && creditsBurned.Sign() > 0 {
		emitMaturedDelta(creator, holder, caller, block, maturedBefore)
		sdk.Log(core.EvRefundPushed(creator, caller, holder, block, creditsBurned, payout))
	}
	return strPtr(`{"creator":"` + jsonEscape(creator) + `","holder":"` + jsonEscape(holder) + `","payoutHbd":"` + bigStr(payout) + `"}`)
}

// Payload: {"creator":"<hive-account>"}. Fully permissionless at the core
// level — core.CloseIfDrained takes no caller at all. Idempotent (returns
// true whenever the market ends up CLOSED, whether just now or already
// was), so a keeper can sweep every market on every block without tracking
// which ones it already flipped. No error return by core contract (bool,
// not error) and no money movement — this only flips a state flag once
// FROZEN + supply==0. Still active-auth gated (C1) at this wrapper layer
// like every other state-changing entrypoint, even though core itself
// needs no caller identity at all — "permissionless" governs WHO may call
// it, not WHAT authority tier a poster-key-only tx is allowed to exercise.
//
//go:wasmexport closeIfDrained
func CloseIfDrained(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	if err := requireActiveAuth(caller); err != nil {
		handleErr(err)
		return nil
	}
	block := currentBlock()

	creator := jsonStr(payload, "creator")
	closed := core.CloseIfDrained(store, creator, block)

	// Gated on the returned bool: this entrypoint is fully permissionless
	// (core.CloseIfDrained takes no caller at all), so an unconditional log
	// here would let anyone call it against a healthy ACTIVE market — a
	// no-op on core's own state — and still emit a "closed" event.
	// magi-indexer/creator_tokens_views.yaml folds "closed" as a one-way, idempotent set with no
	// way to unset it (KindClosed: "m.closed = true // idempotent set"), so
	// that single spurious event would permanently poison the indexer's
	// replayed view of an otherwise-live market. core.CloseIfDrained is
	// documented idempotent (true on the transition AND on every subsequent
	// call against an already-closed market), so gating on `closed` here
	// loses nothing: a genuine repeat close still logs (harmlessly
	// idempotent on the indexer's side, per index.go's own doc), only a
	// call that changed nothing stays silent.
	if closed {
		sdk.Log(core.EvClosed(creator, caller, block))
	}
	return strPtr(`{"creator":"` + jsonEscape(creator) + `","closed":` + boolStr(closed) + `}`)
}

// Payload: {"amount":"<decimal big.Int HBD string>"}. C2 defect fix
// (PRUNED-ADJUDICATION-2026-07-21): kTreasury (Register's registration fee,
// Renew's subscription fee, Ask/Answer's commission leg) had NO exit
// anywhere in the delivered system — 100% of protocol revenue was
// permanently locked. core.WithdrawTreasury is owner-gated internally
// (caller != core.Owner(s) is refused) and bounded to (0, current treasury
// balance] — this wrapper's only job is the active-auth gate (C1), input
// parsing, and the actual HBD payout. No path to any market's reserve
// exists here or in core — this touches kTreasury alone (I4).
//
// MONEY OUT: state mutated FIRST (core.WithdrawTreasury debits kTreasury
// and returns the amount it actually debited), THEN sdk.HiveTransfer pays
// it out — CEI ordering, the same pattern every other HBD-out entrypoint in
// this file uses. Deliberately pays the RETURNED amount, not the raw
// payload `amount` local, mirroring every other entrypoint's convention of
// trusting the core call's own result over the caller-supplied input it was
// derived from (core.WithdrawTreasury's own doc: "Debits kTreasury by
// exactly `amount` and returns it" — identical by construction today, but
// this is the same defensive discipline reclaim/refund/refundHolder already
// apply to their own payouts).
//
//go:wasmexport withdrawTreasury
func WithdrawTreasury(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	if err := requireActiveAuth(caller); err != nil {
		handleErr(err)
		return nil
	}
	block := currentBlock()

	amount, ok := parseBigDecimal(jsonStr(payload, "amount"))
	if !ok {
		handleErr(inputErr("invalid amount"))
		return nil
	}

	paid, err := core.WithdrawTreasury(store, caller, amount) // state mutated FIRST (owner check is inside core)
	if err != nil {
		handleErr(err)
		return nil
	}
	sdk.HiveTransfer(sdk.Address(caller), nativeInt64(paid), sdk.AssetHbd) // THEN pay the owner
	// GAP CLOSED (2026-07-28): hand-built sdk.Log replaced by
	// core.EvTreasuryWithdrawn (core/events.go), pinned by
	// TestSchemaContract_TreasuryWithdrawn. Emitted JSON is byte-identical to
	// the line it replaces. magi-indexer/creator_tokens_mappings.yaml+index.go already recognize this
	// exact shape (KindTreasuryWithdrawn, TreasuryWithdrawnEvent, folded as a
	// SUBTRACTION from treasuryHbd — that half of this gap was fixed on the
	// indexer side already) — the only piece missing was a typed constructor
	// on this side to pin against, which this closes. That file's own
	// KindTreasuryWithdrawn doc comment ("NOT one of core/events.go's Ev*
	// constructors") is now STALE and outside this fix's ownership to correct.
	sdk.Log(core.EvTreasuryWithdrawn(caller, block, paid))
	return strPtr(`{"owner":"` + jsonEscape(caller) + `","amount":"` + bigStr(paid) + `"}`)
}

// Payload: {} (no fields) — the caller claims their OWN accrued trade-fee
// balance. OUTFLOW-1 FIX (FIX ROUND 1, 2026-07-22): core.ClaimTradeFees — the
// creator's 5% pull-claimable half of every trade fee (tradefee.go, RULING F8)
// — had NO wasm entrypoint anywhere in this contract and was invoked nowhere
// else in the repo, so every unit of creator trade-fee revenue that accrues to
// kFeeBal the instant Sell ships (Wave D) would have been STRUCTURALLY
// unclaimable: not a RULING-G revert-on-reject (which has an error to catch and
// a phase to wait out) but a total fund LOCK with no invocable path out at all.
// This wires the pull, mirroring withdrawTreasury's CEI shape exactly, so it
// can never again be forgotten when buy/sell land. It is DISTINCT from — and
// not covered by — the disclosed "missing buy/sell entrypoints"
// Wave-D item (see the sell/quote block below).
//
// PURE OUTFLOW: core.ClaimTradeFees consults NO pause, NO phase, NO
// market-existence gate (tradefee.go's own doc: earned money must never be
// frozen by a billing state or an admin switch), so this wrapper — like
// withdrawTreasury/refund/refundHolder — only active-auth gates (C1) and pays.
// A caller with nothing accrued gets (0, nil): state untouched, the transfer
// skipped, exactly the zero-payout convention refund/refundHolder already use.
//
// MONEY OUT: state mutated FIRST (core.ClaimTradeFees zeroes kFeeBal(caller)
// and returns the amount it debited), THEN sdk.HiveTransfer pays it out — the
// same CEI ordering every HBD-out entrypoint in this file uses. Pays the
// RETURNED amount, never a caller-supplied figure (there is none to supply).
//
//go:wasmexport claimTradeFees
func ClaimTradeFees(a *string) *string {
	caller := currentCaller()
	if err := requireActiveAuth(caller); err != nil {
		handleErr(err)
		return nil
	}
	block := currentBlock()

	paid, err := core.ClaimTradeFees(store, caller) // state mutated FIRST (zeroes kFeeBal, returns the debited amount)
	if err != nil {
		handleErr(err)
		return nil
	}
	if paid != nil && paid.Sign() > 0 {
		sdk.HiveTransfer(sdk.Address(caller), nativeInt64(paid), sdk.AssetHbd) // THEN pay the creator their claimed fees
		// GAP CLOSED (2026-07-28): hand-built sdk.Log replaced by
		// core.EvTradeFeesClaimed (core/events.go), pinned by
		// TestSchemaContract_TradeFeesClaimed. Emitted JSON is byte-identical to
		// the line it replaces. magi-indexer/creator_tokens_mappings.yaml+index.go already recognize
		// this exact shape (KindTradeFeesClaimed, TradeFeesClaimedEvent,
		// audit-only fold that deliberately never touches ix.treasuryHbd — that
		// half of this gap was fixed on the indexer side already) — the only
		// piece missing was a typed constructor on this side to pin against,
		// which this closes. That file's own KindTradeFeesClaimed doc is
		// unaffected (it never claimed core had a constructor).
		sdk.Log(core.EvTradeFeesClaimed(caller, block, paid))
	}
	return strPtr(`{"account":"` + jsonEscape(caller) + `","amount":"` + bigStr(paid) + `"}`)
}

// Payload: {"creator":"<hive-account>"}. M2 defect fix
// (PRUNED-ADJUDICATION-2026-07-21): Renew is deliberately permissionless (a
// fan can keep a creator alive), which lets a hostile stranger grief a
// creator's own wind-down by renewing indefinitely and blocking the normal
// OVERDUE->FROZEN ladder. Retire is the creator's own counter-move.
//
// DEFECT 1 FIX (2026-07-21): core.Retire now sets a forced-freeze MARKER that
// drives Phase() straight to FROZEN immediately and irreversibly, instead of
// the original "lower kPaidUntil to `block`" — which for an already-lapsed
// (OVERDUE/FROZEN) market RAISED paidUntil and flipped it back to ACTIVE, both
// un-freezing a creator's own wind-down and opening a permanent
// subscription-dodge. It remains a pure billing-state override: no fee, no
// fund movement, and paidUntil is left untouched. Creator-only (core.Retire
// enforces caller==creator internally via requireOpenCreatorMarket, the same
// guard SetFace/SetCap use), so `creator` is read from the payload exactly
// like renew/reclaim/decline (legitimate payload data, not an identity claim)
// rather than always being caller: a caller who is not the named creator
// simply gets core's own creator-only AUTH rejection.
//
// No SDK money call at all: Retire moves no funds in either direction.
//
//go:wasmexport retire
func Retire(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	if err := requireActiveAuth(caller); err != nil {
		handleErr(err)
		return nil
	}
	block := currentBlock()

	creator := jsonStr(payload, "creator")

	if err := core.Retire(store, caller, creator, block); err != nil {
		handleErr(err)
		return nil
	}
	// GAP CLOSED (2026-07-28): hand-built sdk.Log replaced by core.EvRetired
	// (core/events.go), pinned by TestSchemaContract_Retired. Emitted JSON is
	// byte-identical to the line it replaces, so magi-indexer/creator_tokens_mappings.yaml's
	// KindRetired decode (RetiredEvent{Creator,Actor,Block}) is unaffected —
	// though that file's own KindRetired doc comment ("NOT one of
	// core/events.go's Ev* constructors ... there is no EvRetired to
	// exercise") is now STALE and outside this fix's ownership to correct
	// (indexer/** is not touched here); flagged for whoever owns that file
	// next.
	sdk.Log(core.EvRetired(creator, caller, block))
	return strPtr(`{"creator":"` + jsonEscape(creator) + `"}`)
}

// Payload: {"creator":"<hive-account>"}. READ-ONLY (writes no state) — lets a
// frontend display the current ask cost BEFORE the asker signs anything.
// Returns the settlement the real `ask` would derive RIGHT NOW via the SAME
// exported core function (core.SettleSpend, settlement.go): the rate
// min(TWAP_short, TWAP_long, spot) and the exact creditsPerAsk, or the SAME
// typed refusal `ask` itself would hit (RULING C, 2026-07-21: the PAR
// fallback is DELETED — settlement REFUSES when no safe rate exists, and a
// preview that pretended otherwise would invite the asker to sign a doomed
// or mispriced transaction). This preview is exactly as strict as the real
// call — shared code, not a wrapper copy, so it can never drift.
//
// WHAT THE PREVIOUS VERSION DID AND WHY IT CHANGED: it called the old
// core.SettlementRate (TWAP-or-PAR, no error path) and duplicated the
// credits math via a local ceilDiv — both halves are gone: PAR settled a
// MinFace service at a 100x overcharge on a live path (settlement.go's
// autopsy), and the ceilDiv duplicate is replaced by core.SettleSpend's
// exported quote so the preview shares core's real derivation, the same
// de-duplication DEFECT 5 did for the commission formula.
//
// A frontend should feed creditsPerAsk straight back in as `ask`'s own
// `maxCredits` (perhaps with a small, explicit slippage margin the asker
// chooses) — see core.Ask's doc for why that cap exists.
//
//go:wasmexport quote
func Quote(a *string) *string {
	payload := payloadStr(a)
	block := currentBlock()

	creator := jsonStr(payload, "creator")

	// DEFECT 3 FIX (2026-07-21): also return the market's current Phase and an
	// inflowsOpen boolean. Without this, quote previewed an actionable "ask
	// will cost X" for a market where the real `ask` would revert at
	// core.Ask's RequireInflowOpen gate — a client had no signal to disable
	// the ask action.
	//
	// inflowsOpen ASKS THE GATE ITSELF rather than re-deriving from Phase
	// (fixed 2026-07-27 after a code review caught the drift). The old version
	// mirrored "ACTIVE or OVERDUE", which was a complete enumeration of that
	// gate's conditions when it was written and stopped being one the moment
	// the delivery gate was added: a delinquent creator's quote reported
	// inflows OPEN, so a buyer keyed their button off it, signed, and the ask
	// reverted. Delegating means this flag cannot fall behind the gate again —
	// the pause switch and the retire mark are covered for free by the same
	// change.
	phase := core.Phase(store, creator, block)
	inflowsOpen := core.RequireInflowOpen(store, creator, block) == nil

	// Same offeringId convention as `ask` — a quote must preview the price the
	// real ask will bind, for the id the client is about to sign against.
	// PRESENT-BUT-UNPARSEABLE is refused rather than defaulted (parse.U64Field,
	// 2026-07-27): 0 names the legacy face price, so silently falling back to
	// it would settle against the WRONG, cheaper service and underpay the
	// creator, with nothing in the receipt to show why. `quote` refuses it too
	// — a preview that answers a malformed id with a price is worse than the
	// refusal the ask itself will give.
	offeringID, idOK := jsonU64Field(payload, "offeringId")
	if !idOK {
		handleErr(inputErr("offeringId must be an unquoted non-negative integer"))
		return nil
	}
	face := readPrice(creator, offeringID)
	if face.Sign() <= 0 {
		if offeringID == 0 {
			handleErr(stateErr("creator has no face price set"))
		} else {
			handleErr(notFoundErr("no such offering"))
		}
		return nil
	}

	// RULING C: the settlement derivation `ask` itself uses — refusal
	// included. A refused quote is the correct preview of a refused ask.
	q, err := core.SettleSpend(store, creator, block, face)
	if err != nil {
		handleErr(err)
		return nil
	}

	// The commission comes off the SAME quote as the credits (settlePosted,
	// settlement.go) rather than being recomputed here: the two legs a buyer
	// pays must always be the two halves of ONE split of ONE posted face, or a
	// preview can quote a total the settlement will not charge. Identical value
	// to core.CommissionOwedFor(face) today — this makes it identical by
	// construction rather than by coincidence.
	commissionOwed := q.CommissionHbd

	return strPtr(`{"creator":"` + jsonEscape(creator) + `","rate":"` + q.Rate.String() + `","face":"` + face.String() + `","creditsPerAsk":"` + q.Credits.String() + `","commissionOwedHbd":"` + commissionOwed.String() + `","phase":"` + jsonEscape(phase) + `","inflowsOpen":` + boolStr(inflowsOpen) + `}`)
}

// Payload: {"creator":"<hive-account>","tokens":"<decimal big.Int token
// amount>"}. READ-ONLY buy preview (WAVE D) — lets a frontend show the exact
// HBD a Buy would cost BEFORE the buyer signs (RULING F: the quote is
// mandatory UI). Shares core.QuoteBuy's buyCompute with Buy itself, so the
// preview can never drift from execution: returns the curve cost, the trade
// fee, TotalDue (== the HiveDraw the buyer approves via transfer.allow), the
// tokens minted, and the post-trade marginal rate. Applies the SAME inflow
// guard Buy does, so a FROZEN/CLOSED/paused market yields the same typed
// refusal rather than a quote for a doomed transaction. No auth (pure read,
// zero writes), mirroring the ask `quote` entrypoint above.
//
//go:wasmexport quoteBuy
func QuoteBuy(a *string) *string {
	payload := payloadStr(a)
	block := currentBlock()

	creator := jsonStr(payload, "creator")
	tokens, ok := parseBigDecimal(jsonStr(payload, "tokens"))
	if !ok {
		handleErr(inputErr("invalid tokens"))
		return nil
	}

	res, err := core.QuoteBuy(store, creator, block, tokens)
	if err != nil {
		handleErr(err)
		return nil
	}
	return strPtr(`{"creator":"` + jsonEscape(creator) + `","minted":"` + bigStr(res.Minted) +
		`","cost":"` + bigStr(res.Cost) + `","fee":"` + bigStr(res.Fee) +
		`","totalDue":"` + bigStr(res.TotalDue) + `","rateAfter":"` + bigStr(res.RateRecorded) + `"}`)
}

// Payload: {"creator":"<hive-account>","tokens":"<decimal big.Int token
// amount>","holder":"<hive-account>"}. READ-ONLY sell preview (WAVE D). The
// exit tax is the HOLDER's own hold-clock rate, so the holder to preview is a
// PAYLOAD field — this keeps it a pure read (no caller/auth, mirroring the
// caller-independent ask `quote`); the real `sell` still requires that
// holder's own active auth. Shares core.QuoteSell's sellCompute with Sell, so
// it can never drift: returns gross (the curve slice), the exit tax to the
// treasury, the trade fee, Net (== the HBD the seller receives — the number
// they feed back as `sell`'s minNet floor), and the taxBps/heldBlocks that
// produced it (so the UI can show WHY the tax is what it is). Same guards as
// Sell, so an over-balance or nonexistent-market preview is the same refusal.
//
//go:wasmexport quoteSell
func QuoteSell(a *string) *string {
	payload := payloadStr(a)
	block := currentBlock()

	creator := jsonStr(payload, "creator")
	holder := jsonStr(payload, "holder")
	tokens, ok := parseBigDecimal(jsonStr(payload, "tokens"))
	if !ok {
		handleErr(inputErr("invalid tokens"))
		return nil
	}

	res, err := core.QuoteSell(store, holder, creator, block, tokens)
	if err != nil {
		handleErr(err)
		return nil
	}
	return strPtr(`{"creator":"` + jsonEscape(creator) + `","holder":"` + jsonEscape(holder) +
		`","sold":"` + bigStr(res.Sold) + `","gross":"` + bigStr(res.Gross) +
		`","tax":"` + bigStr(res.Tax) + `","fee":"` + bigStr(res.Fee) +
		`","net":"` + bigStr(res.Net) + `","taxBps":` + u64s(res.TaxBps) +
		`,"heldBlocks":` + u64s(res.HeldBlocks) + `}`)
}

// ===================================
// Offering catalogue (2026-07-27) — the creator's shop
// ===================================
//
// Four writes + one read wiring core/offerings.go: a creator posts up to
// MaxOfferings named services, each with its own HBD price under its own 2x/7d
// anti-rug band, and a buyer asks against one of them (`ask`'s offeringId).
//
// ALL FOUR ARE ACTIVE-AUTH GATED (C1), exactly like setFace/setCap and for the
// same reason: a posting key is delegated to every dApp a creator ever logs
// into, and repricing someone's services IS a value operation even though no
// HBD moves in the call. An attacker holding a posting key who could set a
// service to MaxFace would extract the difference from the creator's own
// buyers on the very next ask.
//
// NONE of them gate on pause/phase beyond requireOpenCreatorMarket's
// exists-and-not-CLOSED check (enforced inside core): posting a price moves no
// funds, and the standing guardrail is that billing state never gates anything.
// The ask AGAINST an offering is the inflow, and it is already behind
// RequireInflowOpen in core.Ask.

// Payload: {"title":"<string>","price":<uint64 HBD base units>}. Creates a new
// offering and returns its id.
//
//go:wasmexport createOffering
func CreateOffering(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	if err := requireActiveAuth(caller); err != nil {
		handleErr(err)
		return nil
	}
	block := currentBlock()

	title := jsonStr(payload, "title")
	price, ok := i64FromU64(jsonU64(payload, "price"))
	if !ok {
		handleErr(inputErr("price overflows int64"))
		return nil
	}

	id, err := core.CreateOffering(store, caller, caller, block, title, price)
	if err != nil {
		handleErr(err)
		return nil
	}
	sdk.Log(core.EvOfferingCreated(caller, caller, block, id, title, core.OfferingPrice(store, caller, id)))
	return strPtr(`{"creator":"` + jsonEscape(caller) + `","offeringId":` + u64s(id) +
		`,"title":"` + jsonEscape(title) + `","price":` + i64s(price) + `}`)
}

// Payload: {"offeringId":<uint64>,"newPrice":<uint64 HBD base units>}. Reprices
// one offering under its own 2x/7d band.
//
//go:wasmexport setOfferingPrice
func SetOfferingPrice(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	if err := requireActiveAuth(caller); err != nil {
		handleErr(err)
		return nil
	}
	block := currentBlock()

	// jsonU64Field, not jsonU64 (2026-07-28): 0 is a MEANINGFUL offeringId —
	// it is the reserved alias for the legacy `face` price — so a malformed
	// or missing value silently defaulting to 0 is the same 0-is-meaningful
	// hazard that was closed on ask/quote/answer/decline/reclaim. It fails
	// CLOSED here today (0 hits "no such offering"), so this is consistency
	// and an honest error message rather than a live defect — but leaving
	// three sites on the loose parser is how the next one stops failing
	// closed without anyone noticing.
	id, idOK := jsonU64Field(payload, "offeringId")
	if !idOK {
		handleErr(inputErr("offeringId must be an unquoted non-negative integer"))
		return nil
	}
	newPrice, ok := i64FromU64(jsonU64(payload, "newPrice"))
	if !ok {
		handleErr(inputErr("newPrice overflows int64"))
		return nil
	}

	// Pre-read for the event, same requirement as setFace's oldFace: core
	// returns only an error, so the previous value has to be captured here.
	oldPrice := core.OfferingPrice(store, caller, id)
	if err := core.SetOfferingPrice(store, caller, caller, block, id, newPrice); err != nil {
		handleErr(err)
		return nil
	}
	sdk.Log(core.EvOfferingUpdated(caller, caller, block, id, core.OfferingTitle(store, caller, id), oldPrice, core.OfferingPrice(store, caller, id)))
	return strPtr(`{"creator":"` + jsonEscape(caller) + `","offeringId":` + u64s(id) + `,"price":` + i64s(newPrice) + `}`)
}

// Payload: {"offeringId":<uint64>,"title":"<string>"}. Relabels an offering.
// Deliberately does NOT touch the price or its band window — renaming a service
// is not a repricing and must neither earn band headroom nor spend it.
//
//go:wasmexport setOfferingTitle
func SetOfferingTitle(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	if err := requireActiveAuth(caller); err != nil {
		handleErr(err)
		return nil
	}
	block := currentBlock()

	// jsonU64Field, not jsonU64 (2026-07-28): 0 is a MEANINGFUL offeringId —
	// it is the reserved alias for the legacy `face` price — so a malformed
	// or missing value silently defaulting to 0 is the same 0-is-meaningful
	// hazard that was closed on ask/quote/answer/decline/reclaim. It fails
	// CLOSED here today (0 hits "no such offering"), so this is consistency
	// and an honest error message rather than a live defect — but leaving
	// three sites on the loose parser is how the next one stops failing
	// closed without anyone noticing.
	id, idOK := jsonU64Field(payload, "offeringId")
	if !idOK {
		handleErr(inputErr("offeringId must be an unquoted non-negative integer"))
		return nil
	}
	title := jsonStr(payload, "title")

	if err := core.SetOfferingTitle(store, caller, caller, id, title); err != nil {
		handleErr(err)
		return nil
	}
	price := core.OfferingPrice(store, caller, id)
	sdk.Log(core.EvOfferingUpdated(caller, caller, block, id, title, price, price))
	return strPtr(`{"creator":"` + jsonEscape(caller) + `","offeringId":` + u64s(id) + `,"title":"` + jsonEscape(title) + `"}`)
}

// Payload: {"offeringId":<uint64>}. Withdraws a service from the shop: no new
// asks against it, a freed catalogue slot, and its price and band anchors
// zeroed so a future offering can never inherit a dead one's anchor. Escrows
// already opened against this id are NOT touched — their credits, deadline and
// answer/reclaim windows are unchanged, so a creator cannot strand a buyer's
// funds by withdrawing a service after being paid for it.
//
//go:wasmexport deleteOffering
func DeleteOffering(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	if err := requireActiveAuth(caller); err != nil {
		handleErr(err)
		return nil
	}
	block := currentBlock()

	// jsonU64Field, not jsonU64 (2026-07-28): 0 is a MEANINGFUL offeringId —
	// it is the reserved alias for the legacy `face` price — so a malformed
	// or missing value silently defaulting to 0 is the same 0-is-meaningful
	// hazard that was closed on ask/quote/answer/decline/reclaim. It fails
	// CLOSED here today (0 hits "no such offering"), so this is consistency
	// and an honest error message rather than a live defect — but leaving
	// three sites on the loose parser is how the next one stops failing
	// closed without anyone noticing.
	id, idOK := jsonU64Field(payload, "offeringId")
	if !idOK {
		handleErr(inputErr("offeringId must be an unquoted non-negative integer"))
		return nil
	}
	if err := core.DeleteOffering(store, caller, caller, id); err != nil {
		handleErr(err)
		return nil
	}
	sdk.Log(core.EvOfferingDeleted(caller, caller, block, id))
	return strPtr(`{"creator":"` + jsonEscape(caller) + `","offeringId":` + u64s(id) + `}`)
}

// Payload: {"creator":"<account>"}. PURE READ — returns the creator's live
// shop. Bounded by MaxOfferings, so this is a single bounded list read and
// never a scan of the id space.
//
//go:wasmexport listOfferings
func ListOfferings(a *string) *string {
	payload := payloadStr(a)
	creator := jsonStr(payload, "creator")

	out := `{"creator":"` + jsonEscape(creator) + `","offerings":[`
	for i, o := range core.ListOfferings(store, creator) {
		if i > 0 {
			out += ","
		}
		out += `{"offeringId":` + u64s(o.ID) +
			`,"title":"` + jsonEscape(o.Title) + `"` +
			`,"price":"` + o.PriceHbd.String() + `"}`
	}
	return strPtr(out + `]}`)
}
