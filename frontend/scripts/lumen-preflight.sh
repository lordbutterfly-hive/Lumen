#!/bin/sh
# Lumen deploy preflight. Run this BEFORE `docker compose up`, not after the
# first user complains.
#
#   ./scripts/lumen-preflight.sh                       # checks apps/blog/.env.local
#   ./scripts/lumen-preflight.sh path/to/.env          # checks a specific file
#
# Every check here exists because the thing it checks for has ALREADY gone wrong
# on this project at least once. It reads variable NAMES and never prints a
# value — several of these are live keys.
#
# Exit 0 = safe to start. Exit 1 = something will break, and it says what.

set -u

ENV_FILE="${1:-apps/blog/.env.local}"
FAIL=0
WARN=0

red()  { printf '\033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
amber(){ printf '\033[33mWARN\033[0m  %s\n' "$1"; WARN=$((WARN+1)); }
green(){ printf '\033[32m ok \033[0m  %s\n' "$1"; }

if [ ! -f "$ENV_FILE" ]; then
  echo "No env file at $ENV_FILE — copy .env.lumen-mainnet.example and fill it in." >&2
  exit 1
fi

# present-and-non-empty, without ever echoing the value
has() { grep -qE "^$1=.+" "$ENV_FILE"; }
val() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }

echo "Lumen preflight — $ENV_FILE"
echo "---------------------------------------------------------------"

# ---- 1. the three that break hour one -------------------------------------
if has DENSER_SERVER_SECRET_COOKIE_PASSWORD; then
  len=$(val DENSER_SERVER_SECRET_COOKIE_PASSWORD | wc -c)
  if [ "$len" -lt 33 ]; then
    red "DENSER_SERVER_SECRET_COOKIE_PASSWORD is under 32 chars — iron-session will reject it"
  else
    green "DENSER_SERVER_SECRET_COOKIE_PASSWORD set"
  fi
else
  red "DENSER_SERVER_SECRET_COOKIE_PASSWORD missing — EVERY lite login will 500 (iron-session: Missing password)"
fi

has LITE_ACCOUNTS_ENABLED && green "LITE_ACCOUNTS_ENABLED set" \
  || red "LITE_ACCOUNTS_ENABLED missing — every lite route answers 'disabled'"

has LITE_DATABASE_URL && green "LITE_DATABASE_URL set" \
  || red "LITE_DATABASE_URL missing — no lite storage at all"

# ---- 2. publishing ---------------------------------------------------------
if has LITE_PUBLISHER_POSTING_WIF; then
  green "LITE_PUBLISHER_POSTING_WIF set"
  if [ "${NODE_ENV:-}" = "production" ] && ! has LITE_PUBLISHER_ALLOW_WIF_IN_PROD; then
    red "NODE_ENV=production with no LITE_PUBLISHER_ALLOW_WIF_IN_PROD — the publisher will REFUSE to arm and posts will queue in Postgres forever"
  fi
else
  red "LITE_PUBLISHER_POSTING_WIF missing — posts will queue in Postgres and NOTHING will report a problem"
fi

has LITE_PUBLISHER_TOKEN && green "LITE_PUBLISHER_TOKEN set" \
  || red "LITE_PUBLISHER_TOKEN missing — the drain scheduler can never run, so nothing publishes"

if has LITE_FRONTEND_ACCOUNT_MAINNET || has LITE_FRONTEND_ACCOUNT_MIRRORNET || has LITE_FRONTEND_ACCOUNT_TESTNET; then
  green "a publisher account is configured for at least one network"
else
  red "no LITE_FRONTEND_ACCOUNT_* set — there is no account to publish under"
fi

if has LITE_PUBLISHER_ALLOW_MAINNET; then
  amber "LITE_PUBLISHER_ALLOW_MAINNET is set — this deploy WILL write permanently to public Hive mainnet"
else
  green "mainnet publishing is OFF (LITE_PUBLISHER_ALLOW_MAINNET unset)"
fi

# ---- 3. moderation ---------------------------------------------------------
has LITE_MODERATOR_TOKEN && green "LITE_MODERATOR_TOKEN set — scripts/lumen-mod.sh will work" \
  || red "LITE_MODERATOR_TOKEN missing — you will NOT be able to ban or take anything down"

