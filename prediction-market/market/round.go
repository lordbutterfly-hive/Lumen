package market

import (
	"math/big"
	"strconv"
	"strings"
)

// Typed state accessors over a Store.

func getStr(s Store, key string) string { v, _ := s.Get(key); return v }
func setStr(s Store, key, val string)   { s.Set(key, val) }

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
func setU64(s Store, key string, n uint64) { s.Set(key, strconv.FormatUint(n, 10)) }

func getMoney(s Store, key string) *big.Int {
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
func setMoney(s Store, key string, v *big.Int) { s.Set(key, v.String()) }
func addMoney(s Store, key string, delta *big.Int) {
	setMoney(s, key, mAdd(getMoney(s, key), delta))
}

// Global helpers.

func isOwner(s Store, caller string) bool {
	return caller != "" && getStr(s, kOwner()) == caller
}
func isPaused(s Store) bool { return getStr(s, kPaused()) == "1" }
func feeBps(s Store) uint64 { return getU64(s, kFeeBps()) }

// Round helpers.

func roundExists(s Store, id uint64) bool {
	_, ok := s.Get(rk(id, "state"))
	return ok
}
func roundState(s Store, id uint64) string { return getStr(s, rk(id, "state")) }
func roundN(s Store, id uint64) int         { return int(getU64(s, rk(id, "n"))) }

// decOwed reduces a round's outstanding staker-owed escrow ("owed") by amt,
// floored at 0. Every claim/refund/reclaim decrements it; when it reaches 0
// everyone has been paid. Any residue left after the claim window is what
// sweepUnclaimed sends to the DHF. Floored so this secondary accounting counter
// can never break a real payout even under an unexpected over-decrement.
func decOwed(s Store, id uint64, amt *big.Int) {
	nv := new(big.Int).Sub(getMoney(s, rk(id, "owed")), amt)
	if nv.Sign() < 0 {
		nv = big.NewInt(0)
	}
	setMoney(s, rk(id, "owed"), nv)
}

// roundStrikes returns the N-1 sorted strike boundaries (bps).
func roundStrikes(s Store, id uint64) []uint64 {
	raw := getStr(s, rk(id, "strikes"))
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

// bucketFor returns the outcome index a price falls into, given sorted strikes.
// A price exactly on a strike belongs to the UPPER bucket (deterministic,
// consensus-safe): outcome k covers [strike[k-1], strike[k]).
func bucketFor(price uint64, strikes []uint64) int {
	for i, s := range strikes {
		if price < s {
			return i
		}
	}
	return len(strikes) // last bucket, above the top strike
}
