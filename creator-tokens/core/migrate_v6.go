package core

import (
	"math/big"
	"strconv"
	"strings"
)

// migrate_v6.go: the lazy unit migration (v6, OWNER RULING 2026-09-22; see
// params.go "TOKEN UNIT" and LUMEN-DOCS/MERITUM-V6-FRACTIONAL-TOKENS-2026-09-22.md D10).
//
// Before v6 every token-denominated value in state was a whole-token count.
// v6 stores UNITS (TokenScale per token). The two cannot be told apart by
// looking at a number, and holders cannot be enumerated on chain, so a
// one-shot migration would miss someone and a paused window would strand
// outflows. Instead every read or write of a token-denominated key passes
// through this Store wrapper, which converts the record it is about to touch
// the first time, marks it converted, and never touches it again:
//
//	holder-scoped  mb|<c>|<h>  bal|<h>|<c>  lots|<c>|<h>   flag u6|<c>|<h>
//	market-scoped  m|<c>|sup   m|<c>|cap                    flag m|<c>|u6
//	escrow-scoped  e|<c>|<seq> em|<c>|<seq> el|<c>|<seq>    the record's field
//	               count: 9 fields = tokens (pre-v6), 10 fields = units
//
// Everything else (reserve, fees, treasury, TWAP, acq clocks, ratings,
// counters, offerings, faces) is HBD or a block number and is not touched.
//
// The matured family keeps its exact name and encoding because magi-market
// reads `bal|<holder>|<creator>` raw (keys.go); only its unit meaning changes.
//
// The wrapper is the ONLY place that knows about pre-v6 state. core's own
// code reads and writes units everywhere; tests that start from a legacy
// fixture wrap their MemStore with WrapUnits, and the wasm wrapper wraps the
// sdk store once at boot (contract/main.go).
type unitsStore struct{ inner Store }

// WrapUnits returns s behind the lazy migration. Idempotent.
func WrapUnits(s Store) Store {
	if _, already := s.(*unitsStore); already {
		return s
	}
	return &unitsStore{inner: s}
}

func (u *unitsStore) Get(key string) (string, bool) {
	u.ensure(key)
	return u.inner.Get(key)
}

// Set and Delete also convert first: a write of units into `mb|c|h` for a
// holder whose `bal|` and `lots|` are still tokens would leave that holder
// half-migrated, and the flag would then never be set.
func (u *unitsStore) Set(key, value string) {
	u.ensure(key)
	u.inner.Set(key, value)
}

func (u *unitsStore) Delete(key string) {
	u.ensure(key)
	u.inner.Delete(key)
}

var unitsScale = big.NewInt(TokenScale)

func (u *unitsStore) ensure(key string) {
	switch {
	case strings.HasPrefix(key, "mb|"):
		if c, h, ok := splitTwo(key[3:]); ok {
			u.ensureHolder(c, h)
		}
	case strings.HasPrefix(key, "bal|"):
		if h, c, ok := splitTwo(key[4:]); ok {
			u.ensureHolder(c, h)
		}
	case strings.HasPrefix(key, "lots|"):
		if c, h, ok := splitTwo(key[5:]); ok {
			u.ensureHolder(c, h)
		}
	case strings.HasPrefix(key, "m|") && (strings.HasSuffix(key, "|sup") || strings.HasSuffix(key, "|cap")):
		c := key[2 : len(key)-4]
		if c != "" {
			u.ensureMarket(c)
		}
	case strings.HasPrefix(key, "e|"):
		if c, seq, ok := splitSeq(key[2:]); ok {
			u.ensureEscrow(c, seq)
		}
	case strings.HasPrefix(key, "em|"):
		if c, seq, ok := splitSeq(key[3:]); ok {
			u.ensureEscrow(c, seq)
		}
	case strings.HasPrefix(key, "el|"):
		if c, seq, ok := splitSeq(key[3:]); ok {
			u.ensureEscrow(c, seq)
		}
	}
}

// splitTwo splits "<a>|<b>" at the FIRST pipe. Account ids never contain a
// pipe (validAccount), so the first pipe is the only one.
func splitTwo(rest string) (string, string, bool) {
	i := strings.IndexByte(rest, '|')
	if i <= 0 || i == len(rest)-1 {
		return "", "", false
	}
	return rest[:i], rest[i+1:], true
}

func splitSeq(rest string) (string, uint64, bool) {
	c, tail, ok := splitTwo(rest)
	if !ok {
		return "", 0, false
	}
	seq, err := strconv.ParseUint(tail, 10, 64)
	if err != nil {
		return "", 0, false
	}
	return c, seq, true
}

