package indexer

import (
	"strconv"
	"sync"
)

// MockEventSource is an in-memory, strictly-ordered EventSource for tests
// (and any future demo). Push events in the exact order they'd be emitted
// on-chain; Events replays them from a cursor exactly like a real paginated
// source would, including short reads under a limit — so tests exercising
// MockEventSource also exercise Index's poll-loop correctly against a
// source that doesn't just hand back everything at once.
//
// Cursor encoding: a decimal string of "how many events have been consumed
// so far". This is MockEventSource-private — callers must not parse it (see
// the Cursor doc in source.go); a real EventSource would encode it
// completely differently (e.g. a block-height+output-id pair, mirroring
// hive-price-market/indexer/gql_source.go's GQLEventSource).
type MockEventSource struct {
	mu     sync.Mutex
	events []RawEvent
}

// NewMockEventSource returns an empty mock source. Use Push to append events.
func NewMockEventSource() *MockEventSource {
	return &MockEventSource{}
}

// Push appends one raw log line to the end of the source, in emission
// order. OutputID/BlockHeight/Seq are filled in automatically (OutputID =
// a synthetic "mock-N" id, Seq = 0, BlockHeight = the running index) so
// tests can just supply the JSON payload. Each Push gets its own distinct
// OutputID, so Index's (OutputID,Seq) de-duplication never collides two
// genuinely different pushed events with each other.
func (m *MockEventSource) Push(data string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := len(m.events)
	m.events = append(m.events, RawEvent{
		OutputID:    "mock-" + strconv.Itoa(n),
		BlockHeight: int64(n),
		Seq:         0,
		Data:        data,
	})
}

// PushRaw appends a caller-constructed RawEvent verbatim (OutputID/Seq not
// auto-assigned) — used by tests that need explicit control over the
// dedup identity, e.g. to simulate a poller redelivering the exact same
// on-chain log line after a restart.
func (m *MockEventSource) PushRaw(ev RawEvent) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.events = append(m.events, ev)
}

// Events implements EventSource. since must be StartCursor or a cursor this
// source previously returned; any other value is rejected (ErrInvalidCursor)
// rather than silently treated as 0 — a poller that lost its cursor should
// fail loudly, not quietly re-deliver or skip events.
func (m *MockEventSource) Events(since Cursor, limit int) ([]RawEvent, Cursor, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	start := 0
	if since != StartCursor {
		n, err := strconv.Atoi(string(since))
		if err != nil || n < 0 {
			return nil, since, ErrInvalidCursor
		}
		start = n
	}
	if start > len(m.events) {
		return nil, since, ErrInvalidCursor
	}

	end := len(m.events)
	if limit > 0 && start+limit < end {
		end = start + limit
	}

	if end == start {
		// No new events: echo `since` back UNCHANGED rather than
		// recomputing a cursor from `end`. Without this, polling an empty
		// source from StartCursor ("") would return Cursor("0") — a
		// different value from StartCursor despite zero events, breaking
		// the "nextCursor == sinceCursor means caught up" contract
		// documented on EventSource.Events (source.go) for that specific
		// edge case.
		return nil, since, nil
	}

	out := make([]RawEvent, end-start)
	copy(out, m.events[start:end])
	next := Cursor(strconv.Itoa(end))
	return out, next, nil
}

// Len reports how many events have been Pushed so far — a test convenience,
// not part of EventSource.
func (m *MockEventSource) Len() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.events)
}

// All returns every pushed event, drained via the EventSource interface
// itself (StartCursor, no limit) — a test convenience so callers don't have
// to hand-roll the Events(...) call for the common "give me everything"
// case.
func (m *MockEventSource) All() []RawEvent {
	events, _, _ := m.Events(StartCursor, 0)
	return events
}
