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
func (a Address) Type() AddressType {
	if strings.HasPrefix(a.String(), "did:pkh:eip155") {
		return AddressTypeEVM
	} else if strings.HasPrefix(a.String(), "did:pkh:bip122") {
		return AddressTypeBTC
	} else if strings.HasPrefix(a.String(), "hive:") {
		return AddressTypeHive
	} else if strings.HasPrefix(a.String(), "system:") {
		return AddressTypeSystem
	} else {
		return AddressTypeUnknown
	}
}

func (a Address) IsValid() bool {
	if a.Type() == AddressTypeUnknown {
		return false
	}
	return true
}
