package market

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// F-P1 — "CreateRound has no caller gate" is true as written and NOT reachable.
// The audit read create.go in isolation; the property that actually holds the
// line is one level up, in the contract's entrypoint table:
//
//	//go:wasmexport roll  -> market.RollRound(store, block, priceBps, feedOK)
//	                      -> CreateRound(s, "protocol", ...)
//
// `roll` is deliberately permissionless, but every parameter it passes is
// derived from protocol constants (computeStrikes + Roll*Blocks) — there is
// nothing for a caller to choose and therefore nothing to squat or cherry-pick.
//
// Nothing in the package pinned that. TestCreateRound_DefaultCreatorIsCaller
// looks like the access-control test and is not one: it passes `owner` in and
// asserts the round is attributed to it, which would pass identically if any
// account could open a round with hand-picked strikes.
//
// These two tests pin the real property. If someone exports createRound (or
// routes a second, caller-supplied path into CreateRound) they must add a
// caller gate or this fails first.

func contractSource(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("../contract/main.go")
	if err != nil {
		t.Fatalf("read contract/main.go: %v", err)
	}
	return string(b)
}

func TestFP1_CreateRoundIsNotAnExportedAction(t *testing.T) {
	src := contractSource(t)
	exports := regexp.MustCompile(`//go:wasmexport\s+(\w+)`).FindAllStringSubmatch(src, -1)
	if len(exports) == 0 {
		t.Fatal("no wasmexports found — the pin would silently pass forever")
	}
	for _, m := range exports {
		if strings.EqualFold(m[1], "createRound") {
			t.Fatal("createRound is now an exported action: CreateRound takes an " +
				"unvalidated caller and arbitrary strikes/deadlines, so this " +
				"entrypoint needs an explicit caller gate before it ships")
		}
	}
}

func TestFP1_OnlyRollOpensARound(t *testing.T) {
	// The round-opening call in production code must be RollRound's, attributed
	// to "protocol". A second call site is exactly how a caller-supplied round
	// would re-enter, so require it to be declared here deliberately.
	b, err := os.ReadFile("create.go")
	if err != nil {
		t.Fatalf("read create.go: %v", err)
	}
	// Count CODE only. Doc comments in this file legitimately quote the call
	// (the F-P1 note in CreateRound does), and counting those made this pin
	// fail on its own explanation the first time it ran.
	var code strings.Builder
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "//") {
			continue
		}
		code.WriteString(line)
		code.WriteString("\n")
	}
	calls := strings.Count(code.String(), "CreateRound(s,")
	if calls != 1 {
		t.Fatalf("expected exactly 1 CreateRound call site in create.go (RollRound's), found %d — "+
			"a new opener must come with its own caller gate", calls)
	}
	if !strings.Contains(string(b), `CreateRound(s, "protocol", block, CreateParams{`) {
		t.Fatal(`RollRound must open rounds as "protocol" — attribution is what makes the permissionless roll safe`)
	}
}

// The attribution guard added with this pin: an empty caller can never become a
// round's creator.
func TestFP1_EmptyCallerRejected(t *testing.T) {
	s := newMem()
	if err := Init(s, owner); err != nil {
		t.Fatal(err)
	}
	_, err := CreateRound(s, "", 0, CreateParams{
		Asset: AssetHbd, Strikes: []uint64{10000}, LockBlock: 2000, SettleBlock: 4000, GraceBlocks: 300,
	})
	if err == nil {
		t.Fatal("an empty caller must not open a round — the round would be unattributable")
	}
}
