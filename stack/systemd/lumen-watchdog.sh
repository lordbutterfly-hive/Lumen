#!/bin/bash
# Lumen watchdog. Checks the things that fail SILENTLY.
#
# ★ WHY THIS EXISTS (2026-08-28). Every scheduled job on this box runs, and nothing
# watched whether it kept succeeding. There is no mail agent, so cron's "mail root on
# failure" goes nowhere. The failure modes that matter here are all quiet: the trust
# snapshot ages past 14 days and the ranked feed FAILS CLOSED; the publisher stalls and
# lite posts pile up while the author sees their post on the site; pg_dump starts
# failing and nobody learns until a restore is needed. Each writes a signal somewhere
# local that nothing read.
#
# Exit 0 = all good. Exit 1 = something needs a human. Every failure prints a line
# starting ALERT so it is greppable in /var/log/lumen-watchdog.log.
#
# To get alerts OFF the box, set ALERT_WEBHOOK in /opt/lumen/watchdog.env (a Discord
# or Slack webhook works as-is). Without it the checks still run and still record.
set -uo pipefail
[ -f /opt/lumen/watchdog.env ] && . /opt/lumen/watchdog.env
DRY_RUN=0
for _arg in "$@"; do [ "$_arg" = "--dry-run" ] && DRY_RUN=1; done
[ "${WATCHDOG_DRY_RUN:-0}" = "1" ] && DRY_RUN=1
FAILS=0
alert() { echo "$(date -Is) ALERT $*"; FAILS=$((FAILS+1)); }
ok()    { echo "$(date -Is) ok    $*"; }

