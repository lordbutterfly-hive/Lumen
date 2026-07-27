package main

import (
	"testing"

	"creator-tokens/core"
	"creator-tokens/keeper"
)

// TestBuildDemoScenario_DoesNotPanic pins the exact regression that took this
// whole CLI down: buildDemoScenario's shared `face` constant was 500, and the
// 2026-07-27 commission carve-out bumped MinFace to 577 (params.go — the
// posted face is now grossed up so its POST-COMMISSION token leg still
// clears the C4 settlement floor). Every core.Register call in
// buildDemoScenario reverted with "face out of range [MinFace, MaxFace]",
// and must() (which wraps every core.* error in a panic) took the whole
// program down before it printed a single line — verified directly: `go run
// ./cmd/keeper` panicked at startup before this fix.
//
// Neither `go build ./cmd/...` nor `go vet ./cmd/...` catches this class of
// regression: MinFace is a runtime bound, not a compile-time one, so a
// parameter change three files away in core/params.go can silently break
// this CLI with zero signal from either command. Actually RUNNING the demo
// scenario, the way this test does, is the only thing that catches it before
// a live deployment does.
//
// This package had no test file at all before this fix — that is the other
// half of why the regression went unnoticed.
func TestBuildDemoScenario_DoesNotPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("buildDemoScenario (or collectMarketViews) panicked: %v", r)
		}
	}()

	store, ix, demoBlock := buildDemoScenario()
	if store == nil {
		t.Fatal("buildDemoScenario returned a nil store")
	}
	if ix == nil {
		t.Fatal("buildDemoScenario returned a nil index")
	}

	creators := []string{"aliceart", "bobmusic", "carlwrites", "danerin"}
	views := collectMarketViews(store, ix, demoBlock, creators)
	if len(views) != len(creators) {
		t.Fatalf("collectMarketViews returned %d views, want %d", len(views), len(creators))
	}

	// Every market the doc comments above buildDemoScenario's four registrations
	// promise ("ACTIVE market (nothing due) -> FROZEN market with holders to
	// refund -> FROZEN market already fully drained (closeIfDrained only) ->
	// FROZEN market with an outstanding escrow") must actually land in the
	// phase that scenario claims -- a silent phase drift here would make every
	// downstream Plan/Sweep assertion meaningless without ever failing loudly.
	wantPhase := map[string]string{
		"aliceart":   core.StateFrozen,
		"bobmusic":   core.StateActive,
		"carlwrites": core.StateFrozen,
		"danerin":    core.StateFrozen,
	}
	for _, v := range views {
		if want := wantPhase[v.Creator]; v.Phase != want {
			t.Errorf("%s phase = %s, want %s", v.Creator, v.Phase, want)
		}
	}

	// danerin must show its one outstanding escrow as still-pending PLUS a
	// non-zero holder balance (reader1 bought 600 and spent 1 on the ask) --
	// this is the scenario that proves closeIfDrained correctly no-ops while
	// an ask is in flight (SPEC §1.7.5: "in-flight asks are never cut off").
	for _, v := range views {
		if v.Creator != "danerin" {
			continue
		}
		if len(v.Holders) != 1 || v.Holders[0].Holder != "reader1" {
			t.Fatalf("danerin holders = %+v, want exactly [reader1]", v.Holders)
		}
		if v.Holders[0].Balance == nil || v.Holders[0].Balance.Sign() <= 0 {
			t.Fatalf("danerin reader1 balance = %v, want > 0 (600 bought, 1 escrowed)", v.Holders[0].Balance)
		}
	}

	// The plan a real sweep would submit must exist and must never touch the
	// still-ACTIVE bobmusic market (Plan's own "only FROZEN markets produce
	// any ops" rule -- keeper/plan.go).
	ops := keeper.Plan(views)
	if len(ops) == 0 {
		t.Fatal("Plan produced no ops at all -- want at least the FROZEN markets' refunds/closes")
	}
	for _, op := range ops {
		if op.Creator == "bobmusic" {
			t.Errorf("Plan produced an op for the still-ACTIVE market bobmusic: %+v", op)
		}
	}
}
