// Magi Creator Tokens — prepaid access credits with a reserve floor.
//
// The `core` package is pure Go (no SDK, no go-vsc-node import) so every
// fund-critical path runs under plain `go test` on any machine. The wasm
// contract layer (contract/) wraps it with the VSC SDK and is built with
// TinyGo 0.39, exactly as hive-price-market does.
//
// Spec: /mnt/o/CREATOR-KEYS-2026-07-20/SPEC-CREATOR-KEYS.md §1
module creator-tokens

go 1.22

require github.com/CosmWasm/tinyjson v0.9.0

require github.com/josharian/intern v1.0.0 // indirect
