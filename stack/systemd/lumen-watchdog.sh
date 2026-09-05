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
