#!/usr/bin/env bash
# Ship apps/blog to lumensocial.net, and refuse to claim success it has not earned.
#
# Every guard here exists because its absence already cost a round:
#  · --delete on the first two rsyncs. Without it, chunks from previous builds
#    stay on the server forever. They are content-hashed so the app still serves
#    correctly, but a grep of the deployed bundle then reports code that is no
#    longer used, which is exactly how a "the fix isn't deployed" argument starts.
#  · public/__ENV.js is NEVER shipped. It is a BUILD artifact and the local copy
#    carries DEV/testnet values (vsc-testnet, the testnet contract id). Shipping it
#    silently runs production against testnet. The server regenerates it from
#    /opt/lumen/.env as an ExecStartPre on every boot.
#  · /home/clauderfly/hive-blog-rebuild/... on the SERVER is never touched.
#    @hiveio/wax resolves its 2.4 MB wasm by an absolute path baked in at build
#    time, so the server needs the build machine's path to exist. Without it the
#    server boots, listens, answers /api/health 200, and every Hive read fails.
#  · /api/health alone proves nothing. The proof that the wasm path survived is
#    the `cache warm:` lines in the log, because those need wax to run.
set -uo pipefail
HOST=root@169.58.251.194
KEY=/home/clauderfly/.lumen-secrets/lumen_server_ed25519
APP=/home/clauderfly/hive-blog-rebuild/apps/blog
SSH="ssh -o StrictHostKeyChecking=no -i $KEY"
# Phase-1 request budget (2026-09-02): the verification curls below carry the QA
# bypass header so a deploy check can never be answered with a 429, whatever the
# crawler load at that moment. The token file is optional; without it the checks
# run as a plain client from this machine's IP.
QA_TOKEN_FILE=/home/clauderfly/.lumen-secrets/lumen-qa-bypass.token
if [ -r "$QA_TOKEN_FILE" ]; then QA_HDR="x-lumen-qa: $(cat "$QA_TOKEN_FILE")"; else QA_HDR="x-lumen-qa: none"; fi
cd "$APP" || exit 1

LOCAL_ID="$(cat .next/BUILD_ID)"
echo "==> local BUILD_ID  $LOCAL_ID"
echo "==> server BUILD_ID $($SSH $HOST 'cat /opt/lumen/app/apps/blog/.next/BUILD_ID 2>/dev/null')  (before)"

if [ "${1:-}" != "--go" ]; then
  echo "==> DRY RUN. Pass --go to actually ship."
  rsync -an --delete --exclude 'apps/blog/.next/static' --exclude 'apps/blog/public' \
    -e "$SSH" .next/standalone/ "$HOST:/opt/lumen/app/" | tail -5
  exit 0
fi

set -e
# ★ GUARDS BEFORE ANYTHING SHIPS (2026-09-06, review, mirrored from the
# identical gate added to deploy-lumen-perf.sh -- this script's own twin
# deploy path, and a guard added to only one of the two is a guard a human
# can still bypass by picking the other). `pnpm --filter @hive/blog
# test:unit` (the cacheTime/withTtlCache-name source-scanning guards among
# others) and the packages/transaction mocha suite used to appear in no CI
# file, no deploy script and no git hook -- they protected nothing unless a
# human remembered to run them by hand. Run all three here, before the first
# byte moves (the purge below is the first real action), so a red guard exits 1
# and the server is never touched. `$MONOREPO_ROOT` is two levels above $APP
# (.../apps/blog -> the pnpm workspace root) so `--filter` resolves; all three
# suites together are ~30s, well under the minutes the rsync+restart+verify
# below already take.
MONOREPO_ROOT="$(cd "$APP/../.." && pwd)"
echo "==> guards 1/3: pnpm --filter @hive/blog test:unit"
if ! (cd "$MONOREPO_ROOT" && pnpm --filter @hive/blog run test:unit); then
  echo "DEPLOY BLOCKED: pnpm --filter @hive/blog test:unit FAILED -- see the '== <file>' lines above for which guard/test failed. Nothing was copied to the server."
  exit 1
