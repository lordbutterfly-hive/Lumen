#!/bin/sh
# Deploy (update) the creator-tokens contract on Magi testnet.
#
# WHY THIS EXISTS. Deploying by hand means passing four flags correctly to a
# tool whose DEFAULTS ARE ALL WRONG FOR US, using a binary that may be stale,
# while remembering that one field silently overwrites contract metadata. Each
# of those cost real time on 2026-08-19 and every one of them fails QUIETLY.
# The whole point of this script is that none of them can be forgotten again.
#
#   ./scripts/deploy-creator-tokens.sh --dry-run   # build + inspect, no broadcast
#   ./scripts/deploy-creator-tokens.sh --go        # broadcast the update
#
# ─────────────────────────────────────────────────────────────────────────────
# THE FOUR TRAPS, and how this script closes each one
#
# 1. STALE BINARY. Both prebuilt `contract-deployer` binaries on this machine
#    predate the source: neither has `-no-broadcast` (dry run) or
#    `-cancel-update` (the escape hatch inside the timelock). This script builds
#    from source every time, so what runs always matches what is in the clone.
#
# 2. `-gqlUrl` DEFAULTS TO MAINNET (`https://api.vsc.eco/api/v1/graphql`). It
#    feeds the election lookup behind the storage proof. Overridden below.
#
# 3. `-data-dir` DEFAULTS TO `data`, i.e. `$HOME/data/config`, which on this
#    machine holds a PLACEHOLDER key and MAINNET Hive API URLs. The real
#    testnet config is `$HOME/deploy-testnet/config`. Overridden below.
#
# 4. `vsc.update_contract` OVERWRITES NAME AND DESCRIPTION UNCONDITIONALLY
#    (go-vsc-node system_txs.go). Passing neither does not "leave them alone" —
#    it blanks them. This script READS the live values off chain and passes them
#    straight back, so metadata survives a deploy by construction.
#
# Also worth knowing, though the deployer handles them:
#   - The 10 TBD fee is LOAD-BEARING. Code changes only when a fee op is
#     present; without it the update succeeds and silently changes nothing.
#   - Testnet timelock is 30 blocks (~90s). The old code runs until activation,
#     and the update can be cancelled during that window.
set -eu

CONTRACT_ID="vsc1BcaD8JrwJPAAN5cU1cHKCBdZrd7jz2WGt8"
NETWORK="testnet"
GQL="https://magi-test.techcoderx.com/api/v1/graphql"
DATA_DIR="deploy-testnet"                 # relative to $HOME — see trap 3
CLONE="/mnt/o/CLONES 2/HOME MAGI/go-vsc-node"
REPO="/mnt/o/Lumen/creator-tokens"
WASM_OUT="/tmp/creator-tokens-deploy.wasm"
DEPLOYER="/tmp/contract-deployer-built"

MODE="${1:-}"
case "$MODE" in
  --dry-run|--go) ;;
  *) echo "usage: $0 --dry-run | --go" >&2; exit 2 ;;
esac

echo "==> 1/5  the tree must be clean, or the deployed CID maps to no commit"
if [ -n "$(git -C /mnt/o/Lumen status --porcelain -- creator-tokens)" ]; then
  echo "REFUSING: /mnt/o/Lumen/creator-tokens has uncommitted changes." >&2
  echo "The chain is the deploy record; commit first so the CID maps to a SHA." >&2
  exit 1
fi
echo "    commit: $(git -C /mnt/o/Lumen rev-parse --short HEAD)"

echo "==> 2/5  build the wasm with the pinned TinyGo recipe"
mkdir -p /tmp/tgcache
docker run --rm -u "$(id -u):$(id -g)" \
  -v "$REPO":/work -v "$HOME/go/pkg/mod":/tmp/gomod -v /tmp/tgcache:/tmp/tgcache \
  -e HOME=/tmp/tgcache -e GOMODCACHE=/tmp/gomod -e GOFLAGS=-mod=mod \
  -w /work tinygo/tinygo:0.41.1 \
  tinygo build -gc=custom -scheduler=none -panic=trap -no-debug \
  -target=wasm-unknown -o /tmp/tgcache/deploy.wasm ./contract
cp /tmp/tgcache/deploy.wasm "$WASM_OUT"
echo "    built: $(wc -c < "$WASM_OUT") bytes"

echo "==> 3/5  build the deployer from source (trap 1: the prebuilt ones are stale)"
LD_LIBRARY_PATH="$HOME/.wasmedge/lib" \
CGO_CFLAGS="-I$HOME/.wasmedge/include" CGO_LDFLAGS="-L$HOME/.wasmedge/lib" \
  go build -C "$CLONE" -o "$DEPLOYER" ./cmd/contract-deployer
echo "    deployer: $DEPLOYER"

echo "==> 4/5  read the LIVE name/description (trap 4: an update blanks them)"
META=$(curl -s -X POST "$GQL" -H 'content-type: application/json' \
  -d "{\"query\":\"{ findContract(filterOptions:{byId:\\\"$CONTRACT_ID\\\"}) { name description } }\"}")
NAME=$(printf '%s' "$META" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["findContract"][0]["name"])')
DESC=$(printf '%s' "$META" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["findContract"][0]["description"])')
[ -n "$NAME" ] || { echo "REFUSING: could not read the live contract name." >&2; exit 1; }
echo "    preserving name: $NAME"
echo "    preserving desc: $DESC"

echo "==> 5/5  $( [ "$MODE" = "--go" ] && echo 'BROADCAST' || echo 'dry run' )"
set -- -network "$NETWORK" -data-dir "$DATA_DIR" -gqlUrl "$GQL" \
       -contractId "$CONTRACT_ID" -wasmPath "$WASM_OUT" \
       -name "$NAME" -description "$DESC"
[ "$MODE" = "--dry-run" ] && set -- "$@" -no-broadcast

cd "$HOME"   # -data-dir is resolved relative to the working directory
LD_LIBRARY_PATH="$HOME/.wasmedge/lib" "$DEPLOYER" "$@"

echo
echo "Activation takes ~30 blocks (~90s) on testnet; the OLD code runs until then."
echo "To verify:  curl -s -X POST $GQL -H 'content-type: application/json' \\"
echo "              -d '{\"query\":\"{ findContract(filterOptions:{byId:\\\"$CONTRACT_ID\\\"}) { code } }\"}'"
echo "To abort inside the window:  $DEPLOYER -network $NETWORK -data-dir $DATA_DIR \\"
echo "                               -gqlUrl $GQL -contractId $CONTRACT_ID -cancel-update"
