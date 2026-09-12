# The real-wasm execution harness

`creator_tokens_escrow_test.go.govsc` is a COPY, kept here so the proof travels
with the contract it proves. It runs from inside go-vsc-node, not from here:

```
cp creator_tokens_escrow_test.go.govsc \
   /home/clauderfly/go-vsc-node/modules/wasm/e2e/creator_tokens_escrow_test.go
cd /home/clauderfly/go-vsc-node
. ~/.wasmedge/env
go test ./modules/wasm/e2e/ -run TestCreatorTokens_EscrowFiveStepPath -count=1 -v
```

It loads `/mnt/o/Lumen/creator-tokens/bin/main.wasm` directly, so it tests the
DEPLOY CANDIDATE and not a rebuild of it. Build the wasm first
(`bash ../build-wasm.sh`) or it will certify whatever binary happens to be there.

## Why this and not a testnet

A testnet proof of the escrow path needs about three days of chain clock: the
long TWAP arm will not price an ask until `LongMinObsBlocks` (57,600 blocks) of
spaced observations exist, `MinAskDeadline` is 28,800 blocks, and `ReclaimGrace`
another 1,200. go-vsc-node's `lib/test_utils.ContractTest` runs the real wasm
through the real runtime with a controllable block height and the production gas
and resource-credit meters, so the same five steps run in half a second with an
exact clock. It is strictly better than a devnet for time-gated paths, and it
reports RC figures that can be checked against mainnet (`register` 1,392 here
against ~1,798 measured on chain).

What it does NOT cover, and a testnet still would: L1 transaction plumbing,
Keychain signing, the indexer, and an in-place update over aged multi-market
state. Those are deploy-rehearsal concerns, not contract-logic ones.

## The three guards the fixture has to clear at once

A fixture that misses any one of these PASSES while proving nothing, so all
three are asserted rather than assumed:

1. **C2 depth ceiling** - `face <= 50% of area(supply)`.
2. **Spend cap** - `credits <= 5% of supply` (`MaxSpendSupplyBps` 500).
3. **A non-zero commission** - `floor(credits x 12%)` is 0 below 9 credits, so a
   small ask makes every assertion about the split vacuous.

The current fixture (1,000 tokens of supply against a 250.000 HBD face, 43
credits, 5 of them commission) sits inside all three with room, and the vacuity
guards in the file fail loudly if a future edit moves it out.
