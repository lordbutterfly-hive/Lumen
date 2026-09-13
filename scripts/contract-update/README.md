# Signing the Meritum contract update with Keychain

```sh
bash /mnt/o/Lumen/scripts/contract-update/prepare-update.sh
python3 -m http.server 8899 --bind 127.0.0.1 --directory /mnt/o/Lumen/scripts/contract-update
# open http://127.0.0.1:8899/sign-update.html
```

`NETWORK=testnet bash prepare-update.sh` targets the testnet contract instead.
(The repo lives on a Windows-mounted drive, which cannot store the executable
bit, so these run as `bash <script>` - the same note `build-wasm.sh` carries.)

To stop the server afterwards, find it by PORT, never with `pkill -f`:

```sh
ss -ltnp | awk '/127.0.0.1:8899/{print $NF}'    # then kill that pid
```

`pkill -f "http.server 8899"` matches the shell running the command too, and
kills it mid-script. That happened while writing this file.

## Why a page and not the deployer

The old runbook puts the `lumencontracts` ACTIVE key into
`~/deploy-mainnet/config/identityConfig.json` in cleartext and ends with "shred
the key". That step was not done after the 2026-09-01 deploy, so the mainnet
active key has been sitting on this disk ever since (mode 600 in a 700
directory, so not world-readable, but on disk). Keychain signs without the key
ever leaving the extension, so there is nothing to remember to shred.

## What the script does, and what it deliberately does not

It rebuilds the wasm through `build-wasm.sh` (whose CID guard is the point and is
never bypassed), reads the contract's **current name and description off the
chain** and sends them back unchanged, collects a storage proof, and writes the
page. It holds no key and cannot broadcast: the dry-run config has an empty
`HiveActiveKey`, and the script FAILS if a `tx id:` ever appears in the
deployer's output.

`owner` is deliberately absent from the transaction. The deployer only sets it
when `-owner` is passed, and a wrong one reassigns the contract to somebody else.
Absent means leave the owner alone.

## The storage proof, and the one way this costs 10 HBD for nothing

A browser cannot produce the proof. It is an aggregated BLS signature: the
deployer publishes the wasm over libp2p, waits for enough elected storage
providers to sign the CID, and finalises a circuit
(`modules/data-availability/client`).

`state_engine` verifies it against `GetElectionByHeight(tx.Self.BlockHeight)` -
the election live at the block the transaction LANDS in. **If an election turns
over between preparing and signing, the update fails with "invalid storage
proof" while the 10 HBD transfer, an ordinary Hive operation in the same
transaction, goes through anyway.** The page re-reads the epoch immediately
before broadcasting and refuses on a mismatch. Prepare, then sign. Not tomorrow.

## The four checks the page re-runs live

| check | why it exists |
|---|---|
| Keychain present | it injects on http(s) only, never `file://` - hence the local server |
| the chain still runs the expected old CID | catches "already deployed" and "the code moved under us" |
| the election epoch is unchanged | the money one, above |
| the payer holds the fee | `lumencontracts` held **0.100 HBD** when this was written |

The button stays disabled until all four are green. Verified 2026-09-13 by
loading the page with no extension against an unfunded account: two checks went
red, the button refused, and the text said which. A signing page nobody has
watched refuse is not a safe signing page.

## After broadcasting

The page polls `findContract` until the contract's own `code` equals the new CID,
for two minutes. **A green transaction is not a deployed contract** -
`update_contract` can be accepted on Hive and still be rejected inside the state
engine, which is exactly what a stale proof does, and the fee is spent either
way. Only the code read back means anything.
