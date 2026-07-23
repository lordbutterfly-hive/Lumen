// Package parse holds the WASM CONTRACT WRAPPER's flat-JSON payload reader
// and a handful of adjacent pure-value helpers, extracted verbatim out of
// ../main.go so they can actually be exercised by `go test` on any machine.
//
// WHY THIS PACKAGE EXISTS: ../main.go is package main in contract/, and every
// file in that directory (main.go itself) unconditionally imports
// creator-tokens/sdk, which imports creator-tokens/runtime — a package whose
// only source file is guarded by `//go:build gc.custom` (a build tag stock
// `go build`/`go test` never sets) and, even forced with that tag, uses
// TinyGo-specific compiler intrinsics (bodiless `//export llvm.wasm.*`
// functions, particular `//go:linkname` targets) that the mainline Go
// compiler rejects outright — this was verified directly, not assumed: both
// `go build ./contract/...` and `GOOS=wasip1 GOARCH=wasm go build
// -tags gc.custom ./contract/...` fail before a single test in that
// directory could ever run. That means NO file placed inside contract/ —
// however small, however sdk-free itself — can ever be compiled or tested by
// `go test`, because Go compiles every non-test file in a directory as one
// unit and ../main.go's sdk import alone is already fatal to that unit
// outside the TinyGo toolchain.
//
// This is why the logic here was moved OUT of main.go into its own sdk-free
// package rather than merely copy-pasted into a same-directory test file
// that could never run: ../main.go's jsonStr/jsonU64/parseBigDecimal/
// jsonEscape/nativeInt64 are now thin wrappers that call straight into this
// package (see the "Minimal flat-JSON payload reader" section there), so
// this is the ACTUAL implementation the wasm contract runs in production —
// not a stale duplicate that could silently drift the way ../main.go's own
// coreFaceKey/readFace duplicate core/keys.go's private key format (a
// pattern this package deliberately avoids repeating).
//
// The payload parser is where the frontend/contract mismatch bug lived: an
// unquoted JSON value for a string field (frontend sent a bare token instead
// of a quoted string) made every one of that shape's actions revert. Str
// below is the exact function responsible for refusing that input rather
// than silently misreading it — see TestStr_RejectsUnquotedValue.
package parse

import (
	"math/big"
	"strconv"
	"strings"
)

func isJSONSpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r'
}

// findKey returns the index just after the colon following `"key":` in a flat
// JSON object, or -1 if not found. Verbatim copy of contract/main.go's
// original findKey.
func findKey(payload, key string) int {
	pat := "\"" + key + "\""
	idx := strings.Index(payload, pat)
	if idx < 0 {
		return -1
	}
	i := idx + len(pat)
	for i < len(payload) && isJSONSpace(payload[i]) {
		i++
	}
	if i >= len(payload) || payload[i] != ':' {
		return -1
	}
	return i + 1
}

// Str extracts a quoted string field's raw contents from a flat JSON object.
// No backslash-escape decoding is performed beyond skipping past an escaped
// character while scanning for the closing quote. Missing, or present but NOT
// wrapped in double quotes (e.g. a bare token, a number, `true`), both
// resolve to "" — this is deliberate rejection, not a best-effort decode: a
// field this narrow scanner cannot positively confirm is a JSON string is
// treated as absent, and every caller in main.go either fails closed on an
// empty required field or lets core's own validation reject the resulting
// zero value. This is the exact function responsible for six frontend
// actions reverting when a payload sent an unquoted value for a string field
// — see the file doc and TestStr_RejectsUnquotedValue.
func Str(payload, key string) string {
	i := findKey(payload, key)
	if i < 0 {
		return ""
	}
	for i < len(payload) && isJSONSpace(payload[i]) {
		i++
	}
	if i >= len(payload) || payload[i] != '"' {
		return ""
	}
	i++
	start := i
	for i < len(payload) && payload[i] != '"' {
		if payload[i] == '\\' && i+1 < len(payload) {
			i++
		}
		i++
	}
	if i > len(payload) {
		return ""
	}
	return payload[start:i]
}

// U64 extracts an unquoted decimal integer field's value from a flat JSON
// object. Missing, malformed, or negative (a leading '-' simply fails to
// match any digit) all default to 0 — every caller in main.go either lets
// core's own validation reject the resulting zero/short value, or (face/cap)
// narrows it via i64FromU64 first.
func U64(payload, key string) uint64 {
	i := findKey(payload, key)
	if i < 0 {
		return 0
	}
	for i < len(payload) && isJSONSpace(payload[i]) {
		i++
	}
	start := i
	for i < len(payload) && payload[i] >= '0' && payload[i] <= '9' {
		i++
	}
	if i == start {
		return 0
	}
	n, err := strconv.ParseUint(payload[start:i], 10, 64)
	if err != nil {
		return 0
	}
	return n
}

// BigDecimal parses a base-10, non-negative big.Int money string exactly like
// core/money.go's (unexported) parseMoney. Duplicated (not imported) from
// core because the wasm wrapper cannot import unexported core helpers and
// must not modify core/ — keep in sync with core.parseMoney if that ever
// changes; this is the SAME duplication contract/main.go's own file header
// already documents and justifies for this exact function.
func BigDecimal(s string) (*big.Int, bool) {
	if s == "" {
		return nil, false
	}
	v, ok := new(big.Int).SetString(s, 10)
	if !ok || v.Sign() < 0 {
		return nil, false
	}
	return v, true
}

// NarrowInt64 reports whether v fits in an int64, returning (v.Int64(), true)
// when it does. A nil v narrows to (0, true), matching contract/main.go's
// nativeInt64 convention that an absent amount is zero, never an error.
// nativeInt64 itself wraps this and calls sdk.Abort on a false result — that
// half needs the live sdk and cannot be tested here, but the actual
// overflow-vs-truncate DECISION this narrowing makes is exactly what
// TestNarrowInt64_AbortsRatherThanTruncates proves: a *big.Int outside the
// int64 range is refused (ok=false), never silently wrapped/truncated to a
// different, wrong int64 value.
func NarrowInt64(v *big.Int) (int64, bool) {
	if v == nil {
		return 0, true
	}
	if !v.IsInt64() {
		return 0, false
	}
	return v.Int64(), true
}

// Escape minimally escapes backslash and double-quote characters for
// embedding a value in the hand-built JSON responses contract/main.go
// constructs. Not a general JSON string escaper — sufficient for the
// account-name/hash strings echoed there, and specifically responsible for
// making sure a malicious or merely unlucky account/hash value can never
// break out of the JSON string context it is embedded in and forge a
// sibling field — see TestEscape_CannotBreakOutOfStringContext, which proves
// this against the standard library's own json.Unmarshal, not just this
// package's own narrow reader.
func Escape(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '"' || c == '\\' {
			b.WriteByte('\\')
		}
		b.WriteByte(c)
	}
	return b.String()
}
