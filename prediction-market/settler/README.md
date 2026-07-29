# settler — the prediction market's round opener and settle keeper

Magi has no on-chain clock: a contract cannot wake itself up. A round has to be
**opened** by someone sending `roll`, and **resolved** by someone sending
`settle`. This is that someone.

**It is a courier, not an authority.** Both operations are permissionless, and
`settle` pins the price to the first oracle tick at or after the settle block —
so whoever calls it cannot influence the outcome or pick a favourable moment.
Running this bot buys *liveness*, nothing else.

**If it dies, nobody loses money.** A round left unsettled past its window VOIDs
and refunds every staker, and any staker can force that alone with `reclaim`.
That is precisely why a bot is the right answer here and an on-chain scheduler
(a consensus feature, with chain-halt blast radius) is not.

## Why it needs to exist at all

The contract ships with **no house fee**, and the keeper's tip is carved out of
that fee — `min(fee, max(SettleBounty, pool·20bps))`. Fee zero means tip zero, so
no stranger has a reason to spend resource credits settling. Someone has to, and
that someone is us. If a self-funding market is ever wanted instead, the fix is
to carve the tip from the pool rather than the fee — a contract change, and it
stops being strictly zero-rake.

## Running it

Dry run first, always. It reads chain state, decides, prints the exact op it
would broadcast, and touches nothing:

```sh
go run ./cmd/settler \
  --gql https://<magi-graphql> \
  --contract vsc1... \
  --net-id <deploy net_id> \
  --account settler-bot
```

Arm it with `--live` (testnet):

```sh
export SETTLER_POSTING_WIF=5...          # env only — never a flag
go run ./cmd/settler --live \
  --node https://<hive-testnet-rpc> \
  --gql ... --contract ... --net-id ... --account settler-bot
```

Mainnet needs a second, explicit opt-in:

```sh
go run ./cmd/settler --live --allow-mainnet --node https://api.hive.blog ...
```

`--once` runs a single cycle and exits, for cron or for checking a deployment.
`--interval` (default 60s) sets the poll rate for the long-running mode.

## The key it holds

**A posting key, and it must stay a posting key.** Every op this bot sends —
`roll`, `settle`, `voidStale` — carries no `transfer.allow` intent and moves none
of its own money, so posting authority is sufficient. The key should be worthless
if stolen. Do not upgrade it to an active key to make something else work; the
broadcaster refuses any op that asks for active authority rather than signing it.

Four things it refuses to do, all at startup or before any network call:

- run without a key when `--live` (and it will not read one from a flag)
- run against mainnet without `--allow-mainnet`
- run with a key that is **not** a posting key of `--account` — otherwise every
  transaction is rejected by Hive forever and the bot looks perfectly healthy
- run with a **multisig** posting authority it cannot satisfy alone

## Why this is a separate Go module

`hivego` (Hive transaction signing) requires Go >= 1.24. The parent module exists
to build the contract to wasm with TinyGo on a deliberately conservative
toolchain. If hivego lived in the parent, a dependency of the *bot* could break
the build of the *contract*. So the bot is its own module and reuses the parent's
tested planner through a `replace` directive.

Build and test it with a 1.24 toolchain:

```sh
docker run --rm -u $(id -u):$(id -g) \
  -v /mnt/o/Lumen/prediction-market:/work -v /tmp/gocache:/gocache \
  -e HOME=/gocache -e GOMODCACHE=/gocache/mod -e GOCACHE=/gocache/build \
  -w /work/settler golang:1.24.2 sh -c 'go vet ./... && go test ./... -count=1'
```

## Statelessness, and why there is no leader election

Nothing is cached between cycles. Every poll re-reads block height, oracle tick
and round state, then decides from scratch. A crash, a restart, or two settlers
running at once all converge on the same decision from the same on-chain truth,
and a double-submitted settle is a harmless no-op — off-chain (a fresh read shows
the round resolved) and on-chain (the contract's own `StateOpen` gate). Run two if
you want redundancy.

## Not yet proven

Nothing has been broadcast. The oracle path in particular has never been
exercised against a live feed — this would be the first contract to consume
`pendulum.hive_moving_avg_bps`. The tick-pinning logic is tested against a
simulated feed only. First real proof is one round opened and settled on testnet.
