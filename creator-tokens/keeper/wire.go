package keeper

import (
	"encoding/json"
	"fmt"
	"strings"
)

// wire.go — the broadcastable envelope this package's Ops render to.
// Deliberately mirrors hive-price-market/scheduler/ops.go structurally
// (same field names, same verified shapes) since the envelope is generic to
// VSC's custom_json "vsc.call" transport, not specific to either contract —
// there is nothing project-specific to reinvent here.

// OpConfig is the subset of deploy-time identifiers an envelope needs — NOT
// scheduling policy.
type OpConfig struct {
	NetID      string
	ContractID string
	RCLimit    uint64
}

// Intent mirrors go-vsc-node's contracts.Intent (verified shape: {type,
// args} — see hive-price-market/scheduler/ops.go's identical, already-
// verified comment). Neither op this package builds ever carries one:
// refundHolder pays the HOLDER out of the market's own RESERVE — it never
// draws HBD in from the caller — and closeIfDrained moves no funds at all
// (core/refund.go). Intents is therefore always empty.
//
// ★ CORRECTED 2026-08-19 (audit anomaly AN-25). This used to conclude that an
// empty Intents list "is exactly what keeps this keeper's own bot account on a
// POSTING key rather than an ACTIVE key" — which is the reasoning of a defect
// that was already FIXED on 2026-07-28, sitting 24 lines above the CustomJSON
// doc and code that correctly use an ACTIVE key. The contract's
// requireActiveAuth refuses an empty RequiredAuths outright, so a posting-key
// keeper is refused on chain; buildCustomJSON below signs ACTIVE for exactly
// that reason. A stale comment that reproduces a fixed bug's reasoning is
// worse than no comment: the next person to "restore consistency" between the
// doc and the code has a coin flip over which one to change.
type Intent struct {
	Type string            `json:"type"`
	Args map[string]string `json:"args,omitempty"`
}

// VSCCall is the inner JSON body of a Hive custom_json "vsc.call" operation.
// Field set and names verified against go-vsc-node's own transaction crafter
// — see hive-price-market/scheduler/ops.go's VSCCall for the verification
// trail against modules/transaction-pool/crafter.go (this shape is generic
// to VSC, not specific to either contract, so the same verification applies
// unchanged here).
type VSCCall struct {
	ContractID string   `json:"contract_id"`
	Action     string   `json:"action"`
	Payload    string   `json:"payload"`
	RCLimit    uint64   `json:"rc_limit"`
	Intents    []Intent `json:"intents"`
	Caller     string   `json:"caller"`
	NetID      string   `json:"net_id"`
}

// CustomJSON is the outer Hive L1 custom_json operation.
//
// AUTH ROUTING: the bot account goes in RequiredAuths (an ACTIVE key).
//
// DEFECT FIX 2026-07-28 — it used to go in RequiredPostingAuths, and every
// op this package produced would have been refused on chain, 100% of the
// time, the moment LiveSubmitter was wired. The old rationale reasoned only
// about the LEDGER's requirement ("an account only needs an ACTIVE key if
// one of its intents is transfer.allow; our ops carry zero intents, so
// posting suffices"). That much is true and is still true — but it is not
// the only gate. ../contract/main.go's requireActiveAuth is an INDEPENDENT,
// contract-side check at the top of every state-changing entrypoint,
// including both ops this package builds (refundHolder at main.go:1245,
// closeIfDrained at main.go:1295). It refuses an empty RequiredAuths array
// outright: "active authority required: posting-only (or missing) auth
// refused". That gate exists because a Hive POSTING key is delegated to
// every dApp a user has ever touched, and gating value operations on ACTIVE
// auth is what closed a CRITICAL finding in this contract's own history.
// The template this package was modelled on has no such contract-side gate,
// so the assumption did not survive being copied here.
//
// Why we fixed the KEEPER rather than carving a posting-tier exception into
// requireActiveAuth: both these ops are already permissionless and pay only
// a pre-recorded party (refundHolder pays `holder`, closeIfDrained moves
// nothing to the caller), so an exception would probably be safe — but
// "probably safe" is not a reason to put a hole in the one gate that closed
// a critical, and the operational cost here is nil. The bot needs an active
// key on a dedicated throwaway account holding no funds; these ops never
// move the bot's own balance, so that key's blast radius is the bot account
// itself and nothing else.
type CustomJSON struct {
	RequiredAuths        []string `json:"required_auths"`
	RequiredPostingAuths []string `json:"required_posting_auths"`
	ID                   string   `json:"id"` // always "vsc.call"
	JSON                 string   `json:"json"`
}

