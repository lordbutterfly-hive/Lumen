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
# ★ GUARD (2026-09-05): this copies DEV TREE -> REPO with --delete. Twice in one
# day work written straight into the repo (untracked files an agent had not yet
# committed) was deleted by a --go that its author believed ran the other way.
# So --go now refuses while the repo has uncommitted changes under frontend/
# that are not mirrored in the dev tree; commit them, or copy them into the dev
# tree first. --force skips the check when you have looked and mean it.
if [ "${1:-}" = "--go" ] && [ "${2:-}" != "--force" ]; then
  dirty=$(git -C /mnt/o/Lumen status --porcelain -- frontend 2>/dev/null || true)
  unmirrored=""
  for f in $(printf '%s\n' "$dirty" | awk '{print $2}'); do
    case "$f" in frontend/*) ;; *) continue;; esac
    if [ -d "/mnt/o/Lumen/$f" ]; then
      for g in $(find "/mnt/o/Lumen/$f" -type f); do
        rel=${g#/mnt/o/Lumen/frontend/}
        cmp -s "$g" "$SRC/$rel" 2>/dev/null || unmirrored="$unmirrored\n  $g"
      done
    else
      rel=${f#frontend/}
      cmp -s "/mnt/o/Lumen/$f" "$SRC/$rel" 2>/dev/null || unmirrored="$unmirrored\n  $f"
    fi
  done
  if [ -n "$unmirrored" ]; then
    printf 'REFUSING --go: the repo has uncommitted frontend/ changes that the dev tree does not have;\n--go would DELETE or OVERWRITE them:%b\nCommit them or copy them into %s first (or pass --go --force).\n' "$unmirrored" "$SRC"
    exit 5
  fi
fi

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
