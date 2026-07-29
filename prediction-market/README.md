# Hive Price Weekly Market (Magi/VSC)

A weekly **parimutuel prediction market on the $HIVE price**, settled objectively
from the on-chain Hive witness feed. Built 2026-07-19 via recon → build-map →
4-council red-team → build → decorrelated review → fix loop. See `BUILD-MAP.md`
for the full design + council adjudication.

> **Handles real user funds.** Every design choice is judged on fault + damage,
> not who can trigger it.

## Architecture

- **`market/`** — pure Go, no SDK, no `go-vsc-node` import. ALL fund logic + the
  state machine + payout math live here, so they run under plain `go test` on any
  machine. **117 fund-safety tests pass** (`go test ./market/`).
- **`contract/main.go`** — thin TinyGo wasm layer: 9 `//go:wasmexport` actions
  that parse the payload, read env (caller / block / oracle keys), call the
  `market` core, and execute SDK effects (`HiveDraw`/`HiveTransfer`/state).
  Compiles to 79,888 B with TinyGo 0.41.1 (verified 2026-07-29).
- **`sdk/`, `runtime/`** — vendored verbatim from `go-contract-template` (one
  import line rebased to this module, per the `magi-market` precedent).
- **`magi-indexer/`** — YAML config (event→table mappings + Hasura views) for
  `magi-mongo-indexer`, the official vsc-eco indexer. This is the ONLY read path
  for anything historical. This repo's own Go indexer was deleted 2026-07-29;
  see `STATUS.md`.

## Oracle

Settlement reads the **Hive witness feed already merged into every contract's
execution env**: `pendulum.hive_moving_avg_bps` (15-min MA), gated on BOTH
`pendulum.hive_ma_ok` AND `pendulum.trusted_hive_mean_ok`. It's an
interquartile-trimmed mean across trusted top witnesses — no external HTTP, no new
trust root. **Unit is HBD/HIVE bps** (the peg feed, a USD *proxy*) — markets must
be labeled as such (peg-break is a documented residual risk).

## Fund-safety properties (verified in `market/*_test.go`)

- **Zero-dust solvency** — winners claim `floor(stake·distRemaining/winRemaining)`
  with both remainders decrementing, so `Σ claims == distributable` exactly (last
  claimant gets the remainder); fuzzed 500 trials, never over-pays.
- **Fee snapshot per round** — an owner fee change never re-prices a live round.
- **No admin drain** — no `emergencyWithdraw`; `withdrawFees` is scoped to a
  separate fee balance, never stakes. (Explicit fix for the magi-market drain class.)
- **CEI** everywhere; **no double-resolution** (settle/void terminal + mutually
  exclusive); **no double-claim**; **bet-after-lock rejected** (direct block check);
  **losing stake forfeited** (never refunded on a settled round); native-asset only
  (received == requested); big.Int throughout (int64 narrowing aborts on overflow).
- **voidStale can't preempt** a settleable round during the settle window (review
  finding 1 fix); min lock→settle gap enforced.

## Build & test

```bash
# Pure fund-critical core — runs anywhere with Go 1.22+:
GOTOOLCHAIN=local go test ./market/ -count=1        # 117 tests

# wasm contract (TinyGo 0.39 via Docker — native tinygo optional):
docker run --rm -v "$(pwd)":/work -w /work tinygo/tinygo:0.39.0 \
  tinygo build -gc=custom -scheduler=none -panic=trap -no-debug \
  -target=wasm-unknown -o bin/main.wasm ./contract

# wasm integration tests (needs go-vsc-node lib/test_utils, Go 1.25):
# cp bin/main.wasm test/artifacts/main.wasm && GOTOOLCHAIN=go1.25.7 go test ./test/ -count=1
```

## Not done / gated (for the user)

1. **Live deploy** — not deployed anywhere; deploy is a separate, explicit step
   (via the Magi deployer tool). Nothing here touches mainnet.
2. **Testnet oracle PoC** — this is the FIRST contract to consume
   `pendulum.*` env keys. A testnet integration test proving those keys are
   populated + non-stale on real state is REQUIRED before trusting settlement.
3. **Wasm integration tests** — the `market` core is fully tested; the wasm layer
   is compile-verified but not yet exercised through `go-vsc-node/lib/test_utils`
   (needs Go 1.25 + the harness). That harness suite is the next build step.
4. **Economic v1** — parimutuel late-window dilution is a known fairness gap
   (BUILD-MAP E-1); v0 mitigates with coarse buckets + lock gap + MA strike, and
   **time-decayed stake weighting** is the documented v1 fix.
5. Oracle residuals: HBD depeg circuit-breaker; behavior below 4 trusted witnesses.
