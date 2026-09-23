#!/bin/sh
# Warm EVERY Inquisition surface: all five boards, every column on every row of them, and
# the profile record behind every account that appears on any of them. One request at a
# time, always.
#
# WHY IT EXISTS (owner, 2026-09-20: "everythign warm and visible instantly by anyone that
# enters lumen and doesnt have to rewarm themselves", "populate all and then prperly
# populate it per week ... automatically"). Boards and records are built on demand and
# kept on disk for a week, which makes the SECOND reader fast and leaves the FIRST one
# watching "Counting..." for half an hour. Run on a timer at a quiet hour, there is no
# first reader.
#
# IT DRIVES EACH BOARD TO COMPLETION, not just to "not building". The staged boards
# publish stage 1 (the ranking) immediately and fill the counterpart and money columns
# behind it; a pass that ends on its wall-clock budget leaves the board at stage 2 with a
# `done` list on disk, and the NEXT request resumes exactly where it stopped. Waiting for
# `building: false` was therefore not enough -- it returns false the moment a pass ends,
# budget or no budget. This checks the stored stage and keeps asking until it is 3.
#
# WHY IT IS NOT A FORCED REBUILD. Every request is the one the page makes. A fresh board
# or record is served from disk and costs nothing; only a missing, stale or PARTIAL one
# triggers work, so running it twice in an hour is free and running it daily is what keeps
# the weekly refresh off the reader path.
#
# HiveSQL is a free DHF-funded service on a single subscription, and it blocked this
# project's IP for ~20 minutes on 2026-09-19 after a burst of concurrent queries. ONE
# REQUEST AT A TIME, NEVER IN PARALLEL, and the records are taken oldest-first under a
# nightly budget so the week's work is spread across the week instead of landing in one
# night. Override with REC_BUDGET= for a first full fill.
set -u
LOG=/var/log/lumen-inquisition-warm.log
BASE=http://127.0.0.1:3000/api/inquisition
CACHE=${LUMEN_CACHE_DIR:-/opt/lumen/cache}
BOARDS="ke muted crossposting downvoted inquisitors"
REC_MAX=${REC_MAX:-420}              # per record request
REC_BUDGET=${REC_BUDGET:-21600}      # nightly wall clock for the record pass (6h: ~4,600 records a week)
FRESH_DAYS=${FRESH_DAYS:-6}          # a whole record younger than this is not asked for

say() { echo "$(date -Is) $*" >> "$LOG"; }

# How far a board must get before it is finished: the staged ones publish at 1 and fill to 3.
want_stage() {
  case "$1" in
    downvoted|inquisitors) echo 3 ;;
    *) echo 1 ;;
  esac
}

stage_of() {
  f="$CACHE/$1.json"
  [ -r "$f" ] || { echo 0; return; }
  s=$(grep -o '"stage":[0-9]*' "$f" | head -1 | cut -d: -f2)
  # A one-stage board carries no stage marker; its file existing IS its completion.
  echo "${s:-1}"
}

say "warm start (rec budget ${REC_BUDGET}s)"

# ── THE BOARDS, AND EVERY COLUMN ON THEM ─────────────────────────────────────────────
for b in $BOARDS; do
  case "$b" in
    downvoted|inquisitors) max=${BOARD_MAX_STAGED:-28800} ;;   # money pass over 100 rows
    *) max=${BOARD_MAX:-9000} ;;
  esac
  want=$(want_stage "$b")
  t0=$(date +%s)
  last=""
  while :; do
    out=$(curl -s --max-time 180 "$BASE/boards?board=$b" 2>/dev/null)
    rows=$(printf '%s' "$out" | grep -o '"account"' | wc -l)
    case "$out" in
      *'"unavailable":true'*) say "$b UNAVAILABLE after $(( $(date +%s) - t0 ))s"; break ;;
      *'"building":true'*) : ;;
      *'"rows"'*)
        st=$(stage_of "$b")
        if [ "$st" -ge "$want" ]; then
          say "$b done in $(( $(date +%s) - t0 ))s, $rows rows, stage $st"
          break
        fi
        # Not building and not finished: the last pass ended on its budget. Asking again
        # starts the next one, which resumes from the `done` list on disk.
        [ "$st" != "$last" ] && { say "$b at stage $st of $want after $(( $(date +%s) - t0 ))s, resuming"; last=$st; }
        ;;
      *) say "$b unexpected reply: $(printf '%s' "$out" | cut -c1-120)" ;;
    esac
    if [ $(( $(date +%s) - t0 )) -gt "$max" ]; then say "$b GAVE UP after ${max}s at stage $(stage_of "$b")"; break; fi
    sleep 30
  done
done

# ── EVERY RECORD BEHIND EVERY ROW, OLDEST FIRST ──────────────────────────────────────
# The app warms records only when a money board FINISHES a build, so on every day but the
# seventh nothing would warm them. Deduplicated across the five boards; a record that is
# whole and young is skipped without a request; a PARTIAL one is never skipped, because
# retrying it is the point of the daily run.
# ★ Plus every record already on disk (2026-09-22): a profile someone opened that sits on
# no board is still a record a reader will see, and a definition change leaves it wrong
# until it is rebuilt like the rest.
# ★★ PLUS EVERY ACCOUNT ACTIVE ON HIVE IN THE LAST 30 DAYS (2026-09-23, owner: "this has to
# be warmed before anyone opens"). Boards and already-opened profiles were the whole list,
# so every other author a reader clicked from a post card was built on first open, behind
# the reader: @rustedwax, @skiptvads, @starkerz. The list is ~4,600 names, most recently
# active first, refreshed by one Accounts query per run; a failed refresh keeps the last one.
# ★★ AND EVERY ACCOUNT THAT EVER HELD 100k+ HP/SP, STEEM HISTORY INCLUDED (2026-09-23, owner:
# "all accounts ever that held more than 100k HP or SP during steem so full history"): ~905,
# built right after the boards. How "ever held" is proven is in warm-accounts.js.
node /opt/lumen/warm-accounts.js >> "$LOG" 2>&1 || say "an account list was not refreshed; using the previous one"
accounts=$( (for b in $BOARDS; do
               [ -r "$CACHE/$b.json" ] && grep -o '"account":"[^"]*"' "$CACHE/$b.json" | cut -d'"' -f4
             done
             [ -r "$CACHE/whale-accounts.txt" ] && cat "$CACHE/whale-accounts.txt"
             [ -r "$CACHE/active-accounts.txt" ] && cat "$CACHE/active-accounts.txt"
             for f in "$CACHE"/rec-*.json; do [ -r "$f" ] && basename "$f" .json | cut -c5-; done) \
           | grep -E '^[a-z0-9.-]{3,16}$' | awk '!seen[$0]++')
