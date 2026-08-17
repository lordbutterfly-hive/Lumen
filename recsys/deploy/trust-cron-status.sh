#!/usr/bin/env bash
# ★★★ ANSWERS "IS THE WEEKLY TRUST BATCH ACTUALLY WORKING", NOT "DID THE
# LOOP CLAIM IT WAS" (2026-08-14). Companion to trust-cron-host.sh, whose own
# header documents the gap this closes: a failed scheduled run's only trace
# used to be one line in `docker logs`, a stream nobody reads.
#
# ★ THE VERDICT COMES FROM POSTGRES, NEVER FROM THE STATUS FILE THE LOOP
# WROTE. A check that can only report what the thing being checked claims
# about itself is worthless — the loop could be wedged, the container could
# be gone, the mount could have failed silently, and a status file alone
# would still say whatever it last said. So the freshness verdict below is
# `trust_snapshot_meta.built_at`, read straight out of the recsys DB the same
# way `recsys.db.store.load_snapshot` — the exact function the SERVICE and
# the BATCH both use — reads it. The loop's own status file
# ($STATUS_DIR/status, written by trust-cron-host.sh's scheduled loop) is
# printed too, but only as supplementary "why", never as the source of the
# STATUS line: a healthy-looking status file next to a stale snapshot is
# itself a finding (the mount is fine but the batch stopped actually
# succeeding, or someone is reading the wrong host).
#
# Runs the query with the SAME image, env file, and network mode
# trust-cron-host.sh already requires (`--network host`, `--env-file`) rather
# than adding a new dependency (no psql client, no psycopg on the host) — the
# recsys image already bundles psycopg[binary] for exactly this DSN.
#
# Exit codes (wire this into anything later — cron mail, a host-level
# monitor, a manual check):
#   0  healthy
#   1  last scheduled run failed, but the snapshot is still safely fresh
#   2  snapshot is within RECSYS_TRUST_STATUS_WARN_DAYS of max_snapshot_age_days
#   3  snapshot already expired, degraded, or never built -- /feed is (or
#      will be, on the very next request) FAIL_CLOSED
#   4  the check itself failed (could not reach Postgres) -- NOT the same as
#      healthy; a vacuous pass here would be worse than a loud failure
#
# Usage:
#   ./deploy/trust-cron-status.sh
#   RECSYS_TRUST_STATUS_WARN_DAYS=5 ./deploy/trust-cron-status.sh   # wider warn window
set -euo pipefail

IMAGE="${RECSYS_IMAGE:-recsys:latest}"
ENV_FILE="${RECSYS_ENV_FILE:-$(cd "$(dirname "$0")/.." && pwd)/.env.local}"
STATUS_DIR="${RECSYS_TRUST_STATUS_DIR:-/var/lib/recsys-trust-cron}"
STATUS_FILE="$STATUS_DIR/status"
WARN_DAYS="${RECSYS_TRUST_STATUS_WARN_DAYS:-3}"

if [ ! -f "$ENV_FILE" ]; then
  echo "CHECK_ERROR: env file not found: $ENV_FILE (needs RECSYS_DATABASE_URL)" >&2
  echo "STATUS: UNKNOWN -- the check itself could not run." >&2
  exit 4
fi

# Talks to the recsys DB through the same code path the service and the
# batch use (`recsys.db.store.load_snapshot`), so this can never drift from
# what "fresh" actually means there -- no hand-rolled SQL to keep in sync
# with db/schema.sql.
PY_SNIPPET=$(cat <<'PYEOF'
import sys
from datetime import datetime, timezone

try:
    from recsys.db.store import load_snapshot
    from recsys.config import TrustConfig
    persisted = load_snapshot()
except Exception as exc:  # noqa: BLE001 - report to the shell, don't crash opaquely
    print("query_error=" + str(exc).replace("\n", " "))
    sys.exit(1)

if persisted is None:
    print("present=0")
    sys.exit(0)

age_days = (datetime.now(timezone.utc) - persisted.built_at).total_seconds() / 86400.0
print("present=1")
print("built_at=" + persisted.built_at.isoformat())
print("age_days=%.3f" % age_days)
print("degraded=" + ("1" if persisted.snapshot.degraded else "0"))
print("max_age_days=" + str(TrustConfig().max_snapshot_age_days))
PYEOF
)

set +e
SNAPSHOT_INFO=$(docker run --rm --network host --env-file "$ENV_FILE" "$IMAGE" python3 -c "$PY_SNIPPET" 2>&1)
QUERY_EXIT=$?
set -e

