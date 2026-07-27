package core

import (
	"math/big"
	"strconv"
)

// Typed state accessors. A missing key and a key set to "" both read back as the
// zero value, which is what every caller wants.

func getStr(s Store, key string) string {
	v, _ := s.Get(key)
	return v
}

func setStr(s Store, key, val string) { s.Set(key, val) }

func getU64(s Store, key string) uint64 {
	v, ok := s.Get(key)
	if !ok || v == "" {
		return 0
	}
	n, err := strconv.ParseUint(v, 10, 64)
	if err != nil {
		return 0
	}
	return n
}

func setU64(s Store, key string, n uint64) {
	s.Set(key, strconv.FormatUint(n, 10))
}

// getMoney returns the stored amount, or zero when unset. A malformed value is
// treated as zero rather than panicking; every write goes through setMoney, so a
// malformed read means state corruption, which the invariant sweep catches.
func getMoney(s Store, key string) *big.Int {
	v, ok := s.Get(key)
	if !ok || v == "" {
		return mZero()
	}
	n, err := parseMoney(v)
	if err != nil {
		return mZero()
	}
	return n
}

// setMoney stores a money value. PANICS on a negative — loudly, by design
// (RULING G hardening, 2026-07-21): before this guard, a negative write was
// STORED as "-123", and getMoney's parseMoney error path then read it back
// as ZERO — so a single buggy negative write anywhere would have silently
// WIPED a reserve, a pot, or a balance, with no error at any layer. A panic
// here is the loud alternative: in the wasm runtime it traps and reverts the
// whole transaction (nothing mutates), and in tests it fails the run at the
// exact write site. No reachable code path can trigger it — every subtract
// routes through mSub/subMoney, which error on underflow before a negative
// can exist, and every add starts from a parseMoney-validated non-negative —
// so this is defense-in-depth against FUTURE arithmetic bugs, in the one
// direction (silent fund wipe) this package can never accept.
func setMoney(s Store, key string, v *big.Int) {
	if v.Sign() < 0 {
		panic("setMoney: negative amount for key " + key + ": " + v.String())
	}
	s.Set(key, v.String())
}

func addMoney(s Store, key string, delta *big.Int) {
	setMoney(s, key, mAdd(getMoney(s, key), delta))
}

// subMoney subtracts, erroring on underflow rather than storing a negative.
func subMoney(s Store, key string, delta *big.Int) error {
	cur := getMoney(s, key)
	next, err := mSub(cur, delta)
	if err != nil {
		return err
	}
	setMoney(s, key, next)
	return nil
}

// validAccount validates an address as the CHAIN actually supplies it.
//
// CRITICAL HISTORY — do not "tighten" this back up without reading it:
// the first version of this function enforced a bare Hive account name,
// [a-z0-9.-]{3,16}. That is NOT what a contract receives. go-vsc-node builds the
// execution caller from RequiredAuths[0] (modules/state-processing/transactions.go
// :122-126) and prefixes every Hive L1 auth with "hive:" (state_engine.go:985), so
// the real value is "hive:username" — which failed on the colon AND on the length
// bound. Every Register, Prepay, RefundHolder and TransferCredits would have
// reverted for every real user: the contract would have been dead on arrival on
// mainnet, while passing 145 local tests that all used bare names.
// Magi also addresses EVM accounts (0x…), contracts, the system, and BLS keys —
// see sdk/address.go's AddressType — so any shape rule keyed to Hive alone is
// wrong by construction.
//
// What this function is actually FOR is narrower and worth stating plainly: state
// keys are built by concatenation ("bal|"+creator+"|"+holder), so a value
// containing the '|' delimiter could forge another account's key. THAT is the
// safety property. Everything else here is a sanity bound, not a security control
// — authenticating the caller is the chain's job, not ours, and the proven
// hive-price-market contract validates nothing beyond non-emptiness for exactly
// this reason.
// MaxAccountLen — the sanity bound on an account identifier, derived from the
// LONGEST identity Magi can actually hand this contract as a caller, with real
// headroom. It was 96, which is SIX characters above the longest identity Magi
// supports today and BELOW the one it is about to.
//
// The arithmetic, so the next person can re-derive it instead of trusting this
// comment (measured against go-vsc-node/lib/dids/btc.go's own prefixes):
//
//	Hive               "hive:" + <=16                              =  21
//	EVM     did:pkh:eip155:1:      + 0x + 40 hex                    =  59
//	BTC     did:pkh:bip122:<32-hex chain id>: is a 48-char prefix, so:
//	          P2PKH "1…" / P2SH "3…"      (34)                      =  82
//	          P2WPKH "bc1q…"              (42)                      =  90  <- longest SUPPORTED today
//	          P2WSH  "bc1q…"              (62)                      = 110  <- REJECTED by 96
//	          Taproot "bc1p…" (P2TR)      (62)                      = 110  <- REJECTED by 96
//
// Magi's DID parser currently accepts only P2PKH, P2SH and P2WPKH (btc.go's own
// type switch), and rejects taproot with a literal "not supported, Phase 2".
// So at 96 nothing REAL was blocked — and that is exactly why it was dangerous:
// the day Magi ships Phase 2 taproot, every one of those users would have been
// refused by THIS contract with a meaningless "invalid account", and the cause
// would have been a constant in a different repository chosen when only Hive
// names existed. Taproot is already the default in several major wallets, so
// that day is a question of when.
//
// 160 clears every form above with room for a longer future address encoding,
// and is still a real bound: it is a sanity limit on state-key size, never a
// security control. The security property is the '|' rejection below — state
// keys are built by concatenation, so a delimiter in an account name could
// forge another account's key. Length has nothing to do with that.
const MaxAccountLen = 160

func validAccount(a string) bool {
	if len(a) == 0 || len(a) > MaxAccountLen {
		return false
	}
	for i := 0; i < len(a); i++ {
		c := a[i]
		// Printable ASCII only, and never the key delimiter.
		if c == '|' || c < 0x20 || c > 0x7e {
			return false
		}
	}
	return true
}
