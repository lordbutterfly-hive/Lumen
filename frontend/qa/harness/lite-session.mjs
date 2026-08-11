/**
 * Mint the exact iron-session cookie a lite login issues, for tests that need
 * MORE THAN ONE session for the same account at the same time.
 *
 * ★ WHY THIS EXISTS SEPARATELY FROM `session.mjs`. That helper mints a FULL Hive
 * session for one browser. Session revocation is a property of several sessions
 * at once — "signing out here left the other device alone" cannot be observed
 * from the device that signed out — so these tests need to hold three cookies
 * for one account and drive them independently. There is no browser flow that
 * produces that: a lite login needs a wallet or a Google account.
 *
 * What is minted here is byte-for-byte the shape `auth/auth-service.issueSession`
 * saves — `{ user, sessionEpoch, sessionId }` sealed with the running server's own
 * secret — so the server code under test is the real one. Nothing here is a stub.
 */

import { sealData } from 'iron-session';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SECRET = 'DENSER_SERVER_SECRET_COOKIE_PASSWORD';
const ENV_FILES = [
  '/home/clauderfly/hive-blog-rebuild/apps/blog/.env.local',
  '/home/clauderfly/hive-blog-rebuild/.env.blog'
];

export const BASE = process.env.QA_BASE || 'http://localhost:3000';

/**
 * ★ AND DO NOT HARDCODE THE COOKIE NAME EITHER. `qa/harness/session.mjs` asserts
 * the running server uses `app_`; measured on this box on 2026-08-10 it sets
 * `blog_login_challenge`, i.e. the prefix is `blog_`. That helper only survives
 * because it probes candidates — its prose is wrong for the third time. Name and
 * secret are resolved together below, against the server, for the same reason.
 */
const COOKIE_NAMES = ['blog_session', 'app_session'];

/**
 * ★★★ ASK THE RUNNING PROCESS, DO NOT READ THE FILE (2026-08-10).
 *
 * `qa/harness/session.mjs` was fixed twice for minting cookies the server could
 * not open, and it is still wrong in a third way: it reads the secret from
 * `apps/blog/.env.local`, but a dev server holds whatever was in its environment
 * WHEN IT STARTED. Editing `.env.local` afterwards changes the file and not the
 * server — and Next never overrides an inherited `process.env` value from a
 * `.env` file anyway. Measured here: the running server's secret is 48 characters
 * (sha256 fb1a0cd8d398), `.env.local` holds a different 49-character one
 * (b48a1c751252). Cookies sealed from the file open as an EMPTY session, every
 * route answers 401, and a revocation test reads as "everything is revoked" —
 * a false PASS on the exact property under test.
 *
 * So: collect every candidate (each running `next` process's own environment,
 * then the env files), and keep the one the SERVER accepts. Same principle as
 * `resolveCookieName` — the server is the authority on its own secret.
 */
