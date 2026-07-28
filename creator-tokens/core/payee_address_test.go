package core

import (
	"os"
	"strings"
	"testing"
)

// payee_address_test.go — source-derived guards for ../sdk/address.go.
//
// WHY A SOURCE TEST AND NOT A UNIT TEST: package `sdk` cannot be built by the
// native toolchain at all — it imports ../runtime, which is wasm-only
// ("build constraints exclude all Go files"). So `go test ./sdk/` is
// impossible and there are no tests in that package. This file uses the same
// idiom fixround1_test.go's TestContract_OUTFLOW1_ClaimTradeFeesEntrypointWired
// already uses for ../contract/main.go: read the source and assert the wiring.
// It is a presence check, which is exactly the class of check that would have
// caught the omission below.

// TestPayee_BitcoinDIDIsAValidRecipient pins the did:pkh:bip122 branch in
// sdk.Address.Type().
//
// THE DEFECT THIS GUARDS (found 2026-07-28 by two independent audit seats):
// Type() classified did:pkh:eip155, hive: and system:, and returned Unknown
// for everything else — so every BITCOIN DID was Unknown and IsValid() was
// false for it. IsValid() has exactly two consumers, and both are payee gates
// in ../contract/main.go:
//
//	transfer      — `to`     : a BTC holder could never be SENT credits.
//	refundHolder  — `holder` : a BTC holder could never be SWEPT.
//
// The second is the damaging one, and the victim is not the BTC holder.
// RefundHolder is the permissionless wind-down push; CloseIfDrained requires
// supply == 0 (../core/refund.go). A single dormant BTC holder therefore pins
// supply above zero permanently, so the market can never reach CLOSED and the
// CREATOR can never re-register. A keeper retries the doomed op forever.
//
// It survived every prior pass because the simulator calls core.RefundHolder
// directly and never crosses the wasm wrapper where the gate lives.
func TestPayee_BitcoinDIDIsAValidRecipient(t *testing.T) {
	src, err := os.ReadFile("../sdk/address.go")
	if err != nil {
		t.Fatalf("read sdk/address.go: %v", err)
	}
	text := string(src)

	if !strings.Contains(text, `AddressTypeBTC`) {
		t.Fatal("PAYEE REGRESSION: sdk/address.go declares no AddressTypeBTC — Bitcoin DIDs fall to AddressTypeUnknown, IsValid() is false, and contract/main.go's transfer + refundHolder gates REFUSE every BTC holder (a dormant one then pins supply > 0 and the creator's market can never close)")
	}
	if !strings.Contains(text, `"did:pkh:bip122"`) {
		t.Fatal("PAYEE REGRESSION: sdk/address.go's Type() has no did:pkh:bip122 prefix branch — see this test's doc for the wind-down consequence")
	}

	// The branch must actually RETURN the BTC type, not merely mention it: a
	// prefix test that fell through to Unknown would satisfy the two checks
	// above while leaving the defect fully intact.
	ti := strings.Index(text, "func (a Address) Type()")
	if ti < 0 {
		t.Fatal("PAYEE REGRESSION: sdk/address.go has no Address.Type() method — this test's premise is broken, fix it rather than deleting it")
	}
	body := text[ti:]
	bi := strings.Index(body, `"did:pkh:bip122"`)
	ri := strings.Index(body, "return AddressTypeBTC")
	if bi < 0 || ri < 0 || ri < bi {
		t.Fatal("PAYEE REGRESSION: the did:pkh:bip122 branch in Address.Type() does not return AddressTypeBTC — a BTC DID still classifies as Unknown")
	}

	// Guard the guard: if either payee gate is ever removed, this test silently
	// stops protecting anything, so fail loudly and make whoever removed it
	// re-read the reasoning above.
	main, err := os.ReadFile("../contract/main.go")
	if err != nil {
		t.Fatalf("read contract/main.go: %v", err)
	}
	if n := strings.Count(string(main), ".IsValid()"); n != 2 {
		t.Fatalf("PAYEE REGRESSION: expected exactly 2 sdk.Address(...).IsValid() payee gates in contract/main.go (transfer's `to` and refundHolder's `holder`), found %d — if a gate was added or removed, re-read this test's doc and update it deliberately", n)
	}
}
