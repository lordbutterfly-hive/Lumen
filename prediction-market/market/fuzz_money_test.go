package market

import (
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// PRUNED Phase-1 mechanical search, agent A8 — money string parser fuzz.
//
// market/money.go's parseMoney is the ONLY money-string parser reachable
// under host `go test`. There is a byte-for-byte-identical duplicate,
// parseBigDecimal, in contract/main.go (package main, comment there says
// "exactly like market/money.go's (unexported) parseMoney... keep in sync").
// That copy is NOT reachable here: contract/ imports hive-price-market/sdk,
// which imports hive-price-market/runtime, which is gated by a `//go:build
// gc.custom` constraint that only TinyGo sets — `go build ./contract/...` /
// `go vet ./contract/...` both fail on host Go with "build constraints
// exclude all Go files in .../runtime". See COVERAGE note in the final
// report for the manual diff confirming the two implementations are
// call-for-call identical (both are a thin wrapper over
// big.Int.SetString(s,10) + Sign()<0 rejection), so this fuzz result is
// logic-equivalent evidence for parseBigDecimal too, but NOT literal
// coverage of that copy.
// ---------------------------------------------------------------------------

func FuzzParseMoney(f *testing.F) {
	seeds := []string{
		"0", "1000", "1", "01", "007",
		"999999999999999999999999999999999999999999",
		"-1", "-0", "",
		"abc", "1e10", "1.5", "1,000",
		" 1000", "1000 ", " 1000 ", "+1000",
		"0x10", "0b10",
		"18446744073709551616",             // 2^64, beyond uint64 (must still work, big.Int)
		"340282366920938463463374607431768211456", // 2^128
		strings.Repeat("9", 1000),           // very long digit string
		strings.Repeat("0", 500) + "1",      // long leading zeros
		"\x00", "\n1000", "1000\n", "\t1000",
		"NaN", "Infinity", "1_000",
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, s string) {
		v, err := parseMoney(s)
		if err != nil {
			// Any rejection is acceptable — the invariant under fuzz is
			// "never panic", not "accept everything".
			if v != nil {
				t.Fatalf("parseMoney(%q) returned a non-nil value %s ALONGSIDE an error %v", s, v, err)
			}
			return
		}
		if v == nil {
			t.Fatalf("parseMoney(%q) returned (nil, nil) — no error but no value", s)
		}
		// Money is never negative — mirrors magi-market's guarantee.
		if v.Sign() < 0 {
			t.Fatalf("parseMoney(%q) accepted a NEGATIVE value %s with no error", s, v)
		}
		// Round-trip: re-parsing the canonical decimal string must reproduce
		// the same value exactly (no silent truncation/precision loss).
		back, err2 := parseMoney(v.String())
		if err2 != nil {
			t.Fatalf("round-trip failed for input %q: v=%s, re-parsing v.String() errored: %v", s, v, err2)
		}
		if back.Cmp(v) != 0 {
			t.Fatalf("round-trip MISMATCH for input %q: v=%s, back=%s", s, v, back)
		}
	})
}
