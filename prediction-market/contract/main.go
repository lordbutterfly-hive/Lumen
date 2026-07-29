// Hive Price Weekly Market — thin VSC/TinyGo wasm wrapper.
//
// All fund-critical logic (state machine, payout math, invariants) lives in
// the pure-Go `market` package (../market/*.go) and is NOT touched here. This
// file's only jobs are: read the VSC SDK env (caller/block/oracle), parse the
// flat-JSON action payload, call into `market`, and move real HIVE/HBD via
// sdk.HiveDraw/HiveTransfer around it.
//
// Build (Docker, tinygo not installed locally):
//
//	docker run --rm -v "/mnt/o/HIVE-PRICE-MARKET":/work -w /work tinygo/tinygo:0.39.0 \
//	    tinygo build -gc=custom -scheduler=none -panic=trap -no-debug -target=wasm-unknown \
//	    -o bin/main.wasm ./contract
//
// Error convention: a *market.Err (typed, symbol-tagged) is surfaced via
// sdk.Revert(err.Msg, err.Symbol) so callers/wallets can branch on the symbol
// (AUTH/INPUT/STATE/ARITH/BALANCE/PAUSED/NOT_FOUND/ORACLE, see
// ../market/errors.go). Any other error, and every wasm-layer-detected input
// problem this wrapper itself constructs as a *market.Err (see inputErr/
// authErr/notFoundErr below), goes through the same path for a single
// consistent error surface. A narrowing overflow at the *big.Int->int64 SDK
// boundary (nativeInt64) is the one case that Aborts directly, matching the
// magi-market nativeAmountInt64 precedent exactly.
package main

import (
	"math/big"
	"strconv"
	"strings"

	"hive-price-market/market"
	"hive-price-market/sdk"
)

func main() {}

// ===================================
// market.Store adapter
// ===================================

// sdkStore adapts the VSC SDK's per-contract state
// (StateGetObject/StateSetObject/StateDeleteObject) to the market.Store
// interface the pure core operates on. No caching, no batching — every
// Get/Set/Delete is a direct host call. A missing key and a key explicitly
// set to "" both read back as ("", false)/("", true) respectively, which
// matches how market/util.go's typed accessors already treat "" as the
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

// handleErr maps a market-layer error to the wasm host. Every call site MUST
// treat this as terminal (`handleErr(err); return nil`) — sdk.Abort halts via
// its own trailing panic() (fatal under -panic=trap), but sdk.Revert does NOT
// panic internally, so falling through after it would keep executing wrapper
// code on top of a reverted-but-still-live Go call stack. The explicit
// `return nil` after every call site is the defense against that.
func handleErr(err error) {
	if merr, ok := err.(*market.Err); ok {
		sdk.Revert(merr.Msg, merr.Symbol)
		return
	}
	sdk.Abort(err.Error())
}

func inputErr(msg string) *market.Err    { return &market.Err{Symbol: market.ErrInput, Msg: msg} }
func authErr(msg string) *market.Err     { return &market.Err{Symbol: market.ErrAuth, Msg: msg} }
func notFoundErr(msg string) *market.Err { return &market.Err{Symbol: market.ErrNotFound, Msg: msg} }

// nativeInt64 narrows a *big.Int to int64 for the native HiveDraw/HiveTransfer
// SDK calls (which take int64, not *big.Int). Mirrors magi-market's
// nativeAmountInt64 pattern exactly (contract/internal.go): abort — not
// revert — on overflow, since an amount that doesn't fit int64 is an
// encoding/usage error at the SDK boundary, not a recoverable business
// rejection.
func nativeInt64(v *big.Int) int64 {
	if v == nil {
		return 0
	}
	if !v.IsInt64() {
		sdk.Abort("native amount overflows int64")
	}
	return v.Int64()
}

// maxIntNarrow bounds any uint64 payload field that gets cast to Go `int`
// (only "outcome" below) so the cast is unambiguous on BOTH 64-bit hosts and
// TinyGo's 32-bit wasm `int`. Without this, an absurd outcome value could
// truncate on the 32-bit target into a small in-range index — market.RecordBet
// re-validates outcome<roundN regardless, so this isn't independently
// exploitable (real outcome indices are always tiny), but it's the same class
// of Go-encoding trap the codebase explicitly guards against elsewhere.
const maxIntNarrow = 1<<31 - 1