fi
echo "==> guards 2/3: packages/transaction mocha suite"
if ! (cd "$MONOREPO_ROOT/packages/transaction" && pnpm test); then
  echo "DEPLOY BLOCKED: packages/transaction mocha suite FAILED -- see the failing test name(s) above. Nothing was copied to the server."
  exit 1
fi
echo "==> guards 3/3: packages/ui mocha suite (@hive/ui)"
# ★ 2026-09-20: added because the deploy path could still ship a reopened open
# redirect with CI green. The seven `?next=` vectors that prove it stays closed
# (`/\evil.com`, a tab or newline before the slashes, a userinfo separator
# behind a backslash) live in packages/ui/lib/sanitize-url.test.ts, and NOTHING
# on this path ran them: guard 1/3 globs `find lib` rooted at apps/blog, so
# packages/ui is outside it by construction. CI runs the suite since 11b5b12,
# but a deploy from this machine never asks CI anything. In BOTH scripts, for
# the same reason the other two are: a guard in one is a guard a human skips by
# picking the other. ~1s.
if ! (cd "$MONOREPO_ROOT" && pnpm --filter @hive/ui run test); then
  echo "DEPLOY BLOCKED: pnpm --filter @hive/ui test FAILED -- the sanitize-url / sign-in redirect suite is red. Nothing was copied to the server."
  exit 1
fi
# ★ Snappiness phase 2: empty the edge cache BEFORE anything changes on disk,
# so no reader is served cached HTML from the old build while the files under it
# move (found in review: the old order served pages naming deleted chunks for
# the whole deploy, and the chunk-error guard's reload got a cache hit of the
# same stale page).
echo "==> 0/5 purge the edge cache (restart lumen-caddy)"
$SSH "$HOST" docker restart lumen-caddy >/dev/null
echo "==> 1/5 standalone"
rsync -a --delete --exclude 'apps/blog/.next/static' --exclude 'apps/blog/public' \
  -e "$SSH" .next/standalone/ "$HOST:/opt/lumen/app/"
echo "==> 2/5 static (previous builds' chunks are KEPT for 14 days)"
# Content-hashed and immutable, so old chunks are inert; keeping them means a
# page rendered by the previous build (in a reader's tab, in a cache, in a
# crawler's queue) still finds its scripts after a deploy. Pruned by age below.
rsync -a -e "$SSH" .next/static/ "$HOST:/opt/lumen/app/apps/blog/.next/static/"
$SSH "$HOST" "find /opt/lumen/app/apps/blog/.next/static -type f -mtime +14 -delete; find /opt/lumen/app/apps/blog/.next/static -type d -empty -delete"
echo "==> 3/5 public (WITHOUT __ENV.js)"
rsync -a --exclude '__ENV.js' -e "$SSH" public/ "$HOST:/opt/lumen/app/apps/blog/public/"
echo "==> 4/5 restart"
$SSH "$HOST" systemctl restart lumen
# ★ 2026-09-05: lumen-publisher.service is PartOf=lumen.service and lumen carries a
# Wants=lumen-publisher.service drop-in (commit 7f3127d), so a restart of lumen now
# brings the publisher up in the same second (before that it stayed dead from Aug 30
# to Sep 5 and three lite posts never reached Hive). The explicit start below is a
# harmless belt-and-braces no-op; the assert further down is the real check.
$SSH "$HOST" 'systemctl start lumen-publisher 2>/dev/null || systemctl restart lumen-publisher'
# ★★★ THE EDGE CACHE THAT MATTERS IS NOW CLOUDFLARE, NOT THE PROXY (2026-09-08).
# Until today the proxy (Caddy + the Souin module) held anonymous HTML in memory
# and restarting the container was the purge. The `cache` directive was removed
# from /opt/lumen/caddy/Caddyfile because it buffered every response and destroyed
# the origin's streaming (commit 4464cba; TTFB 654->198 ms). So this restart no
# longer purges anything -- it is kept only because it is how a Caddyfile change
# actually lands (Docker bind-mounts that file BY INODE, so an edit plus
# `caddy reload` silently keeps serving the old config).
#
# CLOUDFLARE is what holds anonymous HTML now, at s-maxage=300 with
# stale-while-revalidate=3600, and it was NEVER being purged on deploy. A stale
# page names this build's chunk files by content hash; after a deploy those files
# are gone, so a cached page asks for chunks that no longer exist. Previous builds'
# static files are kept for 14 days, which softened it, but the honest fix is to
# purge the CDN. purge_everything, not by-prefix: purge-by-prefix is an Enterprise
# feature and a hand-written URL list would always miss something. Static assets
# are content-hashed, so re-fetching them once per deploy is cheap.
echo "==> 5/6 restart the proxy (lands any Caddyfile change; no longer a cache purge)"
$SSH "$HOST" docker restart lumen-caddy >/dev/null

