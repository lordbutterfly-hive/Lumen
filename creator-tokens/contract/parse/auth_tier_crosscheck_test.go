package parse

// Auth-tier cross-language check: does the auth tier the FRONTEND actually
// puts on the wire match the auth tier THIS CONTRACT'S OWN SOURCE demands?
//
// This is the sibling of golden_crosscheck_test.go. That file proves the
// contract's parser accepts the bytes the frontend emits. This one proves the
// contract's *authority gate* accepts the *authority* the frontend emits —
// the other half of "an op the frontend built will actually execute".
//
// WHY IT EXISTS. contract/main.go gates every state-changing entrypoint on
// requireActiveAuth (main.go:206-212), which refuses an empty RequiredAuths
// outright:
//
//	auths := sdk.GetEnv().Sender.RequiredAuths
//	if len(auths) == 0 || string(auths[0]) != caller { ... refuse ... }
//
// That gate exists because go-vsc-node derives the caller from
// RequiredAuths[0] and FALLS BACK to RequiredPostingAuths[0]. Without it, a
// Hive POSTING key — the low-trust key users delegate to every dApp,
// including our own frontend — could authorize a transfer, a refund, a
// reclaim, a price change. The gate must never be widened; the CALLER is what
// gets fixed when the two disagree.
//
// The two sides live in different languages, in different repositories, and
// the wasm wrapper cannot be compiled or executed by the native Go toolchain
// at all (it imports the TinyGo-only sdk), so nothing can exercise the real
// gate in a test. A source-presence check on one side plus the captured ops
// on the other is the strongest guard available on this seam — the same idiom
// as keeper/wire_test.go's TestBuildOp_AuthTierMatchesWhatTheContractDemands,
// which caught precisely this bug in the keeper (every op it built carried
// posting-only auth, and its own test asserted that was CORRECT).
//
// It has caught one already: as of 2026-07-29 the frontend's
// WRITE_ACTIONS_REQUIRING_ACTIVE_AUTH list had gone stale at 18 entries while
// the client had grown to 24 write actions, so its posting-auth tripwire was
// returning clean for decline, rate and all four offerings-shop writes.
//
// The requirement is DERIVED, never restated: if a future change genuinely
// removes the active-auth gate from an entrypoint, these tests stop demanding
// active auth for it instead of failing for the wrong reason.

import (
	"encoding/json"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// authFixture re-reads captured_payloads.json for the auth arrays the golden
// fixture also carries. Pointers, not plain slices, so an ABSENT field is
// distinguishable from an empty one: absent means the fixture was written by
// a harness predating this check, which must fail loudly rather than read as
// "no auths".
type authFixture struct {
	Action               string    `json:"action"`
	RequiredAuths        *[]string `json:"requiredAuths"`
	RequiredPostingAuths *[]string `json:"requiredPostingAuths"`
}

type authDoc struct {
	Fixtures []authFixture `json:"fixtures"`
}

func loadAuthFixtures(t *testing.T) []authFixture {
	t.Helper()
	path := os.Getenv("CREATOR_TOKENS_E2E_FIXTURES")
	if path == "" {
		path = "captured_payloads.json"
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read golden fixtures %q: %v — run the TS harness (npx tsx apps/blog/features/creator-tokens/lib/vsc/__e2e__/vsc-data-path.e2e.ts) to (re)generate it", path, err)
	}
	var doc authDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("malformed golden fixtures %q: %v", path, err)
	}
	if len(doc.Fixtures) == 0 {
		t.Fatal("no fixtures in captured_payloads.json — the TS harness must have produced zero captures")
	}
	return doc.Fixtures
}

// wasmExportDirective matches a bare `//go:wasmexport <name>` line. Anchored
// to the start of a line so a directive quoted inside a doc comment (main.go
// :1094-1095 deliberately discusses the buy/sell directives in prose) cannot
// be miscounted as a real one.
var wasmExportDirective = regexp.MustCompile(`(?m)^//go:wasmexport[ \t]+(\w+)[ \t]*$`)

