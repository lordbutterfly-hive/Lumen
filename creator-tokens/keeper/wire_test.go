package keeper

import (
	"encoding/json"
	"testing"
)

func testOpConfig() OpConfig {
	return OpConfig{NetID: "vsc-testnet", ContractID: "vsc1demo000000000000000000000000000000", RCLimit: 5000}
}

func TestBuildOp_RefundHolderPayloadShape(t *testing.T) {
	op := Op{Kind: OpRefundHolder, Creator: "alice", Holder: "bob", Balance: bi(500)}
	envelope, err := BuildOp(testOpConfig(), "hive:keeper-bot", op)
	if err != nil {
		t.Fatalf("BuildOp: %v", err)
	}
	if envelope.ID != "vsc.call" {
		t.Fatalf("ID = %q, want vsc.call", envelope.ID)
	}
	if len(envelope.RequiredAuths) != 0 {
		t.Fatalf("RequiredAuths = %v, want empty (posting-only op)", envelope.RequiredAuths)
	}
	if len(envelope.RequiredPostingAuths) != 1 || envelope.RequiredPostingAuths[0] != "keeper-bot" {
		t.Fatalf("RequiredPostingAuths = %v, want [keeper-bot]", envelope.RequiredPostingAuths)
	}

	var call VSCCall
	if err := json.Unmarshal([]byte(envelope.JSON), &call); err != nil {
		t.Fatalf("decode inner VSCCall: %v", err)
	}
	if call.Action != "refundHolder" {
		t.Fatalf("Action = %q, want refundHolder", call.Action)
	}
	if len(call.Intents) != 0 {
		t.Fatalf("Intents = %v, want empty (refundHolder draws no funds in from caller)", call.Intents)
	}

	var payload map[string]string
	if err := json.Unmarshal([]byte(call.Payload), &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if payload["creator"] != "alice" || payload["holder"] != "bob" {
		t.Fatalf("payload = %v, want {creator:alice, holder:bob}", payload)
	}
	if _, present := payload["balance"]; present {
		t.Fatalf("payload leaked the advisory Balance field onto the wire: %v", payload)
	}
}

func TestBuildOp_CloseIfDrainedPayloadShape(t *testing.T) {
	op := Op{Kind: OpCloseIfDrained, Creator: "alice"}
	envelope, err := BuildOp(testOpConfig(), "hive:keeper-bot", op)
	if err != nil {
		t.Fatalf("BuildOp: %v", err)
	}
	var call VSCCall
	if err := json.Unmarshal([]byte(envelope.JSON), &call); err != nil {
		t.Fatalf("decode inner VSCCall: %v", err)
	}
	if call.Action != "closeIfDrained" {
		t.Fatalf("Action = %q, want closeIfDrained", call.Action)
	}
	var payload map[string]string
	if err := json.Unmarshal([]byte(call.Payload), &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if len(payload) != 1 || payload["creator"] != "alice" {
		t.Fatalf("payload = %v, want exactly {creator:alice}", payload)
	}
}

func TestBuildOp_UnknownKindErrors(t *testing.T) {
	op := Op{Kind: OpKind(99), Creator: "alice"}
	if _, err := BuildOp(testOpConfig(), "hive:keeper-bot", op); err == nil {
		t.Fatal("expected an error for an unknown op kind")
	}
}

func TestAccountName_StripsScheme(t *testing.T) {
	if got := accountName("hive:keeper-bot"); got != "keeper-bot" {
		t.Fatalf("accountName(hive:keeper-bot) = %q", got)
	}
	if got := accountName("bare-name"); got != "bare-name" {
		t.Fatalf("accountName(bare-name) = %q, want unchanged", got)
	}
}
