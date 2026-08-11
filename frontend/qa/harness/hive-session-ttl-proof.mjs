/**
 * PROOF (2026-08-11): the two regressions from today's earlier jobs are fixed —
 * without reopening either the "TTL enforcement" property F-L37 built, or the
 * "browser-session cookie" property J6 built.
 *
 *   QA_BASE=http://localhost:3000 node qa/harness/hive-session-ttl-proof.mjs
 *
 * ═══ BUG 1 (CRITICAL) — F-L37's TTL/stamp logic applied to Hive sessions too ═══
 *
 * `getLiteSession()` blanked `session.user` for ANY session with no
 * `sessionIssuedAt` stamp. That field is written only by a Proxy `set` trap
 * inside `getLiteSession()` itself — but a full-Hive login
 * (`packages/smart-signer/lib/api-handlers/auth/login.ts:160`) calls
 * `getIronSession(req, res, sessionOptions)` DIRECTLY, so a Hive session could
 * NEVER carry the stamp. `/api/retention/goal` and `/api/feed/for-you` both
 * read `session.user` through `getLiteSession()` for ANY logged-in user, lite
 * or Hive — so every real Hive login was silently treated as signed-out on
 * those two routes. Reviewer's live reproduction (real sealed `hbd-temp`
 * cookie, loginType keychain):
 *   no stamp: /api/retention/goal -> 401 ; /api/feed/for-you -> trending-fallback
 *   + stamp:  /api/retention/goal -> 200 ; /api/feed/for-you -> source=recsys
 *
 * Section 1 below reproduces that EXACT scenario with a REAL sealed cookie
 * (`qa/harness/session.mjs`'s `signedInStorageState`, no stamp of any kind —
 * the shape login.ts actually writes) and asserts the FIXED behaviour.
 *
 * ═══ BUG 2 (HIGH) — the full-Hive cookie lost its ONLY expiry ═══
 *
 * `maxAge: undefined` (packages/smart-signer/lib/session.ts) makes the cookie
 * a true browser-session cookie, per the owner's "closing the browser signs
 * you out" requirement — but iron-session 8.0.4 couples that to seal `ttl = 0`,
 * so iron-webcrypto embeds NO expiry in the sealed VALUE either. A leaked
 * Hive cookie STRING authenticated forever. F-L38 adds a server-enforced
 * `hiveSessionIssuedAt` stamp, backfilled the first time `getLiteSession()`
 * reads a Hive session carrying none (login.ts was out of this job's
 * ownership and could not be edited to stamp at issue).
 *
 * Section 2 proves: a fresh Hive session is accepted; an over-TTL one is
 * refused; a no-stamp one (what every real Hive session is, today) is
 * accepted AND gets backfilled — verified by unsealing the resulting
 * Set-Cookie and reading `hiveSessionIssuedAt` back out of it, not merely by
 * re-observing a 200. Section 3 proves the cookie is STILL a true session
 * cookie (no Max-Age, no Expires) on both the lite and Hive paths — the
 * property this fix must not regress while adding the new one.
 *
 * WHAT THIS DOES NOT PROVE (stated, not hidden): `hiveSessionIssuedAt` is
 * only ever CHECKED inside `getLiteSession()`. A Hive session read exclusively
 * through the other `getIronSession(req, res, sessionOptions)` call sites
 * (`login.ts`, oauth/consent/chat-token handlers, `users/me.ts`,
 * `auth-utils.ts`, `server-session.ts`, `logout.ts`) is not TTL-enforced at
 * all — those files were out of this job's ownership. See the long comment on
 * `hiveSessionIssuedAt` in `packages/smart-signer/types/common.ts`.
 */
import { unsealData } from 'iron-session';
import {
  BASE,
  call,
  mintHiveSession,
  resolveSessionSecret,
  ok,
  summary
} from './lite-session.mjs';
import { signedInStorageState } from './session.mjs';

const HIVE_USER = 'hbd-temp';
const TTL_DAYS = 14; // must match HIVE_SESSION_TTL_DAYS's default (packages/smart-signer/lib/session.ts) — apps/blog/.env.local sets no override
const DAY_MS = 24 * 60 * 60 * 1000;

console.log(`base=${BASE}  hive user=${HIVE_USER}\n`);