# ---- 4. signup methods -----------------------------------------------------
if has LITE_GOOGLE_CLIENT_ID; then
  if has LITE_EMAIL_ENCRYPTION_KEY; then
    green "Google signup on, email encryption key present"
  else
    red "LITE_GOOGLE_CLIENT_ID set without LITE_EMAIL_ENCRYPTION_KEY — signup refuses rather than storing unkeyed PII"
  fi
  amber "Google signup is ON — known open item: Drive OAuth access+refresh tokens are returned to client JS with no session binding. Leave it off for a first launch."
else
  green "Google signup off (removes the OAuth token exposure)"
fi

# ---- 4b. CAPTCHA — the pair that must be set TOGETHER ----------------------
# ★ 2026-08-06, found driving a PRODUCTION build behind real TLS. There are two
# variables and three ways to get this wrong, and each one kills signup silently
# in a different place:
#
#   secret only      -> the client renders no widget (it keys off the SITE key),
#                       so it posts no token; the server demands one. Every
#                       signup answers 403 captcha_failed.
#   site key only    -> assertLiteEnabled() refuses to start signup in
#                       production at all. Every signup answers 503.
#   neither, in prod -> same 503. Captcha is NOT optional in production; the
#                       code refuses to open signup without it rather than run
#                       with bot protection that fails open.
#
# Only "both set" works. Cloudflare's always-pass TEST keys are fine for a
# staging box: site 1x00000000000000000000AA / secret 1x0000000000000000000000000000000AA.
if has LITE_TURNSTILE_SECRET && has REACT_APP_TURNSTILE_SITE_KEY; then
  green "Turnstile fully configured (secret + public site key)"
elif has LITE_TURNSTILE_SECRET; then
  red "LITE_TURNSTILE_SECRET without REACT_APP_TURNSTILE_SITE_KEY — the widget never renders, no token is sent, and EVERY signup answers 403 captcha_failed"
elif has REACT_APP_TURNSTILE_SITE_KEY; then
  red "REACT_APP_TURNSTILE_SITE_KEY without LITE_TURNSTILE_SECRET — in production assertLiteEnabled() refuses signup entirely (503)"
else
  red "no Turnstile keys — in production signup is refused outright (503 lite_accounts_disabled). Captcha is mandatory there by design."
fi

# ---- 4c. the browser must be ALLOWED to load those third-party scripts ------
# The CSP grants challenges.cloudflare.com / accounts.google.com only when the
# matching PUBLIC (REACT_APP_*) variable is present in the SERVER's environment.
# A key set only in a secret store the Next server does not see leaves the CSP
# closed, and the symptom is a widget that never appears — not an error.
if has LITE_GOOGLE_CLIENT_ID && ! has REACT_APP_LITE_GOOGLE_CLIENT_ID; then
  red "LITE_GOOGLE_CLIENT_ID without REACT_APP_LITE_GOOGLE_CLIENT_ID — the Google button stays disabled AND the CSP blocks accounts.google.com"
fi

# ---- 5. upgrade path -------------------------------------------------------
if has LITE_ACCOUNT_CREATOR_ACTIVE_WIF; then
  amber "LITE_ACCOUNT_CREATOR_ACTIVE_WIF set — this is an ACTIVE key, and the upgrade path has never broadcast a real transaction. Drive it on a testnet first."
else
  green "account-creator disabled (upgrade path off)"
fi

# ---- 5b. ranked feed -------------------------------------------------------
if has RECSYS_FEED_URL; then
  if has RECSYS_API_TOKEN; then
    green "ranked For You feed ON (RECSYS_FEED_URL + token set)"
  else
    red "RECSYS_FEED_URL set without RECSYS_API_TOKEN — recsys will 401 every request and For You silently serves trending instead"
  fi
  has LITE_RECSYS_TOKEN || amber "LITE_RECSYS_TOKEN unset — recsys cannot pull the lite follow graph back"
else
  amber "RECSYS_FEED_URL unset — 'For You' serves Hive trending, NOT the ranking engine"
fi