// ===================================
// Env helpers
// ===================================

func currentCaller() string {
	return string(sdk.GetEnv().Caller)
}

func currentBlock() uint64 {
	h := sdk.GetEnvKey("block.height")
	if h == nil || *h == "" {
		return 0
	}
	n, err := strconv.ParseUint(*h, 10, 64)
	if err != nil {
		return 0
	}
	return n
}

func envU64(key string) uint64 {
	v := sdk.GetEnvKey(key)
	if v == nil || *v == "" {
		return 0
	}
	n, err := strconv.ParseUint(*v, 10, 64)
	if err != nil {
		return 0
	}
	return n
}

func envBool(key string) bool {
	v := sdk.GetEnvKey(key)
	return v != nil && *v == "true"
}

// roundAsset reads a round's immutable configured asset directly from state
// using market's own key format (rd|<id>|asset — see market/keys.go:rk and
// BUILD-MAP.md §4). market.RecordBet takes NO asset parameter (betting is
// asset-agnostic bookkeeping by design in the core), so this is the only
// place BUILD-MAP §2/§7-inv.4's single-asset-per-round invariant can be
// enforced. Returns "" if the round doesn't exist (state+asset are always
// set together atomically in market.CreateRound, so this doubles as an
// existence check). COUPLING WARNING: this duplicates market/keys.go's rk()
// format outside the package; keep in sync if that format ever changes.
func roundAsset(id uint64) string {
	v := sdk.StateGetObject("rd|" + strconv.FormatUint(id, 10) + "|asset")
	if v == nil {
		return ""
	}
	return *v
}

// ===================================
// Minimal flat-JSON payload reader (TinyGo-safe, no encoding/json/reflection)
// ===================================
//
// Every action below documents its exact payload shape. These readers assume
// a single flat JSON object (no nesting) and scan for the FIRST occurrence of
// `"key":`, so a value elsewhere in the payload that happens to contain that
// exact substring could in principle mis-locate a field — not a concern for
// the fixed, narrow payload shapes used here, and every field read only ever
// affects the CALLER'S OWN transaction (their own bet/amount/asset choice),
// never another account's funds or state. Not a general-purpose JSON parser.

func payloadStr(a *string) string {
	if a == nil {
		return ""
	}
	return *a
}

func isJSONSpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r'
}

// findKey returns the index just after the colon following `"key":` in a flat
// JSON object, or -1 if not found.
func findKey(payload, key string) int {
	pat := "\"" + key + "\""
	idx := strings.Index(payload, pat)
	if idx < 0 {
		return -1
	}
	i := idx + len(pat)
	for i < len(payload) && isJSONSpace(payload[i]) {
		i++
	}
	if i >= len(payload) || payload[i] != ':' {
		return -1
	}
	return i + 1
}

// jsonStr extracts a quoted string field's raw contents. No backslash-escape
// decoding is performed beyond skipping past an escaped character while
// scanning for the closing quote (sufficient for the plain address/asset-name
// strings used in every payload here; none contain embedded quotes in
// practice). Missing/malformed ⇒ "".
func jsonStr(payload, key string) string {
	i := findKey(payload, key)
	if i < 0 {
		return ""
	}
	for i < len(payload) && isJSONSpace(payload[i]) {
		i++
	}
	if i >= len(payload) || payload[i] != '"' {
		return ""
	}
	i++
	start := i
	for i < len(payload) && payload[i] != '"' {
		if payload[i] == '\\' && i+1 < len(payload) {
			i++
		}
		i++
	}
	if i > len(payload) {
		return ""
	}
	return payload[start:i]
}

