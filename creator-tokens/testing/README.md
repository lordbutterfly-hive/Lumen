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

## The negative control, and why it matters more than the green run

`CREATOR_TOKENS_WASM` overrides the path. A green test proves nothing until you
have watched it go red for the right reason, so point it at the PREVIOUS
contract and check that it fails where the change is:

```
cd /mnt/o/Lumen && git archive b38d0bb^ creator-tokens | tar -x -C /tmp/old
cd /tmp/old/creator-tokens && bash build-wasm.sh      # CID will mismatch, expected
CREATOR_TOKENS_WASM=/tmp/old/creator-tokens/bin/main.wasm \
  go test ./modules/wasm/e2e/ -run TestCreatorTokens_EscrowFiveStepPath -v
```

Run 2026-09-12 it failed at the first divergence, which is exactly the change:
the old contract's `quote` returns `creditsPerAsk 38` and
`commissionOwedHbd 30000` (the 88/12 split with an HBD leg), there is no
`commissionCredits` field, and the vacuity guard fires. The new one returns 43
credits with 5 of them commission.

That run also produced a useful cross-check: building `b38d0bb^` reproduces
`bafkreigqshjvsnoauwq6eeiisibbpqpesw5ysuiyhp36rjl3i7xi4dwqwi`, the CID
`V2_CODE_CIDS` labels "v2 fee/display update (2026-09-09)" and the one activated
on chain at block 109824076. So the pre-change source IS the deployed contract,
and this update's diff is exactly deployed-to-candidate with nothing in between.

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

1. **C2 depth ceiling** - `face <= area(supply)` (`MaxServiceFaceAreaBps` 10000;
   it was 50% of area, 5000, before v5 on 2026-09-18).
2. **Spend cap** - `credits <= supply` (`MaxSpendSupplyBps` 10000; it was 5% of
   supply, 500, before v5). A coherent market reaches it only when the
   settlement rate sags below the backing per token, so a fixture that wants to
   exercise it must seed a sagged short window, not just a big face.
3. **A non-zero commission** - `floor(credits x 12%)` is 0 below 9 credits, so a
   small ask makes every assertion about the split vacuous.

The current fixture (1,000 tokens of supply against a 250.000 HBD face, 43
credits, 5 of them commission) sits inside all three with room, and the vacuity
guards in the file fail loudly if a future edit moves it out.

## The whole-token door (v6, 2026-09-22)

`TestCreatorTokens_V6WholeTokenDoor` (same file, own process) drives the
marketplace door through the wasm: a 3.50 position graduates into `bal|` = LE(3)
plus `balf|` = "50", `balanceOf` answers 3, `approve` 2 / `safeTransferFrom` 1+1
move whole tokens and decrement the whole-token allowance, a fractional
`amount` is refused, and sells inside a whole token emit `maturedMoved` only
while a sell across the boundary burns one `TransferSingle`.

**The harness's money model (measured 2026-09-22, do not fight it):** the
test ledger never compiles a buy's HBD draw. After any number of buys the
buyer's `GetBalance` still reads its deposit and `contract:<id>` reads 0 at
every height, so a payout (sell, refund) is honoured only out of the PENDING
draws of the same uncompiled slot; a sell after an `IncrementBlocks` with no
buy since is refused with `ledger_error insufficient balance` whatever the
reserve says. The five-step path's sells sit right behind its buys, which is
why they pay; the door test parks a 5-token buy in front of its sells for the
same reason. Money conservation is proven by core's ledger tests and on
devnet/testnet, not here. (Also: a deposit memo `&to=` longer than 16 chars
including the `hive:` prefix credits the SENDER, silently; `hive:lumencontracts`
is 18.)

## The devnet update rehearsal (v6, 2026-09-22)

`lumen_v6_units_devnet_test.go.govsc` is a copy of
`go-vsc-node/tests/devnet/lumen_v6_units_test.go` (the O-drive clone under
`/mnt/o/CLONES 2/HOME MAGI/go-vsc-node`). It deploys the v5.1 wasm, builds
whole-token state, queues the v6 wasm as an in-place code update through the
contract-deployer (the mainnet procedure, 30-block devnet timelock), waits for
activation and drives the decimal wire through the same contract id. Run:

```
cd "/mnt/o/CLONES 2/HOME MAGI/go-vsc-node" && . ~/.wasmedge/env
LUMEN_V6=1 DEVNET_PROJECT=devnet-test-9f179832 LUMEN_DEVNET_DATA=/home/clauderfly/devnet-data-<fresh> \
  go test -v -run '^TestLumenV6Units$' -timeout 70m ./tests/devnet/
```

Use a FRESH data dir every run: HAF leaves postgres-owned files behind that
need sudo to remove. The wasm paths default to ~/devnet-wasm/creator-tokens-v5.1.wasm
and creator-tokens-v6.wasm (LUMEN_WASM_V5 / LUMEN_WASM_V6 override them).
It caught the one defect the unit suite and the real-wasm harness could not:
the migration flag check trusted the host's ok bit (migrate_v6.go flagSet).