// contractEntrypoints parses main.go and reports every //go:wasmexport, plus
// the subset whose region calls requireActiveAuth. A region runs from one
// directive to the next — the same slicing keeper/wire_test.go:122-132 uses,
// and sound for the same reason: main.go puts each directive immediately above
// its own func and the gate is the third statement of every gated one.
func contractEntrypoints(t *testing.T) (all map[string]bool, active map[string]bool) {
	t.Helper()
	path := os.Getenv("CREATOR_TOKENS_CONTRACT_MAIN")
	if path == "" {
		path = "../main.go"
	}
	src, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	text := string(src)

	locs := wasmExportDirective.FindAllStringSubmatchIndex(text, -1)
	if len(locs) == 0 {
		t.Fatalf("%s declares no //go:wasmexport directives — this test's premise is broken, fix it rather than deleting it", path)
	}

	all = map[string]bool{}
	active = map[string]bool{}
	for i, loc := range locs {
		name := text[loc[2]:loc[3]]
		all[name] = true
		end := len(text)
		if i+1 < len(locs) {
			end = locs[i+1][0]
		}
		if strings.Contains(text[loc[0]:end], "requireActiveAuth(") {
			active[name] = true
		}
	}
	return all, active
}

// TestAuthTier_ContractGateIsIntact is the premise check. Every other
// assertion in this file is conditional on what main.go says, so if main.go
// stopped gating anything at all, those assertions would all pass vacuously.
// This one fails instead.
func TestAuthTier_ContractGateIsIntact(t *testing.T) {
	all, active := contractEntrypoints(t)

	if len(all) < 20 {
		t.Fatalf("main.go declares only %d wasm entrypoints — expected the full contract surface (~29); is CREATOR_TOKENS_CONTRACT_MAIN pointing at the right file?", len(all))
	}
	if len(active) == 0 {
		t.Fatal("AUTH-GATE REGRESSION: not one //go:wasmexport in main.go calls requireActiveAuth. The contract's entire defence against a posting key authorizing a money write is gone. This is the gate that stops go-vsc-node's RequiredPostingAuths[0] caller fallback from being reachable.")
	}

	// The ungated entrypoints must be reads only. This is a NAMED allow-list
	// on purpose: a new UNGATED entrypoint is exactly the change that must not
	// pass silently, so adding one forces a deliberate edit here.
	knownReadOnly := map[string]bool{
		"quote": true, "quoteBuy": true, "quoteSell": true, "listOfferings": true,
		// Market-facing reads (2026-07-30). Each returns state and writes
		// nothing, so an ungated caller can learn only what the chain already
		// makes public — and magi-market reads these values straight out of raw
		// state anyway, so gating them would protect nothing.
		"allowance":           true, // reads allow|<owner>|<spender>|<creator>
		"balanceOf":           true, // reads the matured balance
		"creatorTokenBalance": true, // our own shape: matured + maturing + graduation block
	}
	var unexpectedUngated []string
	for name := range all {
		if !active[name] && !knownReadOnly[name] {
			unexpectedUngated = append(unexpectedUngated, name)
		}
	}
	sort.Strings(unexpectedUngated)
	if len(unexpectedUngated) > 0 {
		t.Fatalf("main.go has ungated entrypoint(s) %v that are not in this test's read-only allow-list. If they are genuinely pure reads, add them to knownReadOnly with a one-line justification. If any of them mutates state, it is missing requireActiveAuth and a posting key can authorize it.", unexpectedUngated)
	}
}

// TestAuthTier_FrontendOpsMatchTheContractGate is the cross-language proof:
// every op the REAL frontend write path emitted (captured by the TS harness)
// carries exactly the authority the contract's own source demands for that
// action.
func TestAuthTier_FrontendOpsMatchTheContractGate(t *testing.T) {
	all, active := contractEntrypoints(t)

	for _, fx := range loadAuthFixtures(t) {
		fx := fx
		t.Run(fx.Action, func(t *testing.T) {
			if fx.RequiredAuths == nil || fx.RequiredPostingAuths == nil {
				t.Fatalf("fixture %q carries no requiredAuths/requiredPostingAuths — captured_payloads.json was written by a harness predating the auth cross-check. Re-run the TS harness (npx tsx apps/blog/features/creator-tokens/lib/vsc/__e2e__/vsc-data-path.e2e.ts); do not hand-edit the fixture.", fx.Action)
			}
			if !all[fx.Action] {
				t.Fatalf("the frontend emits action %q, which is not a //go:wasmexport in main.go at all — it would dispatch to an unknown entrypoint on chain", fx.Action)
			}
			if !active[fx.Action] {
				// Not a failure: an entrypoint the contract genuinely does not
				// gate needs no active auth. Recorded so a deliberate
				// downgrade is visible in the test log.
				t.Logf("note: main.go does not gate %q on requireActiveAuth, so this op's auth tier is unconstrained by the contract", fx.Action)
				return
			}
			if len(*fx.RequiredAuths) == 0 {
				t.Fatalf("AUTH-TIER REGRESSION: main.go gates %q on requireActiveAuth, which refuses an empty RequiredAuths — but the frontend emitted an op with required_auths=[]. Every one of these would be rejected on chain, 100%% of the time. Fix the CALLER (apps/blog/features/creator-tokens/lib/vsc/op-builders.ts buildOp), never requireActiveAuth.", fx.Action)
			}
			if len(*fx.RequiredPostingAuths) != 0 {
				t.Fatalf("AUTH-TIER REGRESSION: the frontend emitted %q with required_posting_auths=%v. A posting key is delegated to every dApp including our own frontend; go-vsc-node falls back to RequiredPostingAuths[0] for the caller, so this is the exact low-trust-key theft surface requireActiveAuth exists to close. Auth belongs in required_auths alone.", fx.Action, *fx.RequiredPostingAuths)
			}
		})
	}
}

