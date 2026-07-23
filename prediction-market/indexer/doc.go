// Package indexer is the off-chain read-side for the Hive Price Weekly
// Market contract (../contract, ../market). It exists because the contract
// exposes NO read entrypoints for aggregates: "#bettors", "your claims
// history", "which rounds did I bet in" cannot be answered by any
// getStateByKeys call — see DUMB-QUESTIONS-RESOLVED-2026-07-19.md, item E5
// ("No read entrypoints. Needs an off-chain indexer over ev:bet/ev:claim/
// ev:resolved logs. The mock's '34 bettors' has no on-chain counter to
// replace it. GAP — BUILD-NEEDED.").
//
// The contract's only "API" for this data is the flat-JSON lines it writes
// via sdk.Log(...) (../sdk/sdk.go:16) at six call sites in ../contract/main.go:
//
//	CreateRound  -> {"ev":"round_created","roundId":N,"by":"hive:acct"}
//	Bet          -> {"ev":"bet","roundId":N,"outcome":K,"acct":"hive:acct","amount":"<base units>"}
//	Settle       -> {"ev":"resolved","roundId":N,"state":"settled"|"void","winner":K,"reason":"..."}
//	VoidStale    -> {"ev":"voided","roundId":N,"reason":"..."}
//	Claim        -> {"ev":"claim","roundId":N,"acct":"hive:acct","payout":"<base units>","asset":"hive"|"hbd"}
//	WithdrawFees -> {"ev":"house_paid","asset":"hive"|"hbd","amount":"...","house":"hive:lordbutterfly"}
//
// Design, top to bottom:
//
//   - events.go    — typed structs for each ev:* shape + ParseEvent, a
//     tolerant decoder (unknown "ev" values and malformed JSON are reported,
//     never panics).
//   - source.go    — the EventSource interface every event origin implements,
//     abstracting the indexer from HOW logs are fetched.
//   - mock_source.go — MockEventSource: an in-memory, ordered event list for
//     tests and the demo. This is what makes the package fully unit-testable
//     TODAY, before the contract is deployed (see DEPLOY-RUNBOOK.md).
//   - gql_source.go  — GQLEventSource: the real, VSC-GQL-backed implementation.
//     Documented in full but returns ErrNotImplemented — it needs a deployed
//     contract AND (see the comment there) a small GraphQL schema addition
//     that does not exist yet upstream.
//   - index.go     — Index, the aggregator: folds a stream of RawEvent into
//     queryable per-round and per-account state (RoundSummary, Bettors,
//     MyPositions, MyUnclaimed, HouseTaken).
//   - api.go       — JSON-shaped DTOs whose field names/types are deliberately
//     aligned with the frontend's RoundState/MyPosition
//     (hive-blog-rebuild/apps/blog/features/prediction-market/types.ts), so a
//     future VscMarketDataSource can consume this package's output with
//     minimal translation.
//   - http.go      — a minimal stdlib net/http.Handler exposing the above as
//     a small JSON API (GET-only, no external router — Go 1.22's
//     http.ServeMux method+wildcard patterns are enough).
//   - scenario.go  — the canonical "1 round, 5 bettors, 3 claim" event
//     sequence shared by the tests and the demo, so what you see in the
//     pasted demo output is exactly what the tests assert.
//   - demo.go / cmd/demo/main.go — RunDemo ingests the canonical scenario
//     from a MockEventSource and prints every aggregate the contract itself
//     cannot answer.
//
// Stdlib only: encoding/json, math/big, net/http, sort, strconv, strings,
// sync. No third-party imports, no SDK/wasm dependency — this package runs
// under plain `go test` on any machine, exactly like ../market.
package indexer
