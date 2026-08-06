#!/bin/sh
# Lumen moderation from one command. Built 2026-08-06 because the abuse plan is
# "someone tells me and I take it down myself" — that only works if taking it
# down is faster than reading about it.
#
# There is no report queue and deliberately none: this IS the tool.
#
#   ./scripts/lumen-mod.sh kick   <name>  "reason"   # ban: kills their session NOW + hides their posts
#   ./scripts/lumen-mod.sh mute   <name>  "reason"   # suspend: same, but reversible in spirit
#   ./scripts/lumen-mod.sh unkick <name>             # reinstate
#   ./scripts/lumen-mod.sh hide   <permlink-or-id> "reason"   # hide ONE post in Lumen
#   ./scripts/lumen-mod.sh nuke   <permlink-or-id> "reason"   # hide it AND remove it from Hive
#   ./scripts/lumen-mod.sh show   <permlink-or-id>            # put a post back
#   ./scripts/lumen-mod.sh who    <name>                      # what is this account's state?
#
# Environment (put these in your shell profile once):
#   LUMEN_BASE_URL        default http://localhost:3000
#   LITE_MODERATOR_TOKEN  required — same value the app has
#   LUMEN_MOD_ACTOR       optional, recorded as who did it (default: $USER)
#
# VERIFIED BEHAVIOUR of `kick`, driven live 2026-08-06 against a real account:
#   * every existing session dies immediately (session_epoch is bumped) — all of
#     profile/follow/unfollow/vote/reblog returned 401 on the next request;
#   * they CANNOT sign back in with the same wallet — re-login is refused;
#   * pending publish jobs are held, so nothing further of theirs reaches Hive;
#   * with content hiding on, their posts disappear from Lumen.
#
# WHAT IT CANNOT DO, and you should know this before you promise anyone anything:
#   Posts ALREADY on Hive are on a public permanent ledger. `kick` hides them in
#   Lumen; it does not remove them from the chain. The response tells you how
#   many are affected — use `nuke` per post to attempt the chain removal, which
#   Hive itself refuses once a post has replies, net-positive votes, or has paid
#   out (the worker then blanks the content instead).

set -eu

BASE="${LUMEN_BASE_URL:-http://localhost:3000}"
ACTOR="${LUMEN_MOD_ACTOR:-${USER:-operator}}"

if [ -z "${LITE_MODERATOR_TOKEN:-}" ]; then
  echo "LITE_MODERATOR_TOKEN is not set — that is the whole authorisation for this tool." >&2
  echo "Export it (the same value the app has) and try again." >&2
  exit 2
fi

cmd="${1:-}"
[ -n "$cmd" ] || { sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
shift

post_json() { # path json
  curl -sS -w '\n%{http_code}' -X POST "$BASE$1" \
    -H 'content-type: application/json' \
    -H 'x-csrf-token: 1' \
    -H "x-lite-moderator-token: $LITE_MODERATOR_TOKEN" \
    -H "x-lite-moderator-actor: $ACTOR" \
    -d "$2"
}

report() { # raw-with-status-on-last-line
  status=$(printf '%s' "$1" | tail -n1)
  body=$(printf '%s' "$1" | sed '$d')
  if [ "$status" = "200" ]; then
    printf '%s\n' "$body" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$body"
    echo "OK ($status)"
  else
    printf '%s\n' "$body"
    echo "FAILED (HTTP $status)" >&2
    exit 1
  fi
}

# JSON-escape a shell string (reasons contain quotes, newlines, apostrophes).
esc() { printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'; }

user_action() { # action name reason hide
  name="${1:?name required}"; reason="${2:-}"; hide="${3:-false}"
  if [ "$1" != "reinstate" ] && [ -z "$reason" ]; then :; fi
  report "$(post_json /api/lite/moderation/user \
    "{\"displayName\":$(esc "$name"),\"action\":\"$4\",\"reason\":$(esc "$reason"),\"hideContent\":$hide}")"
}

post_action() { # target reason visibility takedown
  # ★ SEND EXACTLY ONE IDENTIFIER. Sending both made every permlink takedown
  # fail with `post_not_found`: the route reads `postId` FIRST and only falls
  # back to `permlink`, so a permlink passed in both fields was looked up as an
  # id. Found running a real takedown against a live mainnet post.
  # A lite permlink is `lumen-<lowercased ULID>`; anything else is an id.
  case "$1" in
    lumen-*) key="permlink" ;;
    *)       key="postId" ;;
  esac
  report "$(post_json /api/lite/moderation/post \
    "{\"$key\":$(esc "$1"),\"reason\":$(esc "$2"),\"visibility\":\"$3\",\"takedown\":$4}")"
}

case "$cmd" in
  kick)
    name="${1:?usage: kick <name> \"reason\"}"; reason="${2:?a reason is required — you will want it later}"
    echo "Banning @$name — sessions die immediately, posts hidden, pending publishes held."
    user_action "$name" "$reason" true ban
    ;;
  mute|suspend)
    name="${1:?usage: mute <name> \"reason\"}"; reason="${2:?a reason is required}"
    user_action "$name" "$reason" true suspend
    ;;
  unkick|reinstate)
    name="${1:?usage: unkick <name>}"
    user_action "$name" "${2:-}" false reinstate
    ;;
  hide)
    post_action "${1:?usage: hide <permlink|id> \"reason\"}" "${2:?a reason is required}" hidden false
    ;;
  nuke)
    echo "Hiding in Lumen AND queueing removal from Hive. Hive may refuse (replies/votes/paid out) — the worker blanks the content instead."
    post_action "${1:?usage: nuke <permlink|id> \"reason\"}" "${2:?a reason is required}" hidden true
    ;;
  show|restore)
    post_action "${1:?usage: show <permlink|id>}" "" visible false
    ;;
  who)
    name="${1:?usage: who <name>}"
    echo "Ask the database directly — there is no read endpoint for this yet:"
    echo "  select display_name, status, suspended_reason, session_epoch, suspended_at"
    echo "    from lumen_user where display_name = '$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')';"
    ;;
  *)
    echo "unknown command: $cmd" >&2
    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac
