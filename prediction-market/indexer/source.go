package indexer

import "errors"

// RawEvent is one sdk.Log(...) line from the contract, as sourced from a VSC
// contract-output. One contract call ⇒ one TransactionOutput ⇒ (today) at
// most one log line for every entrypoint in ../contract/main.go, each of
// which calls sdk.Log exactly once.
type RawEvent struct {
	// OutputID is the contract-output CID this log line came from
	// (ContractOutput.id in go-vsc-node's GQL schema,
	// modules/gql/schema.graphql:176-177). Opaque beyond being a stable,
	// unique identifier — useful for dedup/audit, not parsed by this package.
	OutputID string
	// BlockHeight is the Magi block height the output was produced at
	// (ContractOutput.block_height, schema.graphql:178-179) — NOT the Hive L1
	// anchor height. Advisory only (ordering/display); RawEvent order as
	// returned by EventSource.Events is authoritative, not this field.
	BlockHeight int64
	// Seq disambiguates multiple log lines within the SAME output, 0-based,
	// in emission order within that output.
	Seq int
	// Data is the raw JSON log line exactly as sdk.Log emitted it.
	Data string
}

// Cursor opaquely identifies a position in the event stream. Callers must
// treat it as an opaque token and always pass back exactly what a prior
// Events call returned as nextCursor — never construct or parse one. Each
// EventSource implementation is free to encode it however suits that
// backend (MockEventSource: a slice offset; GQLEventSource: a
// block-height+output-id pair — see gql_source.go).
type Cursor string

// StartCursor is the cursor value meaning "from the very beginning of the
// stream" — pass it as sinceCursor on the first call to Events.
const StartCursor Cursor = ""

// EventSource abstracts WHERE contract event logs come from, so Index (the
// aggregator in index.go) can be fed by a live GQL poller in production
// (gql_source.go) or a canned in-memory list in tests (mock_source.go) with
// zero code difference in the folding logic.
//
// Ordering contract: Events MUST return events in on-chain emission order
// (block height, then tx-in-block, then log-in-tx/Seq) relative to
// everything already returned for cursors before sinceCursor. Index folds
// events strictly in the order given and depends on it — e.g. it assumes a
// bet's ev:bet always precedes any ev:claim for the same (round, account),
// because that is the only order the contract can possibly emit them in
// (Claim requires a resolved round; Bet requires an open one). An
// out-of-order source silently produces wrong aggregates, not a crash — see
// index_test.go's ordering assumptions.
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
// documented but not wired to a live backend yet (see GQLEventSource in
// gql_source.go, which needs a deployed contract).
var ErrNotImplemented = errors.New("indexer: event source not implemented")

// ErrInvalidCursor is returned by an EventSource when sinceCursor is not
// StartCursor and not a value that source itself previously issued.
var ErrInvalidCursor = errors.New("indexer: invalid cursor")
