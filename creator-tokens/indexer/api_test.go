package indexer

import (
	"encoding/json"
	"testing"
)

// api_test.go proves the api.go DTOs correctly project index.go's internal
// query surface into the wire (money-as-string, never-nil-slice) shape.

func TestPositionView(t *testing.T) {
	ix := NewIndex()
	ix.Ingest(mustDrain(t, buildCanonicalScenario()))

	v := ix.PositionView("alice", "bob")
	if v.Creator != "alice" || v.Holder != "bob" {
		t.Errorf("got %+v", v)
	}
	if v.Credits != "3350" {
		t.Errorf("Credits = %q, want 3350", v.Credits)
	}
}

func TestPositionView_UnknownHolderIsZeroString(t *testing.T) {
	ix := NewIndex()
	v := ix.PositionView("nobody", "nobody")
	if v.Credits != "0" {
		t.Errorf("Credits = %q, want %q", v.Credits, "0")
	}
}

func TestHolderListView(t *testing.T) {
	ix := NewIndex()
	ix.Ingest(mustDrain(t, buildCanonicalScenario()))

	v := ix.HolderListView("alice")
	want := []string{"alice", "bob", "carol"}
	if len(v.Holders) != len(want) {
		t.Fatalf("Holders = %v, want %v", v.Holders, want)
	}
	for i := range want {
		if v.Holders[i] != want[i] {
			t.Errorf("Holders[%d] = %q, want %q", i, v.Holders[i], want[i])
		}
	}
}

// TestHolderListView_UnknownCreatorIsEmptySliceNotNil proves the DTO layer
// normalizes a nil internal result to an empty slice — `null` in a JSON
// response is a common frontend footgun ("holders.map is not a function"),
// []string{} always marshals to `[]`.
func TestHolderListView_UnknownCreatorIsEmptySliceNotNil(t *testing.T) {
	ix := NewIndex()
	v := ix.HolderListView("nobody")
	if v.Holders == nil {
		t.Fatal("Holders is nil, want non-nil empty slice")
	}
	if len(v.Holders) != 0 {
		t.Fatalf("Holders = %v, want empty", v.Holders)
	}
}

func TestDeliveryRecordView(t *testing.T) {
	ix := NewIndex()
	ix.Ingest(mustDrain(t, buildCanonicalScenario()))

	v := ix.DeliveryRecordView("alice", 0)
	if v.AnsweredCount != 2 || v.MissedCount != 1 || v.PendingCount != 1 {
		t.Errorf("got %+v", v)
	}
	want := []string{"50", "40"}
	if len(v.ResponseBlocks) != len(want) {
		t.Fatalf("ResponseBlocks = %v, want %v", v.ResponseBlocks, want)
	}
	for i := range want {
		if v.ResponseBlocks[i] != want[i] {
			t.Errorf("ResponseBlocks[%d] = %q, want %q (must be a decimal STRING, not a bare number)", i, v.ResponseBlocks[i], want[i])
		}
	}
}

func TestEventHistoryView(t *testing.T) {
	ix := NewIndex()
	ix.Ingest(mustDrain(t, buildCanonicalScenario()))

	v := ix.EventHistoryView("alice")
	if v.Creator != "alice" {
		t.Errorf("Creator = %q, want alice", v.Creator)
	}
	if len(v.Events) != 16 {
		t.Fatalf("len(Events) = %d, want 16", len(v.Events))
	}
	// Data is the exact original JSON line, unmodified.
	if v.Events[0].Data == "" {
		t.Error("Events[0].Data is empty, want the original log line")
	}
}

// TestEventHistoryView_RawEventFieldsAreCamelCaseOnTheWire is the DEFECT FIX
// for RawEvent's own JSON tags (source.go): before this fix, RawEvent had NO
// `json:"..."` tags at all, so encoding/json fell back to its bare Go field
// names — "OutputID"/"BlockHeight"/"Seq"/"Data" — the one wire shape in this
// whole package NOT in the lowercase-camelCase convention every other DTO
// here follows (PositionView, HolderListView, DeliveryRecordView,
// MarketSummaryView, TreasurySummaryView all use json tags like "creator",
// "answeredCount", "treasuryHbd"). EventHistoryView is the one DTO that
// embeds RawEvent directly, so this is where the mismatch would actually
// reach a consumer.
func TestEventHistoryView_RawEventFieldsAreCamelCaseOnTheWire(t *testing.T) {
	ix := NewIndex()
	ix.Ingest(mustDrain(t, buildCanonicalScenario()))

	v := ix.EventHistoryView("alice")
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("json.Marshal(EventHistoryView) failed: %v", err)
	}

	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("json.Unmarshal failed: %v", err)
	}
	events, ok := decoded["events"].([]any)
	if !ok || len(events) == 0 {
		t.Fatalf("decoded[\"events\"] = %v, want a non-empty array", decoded["events"])
	}
	first, ok := events[0].(map[string]any)
	if !ok {
		t.Fatalf("events[0] = %v, want an object", events[0])
	}
	for _, wantKey := range []string{"outputId", "blockHeight", "seq", "data"} {
		if _, present := first[wantKey]; !present {
			t.Errorf("events[0] is missing camelCase key %q — got keys %v", wantKey, keysOf(first))
		}
	}
	for _, mustBeAbsent := range []string{"OutputID", "BlockHeight", "Seq", "Data"} {
		if _, present := first[mustBeAbsent]; present {
			t.Errorf("events[0] still has the untagged PascalCase key %q — RawEvent's json tags did not take effect", mustBeAbsent)
		}
	}
}

