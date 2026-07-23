package indexer

import "testing"

// TestGQLEventSource_NotImplemented documents, via a real test, exactly what
// the stub does today: nothing — it fails closed with ErrNotImplemented
// rather than silently returning an empty (and misleadingly "caught up")
// result. A caller that accidentally wires GQLEventSource in before the
// contract is deployed gets a loud, immediate error, not a quietly-empty
// indexer that looks like a healthy market with zero activity.
func TestGQLEventSource_NotImplemented(t *testing.T) {
	src := NewGQLEventSource("https://magi-test.techcoderx.com/api/v1/graphql", "vsc1Bexampleplaceholder")
	events, next, err := src.Events(StartCursor, 100)
	if err != ErrNotImplemented {
		t.Fatalf("expected ErrNotImplemented, got %v", err)
	}
	if events != nil {
		t.Fatalf("expected nil events, got %v", events)
	}
	if next != StartCursor {
		t.Fatalf("expected cursor to be echoed back unchanged, got %q", next)
	}
}

// Compile-time interface satisfaction checks — both sources really do
// implement EventSource (a typo in either method signature would only show
// up here, not at any call site since nothing calls through the interface
// value in production yet).
var (
	_ EventSource = (*MockEventSource)(nil)
	_ EventSource = (*GQLEventSource)(nil)
)
