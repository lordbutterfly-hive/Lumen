#!/bin/sh
# Sync the frontend dev tree into the Lumen repo.
#   sync-frontend.sh        dry run (default) — shows exactly what would change
#   sync-frontend.sh --go   perform the copy
#
# Dev tree lives on the Linux fs because small-file I/O there is ~7x faster than
# the Windows mount; the repo has to live on /mnt/o so GitHub Desktop can see it.
# This script is the ONLY sanctioned bridge between them. Never hand-copy.
#
# ★ CANONICAL COPY (moved into the repo 2026-08-16). It used to live only in
# /mnt/o/LUMEN-DOCS/, i.e. the one script that decides what reaches the repo was
# itself unversioned — a change to an --exclude left no trace anywhere, and a
# fresh checkout did not contain the tool needed to work on it. That path is now
# a thin wrapper around this file. See the root README, "How frontend/ is
# maintained", for why the tree is vendored at all.

set -eu

SRC=/home/clauderfly/hive-blog-rebuild
DST=/mnt/o/Lumen/frontend

[ -d "$SRC" ] || { echo "missing dev tree: $SRC"; exit 1; }
[ -d "$DST" ] || { echo "missing repo:     $DST"; exit 1; }

# Three excludes added 2026-08-10 (never put a comment inside the rsync call
# below — a `#` inside a backslash-continued command silently eats the rest of
# it). `.next-dev/` is the :3010 instance's dev distDir (apps/blog/package.json
# `dev:3010` sets NEXT_DIST_DIR) and `test-results/` is Playwright output:
# ~1,200 build artifacts a --go run copied into the repo. Both are gitignored,
# so it was only ever disk noise, but it buried the real diff. `.tls/` holds the
# local self-signed TLS PRIVATE KEY used by scripts/lumen-https-front.mjs, which
# has no business in the repo directory even though .gitignore catches it.
MODE="--dry-run"
LABEL="DRY RUN — nothing copied. Re-run with --go to apply."
if [ "${1:-}" = "--go" ]; then MODE=""; LABEL="Copied. Now commit + push in GitHub Desktop."; fi

rsync -rlic $MODE --delete \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='.next/' \
  --exclude='.turbo/' \
  --exclude='dist/' \
  --exclude='build/' \
  --exclude='.next-dev/' \
  --exclude='.next-prod*/' \
  --exclude='.next-qa/' \
  --exclude='.next*/' \
  --exclude='.hive-api-cache/' \
  --exclude='.tls/' \
  --exclude='*.tmp.mjs' \
  --exclude='*.tmp.ts' \
  --exclude='test-results/' \
  --exclude='.tls/' \
  --exclude='qa/harness/reports/' \
  --exclude='.env' \
  --exclude='.env.blog' \
  --exclude='.env.local' \
  --exclude='.env.testing' \
  --exclude='.env.mirrornet-testing' \
  --exclude='next-env.d.ts' \
  --exclude='version.json' \
  --exclude='*.tsbuildinfo' \
  --exclude='*.log' \
  --exclude='public/__ENV.js' \
  --exclude='public/auth/' \
  --exclude='public/locales/' \
  --exclude='public/smart-signer/' \
  "$SRC/" "$DST/"

echo
echo "$LABEL"
