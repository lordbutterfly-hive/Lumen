package sdk

import "strings"

type Intent struct {
	Type string            `json:"type"`
	Args map[string]string `json:"args"`
}

type Sender struct {
	Address              Address   `json:"id"`
	RequiredAuths        []Address `json:"required_auths"`
	RequiredPostingAuths []Address `json:"required_posting_auths"`
}

type ContractCallOptions struct {
	Intents []Intent `json:"intents,omitempty"`
}

type AddressDomain string

const (
	AddressDomainUser     AddressDomain = "user"
	AddressDomainContract AddressDomain = "contract"
	AddressDomainSystem   AddressDomain = "system"
)

type AddressType string

const (
	AddressTypeEVM     AddressType = "evm"
	AddressTypeBTC     AddressType = "btc"
	AddressTypeHive    AddressType = "hive"
	AddressTypeSystem  AddressType = "system"
	AddressTypeBLS     AddressType = "bls"
	AddressTypeUnknown AddressType = "unknown"
)

type Address string

func (a Address) String() string {
	return string(a)
}

func (a Address) Domain() AddressDomain {
	if strings.HasPrefix(a.String(), "system:") {
		return AddressDomainSystem
	}
	if strings.HasPrefix(a.String(), "contract:") {
		return AddressDomainContract
	}
	return AddressDomainUser
}

// Type classifies a payee address. Only IsValid consumes it, and only from the
// two payee gates in ../contract/main.go (`transfer`'s `to`, `refundHolder`'s
// `holder`), so an identity form missing from this switch is not merely
// unclassified — it is REFUSED as a recipient.
//
// did:pkh:bip122 (2026-07-28): Bitcoin was absent here, so every BTC DID fell
// to Unknown and IsValid() was false for it. Two consequences, both real:
// a BTC holder could never be sent credits, and — worse — the permissionless
// RefundHolder push could never sweep them during a wind-down. Since
// CloseIfDrained requires supply == 0 (core/refund.go), a single dormant BTC
// holder would pin supply above zero forever, so the market could never reach
// CLOSED and the creator could never re-register. The victim there is the
// CREATOR, not the holder who wandered off.
//
// The gate was over-restrictive rather than protective: the node itself
// accepts a BTC DID as a transfer destination (ExecuteTransfer rejects only
// `system:` prefixes), so nothing downstream needed this refusal.
//
// Deliberately a prefix test and NOT the host's verify_address hostcall: the
// contract does not bind that import, and the host version is network-aware,
// which would make this contract reject the wrong-network BTC form and drag
// the testnet/mainnet split into consensus-critical contract state.
//
// A BARE PREFIX TEST WAS NOT ENOUGH (2026-08-19, finding F6). Before this, the
// EVM and Hive branches were `strings.HasPrefix` alone with no requirement on
// what follows the prefix, so "did:pkh:eip155BOGUS" (no colon-delimited
// chain-id/address body at all) and a bare "hive:" (no account name) both
// classified as a payable identity. Type() feeds IsValid(), which is exactly
// what isPayableAddress (../contract/main.go) gates transfer's `to`,
// safeTransferFrom's `to` and refundHolder's `holder` on — so those two
// strings were accepted as payout destinations, and the permissionless
// RefundHolder wind-down sweep paid real HBD to them. Neither string is a
// shape any real signer can ever produce: go-vsc-node's ParseEthDID requires
// the exact prefix "did:pkh:eip155:1:" plus a valid hex address, and a Hive
// account name can never be empty (see ../core/util.go's validAccount
// history for the same lesson about trusting a bare prefix). Once value
// lands there, no msg.required_auths entry can ever equal the destination
// string, so it is a one-way sink — permanently stranded, exactly like the
// `system:`-domain case isPayableAddress already guards against.
//
// The fix is a pure narrowing, not a new validation scheme. did:pkh:eip155
// and did:pkh:bip122 are bare prefixes with NO trailing colon of their own
// (the colon belongs to the chain-id that follows, e.g. "did:pkh:eip155:1:
// 0x…" — see ../core/util.go's MaxAccountLen arithmetic for the exact
// shapes), so "did:pkh:eip155BOGUS" would slip past a check that only asked
// for "one more character": it has one, it is just not a body, it is a typo
// glued onto the prefix. hasColonBody rules that out by requiring the
// colon-delimited chain-id to actually be there. "hive:" already ends in its
// own colon, so hasNonEmptyBody — one more character, nothing more — is
// enough: a Hive account name has no further required delimiter.
//
// Every previously-valid address with a real body (did:pkh:eip155:1:0x…,
// did:pkh:bip122:<chain>:…, hive:<name>) still classifies identically —
// see ../core/payee_address_test.go's TestPayee_BodylessPrefixIsNotAValidRecipient,
// whose genuine-form fixtures mirror ../core/util_test.go's own
// account-shape fixtures (this package cannot host its own _test.go: it
// imports ../runtime, which is wasm-only, so the regression guard for this
// function lives in core instead — see that file's header comment). Only the
// bodyless/malformed forms flip from their old (wrong) type to Unknown.
// `system:` deliberately keeps the original bare-prefix test: isPayableAddress
// already refuses the whole system domain via Domain(), regardless of what
// Type() reports for it, so narrowing it here would add nothing and risks
// confusing the two independent guards.
func (a Address) Type() AddressType {
	s := a.String()
	if hasColonBody(s, "did:pkh:eip155") {
		return AddressTypeEVM
	} else if hasColonBody(s, "did:pkh:bip122") {
		return AddressTypeBTC
	} else if hasNonEmptyBody(s, "hive:") {
		return AddressTypeHive
	} else if strings.HasPrefix(s, "system:") {
		return AddressTypeSystem
	} else {
		return AddressTypeUnknown
	}
}

// hasColonBody reports whether s is exactly `prefix` followed by ":" and at
// least one more character — the "prefix:chain-id:…" shape every did:pkh:X
// DID this contract accepts actually has. A bare strings.HasPrefix(s, prefix)
// also matches "did:pkh:eip155BOGUS" (text glued directly onto the prefix,
// no colon, no chain-id, no address) and "did:pkh:eip155" on its own — both
// unsignable, both what this refuses.
func hasColonBody(s, prefix string) bool {
	if !strings.HasPrefix(s, prefix) {
		return false
	}
	rest := s[len(prefix):]
	return len(rest) > 1 && rest[0] == ':'
}

// hasNonEmptyBody reports whether s starts with prefix (already
// colon-terminated) AND has at least one character beyond it — i.e. prefix
// alone does not count. This is what refuses bare "hive:": an empty Hive
// account name.
//
// Neither helper parses or validates what comes after the prefix (chain-id
// shape, hex length, bech32 checksum, Hive account-name charset) — that would
// duplicate go-vsc-node's own DID/account parsing and could reject a real
// address on a rule this contract got slightly wrong. The one thing this
// contract's own state depends on is that the string is not a bare, bodyless
// (or body-less-but-for-garbage) prefix, because that is the specific shape
// RefundHolder proved unsignable and un-refundable.
func hasNonEmptyBody(s, prefix string) bool {
	return strings.HasPrefix(s, prefix) && len(s) > len(prefix)
}

func (a Address) IsValid() bool {
	if a.Type() == AddressTypeUnknown {
		return false
	}
	return true
}