echo "==> 6/6 purge the Cloudflare HTML cache"
# Token: Zone / Cache Purge / Purge, scoped to this zone only. Kept out of the repo.
# A missing token must NOT abort a deploy that has already shipped the files, but it
# MUST show up as a red check below, because an unpurged CDN serves the old page for
# up to s-maxage + stale-while-revalidate.
CF_TOKEN_FILE=/home/clauderfly/.lumen-secrets/cloudflare-purge.token
CF_ZONE=ad3489db77f0577ab98b1defc94fd925
if [ -r "$CF_TOKEN_FILE" ]; then
  CF_PURGE_RAW="$(curl -sS --max-time 30 -X POST \
    "https://api.cloudflare.com/client/v4/zones/$CF_ZONE/purge_cache" \
    -H "Authorization: Bearer $(cat "$CF_TOKEN_FILE")" \
    -H 'Content-Type: application/json' \
    --data '{"purge_everything":true}' 2>&1)"
else
  CF_PURGE_RAW='{"success":false,"errors":["no token at '"$CF_TOKEN_FILE"'"]}'
fi
case "$CF_PURGE_RAW" in
  *'"success":true'*) CF_PURGED=yes ;;
  *)                  CF_PURGED=no  ;;
esac
set +e

echo "==> waiting for it to answer"
for i in $(seq 1 30); do
  curl -sf -o /dev/null --max-time 5 -H "$QA_HDR" https://lumensocial.net/api/health && break
  sleep 2
done

# ★ WARM EVERY WORKER BEFORE READERS DO (2026-09-24). Each of the 3 cluster workers
# loads a route's server code on that route's first request, so the first readers
# after a deploy paid up to ~1.2 s per route per worker (home 1.2 s, post 0.7 s,
# creator page 0.8 s, Inquisition 1.0 s; 0.05-0.3 s once warm). Six loopback hits per
# route land two on each worker (round-robin), with a cache-buster so every one is a
# real render. A/B on production, 4 restarts alternating, first 3 hits per route
# after the step: without p50 174/161 ms, p90 880/982 ms; with p50 69/80 ms, p90
# 202/289 ms. Costs ~15-19 s here. Read-only GETs; no page records a view.
# ★ The feed API route is in the list too (2026-09-24): loading that module is what
# registers the feed builder and starts the viewer warmer in each worker
# (`startViewerWarmer` runs at the route's module scope), and the home page's
# background refresh needs that builder. Without it, a fresh deploy had no warmer and
# no home refresh in a worker until some reader happened to call the API there.
echo "==> warm the workers (main routes, loopback)"
$SSH "$HOST" 'for r in / /@lordbutterfly /@lordbutterfly/wallet /@lordbutterfly/followers /photography/@lordbutterfly/product-photography-attempt-no-1 /topics/photography /inquisition /m/lordbutterfly; do for k in 1 2 3 4 5 6; do curl -s -o /dev/null --max-time 20 "http://127.0.0.1:3000$r?warm=$k$(date +%s%N)"; done; done; for k in 1 2 3 4 5 6; do curl -s -o /dev/null --max-time 20 "http://127.0.0.1:3000/api/feed/for-you?tag=photography&limit=30&warm=$k$(date +%s%N)"; done'