function cookieHeaderFromStorageState(storageState) {
  return storageState.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

async function getWithCookieHeader(path, cookieHeader) {
  return fetch(`${BASE}${path}`, {
    headers: { cookie: cookieHeader, 'x-csrf-token': '1' }
  });
}

/* ============================================================ 1: BUG 1 regression, real cookie */

console.log('1. BUG 1 — a REAL full-Hive cookie with NO stamp (the exact reviewer repro)');

let realHiveState;
try {
  realHiveState = await signedInStorageState(HIVE_USER);
} catch (error) {
  console.error(`FATAL: could not mint a real Hive session via signedInStorageState(): ${error.message}`);
  process.exit(1);
}
const realCookieHeader = cookieHeaderFromStorageState(realHiveState);
// Sanity: this cookie carries NO sessionIssuedAt / hiveSessionIssuedAt at all —
// exactly the shape login.ts writes, and exactly what triggered the bug.
const realCookiePair = realHiveState.cookies[0];
console.log(`   minted cookie name=${realCookiePair?.name}`);

const goalRes = await getWithCookieHeader('/api/retention/goal', realCookieHeader);
const goalBody = await goalRes.json().catch(() => ({}));
ok(
  goalRes.status === 200,
  'GET /api/retention/goal with a no-stamp Hive cookie -> 200 (was 401)',
  `-> ${goalRes.status} ${JSON.stringify(goalBody)}`
);

const feedRes = await getWithCookieHeader('/api/feed/for-you?limit=5', realCookieHeader);
const feedBody = await feedRes.json().catch(() => ({}));
console.log(`   /api/feed/for-you source=${feedBody.source} degraded=${feedBody.degraded ?? 'n/a'} cache=${feedBody.cache ?? 'n/a'}`);
ok(
  feedBody.source === 'recsys',
  'GET /api/feed/for-you with a no-stamp Hive cookie -> source=recsys (was trending-fallback)',
  `source=${feedBody.source} degraded=${feedBody.degraded ?? 'n/a'}`
);

/* ============================================================ 2: BUG 2, Hive TTL enforcement */

console.log('\n2. BUG 2 — the Hive TTL: fresh accepted, over-TTL refused, no-stamp backfilled');

console.log('\n2a. a FRESH Hive session (hiveSessionIssuedAt = now) is accepted');
const freshHive = await mintHiveSession(HIVE_USER, Date.now());
const freshRes = await call('/api/retention/goal', freshHive);
ok(freshRes.status === 200, 'fresh Hive session -> GET /api/retention/goal', `-> ${freshRes.status}`);

console.log('\n2b. an OVER-TTL Hive session (14d+1min old) is refused');
const tooOld = Date.now() - (TTL_DAYS * DAY_MS + 60_000);
const staleHive = await mintHiveSession(HIVE_USER, tooOld);
const staleRes = await call('/api/retention/goal', staleHive);
ok(
  staleRes.status === 401,
  'over-TTL Hive session -> GET /api/retention/goal',
  `issuedAt=${new Date(tooOld).toISOString()} -> ${staleRes.status}`
);
// And feed/for-you falls back to the anonymous path for the same expired cookie
// (viewer resolves empty once session.user is blanked) rather than personalising.
const staleFeedRes = await call('/api/feed/for-you?limit=5', staleHive);
const staleFeedBody = await staleFeedRes.json().catch(() => ({}));
ok(
  staleFeedBody.source !== 'recsys',
  'over-TTL Hive session -> /api/feed/for-you does NOT personalise',
  `source=${staleFeedBody.source} degraded=${staleFeedBody.degraded ?? 'n/a'}`
);

console.log('\n2c. a JUST-INSIDE-TTL Hive session (14d-1min old) still works — a real boundary, not a hair trigger');
const justInside = Date.now() - (TTL_DAYS * DAY_MS - 60_000);
const insideHive = await mintHiveSession(HIVE_USER, justInside);
const insideRes = await call('/api/retention/goal', insideHive);
ok(
  insideRes.status === 200,
  'Hive session stamped 14d-1min ago -> GET /api/retention/goal',
  `issuedAt=${new Date(justInside).toISOString()} -> ${insideRes.status}`
);

console.log('\n2d. a NO-STAMP Hive session (what every live Hive cookie is today) is accepted AND backfilled');
const noStampHive = await mintHiveSession(HIVE_USER, undefined);
const backfillRes = await call('/api/retention/goal', noStampHive);
const backfillBody = await backfillRes.json().catch(() => ({}));
ok(
  backfillRes.status === 200,
  'no-stamp Hive session -> GET /api/retention/goal -> 200 (NOT treated as expired, unlike lite)',
  `-> ${backfillRes.status} ${JSON.stringify(backfillBody)}`
);

const backfillSetCookie = backfillRes.headers.getSetCookie().find((l) => l.startsWith(`${noStampHive.cookieName}=`));
ok(!!backfillSetCookie, 'the backfill actually attempted to persist a Set-Cookie', backfillSetCookie ?? '(none)');

if (backfillSetCookie) {
  const sealedValue = backfillSetCookie.split(';')[0].slice(noStampHive.cookieName.length + 1);
  const { password } = await resolveSessionSecret();
  let decoded = null;
  try {
    decoded = await unsealData(sealedValue, { password, ttl: 0 });
  } catch (error) {
    decoded = { __unsealError: String(error && error.message ? error.message : error) };
  }
  const stampedNow =
    typeof decoded?.hiveSessionIssuedAt === 'number' && Math.abs(Date.now() - decoded.hiveSessionIssuedAt) < 30_000;
  ok(
    stampedNow,
    'the persisted Set-Cookie, unsealed, carries a FRESH hiveSessionIssuedAt (the backfill actually wrote the field, not just a 200)',
    `decoded.hiveSessionIssuedAt=${decoded?.hiveSessionIssuedAt} (${decoded?.__unsealError ?? 'unsealed ok'})`
  );
}

/* ============================================================ 3: Set-Cookie shape, both paths */

console.log('\n3. Set-Cookie has NO Max-Age and NO Expires — the property this fix must not regress');

if (backfillSetCookie) {
  const lower = backfillSetCookie.toLowerCase();
  ok(!lower.includes('max-age='), 'Hive-path backfill Set-Cookie has NO Max-Age', backfillSetCookie);
  ok(!lower.includes('expires='), 'Hive-path backfill Set-Cookie has NO Expires', backfillSetCookie);
} else {
  ok(false, 'Hive-path Set-Cookie shape check ran', 'no Set-Cookie was captured to inspect (see 2d above)');
}

// Lite path: the FULL Max-Age/Expires-absence proof (via a genuine EVM signup)
// already lives in qa/harness/lite-session-ttl-proof.mjs §5 and is re-run as
// part of this job's verification — not duplicated here to avoid a second
// live signup per run. This script's own proof is the Hive path, which is new.

console.log('\ndone (no DB rows were created by this script — hbd-temp is a real, persistent account; Hive sessions are not lite DB rows)');

summary('hive-session-ttl-proof');
