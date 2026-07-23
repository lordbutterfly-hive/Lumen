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
// (core/refund.go). Intents is therefore always empty, which (per the
// auth-routing rule on CustomJSON below) is exactly what keeps this
// keeper's own bot account on a POSTING key rather than an ACTIVE key.
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

// CustomJSON is the outer Hive L1 custom_json operation. Auth routing
// mirrors the imitated template exactly: an account only needs
// RequiredAuths (an ACTIVE key) if one of its intents is "transfer.allow";
// every op this package builds carries zero intents (see Intent's doc), so
// the keeper's own bot account always lands in RequiredPostingAuths —
// cheaper and safer for an unattended, automated process to hold than an
// active key.
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

// buildCustomJSON assembles one VSCCall + wraps it in the outer envelope.
func buildCustomJSON(cfg OpConfig, action string, payload map[string]interface{}, caller string) (CustomJSON, error) {
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
		RequiredAuths:        []string{},
		RequiredPostingAuths: []string{accountName(caller)},
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
