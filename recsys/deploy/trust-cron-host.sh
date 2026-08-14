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
# ★★★ A FAILED RUN USED TO BE INVISIBLE, AND THE RETRY MATH WAS WRONG
# (2026-08-14). Two separate defects, found while making failure visible for
# this same date's ops-hardening pass:
#
# (1) VISIBILITY. The scheduled loop's only trace of a run, pass or fail, was
#     a line in `docker logs` — a stream nobody was reading. A failed run left
#     no state anywhere else, so the snapshot aged silently toward
#     `max_snapshot_age_days = 14` with zero operator-visible signal until
#     `/feed` started refusing every request. This script now writes
#     `$STATUS_DIR/status` (last run's start/end/exit code/duration,
#     consecutive-failure count) after every scheduled attempt, and
#     `./deploy/trust-cron-status.sh` reads the REAL state — the recsys
#     Postgres `trust_snapshot_meta.built_at`, not this file — to answer "is
#     the batch actually healthy". Two consecutive failures also emit a
#     `TRUST_BATCH_ALERT` line (`docker logs | grep TRUST_BATCH_ALERT`), so
#     the log itself escalates rather than repeating the same easy-to-ignore
#     "retrying" message forever.
#
# (2) THE RETRY MATH. The loop was `sleep INTERVAL_S; run; on failure sleep
#     RETRY_S`, and then looped back to the top — which sleeps INTERVAL_S
#     AGAIN before the retried attempt. The comment above (and
#     `tests/test_deploy_artifact.py`'s "interval strictly below max_age, so
#     one failed run cannot age the snapshot out") assumed a failure recovers
#     in RETRY_S. It does not: it recovers in RETRY_S + INTERVAL_S. Measured
#     against the shipped defaults (interval 604800s/7d, retry 3600s/1h,
#     `max_snapshot_age_days` 14d = 1209600s): a single failure at the day-7
#     attempt pushes the retried attempt to day 14.04 — 3600s AFTER the
#     snapshot has already expired and `/feed` has gone FAIL_CLOSED. The exact
#     outage this design exists to prevent, guaranteed by its own retry path.
#     Fixed below by tracking the NEXT sleep duration explicitly (INTERVAL_S
#     after success, RETRY_S after failure) instead of nesting a second sleep
#     inside the loop body. ★ The SAME bug is present in
#     `deploy/compose.recsys.yml`'s `recsys-trust-batch-cron` heredoc — left
#     unfixed there deliberately (out of this pass's stated scope, and
#     changing that file's exact text risks the pinned string-matching tests
#     in `tests/test_deploy_artifact.py`); flag it for a decision rather than
#     editing untested.
#
# ★★★ THE BATCH WINDOW NOW SURVIVES A FRESH HOST (2026-08-14).
# `RECSYS_TRUST_SINCE_DAYS` used to exist only in whichever shell happened to
# run this script — a new box, a new operator, a plain `ssh` session that
# didn't inherit the old shell's exports, all got a silent fallback to the
# 365-day default this file's window note above proves cannot complete. When
# the variable is unset in the shell, this script now reads a default from
# `deploy/trust-batch-defaults.env` — committed to git (unlike `.env.local`,
# which the repo's `.gitignore` excludes), so the value ships with the
# checkout instead of living in someone's memory. An operator who sets
# `RECSYS_TRUST_SINCE_DAYS` in their own shell is read FIRST and always wins;
# the file only fills the gap when nobody set anything at all.
#
# Usage:
#   ./deploy/trust-cron-host.sh                 # build a snapshot now, then schedule
#   ./deploy/trust-cron-host.sh --skip-initial  # schedule only (snapshot already fresh)
#   RECSYS_TRUST_BATCH_INTERVAL_S=259200 ./deploy/trust-cron-host.sh   # 3-day cadence
#   ./deploy/trust-cron-status.sh               # is the batch actually healthy? (reads Postgres)
set -euo pipefail

IMAGE="${RECSYS_IMAGE:-recsys:latest}"
ENV_FILE="${RECSYS_ENV_FILE:-$(cd "$(dirname "$0")/.." && pwd)/.env.local}"
CONTAINER="${RECSYS_TRUST_CRON_NAME:-recsys-trust-batch-cron}"
INTERVAL_S="${RECSYS_TRUST_BATCH_INTERVAL_S:-604800}"
RETRY_S="${RECSYS_TRUST_BATCH_RETRY_S:-3600}"
SINCE_DAYS="${RECSYS_TRUST_SINCE_DAYS:-}"
SINCE_DAYS_SOURCE="shell (RECSYS_TRUST_SINCE_DAYS)"
# Host-mounted so a human or `trust-cron-status.sh` can read the loop's last
# outcome without `docker exec`. See the visibility note above.
# ★ DEFAULT MUST WORK FOR THE USER WHO ACTUALLY RUNS THIS (2026-08-14).
# `/var/lib/recsys-trust-cron` is the right home on a root-managed host and the
# wrong one everywhere else: this deployment is driven by an ordinary user, for
# whom that mkdir is EACCES. An explicit RECSYS_TRUST_STATUS_DIR always wins;
# otherwise prefer /var/lib when it is actually writable, and fall back to the
# user's own state directory rather than failing on a path they cannot create.
if [ -n "${RECSYS_TRUST_STATUS_DIR:-}" ]; then
  STATUS_DIR="$RECSYS_TRUST_STATUS_DIR"