// jsonU64 extracts an unquoted decimal integer field's value. Missing,
// malformed, or negative (a leading '-' simply fails to match any digit)
// defaults to 0 — every caller below either lets the market core reject the
// resulting zero value through its own validation, or (for "outcome") is
// separately bounds-checked at the narrowing boundary.
func jsonU64(payload, key string) uint64 {
	i := findKey(payload, key)
	if i < 0 {
		return 0
	}
	for i < len(payload) && isJSONSpace(payload[i]) {
		i++
	}
	start := i
	for i < len(payload) && payload[i] >= '0' && payload[i] <= '9' {
		i++
	}
	if i == start {
		return 0
	}
	n, err := strconv.ParseUint(payload[start:i], 10, 64)
	if err != nil {
		return 0
	}
	return n
}

// jsonStrU64Array extracts a flat JSON array of unquoted decimal integers,
// e.g. "strikes":[10000,12000]. No nesting, no strings inside the array,
// whitespace between tokens tolerated. Missing/malformed ⇒ nil, which
// market.CreateRound already rejects (len(Strikes)+1 outcomes out of range).
func jsonStrU64Array(payload, key string) []uint64 {
	i := findKey(payload, key)
	if i < 0 {
		return nil
	}
	for i < len(payload) && isJSONSpace(payload[i]) {
		i++
	}
	if i >= len(payload) || payload[i] != '[' {
		return nil
	}
	i++
	out := []uint64{}
	for {
		for i < len(payload) && (isJSONSpace(payload[i]) || payload[i] == ',') {
			i++
		}
		// Fail CLOSED (C5): return nil on ANY malformation so createRound rejects
		// the round rather than silently storing a TRUNCATED strikes array (a
		// signed-intent-≠-executed-effect gap). Only a clean ']' returns the slice.
		if i >= len(payload) {
			return nil // unterminated array (no closing ']')
		}
		if payload[i] == ']' {
			return out // clean terminator
		}
		start := i
		for i < len(payload) && payload[i] >= '0' && payload[i] <= '9' {
			i++
		}
		if i == start {
			return nil // a non-digit, non-']' token — malformed
		}
		n, err := strconv.ParseUint(payload[start:i], 10, 64)
		if err != nil {
			return nil // overflow / unparseable
		}
		out = append(out, n)
	}
}

// parseBigDecimal parses a base-10, non-negative big.Int money string exactly
// like market/money.go's (unexported) parseMoney. Duplicated here because
// this wrapper cannot import unexported core helpers and must not modify
// market/ — keep in sync with market.parseMoney if that ever changes.
func parseBigDecimal(s string) (*big.Int, bool) {
	if s == "" {
		return nil, false
	}
	v, ok := new(big.Int).SetString(s, 10)
	if !ok || v.Sign() < 0 {
		return nil, false
	}
	return v, true
}

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

// jsonEscape minimally escapes backslash and double-quote characters for
// embedding a value in the hand-built JSON responses below. Not a general
// JSON string escaper — sufficient for the address/asset-name strings echoed
// here.
func jsonEscape(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '"' || c == '\\' {
			b.WriteByte('\\')
		}
		b.WriteByte(c)
	}
	return b.String()
}

// ===================================
// Entrypoints
// ===================================

// Payload: {} (ignored). Caller MUST equal contract.owner (the deployer
// recorded by the VSC runtime at contract registration). market.Init itself
// trusts whatever `deployer` it's handed and only guards against a second
// call — this owner gate is entirely this wrapper's responsibility.
//
//go:wasmexport init
func Init(a *string) *string {
	caller := currentCaller()
	ownerEnv := sdk.GetEnvKey("contract.owner")
	if ownerEnv == nil || caller != *ownerEnv {
		handleErr(authErr("init: caller must be contract.owner"))
		return nil
	}
	if err := market.Init(store, caller); err != nil {
		handleErr(err)
		return nil
	}
	return strPtr(`{"owner":"` + jsonEscape(caller) + `"}`)
}