func keysOf(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// TestHolderPositionsView_MatchesFrontendWireContract proves
// HolderPositionsView's JSON shape is EXACTLY what
// ../frontend/apps/blog/features/creator-tokens/lib/vsc-data-source.ts's
// readWallet already parses today: `{"positions":[{"creator":"..."}]}` — a
// bare array of objects each carrying only `creator`, decoded there via
// `positions.map(p => getJsonProp(p, 'creator')).filter(c => typeof c ===
// 'string')`. This is the missing reverse-index query the frontend already
// calls with no backing implementation (task spec: "what consumers need and
// cannot get").
func TestHolderPositionsView_MatchesFrontendWireContract(t *testing.T) {
	ix := NewIndex()
	ix.Ingest(mustDrain(t, buildCanonicalScenario()))

	v := ix.HolderPositionsView("bob")
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("json.Unmarshal failed: %v", err)
	}
	positions, ok := decoded["positions"].([]any)
	if !ok || len(positions) != 1 {
		t.Fatalf("decoded[\"positions\"] = %v, want a 1-element array", decoded["positions"])
	}
	first, ok := positions[0].(map[string]any)
	if !ok {
		t.Fatalf("positions[0] = %v, want an object", positions[0])
	}
	creator, ok := first["creator"].(string)
	if !ok || creator != "alice" {
		t.Errorf("positions[0].creator = %v, want the string \"alice\" — this is the ONLY field ../frontend's readWallet reads off each element", first["creator"])
	}
}

func TestHolderPositionsView_UnknownHolderIsEmptySliceNotNil(t *testing.T) {
	ix := NewIndex()
	v := ix.HolderPositionsView("nobody")
	if v.Positions == nil {
		t.Fatal("Positions is nil, want non-nil empty slice (a bare `null` here is the exact frontend footgun HolderListView's own doc already warns about)")
	}
	if len(v.Positions) != 0 {
		t.Fatalf("Positions = %v, want empty", v.Positions)
	}
}

// TestAskerAsksView_MatchesFrontendWireContract is the sibling proof for
// `/askers/{asker}/asks`: readMyAsks parses `{"asks":[{"creator":"...",
// "seq":<number>}]}`, reading `seq` as a bare JS number
// ("typeof p.seq === 'number'") — NOT a quoted string, unlike every money
// field elsewhere in this package's wire shapes.
func TestAskerAsksView_MatchesFrontendWireContract(t *testing.T) {
	ix := NewIndex()
	ix.Ingest(mustDrain(t, buildCanonicalScenario()))

	v := ix.AskerAsksView("bob")
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("json.Unmarshal failed: %v", err)
	}
	asks, ok := decoded["asks"].([]any)
	if !ok || len(asks) != 2 {
		t.Fatalf("decoded[\"asks\"] = %v, want a 2-element array (bob asked seq0 and seq3)", decoded["asks"])
	}
	first, ok := asks[0].(map[string]any)
	if !ok {
		t.Fatalf("asks[0] = %v, want an object", asks[0])
	}
	if _, isNumber := first["seq"].(float64); !isNumber {
		t.Errorf("asks[0].seq = %v (%T), want a bare JSON NUMBER — readMyAsks checks `typeof p.seq === 'number'` and would silently drop this ask if it were a quoted string", first["seq"], first["seq"])
	}
	if c, _ := first["creator"].(string); c != "alice" {
		t.Errorf("asks[0].creator = %v, want \"alice\"", first["creator"])
	}
}

func TestAskerAsksView_UnknownAskerIsEmptySliceNotNil(t *testing.T) {
	ix := NewIndex()
	v := ix.AskerAsksView("nobody")
	if v.Asks == nil {
		t.Fatal("Asks is nil, want non-nil empty slice")
	}
}

func TestEventHistoryView_UnknownCreatorIsEmptySliceNotNil(t *testing.T) {
	ix := NewIndex()
	v := ix.EventHistoryView("nobody")
	if v.Events == nil {
		t.Fatal("Events is nil, want non-nil empty slice")
	}
}

