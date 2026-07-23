package core

import (
	"math/big"
	"strings"
	"testing"
)

// The chain hands a contract a DID-shaped caller: go-vsc-node builds it from
// RequiredAuths[0] (modules/state-processing/transactions.go:122-126) and
// prefixes every Hive L1 auth with "hive:" (state_engine.go:985). An earlier
// version of validAccount enforced a bare [a-z0-9.-]{3,16} Hive name, which
// rejected every real caller — the contract would have been unusable on mainnet
// while passing every local test, because every test used bare names.
func TestValidAccount_AcceptsRealChainCallerShapes(t *testing.T) {
	accepted := []string{
		"hive:blocktrades",                           // the actual mainnet caller shape
		"hive:a.very-long.name123",                   // hive names allow dots and dashes
		"0x8ba1f109551bD432803012645Ac136ddd64DBA72", // EVM address
		"contract:vsc1abcdef",                        // contract-domain caller
		"system:gateway",                             // system account
		"alice",                                      // bare name, as used throughout the tests
	}
	for _, a := range accepted {
		if !validAccount(a) {
			t.Fatalf("validAccount(%q) = false — this shape is produced by the chain and MUST be accepted", a)
		}
	}

	// The one property that is a genuine security control: the key delimiter
	// must never appear, because state keys are built by concatenation.
	rejected := []string{"", "a|b", "hive:al|ice", string(rune(0x01)) + "x"}
	for _, a := range rejected {
		if validAccount(a) {
			t.Fatalf("validAccount(%q) = true — must reject: it can forge another account's state key", a)
		}
	}
}

// setMoney must reject a NEGATIVE loudly (RULING G hardening). THE BUG THIS
// GUARDS: before the panic existed, a negative write was STORED as "-123"
// and getMoney's parseMoney error path then read it back as ZERO — so one
// buggy negative write anywhere would have silently WIPED a reserve, a fee
// pot or a balance, with no error at any layer. A panic is the loud
// alternative: in the wasm runtime it traps and reverts the whole
// transaction (nothing mutates), and in tests it fails at the exact write
// site. No reachable path can trigger it (every subtract routes through
// mSub/subMoney, which error on underflow first), so this test writes
// directly.
func TestSetMoney_NegativeIsLoud_NotSilentlyZeroed(t *testing.T) {
	s := NewMemStore()
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("setMoney accepted a negative amount — a future negative write would silently WIPE the value to zero on the next read")
		}
		msg, ok := r.(string)
		if !ok || !strings.Contains(msg, "setMoney: negative amount") {
			t.Fatalf("panic value = %v, want the setMoney negative-amount message", r)
		}
		// Nothing was written: the guard runs BEFORE the Set.
		if v, ok := s.Get("m|c|res"); ok {
			t.Fatalf("the rejected negative write still stored %q", v)
		}
	}()
	setMoney(s, kReserve("c"), big.NewInt(-1))
}

// The round-trip the panic protects, stated as an executable fact: a
// negative value that DID reach state would read back as zero.
func TestGetMoney_MalformedOrNegativeStoredValueReadsZero(t *testing.T) {
	s := NewMemStore()
	s.Set(kReserve("c"), "-500") // bypassing setMoney, as only a bug could
	if got := getMoney(s, kReserve("c")); got.Sign() != 0 {
		t.Fatalf("getMoney on a stored negative = %s, want 0 — this is exactly the silent wipe setMoney's panic prevents", got)
	}
	s.Set(kReserve("c"), "not-a-number")
	if got := getMoney(s, kReserve("c")); got.Sign() != 0 {
		t.Fatalf("getMoney on a malformed value = %s, want 0", got)
	}
}
