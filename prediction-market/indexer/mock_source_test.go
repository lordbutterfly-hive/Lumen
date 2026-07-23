package indexer

import "testing"

func TestMockEventSource_EmptySourceCaughtUp(t *testing.T) {
	src := NewMockEventSource()
	events, next, err := src.Events(StartCursor, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("expected no events, got %d", len(events))
	}
	if next != StartCursor {
		t.Fatalf("expected cursor to stay at start on an empty source, got %q", next)
	}
}

func TestMockEventSource_ReplaysInOrder(t *testing.T) {
	src := NewMockEventSource()
	src.Push(`{"ev":"round_created","roundId":1,"by":"hive:a"}`)
	src.Push(`{"ev":"bet","roundId":1,"outcome":0,"acct":"hive:a","amount":"10"}`)
	src.Push(`{"ev":"bet","roundId":1,"outcome":0,"acct":"hive:b","amount":"20"}`)

	events, next, err := src.Events(StartCursor, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 3 {
		t.Fatalf("expected 3 events, got %d", len(events))
	}
	if events[0].Data != `{"ev":"round_created","roundId":1,"by":"hive:a"}` {
		t.Fatalf("wrong order: %+v", events)
	}
	if events[2].Data != `{"ev":"bet","roundId":1,"outcome":0,"acct":"hive:b","amount":"20"}` {
		t.Fatalf("wrong order: %+v", events)
	}

	// Caught up: re-polling from `next` returns nothing new.
	events2, next2, err := src.Events(next, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events2) != 0 {
		t.Fatalf("expected no new events, got %d", len(events2))
	}
	if next2 != next {
		t.Fatalf("cursor should be stable once caught up: %q vs %q", next2, next)
	}
}

func TestMockEventSource_ShortReadsUnderLimit(t *testing.T) {
	src := NewMockEventSource()
	for i := 0; i < 10; i++ {
		src.Push(`{"ev":"round_created","roundId":1,"by":"hive:a"}`)
	}

	cursor := StartCursor
	total := 0
	batches := 0
	for {
		events, next, err := src.Events(cursor, 3)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(events) == 0 {
			break
		}
		total += len(events)
		batches++
		cursor = next
		if batches > 20 {
			t.Fatal("pagination did not terminate — possible infinite loop")
		}
	}
	if total != 10 {
		t.Fatalf("expected to drain all 10 events across batches, got %d", total)
	}
	if batches != 4 { // 3+3+3+1
		t.Fatalf("expected 4 batches of size<=3, got %d", batches)
	}
}

func TestMockEventSource_InvalidCursorRejected(t *testing.T) {
	src := NewMockEventSource()
	src.Push(`{"ev":"round_created","roundId":1,"by":"hive:a"}`)

	_, _, err := src.Events(Cursor("not-a-number"), 0)
	if err != ErrInvalidCursor {
		t.Fatalf("expected ErrInvalidCursor, got %v", err)
	}

	_, _, err = src.Events(Cursor("999"), 0) // past the end
	if err != ErrInvalidCursor {
		t.Fatalf("expected ErrInvalidCursor for an out-of-range cursor, got %v", err)
	}
}

func TestMockEventSource_Len(t *testing.T) {
	src := NewMockEventSource()
	if src.Len() != 0 {
		t.Fatalf("expected 0, got %d", src.Len())
	}
	src.Push(`{"ev":"round_created","roundId":1,"by":"hive:a"}`)
	if src.Len() != 1 {
		t.Fatalf("expected 1, got %d", src.Len())
	}
}