fail=0
chk() { printf '%-52s %s\n' "$1" "$2"; [ "$2" = FAIL ] && fail=1; return 0; }

SERVER_ID="$($SSH $HOST 'cat /opt/lumen/app/apps/blog/.next/BUILD_ID 2>/dev/null')"
[ "$SERVER_ID" = "$LOCAL_ID" ] && chk "server BUILD_ID matches local ($LOCAL_ID)" PASS \
                              || chk "server BUILD_ID matches local (got '$SERVER_ID')" FAIL
[ "$($SSH $HOST systemctl is-active lumen)" = active ] && chk "lumen.service active" PASS || chk "lumen.service active" FAIL
[ "$($SSH $HOST systemctl is-active lumen-publisher)" = active ] && chk "lumen-publisher.service active" PASS || chk "lumen-publisher.service active" FAIL
HEALTH="$(curl -s --max-time 10 -H "$QA_HDR" https://lumensocial.net/api/health)"
grep -q '"status":"ok"' <<<"$HEALTH" && chk "/api/health ok" PASS || chk "/api/health ok ($HEALTH)" FAIL
# ★ The real wasm proof. /api/health only checks connectivity.
# Counted from the LAST cluster start, not the last 200 lines: the warm-up step above
# logs dozens of render lines after boot and pushed the boot lines out of a fixed
# window (false FAIL, 2026-09-24). Anchoring on the restart also means an old boot's
# lines can never pass for this one's.
$SSH "$HOST" "awk '/\\[cluster\\] primary/{n=0} /cache warm:/{n++} END{print n+0}' /var/log/lumen.log" | grep -qv '^0$' \
  && chk "cache warm lines present (wax wasm path intact)" PASS \
  || chk "cache warm lines present (wax wasm path intact)" FAIL
# ★ CACHE-BUSTER (2026-09-05): the QA header bypasses Souin but NOT Cloudflare's HTML
# cache (measured: cf-cache-status HIT on /@name with the header). A query string makes
# the app answer private/no-store, so these checks always read the origin, never a
# pre-deploy page still sitting at a Cloudflare PoP.
# ★ __ENV.js must be PRODUCTION values, never the local testnet ones.
ENVJS="$(curl -s --max-time 10 -H "$QA_HDR" "https://lumensocial.net/__ENV.js?deploy=$LOCAL_ID")"
grep -q 'vsc-testnet' <<<"$ENVJS" && chk "__ENV.js is NOT serving testnet values" FAIL \
                                  || chk "__ENV.js is NOT serving testnet values" PASS
# The thing we actually shipped, proven at the served bytes.
HTML="$(curl -s --max-time 20 -H "$QA_HDR" "https://lumensocial.net/?deploy=$LOCAL_ID")"
grep -q 'data-testid="right-rail-topics-list"' <<<"$HTML" && chk "topics chips in the LIVE SSR HTML" PASS \
                                                          || chk "topics chips in the LIVE SSR HTML" FAIL
[ "$CF_PURGED" = yes ] && chk "Cloudflare cache purged" PASS \
                       || chk "Cloudflare cache purged ($(printf '%s' "$CF_PURGE_RAW" | head -c 120))" FAIL
grep -q 'data-testid="right-rail-topics-loading"' <<<"$HTML" && chk "no skeleton in the LIVE SSR HTML" FAIL \
                                                             || chk "no skeleton in the LIVE SSR HTML" PASS
echo
[ "$fail" -eq 0 ] && echo "DEPLOY VERIFIED" || echo "DEPLOY HAS FAILURES ABOVE"
exit "$fail"
