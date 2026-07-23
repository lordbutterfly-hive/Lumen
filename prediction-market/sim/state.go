package sim

import (
	"math/big"
	"strconv"
	"strings"

	"hive-price-market/market"
)

// ---------------------------------------------------------------------------
// Read-only state accessors mirroring market/keys.go's key scheme + market/
// util.go's typed accessors.
//
// COUPLING WARNING (same pattern contract/main.go already uses for
// roundAsset(), see contract/main.go:152-167): the `market` package's key
// builders (rk, rkOutcomePool, rkStake, ...) and typed accessors (getStr,
// getU64, getMoney) are unexported, so a caller outside the package — the
// wasm contract layer, and now this simulator — can only read round state by
// duplicating the same key format against the public market.Store interface.
// This is a READ-ONLY duplication (no business logic, no writes bypassing
// market's own exported mutators) kept deliberately in sync with
// market/keys.go. If that format ever changes, this file needs the matching
// update — exactly the maintenance burden contract/main.go's own comment
// already documents and accepts.
// ---------------------------------------------------------------------------

func rdKey(id uint64, field string) string {
	return "rd|" + strconv.FormatUint(id, 10) + "|" + field
}
func opKey(id uint64, k int) string { return rdKey(id, "op|"+strconv.Itoa(k)) }
func stakeKey(id uint64, acct string, k int) string {
	return rdKey(id, "st|"+acct+"|"+strconv.Itoa(k))
}
func stakeTotalKey(id uint64, acct string) string { return rdKey(id, "stt|"+acct) }
func claimedKey(id uint64, acct string) string    { return rdKey(id, "cl|"+acct) }
func activeRoundKey(asset string) string          { return "active|" + asset }
func roundCountKey() string                       { return "round_count" }

func getStr(s market.Store, key string) string { v, _ := s.Get(key); return v }

func getU64(s market.Store, key string) uint64 {
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

func getMoney(s market.Store, key string) *big.Int {
	v, ok := s.Get(key)
	if !ok || v == "" {
		return big.NewInt(0)
	}
	n, ok := new(big.Int).SetString(v, 10)
	if !ok {
		return big.NewInt(0)
	}
	return n
}

func getBool01(s market.Store, key string) bool { return getStr(s, key) == "1" }

// RoundView is a read-only snapshot of a round's public state, assembled
// entirely from the Store via the key format above — never via unexported
// market internals.
type RoundView struct {
	ID      uint64
	Exists  bool
	State   string // market.StateOpen / StateSettled / StateVoid
	Asset   string
	N       int
	Strikes []uint64
	Lock    uint64
	Settle  uint64
	Grace   uint64
	FeeBps  uint64
	Label   string
	Creator string
	Unit    string

	RefPrice uint64

	// Populated once resolved.
	Winner     int
	Price      uint64
	Tick       uint64
	WRem, DRem *big.Int
	Owed       *big.Int
	VoidReason string
	Swept      bool

	Pool *big.Int
}

// ReadRound loads a RoundView. Exists=false if no round with this id has ever
// been created (state key absent).
func ReadRound(s market.Store, id uint64) RoundView {
	rv := RoundView{ID: id}
	stateVal, ok := s.Get(rdKey(id, "state"))
	if !ok {
		return rv
	}
	rv.Exists = true
	rv.State = stateVal
	rv.Asset = getStr(s, rdKey(id, "asset"))
	rv.N = int(getU64(s, rdKey(id, "n")))
	rv.Strikes = parseStrikes(getStr(s, rdKey(id, "strikes")))
	rv.Lock = getU64(s, rdKey(id, "lock"))
	rv.Settle = getU64(s, rdKey(id, "settle"))
	rv.Grace = getU64(s, rdKey(id, "grace"))
	rv.FeeBps = getU64(s, rdKey(id, "fb"))
	rv.Label = getStr(s, rdKey(id, "label"))
	rv.Creator = getStr(s, rdKey(id, "creator"))
	rv.Unit = getStr(s, rdKey(id, "unit"))
	rv.RefPrice = getU64(s, rdKey(id, "refprice"))
	rv.Pool = getMoney(s, rdKey(id, "pool"))

	if rv.State == market.StateSettled || rv.State == market.StateVoid {
		rv.Winner = int(getU64(s, rdKey(id, "win")))
		rv.Price = getU64(s, rdKey(id, "price"))
		rv.Tick = getU64(s, rdKey(id, "tick"))
		rv.WRem = getMoney(s, rdKey(id, "wrem"))
		rv.DRem = getMoney(s, rdKey(id, "drem"))
		rv.Owed = getMoney(s, rdKey(id, "owed"))
		rv.VoidReason = getStr(s, rdKey(id, "vr"))
		rv.Swept = getBool01(s, rdKey(id, "swept"))
	}
	return rv
}

func parseStrikes(raw string) []uint64 {
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]uint64, 0, len(parts))
	for _, p := range parts {
		n, err := strconv.ParseUint(p, 10, 64)
		if err != nil {
			return nil
		}
		out = append(out, n)
	}
	return out
}

// OutcomePool returns the total staked on outcome k of round id.
func OutcomePool(s market.Store, id uint64, k int) *big.Int { return getMoney(s, opKey(id, k)) }

// StakeOf returns acct's stake on outcome k of round id.
func StakeOf(s market.Store, id uint64, acct string, k int) *big.Int {
	return getMoney(s, stakeKey(id, acct, k))
}

// StakeTotalOf returns acct's total stake across all outcomes of round id.
func StakeTotalOf(s market.Store, id uint64, acct string) *big.Int {
	return getMoney(s, stakeTotalKey(id, acct))
}

// IsClaimed reports whether acct has already claimed/reclaimed round id.
func IsClaimed(s market.Store, id uint64, acct string) bool {
	return getBool01(s, claimedKey(id, acct))
}

// ActiveRoundID returns the currently-open round id for asset, if any.
func ActiveRoundID(s market.Store, asset string) (id uint64, ok bool) {
	v := getU64(s, activeRoundKey(asset))
	if v == 0 {
		return 0, false
	}
	return v - 1, true
}

// RoundCount returns the number of rounds ever created.
func RoundCount(s market.Store) uint64 { return getU64(s, roundCountKey()) }

// bucketFor mirrors market/util.go's unexported bucketFor exactly (same
// public formula: outcome k covers [strike[k-1], strike[k]); a price exactly
// on a strike belongs to the UPPER bucket). Needed so sim actors (sharp
// bettors, the keeper reading the "would-be winner") can reason about which
// bucket a price falls into using only exported information, without
// depending on unexported market internals.
func bucketFor(price uint64, strikes []uint64) int {
	for i, s := range strikes {
		if price < s {
			return i
		}
	}
	return len(strikes)
}

// mMulBpsDiv mirrors market/money.go's unexported mMulBpsDiv (floor(total *
// bps / 10000)) — trivial, public arithmetic, duplicated for the same reason
// as bucketFor above.
func mMulBpsDiv(total *big.Int, bps uint64) *big.Int {
	p := new(big.Int).Mul(total, new(big.Int).SetUint64(bps))
	return p.Div(p, big.NewInt(10000))
}