function secretCandidates() {
  const found = [];
  const add = (v) => {
    const value = (v ?? '').trim().replace(/^["']|["']$/g, '');
    if (value && !found.includes(value)) found.push(value);
  };

  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    let cmdline;
    try {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    } catch {
      continue;
    }
    if (!cmdline.includes('next')) continue;
    try {
      const line = readFileSync(`/proc/${pid}/environ`, 'utf8')
        .split('\0')
        .find((l) => l.startsWith(`${SECRET}=`));
      if (line) add(line.slice(SECRET.length + 1));
    } catch {
      /* not ours to read */
    }
  }

  for (const file of ENV_FILES) {
    try {
      const line = readFileSync(file, 'utf8')
        .split('\n')
        .find((l) => l.startsWith(`${SECRET}=`));
      if (line) add(line.slice(SECRET.length + 1));
    } catch {
      /* absent */
    }
  }

  if (!found.length) throw new Error(`${SECRET} found in no running next process and no env file`);
  return found;
}

let RESOLVED = null;

/**
 * Prove the cookie before any test uses it: seal a probe session for a real row
 * and ask the server who it thinks that is. A cookie that does not open is
 * indistinguishable from being signed out, so this refuses to guess.
 */
async function resolveCookie(user) {
  if (RESOLVED) return RESOLVED;
  const secrets = secretCandidates();
  const seen = [];
  for (const password of secrets) {
    const sealed = await sealData({ user: sessionUserFor(user) }, { password, ttl: 600 });
    for (const name of COOKIE_NAMES) {
      let body;
      try {
        const res = await fetch(`${BASE}/api/users/me`, { headers: { cookie: `${name}=${sealed}` } });
        body = await res.json();
      } catch (error) {
        throw new Error(
          `could not reach ${BASE}/api/users/me to verify the session cookie ` +
            `(${String(error).slice(0, 120)}). Is the app running?`
        );
      }
      if (body?.isLoggedIn && body.username === user.displayName) {
        RESOLVED = { password, name };
        return RESOLVED;
      }
      seen.push(`${name}: isLoggedIn=${body?.isLoggedIn} username="${body?.username ?? ''}"`);
    }
  }
  throw new Error(
    `the server opened NONE of ${secrets.length} secret(s) x ${COOKIE_NAMES.length} cookie name(s) — ` +
      `/api/users/me answered [${seen.join('; ')}] for "${user.displayName}".\n` +
      `Do NOT test with this: every route would answer 401 and a session test would report ` +
      `"revoked" for reasons that have nothing to do with revocation.`
  );
}

/** Run one statement against the QA Postgres and return the (tuple-only) output. */
export function psql(sql) {
  return execFileSync(
    'docker',
    ['exec', 'lumen-b12-pg', 'psql', '-U', 'qa', '-d', 'lite', '-t', '-A', '-c', sql],
    { encoding: 'utf8' }
  ).trim();
}

/** The `User` payload `session/lite-session.ts::buildLiteSessionUser` stores. */
function sessionUserFor(user) {
  return {
    isLoggedIn: true,
    username: user.displayName,
    userId: user.userId,
    account_tier: 'lite',
    avatarUrl: '',
    loginType: 'wif',
    keyType: 'posting',
    authenticateOnBackend: false,
    chatAuthToken: '',
    oauthConsent: {},
    strict: false
  };
}

/**
 * Seal a lite session cookie.
 *
 * @param user      `{ userId, displayName }`
 * @param epoch     the `session_epoch` stamped at issue
 * @param sessionId per-device id; pass `null` to mint a LEGACY (pre-sid) cookie,
 *                  which is what every session issued before that build carries.
 * @param issuedAt  epoch-ms for `sessionIssuedAt` (F-L37, 2026-08-11), the
 *                  server-enforced TTL stamp checked by getLiteSession(). Defaults
 *                  to `Date.now()` — a REAL login always stamps one now, so a
 *                  default-minted cookie should too, or every existing caller of
 *                  this function that expects "fresh session -> 200" would start
 *                  seeing 401s for a reason that has nothing to do with what it is
 *                  testing. Pass an old timestamp (e.g. `Date.now() - 15*86400000`)
 *                  to mint an EXPIRED session, or `null` to mint a LEGACY cookie
 *                  with no stamp at all — what every cookie issued before F-L37
 *                  carries, which getLiteSession() also treats as expired.
 */
export async function mintLiteSession(user, epoch, sessionId = randomUUID(), issuedAt = Date.now()) {
  const { password, name } = await resolveCookie(user);
  const data = { user: sessionUserFor(user), sessionEpoch: epoch };
  if (sessionId) data.sessionId = sessionId;
  if (issuedAt !== null) data.sessionIssuedAt = issuedAt;
  const sealed = await sealData(data, { password, ttl: 60 * 60 * 24 * 14 });
  return { sealed, sessionId, cookieName: name };
}

/**
 * Resolve `{ password, name }` once — the SAME secret/cookie-name discovery
 * `mintLiteSession` uses (and caches, module-wide, in `RESOLVED`), exposed
 * directly so a caller can seal a DIFFERENTLY-SHAPED payload (a full-Hive
 * session, below) through the identical, server-verified secret. The probe
 * is a throwaway LITE-shaped session; `resolveCookie` only needs the server
 * to unseal it and echo the display name back, never a matching DB row, so
 * this touches no table and mints no real account.
 */
export async function resolveSessionSecret() {
  return resolveCookie({ userId: 'qa-secret-probe', displayName: `qa-secret-probe-${randomUUID()}` });
}

/**
 * Seal a FULL-HIVE iron-session cookie — byte-for-byte the shape
 * `packages/smart-signer/lib/api-handlers/auth/login.ts` writes at
 * `session.user = user; await session.save();` (see that file, ~line 149:
 * `isLoggedIn, username, avatarUrl, loginType, keyType, authenticateOnBackend,
 * chatAuthToken, oauthConsent, strict` — and, notably, NO `account_tier` key
 * at all; a real Hive login never sets one). This harness cannot drive Hive
 * Keychain (a browser extension), so for tests that only need the SERVER-SIDE
 * session shape — not a genuine signature — this seals the cookie directly,
 * the same trick `mintLiteSession` already uses for the lite tier.
 *
 * @param username           Hive account name to appear as.
 * @param hiveSessionIssuedAt epoch-ms for the F-L38 (2026-08-11) Hive TTL
 *   stamp `hiveSessionIssuedAt`. Omit (or pass `undefined`) to mint a cookie
 *   with NO stamp at all — what every real Hive cookie carries today, since
 *   `login.ts` was out of scope to edit and getLiteSession() only backfills
 *   this field on READ. Pass an old timestamp (e.g. `Date.now() -
 *   15*86400000`) to mint an over-TTL session for the expiry proof.
 */
export async function mintHiveSession(username, hiveSessionIssuedAt) {
  const { password, name } = await resolveSessionSecret();
  const user = {
    isLoggedIn: true,
    username,
    avatarUrl: '',
    loginType: 'keychain',
    keyType: 'posting',
    authenticateOnBackend: false,
    chatAuthToken: '',
    oauthConsent: {},
    strict: false
  };
  const data = { user };
  if (hiveSessionIssuedAt !== undefined) data.hiveSessionIssuedAt = hiveSessionIssuedAt;
  const sealed = await sealData(data, { password, ttl: 60 * 60 * 24 * 14 });
  return { sealed, cookieName: name };
}

/** Issue a request carrying one sealed session cookie. */
export function call(path, session, init = {}) {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      cookie: `${session.cookieName}=${session.sealed}`,
      'x-csrf-token': '1',
      'content-type': 'application/json',
      ...(init.headers || {})
    }
  });
}