# 1. Is the site actually serving?
CODE=$(curl -s -o /dev/null -m 20 -w '%{http_code}' http://127.0.0.1:3000/api/health || echo 000)
[ "$CODE" = "200" ] && ok "site responding (200)" || alert "site /api/health returned $CODE"

# 2. Database reachable, and does it still have its schema? (connectivity alone lies:
#    /api/health said ok while the database had ZERO tables.)
URL=$(grep '^LITE_DATABASE_URL=' /opt/lumen/.env | cut -d= -f2-)
T=$(psql "$URL" -tAc "select count(*) from pg_tables where schemaname='public'" 2>/dev/null || echo 0)
[ "${T:-0}" -ge 25 ] && ok "lite db has $T tables" || alert "lite db has only ${T:-0} tables (expected >=25)"

# 3. Trust snapshot age. The ranked feed fails closed at 14 days.
RURL=$(grep '^RECSYS_DATABASE_URL=' /opt/lumen/recsys.env | cut -d= -f2-)
AGE=$(psql "$RURL" -tAc "select round(extract(epoch from now()-max(built_at))/86400.0,1) from trust_snapshot_meta" 2>/dev/null || echo "")
if [ -z "$AGE" ]; then alert "cannot read trust snapshot age"
elif awk "BEGIN{exit !($AGE > 10)}"; then alert "trust snapshot is ${AGE} days old - fails closed at 14"
else ok "trust snapshot ${AGE} days old"; fi

# 4. Publisher: is the queue stalled? Jobs stuck pending with attempts burned.
STUCK=$(psql "$URL" -tAc "select count(*) from publish_job where status='pending' and created_at < now() - interval '30 minutes'" 2>/dev/null || echo "?")
[ "$STUCK" = "0" ] && ok "no stalled publish jobs" || alert "$STUCK publish job(s) pending >30min - posts are not reaching Hive"

# 5. Backups fresh and non-trivial.
for db in lumen_lite recsys; do
  F=$(ls -t /var/backups/lumen/$db-*.dump 2>/dev/null | head -1)
  if [ -z "$F" ]; then alert "no $db backup found"
  else
    AGE_H=$(( ($(date +%s) - $(stat -c %Y "$F")) / 3600 ))
    SZ=$(stat -c%s "$F")
    if [ "$AGE_H" -gt 36 ]; then alert "$db backup is ${AGE_H}h old"
    elif [ "$SZ" -lt 1000 ]; then alert "$db backup is only ${SZ} bytes"
    else ok "$db backup ${AGE_H}h old, ${SZ} bytes"; fi
  fi
done

# 6. Disk. Everything above fails in confusing ways once this fills.
USE=$(df --output=pcent / | tail -1 | tr -dc '0-9')
[ "$USE" -lt 85 ] && ok "disk ${USE}% used" || alert "disk ${USE}% used"

# 7. Services still up. The publisher additionally SELF-HEALS.
#
# It is the one unit whose death is invisible: lite posts keep being accepted and
# queue in Postgres, the author sees their post on the site, and nothing tells
# anyone. It sat dead for six days (2026-08-30 to 2026-09-05) because a stop
# propagated from lumen.service through Requires= and no start ever propagated
# back, while this watchdog logged 652 unread ALERT lines. Detection without a
# webhook is not monitoring, so the check now also fixes what it finds.
#
# Restarting it is safe at any time: the drain endpoint takes a cluster-wide
# advisory lock and is idempotent, so an overlapping run answers
# {"status":"skipped"} rather than double-publishing. One attempt per run.
for s in lumen lumen-publisher postgresql; do
  STATE=$(systemctl is-active $s)
  if [ "$STATE" = "active" ]; then ok "$s active"; continue; fi
  if [ "$s" = "lumen-publisher" ] && [ "$(systemctl is-active lumen)" = "active" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      alert "lumen-publisher is $STATE - would self-heal lumen-publisher [dry-run, not started]"
      continue
    fi
    systemctl start lumen-publisher >/dev/null 2>&1
    sleep 2
    NEW=$(systemctl is-active lumen-publisher)
    if [ "$NEW" = "active" ]; then
      alert "lumen-publisher was $STATE - self-healed lumen-publisher (now active)"
    else
      alert "lumen-publisher is $NEW - self-heal FAILED, systemctl start did not bring it up"
    fi
    continue
  fi
  alert "$s is $STATE"
done
[ "$(docker inspect -f '{{.State.Running}}' recsys-feed 2>/dev/null)" = "true" ] && ok "recsys-feed running" || alert "recsys-feed not running"

# 8. MEMORY (added 2026-09-06). Workers have been seen growing to 1.3-1.5GB each
# within an hour, and a box that swaps freezes for 10s at a time under this RAM
# budget (7.9GB, 4 cores, a 2.75GB-capped recsys-feed container next to Node).
# A code fix for the leak is being deployed separately; this is the safety net
# underneath it: log a CSV trend line every run so a slow leak is visible before
# it becomes an incident, and restart lumen (which also restarts the publisher,
# since lumen-publisher carries PartOf=lumen.service) if memory pressure gets
# severe and stays severe. Conservative on purpose: two consecutive low-memory
# runs (15min apart) before acting on MemAvailable alone, a cooldown so a flapping
# condition cannot restart-loop the box, and a floor under lumen's own uptime so
# the guard never fights a restart that just happened for another reason.
WATCHDOG_MEM_MIN_MB=${WATCHDOG_MEM_MIN_MB:-450}
WATCHDOG_SWAP_MAX_MB=${WATCHDOG_SWAP_MAX_MB:-400}
WATCHDOG_RESTART_COOLDOWN_S=${WATCHDOG_RESTART_COOLDOWN_S:-3600}

# ★ Overridable ONLY so the sandbox can exercise this exact file rather than a
# near-copy of it (a copy is not the thing you ship). Unset means production.
MEM_LOG=${MEM_LOG:-/var/log/lumen-mem.log}
MEM_STATE_DIR=${MEM_STATE_DIR:-/var/lib/lumen-watchdog}
MEMINFO_FILE=${MEMINFO_FILE:-/proc/meminfo}
mkdir -p "$MEM_STATE_DIR"
MEM_LOW_COUNT_FILE="$MEM_STATE_DIR/mem-low-count"
SWAP_HIGH_COUNT_FILE="$MEM_STATE_DIR/swap-high-count"
MEM_LAST_RESTART_FILE="$MEM_STATE_DIR/mem-guard-last-restart"

MEM_AVAIL_MB=$(awk '/MemAvailable:/{printf "%d", $2/1024}' "$MEMINFO_FILE")
SWAP_USED_MB=$(awk '/SwapTotal:/{t=$2} /SwapFree:/{f=$2} END{printf "%d", (t-f)/1024}' "$MEMINFO_FILE")

WORKER_RSS_MB=""
for p in $(pgrep -f "^next-server"); do
  R=$(ps -o rss= -p "$p" 2>/dev/null | tr -d ' ')
  [ -n "${R:-}" ] || continue
  WORKER_RSS_MB="${WORKER_RSS_MB}${WORKER_RSS_MB:+;}$((R/1024))"
done
[ -n "$WORKER_RSS_MB" ] || WORKER_RSS_MB="0"

RECSYS_RAW=$(docker stats --no-stream --format '{{.MemUsage}}' recsys-feed 2>/dev/null | awk '{print $1}')
RECSYS_MEM_MB=$(awk -v raw="${RECSYS_RAW:-}" 'BEGIN{
  if (raw ~ /GiB$/) { sub("GiB","",raw); printf "%d", raw*1024; exit }
  if (raw ~ /MiB$/) { sub("MiB","",raw); printf "%d", raw; exit }
  if (raw ~ /KiB$/) { sub("KiB","",raw); printf "%d", raw/1024; exit }
  print 0
}')
[ -n "${RECSYS_MEM_MB:-}" ] || RECSYS_MEM_MB=0

LUMEN_ACTIVE_TS=$(systemctl show -p ActiveEnterTimestamp lumen 2>/dev/null | cut -d= -f2-)
LUMEN_ACTIVE_EPOCH=0
[ -n "$LUMEN_ACTIVE_TS" ] && LUMEN_ACTIVE_EPOCH=$(date -d "$LUMEN_ACTIVE_TS" +%s 2>/dev/null || echo 0)
NOW_EPOCH=$(date +%s)
LUMEN_UPTIME_S=0
[ "$LUMEN_ACTIVE_EPOCH" -gt 0 ] && LUMEN_UPTIME_S=$((NOW_EPOCH - LUMEN_ACTIVE_EPOCH))

MEM_HEADER="timestamp,mem_available_mb,swap_used_mb,worker_rss_mb,recsys_mem_mb,lumen_uptime_s"
[ -f "$MEM_LOG" ] || echo "$MEM_HEADER" > "$MEM_LOG"
echo "$(date -Is),${MEM_AVAIL_MB},${SWAP_USED_MB},${WORKER_RSS_MB},${RECSYS_MEM_MB},${LUMEN_UPTIME_S}" >> "$MEM_LOG"
# logrotate (weekly, 8 rotations) owns size; /etc/logrotate.d/lumen-mem.

MEM_LOW_COUNT=$(cat "$MEM_LOW_COUNT_FILE" 2>/dev/null || echo 0)
case "$MEM_LOW_COUNT" in ''|*[!0-9]*) MEM_LOW_COUNT=0 ;; esac
if [ "$MEM_AVAIL_MB" -lt "$WATCHDOG_MEM_MIN_MB" ]; then
  MEM_LOW_COUNT=$((MEM_LOW_COUNT+1))
else
  MEM_LOW_COUNT=0
fi
[ "$DRY_RUN" -eq 1 ] || echo "$MEM_LOW_COUNT" > "$MEM_LOW_COUNT_FILE"

# Swap trigger needs two consecutive readings too, same shape as the low-memory
# counter above, so one noisy sample can't fire a restart on its own.
SWAP_COND=0
[ "$SWAP_USED_MB" -gt "$WATCHDOG_SWAP_MAX_MB" ] && [ "$MEM_AVAIL_MB" -lt 900 ] && SWAP_COND=1
SWAP_HIGH_COUNT=$(cat "$SWAP_HIGH_COUNT_FILE" 2>/dev/null || echo 0)
case "$SWAP_HIGH_COUNT" in ''|*[!0-9]*) SWAP_HIGH_COUNT=0 ;; esac
if [ "$SWAP_COND" -eq 1 ]; then
  SWAP_HIGH_COUNT=$((SWAP_HIGH_COUNT+1))
