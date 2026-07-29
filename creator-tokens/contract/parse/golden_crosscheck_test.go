package parse

// Golden cross-language check: feed the EXACT payload JSON byte strings the
// real frontend write path emits (captured by the TS integration harness at
// apps/blog/features/creator-tokens/lib/vsc/__e2e__/vsc-data-path.e2e.ts, which
// drives the genuine VscCreatorTokensDataSource) through THIS package's
// Str/U64/BigDecimal — the actual parse implementation the wasm contract runs
// in production. This is the only way to prove, cross-language, that the parse
// bytecode accepts what the TS emits: TS's JSON serializer vs Go's own flat-
// JSON scanner, with nothing in between.
//
// The fixtures live in captured_payloads.json (regenerate by re-running the TS
// harness). Each field records its spec-declared kind (u64/str/money) and the
// value the frontend intended; this test re-parses the RAW payload string with
// Go's scanner and asserts it recovers that value — so if TS ever regressed a
// money field to a bare number, or a u64 to a quoted string, Go's scanner
// returns the wrong shape and this test fails even though the fixture's `want`
// was correct (see TestGoldenCrossCheck_RejectsUnquotedMoneyRegression).

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

type goldenField struct {
	Name    string `json:"name"`
	Kind    string `json:"kind"`    // "u64" | "str" | "money"
	WantStr string `json:"wantStr"` // for str/money
	WantU64 uint64 `json:"wantU64"` // for u64
}

type goldenFixture struct {
	Action  string        `json:"action"`
	Payload string        `json:"payload"` // the exact JSON string the Go parser must accept
	Fields  []goldenField `json:"fields"`
}

type goldenDoc struct {
	Fixtures []goldenFixture `json:"fixtures"`
}

func loadGoldenFixtures(t *testing.T) goldenDoc {
	t.Helper()
	path := os.Getenv("CREATOR_TOKENS_E2E_FIXTURES")
	if path == "" {
		path = "captured_payloads.json"
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read golden fixtures %q: %v — run the TS harness (npx tsx apps/blog/features/creator-tokens/lib/vsc/__e2e__/vsc-data-path.e2e.ts) to (re)generate it", path, err)
	}
	var doc goldenDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("malformed golden fixtures %q: %v", path, err)
	}
	return doc
}

