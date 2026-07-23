package scheduler

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// A local, verbatim-behavior port of contract/main.go's flat-JSON payload
// readers (findKey/jsonStr/jsonU64, main.go:181-265). This package must NOT
// import ../contract (it's TinyGo/wasm build-constrained — task
// requirement), so this is the only way to prove, at the byte level, that
// the payload strings BuildSettleOp/BuildVoidStaleOp/BuildReclaimOp produce
// are actually parseable by the REAL contract reader, not just "valid
// JSON". Kept intentionally identical in behavior to main.go's
// implementation. (BuildRollOp needs no such proof — its payload is `{}`
// and the contract never reads it at all, see that builder's doc.)
// ---------------------------------------------------------------------------

func isJSONSpaceT(b byte) bool { return b == ' ' || b == '\t' || b == '\n' || b == '\r' }

func findKeyT(payload, key string) int {
	pat := "\"" + key + "\""
	idx := strings.Index(payload, pat)
	if idx < 0 {
		return -1
	}
	i := idx + len(pat)
	for i < len(payload) && isJSONSpaceT(payload[i]) {
		i++
	}
	if i >= len(payload) || payload[i] != ':' {
		return -1
	}
	return i + 1
}

func jsonStrT(payload, key string) string {
	i := findKeyT(payload, key)
	if i < 0 {
		return ""
	}
	for i < len(payload) && isJSONSpaceT(payload[i]) {
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

func jsonU64T(payload, key string) uint64 {
	i := findKeyT(payload, key)
	if i < 0 {
		return 0
	}
	for i < len(payload) && isJSONSpaceT(payload[i]) {
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

// ---------------------------------------------------------------------------

func testCfg() OpConfig {
	return OpConfig{NetID: "vsc-testnet", ContractID: "vsc1abcdefg", RCLimit: 5000}
}

func TestBuildRollOp_Shape(t *testing.T) {
	op, err := BuildRollOp(testCfg(), "hive:scheduler-bot")
	if err != nil {
		t.Fatalf("BuildRollOp: %v", err)
	}
	if op.ID != "vsc.call" {
		t.Fatalf("op.ID = %q, want vsc.call", op.ID)
	}
	if len(op.RequiredAuths) != 0 {
		t.Fatalf("RequiredAuths = %v, want empty (no transfer.allow intent in roll)", op.RequiredAuths)
	}
	if len(op.RequiredPostingAuths) != 1 || op.RequiredPostingAuths[0] != "scheduler-bot" {
		t.Fatalf("RequiredPostingAuths = %v, want [scheduler-bot]", op.RequiredPostingAuths)
	}

	var call VSCCall
	if err := json.Unmarshal([]byte(op.JSON), &call); err != nil {
		t.Fatalf("op.JSON does not unmarshal as VSCCall: %v\njson=%s", err, op.JSON)
	}
	if call.ContractID != "vsc1abcdefg" || call.Action != "roll" || call.NetID != "vsc-testnet" || call.RCLimit != 5000 {
		t.Fatalf("VSCCall envelope wrong: %+v", call)
	}
	if len(call.Intents) != 0 {
		t.Fatalf("Intents = %v, want empty", call.Intents)
	}
	// contract/main.go's Roll handler (main.go:389-401) never reads its
	// payload argument at all — the empty object is just a well-formed
	// payload string, not something the parser extracts fields from.
	if call.Payload != "{}" {
		t.Fatalf("payload = %q, want {} (roll's payload is ignored by the contract)", call.Payload)
	}
}

func TestBuildSettleOp_Shape(t *testing.T) {
	op, err := BuildSettleOp(testCfg(), "hive:keeper-bot", 7)
	if err != nil {
		t.Fatalf("BuildSettleOp: %v", err)
	}
	var call VSCCall
	if err := json.Unmarshal([]byte(op.JSON), &call); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if call.Action != "settle" {
		t.Fatalf("action = %q, want settle", call.Action)
	}
	if got := jsonU64T(call.Payload, "roundId"); got != 7 {
		t.Fatalf("payload roundId = %d, want 7 (payload=%s)", got, call.Payload)
	}
	if len(op.RequiredPostingAuths) != 1 || op.RequiredPostingAuths[0] != "keeper-bot" {
		t.Fatalf("RequiredPostingAuths = %v, want [keeper-bot]", op.RequiredPostingAuths)
	}
}

func TestBuildVoidStaleOp_Shape(t *testing.T) {
	op, err := BuildVoidStaleOp(testCfg(), "hive:keeper-bot", 9)
	if err != nil {
		t.Fatalf("BuildVoidStaleOp: %v", err)
	}
	var call VSCCall
	if err := json.Unmarshal([]byte(op.JSON), &call); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if call.Action != "voidStale" {
		t.Fatalf("action = %q, want voidStale", call.Action)
	}
	if got := jsonU64T(call.Payload, "roundId"); got != 9 {
		t.Fatalf("payload roundId = %d, want 9", got)
	}
}

func TestBuildReclaimOp_Shape(t *testing.T) {
	op, err := BuildReclaimOp(testCfg(), "hive:staker", 11)
	if err != nil {
		t.Fatalf("BuildReclaimOp: %v", err)
	}
	var call VSCCall
	if err := json.Unmarshal([]byte(op.JSON), &call); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if call.Action != "reclaim" {
		t.Fatalf("action = %q, want reclaim", call.Action)
	}
	if got := jsonU64T(call.Payload, "roundId"); got != 11 {
		t.Fatalf("payload roundId = %d, want 11 (payload=%s)", got, call.Payload)
	}
	if len(op.RequiredPostingAuths) != 1 || op.RequiredPostingAuths[0] != "staker" {
		t.Fatalf("RequiredPostingAuths = %v, want [staker]", op.RequiredPostingAuths)
	}
}

func TestAccountName(t *testing.T) {
	cases := map[string]string{
		"hive:lordbutterfly": "lordbutterfly",
		"hive:owner":         "owner",
		"noscheme":           "noscheme",
	}
	for in, want := range cases {
		if got := accountName(in); got != want {
			t.Fatalf("accountName(%q) = %q, want %q", in, got, want)
		}
	}
}