// Payload: {} (ignored). PERMISSIONLESS decentralized round opener. Reads the
// witness oracle for the reference price and derives the ±10/20/30% strikes (7
// buckets) + the
// weekly timing deterministically in-contract (market.RollRound) — anyone can
// open the next round once the previous one resolves; no operator chooses the
// strikes or timing, so there is nothing to cherry-pick. Attributed to "protocol".
//
//go:wasmexport roll
func Roll(a *string) *string {
	block := currentBlock()
	priceBps := envU64("pendulum.hive_moving_avg_bps")
	feedOK := envBool("pendulum.hive_ma_ok") && envBool("pendulum.trusted_hive_mean_ok")
	id, err := market.RollRound(store, block, priceBps, feedOK)
	if err != nil {
		handleErr(err)
		return nil
	}
	sdk.Log(`{"type":"roll","roundId":` + u64s(id) + `,"refPrice":` + u64s(priceBps) + `}`)
	return strPtr(`{"roundId":` + u64s(id) + `}`)
}

// Payload: {"roundId":<u64>,"outcome":<u64>,"amount":"<decimal big.Int
// string>","asset":"hive"|"hbd"}. Draws `amount` of the ROUND'S configured
// native asset from the caller via a transfer.allow intent (sdk.HiveDraw)
// BEFORE crediting the stake — matching the core's requirement that
// `received` passed to RecordBet is the actual amount pulled (native asset ⇒
// received == requested, no fee-on-transfer). A payload "asset" that doesn't
// match the round's stored asset is rejected: RecordBet is asset-agnostic
// bookkeeping (see market/bet.go), so this wrapper is the only place the
// single-asset-per-round invariant can be enforced — trusting payload asset
// blindly would let a caller draw one native asset while being credited (and
// later paid out) in the other, siphoning from same-asset bettors.
//
//go:wasmexport bet
func Bet(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	block := currentBlock()

	roundId := jsonU64(payload, "roundId")
	asset := roundAsset(roundId)
	if asset == "" {
		handleErr(notFoundErr("no such round"))
		return nil
	}
	if payloadAsset := jsonStr(payload, "asset"); payloadAsset != "" && payloadAsset != asset {
		handleErr(inputErr("asset does not match round"))
		return nil
	}

	outcomeU64 := jsonU64(payload, "outcome")
	if outcomeU64 > maxIntNarrow {
		handleErr(inputErr("outcome out of range"))
		return nil
	}
	outcome := int(outcomeU64)

	amount, ok := parseBigDecimal(jsonStr(payload, "amount"))
	if !ok {
		handleErr(inputErr("invalid amount"))
		return nil
	}

	sdk.HiveDraw(nativeInt64(amount), sdk.Asset(asset)) // pull FIRST
	if err := market.RecordBet(store, caller, block, roundId, outcome, amount); err != nil {
		handleErr(err)
		return nil
	}
	sdk.Log(`{"type":"bet","roundId":` + u64s(roundId) + `,"outcome":` + strconv.Itoa(outcome) + `,"acct":"` + jsonEscape(caller) + `","amount":"` + amount.String() + `"}`)
	return strPtr(`{"roundId":` + u64s(roundId) + `,"outcome":` + strconv.Itoa(outcome) + `,"received":"` + amount.String() + `"}`)
}

// Payload: {"roundId":<u64>}. Permissionless — any caller may settle once
// block >= the round's settleBlock. Reads the Pendulum witness-feed env keys
// fresh at execution time: priceBps = pendulum.hive_moving_avg_bps (the
// 15-min MA, NOT the raw tick, per BUILD-MAP §1/§8), tickHeight =
// pendulum.tick_block_height (recorded on-chain for audit), feedOK = BOTH
// pendulum.hive_ma_ok AND pendulum.trusted_hive_mean_ok — hive_ma_ok alone
// never expires on a stale/frozen ring (ORACLE-SETTLEMENT-REDTEAM-2026-07-19
// Attack 3), so trusted_hive_mean_ok (the true per-tick freshness flag) MUST
// also gate, else a sustained oracle outage silently bypasses void-on-bad-feed.
// On SETTLED with a positive keeper bounty, pays the bounty (from the fee,
// never from stakes) to the caller who settled.
//
//go:wasmexport settle
func Settle(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	block := currentBlock()
	roundId := jsonU64(payload, "roundId")

	priceBps := envU64("pendulum.hive_moving_avg_bps")
	tick := envU64("pendulum.tick_block_height")
	feedOK := envBool("pendulum.hive_ma_ok") && envBool("pendulum.trusted_hive_mean_ok")

	result, err := market.Settle(store, caller, block, roundId, priceBps, tick, feedOK)
	if err != nil {
		handleErr(err)
		return nil
	}
	if result.State == market.StateSettled && result.Bounty != nil && result.Bounty.Sign() > 0 {
		sdk.HiveTransfer(sdk.Address(caller), nativeInt64(result.Bounty), sdk.Asset(result.Asset))
	}
	// Surface the void reason (empty when SETTLED) so a user always sees WHY a
	// round resolved the way it did rather than an unexplained VOID.
	sdk.Log(`{"type":"resolved","roundId":` + u64s(roundId) + `,"state":"` + result.State + `","winner":` + strconv.Itoa(result.Winner) + `,"reason":"` + jsonEscape(result.Reason) + `"}`)
	return strPtr(`{"roundId":` + u64s(roundId) + `,"state":"` + result.State + `","winner":` + strconv.Itoa(result.Winner) + `,"bounty":"` + bigStr(result.Bounty) + `","reason":"` + jsonEscape(result.Reason) + `"}`)
}

