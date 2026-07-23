package indexer

import "testing"

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
