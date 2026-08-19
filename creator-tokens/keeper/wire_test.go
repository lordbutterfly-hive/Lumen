package keeper

import (
	"encoding/json"
	"os"
	"strings"
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
	// ACTIVE auth, and this assertion is load-bearing: it used to demand the
	// exact opposite ("want empty (posting-only op)"), which pinned a defect
	// as correct. ../contract/main.go's requireActiveAuth refuses an empty
	// RequiredAuths on BOTH ops this package builds (refundHolder :1245,
	// closeIfDrained :1295), so a posting-only envelope would have been
	// rejected on chain 100% of the time the moment LiveSubmitter was wired.
	// Do not flip this back without reading CustomJSON's auth-routing doc.
	if len(envelope.RequiredAuths) != 1 || envelope.RequiredAuths[0] != "keeper-bot" {
		t.Fatalf("RequiredAuths = %v, want [keeper-bot] — the contract requires ACTIVE auth", envelope.RequiredAuths)
	}
	if len(envelope.RequiredPostingAuths) != 0 {
		t.Fatalf("RequiredPostingAuths = %v, want empty — auth belongs in RequiredAuths", envelope.RequiredPostingAuths)
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

// TestBuildOp_AuthTierMatchesWhatTheContractDemands ties this package's
// envelope to the contract's actual gate, so the two cannot drift apart
// again silently.
//
// They HAD drifted: every op this package built carried posting-only auth,
// while ../contract/main.go's requireActiveAuth refuses an empty
// RequiredAuths at the top of both entrypoints the keeper calls. Nothing
// caught it because the two facts live in different packages and the wasm
// wrapper cannot be compiled or executed by the native toolchain at all
// (it imports the TinyGo-only sdk), so no ordinary test can exercise the
// real gate. A source-presence check is the only guard available — same
// idiom as core/fixround1_test.go's TestContract_OUTFLOW1_*.
//
// The logic is deliberately conditional rather than hardcoded: if a future
// change genuinely removes the active-auth requirement from these
// entrypoints, this test stops demanding active auth instead of failing for
// the wrong reason.
func TestBuildOp_AuthTierMatchesWhatTheContractDemands(t *testing.T) {
	src, err := os.ReadFile("../contract/main.go")
	if err != nil {
		t.Fatalf("read contract/main.go: %v", err)
	}
	text := string(src)

	entrypointGatedOnActiveAuth := func(name string) bool {
		i := strings.Index(text, "//go:wasmexport "+name+"\n")
		if i < 0 {
			t.Fatalf("contract/main.go has no //go:wasmexport %s — this test's premise is broken, fix it rather than deleting it", name)
		}
		region := text[i:]
		if end := strings.Index(region[1:], "//go:wasmexport"); end >= 0 {
			region = region[:end+1]
		}
		return strings.Contains(region, "requireActiveAuth(")
	}

	needsActive := entrypointGatedOnActiveAuth("refundHolder") || entrypointGatedOnActiveAuth("closeIfDrained")

	cfg := OpConfig{ContractID: "vsc1contract", NetID: "vsc-mainnet", RCLimit: 100}
	env, err := BuildOp(cfg, "hive:keeper-bot", Op{Kind: OpRefundHolder, Creator: "alice", Holder: "bob"})
	if err != nil {
		t.Fatalf("BuildOp: %v", err)
	}

	if needsActive && len(env.RequiredAuths) == 0 {
		t.Fatal("AUTH-TIER REGRESSION: contract/main.go gates refundHolder/closeIfDrained on requireActiveAuth, which refuses an empty RequiredAuths — but this package builds a posting-only envelope. Every op the keeper submits would be rejected on chain, 100% of the time. Put the bot account in RequiredAuths (see CustomJSON's auth-routing doc).")
	}
	if !needsActive && len(env.RequiredAuths) != 0 {
		t.Log("note: the contract no longer gates these entrypoints on active auth; a posting-only envelope would now be acceptable and would be cheaper to operate")
	}
}

// TestNormalizeCaller_OnlyTheShapeTheChainAcceptsGetsThrough pins the AN-24
// fix. The keeper writes Caller into the vsc.call body while the outer
// transaction carries the bare name in RequiredAuths; go-vsc-node derives the
// effective caller from RequiredAuths[0] with a "hive:" prefix, so a caller in
// any other shape is rejected on chain — silently, from the keeper's side, so a
// misconfigured bot looks healthy and simply never does anything.
func TestNormalizeCaller_OnlyTheShapeTheChainAcceptsGetsThrough(t *testing.T) {
	for _, tc := range []struct {
		in, want string
	}{
		{"hive:keeper-bot", "hive:keeper-bot"},
		{"keeper-bot", "hive:keeper-bot"}, // a bare name is unambiguous: normalise it
		{"  hive:keeper-bot  ", "hive:keeper-bot"},
	} {
		got, err := NormalizeCaller(tc.in)
		if err != nil {
			t.Fatalf("NormalizeCaller(%q) errored: %v", tc.in, err)
		}
		if got != tc.want {
			t.Fatalf("NormalizeCaller(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}

	for _, bad := range []string{
		"",
		"   ",
		"did:pkh:eip155:1:0xabc",
		"system:treasury",
		"hive:",
		"hive:keeper:bot",
		"contract:vsc1abc",
	} {
		if got, err := NormalizeCaller(bad); err == nil {
			t.Fatalf("NormalizeCaller(%q) accepted it as %q — the chain would reject every op "+
				"this keeper submits, with nothing to show for it locally", bad, got)
		}
	}
}

// TestBuildCustomJSON_RefusesABadCallerRatherThanSubmittingIt is the
// defense-in-depth half: the package is importable, so a future caller could
// hand it a raw flag value that main.go never saw.
func TestBuildCustomJSON_RefusesABadCallerRatherThanSubmittingIt(t *testing.T) {
	cfg := OpConfig{ContractID: "vsc1test", NetID: "vsc-testnet", RCLimit: 1000}
	if _, err := buildCustomJSON(cfg, "refundHolder", map[string]interface{}{"creator": "alice"}, "did:pkh:eip155:1:0xabc"); err == nil {
		t.Fatal("buildCustomJSON built an envelope for a caller shape the chain rejects")
	}
	// ANTI-VACUITY: the good shape must still build.
	if _, err := buildCustomJSON(cfg, "refundHolder", map[string]interface{}{"creator": "alice"}, "hive:keeper-bot"); err != nil {
		t.Fatalf("the valid caller shape was refused: %v", err)
	}
}
