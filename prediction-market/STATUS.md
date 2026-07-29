# Prediction Market — status, 2026-07-29

A weekly parimutuel market on the price of HIVE. You back a price bucket, the
oracle settles it, winners split the pool. Nothing is deployed.

**One-line state: the contract is finished and decentralized, the read path is
migrated to Magi's indexer, and the UI no longer renders anything fabricated.
What remains is a deployment and one product decision about who settles.**

---

## Verified as of this commit

| | |
|---|---|
| `go vet` | clean (market, scheduler, sim, cmd) |
| `go test` | green — market 117, scheduler, sim |
| TinyGo wasm | **79,888 B, 9 entrypoints**, exit 0 |
| Frontend `tsc` | clean across the whole blog app |
| Frontend `eslint` | 0 errors, 0 warnings in `features/prediction-market` |
| Pool-series self-test | 10/10 |
| Mapping tripwire | 6 tests, all 6 mutation-proven red |

`go build ./...` fails on the wasm-only `contract`→`runtime` package. That is
expected; always gate on the explicit buildable set:

```
go vet  ./market/ ./scheduler/ ./sim/ ./cmd/...
go test ./market/ ./scheduler/ ./sim/ ./cmd/... -count=1
```

Wasm build (the container user is `tinygo`, so HOME and GOMODCACHE must be
redirected — and note `$HOME/go/pkg/mod` on this box is root-owned and
unwritable by the container uid, so point GOMODCACHE at scratch):

```
docker run --rm -u $(id -u):$(id -g) \
  -v /mnt/o/Lumen/prediction-market:/work \
  -v /tmp/tgcache:/tmp/tgcache \
  -e HOME=/tmp/tgcache -e GOMODCACHE=/tmp/tgcache/gomod -e GOFLAGS=-mod=mod \
  -w /work tinygo/tinygo:0.41.1 \
  tinygo build -gc=custom -scheduler=none -panic=trap -no-debug \
  -target=wasm-unknown -o /tmp/tgcache/pm.wasm ./contract
```

---

## How the money works

Stakes go into one pool per bucket. At settlement the winning bucket's backers
split the **entire** pool in proportion to their stake — **there is no house
take**. `DefaultFeeBps` is 0 and `DefaultHouseAccount` is empty; the fee
mechanism still exists in the core but is off, retained only so the fuzzers keep
covering that arithmetic.

The split is zero-dust: each claim takes `floor(stake · remaining / winRemaining)`
with both remainders decrementing, so the sum of claims equals the distributable
pool exactly and the last claimant absorbs the rounding. Fuzzed, never overpays.

**Nobody can trap the funds.** Three independent escapes, all permissionless:
settling past the window auto-voids and refunds everyone; `voidStale` forces a
void past the deadline plus grace; and `reclaim` lets any individual staker void
a stuck round and pull their own stake in one call, needing no oracle, keeper or
owner. Long after resolution `sweepUnclaimed` sends still-unclaimed money to the
Hive DHF rather than burning it or stranding it.

---

## "Does the round settle itself?" — yes and no, and the difference matters

**Yes, in the sense that matters for trust.** Nobody privileged is involved and
no caller can influence the result. `roll` opens a round and derives every strike
and deadline in-contract from the witness oracle. `settle` pins the price to the
FIRST oracle tick at or after the settle block, so the outcome is fixed by the
schedule, not by who calls or when they call within the window. All the
owner-gated entrypoints were deleted — the contract exposes only permissionless
actions.

**No, in the sense that something must still send a transaction.** Magi has no
on-chain scheduler. A round sits until someone calls `roll`, and a settleable
round sits until someone calls `settle`.

**The consequence, and it needs a decision.** If nobody settles within the
window, the round VOIDs and everyone is refunded. Funds are safe — but a market
that voids every week is not a market. The keeper bounty was designed to pay for
that call, and it is carved out of the protocol fee: `computeBounty` is
`min(fee, max(SettleBounty, pool·20bps))`. **With the fee at zero, the bounty is
also zero,** so no stranger has a reason to spend resource credits settling. The
zero-rake decision and the settle incentive are the same knob.

Three ways out, for the operator to choose:

1. **Run the keeper** (`scheduler/`, built, 41 tests, plans `roll` and `settle`
   and decides when to void). Its `HiveBroadcaster` is an explicit stub pending a
   signing key. This keeps zero rake and costs us one small always-on process.
2. **Carve the bounty from the pool instead of the fee** — winners pay a few
   basis points to whoever settles. Not a house take, but it is no longer
   strictly zero-rake, and it changes the legal framing the zero-rake decision
   was made to protect.
3. **Accept occasional voids.** Honest and safe, and probably fatal to the
   product.