// Payload: {} (ignored). READ-ONLY (writes no state) — echoes the live pendulum
// witness price from env so an off-chain round-creation scheduler can read the
// SAME hive_moving_avg_bps the contract will settle against, via GQL
// simulateContractCalls (no broadcast, no fee). Closes the "no way to read the
// live price to set a round's strikes" gap (B5). priceBps = HBD-per-HIVE bps
// (10000 = 1.0); feedOK = hive_ma_ok && trusted_hive_mean_ok.
//
//go:wasmexport peekPrice
func PeekPrice(a *string) *string {
	priceBps := envU64("pendulum.hive_moving_avg_bps")
	tick := envU64("pendulum.tick_block_height")
	feedOK := envBool("pendulum.hive_ma_ok") && envBool("pendulum.trusted_hive_mean_ok")
	ok := "false"
	if feedOK {
		ok = "true"
	}
	return strPtr(`{"priceBps":` + u64s(priceBps) + `,"tick":` + u64s(tick) + `,"feedOK":` + ok + `,"unit":"` + jsonEscape(market.SettleUnit) + `"}`)
}

// Payload: {"roundId":<u64>}. Permissionless liveness escape hatch: forces a
// still-OPEN round to VOID once block >= settleBlock+grace, regardless of
// feed health, so funds can never get stuck behind a persistently bad oracle
// feed. No transfer here — VOID carries no keeper bounty (only SETTLED does,
// paid from the fee, never from stakes); stakers self-claim refunds via claim.
//
//go:wasmexport voidStale
func VoidStale(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	block := currentBlock()
	roundId := jsonU64(payload, "roundId")

	result, err := market.VoidStale(store, caller, block, roundId)
	if err != nil {
		handleErr(err)
		return nil
	}
	sdk.Log(`{"type":"voided","roundId":` + u64s(roundId) + `,"reason":"` + jsonEscape(result.Reason) + `"}`)
	return strPtr(`{"roundId":` + u64s(roundId) + `,"state":"` + result.State + `","reason":"` + jsonEscape(result.Reason) + `"}`)
}

// Payload: {"roundId":<u64>}. Caller claims their entitlement for a SETTLED
// (winning-outcome share) or VOID (full stake refund) round. market.Claim
// marks the claimed flag BEFORE returning (CEI), so the HiveTransfer below
// always happens strictly after state is already updated. A zero payout
// (loser, or an account with no stake) is still a successful claim — no
// transfer, no error.
//
//go:wasmexport claim
func Claim(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	roundId := jsonU64(payload, "roundId")

	payout, asset, err := market.Claim(store, caller, roundId)
	if err != nil {
		handleErr(err)
		return nil
	}
	if payout != nil && payout.Sign() > 0 {
		sdk.HiveTransfer(sdk.Address(caller), nativeInt64(payout), sdk.Asset(asset))
	}
	sdk.Log(`{"type":"claim","roundId":` + u64s(roundId) + `,"acct":"` + jsonEscape(caller) + `","payout":"` + bigStr(payout) + `","asset":"` + jsonEscape(asset) + `"}`)
	return strPtr(`{"roundId":` + u64s(roundId) + `,"payout":"` + bigStr(payout) + `","asset":"` + jsonEscape(asset) + `"}`)
}