elif [ -w /var/lib ] || [ -w /var/lib/recsys-trust-cron ] 2>/dev/null; then
  STATUS_DIR=/var/lib/recsys-trust-cron
else
  STATUS_DIR="${XDG_STATE_HOME:-$HOME/.local/share}/recsys-trust-cron"
fi
STATUS_DIR_CONTAINER="/var/lib/recsys-trust-cron"
SKIP_INITIAL=0
[ "${1:-}" = "--skip-initial" ] && SKIP_INITIAL=1

# Empty = "use settings.history.trust_days" (365) unless the durable default
# file below supplies one. See the window note above before leaving both
# empty against the public mirror.
if [ -z "$SINCE_DAYS" ]; then
  DEFAULTS_FILE="$(cd "$(dirname "$0")" && pwd)/trust-batch-defaults.env"
  if [ -f "$DEFAULTS_FILE" ]; then
    FILE_VALUE="$(grep -E '^RECSYS_TRUST_SINCE_DAYS=' "$DEFAULTS_FILE" | tail -1 | cut -d= -f2-)"
    case "$FILE_VALUE" in
      ''|*[!0-9]*)
        [ -n "$FILE_VALUE" ] && echo "WARNING: $DEFAULTS_FILE has a non-numeric RECSYS_TRUST_SINCE_DAYS ('$FILE_VALUE') — ignoring it." >&2
        ;;
      *)
        SINCE_DAYS="$FILE_VALUE"
        SINCE_DAYS_SOURCE="$DEFAULTS_FILE"
        ;;
    esac
  fi
fi

BATCH_ARGS=""
if [ -n "$SINCE_DAYS" ]; then
  BATCH_ARGS="--since-days $SINCE_DAYS"
  echo "==> RECSYS_TRUST_SINCE_DAYS=$SINCE_DAYS (source: $SINCE_DAYS_SOURCE)"
else
  # Caught by re-running this script without the variable in the shell AND
  # with trust-batch-defaults.env missing: the container was rebuilt with an
  # EMPTY window, so the weekly run would have gone back to 365 days and
  # failed every time while the scheduler sat there looking fine. The window
  # lives in the container's env, not in .env.local — if it is not in THIS
  # shell or in the defaults file, it does not reach the loop.
  echo "WARNING: RECSYS_TRUST_SINCE_DAYS is unset and $(dirname "$0")/trust-batch-defaults.env"
  echo "         is missing or has no value — the batch will use trust_days (365)."
  echo "         Against the public mirror that CANNOT COMPLETE (measured 2026-08-14:"
  echo "         cancelled at 900s and again at 3600s). Set it, or restore the defaults" >&2
  echo "         file, unless you are pointed at a data source you control." >&2
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

# ★★★ EVERY STEP THAT CAN FAIL RUNS *BEFORE* THE EXISTING SCHEDULER IS
# DESTROYED (2026-08-14, second pass — this bit for real).
#
# The previous ordering did `docker rm -f` FIRST and created the status
# directory AFTERWARDS. Run as a non-root user, the default
# `/var/lib/recsys-trust-cron` mkdir fails with EACCES — and by then the old
# container was already gone, so a script whose entire purpose is "keep the
# trust snapshot fresh" left the box with NO SCHEDULER AT ALL and exited 1.
# Reproduced exactly that way on this host: the cron was destroyed and not
# replaced, and only an operator watching the output would ever have known.
#
# ★ THE BIND MOUNT INHERITS THE HOST INODE'S PERMISSIONS, NOT THE IMAGE'S.
# The container runs as uid 1001 (Dockerfile: `USER recsys`, `--uid 1001
# --gid 1001`), which has no matching account on the host. Docker would
# otherwise create $STATUS_DIR root:root on first use, every write from
# inside the container would fail, and that failure would be as invisible as
# the one this whole change exists to surface. World-writable is acceptable
# here: the directory only ever holds a plaintext status line (timestamps, an
# exit code, a counter), never a credential.
if ! mkdir -p "$STATUS_DIR" 2>/dev/null; then
  echo "FATAL: cannot create status directory $STATUS_DIR" >&2
  echo "       The existing scheduler has NOT been touched — it is still running." >&2
  echo "       Either run as a user who can write that path, or set" >&2
  echo "       RECSYS_TRUST_STATUS_DIR to somewhere writable, e.g." >&2
  echo "         RECSYS_TRUST_STATUS_DIR=\"\$HOME/.local/share/recsys-trust-cron\" $0 ${1:-}" >&2
  exit 1