# ---- 5c. can recsys SEE Lumen's own posts? --------------------------------
# ★ 2026-08-06: recsys gates ALL lite-post sourcing on `LiteConfig.enabled`,
# which is `bool(publisher_accounts)`. With it unset the ranker silently ignores
# every Lumen-native post — the feed looks fine and is quietly Hive-only. This
# is a RECSYS-side variable, so it is checked against recsys's env file.
RECSYS_ENV="${RECSYS_ENV_FILE:-/mnt/o/Lumen/recsys/.env.local}"
if [ -f "$RECSYS_ENV" ]; then
  if grep -qE '^(LITE_PUBLISHER_ACCOUNTS|LITE_FRONTEND_ACCOUNT_[A-Z]+)=.+' "$RECSYS_ENV"; then
    green "recsys can source Lumen-native posts (publisher accounts set)"
  else
    red "recsys has no LITE_PUBLISHER_ACCOUNTS/LITE_FRONTEND_ACCOUNT_* — it will IGNORE every Lumen post and serve a silently Hive-only feed"
  fi
else
  amber "recsys env not found at $RECSYS_ENV — cannot check lite sourcing"
fi

# ---- 6. database reachable + migrated -------------------------------------
if command -v psql >/dev/null 2>&1 && has LITE_DATABASE_URL; then
  DSN=$(val LITE_DATABASE_URL)
  if psql "$DSN" -tAc 'select 1' >/dev/null 2>&1; then
    green "lite database reachable"
    n=$(psql "$DSN" -tAc "select count(*) from information_schema.tables where table_schema='public'" 2>/dev/null)
    if [ "${n:-0}" -ge 14 ]; then
      green "lite schema present ($n tables)"
    else
      red "lite database has only ${n:-0} tables — apply apps/blog/lib/lite/db/migrations/*.sql in filename order"
    fi
  else
    red "cannot connect to LITE_DATABASE_URL"
  fi
else
  amber "psql not available — database reachability not checked"
fi

# --- Creator-tokens indexer mapping ------------------------------------------
#
# ★ THE FAILURE THIS PREVENTS (2026-08-07 -> 2026-08-14, cost a week).
#
# The Magi indexer decodes a contract's logs using a mapping that is PINNED TO
# ONE ADDRESS (creator_tokens_mappings.yaml `contracts[].address`). It files
# events from the moment it first sees that contract and never goes back: there
# is no automatic replay of logs that arrived before the mapping was installed.
#
# So if the contract is deployed (or relaunched) BEFORE its mapping is updated,
# every event in that window is stored raw and never decoded. The symptom is
# silent and misleading — `/creators` reads "No creators have launched a token
# yet" while a live market sits on chain, and every view we read
# (lumen_ct_discovery / balances / delivery_record / price_history) is empty,
# because they are all built on `registered` and `bought`.
#
# That is exactly what happened: the contract went live at block 5,480,152 and
# the mapping landed two days later. Three events were lost, and it took a
# round trip with the indexer operator to establish that nothing was broken —
# the mapping simply started late.
#
# The rule is: MAPPING FIRST, THEN DEPLOY. This check is here because "remember
# to update the YAML" is not a control.
MAPPING_YAML="/mnt/o/Lumen/creator-tokens/magi-indexer/creator_tokens_mappings.yaml"
APP_CT_ID=$(grep -oE '^REACT_APP_CREATOR_TOKENS_CONTRACT_ID=.*' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)
if [ -n "$APP_CT_ID" ]; then
  if [ -f "$MAPPING_YAML" ]; then
    MAP_CT_ID=$(grep -oE 'address: "[^"]+"' "$MAPPING_YAML" 2>/dev/null | head -1 | cut -d'"' -f2)
    if [ "$APP_CT_ID" = "$MAP_CT_ID" ]; then
      green "creator-tokens mapping address matches the app's contract id"
    else
      red "creator-tokens mapping is for a DIFFERENT contract than the app points at — update creator_tokens_mappings.yaml (address AND fromBlockHeight) and reinstall it on the indexer BEFORE this contract sees traffic, or its events will never be decoded"
    fi
  else
    amber "creator-tokens mapping not found at $MAPPING_YAML — cannot check it matches the app's contract id"
  fi
fi

echo "---------------------------------------------------------------"
if [ "$FAIL" -gt 0 ]; then
  echo "$FAIL blocking problem(s), $WARN warning(s). Do not start yet."
  exit 1
fi
echo "No blocking problems. $WARN warning(s) — read them, they are all real."
exit 0
