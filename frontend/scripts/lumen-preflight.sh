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

echo "---------------------------------------------------------------"
if [ "$FAIL" -gt 0 ]; then
  echo "$FAIL blocking problem(s), $WARN warning(s). Do not start yet."
  exit 1
fi
echo "No blocking problems. $WARN warning(s) — read them, they are all real."
exit 0
