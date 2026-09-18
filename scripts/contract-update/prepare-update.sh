#!/usr/bin/env bash
# Prepare a vsc.update_contract for signing in Hive Keychain.
#
# WHY THIS EXISTS, AND WHY IT IS NOT THE OLD RUNBOOK. CONTRACT-DEPLOY-RUNBOOK's
# path puts the lumencontracts ACTIVE key into ~/deploy-mainnet/config in
# cleartext, broadcasts from Go, and ends with "shred the key" - a step that was
# not done after the 2026-09-01 deploy, so the mainnet active key has been
# sitting on this disk ever since. Keychain signs without the key ever leaving
# the extension, so the shred step stops being something to remember.
#
# ★ THE ONE THING A BROWSER CANNOT DO is the storage proof. It is an aggregated
# BLS signature: the deployer publishes the wasm over libp2p, waits for enough
# elected storage providers to sign the CID, and finalises a circuit. So this
# script does that part, bakes the result into a page, and hands the page to
# Keychain for the signature that actually costs money.
#
# ★★★ THE PROOF IS PERISHABLE AND A STALE ONE COSTS 10 HBD. state_engine verifies
# it against `GetElectionByHeight(tx.Self.BlockHeight)` - the election live at the
# block the transaction LANDS in. If an election turns over between this script
# and your click, the update fails with "invalid storage proof" while the 10 HBD
# transfer, an ordinary Hive op in the same transaction, goes through anyway.
# The page therefore re-reads the election epoch immediately before broadcasting
# and REFUSES if it has moved. Run this script, then sign. Do not run it today
# and sign tomorrow.
set -euo pipefail

NETWORK="${NETWORK:-mainnet}"
if [ "$NETWORK" = "mainnet" ]; then
  CONTRACT_ID="${CONTRACT_ID:-vsc1BisggC1NtviuYN1mSR372HGSU6hUfdZARt}"
  # api.vsc.eco DIED 2026-09-17 and is not coming back (the ex-founder stopped
  # paying for the machine; no ICMP, no TCP on 22/80/443, from two networks).
  # It used to be this default, which is not a wrong-chain bug but a HANG: step
  # 2 below curls it with --max-time 30 and the script exits 28 with no message
  # about why, holding a freshly built wasm and no page. Both live mainnet nodes
  # were verified against THIS contract on 2026-09-17 - same code CID, same
  # state, getStateByKeys/findContract/simulateContractCalls all answering. The
  # other one is https://magi.milohpr.com/api/v1/graphql (Milo, active witness);
  # pass it as GQL=... if techcoderx is down when you come to sign.
  GQL="${GQL:-https://vsc.techcoderx.com/api/v1/graphql}"
  NET_ID="vsc-mainnet"
  CURRENCY="HBD"
else
  CONTRACT_ID="${CONTRACT_ID:-vsc1BcaD8JrwJPAAN5cU1cHKCBdZrd7jz2WGt8}"
  GQL="${GQL:-https://magi-test.techcoderx.com/api/v1/graphql}"
  NET_ID="vsc-testnet"
  CURRENCY="TBD"
fi
GATEWAY="vsc.gateway"
FEE="10.000 ${CURRENCY}"
REPO=/mnt/o/Lumen/creator-tokens
WASM="$REPO/bin/main.wasm"
DEPLOYER=/home/clauderfly/go-vsc-node/build/contract-deployer-new
DRYDIR="${DRYDIR:-/home/clauderfly/deploy-dryrun}"
OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1/6  Rebuild the wasm and assert its CID"
( cd "$REPO" && TINYGO_CACHE="${TINYGO_CACHE:-/home/clauderfly/.cache/tinygo-ct}" bash build-wasm.sh >/dev/null ) \
  || { echo "FAIL: build-wasm.sh refused. Its CID guard is the whole point; do not bypass it." >&2; exit 1; }
NEW_CID=$(python3 - "$WASM" <<'PY'
import hashlib, base64, sys
d = hashlib.sha256(open(sys.argv[1],'rb').read()).digest()
print('b' + base64.b32encode(bytes([0x01,0x55,0x12,0x20]) + d).decode().lower().rstrip('='))
PY
)
SIZE=$(stat -c%s "$WASM")
echo "     $NEW_CID  ($SIZE bytes)"

say "2/6  Read the contract's CURRENT name/description off chain"
# NEVER a literal. system_txs.go takes both FROM the update tx and overwrites
# them unconditionally, and the two networks genuinely differ (testnet ends its
# description with a full stop, mainnet does not). A typo here silently renames
# a live contract.
CHAIN=$(curl -s --max-time 30 -X POST "$GQL" -H 'Content-Type: application/json' \
  -d "{\"query\":\"query(\$id:String!){findContract(filterOptions:{byId:\$id}){id code name description owner}}\",\"variables\":{\"id\":\"$CONTRACT_ID\"}}")
eval "$(python3 - "$CHAIN" "$CONTRACT_ID" <<'PY'
import json, sys, shlex
rows = json.loads(sys.argv[1])['data']['findContract']
row = next((r for r in rows if r['id'] == sys.argv[2]), None)
if row is None:
    sys.exit("FAIL: the chain does not know that contract id")
for k in ('code', 'name', 'description', 'owner'):
    print(f"CHAIN_{k.upper()}={shlex.quote(row[k] or '')}")