/**
 * Create (or reuse) a disposable lite account and reset it to a known state.
 *
 * ★ The INSERT and the read-back are deliberately two statements. `psql -t -A`
 * still prints the command tag ("INSERT 0 1") after a RETURNING row, so doing it
 * in one call yields "<id>\nINSERT 0 1" as the user id — which seals into a
 * cookie for a user that does not exist, every route answers 401, and the whole
 * suite fails in a way that reads exactly like the bug under test.
 */
export function ensureTestUser(displayName, userId) {
  psql(
    `INSERT INTO lumen_user (user_id, display_name) VALUES ('${userId}','${displayName}')
       ON CONFLICT (display_name) DO NOTHING`
  );
  const id = psql(`SELECT user_id FROM lumen_user WHERE display_name='${displayName}'`);
  if (!id || id.includes('\n')) throw new Error(`could not resolve a single user_id: ${JSON.stringify(id)}`);
  psql(`UPDATE lumen_user SET session_epoch=0, status='active' WHERE user_id='${id}'`);
  return { userId: id, displayName };
}

export function epochOf(userId) {
  return Number(psql(`SELECT session_epoch FROM lumen_user WHERE user_id='${userId}'`));
}

/**
 * Forget every per-device revocation for one account. Written to survive the
 * table not existing yet, so the same script can be run against the tree BEFORE
 * the migration to reproduce the bug and AFTER it to prove the fix.
 */
export function clearRevocations(userId) {
  psql(
    `DO $$ BEGIN IF to_regclass('public.lumen_revoked_session') IS NOT NULL THEN ` +
      `DELETE FROM lumen_revoked_session WHERE user_id='${userId}'; END IF; END $$;`
  );
}

/* ------------------------------------------------------------------ reporting */

let failures = 0;
let checks = 0;

export function ok(condition, name, evidence) {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}\n          ${evidence}`);
}

export function summary(label) {
  console.log(`\n${label}: ${checks - failures}/${checks} passed`);
  if (failures) {
    console.log(`${failures} FAILING CHECK(S)`);
    process.exitCode = 1;
  }
  return failures;
}