// TestGoldenCrossCheck_FrontendPayloadsParse is the core cross-language proof:
// every field of every captured frontend payload is recovered correctly by the
// production Go parser.
func TestGoldenCrossCheck_FrontendPayloadsParse(t *testing.T) {
	doc := loadGoldenFixtures(t)
	if len(doc.Fixtures) == 0 {
		t.Fatal("no fixtures in captured_payloads.json — the TS harness must have produced zero captures")
	}

	// Every write action the frontend's E2E harness captures a fixture for
	// must be represented — a silent drop (an action that stopped emitting an
	// op) would otherwise pass unnoticed.
	//
	// ★ FIXED: this list still said "prepay" — the `prepay` wasmexport
	// entrypoint was DELETED (RULING A, RULINGS-v2-2026-07-21: core.Buy on
	// the bonding curve replaced the PAR mint as the only issuance path), so
	// captured_payloads.json can never contain it again and this test failed
	// unconditionally ("golden fixtures missing action \"prepay\"") the
	// instant the harness was re-run against the current frontend — verified
	// directly. It was also MISSING "buy", "sell" and "retire", three actions
	// captured_payloads.json's own fixtures already demonstrate the frontend
	// emits today, so this list had silently stopped protecting the exact
	// three actions most likely to regress next.
	//
	// ★ 2026-07-29: "refund", "refundHolder" and "claimTradeFees" are now
	// REQUIRED here too. They used to be excused because captured_payloads.json
	// genuinely had no fixture for them — but the reason was not that the
	// frontend never exercised those paths. The harness DID drive refund and
	// refundHolder (against a pre-seeded-FROZEN market, since the wind-down
	// rail is the only place they open), it just recorded them into a SECOND
	// CapturingBroadcaster whose ops were then dropped on the floor by
	// writeGoFixtures. So the two rails that hand real HBD back to a holder
	// were the only money paths this cross-check never saw. The harness now
	// writes both capture sets, and drives claimTradeFees as well.
	//
	// The shop/decline/rate writes are covered too, via the auth-tier
	// cross-check in auth_tier_crosscheck_test.go, which derives the required
	// set from main.go rather than restating it here.
	wantActions := []string{"register", "renew", "setFace", "setCap", "buy", "sell", "ask", "answer", "reclaim", "retire", "transfer", "refund", "refundHolder", "claimTradeFees"}
	seen := map[string]bool{}
	for _, fx := range doc.Fixtures {
		seen[fx.Action] = true
	}
	for _, a := range wantActions {
		if !seen[a] {
			t.Errorf("golden fixtures missing action %q — the harness did not capture it", a)
		}
	}

	for _, fx := range doc.Fixtures {
		fx := fx
		t.Run(fx.Action, func(t *testing.T) {
			if len(fx.Fields) == 0 {
				// A field-less fixture is ALMOST always a regression: an action
				// that stopped emitting its payload. But three entrypoints
				// genuinely take no payload at all — the caller IS the subject,
				// so main.go reads nothing (claimTradeFees main.go:1446, pause
				// :456, unpause :483, all specced as `{}` in
				// payload-contract.ts). Naming them, rather than accepting any
				// empty fixture, keeps the regression check intact: adding a
				// fourth requires a deliberate edit here.
				//
				// For those three the payload must still be EXACTLY `{}`. Their
				// entrypoints run the same unread-key check as every other, so
				// a stray field is a hard on-chain error, not a harmless extra.
				payloadless := map[string]bool{"claimTradeFees": true, "pause": true, "unpause": true}
				if !payloadless[fx.Action] {
					t.Fatalf("action %q has no fields to check — it declares payload fields in ACTION_PAYLOAD_SPECS, so a fixture with none means the frontend stopped emitting them", fx.Action)
				}
				if strings.TrimSpace(fx.Payload) != "{}" {
					t.Fatalf("action %q takes no payload, but the frontend emitted %s — main.go's unread-key check refuses any field here", fx.Action, fx.Payload)
				}
				return
			}
			for _, f := range fx.Fields {
				switch f.Kind {
				case "u64":
					// jsonU64: a bare, unquoted decimal integer. A quoted value
					// (TS regression) would read back as 0.
					got := U64(fx.Payload, f.Name)
					if got != f.WantU64 {
						t.Fatalf("U64(%q, %q) = %d, want %d — TS may have quoted a numeric field (payload: %s)", fx.Action, f.Name, got, f.WantU64, fx.Payload)
					}
				case "str":
					// jsonStr: a quoted string. An unquoted value reads back "".
					got := Str(fx.Payload, f.Name)
					if got != f.WantStr {
						t.Fatalf("Str(%q, %q) = %q, want %q (payload: %s)", fx.Action, f.Name, got, f.WantStr, fx.Payload)
					}
					if got == "" {
						t.Fatalf("Str(%q, %q) = \"\" — TS emitted an unquoted/absent value for a string field (payload: %s)", fx.Action, f.Name, fx.Payload)
					}
				case "money":
					// jsonStr -> parseBigDecimal: a quoted, bare non-negative
					// base-10 integer string. This is the exact shape the
					// frontend/contract mismatch bug got wrong.
					s := Str(fx.Payload, f.Name)
					v, ok := BigDecimal(s)
					if !ok {
						t.Fatalf("BigDecimal(Str(%q, %q)) rejected %q — a money field must be a quoted base-10 integer string (payload: %s)", fx.Action, f.Name, s, fx.Payload)
					}
					if v.String() != f.WantStr {
						t.Fatalf("money field %q.%q parsed to %s, want %s (payload: %s)", fx.Action, f.Name, v.String(), f.WantStr, fx.Payload)
					}
				default:
					t.Fatalf("unknown field kind %q for %q.%q", f.Kind, fx.Action, f.Name)
				}
			}
		})
	}
}

// TestGoldenCrossCheck_RejectsUnquotedMoneyRegression proves the cross-check has
// teeth: had the TS path regressed to emitting a money field as a BARE number
// (the exact bug parse exists to catch), Go's scanner refuses it — Str returns
// "" for an unquoted value and BigDecimal("") is not ok — while the correctly-
// quoted form the harness actually emits parses cleanly.
func TestGoldenCrossCheck_RejectsUnquotedMoneyRegression(t *testing.T) {
	regressed := `{"creator":"hive:alice","hbdPaid":5000}` // hbdPaid unquoted — the regression
	if s := Str(regressed, "hbdPaid"); s != "" {
		t.Fatalf("Str on an unquoted money field = %q, want \"\" (an unquoted value must be rejected, not misread)", s)
	}
	if _, ok := BigDecimal(Str(regressed, "hbdPaid")); ok {
		t.Fatal("BigDecimal on an unquoted money field parsed ok=true, want false")
	}

	good := `{"creator":"hive:alice","hbdPaid":"5000"}` // the shape the harness actually emits
	v, ok := BigDecimal(Str(good, "hbdPaid"))
	if !ok || v.String() != "5000" {
		t.Fatalf("quoted money field failed to parse: ok=%v v=%v, want (true, 5000)", ok, v)
	}
}
