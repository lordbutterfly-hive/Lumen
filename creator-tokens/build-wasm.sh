#!/usr/bin/env bash
# Build the creator-tokens contract wasm with the PINNED toolchain, and refuse
# to hand back a binary whose CID is not the one the frontend allow-lists.
#
# WHY THIS IS A SCRIPT AND NOT A NOTE. go.mod's header said "TinyGo 0.39" for
# months while the shipping binary was 0.41.1. Nothing caught it, because a
# comment is not a control. Building with 0.39 produces a DIFFERENT wasm and so
# a different CID, and the app pins itself to v1 rules forever on an unlisted
# CID (features/creator-tokens/market/contract-rules.ts, header items 2 and 3) —
# silently, and in the "safe" direction, so no alarm ever fires. The only way
# that cannot happen again is if the build itself asserts the CID.
# NOTE: this repo lives on a Windows-mounted drive, which cannot store the unix
# executable bit. Run it as `bash build-wasm.sh`, or `chmod +x` it after a
# checkout onto a Linux filesystem.
set -euo pipefail

IMAGE="tinygo/tinygo:0.41.1"
OUT="${1:-bin/main.wasm}"
# The CID the frontend's V2_CODE_CIDS allow-lists for v2. If you INTEND to change
# the contract, this line and that allow-list move together, in that order.
EXPECTED_CID="bafkreiajgng3ozcazro5goha34f2yfs265iylzi6rr5pk6ttent7s5xocu"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# ★ THE TINYGO CACHE MUST LIVE ON A REAL LINUX FILESYSTEM. This repo is on a
# Windows-mounted drive, and TinyGo chmods inside its cache: mounting a drvfs
# path as HOME fails with
#   chmod /tgcache/.cache/tinygo/...: operation not permitted
# and the build dies with nothing wrong with the source. Keep the cache off the
# repo (it is not source anyway), overridable for CI.
cache="${TINYGO_CACHE:-${TMPDIR:-/tmp}/tinygo-cache-creator-tokens}"
mkdir -p "$cache" "$(dirname "$here/$OUT")"

docker image inspect "$IMAGE" >/dev/null 2>&1 || {
  echo "FAIL: $IMAGE is not present. Pull it; do NOT substitute another version." >&2
  exit 2
}

rm -f "$here/$OUT"
docker run --rm \
  -v "$here":/src -v "$cache":/tgcache \
  -e HOME=/tgcache -w /src -u "$(id -u):$(id -g)" \
  "$IMAGE" \
  tinygo build -gc=custom -scheduler=none -panic=trap -no-debug \
    -target=wasm-unknown -o "/src/$OUT" ./contract

# A missing artifact must FAIL, never pass quietly with nothing to check.
[ -s "$here/$OUT" ] || { echo "FAIL: no wasm was produced at $OUT" >&2; exit 3; }

cid=$(python3 - "$here/$OUT" <<'PY'
import hashlib, base64, sys
d = hashlib.sha256(open(sys.argv[1],'rb').read()).digest()
print('b' + base64.b32encode(bytes([0x01,0x55,0x12,0x20]) + d).decode().lower().rstrip('='))
PY
)

size=$(stat -c%s "$here/$OUT")
echo "built  $OUT  ${size} bytes"
echo "cid    $cid"

if [ "$cid" != "$EXPECTED_CID" ]; then
  cat >&2 <<MSG
FAIL: CID MISMATCH
  got      $cid
  expected $EXPECTED_CID
This binary is NOT the one the frontend allow-lists. Deploying it makes every
client treat the chain as v1 forever. Either the source changed on purpose — in
which case update EXPECTED_CID here AND V2_CODE_CIDS in
features/creator-tokens/market/contract-rules.ts, and redeploy the frontend
FIRST (contract-rules.ts header, deploy order) — or your toolchain is wrong.
MSG
  exit 1
fi
echo "OK: CID matches the frontend's V2_CODE_CIDS entry."
