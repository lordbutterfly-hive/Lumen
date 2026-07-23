package indexer

import "testing"

func TestMockEventSource_EmptySourceStartCursorIsCaughtUp(t *testing.T) {
	src := NewMockEventSource()
	events, next, err := src.Events(StartCursor, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("expected 0 events, got %d", len(events))
	}
	if next != StartCursor {
		t.Fatalf("next cursor = %q, want StartCursor unchanged (empty source, caught up)", next)
	}
}

func TestMockEventSource_PushAndDrainPreservesOrder(t *testing.T) {
	src := NewMockEventSource()
	src.Push(`{"ev":"a"}`)
	src.Push(`{"ev":"b"}`)
	src.Push(`{"ev":"c"}`)

	events, next, err := src.Events(StartCursor, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(events) != 3 {
		t.Fatalf("got %d events, want 3", len(events))
	}
	for i, want := range []string{`{"ev":"a"}`, `{"ev":"b"}`, `{"ev":"c"}`} {
		if events[i].Data != want {
			t.Errorf("events[%d].Data = %q, want %q", i, events[i].Data, want)
		}
	}
	if next == StartCursor {
		t.Fatal("next cursor should have advanced past 3 events")
	}
}

func TestMockEventSource_ShortReadsUnderLimit(t *testing.T) {
	src := NewMockEventSource()
	for i := 0; i < 5; i++ {
		src.Push(`{"ev":"x"}`)
	}

	cursor := StartCursor
	total := 0
	batches := 0
	for {
		events, next, err := src.Events(cursor, 2)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(events) == 0 {
			break
		}
		if len(events) > 2 {
			t.Fatalf("batch size %d exceeds limit 2", len(events))
		}
		total += len(events)
		batches++
		cursor = next
	}
	if total != 5 {
		t.Fatalf("drained %d events total, want 5", total)
	}
	if batches != 3 { // 2 + 2 + 1
		t.Fatalf("drained in %d batches, want 3", batches)
	}
}

func TestMockEventSource_InvalidCursorIsRejected(t *testing.T) {
	src := NewMockEventSource()
	src.Push(`{"ev":"a"}`)

	_, _, err := src.Events(Cursor("not-a-number"), 0)
	if err != ErrInvalidCursor {
		t.Fatalf("got err=%v, want ErrInvalidCursor", err)
	}

	_, _, err = src.Events(Cursor("-1"), 0)
	if err != ErrInvalidCursor {
		t.Fatalf("negative cursor: got err=%v, want ErrInvalidCursor", err)
	}

	_, _, err = src.Events(Cursor("999"), 0) // beyond the end
	if err != ErrInvalidCursor {
		t.Fatalf("out-of-range cursor: got err=%v, want ErrInvalidCursor", err)
	}
}

func TestMockEventSource_DistinctOutputIDsPerPush(t *testing.T) {
	src := NewMockEventSource()
	src.Push(`{"ev":"a"}`)
	src.Push(`{"ev":"a"}`) // identical Data, must still get a distinct identity
	events := src.All()
	if events[0].OutputID == events[1].OutputID {
		t.Fatalf("two separate Push calls got the same OutputID: %q", events[0].OutputID)
	}
}

func TestMockEventSource_PushRawPreservesGivenIdentity(t *testing.T) {
	src := NewMockEventSource()
	src.PushRaw(RawEvent{OutputID: "fixed-id", Seq: 3, Data: `{"ev":"a"}`})
	events := src.All()
	if len(events) != 1 || events[0].OutputID != "fixed-id" || events[0].Seq != 3 {
		t.Fatalf("got %+v, want OutputID=fixed-id Seq=3", events)
	}
}

func TestMockEventSource_LenTracksPushes(t *testing.T) {
	src := NewMockEventSource()
	if src.Len() != 0 {
		t.Fatalf("Len() = %d, want 0", src.Len())
	}
	src.Push(`{"ev":"a"}`)
	src.Push(`{"ev":"b"}`)
	if src.Len() != 2 {
		t.Fatalf("Len() = %d, want 2", src.Len())
	}
}