Recommendation: (1). It preserves both the zero rake and the decentralization,
and the failure mode if the keeper dies is a refund, not a loss.

---

## The read path: Magi's indexer, and only Magi's indexer

Chain state answers anything that must be current to the block: pools, status,
a caller's own stake, whether they have claimed. The frontend reads that
directly over GraphQL `getStateByKeys` and it needs no indexer at all.

Everything **historical** or **cross-account** comes from `magi-mongo-indexer`
via Hasura, configured by `magi-indexer/*.yaml`:

| View | Answers |
|---|---|
| `lumen_pm_round_state` | is this round open, settled or void? |
| `lumen_pm_round_pools` | how much is on each bucket? |
| `lumen_pm_round_summary` | the round card and the history list |
| `lumen_pm_my_positions` | what am I in? |
| `lumen_pm_my_unclaimed` | where do I still have collectable money? |
| `lumen_pm_price_history` | the oracle price at each round open |
| `lumen_pm_pool_history` | how the pools moved during a round (the chart) |

**This repo's own Go indexer was deleted** (~2,300 lines). Two reasons, either
sufficient:

- **It could never be fed.** go-vsc-node persists every contract log, but its
  public GraphQL type `ContractOutputResult` exposes only `ret` and `ok` — there
  is no path from `findContractOutput` to the logs. Its production event source
  was a documented stub waiting on an upstream schema change nobody had
  scheduled. Meanwhile the frontend called its REST endpoints into thin air and
  degraded silently to zero.
- **It had rotted, undetected.** It knew `round_created` and `house_paid` —
  neither of which the contract can emit any more — and knew nothing of `roll`,
  `reclaim` or `sweep`, three of the seven events it actually writes. Not one
  test went red.

Deleting it removed an implicit guard: its typed decode structs were enforcing
"money is a quoted string, ids and counts are bare numbers". That check now lives
in `market/magi_mapping_contract_test.go`, which reads the contract's actual log
literals and the real YAML and fails if any event is unmapped, any field
misnamed, any column unfilled, or any declared type disagrees with the wire. Six
mutation probes, all six caught.

**One change was required on our side:** magi-mongo-indexer identifies a log by a
field called `type` (`internal/indexer/mapper/mapper.go:87-92`, verified at
source). Our contract emitted `ev`. All seven log sites were renamed. Nothing is
deployed, so this was free now and a migration later.

---

## Rules the code enforces

1. **No house take.** Winners split the whole pool.
2. **No privileged operations.** There are no owner-gated entrypoints to call.
3. **Funds can always come back.** Every stuck-round path terminates in a refund
   that any staker can trigger alone.
4. **Unknown is not zero.** The bettor count renders as absent or an em dash when
   the indexer cannot answer, never as `0` — which would assert that nobody has
   bet. Same rule for the chart: no history means the flat line is drawn AND
   labelled a placeholder.
5. **The chart never interpolates.** It is folded from real bets, forward-filled
   in BigInt, and returns nothing at all below two blocks of history — one point
   drawn as a line is a claim the odds held steady.

---

## What is left

1. **Testnet deploy**, then set `REACT_APP_VSC_MARKET_CONTRACT_ID`, `_NET_ID`,
   `_GQL_URL`, and `_INDEXER_URL`. Until the first three are set the market
   honestly reports itself unavailable; until `_INDEXER_URL` is set the bettor
   count and chart history read as unknown.
2. **Register `magi-indexer/*.yaml`** with a magi-mongo-indexer instance: set
   `address` to the deployed contract id and `fromBlockHeight` to its deploy
   block, then restart. It backfills automatically.
3. **The settle decision above**, and if it is the keeper: give
   `scheduler.HiveBroadcaster` a real signing path. An active key is not needed —
   `roll` and `settle` are permissionless and pay nobody — so a funds-less
   throwaway account is enough.
4. **The oracle has never been exercised.** This would be the first contract to
   consume `pendulum.hive_moving_avg_bps`. The tick-pinning logic is tested
   against a simulated feed only; a testnet round is the proof.

---

## Notes for whoever picks this up

- Money is **base units** — 3 decimals. It travels as quoted text everywhere,
  including through the indexer. Never let it touch a float.
- The oracle feed is **HBD/HIVE basis points** — a peg proxy, not a USD price.
  Label it that way wherever it is shown; a peg break is a documented residual
  risk, not a handled case.
- `winner` on a resolved event is only meaningful when `state = 'settled'`. The
  void path never sets it, so it reads back as 0, which collides with a real
  winning bucket index of 0. Every view gates on state before touching it.
- A `reclaim` row proves its round is void. `market.Reclaim` refuses a settled
  round outright (`market/reclaim.go:52-56`) and emits no separate void log, so
  it is the only record that a reclaim-voided round ended.