// TestAuthTier_EveryGatedWriteIsExercised keeps the cross-check from going
// quietly blind. The assertions above only ever see actions the harness
// happened to capture, so an entrypoint the frontend stopped emitting — or
// one added on chain and never wired client-side — would simply vanish from
// this file's coverage without any test turning red.
//
// It is a t.Errorf, not a t.Fatalf, and it names the gap precisely, because
// "the client does not implement this entrypoint yet" is a legitimate state
// this package cannot itself fix (the same reasoning golden_crosscheck_test.go
// applies to refund/refundHolder).
func TestAuthTier_EveryGatedWriteIsExercised(t *testing.T) {
	_, active := contractEntrypoints(t)

	captured := map[string]bool{}
	for _, fx := range loadAuthFixtures(t) {
		captured[fx.Action] = true
	}

	// Entrypoints with no client method by design, so the harness cannot
	// capture one. Each needs a reason, not just a name.
	noClientMethod := map[string]string{
		"init":             "deployer-only, called once at deploy time; no client method exists",
		"pause":            "platform-owner control; the payload builder exists but no data-source method wires it",
		"unpause":          "platform-owner control; the payload builder exists but no data-source method wires it",
		"withdrawTreasury": "platform-owner control; the data source has the method but no UI reaches it, so the harness journey cannot drive it as a user would",
		"changeOwner":      "F19 defect fix (2026-08-19): platform-owner control, propose half of the 2-step ownership transfer; no client method exists yet, same tier as pause/unpause/withdrawTreasury above",
		"acceptOwnership":  "F19 defect fix (2026-08-19): pending-owner control, accept half of the 2-step ownership transfer; no client method exists yet",
		"closeIfDrained":   "permissionless keeper op; creator-tokens/keeper builds this envelope, and keeper/wire_test.go cross-checks ITS auth tier against the same gate",
		// The market-facing doors (2026-07-30, milestone M2). No client method
		// exists yet — the frontend wiring is milestone M4 — so the TS harness
		// cannot drive them. REMOVE THESE TWO ENTRIES the moment the client
		// gains approve/safeTransferFrom builders, or their auth tier ships
		// cross-checked by nothing.
		//
		// Note for whoever does that: safeTransferFrom is gated CONDITIONALLY —
		// requireActiveAuth applies only when the caller is moving their own
		// tokens. A third-party spender (the marketplace) is authorised by the
		// allowance instead, because the active-auth gate structurally refuses
		// every contract caller. This test's scanner sees the gate and treats
		// the entrypoint as gated, which is correct for the owner path.
		"graduate":         "holder moves their own cleared position into the tradable bucket; client builder lands with the frontend wiring in M4",
		"approve":          "grant door; client builder lands with the frontend wiring in M4",
		"safeTransferFrom": "spend door; conditionally gated (owner path only) — client builder lands in M4",
	}

	var missing []string
	for name := range active {
		if captured[name] {
			continue
		}
		if _, known := noClientMethod[name]; known {
			continue
		}
		missing = append(missing, name)
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("main.go gates %v on requireActiveAuth, but the frontend harness captured no op for them — their auth tier is NOT cross-checked by this file. Either wire them into apps/blog/features/creator-tokens/lib/vsc/__e2e__/vsc-data-path.e2e.ts's journey, or add them to noClientMethod above WITH a reason.", missing)
	}
}
