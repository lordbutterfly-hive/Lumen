#!/bin/sh
# Builds ONE profile record for the Inquisition warm pass. Called by warm-inquisition.sh
# through `xargs -P $WARM_PARALLEL`, with its settings in the environment. Asks the record
# route (the same request a reader's page makes), polls until the fill finishes, appends
# "built <account>" or "failed <account>" to $WARM_RESULTS, and rewrites the status file.
a="$1"
[ "$(date +%s)" -ge "$WARM_DEADLINE" ] && exit 0   # out of budget: leave it for the next run
say() { echo "$(date -Is) $*" >> "$LOG"; }
tmp=$(mktemp /tmp/lumen-warm-rec.XXXXXX)
t0=$(date +%s); result=failed; down=0
while :; do
  code=$(curl -s -o "$tmp" -w '%{http_code}' --max-time "$REC_MAX" "$BASE/record/$a" 2>/dev/null)
  if [ "$code" = "429" ]; then sleep 60; continue; fi
  # ★ 000 = the app did not answer at all, i.e. it is restarting (the memory guard restarts
  # it when MemAvailable drops below ~800MB; it did at 05:05 on 2026-09-23). That is not
  # this account failing: wait for the app, up to two minutes, and ask again. Counting it
  # as a failure burned 60 accounts in one second while the app was down.
  if [ "$code" = "000" ]; then
    down=$((down + 1))
    if [ "$down" -le 24 ]; then sleep 5; t0=$(date +%s); continue; fi
    say "rec $a: app did not answer for 2 minutes"; break
  fi
  if [ "$code" != "200" ]; then say "rec $a HTTP $code"; break; fi
  case "$(cat "$tmp" 2>/dev/null)" in
    *'"unavailable":true'*) say "rec $a unavailable"; break ;;
    *'"building":true'*) : ;;
    *) result=built; break ;;
  esac
  if [ $(( $(date +%s) - t0 )) -gt "$REC_MAX" ]; then say "rec $a still filling after ${REC_MAX}s"; break; fi
  sleep 2   # a poll is a disk read on our side, never a HiveSQL query
done
rm -f "$tmp"
echo "$result $a" >> "$WARM_RESULTS"
built=$(grep -c '^built ' "$WARM_RESULTS"); failed=$(grep -c '^failed ' "$WARM_RESULTS")
printf '{"state":"running","startedAt":"%s","updatedAt":"%s","total":%s,"due":%s,"built":%s,"failed":%s,"current":"%s","parallel":%s,"budgetEndsAt":"%s"}\n' \
  "$WARM_STARTED" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$WARM_TOTAL" "$WARM_DUE" "$built" "$failed" "$a" "$WARM_PARALLEL" \
  "$(date -u -d "@$WARM_DEADLINE" +%Y-%m-%dT%H:%M:%SZ)" > "$WARM_STATUS.$$" && mv "$WARM_STATUS.$$" "$WARM_STATUS"
