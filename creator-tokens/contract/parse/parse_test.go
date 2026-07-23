package parse

import (
	"encoding/json"
	"math/big"
	"testing"
)

// ---------------------------------------------------------------------------
// Str — the payload parser. This is where the frontend/contract mismatch bug
// lived: a payload field sent as a bare/unquoted JSON value (rather than a
// quoted string) must be REFUSED, not misread as if it had been quoted, and
// not allowed to smuggle a differently-typed value through as if it were the
// field's real content.
// ---------------------------------------------------------------------------

func TestStr_RejectsUnquotedValue(t *testing.T) {
	cases := []struct {
		name    string
		payload string
	}{
		{"bare identifier", `{"creator":alice}`},
		{"bare number", `{"creator":12345}`},
		{"bare true", `{"creator":true}`},
		{"bare null", `{"creator":null}`},
		{"unquoted with trailing fields", `{"creator":alice,"amount":"5"}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Str(c.payload, "creator")
			if got != "" {
				t.Fatalf("Str(%q, \"creator\") = %q, want \"\" (an unquoted value must be rejected, never misread)", c.payload, got)
			}
		})
	}
}

func TestStr_AcceptsProperlyQuotedValue(t *testing.T) {
	got := Str(`{"creator":"alice","amount":"5"}`, "creator")
	if got != "alice" {
		t.Fatalf("Str = %q, want %q", got, "alice")
	}
}

func TestStr_MissingKeyIsEmpty(t *testing.T) {
	if got := Str(`{"other":"x"}`, "creator"); got != "" {
		t.Fatalf("Str on a missing key = %q, want \"\"", got)
	}
	if got := Str(``, "creator"); got != "" {
		t.Fatalf("Str on an empty payload = %q, want \"\"", got)
	}
}

// TestStr_UnterminatedStringDoesNotOverrun documents actual (inherited,
// unchanged) behavior rather than an assumption: Str is a narrow scanner, not
// a JSON validator. Given no closing quote, it scans to the end of the
// payload string and returns whatever it collected — it does NOT require a
// closing quote to return a value, and it does NOT read past len(payload).
// This is a real, minor finding (reported separately, not something this
// extraction changed or was asked to fix): a payload truncated exactly
// inside a quoted value is not rejected as malformed, it is silently
// accepted with the truncated tail as the field's value. Bounded and
// memory-safe either way — the loop's own `i < len(payload)` guard is what
// this test actually protects against regressing.
func TestStr_UnterminatedStringDoesNotOverrun(t *testing.T) {
	got := Str(`{"creator":"alice`, "creator")
	if got != "alice" {
		t.Fatalf("Str on an unterminated quoted value = %q, want %q (scans to end of payload, does not require a closing quote — see the finding note above this test)", got, "alice")
	}
}

func TestStr_HandlesEscapedQuoteInsideValue(t *testing.T) {
	// `\"` inside the value must not be mistaken for the closing quote.
	got := Str(`{"hash":"a\"b"}`, "hash")
	if got != `a\"b` {
		t.Fatalf("Str with an escaped quote = %q, want %q (raw, undecoded)", got, `a\"b`)
	}
}

// ---------------------------------------------------------------------------
// U64
// ---------------------------------------------------------------------------

func TestU64_HappyPath(t *testing.T) {
	if got := U64(`{"periods":7}`, "periods"); got != 7 {
		t.Fatalf("U64 = %d, want 7", got)
	}
}

func TestU64_NegativeAndGarbageDefaultToZero(t *testing.T) {
	cases := []string{
		`{"periods":-5}`,  // leading '-' matches no digit -> 0
		`{"periods":"7"}`, // quoted, not a bare integer -> 0
		`{"periods":abc}`, // not numeric at all -> 0
		`{"other":7}`,     // missing key -> 0
		``,                // empty payload -> 0
	}
	for _, payload := range cases {
		if got := U64(payload, "periods"); got != 0 {
			t.Fatalf("U64(%q) = %d, want 0", payload, got)
		}
	}
}

// ---------------------------------------------------------------------------
// BigDecimal — reject empty/negative/garbage; accept well-formed decimals.
// ---------------------------------------------------------------------------

func TestBigDecimal_RejectsEmptyNegativeGarbage(t *testing.T) {
	cases := []string{
		"",      // empty
		"-1",    // negative
		"abc",   // garbage
		"1.5",   // decimal point, not a base-10 integer
		"1e9",   // exponent form
		"0x10",  // hex form (base 10 parser must refuse the 'x')
		" 5",    // leading space
		"5 ",    // trailing space
		"5,000", // thousands separator
	}
	for _, s := range cases {
		if v, ok := BigDecimal(s); ok {
			t.Fatalf("BigDecimal(%q) = (%v, true), want ok=false", s, v)
		}
	}
}

// "-0" is intentionally ACCEPTED, as zero: SetString("-0",10) parses to the
// value 0, and 0.Sign() == 0, not < 0, so the negativity guard does not
// reject it — mathematically correct (negative zero is zero) and exactly
// the same behavior core/money.go's parseMoney has, since BigDecimal is a
// deliberate duplicate of it (see the file doc). Not a gap: a "-0" payment
// is indistinguishable from a "0" payment and every caller already rejects a
// zero amount on its own separate business-logic check downstream.
func TestBigDecimal_NegativeZeroIsAcceptedAsZero(t *testing.T) {
	v, ok := BigDecimal("-0")
	if !ok {
		t.Fatalf(`BigDecimal("-0") rejected, want accepted as zero`)
	}
	if v.Sign() != 0 {
		t.Fatalf(`BigDecimal("-0") = %s, want exactly 0`, v)
	}
}

func TestBigDecimal_AcceptsWellFormed(t *testing.T) {
	cases := []struct {
		in   string
		want int64
	}{
		{"0", 0},
		{"1", 1},
		{"1000000", 1000000},
	}
	for _, c := range cases {
		v, ok := BigDecimal(c.in)
		if !ok {
			t.Fatalf("BigDecimal(%q) rejected, want accepted", c.in)
		}
		if v.Cmp(big.NewInt(c.want)) != 0 {
			t.Fatalf("BigDecimal(%q) = %s, want %d", c.in, v, c.want)
		}
	}
}

func TestBigDecimal_HugeValueBeyondInt64StillParses(t *testing.T) {
	// BigDecimal itself has no int64 ceiling — that narrowing is
	// NarrowInt64's job, tested separately. A huge but well-formed decimal
	// string must still parse here.
	huge := "123456789012345678901234567890"
	v, ok := BigDecimal(huge)
	if !ok {
		t.Fatalf("BigDecimal(%q) rejected a huge but well-formed decimal", huge)
	}
	if v.String() != huge {
		t.Fatalf("BigDecimal(%q) = %s, want it echoed back exactly", huge, v.String())
	}
}

// ---------------------------------------------------------------------------
// NarrowInt64 — the exact decision contract/main.go's nativeInt64 makes
// before calling sdk.Abort. Must REFUSE (ok=false) an out-of-range amount,
// never silently wrap/truncate it into a different, wrong in-range value.
// ---------------------------------------------------------------------------

func TestNarrowInt64_AbortsRatherThanTruncates(t *testing.T) {
	// One past math.MaxInt64: a naive truncating cast (e.g. via a modular
	// uint64->int64 reinterpretation) would silently wrap this to a large
	// NEGATIVE int64 rather than refusing it. NarrowInt64 must refuse.
	overflow := new(big.Int).Add(big.NewInt(0).SetInt64(9223372036854775807), big.NewInt(1)) // math.MaxInt64 + 1
	if n, ok := NarrowInt64(overflow); ok {
		t.Fatalf("NarrowInt64(MaxInt64+1) = (%d, true), want ok=false (must abort, not truncate)", n)
	}

	// Far beyond int64 entirely (a 128-bit-scale value) — same requirement,
	// with a much larger margin so a subtler truncation bug (e.g. only the
	// low 64 bits surviving a bad cast) would also be caught.
	wayOver := new(big.Int).Lsh(big.NewInt(1), 100) // 2^100
	if n, ok := NarrowInt64(wayOver); ok {
		t.Fatalf("NarrowInt64(2^100) = (%d, true), want ok=false", n)
	}

	// Negative overflow (below MinInt64) must also be refused, not wrapped.
	negOverflow := new(big.Int).Sub(big.NewInt(0).SetInt64(-9223372036854775808), big.NewInt(1)) // math.MinInt64 - 1
	if n, ok := NarrowInt64(negOverflow); ok {
		t.Fatalf("NarrowInt64(MinInt64-1) = (%d, true), want ok=false", n)
	}
}

func TestNarrowInt64_AcceptsInRangeAndNil(t *testing.T) {
	if n, ok := NarrowInt64(big.NewInt(12345)); !ok || n != 12345 {
		t.Fatalf("NarrowInt64(12345) = (%d, %v), want (12345, true)", n, ok)
	}
	if n, ok := NarrowInt64(nil); !ok || n != 0 {
		t.Fatalf("NarrowInt64(nil) = (%d, %v), want (0, true)", n, ok)
	}
	maxInt64 := new(big.Int).SetInt64(9223372036854775807)
	if n, ok := NarrowInt64(maxInt64); !ok || n != 9223372036854775807 {
		t.Fatalf("NarrowInt64(MaxInt64) = (%d, %v), want (MaxInt64, true) — the boundary itself must be accepted, not off-by-one rejected", n, ok)
	}
}

// ---------------------------------------------------------------------------
// Escape — must make it structurally impossible for an embedded value to
// break out of the JSON string context it is placed in. Proved against the
// standard library's own encoding/json, not just this package's own Str
// reader, so the proof does not just check "this scanner's inverse of
// itself" but "any conforming JSON parser reads this back as one string."
// ---------------------------------------------------------------------------

func TestEscape_CannotBreakOutOfStringContext(t *testing.T) {
	malicious := []string{
		`","evil":"true`,     // attempts to inject a sibling field
		`\",\"evil\":\"true`, // pre-escaped attempt at the same
		`"}{"pwned":true`,    // attempts to close and reopen the object
		`back\slash`,         // a literal backslash mid-string
		`quote"in"middle`,    // literal quotes mid-string
		`""""""`,             // a run of nothing but quotes
		`\\\\\\`,             // a run of nothing but backslashes
	}
	for _, m := range malicious {
		wire := `{"name":"` + Escape(m) + `"}`
		var out struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal([]byte(wire), &out); err != nil {
			t.Fatalf("Escape(%q) produced invalid JSON %q: %v", m, wire, err)
		}
		if out.Name != m {
			t.Fatalf("Escape(%q): round-tripped as %q, want the exact original — a mismatch here means the escaping let the value escape its string context (e.g. injected a sibling field or altered object structure)", m, out.Name)
		}
	}
}

// TestEscape_ControlCharactersProduceInvalidJSON documents a REAL, SEPARATE
// finding this proof surfaced: Escape only escapes '"' and '\\' (by design —
// its own doc says "not a general JSON string escaper"). A raw control byte
// (e.g. a literal tab or newline) passes through unescaped, and per RFC 8259
// a JSON string may not contain an unescaped control character — so a value
// containing one produces a JSON document a spec-conformant parser refuses,
// exactly what this test observes against encoding/json.
//
// Blast radius, traced rather than assumed: every account-name field
// (creator/holder/to/from) that ever reaches jsonEscape/Escape is already
// constrained to printable-ASCII-no-'|' by core/util.go's validAccount
// (`c < 0x20` is rejected outright), so no account field can ever carry a
// raw control byte here. The one place this is NOT true: core/ask.go's
// contentHash and answerHash are validated only for non-empty and "does not
// contain '|'" — nothing rejects a literal control byte in either. Since
// core/events.go's EvAsked/EvAnswered pass contentHash/answerHash through
// the identical minimal evJSONEscape before logging, a contentHash/
// answerHash containing e.g. a raw newline would make that one "asked"/
// "answered" event's log line invalid JSON. indexer/index.go's own contract
// degrades this gracefully (ParseEvent failure -> Stats.Malformed, skipped,
// never wedges ingestion of anything else) — so the impact is bounded to
// "that one ask silently never appears in the delivery record," not a fund
// or cross-market issue. Reported as a finding, not fixed here: contentHash
// validation lives in core/ask.go, underneath the Ask/Answer entrypoints
// another agent owns concurrently.
func TestEscape_ControlCharactersProduceInvalidJSON(t *testing.T) {
	withControlChar := "tab\tnewline\ncarriage\r"
	wire := `{"name":"` + Escape(withControlChar) + `"}`
	var out struct {
		Name string `json:"name"`
	}
	err := json.Unmarshal([]byte(wire), &out)
	if err == nil {
		t.Fatalf("Escape(%q) unexpectedly produced valid JSON %q (%q) — if this now passes, Escape may have started escaping control characters; update this test's comment and TestEscape_CannotBreakOutOfStringContext's case list accordingly", withControlChar, wire, out.Name)
	}
}

func TestEscape_PlainStringUnchanged(t *testing.T) {
	if got := Escape("alice"); got != "alice" {
		t.Fatalf("Escape(%q) = %q, want unchanged", "alice", got)
	}
}
