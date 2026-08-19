# Creator Tokens — status, 2026-07-28

Per-creator token on a bonding curve. You buy a creator's token, spend it on
their services, and the price moves with supply.

> **Deployment status, corrected 2026-08-19 (audit anomaly AN-01).** This line
> used to read "Nothing is deployed." It is deployed on Magi **testnet** as
> `vsc1BcaD8JrwJPAAN5cU1cHKCBdZrd7jz2WGt8` (`REACT_APP_CREATOR_TOKENS_NET_ID=vsc-testnet`)
> — the chain returns a real output CID for it, and a local rebuild with the
> pinned `tinygo/tinygo:0.41.1` recipe reproduced that CID byte for byte. One
> market has ever existed on it, creator = owner = only holder, ~9.9 testnet
> HBD, no third-party exposure. Nothing is on MAINNET. A status file that says
> "nothing is deployed" when something is, is how an audit ends up rating the
> wrong code.

**One-line state: the contract is feature-complete and the product is connected
to it. What remains is deployment, not code.**

---

## Verified as of this commit

| | |
|---|---|
| `go vet` | clean (core, keeper, sim, sim/analysis, cmd, contract/parse) |
| `go test -race` | green, all packages |
| Core tests | 391 |
| TinyGo wasm | 135,407 B, **29 entrypoints**, exit 0 |
| Frontend `tsc` | clean across the whole blog app |
| Frontend `eslint` | 0 errors |
| Payload self-test | green |
| End-to-end harness | 232 assertions |
| TS→Go golden cross-check | all 18 write actions parse under the contract's own parser |

`go build ./...` fails on the wasm-only `contract`→`runtime` package. That is
expected; always gate on the explicit buildable set:

```
go vet  ./core/ ./keeper/ ./sim/ ./sim/analysis/ ./cmd/... ./contract/parse/
go test ./core/ ./keeper/ ./sim/ ./sim/analysis/ ./contract/parse/ -race
```

Wasm build (the container user is `tinygo`, so HOME/GOMODCACHE must be
redirected):

```
docker run --rm -u $(id -u):$(id -g) \
  -v /mnt/o/Lumen/creator-tokens:/work \
  -v $HOME/go/pkg/mod:/tmp/gomod -v /tmp/tgcache:/tmp/tgcache \
  -e HOME=/tmp/tgcache -e GOMODCACHE=/tmp/gomod -e GOFLAGS=-mod=mod \
  -w /work tinygo/tinygo:0.41.1 \
  tinygo build -gc=custom -scheduler=none -panic=trap -no-debug \
  -target=wasm-unknown -o /tmp/tgcache/out.wasm ./contract
```

---

## How the money actually works

**Buying.** Tokens are minted on a linear curve, `reserve = k·S²/2`. A 10% trade
fee splits 5% creator / 5% platform. Selling redeems the exact curve slice, less
an exit tax that decays to zero over six weeks. The buyer's only slippage
protection is the `transfer.allow` they sign, so the quote is mandatory before
signing.

**Paying a creator.** The buyer's tokens move into contract-held escrow; the 12%
commission is a separate HBD leg, **carved out of** the posted price, not added
to it — a posted $200 service costs the buyer exactly $200. Then one of three
things happens:

- **Creator marks it delivered** → tokens go to the creator, commission to the
  platform.
- **Creator declines** (same window) → buyer gets everything back, tokens *and*
  commission. Not a black mark.
- **Creator ignores it** → after the deadline plus ~1h, *anyone* can trigger the
  refund. Buyer gets tokens back plus the commission minus a small retained
  slice; the creator gets a strike. Three strikes above a 25% miss rate shuts
  their inflows for seven days — sales only; every outflow stays open.

**What protects the buyer.** Money never reaches the creator until they respond.
The refund is permissionless, so a vanished creator cannot trap anyone, and it
works even while the market is frozen or paused. The buyer signs a maximum price,
so the creator cannot spike it mid-transaction. Answer and reclaim windows are
disjoint by construction, so block ordering can never decide which one wins.

**What does not.** Nothing judges whether the work was any good — the contract
never sees it. Marking a job delivered is **unilateral**: a creator can be paid
having done nothing. There is no dispute and no clawback. The buyer's recourse is
the rating they leave afterwards, and the fact that a creator who burns people
watches their own token's price fall. This is a deliberate design decision, not
an oversight.

---

## Architecture

```
core/          25 files, pure Go, stdlib only — all the money logic
contract/      TinyGo wasm wrapper, 29 entrypoints
magi-indexer/  YAML config for the Magi indexer (mappings + views)
keeper/        permissionless-op planner (no indexer dependency)
sim/           multi-seed behavioural simulation
```

