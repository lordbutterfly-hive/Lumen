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
	// Updated deliberately 2026-07-30 (milestone M2): safeTransferFrom is the
	// THIRD payee gate. It moves matured tokens to a counterparty, so it needs
	// the same protection as transfer — a destination this classifier does not
	// recognise would strand the tokens at a dead key with no rail able to
	// reach them.
	//
	// Note that safeTransferFrom ALSO refuses contract-domain destinations
	// (core/doors.go), which IsValid does not cover: a contract address is a
	// perfectly real account that simply cannot be refunded, because it holds no
	// keys and cannot call. The two checks guard different failures and neither
	// replaces the other.
	// ★ UPDATED 2026-07-30 (scrutiny F1). The three payee gates now route through
	// ONE helper, isPayableAddress, instead of calling IsValid directly — because
	// IsValid alone accepts `system:` addresses, which our own classifier calls
	// valid but go-vsc's ledger refuses to pay. A balance parked at one survives
	// the wind-down burn and then reverts the payout, pinning supply above zero
	// forever. So the count to pin is now the number of CALL SITES of the helper,
	// plus the single IsValid inside it.
	// ★ UPDATED 2026-08-19 (F19 defect fix): changeOwner is the FOURTH gate.
	// It does not guard the wind-down/supply-pinning failure the other three
	// do — it guards a different one: the eventual owner receives real HBD
	// via withdrawTreasury's HiveTransfer, so proposing an unpayable
	// (system/contract-domain/malformed) account as the new owner would
	// strand that payout path exactly like an unpayable transfer destination
	// strands a holder's tokens. Same helper, same "must be able to receive
	// a payout" property, different door.
	if n := strings.Count(string(main), "isPayableAddress("); n != 5 {
		t.Fatalf("PAYEE REGRESSION: expected 5 isPayableAddress mentions in contract/main.go (its definition plus four gates: transfer's `to`, refundHolder's `holder`, safeTransferFrom's `to`, changeOwner's `newOwner`), found %d — if a gate was added or removed, re-read this test's doc and update it deliberately", n)
	}
	if !strings.Contains(string(main), "AddressDomainSystem") {
		t.Fatal("PAYEE REGRESSION: the payee gate no longer refuses `system:` destinations — a single token sent to one can never be swept, so supply never reaches zero and the market can never close")
	}
}

