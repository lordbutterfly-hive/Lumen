# Deploy scripts (versioned copies)

These are the live copies of the two production deploy scripts that run from the
build machine (`/home/clauderfly/deploy-lumen.sh` and `deploy-lumen-perf.sh`), added to
the repo on 2026-09-05 so a change to them shows up in git history.

- `deploy-lumen.sh` ships `apps/blog/.next` from `/home/clauderfly/hive-blog-rebuild`.
- `deploy-lumen-perf.sh` ships from the isolated tree `/home/clauderfly/lumen-perf-tree`
  (server symlink `lumen-perf-tree -> hive-blog-rebuild` keeps the wax wasm path valid)
  and installs `/opt/lumen/cluster.js.new` when present.

Both: purge the edge cache before and after, rsync `--delete` (a deploy is a FULL
overwrite, so always ONE combined deploy from committed HEAD), restart `lumen`, then
start `lumen-publisher` explicitly and assert it, and read the served HTML through a
`?deploy=<build id>` cache-buster because the QA header bypasses Souin but not
Cloudflare's HTML cache. Secrets are read from `~/.lumen-secrets/`, never stored here.

Keep the copies in sync with the live files when they change (`cp`, then commit).