// Payload: {"roundId":<u64>}. FAIL-SAFE return-to-sender. If a round is stuck
// OPEN past its settle deadline (settleBlock+window+grace), ANY staker forces it
// to VOID and gets their FULL stake back in ONE call — no oracle, no keeper, no
// owner. Refuses a SETTLED round so a loser can't dodge a real loss. CEI: state
// flipped + claimed set in market.Reclaim BEFORE this HiveTransfer. Permissionless.
//
//go:wasmexport reclaim
func Reclaim(a *string) *string {
	payload := payloadStr(a)
	caller := currentCaller()
	block := currentBlock()
	roundId := jsonU64(payload, "roundId")

	refund, asset, err := market.Reclaim(store, caller, block, roundId)
	if err != nil {
		handleErr(err)
		return nil
	}
	if refund != nil && refund.Sign() > 0 {
		sdk.HiveTransfer(sdk.Address(caller), nativeInt64(refund), sdk.Asset(asset))
	}
	sdk.Log(`{"type":"reclaim","roundId":` + u64s(roundId) + `,"acct":"` + jsonEscape(caller) + `","refund":"` + bigStr(refund) + `","asset":"` + jsonEscape(asset) + `"}`)
	return strPtr(`{"roundId":` + u64s(roundId) + `,"refund":"` + bigStr(refund) + `","asset":"` + jsonEscape(asset) + `"}`)
}

// Payload: {"roundId":<u64>}. Permissionless. Long after a round resolved
// (settleBlock + ClaimWindowBlocks, ~90 days), sweeps any UNCLAIMED staker funds
// — winnings a winner never took, or an abandoned/unreceivable refund — to the
// Hive DHF (@hive.fund) rather than burning them or leaving them stuck. Uses
// HiveWithdraw (L2→L1 unmap) because the DHF is an L1 institution. market.Sweep-
// Unclaimed sets the `swept` flag first (CEI), so claim/reclaim are then rejected
// and nothing can double-spend the funds already sent to the DHF.
//
//go:wasmexport sweepUnclaimed
func SweepUnclaimed(a *string) *string {
	payload := payloadStr(a)
	block := currentBlock()
	roundId := jsonU64(payload, "roundId")

	amt, dhf, err := market.SweepUnclaimed(store, block, roundId)
	if err != nil {
		handleErr(err)
		return nil
	}
	asset := roundAsset(roundId)
	if amt != nil && amt.Sign() > 0 {
		sdk.HiveWithdraw(sdk.Address(dhf), nativeInt64(amt), sdk.Asset(asset))
	}
	sdk.Log(`{"type":"sweep","roundId":` + u64s(roundId) + `,"amount":"` + bigStr(amt) + `","asset":"` + jsonEscape(asset) + `","to":"` + jsonEscape(dhf) + `"}`)
	return strPtr(`{"roundId":` + u64s(roundId) + `,"amount":"` + bigStr(amt) + `","asset":"` + jsonEscape(asset) + `","to":"` + jsonEscape(dhf) + `"}`)
}

// ── NO PRIVILEGED OPERATIONS ────────────────────────────────────────────────
// Fully decentralized: the owner-gated entrypoints (setFeeBps, setHouse,
// withdrawFees, pause, unpause, changeOwner, acceptOwnership,
// cancelOwnershipTransfer) have been REMOVED. The deployed contract exposes only
// permissionless actions — roll, bet, claim, settle, voidStale, reclaim,
// sweepUnclaimed, peekPrice — so no operator can charge a fee, pause the market,
// move funds, or transfer control. Rounds open via the permissionless on-chain
// `roll`; the market is zero-rake by construction. (The corresponding functions
// still exist in the `market` package but are unreachable — no wasm export calls
// them — pending their removal in the market-package cleanup pass.)
