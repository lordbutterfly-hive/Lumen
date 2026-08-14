#!/usr/bin/env bash
# ★★★ THE TRUST-SNAPSHOT SCHEDULE FOR A HOST-NETWORK DEPLOYMENT (2026-08-14).
#
# `deploy/compose.recsys.yml` already carries the durable answer to "how does
# the snapshot stay fresh" — the `recsys-trust-batch-cron` service. This script
# exists because the running deployment on this box is NOT compose-managed:
# `recsys-feed` was started with `docker run --network host` (no compose
# labels, `HostConfig.NetworkMode=host`), and its DSNs point at
# `127.0.0.1:55433`. Bringing the compose cron up would put the batch on the
# `docker` BRIDGE network, where `127.0.0.1` is the container itself and the
# recsys Postgres is not there at all. Same service, same command, expressed
# against the network the deployment actually uses.
#
# ★ WHY THIS RUNS THE BATCH BEFORE STARTING THE LOOP. The compose cron sleeps
# FIRST, and that is correct THERE — compose gates it behind
# `recsys-trust-batch` completing (`condition: service_completed_successfully`),
# so a snapshot always exists before the first sleep. Start the loop on its own
# and that assumption is gone: with a snapshot built 2026-08-06, a 7-day sleep
# fires 2026-08-21, one day AFTER `max_snapshot_age_days = 14` expires it on
# 2026-08-20 — and `/feed` is FAIL_CLOSED, so it refuses every request in the
# gap. Sleep-first is only safe when something else already ran.
#
# ★★★ THE WINDOW IS A DEPLOYMENT PARAMETER NOW, MEASURED 2026-08-14. At the
# default `trust_days = 365` this batch CANNOT COMPLETE against the public
# mirror: the first edge query was cancelled at 900s, and again at a 3600s
# timeout. It is not slowness, it is the query planner, and it is not the
# window size either:
#
#   reply edges  1d 0.37s | 7d 1.9s | 30d 9.0s | 90d 29.7s | 365d >3600s
#   365d EXPLAIN flips from a per-block Nested Loop to a Merge Join that
#   index-scans all 151,056,730 comment operations ever made.
#   vote edges   recent 7d 20.6s | 7d SLICE A YEAR BACK >280s, cancelled
#   (both time bounds ARE pushed into the block index; the planner still
#   chose a Hash Join over a 386,598,129-row Seq Scan. `enable_seqscan=off`
#   did not rescue it — old operations are simply cold on a shared mirror.)
#
# So the sweep is bounded by how far back the mirror can serve, not by what
# the config asks for. RECSYS_TRUST_SINCE_DAYS passes `--since-days` through
# to the batch. Leave it unset ONLY against a data source you control.
#
# ★ INTERVAL MUST STAY STRICTLY BELOW `max_snapshot_age_days` IN SECONDS
# (14d = 1209600). 7 days leaves a full extra cycle of headroom so one failed
# run cannot age the snapshot out; `tests/test_deploy_artifact.py` enforces that
# relationship against the compose file, and this script keeps the same numbers
# rather than inventing its own.
#
# Usage:
#   ./deploy/trust-cron-host.sh                 # build a snapshot now, then schedule
#   ./deploy/trust-cron-host.sh --skip-initial  # schedule only (snapshot already fresh)
#   RECSYS_TRUST_BATCH_INTERVAL_S=259200 ./deploy/trust-cron-host.sh   # 3-day cadence
set -euo pipefail

IMAGE="${RECSYS_IMAGE:-recsys:latest}"
ENV_FILE="${RECSYS_ENV_FILE:-$(cd "$(dirname "$0")/.." && pwd)/.env.local}"
CONTAINER="${RECSYS_TRUST_CRON_NAME:-recsys-trust-batch-cron}"
INTERVAL_S="${RECSYS_TRUST_BATCH_INTERVAL_S:-604800}"
RETRY_S="${RECSYS_TRUST_BATCH_RETRY_S:-3600}"
SINCE_DAYS="${RECSYS_TRUST_SINCE_DAYS:-}"
SKIP_INITIAL=0
[ "${1:-}" = "--skip-initial" ] && SKIP_INITIAL=1

# Empty = "use settings.history.trust_days" (365). See the window note above
# before leaving it empty against the public mirror.
BATCH_ARGS=""
if [ -n "$SINCE_DAYS" ]; then
  BATCH_ARGS="--since-days $SINCE_DAYS"