// accountName strips a "hive:" scheme prefix for Hive's required_auths /
// required_posting_auths arrays, which expect bare usernames. Identical to
// (and the same documented DID caveat as) hive-price-market/scheduler/
// ops.go's accountName — this keeper's Caller is always "hive:name".
func accountName(caller string) string {
	if i := strings.Index(caller, ":"); i >= 0 && i+1 < len(caller) {
		return caller[i+1:]
	}
	return caller
}

// NormalizeCaller turns an operator-supplied --caller into the ONE shape the
// chain accepts, or refuses it loudly at startup.
//
// DEFECT FIX 2026-08-19 (audit anomaly AN-24). The keeper's Caller is written
// into the vsc.call body, while accountName strips the scheme for the outer
// transaction's RequiredAuths. go-vsc-node then derives the effective caller
// from RequiredAuths[0] and prefixes it with "hive:" — so if the two do not
// agree, every op the keeper submits is rejected with "caller is not in
// required_auths". Nothing validated this: the full 10-shape domain was driven
// and 8 shapes produced a value that fails on chain, including the plain bare
// username an operator would most naturally type. The failure is silent from
// the keeper's side (it is a chain-side rejection), so a misconfigured keeper
// looks like it is running fine and simply never does anything.
//
// A BARE NAME IS NORMALISED, ANYTHING ELSE IS REFUSED. "keeper-bot" is
// unambiguous — there is exactly one scheme this keeper can sign under — so
// accepting it is a kindness with no ambiguity attached. A DID, an empty
// string, an unknown scheme or a name with a second colon in it is NOT
// unambiguous, and guessing at one of those is how you get a keeper that runs
// for a week doing nothing.
func NormalizeCaller(caller string) (string, error) {
	c := strings.TrimSpace(caller)
	if c == "" {
		return "", fmt.Errorf("keeper: --caller is empty; it must be the keeper bot's own Hive account, e.g. hive:creator-keys-keeper")
	}
	if i := strings.Index(c, ":"); i >= 0 {
		if !strings.HasPrefix(c, "hive:") {
			return "", fmt.Errorf("keeper: --caller %q uses an unsupported scheme; this keeper signs Hive transactions, so the caller must be hive:<account>", caller)
		}
		name := c[len("hive:"):]
		if name == "" || strings.Contains(name, ":") {
			return "", fmt.Errorf("keeper: --caller %q is not a well-formed hive:<account>", caller)
		}
		return c, nil
	}
	return "hive:" + c, nil
}

// buildCustomJSON assembles one VSCCall + wraps it in the outer envelope.
func buildCustomJSON(cfg OpConfig, action string, payload map[string]interface{}, caller string) (CustomJSON, error) {
	// Defense in depth: main.go normalises at startup, but this package is
	// importable and a future caller could hand us a raw flag value. A bad
	// caller here means every op is rejected on chain with nothing to show for
	// it locally, so refuse to BUILD one rather than submit it.
	caller, err := NormalizeCaller(caller)
	if err != nil {
		return CustomJSON{}, err
	}
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return CustomJSON{}, fmt.Errorf("keeper: encode %s payload: %w", action, err)
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
		return CustomJSON{}, fmt.Errorf("keeper: encode %s vsc.call: %w", action, err)
	}
	return CustomJSON{
		// ACTIVE, not posting — ../contract/main.go's requireActiveAuth
		// refuses an empty RequiredAuths outright. See CustomJSON's doc.
		RequiredAuths:        []string{accountName(caller)},
		RequiredPostingAuths: []string{},
		ID:                   "vsc.call",
		JSON:                 string(callBytes),
	}, nil
}

// BuildOp renders op as a broadcastable Hive custom_json envelope. Payload
// shapes match contract/main.go's own payload readers field-for-field:
//
//	refundHolder:   {"creator":"<hive-account>","holder":"<hive-account>"}  (main.go:725)
//	closeIfDrained: {"creator":"<hive-account>"}                            (main.go:759)
//
// Neither payload includes op.Balance — it is this package's own advisory
// figure, never something the contract call needs or trusts (see Plan's
// "verify, don't trust" doc); putting it on the wire would invite a future
// reader to mistake it for authoritative input.
func BuildOp(cfg OpConfig, caller string, op Op) (CustomJSON, error) {
	switch op.Kind {
	case OpRefundHolder:
		return buildCustomJSON(cfg, "refundHolder", map[string]interface{}{
			"creator": op.Creator,
			"holder":  op.Holder,
		}, caller)
	case OpCloseIfDrained:
		return buildCustomJSON(cfg, "closeIfDrained", map[string]interface{}{
			"creator": op.Creator,
		}, caller)
	default:
		return CustomJSON{}, fmt.Errorf("keeper: unknown op kind %d for creator %s", op.Kind, op.Creator)
	}
}
