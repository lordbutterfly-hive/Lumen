package scheduler

import (
	"encoding/json"
	"fmt"
	"strings"
)

// OpConfig is the subset of Config an op builder needs (deploy-time
// identifiers, not scheduling policy).
type OpConfig struct {
	NetID      string
	ContractID string
	RCLimit    uint64
}

// Intent mirrors go-vsc-node's contracts.Intent EXACTLY
// (modules/db/vsc/contracts/schema.go:19-22, verified 2026-07-19: {type,
// args}). The only intent type the contract layer defines today is
// "transfer.allow" (used by `bet` to authorize HiveDraw — contract/main.go:445,
// out of scope for this scheduler). Every op this package builds
// (roll/settle/voidStale/reclaim) moves NO caller funds via an intent —
// settle pays its keeper bounty and reclaim/claim pay stakers back OUT via
// HiveTransfer *inside* the contract, never draw IN from the caller — so
// every op's Intents is always empty.
type Intent struct {
	Type string            `json:"type"`
	Args map[string]string `json:"args,omitempty"`
}

// VSCCall is the inner JSON body of a Hive custom_json "vsc.call" operation.
// Field set and names verified against go-vsc-node's OWN transaction crafter
// (modules/transaction-pool/crafter.go:465-519, VscContractCall +
// SerializeHive, read 2026-07-19): {contract_id, action, payload, rc_limit,
// intents, caller, net_id}. `payload` is itself a JSON-encoded STRING (not a
// nested object) — matches contract/main.go's flat-JSON payload readers,
// which explicitly only handle "a single flat JSON object (no nesting)"
// (main.go:170-179).
type VSCCall struct {
	ContractID string   `json:"contract_id"`
	Action     string   `json:"action"`
	Payload    string   `json:"payload"`
	RCLimit    uint64   `json:"rc_limit"`
	Intents    []Intent `json:"intents"`
	Caller     string   `json:"caller"`
	NetID      string   `json:"net_id"`
}

// CustomJSON is the outer Hive L1 custom_json operation, verified against
// go-vsc-node's crafter.go:551-556 (which itself builds a
// hivego.CustomJsonOperation, ~/hivego/hive_ops.go:141-147) — same 4 fields,
// same names, same "vsc.call" id constant.
//
// Auth routing mirrors crafter.go:529-549 exactly: an account only goes into
// RequiredAuths (needs the ACTIVE key) if one of its intents is
// "transfer.allow"; otherwise it goes into RequiredPostingAuths (posting key
// suffices). Every op this package builds carries zero intents (see Intent's
// doc comment above), so the caller always lands in RequiredPostingAuths —
// cheaper and safer for an automated keeper bot to hold than an active key.
type CustomJSON struct {
	RequiredAuths        []string `json:"required_auths"`
	RequiredPostingAuths []string `json:"required_posting_auths"`
	ID                   string   `json:"id"` // always "vsc.call"
	JSON                 string   `json:"json"`
}

// accountName strips a "hive:" scheme prefix for Hive's required_auths /
// required_posting_auths arrays, which the Hive protocol expects as bare
// usernames. (crafter.go:545,548 does `strings.Split(k, ":")[1]`, which is
// only correct for two-segment scheme:name identifiers; a "did:key:..."
// identifier has three segments and that expression yields "key", not the
// intended name — a pre-existing quirk in that code we don't need to
// replicate, since a Hive custom_json op can only ever be signed by a real
// Hive account, never a DID. This scheduler's Caller is always "hive:name".)
func accountName(caller string) string {
	if i := strings.Index(caller, ":"); i >= 0 && i+1 < len(caller) {
		return caller[i+1:]
	}
	return caller
}