PRESENT=""
BUILT_AT=""
AGE_DAYS=""
DEGRADED=""
MAX_AGE_DAYS=""
QUERY_ERROR=""
# `read` with a 2-variable target and IFS='=' absorbs everything after the
# FIRST '=' into $rest, so a value that itself contains '=' (or, for
# query_error, arbitrary free-text from a driver exception) still parses
# correctly -- deliberately not `eval`, which a freeform error message would
# break.
while IFS='=' read -r key rest; do
  case "$key" in
    present) PRESENT="$rest" ;;
    built_at) BUILT_AT="$rest" ;;
    age_days) AGE_DAYS="$rest" ;;
    degraded) DEGRADED="$rest" ;;
    max_age_days) MAX_AGE_DAYS="$rest" ;;
    query_error) QUERY_ERROR="$rest" ;;
  esac
done <<EOF
$SNAPSHOT_INFO
EOF

NOW_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "recsys trust-batch status  ($NOW_TS)"
echo "=================================================="

if [ "$QUERY_EXIT" -ne 0 ] || [ -n "$QUERY_ERROR" ] || [ -z "$PRESENT" ]; then
  echo "Snapshot (recsys Postgres, trust_snapshot_meta): COULD NOT BE READ"
  echo "  docker exit code: $QUERY_EXIT"
  [ -n "$QUERY_ERROR" ] && echo "  error:             $QUERY_ERROR"
  echo "  raw output:"
  echo "$SNAPSHOT_INFO" | sed 's/^/    /'
  echo
  echo "STATUS: UNKNOWN -- the check itself failed. Treat this the same as a"
  echo "        failing check, never as \"probably fine\"."
  exit 4
fi

# ★ THE VERDICT IS PRINTED ONCE, AT THE END, AFTER BOTH INPUTS ARE IN. Facts
# are printed as they're gathered (below); the "STATUS:" line itself waits
# until freshness (Postgres) AND the last-run outcome (status file) have both
# been read, so a human skimming only the last line never sees "HEALTHY"
# followed a few lines later by a nonzero exit code that silently overrode it.
FRESH_SEVERITY=0
FRESH_REASON=""
if [ "$PRESENT" = "0" ]; then
  echo "Snapshot (recsys Postgres, trust_snapshot_meta): NEVER BUILT"
  echo "  no row in trust_snapshot_meta -- the batch has never persisted a"
  echo "  snapshot against this database."
  FRESH_SEVERITY=3
  FRESH_REASON="no snapshot has ever been built -- /feed is FAIL_CLOSED on every request until the first batch run succeeds. Run:
        docker run --rm --network host --env-file \"$ENV_FILE\" \"$IMAGE\" python -m recsys.jobs.trust_batch"
else
  DEGRADED_LABEL="no"
  [ "$DEGRADED" = "1" ] && DEGRADED_LABEL="YES"
  EXPIRE_THRESHOLD="$(awk -v m="$MAX_AGE_DAYS" -v w="$WARN_DAYS" 'BEGIN{print m-w}')"
  IS_EXPIRED="$(awk -v a="$AGE_DAYS" -v m="$MAX_AGE_DAYS" 'BEGIN{print (a>=m)?1:0}')"
  IS_NEAR="$(awk -v a="$AGE_DAYS" -v t="$EXPIRE_THRESHOLD" 'BEGIN{print (a>=t)?1:0}')"

  echo "Snapshot (recsys Postgres, trust_snapshot_meta):"
  echo "  built_at:       $BUILT_AT"
  echo "  age:            ${AGE_DAYS} days"
  echo "  max age:        ${MAX_AGE_DAYS} days  (TrustConfig.max_snapshot_age_days -- /feed FAIL_CLOSEs past this)"
  echo "  warn threshold: ${EXPIRE_THRESHOLD} days  (max age - RECSYS_TRUST_STATUS_WARN_DAYS=${WARN_DAYS})"
  echo "  degraded:       $DEGRADED_LABEL"

  if [ "$IS_EXPIRED" = "1" ]; then
    FRESH_SEVERITY=3
    FRESH_REASON="snapshot EXPIRED -- /feed is FAIL_CLOSED on every request right now."
  elif [ "$DEGRADED" = "1" ]; then
    FRESH_SEVERITY=3
    FRESH_REASON="the persisted snapshot is marked degraded. save_snapshot() should have refused to write this; treat as a data-integrity incident, not just a stale-batch one."
  elif [ "$IS_NEAR" = "1" ]; then
    FRESH_SEVERITY=2
    FRESH_REASON="snapshot is within ${WARN_DAYS} day(s) of expiry. One more missed/failed run and /feed FAIL_CLOSEs."
  else
    FRESH_SEVERITY=0
  fi