fi
chmod 1777 "$STATUS_DIR" 2>/dev/null || true
if [ ! -w "$STATUS_DIR" ]; then
  echo "FATAL: $STATUS_DIR exists but is not writable; existing scheduler left untouched." >&2
  exit 1
fi

# Only now, with everything that can fail already done, replace an existing
# scheduler — two loops on the same DSN would mean two concurrent batches
# writing one snapshot.
if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "==> removing existing $CONTAINER container"
  docker rm -f "$CONTAINER" >/dev/null
  docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER" && {
    echo "FATAL: $CONTAINER still present after rm" >&2; exit 1; }
fi

echo "==> starting $CONTAINER (interval ${INTERVAL_S}s, retry ${RETRY_S}s, status: $STATUS_DIR/status)"
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --network host \
  -v "$STATUS_DIR:$STATUS_DIR_CONTAINER" \
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
    STATUS_FILE="/var/lib/recsys-trust-cron/status"
    # Seed the failure streak from any status file a previous container
    # instance left behind — a host reboot restarts this container fresh, and
    # losing the count would silently reset the escalation threshold right
    # when a run of failures needs it most.
    FAIL_STREAK=0
    if [ -f "$STATUS_FILE" ]; then
      PREV=$(grep -E "^consecutive_failures=" "$STATUS_FILE" | tail -1 | cut -d= -f2)
      case "$PREV" in ""|*[!0-9]*) ;; *) FAIL_STREAK="$PREV" ;; esac
    fi
    # ★ NEXT_SLEEP_S is the fix for the retry-math bug documented in this
    # file'"'"'s header. The old loop always slept INTERVAL_S at the top of
    # the loop AND slept RETRY_S again on failure, so a retry actually landed
    # RETRY_S + INTERVAL_S after the failed attempt -- past
    # max_snapshot_age_days under the shipped defaults. Tracking the next
    # sleep explicitly makes a failure retry in RETRY_S, full stop; a success
    # returns to INTERVAL_S.
    NEXT_SLEEP_S="${RECSYS_TRUST_BATCH_INTERVAL_S:-604800}"
    while true; do
      sleep "$NEXT_SLEEP_S"
      START_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      START_EPOCH=$(date +%s)
      echo "trust_batch: starting scheduled run"
      if python -m recsys.jobs.trust_batch ${RECSYS_TRUST_BATCH_ARGS}; then
        EXIT_CODE=0
        FAIL_STREAK=0
        NEXT_SLEEP_S="${RECSYS_TRUST_BATCH_INTERVAL_S:-604800}"
        echo "trust_batch: scheduled run OK"
      else
        EXIT_CODE=$?
        FAIL_STREAK=$((FAIL_STREAK + 1))
        NEXT_SLEEP_S="${RECSYS_TRUST_BATCH_RETRY_S:-3600}"
        if [ "$FAIL_STREAK" -ge 2 ]; then
          echo "trust_batch: TRUST_BATCH_ALERT consecutive_failures=$FAIL_STREAK exit_code=$EXIT_CODE -- snapshot is aging toward FAIL_CLOSED and nobody has fixed this yet. Run ./deploy/trust-cron-status.sh"
        else
          echo "trust_batch: scheduled run FAILED exit_code=$EXIT_CODE -- retrying in ${NEXT_SLEEP_S}s"
        fi
      fi
      END_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      DURATION_S=$(( $(date +%s) - START_EPOCH ))
      {
        echo "last_run_start=$START_TS"
        echo "last_run_end=$END_TS"
        echo "last_run_exit_code=$EXIT_CODE"
        echo "last_run_duration_s=$DURATION_S"
        echo "consecutive_failures=$FAIL_STREAK"
      } > "$STATUS_FILE.tmp" 2>/dev/null && mv "$STATUS_FILE.tmp" "$STATUS_FILE" || echo "trust_batch: WARNING could not write $STATUS_FILE (mount missing or not writable)"
    done
  ' >/dev/null

sleep 2
docker ps --filter "name=$CONTAINER" --format '==> {{.Names}} {{.Status}} (restart policy: unless-stopped)'
echo "    logs:          docker logs -f $CONTAINER"
echo "    last run:      $STATUS_DIR/status (written after every scheduled attempt)"
echo "    is it healthy: ./deploy/trust-cron-status.sh  (reads the recsys Postgres directly)"
echo "    the SERVICE reloads the snapshot from Postgres on its own"
echo "    (trust_snapshot.refresh_s = 600), so no restart of recsys-feed is needed."