func kUnitsHolder(c, h string) string { return "u6|" + c + "|" + h }
func kUnitsMarket(c string) string    { return mk(c, "u6") }

func scaleMoneyString(v string) (string, bool) {
	n, ok := new(big.Int).SetString(v, 10)
	if !ok || n.Sign() < 0 {
		return "", false
	}
	return n.Mul(n, unitsScale).String(), true
}

// scaleLotsString multiplies every cohort's count by TokenScale, keeping the
// acquisition blocks exactly. Same "count,acq;count,acq" layout setLots writes.
func scaleLotsString(raw string) string {
	var b strings.Builder
	first := true
	for _, part := range strings.Split(raw, ";") {
		if part == "" {
			continue
		}
		fields := strings.SplitN(part, ",", 2)
		if len(fields) != 2 {
			continue
		}
		cnt, ok := new(big.Int).SetString(fields[0], 10)
		if !ok || cnt.Sign() <= 0 {
			continue
		}
		if !first {
			b.WriteByte(';')
		}
		first = false
		b.WriteString(cnt.Mul(cnt, unitsScale).String())
		b.WriteByte(',')
		b.WriteString(fields[1])
	}
	return b.String()
}

func (u *unitsStore) ensureHolder(c, h string) {
	flag := kUnitsHolder(c, h)
	if _, done := u.inner.Get(flag); done {
		return
	}
	if v, ok := u.inner.Get(kBal(c, h)); ok && v != "" {
		if scaled, ok := scaleMoneyString(v); ok {
			u.inner.Set(kBal(c, h), scaled)
		}
	}
	if v, ok := u.inner.Get(kMatured(h, c)); ok && v != "" {
		if n, valid := leToU64([]byte(v)); valid && n > 0 {
			scaled := new(big.Int).Mul(new(big.Int).SetUint64(n), unitsScale)
			if scaled.IsUint64() {
				u.inner.Set(kMatured(h, c), string(u64ToLE(scaled.Uint64())))
			}
		}
	}
	if v, ok := u.inner.Get(kLots(c, h)); ok && v != "" {
		if scaled := scaleLotsString(v); scaled != "" {
			u.inner.Set(kLots(c, h), scaled)
		} else {
			u.inner.Delete(kLots(c, h))
		}
	}
	u.inner.Set(flag, "1")
}

func (u *unitsStore) ensureMarket(c string) {
	flag := kUnitsMarket(c)
	if _, done := u.inner.Get(flag); done {
		return
	}
	for _, key := range []string{kSupply(c), kCap(c)} {
		if v, ok := u.inner.Get(key); ok && v != "" {
			if scaled, ok := scaleMoneyString(v); ok {
				u.inner.Set(key, scaled)
			}
		}
	}
	u.inner.Set(flag, "1")
}

// ensureEscrow converts a pre-v6 escrow record (9 fields) and its two side
// keys in one step, keyed on the record's own field count so no flag is
// needed: packEscrow writes 10 fields, and a 10-field record is never touched.
func (u *unitsStore) ensureEscrow(c string, seq uint64) {
	raw, ok := u.inner.Get(kEscrow(c, seq))
	if !ok || raw == "" {
		return
	}
	p := strings.SplitN(raw, "|", escrowFieldsV6)
	if len(p) != escrowFieldsV5 {
		return
	}
	credits, ok1 := scaleMoneyString(p[1])
	commission, ok2 := scaleMoneyString(p[4])
	if !ok1 || !ok2 {
		return
	}
	// asker|credits|deadline|status|commissionCredits|acqBlock|offeringID|units|contentHash|answerHash
	rec := strings.Join([]string{p[0], credits, p[2], p[3], commission, p[5], p[6], escrowUnitsMarker, p[7], p[8]}, "|")
	u.inner.Set(kEscrow(c, seq), rec)
	if v, ok := u.inner.Get(kEscrowMaturedLeg(c, seq)); ok && v != "" {
		if scaled, ok := scaleMoneyString(v); ok {
			u.inner.Set(kEscrowMaturedLeg(c, seq), scaled)
		}
	}
	if v, ok := u.inner.Get(kEscrowLots(c, seq)); ok && v != "" {
		if scaled := scaleLotsString(v); scaled != "" {
			u.inner.Set(kEscrowLots(c, seq), scaled)
		} else {
			u.inner.Delete(kEscrowLots(c, seq))
		}
	}
}