else
  # Caught by re-running this script without the variable in the shell: the
  # container was rebuilt with an EMPTY window, so the weekly run would have
  # gone back to 365 days and failed every time while the scheduler sat there
  # looking fine. The window lives in the container's env, not in .env.local —
  # if it is not in THIS shell it does not reach the loop.
  echo "WARNING: RECSYS_TRUST_SINCE_DAYS is unset — the batch will use trust_days"
  echo "         (365). Against the public mirror that CANNOT COMPLETE (measured"
  echo "         2026-08-14: cancelled at 900s and again at 3600s). Set it unless"
  echo "         you are pointed at a data source you control." >&2
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "FATAL: env file not found: $ENV_FILE" >&2
  echo "       (it carries RECSYS_DATABASE_URL, LUMEN_EXPLORE_SEAT_SECRET and" >&2
  echo "        HAFSQL_STATEMENT_TIMEOUT_MS — the batch cannot complete without them)" >&2
  exit 1
fi

# The 15s HAFSQL default cancels `engagement_edges` over the 365-day window, so
# the batch dies and NO snapshot is ever written. Fail here rather than at
# minute nine of a run that was never going to finish.
if ! grep -qE '^HAFSQL_STATEMENT_TIMEOUT_MS=[0-9]+' "$ENV_FILE"; then
  echo "FATAL: HAFSQL_STATEMENT_TIMEOUT_MS is not set in $ENV_FILE" >&2
  echo "       Set it generously for the batch (e.g. 900000). The 15s request-path" >&2
  echo "       default cancels the 365-day engagement_edges query every time." >&2
  exit 1
fi

if [ "$INTERVAL_S" -ge 1209600 ]; then
  echo "FATAL: RECSYS_TRUST_BATCH_INTERVAL_S=$INTERVAL_S is >= max_snapshot_age_days (1209600s)." >&2
  echo "       The snapshot would expire before the next run. Refusing." >&2
  exit 1
fi

if [ "$SKIP_INITIAL" -eq 0 ]; then
  echo "==> building a snapshot now (foreground; window: ${SINCE_DAYS:-trust_days default})"
  # shellcheck disable=SC2086  # BATCH_ARGS is either empty or "--since-days N"
  docker run --rm --network host --env-file "$ENV_FILE" "$IMAGE" \
    python -m recsys.jobs.trust_batch $BATCH_ARGS
  echo "==> initial snapshot OK"
else
  echo "==> --skip-initial: NOT building a snapshot. The loop sleeps ${INTERVAL_S}s BEFORE"
  echo "    its first run, so only use this when the current snapshot is fresh."
fi

# Replace an existing scheduler rather than silently starting a second one:
# two loops on the same DSN means two concurrent batches writing one snapshot.
if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "==> removing existing $CONTAINER container"
  docker rm -f "$CONTAINER" >/dev/null
  docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER" && {
    echo "FATAL: $CONTAINER still present after rm" >&2; exit 1; }
fi

echo "==> starting $CONTAINER (interval ${INTERVAL_S}s, retry ${RETRY_S}s)"
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --network host \
  `# The image HEALTHCHECK probes the SERVICE (recsys.service.healthcheck).` \
  `# This container is a sleep loop, not the service — and on --network host` \
  `# that probe reaches the REAL feed service on :8000 and reports HEALTHY,` \
  `# measuring a different process entirely. Observed live: the scheduler went` \
  `# green two seconds after start, having checked nothing about itself. A` \
  `# health signal that cannot fail is worse than none.` \
  --no-healthcheck \
  --env-file "$ENV_FILE" \
  -e RECSYS_TRUST_BATCH_INTERVAL_S="$INTERVAL_S" \
  -e RECSYS_TRUST_BATCH_RETRY_S="$RETRY_S" \
  -e RECSYS_TRUST_BATCH_ARGS="$BATCH_ARGS" \
  "$IMAGE" \
  sh -c '
    while true; do
      sleep "${RECSYS_TRUST_BATCH_INTERVAL_S:-604800}"
      echo "trust_batch: starting scheduled run"
      if python -m recsys.jobs.trust_batch ${RECSYS_TRUST_BATCH_ARGS}; then
        echo "trust_batch: scheduled run OK"
      else
        echo "trust_batch: scheduled run FAILED — retrying in ${RECSYS_TRUST_BATCH_RETRY_S:-3600}s"
        sleep "${RECSYS_TRUST_BATCH_RETRY_S:-3600}"
      fi
    done
  ' >/dev/null

sleep 2
docker ps --filter "name=$CONTAINER" --format '==> {{.Names}} {{.Status}} (restart policy: unless-stopped)'
echo "    logs: docker logs -f $CONTAINER"
echo "    the SERVICE reloads the snapshot from Postgres on its own"
echo "    (trust_snapshot.refresh_s = 600), so no restart of recsys-feed is needed."