total=$(printf '%s\n' "$accounts" | grep -c .)

# Oldest first: missing, partial and unfinished records lead, then the least recently built.
# ★ AGE IS THE RECORD'S OWN `builtAt`, THE CLOCK THE APP USES, NOT THE FILE'S MTIME
# (2026-09-22). A migration that rewrites the files resets every mtime without making any
# record newer: 357 records the app considered stale were skipped here as "fresh", so
# their old figures would have waited for a reader to open each profile.
# ★★ ONLY BOARD AND ACTIVE ACCOUNTS ARE REFRESHED WEEKLY (2026-09-23, owner: "the weekly
# rewarm probably doesnt have to rewarm everything, only the active users"). A whale who
# stopped posting years ago, or a profile somebody opened once, is BUILT once and then left:
# the record route still refreshes it behind whoever opens it after a week, so nobody is
# served a stale figure without a refresh following. Missing, partial and unfinished
# records are built for every account on the list, active or not.
WEEKLY=/tmp/lumen-warm-weekly.txt
( for b in $BOARDS; do [ -r "$CACHE/$b.json" ] && grep -o '"account":"[^"]*"' "$CACHE/$b.json" | cut -d'"' -f4; done
  [ -r "$CACHE/active-accounts.txt" ] && cat "$CACHE/active-accounts.txt" ) | sort -u > "$WEEKLY"
now=$(date +%s)
queue=$(for a in $accounts; do
          f="$CACHE/rec-$a.json"
          if [ -r "$f" ]; then
            b=$(grep -o '"builtAt":[0-9]*' "$f" | tail -1 | cut -d: -f2)
            b=$(( ${b:-0} / 1000 ))
            if grep -q '"partial":true\|"complete":false' "$f"; then echo "0 $a"
            elif [ $(( now - b )) -lt $(( FRESH_DAYS * 86400 )) ]; then :   # fresh and whole: skip
            elif ! grep -qxF "$a" "$WEEKLY"; then :                         # built, not active: on demand
            else echo "$b $a"
            fi
          else
            echo "0 $a"
          fi
        done | sort -s -n -k1,1 | cut -d' ' -f2)   # stable: missing ones keep board, then activity order
due=$(printf '%s\n' "$queue" | grep -c .)
say "record pass: $due of $total accounts due"

# ★ PROGRESS ANYONE CAN READ (2026-09-23, owner: "i have no way to check how far along the
# warm we are"). Rewritten after every record; served by /api/inquisition/warm-status.
STATUS="$CACHE/warm-status.json"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
status() {
  printf '{"state":"%s","startedAt":"%s","updatedAt":"%s","total":%s,"due":%s,"built":%s,"failed":%s,"current":"%s","budgetEndsAt":"%s"}\n' \
    "$1" "$started" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$total" "$due" "$built" "$failed" "$2" \
    "$(date -u -d "@$deadline" +%Y-%m-%dT%H:%M:%SZ)" > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
}

deadline=$(( $(date +%s) + REC_BUDGET ))
built=0; failed=0
status running ""

# ★★ TWO RECORDS AT A TIME (2026-09-23, owner: "why is warm so slow. cant you batch
# stuff"). Measured: an ordinary account builds in 6-9s, a prolific one ~46s, so one at a
# time is ~17h for 5,000 records. Three in flight (owner, 2026-09-23: "go to 3") fill the
# app's six slow-lane slots; a fourth would only queue behind them and behind readers. The route still guarantees one
# build per account across the three workers, and each worker queues its own HiveSQL
# statements, so two records is at most ~8 statements at once -- far below the 40-request
# burst that got this IP blocked on 2026-09-19. Raise WARM_PARALLEL with that in mind.
WARM_PARALLEL=${WARM_PARALLEL:-3}   # 3 fills the six slow-lane slots (2 per worker x 3); more only queues
WARM_RESULTS=$(mktemp /tmp/lumen-warm-results.XXXXXX)
export BASE REC_MAX LOG WARM_RESULTS WARM_PARALLEL
export WARM_DEADLINE=$deadline WARM_STATUS=$STATUS WARM_STARTED=$started WARM_TOTAL=$total WARM_DUE=$due
printf '%s\n' "$queue" | grep . | xargs -r -n 1 -P "$WARM_PARALLEL" /opt/lumen/warm-one-record.sh
built=$(grep -c '^built ' "$WARM_RESULTS"); failed=$(grep -c '^failed ' "$WARM_RESULTS")
rm -f "$WARM_RESULTS"
if [ $(( built + failed )) -lt "$due" ]; then
  say "record pass out of budget: $built built, $failed incomplete, $(( due - built - failed )) still due"
  status "out of budget" ""
else
  status done ""
fi
say "record pass done: $built built, $failed incomplete, of $due due ($total total)"
say "warm done"