// buildCustomJSON assembles one VSCCall + wraps it in the outer CustomJSON
// envelope. payload fields are JSON-encoded via encoding/json, which (for
// the flat map[string]interface{} payloads every builder below constructs)
// produces exactly the shape contract/main.go's hand-rolled flat-JSON reader
// expects: quoted strings for jsonStr fields, bare decimal numbers for
// jsonU64 fields (see ops_test.go's TestBuildSettleOp_Shape /
// TestBuildReclaimOp_Shape for a byte-level proof against a local port of
// that exact reader).
func buildCustomJSON(cfg OpConfig, action string, payload map[string]interface{}, caller string) (CustomJSON, error) {
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return CustomJSON{}, fmt.Errorf("scheduler: encode %s payload: %w", action, err)
	}
	call := VSCCall{
		ContractID: cfg.ContractID,
		Action:     action,
		Payload:    string(payloadBytes),
		RCLimit:    cfg.RCLimit,
		Intents:    []Intent{},
		Caller:     caller,
		NetID:      cfg.NetID,
	}
	callBytes, err := json.Marshal(call)
	if err != nil {
		return CustomJSON{}, fmt.Errorf("scheduler: encode %s vsc.call: %w", action, err)
	}
	return CustomJSON{
		RequiredAuths:        []string{},
		RequiredPostingAuths: []string{accountName(caller)},
		ID:                   "vsc.call",
		JSON:                 string(callBytes),
	}, nil
}

// BuildRollOp builds the roll op — the PERMISSIONLESS, decentralized round
// opener (contract/main.go:389-401's Roll handler, market.RollRound). Its
// payload is `a *string` but the handler NEVER reads it (main.go:390-401 —
// no jsonStr/jsonU64 call on `a` anywhere in Roll): the reference price
// (pendulum.hive_moving_avg_bps), the 7-bucket ±10/20/30% strikes
// (market/create.go computeStrikes), and the weekly lock/settle/grace timing
// (market.RollBettingBlocks/RollSettleGapBlocks/RollGraceBlocks) are ALL
// derived on-chain, deterministically, from env + protocol constants — so
// there is nothing for an off-chain caller to compute or supply. This is a
// DELIBERATE simplification from the old (pre-re-skin) createRound flow,
// which took a caller-supplied {asset,strikes,lock,settle,grace,label,
// creator,refPrice} payload the owner had to compute off-chain; verified by
// reading contract/main.go directly rather than assumed. The payload is
// still sent as `{}` (an empty flat JSON object) for a well-formed op, not
// because the contract needs it.
func BuildRollOp(cfg OpConfig, caller string) (CustomJSON, error) {
	return buildCustomJSON(cfg, "roll", map[string]interface{}{}, caller)
}

// BuildSettleOp builds the settle op. Payload: {roundId} (contract/main.go:471).
// Permissionless on-chain, but the scheduler still signs as its own bot
// account so the keeper bounty (main.go:482-484) pays that account.
func BuildSettleOp(cfg OpConfig, caller string, roundID uint64) (CustomJSON, error) {
	return buildCustomJSON(cfg, "settle", map[string]interface{}{"roundId": roundID}, caller)
}

// BuildVoidStaleOp builds the voidStale op. Payload: {roundId}
// (contract/main.go:518-521). Permissionless liveness fallback: forces a
// still-OPEN round to VOID once block >= settleBlock+SettleWindowBlocks+grace,
// regardless of feed health, so funds can never get stuck behind a
// persistently bad oracle feed. See keeper.go's DecideKeeperAction doc for
// why the settle keeper prefers settle() first and only reaches for this as
// a SEPARATE fallback.
func BuildVoidStaleOp(cfg OpConfig, caller string, roundID uint64) (CustomJSON, error) {
	return buildCustomJSON(cfg, "voidStale", map[string]interface{}{"roundId": roundID}, caller)
}

// BuildReclaimOp builds the reclaim op. Payload: {roundId}
// (contract/main.go:565-568). Permissionless FAIL-SAFE, callable by ANY
// staker on a round stuck OPEN past its settle deadline
// (settleBlock+SettleWindowBlocks+grace — the identical threshold voidStale
// itself enforces) to force it VOID and pull back their OWN full stake in
// ONE call — no oracle, no keeper, no owner. This is a USER self-serve
// action (market.Reclaim refunds the CALLER's own stake, and this
// scheduler's bot account never has one), included here for completeness of
// the current export set and so any caller (a staker running this binary
// directly, or a future ops tool) can build a well-formed reclaim op against
// the same OpConfig/CustomJSON plumbing as every other action — the
// automated keeper loop (scheduler.go's RunKeeperCycle) does not broadcast
// this on anyone's behalf.
func BuildReclaimOp(cfg OpConfig, caller string, roundID uint64) (CustomJSON, error) {
	return buildCustomJSON(cfg, "reclaim", map[string]interface{}{"roundId": roundID}, caller)
}