else
  SWAP_HIGH_COUNT=0
fi
[ "$DRY_RUN" -eq 1 ] || echo "$SWAP_HIGH_COUNT" > "$SWAP_HIGH_COUNT_FILE"
SWAP_TRIGGER=0
[ "$SWAP_HIGH_COUNT" -ge 2 ] && SWAP_TRIGGER=1

RESTART_WANTED=0
REASON=""
if [ "$MEM_LOW_COUNT" -ge 2 ]; then
  RESTART_WANTED=1
  REASON="MemAvailable=${MEM_AVAIL_MB}MB below ${WATCHDOG_MEM_MIN_MB}MB for 2 consecutive runs"
fi
if [ "$SWAP_TRIGGER" -eq 1 ]; then
  RESTART_WANTED=1
  [ -n "$REASON" ] && REASON="${REASON}; "
  REASON="${REASON}swap=${SWAP_USED_MB}MB above ${WATCHDOG_SWAP_MAX_MB}MB with MemAvailable=${MEM_AVAIL_MB}MB below 900MB for 2 consecutive runs"
fi

if [ "$RESTART_WANTED" -eq 1 ]; then
  LUMEN_STATE=$(systemctl is-active lumen 2>/dev/null)
  LAST_RESTART=$(cat "$MEM_LAST_RESTART_FILE" 2>/dev/null || echo 0)
  case "$LAST_RESTART" in ''|*[!0-9]*) LAST_RESTART=0 ;; esac
  SINCE_LAST=$((NOW_EPOCH - LAST_RESTART))
  if [ "$LUMEN_STATE" != "active" ]; then
    ok "memory guard: lumen not active, not restarting"
  elif [ "$LUMEN_UPTIME_S" -lt 600 ]; then
    ok "memory guard: would restart lumen ($REASON) but lumen uptime is ${LUMEN_UPTIME_S}s < 600s, skipping"
  elif [ "$LAST_RESTART" -gt 0 ] && [ "$SINCE_LAST" -lt "$WATCHDOG_RESTART_COOLDOWN_S" ]; then
    ok "memory guard: would restart lumen ($REASON) but last restart was ${SINCE_LAST}s ago < cooldown ${WATCHDOG_RESTART_COOLDOWN_S}s, skipping"
  elif [ "$DRY_RUN" -eq 1 ]; then
    alert "memory guard would restart lumen (MemAvailable=${MEM_AVAIL_MB} swap=${SWAP_USED_MB}) [dry-run, not restarted: $REASON]"
  else
    systemctl restart lumen >/dev/null 2>&1
    echo "$NOW_EPOCH" > "$MEM_LAST_RESTART_FILE"
    # Both counters, not just the low one: a restart that was triggered BY the
    # swap rule would otherwise leave swap-high-count at 2 and re-arm itself the
    # moment the cooldown expires, even though the restart already acted on it.
    echo 0 > "$MEM_LOW_COUNT_FILE"
    echo 0 > "$SWAP_HIGH_COUNT_FILE"
    alert "memory guard restarted lumen (MemAvailable=${MEM_AVAIL_MB} swap=${SWAP_USED_MB})"
  fi