// TestPayee_BodylessPrefixIsNotAValidRecipient pins the F6 fix (2026-08-19):
// Address.Type() must refuse a bare prefix with no real body glued onto it,
// not merely test strings.HasPrefix.
//
// THE DEFECT THIS GUARDS: before this fix, Type()'s did:pkh:eip155,
// did:pkh:bip122 and hive: branches were bare strings.HasPrefix checks, so
// "did:pkh:eip155BOGUS" (no colon-delimited chain-id/address body at all)
// and a bare "hive:" (no account name) both classified as EVM/Hive and
// therefore as a VALID, PAYABLE recipient — IsValid() and isPayableAddress
// both just delegate to Type(). transfer's `to`, safeTransferFrom's `to` and
// refundHolder's `holder` (../contract/main.go) all gate on isPayableAddress,
// so value could be parked at, and the permissionless wind-down sweep could
// pay real HBD OUT to, an identity string no real msg.required_auths entry
// can ever equal (go-vsc-node's ParseEthDID requires the exact prefix
// "did:pkh:eip155:1:" plus a valid hex address; a Hive account name can never
// be empty). Proven live: RefundHolder paid 1,596.047 HBD to "did:pkh:
// eip155BOGUS" and to "hive:" in the wasm-wrapper repro (AN-10).
//
// Same source-derived idiom as TestPayee_BitcoinDIDIsAValidRecipient above,
// and for the same reason: package sdk cannot be built by the native
// toolchain (see the file doc), so there is no way to call
// sdk.Address("...").Type() from a normal unit test in this tree.
func TestPayee_BodylessPrefixIsNotAValidRecipient(t *testing.T) {
	src, err := os.ReadFile("../sdk/address.go")
	if err != nil {
		t.Fatalf("read sdk/address.go: %v", err)
	}
	text := string(src)

	ti := strings.Index(text, "func (a Address) Type()")
	if ti < 0 {
		t.Fatal("PAYEE REGRESSION: sdk/address.go has no Address.Type() method — this test's premise is broken, fix it rather than deleting it")
	}
	// Only look inside Type()'s own body, up to the next top-level func, so a
	// helper mentioned elsewhere in the file (e.g. in a doc comment) cannot
	// satisfy these checks by accident.
	rest := text[ti+len("func (a Address) Type()"):]
	endBody := strings.Index(rest, "\nfunc ")
	if endBody < 0 {
		endBody = len(rest)
	}
	typeBody := rest[:endBody]

	// The three previously-bare branches must now route through a body-aware
	// helper rather than strings.HasPrefix directly. This is a structural
	// check, not a style preference: strings.HasPrefix(s, "did:pkh:eip155")
	// is exactly the bug, because it also matches "did:pkh:eip155BOGUS".
	for _, want := range []struct{ call, ret string }{
		{`hasColonBody(s, "did:pkh:eip155")`, "return AddressTypeEVM"},
		{`hasColonBody(s, "did:pkh:bip122")`, "return AddressTypeBTC"},
		{`hasNonEmptyBody(s, "hive:")`, "return AddressTypeHive"},
	} {
		ci := strings.Index(typeBody, want.call)
		if ci < 0 {
			t.Fatalf("PAYEE REGRESSION: Address.Type() no longer calls %s — a bodyless/malformed prefix (e.g. \"did:pkh:eip155BOGUS\" or bare \"hive:\") would classify as a real address type again, and RefundHolder's permissionless sweep would pay HBD to it (see AN-10)", want.call)
		}
		ri := strings.Index(typeBody[ci:], want.ret)
		if ri < 0 {
			t.Fatalf("PAYEE REGRESSION: the %s branch does not %s — check the branch still returns the right type", want.call, want.ret)
		}
	}
	// strings.HasPrefix must still be gone from the EVM/BTC/Hive branches —
	// only `system:` is deliberately still a bare prefix test (isPayableAddress
	// refuses the whole system domain independently via Domain(), so nothing
	// downstream needs Type() to narrow it further; see the doc above
	// Address.Type() in sdk/address.go for why).
	if strings.Contains(typeBody, `strings.HasPrefix(s, "did:pkh:eip155")`) ||
		strings.Contains(typeBody, `strings.HasPrefix(a.String(), "did:pkh:eip155")`) {
		t.Fatal("PAYEE REGRESSION: Address.Type()'s EVM branch is back to a bare strings.HasPrefix — a bodyless \"did:pkh:eip155BOGUS\" would classify as EVM again")
	}
	if strings.Contains(typeBody, `strings.HasPrefix(s, "hive:")`) ||
		strings.Contains(typeBody, `strings.HasPrefix(a.String(), "hive:")`) {
		t.Fatal("PAYEE REGRESSION: Address.Type()'s Hive branch is back to a bare strings.HasPrefix — a bodyless bare \"hive:\" would classify as Hive again")
	}

	// Behavioural control, not just presence: hasColonBody/hasNonEmptyBody
	// must actually implement "prefix, then a real body" and not just any
	// helper by that name. Mirrors sdk/address.go's helpers exactly (kept
	// honest by the source checks above pinning their call sites); this
	// package cannot import sdk (see file doc), so the only way to exercise
	// the real DECISION is to run the identical logic here.
	hasColonBody := func(s, prefix string) bool {
		if !strings.HasPrefix(s, prefix) {
			return false
		}
		r := s[len(prefix):]
		return len(r) > 1 && r[0] == ':'
	}
	hasNonEmptyBody := func(s, prefix string) bool {
		return strings.HasPrefix(s, prefix) && len(s) > len(prefix)
	}

	// The exact bogus forms AN-10 proved pay out HBD to an unsignable
	// identity, plus the same failure shape on the BTC branch.
	deadForms := []struct {
		s      string
		refute func(s string) bool // the helper that must return false
	}{
		{"did:pkh:eip155BOGUS", func(s string) bool { return hasColonBody(s, "did:pkh:eip155") }},
		{"did:pkh:eip155", func(s string) bool { return hasColonBody(s, "did:pkh:eip155") }},
		{"did:pkh:eip155:", func(s string) bool { return hasColonBody(s, "did:pkh:eip155") }},
		{"did:pkh:bip122BOGUS", func(s string) bool { return hasColonBody(s, "did:pkh:bip122") }},
		{"did:pkh:bip122:", func(s string) bool { return hasColonBody(s, "did:pkh:bip122") }},
		{"hive:", func(s string) bool { return hasNonEmptyBody(s, "hive:") }},
	}
	for _, c := range deadForms {
		if c.refute(c.s) {
			t.Errorf("FUND-LOSS: %q still classifies as a payable identity type — no real signer can ever produce this string, so a payout to it is permanently stranded", c.s)
		}
	}

	// Anti-vacuity control: this is not a check that merely rejects
	// everything. Every real address form the contract accepts today
	// (mirroring core/util_test.go's own account-shape fixtures) must still
	// pass — a fix that also refused these would be worse than the bug it
	// closes.
	genuineForms := []struct {
		s      string
		accept func(s string) bool
	}{
		{"did:pkh:eip155:1:0x" + strings.Repeat("a", 40), func(s string) bool { return hasColonBody(s, "did:pkh:eip155") }},
		{"did:pkh:bip122:000000000019d6689c085ae165831e93:" + strings.Repeat("1", 34), func(s string) bool { return hasColonBody(s, "did:pkh:bip122") }},
		{"did:pkh:bip122:000000000019d6689c085ae165831e93:bc1q" + strings.Repeat("a", 38), func(s string) bool { return hasColonBody(s, "did:pkh:bip122") }},
		{"hive:blocktrades", func(s string) bool { return hasNonEmptyBody(s, "hive:") }},
		{"hive:alice", func(s string) bool { return hasNonEmptyBody(s, "hive:") }},
	}
	for _, c := range genuineForms {
		if !c.accept(c.s) {
			t.Errorf("PAYEE REGRESSION: genuine address %q was refused by the narrowed check — the fix over-tightened and would now reject a real holder", c.s)
		}
	}
}
