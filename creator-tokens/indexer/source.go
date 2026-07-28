package indexer

import "errors"

// RawEvent is one sdk.Log(...) line from the contract, as sourced from a VSC
// contract-output.
//
// ONE CONTRACT CALL CAN EMIT MORE THAN ONE LOG LINE (corrected 2026-07-28).
// This doc used to say "one contract call ⇒ one TransactionOutput ⇒ at most
// one log line for every entrypoint … each of which calls sdk.Log at most
// once." That stopped being true when ../contract/main.go's `register` gained
// an atomic first buy: it now logs `registered` AND `bought` from a single
// call, and it is currently the only entrypoint that does.
//
// Consequence for whoever writes the first PRODUCTION EventSource — there is
// none yet, only MockEventSource — Seq is what separates two log lines that
// share one OutputID, and Index de-duplicates on the (OutputID, Seq) PAIR. A
// source that hardcodes Seq = 0 (as MockEventSource.Push does, for the common
// one-line case) will make the second line look like a redelivery of the
// first and silently DROP it. For `register` that means dropping every
// creator's entire launch position, on the default new-market path, with no
// error anywhere. Assign Seq per log line, in emission order.
// TestIndex_RegisterEmitsTwoLogsFromOneOutput pins this.
//
// JSON TAGS (DEFECT FIX, 2026-07-28): these four fields used to carry NO
// `json:"..."` tags at all, so encoding/json fell back to their bare Go
// names — "OutputID"/"BlockHeight"/"Seq"/"Data" — the ONE wire shape in this
// entire package NOT in the lowercase-camelCase convention every other DTO
// here follows (PositionView, HolderListView, DeliveryRecordView,
// MarketSummaryView, TreasurySummaryView — api.go). That mismatch is latent
// today (EventHistoryView, api.go, is the only DTO that embeds RawEvent
// directly, and nothing in this repo currently decodes its JSON output), but
// it is exactly the kind of boundary a future frontend consumer would trip
// on silently: every other field in this API reads `creator`/`holders`/
// `answeredCount`; this one alone would read `OutputID`/`BlockHeight`. Tagged
// now, before anything depends on the untagged shape, rather than after.
type RawEvent struct {
	// OutputID is the contract-output CID this log line came from
	// (ContractOutput.id in go-vsc-node's GQL schema). Opaque beyond being a
	// stable, unique identifier — Index uses (OutputID, Seq) together as the
	// de-duplication key that makes Ingest safe to call twice with
	// overlapping batches (see index.go's Poll/restart doc).
	OutputID string `json:"outputId"`
	// BlockHeight is the Magi block height the output was produced at —
	// NOT the Hive L1 anchor height. Advisory only (ordering/display);
	// RawEvent order as returned by EventSource.Events is authoritative,
	// not this field.
	BlockHeight int64 `json:"blockHeight"`
	// Seq disambiguates multiple log lines within the SAME output, 0-based,
	// in emission order within that output.
	Seq int `json:"seq"`
	// Data is the raw JSON log line exactly as sdk.Log emitted it — the
	// output of one of core/events.go's Ev* constructors, unchanged.
	Data string `json:"data"`
}

// Cursor opaquely identifies a position in the event stream. Callers must
// treat it as an opaque token and always pass back exactly what a prior
// Events call returned as nextCursor — never construct or parse one. Each
// EventSource implementation is free to encode it however suits that
// backend (MockEventSource: a slice offset).
type Cursor string

// StartCursor is the cursor value meaning "from the very beginning of the
// stream" — pass it as sinceCursor on the first call to Events.
const StartCursor Cursor = ""

// EventSource abstracts WHERE contract event logs come from, so Index (the
// aggregator in index.go) can be fed by a live GQL poller in production or a
// canned in-memory list in tests (mock_source.go) with zero code difference
// in the folding logic.
//
// Ordering contract: Events MUST return events in on-chain emission order
// (block height, then tx-in-block, then log-in-tx/Seq) relative to
// everything already returned for cursors before sinceCursor. Index folds
// events strictly in the order given and depends on it — e.g. it assumes an
// asker's ev:asked always precedes any ev:answered/ev:reclaimed for the same
// (creator, seq), because that is the only order the contract can possibly
// emit them in (ask.go: Answer/Reclaim both require an existing PENDING
// escrow record, which only ev:asked ever creates). An out-of-order source
// silently produces wrong aggregates, not a crash — see index_test.go's
// ordering assumptions.
type EventSource interface {
	// Events returns raw events strictly after sinceCursor, in emission
	// order, plus the cursor to resume from on the next call.
	//
	//   - limit <= 0 means "no limit" — return everything currently
	//     available after sinceCursor.
	//   - limit > 0 caps the number of events returned in this call; the
	//     source may return fewer even when more exist (short reads are
	//     always legal — callers must loop until an empty batch, exactly
	//     like io.Reader).
	//   - Zero events returned with nextCursor == sinceCursor means the
	//     caller is caught up as of this call; poll again later for new
	//     events. This is NOT an error.
	Events(sinceCursor Cursor, limit int) (events []RawEvent, nextCursor Cursor, err error)
}

// ErrNotImplemented is returned by EventSource implementations that are
// documented but not wired to a live backend yet.
var ErrNotImplemented = errors.New("indexer: event source not implemented")

// ErrInvalidCursor is returned by an EventSource when sinceCursor is not
// StartCursor and not a value that source itself previously issued.
var ErrInvalidCursor = errors.New("indexer: invalid cursor")