else
  ok "memory guard: MemAvailable=${MEM_AVAIL_MB}MB swap=${SWAP_USED_MB}MB workers=${WORKER_RSS_MB}MB recsys=${RECSYS_MEM_MB}MB (below thresholds)"
fi

if [ "$FAILS" -gt 0 ] && [ -z "${ALERT_WEBHOOK:-}" ]; then
  echo "$(date -Is) ALERT-NOT-SENT ALERT_WEBHOOK is unset (create /opt/lumen/watchdog.env with ALERT_WEBHOOK=<discord-or-slack-url>) - the $FAILS alert(s) above stay on this box and nobody is told"
fi
if [ "$FAILS" -gt 0 ] && [ -n "${ALERT_WEBHOOK:-}" ]; then
  MSG="Lumen watchdog: $FAILS problem(s) on $(hostname). Run: journalctl -u lumen-watchdog -n 50"
  curl -s -m 15 -X POST "$ALERT_WEBHOOK" -H 'Content-Type: application/json' \
    -d "{\"content\":$(printf '%s' "$MSG" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'),\"text\":$(printf '%s' "$MSG" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')}" >/dev/null || true
fi
echo "$(date -Is) --- $FAILS problem(s) ---"
exit $([ "$FAILS" -gt 0 ] && echo 1 || echo 0)
