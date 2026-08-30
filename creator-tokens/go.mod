// Magi Creator Tokens — prepaid access credits with a reserve floor.
//
// The `core` package is pure Go (no SDK, no go-vsc-node import) so every
// fund-critical path runs under plain `go test` on any machine. The wasm
// contract layer (contract/) wraps it with the VSC SDK and is built with
// TinyGo 0.41.1 — pinned, and NOT a matter of taste. The toolchain version is
// part of the contract's IDENTITY: the deployed code is addressed by the CID of
// the wasm, and a different TinyGo emits a different binary and therefore a
// different CID. Measured 2026-08-30 on this exact source:
//     0.41.1 -> 149608 bytes, bafkreiajgng3ozcazro5goha34f2yfs265iylzi6rr5pk6ttent7s5xocu
//     0.39.0 -> 148622 bytes, bafkreib5nepei3rw432waausvqus77abvkh53ar2gp3rwyx6p6bz5sy7si
// Only the first is in the frontend's V2_CODE_CIDS allow-list
// (features/creator-tokens/market/contract-rules.ts). Build with 0.39 and the
// app treats the chain as v1 FOREVER — wind-down on lapse, renew refused on a
// delisted market — silently, and failing "safe" so nothing alarms. This header
// used to say 0.39 and was wrong; do not build by hand, use ./build-wasm.sh.
//
// Spec: /mnt/o/CREATOR-KEYS-2026-07-20/SPEC-CREATOR-KEYS.md §1
module creator-tokens

go 1.22

require github.com/CosmWasm/tinyjson v0.9.0

require github.com/josharian/intern v1.0.0 // indirect