### Reads come from two places, deliberately

**Chain state** answers anything that must be current to the block: balances,
phase, prices, the exit tax, a creator's own escrow inbox. Never replayed.

**The Magi indexer** answers everything that is a *history* or a *reverse* index —
questions contract state structurally cannot answer, because state is keyed
creator→holder and these ask the other way:

| View | Answers |
|---|---|
| `lumen_ct_balances` | which markets does this account hold? |
| `lumen_ct_price_history` | how has this token moved? |
| `lumen_ct_delivery_record` | does this creator deliver? |
| `lumen_ct_my_asks` | what have I paid for? |
| `lumen_ct_creator_earnings` | what have I earned? |
| `lumen_ct_discovery` | the ranked creator list |

`magi-mongo-indexer` is the official `vsc-eco` service — it reads contract logs
from the node's MongoDB, normalises them into Postgres from our YAML, and serves
Hasura GraphQL. It runs in production at `https://indexer.magi.milohpr.com`;
Altera uses it.

**This repo's own Go indexer was deleted** (~1,200 lines of logic, ~4,900 raw).
It folded the same events correctly and had no HTTP server, so nothing could ever
read it — two sources of truth, one unreadable.

Deleting it removed an implicit guard: its typed decode structs were enforcing
"money is a quoted string, counts are bare numbers". That check now lives in
`core/magi_mapping_contract_test.go`, against the real YAML — every mapped field
must be emitted, every emitted event mapped, every declared column filled, and
each column's type must match the wire. Five mutation probes, all caught.

---

## Rules the code enforces, and will keep enforcing

These are encoded as tests, not conventions. Breaking one turns something red.

1. **Non-payment and non-delivery never gate funds.** Sales can close; refunds,
   reclaims, sells and claims never do.
2. **A rating can never touch money.** It is reputation only —
   `TestRating_NeverGatesAnyFundPath` pins this. Only a paying buyer of a
   delivered job can rate, once. A fake rating costs a real escrow paid to the
   creator being lied about.
3. **Unavailable ≠ empty ≠ error.** A failed read never renders as "you hold
   nothing" or "no creators". Every screen distinguishes four states.
4. **Never invent a number.** Anything the chain cannot answer renders as absent
   with a stated reason. No fabricated charts, bios, or reputations.
5. **Ranking is on delivery only**, and it lives in SQL so no component can
   quietly re-rank on price. Unproven creators sort last — missing is not
   perfect. No volume anywhere: wash trading buys a fake record, and volume is
   the metric that pays for it.
6. **The curve exists once.** The chart derives price from supply with the same
   ported formula the buy button uses; a second copy is how a preview starts
   disagreeing with a charge.

---

## What is left

All three are deployment, not code.

1. **Testnet deploy**, then set `REACT_APP_CREATOR_TOKENS_CONTRACT_ID`,
   `_NET_ID`, `_GQL_URL`, `_INDEXER_URL`. Until all of those are set,
   `getCreatorTokensDataSource()` returns null and every surface honestly says
   "not available" — see `.env.blog.example`.
2. **Register `magi-indexer/*.yaml`** with a magi-mongo-indexer instance: set
   `address` to the deployed contract id and `fromBlockHeight` to its deploy
   block, then restart. It backfills automatically.
3. **Broadcaster active auth.** All 11 writes need ACTIVE authority and
   `requiredKeyType` appears nowhere in `broadcaster.ts`. Needs a runtime check,
   not a comment. This is the same class of bug already fixed in the keeper.

Then: one real HBD through a buy. Nothing above is proven until that passes.

---

## Notes for whoever picks this up

- Money is **base units** — 3 decimals for HBD, whole integers for token counts.
  Never run a token count through `humanToBaseUnits`; that is a silent 1000×
  error on a fund path.
- HBD→USD is 1:1 in exactly one function (`live/adapt.ts`, `usdFromHbd`). HBD is
  the dollar-pegged asset, so the peg *is* the mapping. If it ever breaks, that
  function is the only place to fix.
- The shop's price fields are **unquoted numbers** on the wire, unlike every
  other money field. Sending a quoted string there posts a free service.
- `market/store.ts` is the old in-memory demo. Nothing imports it any more. It
  can go once nobody wants it as a reference.

Longer history, including every ruling and audit pass, is in
`/mnt/o/LUMEN-DOCS/creator-tokens/` — start with `GAP-LIST-2026-07-28.md`.