fi

echo
LAST_RUN_FAILED=0
if [ -f "$STATUS_FILE" ]; then
  # ★★★ PARSED, NEVER SOURCED (2026-08-17). This block used to be `. "$STATUS_FILE"`
  # under a comment arguing it was safe because "this file is written ONLY by
  # trust-cron-host.sh's own loop in fixed key=value lines". That is a claim about
  # who SHOULD write it, and the filesystem disagreed: the directory the container
  # bind-mounts for it is mode 1777 on this host --
  #
  #     drwxrwxrwt  clauderfly  /home/clauderfly/.local/share/recsys-trust-cron
  #
  # world-writable, so ANY local user can create or replace `status`. Sourcing
  # executes whatever is in it, as whoever runs this script -- which is an
  # operator investigating an incident, often with sudo. It is also not limited to
  # running commands: a sourced file can overwrite ANY variable in this script,
  # including `FRESH_SEVERITY` and the Postgres-verified verdict below, so a
  # planted file could make a FAIL_CLOSED snapshot report as healthy. The header's
  # promise that the verdict is "verified against Postgres, not trusted from this
  # file" cannot survive sourcing the file.
  #
  # 1777 is not a mistake to chmod away, either: the container writes as its own
  # uid, and tightening the mode is what would break the writer. So the fix
  # belongs HERE, in the reader -- read the five fields and execute nothing.
  # Control characters are stripped because these values are printed straight to
  # a terminal, and a file an attacker controls should not be able to emit escape
  # sequences into an operator's screen.
  status_field() {
    grep -E "^$1=" "$STATUS_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\000-\037'
  }
  last_run_start=$(status_field last_run_start)
  last_run_end=$(status_field last_run_end)
  last_run_exit_code=$(status_field last_run_exit_code)
  last_run_duration_s=$(status_field last_run_duration_s)
  consecutive_failures=$(status_field consecutive_failures)
  echo "Last scheduled run ($STATUS_FILE, informational -- the verdict below is"
  echo "verified against Postgres, not trusted from this file):"
  echo "  start:                 ${last_run_start:-unknown}"
  echo "  end:                   ${last_run_end:-unknown}"
  echo "  exit code:             ${last_run_exit_code:-unknown}"
  echo "  duration:              ${last_run_duration_s:-unknown}s"
  echo "  consecutive failures:  ${consecutive_failures:-unknown}"
  case "${last_run_exit_code:-0}" in
    0) : ;;
    *[!0-9]*) : ;;  # malformed field, don't act on it
    *)
      LAST_RUN_FAILED=1
      echo "  -> the LAST scheduled attempt failed. The snapshot above may still be"
      echo "     fresh (an earlier run built it), but this is the early-warning sign"
      echo "     that a run of failures is starting."
      ;;
  esac
else
  echo "Last scheduled run: no status file at $STATUS_FILE yet."
  echo "  Normal for a container that hasn't hit its first scheduled tick, or"
  echo "  one started with --skip-initial. Not itself a failure."
fi

# Combine: freshness (from Postgres) sets the floor; a failed last run can
# only push severity UP to at least 1 (visible before it threatens
# freshness), never down -- an expired snapshot stays CRITICAL even if the
# most recent single attempt happened to succeed.
SEVERITY="$FRESH_SEVERITY"
if [ "$LAST_RUN_FAILED" = "1" ] && [ "$SEVERITY" -lt 1 ]; then
  SEVERITY=1
fi

echo
case "$SEVERITY" in
  3) echo "STATUS: CRITICAL -- $FRESH_REASON" ;;
  2) echo "STATUS: WARNING -- $FRESH_REASON" ;;
  1) echo "STATUS: DEGRADED -- snapshot is fresh, but the LAST scheduled run failed (consecutive_failures=${consecutive_failures:-unknown}). No feed impact yet; will start compounding toward FAIL_CLOSED if not fixed." ;;
  *) echo "STATUS: HEALTHY -- snapshot is fresh and the last scheduled run (if any) succeeded." ;;
esac
echo "EXIT CODE: $SEVERITY"
exit "$SEVERITY"
