// Hive Price Weekly Market — Magi/VSC parimutuel prediction market.
//
// The `market` package is pure Go (no SDK, no go-vsc-node import) so the
// fund-critical logic runs under plain `go test` on any machine. The wasm
// contract layer (contract/) wraps it with the VSC SDK and is built with
// TinyGo 0.39 (see README).
module hive-price-market

go 1.22

require github.com/CosmWasm/tinyjson v0.9.0

require github.com/josharian/intern v1.0.0 // indirect
