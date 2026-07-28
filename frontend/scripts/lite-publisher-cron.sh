#!/bin/sh
# Drive the Lumen lite publisher. THIS IS THE PIECE A REAL DEPLOY MUST RUN — without
# it, lite posts sit in Postgres forever and never reach Hive, silently, with no error
# shown to the user.
#
#   crontab:  * * * * * /path/to/lite-publisher-cron.sh >> /var/log/lumen-publisher.log 2>&1
#
# For a container deploy use docker/lumen-publisher.yml instead — same call, run as a
# service next to the blog, so "is the publisher running?" is answerable with `ps`:
#   docker compose -f docker/docker-compose.yml -f docker/lumen-publisher.yml up -d
#
# Safe to run every minute even while a previous run is still going: the endpoint takes
# a cluster-wide advisory lock and returns {"status":"skipped"} instead of double-
# publishing. One call drains up to 25 jobs, paced at Hive's 3-second comment interval,
# so a full batch takes ~85 seconds.
#
# Env:
#   LUMEN_BASE_URL         default http://127.0.0.1:3000
#   LITE_PUBLISHER_TOKEN   required — same value the app has
#   LITE_DRAIN_MAX         default 25 (the endpoint's own ceiling)
set -eu

BASE="${LUMEN_BASE_URL:-http://127.0.0.1:3000}"
MAX="${LITE_DRAIN_MAX:-25}"

if [ -z "${LITE_PUBLISHER_TOKEN:-}" ]; then
  echo "$(date -Is) LITE_PUBLISHER_TOKEN is not set — refusing to run" >&2
  exit 1
fi

RESPONSE=$(curl -sS -X POST "$BASE/api/lite/publisher/drain" \
  -H 'content-type: application/json' \
  -H "x-lite-publisher-token: $LITE_PUBLISHER_TOKEN" \
  -d "{\"max\":$MAX}" \
  --max-time 300 -w '\n%{http_code}')

CODE=$(printf '%s' "$RESPONSE" | tail -n1)
BODY=$(printf '%s' "$RESPONSE" | sed '$d')

echo "$(date -Is) drain HTTP $CODE $BODY"

# A drain that returns 200 is not proof the queue is moving — it returns 200 for an
# empty queue and for a queue whose jobs all failed. Ask the queue itself, because the
# failure being guarded against here is silence: if this cron is not installed at all,
# nothing below ever runs and nothing ever complains. Whatever runs this script should
# alert on a non-zero exit.
HEALTH=$(curl -sS "$BASE/api/lite/publisher/health" \
  -H "x-lite-publisher-token: $LITE_PUBLISHER_TOKEN" \
  --max-time 30 -w '\n%{http_code}' || printf '\n000')

HCODE=$(printf '%s' "$HEALTH" | tail -n1)
HBODY=$(printf '%s' "$HEALTH" | sed '$d')
echo "$(date -Is) health HTTP $HCODE $HBODY"

# 503 from health means stalled or stuck work — that IS worth paging on.
if [ "$HCODE" = "503" ]; then
  echo "$(date -Is) PUBLISHER QUEUE STALLED — lite posts are queued and not reaching Hive" >&2
  exit 1
fi

# 503 from the DRAIN means the publisher is deliberately dark (no signer injected, or
# refusing to arm against mainnet without an explicit opt-in). That is a configuration
# state, not a failure to alert on every minute.
case "$CODE" in
  200|503) exit 0 ;;
  *) exit 1 ;;
esac
