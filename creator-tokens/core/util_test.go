package core

import (
	"strings"
	"testing"
)


// TestValidAccount_AcceptsEveryIdentityMagiCanProduce pins the account bound
// against the REAL identity shapes the chain hands a contract as `caller`,
// including the ones Magi does not accept YET.
//
// The bound was 96, which is six characters above the longest identity Magi
// supports today (a bech32 P2WPKH BTC DID at 90) and below the one it is about
// to (taproot at 110, deferred as "Phase 2" in go-vsc-node/lib/dids/btc.go).
// Nothing real was blocked — which is exactly why it was dangerous: the day
// taproot ships, every one of those holders would have been refused by THIS
// contract with a meaningless "invalid account", caused by a constant chosen in
// another repository when only Hive names existed.
//
// Lengths are asserted explicitly so the arithmetic in util.go's doc is checked
// by the machine rather than trusted.
func TestValidAccount_AcceptsEveryIdentityMagiCanProduce(t *testing.T) {
	const btcPrefix = "did:pkh:bip122:000000000019d6689c085ae165831e93:" // 48
	const ethPrefix = "did:pkh:eip155:1:"                                // 17

	cases := []struct {
		name    string
		account string
		wantLen int
	}{
		{"hive", "hive:blocktrades", 16},
		{"EVM", ethPrefix + "0x" + strings.Repeat("a", 40), 59},
		{"BTC P2PKH legacy", btcPrefix + strings.Repeat("1", 34), 82},
		{"BTC P2WPKH bech32", btcPrefix + "bc1q" + strings.Repeat("a", 38), 90},
		// Not accepted by Magi today; accepted HERE so this contract is never
		// the thing that blocks them when it is.
		{"BTC P2WSH bech32", btcPrefix + "bc1q" + strings.Repeat("a", 58), 110},
		{"BTC taproot P2TR", btcPrefix + "bc1p" + strings.Repeat("a", 58), 110},
	}
	for _, c := range cases {
		if len(c.account) != c.wantLen {
			t.Fatalf("%s: fixture is %d chars, expected %d — the arithmetic in util.go's doc is wrong, or this fixture is", c.name, len(c.account), c.wantLen)
		}
		if !validAccount(c.account) {
			t.Fatalf("%s (%d chars) rejected; MaxAccountLen is %d — a real chain identity cannot be refused by this contract", c.name, len(c.account), MaxAccountLen)
		}
	}
	// The bound is still a real bound, and the delimiter is still the actual
	// security control at any length.
	if validAccount(strings.Repeat("x", MaxAccountLen+1)) {
		t.Fatal("an over-length account was accepted — the sanity bound is gone")
	}
	if validAccount(btcPrefix + "bc1q" + strings.Repeat("a", 30) + "|forged") {
		t.Fatal("an account containing the state-key delimiter was accepted — that is the one real security property here")
	}
}