func TestMarketSummaryView(t *testing.T) {
	ix := NewIndex()
	ix.Ingest(mustDrain(t, buildCanonicalScenario()))

	v := ix.MarketSummaryView("alice")
	if !v.Known {
		t.Fatal("Known = false, want true")
	}
	if v.LastFace != "1500" {
		t.Errorf("LastFace = %q, want 1500", v.LastFace)
	}
	if v.LastCap != "200000" {
		t.Errorf("LastCap = %q, want 200000", v.LastCap)
	}
	if v.Closed {
		t.Error("Closed = true, want false")
	}
}

// TestDeliveryRecordView_DeclinedNotCountedAsMissed is the DEFECT 2
// regression: index.go's internal DeliveryRecord always computed
// DeclinedCount correctly (a prompt, fully-refunded "no" is delivery, not a
// miss — core/delivery.go), but this wire DTO dropped the field on the
// floor, so a declined ask was invisible to any consumer of this view: not
// counted as missed (good), but not visible as declined either (the whole
// point lost). This proves the DTO now surfaces it, and that a decline still
// never leaks into MissedCount.
func TestDeliveryRecordView_DeclinedNotCountedAsMissed(t *testing.T) {
	ix := NewIndex()
	ix.Ingest([]RawEvent{
		{OutputID: "o1", Data: `{"ev":"registered","v":1,"creator":"faye","actor":"faye","block":100,"face":"1000","cap":"100000","feePaid":"0"}`},
		{OutputID: "o2", Data: `{"ev":"asked","v":1,"creator":"faye","actor":"gwen","block":200,"seq":1,"creditsSpent":"1000","commissionHbd":"120","rate":"1000000","deadlineBlocks":28800,"contentHash":"h1"}`},
		// faye (the creator) declines gwen's ask promptly — full refund,
		// explicitly NOT a miss (core/delivery.go's recordDelivery).
		{OutputID: "o3", Data: `{"ev":"declined","v":1,"creator":"faye","actor":"faye","block":250,"seq":1,"credits":"1000","commissionHbd":"120","asker":"gwen"}`},
	})

	v := ix.DeliveryRecordView("faye", 0)
	if v.DeclinedCount != 1 {
		t.Errorf("DeliveryRecordView.DeclinedCount = %d, want 1 — the wire DTO must surface the decline, not silently drop it", v.DeclinedCount)
	}
	if v.MissedCount != 0 {
		t.Errorf("DeliveryRecordView.MissedCount = %d, want 0 — a decline must NEVER show up as a miss in the wire shape", v.MissedCount)
	}
	if v.AnsweredCount != 0 {
		t.Errorf("DeliveryRecordView.AnsweredCount = %d, want 0", v.AnsweredCount)
	}

	// Sanity check against the internal (already-correct) aggregate this DTO
	// projects, so a future change to DeliveryRecordView's mapping can't
	// silently drift from DeliveryRecord itself again.
	rec := ix.DeliveryRecord("faye", 0)
	if v.DeclinedCount != rec.DeclinedCount {
		t.Errorf("DeliveryRecordView.DeclinedCount = %d, DeliveryRecord.DeclinedCount = %d — DTO must mirror the internal aggregate exactly", v.DeclinedCount, rec.DeclinedCount)
	}
}

// TestMarketSummaryView_RetiredMirrorsMarketSummary proves the `retired`
// finding's wire projection: MarketSummaryView must surface Retired exactly
// like MarketSummary does, and Retired/Closed remain independently readable
// (a market can be retired without yet being closed).
func TestMarketSummaryView_RetiredMirrorsMarketSummary(t *testing.T) {
	ix := NewIndex()
	ix.Ingest([]RawEvent{
		{OutputID: "o1", Data: `{"ev":"registered","v":1,"creator":"heidi","actor":"heidi","block":1,"face":"1000","cap":"100000","feePaid":"0"}`},
		{OutputID: "o2", Data: `{"ev":"retired","creator":"heidi","actor":"heidi","block":10}`},
	})

	v := ix.MarketSummaryView("heidi")
	if !v.Retired {
		t.Error("MarketSummaryView(heidi).Retired = false, want true")
	}
	if v.Closed {
		t.Error("MarketSummaryView(heidi).Closed = true, want false")
	}
}

// TestMarketSummaryView_UnknownCreatorOmitsFaceAndCap proves an
// unobserved creator round-trips as Known=false with LastFace/LastCap left
// at their Go zero value (""), which the `omitempty` json tag drops
// entirely from the wire response — distinguishable from "the creator
// posted a face of literally empty string," which cannot happen on-chain.
func TestMarketSummaryView_UnknownCreatorOmitsFaceAndCap(t *testing.T) {
	ix := NewIndex()
	v := ix.MarketSummaryView("nobody")
	if v.Known {
		t.Error("Known = true, want false")
	}
	if v.LastFace != "" || v.LastCap != "" {
		t.Errorf("got LastFace=%q LastCap=%q, want both empty", v.LastFace, v.LastCap)
	}
}