PY
)"
echo "     owner        $CHAIN_OWNER"
echo "     name         $CHAIN_NAME"
echo "     description  $CHAIN_DESCRIPTION"
echo "     code now     $CHAIN_CODE"
if [ "$CHAIN_CODE" = "$NEW_CID" ]; then
  echo; echo "ALREADY DEPLOYED: the chain is running this exact CID. Nothing to do, and nothing to pay."; exit 0
fi

say "3/6  Check the payer can actually pay"
BAL=$(curl -s --max-time 30 -X POST https://api.hive.blog -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"condenser_api.get_accounts","params":[["'"${CHAIN_OWNER#hive:}"'"]],"id":1}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['result'][0]['hbd_balance'])")
echo "     ${CHAIN_OWNER#hive:} holds $BAL, the update costs $FEE"
BAL_OK=$(python3 -c "print('yes' if float('$BAL'.split()[0]) >= 10.0 else 'no')")
if [ "$BAL_OK" != "yes" ]; then
  echo
  echo "     ★ NOT ENOUGH. The page will be written anyway so it is ready, but it"
  echo "       refuses to broadcast until the balance covers the fee. Top up"
  echo "       @${CHAIN_OWNER#hive:} with at least 10 HBD and re-run this script."
fi

say "4/6  Obtain a FRESH storage proof (libp2p, ~15s of signature collection)"
# ★ CAPTURED TO A FILE, NEVER THROUGH `| grep -m1`. With `set -o pipefail` an
# early-exiting grep hands the deployer a SIGPIPE and the whole substitution
# reports failure even when the proof was collected perfectly - which is exactly
# what happened on the first run of this script, and it reads like "could not
# collect enough signatures" when nothing of the sort went wrong.
LOG=$(mktemp -t ct-proof-XXXXXX.log)
# ★ `set +u` AROUND THE ENV SCRIPT. ~/.wasmedge/env dereferences variables that
# may be unset (LD_LIBRARY_PATH among them), so under `set -u` it aborts the
# subshell before the deployer ever runs - and the failure is SILENT, an empty
# log that reads like "the network refused us". Cost one confusing run.
( set +u; cd /home/clauderfly && . ~/.wasmedge/env 2>/dev/null; set -u; timeout 300 "$DEPLOYER" \
  -network "$NETWORK" -gqlUrl "$GQL" -contractId "$CONTRACT_ID" -wasmPath "$WASM" \
  -name "$CHAIN_NAME" -description "$CHAIN_DESCRIPTION" -data-dir "$(basename "$DRYDIR")" ) >"$LOG" 2>&1 || true
PROOF_RAW=$(grep -m1 '^storage proof ' "$LOG" || true)
if [ -z "$PROOF_RAW" ]; then
  echo "FAIL: no storage proof line. Last 15 lines of $LOG:" >&2
  tail -15 "$LOG" >&2
  exit 1
fi
# A dry run must NEVER have broadcast. The keyless config is the guarantee; this
# is the check that the guarantee held.
if grep -q '^tx id:' "$LOG"; then
  echo "FAIL: the dry run BROADCAST a transaction. $DRYDIR is supposed to have an empty HiveActiveKey." >&2
  exit 1
fi
rm -f "$LOG"
eval "$(python3 - "$PROOF_RAW" "$NEW_CID" <<'PY'
import re, sys, shlex
# The deployer prints Go's %v of the struct: `storage proof {<hash> {<sig> <bv>}}`.
# Parsed defensively and then CHECKED against the CID we just built, so a change
# to that print format fails here rather than producing a proof for other bytes.
m = re.match(r'^storage proof \{(\S+) \{(\S+) (\S+)\}\}\s*$', sys.argv[1])
if not m:
    sys.exit("FAIL: could not parse the storage proof line: " + sys.argv[1])
h, sig, bv = m.groups()
if h != sys.argv[2]:
    sys.exit(f"FAIL: the proof is for {h} but the wasm is {sys.argv[2]}")
print(f"PROOF_HASH={shlex.quote(h)}")
print(f"PROOF_SIG={shlex.quote(sig)}")
print(f"PROOF_BV={shlex.quote(bv)}")
PY
)"
echo "     proof for $PROOF_HASH  (bv $PROOF_BV)"

say "5/6  Record the election this proof was signed under"
EPOCH=$(curl -s --max-time 30 -X POST "$GQL" -H 'Content-Type: application/json' \
  -d '{"query":"{electionByBlockHeight{epoch block_height}}"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['electionByBlockHeight']['epoch'])")
echo "     epoch $EPOCH  (the page refuses to broadcast if this has moved)"

say "6/6  Write the signing page"
python3 "$OUT/render-page.py" \
  --out "$OUT/sign-update.html" --network "$NETWORK" --net-id "$NET_ID" \
  --contract-id "$CONTRACT_ID" --gql "$GQL" --gateway "$GATEWAY" --fee "$FEE" \
  --account "${CHAIN_OWNER#hive:}" --name "$CHAIN_NAME" --description "$CHAIN_DESCRIPTION" \
  --old-cid "$CHAIN_CODE" --new-cid "$NEW_CID" --wasm-size "$SIZE" \
  --proof-hash "$PROOF_HASH" --proof-sig "$PROOF_SIG" --proof-bv "$PROOF_BV" --epoch "$EPOCH"

cat <<EOF

Written: $OUT/sign-update.html

Serve it and open it - Keychain does NOT inject into file:// pages, only http(s):

    python3 -m http.server 8899 --bind 127.0.0.1 --directory $OUT
    then open  http://127.0.0.1:8899/sign-update.html

Sign PROMPTLY. The proof is tied to election epoch $EPOCH.
EOF
