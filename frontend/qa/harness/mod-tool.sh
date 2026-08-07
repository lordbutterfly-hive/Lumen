#!/bin/sh
# Moderation wrapper for QA. Reads LITE_MODERATOR_TOKEN from the app's env file
# and hands it to scripts/lumen-mod.sh, so a tester can exercise the takedown
# path WITHOUT the token ever being printed, pasted or stored anywhere else.
#
#   qa/harness/mod-tool.sh who    <name>
#   qa/harness/mod-tool.sh kick   <name> "reason"
#   qa/harness/mod-tool.sh unkick <name>
#   qa/harness/mod-tool.sh hide   <permlink|id> "reason"
#   qa/harness/mod-tool.sh show   <permlink|id>
#
# ★ ONLY ACT ON ACCOUNTS AND POSTS YOU CREATED. `nuke` is deliberately not
#   exposed here: it attempts removal from Hive MAINNET, which is permanent.
set -eu
ROOT=/home/clauderfly/hive-blog-rebuild
TOKEN=$(python3 -c "
import re,pathlib
s=pathlib.Path('$ROOT/apps/blog/.env.local').read_text()
m=re.search(r'^LITE_MODERATOR_TOKEN=(.+)\$',s,re.M)
print(m.group(1).strip() if m else '')")
[ -n "$TOKEN" ] || { echo "moderator token not configured" >&2; exit 2; }
case "${1:-}" in
  nuke) echo "refused: nuke removes content from Hive mainnet permanently. Not available to QA." >&2; exit 2 ;;
esac
LITE_MODERATOR_TOKEN="$TOKEN" LUMEN_BASE_URL=http://localhost:3000 \
  LUMEN_MOD_ACTOR=qa sh "$ROOT/scripts/lumen-mod.sh" "$@"
