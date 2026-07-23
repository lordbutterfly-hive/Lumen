package indexer

// GQLEventSource is the intended production EventSource: it tails a deployed
// contract's outputs via go-vsc-node's GraphQL API. It is a DOCUMENTED STUB —
// every method returns ErrNotImplemented. Two independent things are missing
// before it can be implemented for real, both confirmed by reading
// go-vsc-node's actual source (not assumed):
//
//  1. The contract isn't deployed (DUMB-QUESTIONS-RESOLVED-2026-07-19.md,
//     E1: "No (README:64)."). There is no contractId to query yet.
//
//  2. A real GraphQL schema gap, found while building this package:
//     go-vsc-node DOES persist every sdk.Log(...) line from a real
//     (non-simulated) contract call — modules/db/vsc/contracts/interface.go:43
//     defines `Logs []string` on ContractOutputResult, and
//     modules/state-processing/state_engine.go:1487/1498 populates it for
//     every successful call (`Logs: log.Logs`). BUT the public GraphQL type
//     `ContractOutputResult` (modules/gql/schema.graphql:165-170) only
//     exposes two fields:
//
//     type ContractOutputResult {
//     ret: String!
//     ok: Boolean!
//     }
//
//     No `logs` field. `findContractOutput` (schema.graphql:825-836) is the
//     only query that reaches historical, already-confirmed outputs, and its
//     result type has no path to the persisted Logs slice at all. The ONLY
//     place `logs` is exposed today is `SimulateContractCallResult.logs`
//     (schema.graphql:790-807) — the dry-run/no-broadcast path
//     (simulateContractCalls), which is useless for indexing history since
//     it never executes a real, already-mined transaction.
//
//     Fix needed upstream (small, additive, no breaking change): add
//     `logs: [String!]` to the `ContractOutputResult` GraphQL type and wire
//     its resolver — gqlgen can autobind directly since the Go struct field
//     already exists (interface.go:43), so this is a schema+resolver change,
//     not a data-model change. Until that lands, findContractOutput cannot
//     be used to read a deployed round's ev:bet/ev:claim/... history at all.
//
// Everything below documents the query this source WILL run once both gaps
// close, so wiring it up later is "fill in the HTTP client", not "redesign
// the approach."
//
// Query shape (see modules/gql/schema.graphql:678-693, 825-836):
//
//	query($contractId: String!, $fromBlock: Uint64, $limit: Int) {
//	  findContractOutput(filterOptions: {
//	    byContract: $contractId
//	    fromBlock:  $fromBlock   # Magi block height, inclusive; cursor resume point
//	    limit:      $limit
//	  }) {
//	    id            # ContractOutput.id -> RawEvent.OutputID
//	    block_height  # ContractOutput.block_height -> RawEvent.BlockHeight
//	    results {
//	      ok
//	      # logs: [String!]   <- does not exist yet; each string is one
//	      #                       RawEvent.Data, in emission order within
//	      #                       this output -> RawEvent.Seq
//	    }
//	  }
//	}
//
// Ordering: findContractOutput results are expected ascending by
// block_height for a fixed byContract filter (consistent with every other
// paginated find* query in the schema using fromBlock/toBlock/offset/limit,
// e.g. findTransaction, findLedgerTXs). Within one output, `results[].logs`
// preserves sdk.Log emission order (state_engine.go:1469-1503 iterates and
// appends in call order; ../contract/main.go's entrypoints each call
// sdk.Log exactly once, so in practice len(logs)<=1 per result today, but
// this source must not assume that — Seq walks every entry).
//
// Cursor encoding: "<block_height>:<output_id>" — carrying the specific
// output_id (not just the block height) lets Events resume correctly even
// when multiple outputs share a block_height, by additionally filtering out
// output_id's already consumed at that exact height (GQL's fromBlock alone
// is not fine-grained enough to dedupe within a height). Genuinely opaque to
// callers per the EventSource contract (source.go) — only GQLEventSource
// itself parses it.
type GQLEventSource struct {
	// Endpoint is the GQL HTTP endpoint, e.g.
	// "https://magi-test.techcoderx.com/api/v1/graphql" (techcoderx testnet,
	// reference_magi_testnet_endpoints) or
	// "https://testnet.magi.milohpr.com/api/v1/graphql" (Milo testnet).
	Endpoint string
	// ContractID is the deployed contract's id (e.g. "vsc1B..."), recorded
	// after Step 1 of DEPLOY-RUNBOOK.md. Empty until deployed.
	ContractID string
	// HTTPDoer abstracts the HTTP client (net/http.Client satisfies it)
	// purely so this type stays constructible/testable without a real
	// network dependency; deliberately NOT wired to net/http here since
	// there is nothing live to call yet.
	HTTPDoer interface {
		// Do would run one GQL POST; left unimplemented — see the type doc.
	}
}

// NewGQLEventSource constructs a GQLEventSource. It performs no I/O and
// never fails — failure is deferred to Events, which always returns
// ErrNotImplemented today (see the type doc for exactly what has to be true
// before that changes: contract deployed + `logs` exposed on
// ContractOutputResult).
func NewGQLEventSource(endpoint, contractID string) *GQLEventSource {
	return &GQLEventSource{Endpoint: endpoint, ContractID: contractID}
}

// Events implements EventSource. Always returns ErrNotImplemented — see the
// GQLEventSource type doc for the two concrete blockers (no deployed
// contract; findContractOutput's GraphQL type doesn't expose logs yet).
func (g *GQLEventSource) Events(sinceCursor Cursor, limit int) ([]RawEvent, Cursor, error) {
	return nil, sinceCursor, ErrNotImplemented
}
