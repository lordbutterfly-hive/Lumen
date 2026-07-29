// Settler bot — the off-chain process that opens and resolves prediction-market
// rounds. A SEPARATE MODULE from the contract on purpose.
//
// The parent module (hive-price-market) exists to build a wasm contract with
// TinyGo, and its `go` directive is deliberately conservative. This bot is
// ordinary server software: it needs hivego for Hive transaction signing, which
// requires Go >= 1.24. Putting that requirement in the parent module would raise
// the floor for the wasm build — so a dependency of the BOT could break the
// CONTRACT. Isolating it here makes that impossible, and the bot still reuses the
// parent's tested planner via the replace directive below.
module hive-price-market/settler

go 1.24

require (
	github.com/vsc-eco/hivego v0.0.0-20260224180332-508b8c394435
	hive-price-market v0.0.0
)

require (
	github.com/andybalholm/brotli v1.0.4 // indirect
	github.com/cfoxon/jsonrpc2client v0.0.0-20220410030230-4f361e74821a // indirect
	github.com/decred/base58 v1.0.4 // indirect
	github.com/decred/dcrd/crypto/blake256 v1.0.0 // indirect
	github.com/decred/dcrd/dcrec/secp256k1/v2 v2.0.0 // indirect
	github.com/klauspost/compress v1.15.0 // indirect
	github.com/valyala/bytebufferpool v1.0.0 // indirect
	github.com/valyala/fasthttp v1.35.0 // indirect
	golang.org/x/crypto v0.0.0-20220214200702-86341886e292 // indirect
)

replace hive-price-market => ../
