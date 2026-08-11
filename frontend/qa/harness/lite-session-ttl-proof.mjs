/**
 * PROOF (F-L37, 2026-08-11): the server-enforced lite session TTL, restored
 * after J6 traded it away.
 *
 *   QA_BASE=http://127.0.0.1:3000 node qa/harness/lite-session-ttl-proof.mjs
 *
 * BACKGROUND. J6 made getLiteSession() issue a true browser-session cookie
 * (`cookieOptions.maxAge: undefined`), per the owner's "close the browser, get
 * logged out" requirement. As a side effect, iron-session 8.0.4 forces its
 * internal seal `ttl` to 0 whenever that flag is used, so the sealed cookie
 * VALUE stopped carrying any expiry at all — a leaked cookie STRING (not tied
 * to any browser session) would have been valid forever, bounded only by
 * session_epoch / per-device revocation, neither of which fires on the mere
 * passage of time.
 *
 * WHAT IS PROVEN
 *   1. A FRESH session (issued now) is accepted.
 *   2. A session stamped older than `sessionTtlDays` (14) is refused (401) —
 *      exactly as if the cookie were absent — and one stamped 1 minute INSIDE
 *      the boundary still works, so this is a real TTL check, not a hair-
 *      trigger or an always-refuse bug in disguise.
 *   3. A LEGACY session — no `sessionIssuedAt` at all, which is every lite
 *      cookie that was live before this fix — is ALSO refused. Deliberate
 *      choice, see getLiteSession()'s LEGACY POLICY comment: the alternative
 *      (grandfather them in) would leave every cookie already issued, and any
 *      already leaked, exactly as immortal as before this fix.
 *   4. The check lives in ONE place (getLiteSession()) and every route
 *      inherits it for free — proven here across TWO unrelated routes
 *      (`/api/lite/profile` and `/api/lite/auth/methods`) with the SAME
 *      expired cookie, no route-level code involved in either.
 *   5. A REAL login (genuine EIP-191 signature from a throwaway EVM key, real
 *      signup) still receives a Set-Cookie with NEITHER `Max-Age` NOR
 *      `Expires` — the F-L3/J6 browser-close behaviour has not regressed.
 */
import {
  BASE,
  call,
  ensureTestUser,
  mintLiteSession,
  ok,
  psql,
  summary
} from './lite-session.mjs';
import { privateKeyToAccount } from 'viem/accounts';
import { randomBytes } from 'node:crypto';

const TTL_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/* ============================================================ 1-4: harness-minted sessions */

const NAME = 'j6ttlqa1';
const user = ensureTestUser(NAME, '01KZQATTLPROOF0000000000J6');
console.log(`base=${BASE}  harness user=${NAME} (${user.userId})\n`);

const acts = async (session) => (await call('/api/lite/profile', session)).status;

console.log('1. a FRESH session (sessionIssuedAt = now, the harness default) is accepted');
const fresh = await mintLiteSession(user, 0);
const freshStatus = await acts(fresh);
ok(freshStatus === 200, 'fresh session -> GET /api/lite/profile', `-> ${freshStatus}`);

console.log('\n2. TTL boundary: 1 minute past 14 days is refused, 1 minute inside is not');
const tooOld = Date.now() - (TTL_DAYS * DAY_MS + 60_000);
const expired = await mintLiteSession(user, 0, undefined, tooOld);
const expiredStatus = await acts(expired);
ok(
  expiredStatus === 401,
  'session stamped 14d+1min ago -> GET /api/lite/profile',
  `issuedAt=${new Date(tooOld).toISOString()} -> ${expiredStatus}`
);

const justInside = Date.now() - (TTL_DAYS * DAY_MS - 60_000);
const stillValid = await mintLiteSession(user, 0, undefined, justInside);
const stillValidStatus = await acts(stillValid);
ok(
  stillValidStatus === 200,
  'session stamped 14d-1min ago (still inside TTL) -> GET /api/lite/profile',
  `issuedAt=${new Date(justInside).toISOString()} -> ${stillValidStatus}`
);

console.log('\n3. a LEGACY session (no sessionIssuedAt at all) is refused, not grandfathered in');
const legacy = await mintLiteSession(user, 0, undefined, null);
const legacyStatus = await acts(legacy);
ok(
  legacyStatus === 401,
  'legacy (pre-F-L37) session -> GET /api/lite/profile',
  `-> ${legacyStatus} (every lite cookie issued before this fix looks exactly like this)`
);

console.log('\n4. the SAME expired cookie is refused on a SECOND, unrelated route with zero route-level code');
const methodsResp = await call('/api/lite/auth/methods', expired);
ok(
  methodsResp.status === 401,
  'expired session -> GET /api/lite/auth/methods (never touched by this fix)',
  `-> ${methodsResp.status}`
);

/* ============================================================ 5: real login, real Set-Cookie */

console.log('\n5. a REAL login (genuine EIP-191 signature) still gets a true session cookie');

function jarFrom(res, jar = {}) {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    jar[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return jar;
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

async function post(path, jar, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': '1',
      ...(Object.keys(jar).length ? { cookie: cookieHeader(jar) } : {})
    },
    body: JSON.stringify(body)
  });
  return res;
}

const privateKey = `0x${randomBytes(32).toString('hex')}`;
const account = privateKeyToAccount(privateKey);
const displayName = 'j6ttl' + Date.now().toString(36).slice(-8);
let jar = {};
let realLoginNote = '';
let sessionSetCookieLine = null;

try {
  const challengeRes = await post('/api/lite/auth/evm/challenge', jar, { address: account.address });
  jar = jarFrom(challengeRes, jar);
  const challenge = await challengeRes.json();
  if (!challenge?.nonce || typeof challenge.message !== 'string') {
    throw new Error(`no challenge issued: ${JSON.stringify(challenge)}`);
  }

  const signature = await account.signMessage({ message: challenge.message });

  const verifyRes = await post('/api/lite/auth/evm/verify', jar, {
    address: account.address,
    signature,
    nonce: challenge.nonce
  });
  jar = jarFrom(verifyRes, jar);
  const verify = await verifyRes.json();

  if (verify?.status === 'needs_name') {
    const nameRes = await post('/api/lite/auth/name', jar, {
      displayName,
      captchaToken: 'qa-dummy-token'
    });
    jar = jarFrom(nameRes, jar);
    const named = await nameRes.json();
    if (named?.status !== 'ok' || !named?.user?.username) {
      throw new Error(`signup did not complete: ${JSON.stringify(named)}`);
    }
    realLoginNote = `challenge -> verify (needs_name) -> name -> user=${named.user.username}`;
    sessionSetCookieLine = nameRes.headers.getSetCookie().find((l) => !l.toLowerCase().startsWith('account_info='));
  } else if (verify?.status === 'authenticated') {
    realLoginNote = `challenge -> verify (authenticated immediately) -> user=${verify.user?.username}`;
    sessionSetCookieLine = verifyRes.headers.getSetCookie().find((l) => !l.toLowerCase().startsWith('account_info='));
  } else {
    throw new Error(`unexpected verify result: ${JSON.stringify(verify)}`);
  }

  ok(!!sessionSetCookieLine, 'real login produced a session Set-Cookie', realLoginNote);
  if (sessionSetCookieLine) {
    const lower = sessionSetCookieLine.toLowerCase();
    ok(
      !lower.includes('max-age='),
      'that Set-Cookie has NO Max-Age',
      sessionSetCookieLine
    );
    ok(
      !lower.includes('expires='),
      'that Set-Cookie has NO Expires',
      sessionSetCookieLine
    );
  }
} catch (error) {
  ok(false, 'real EVM login flow completed', String(error && error.message ? error.message : error));
}

/* ============================================================ cleanup */

console.log('\ncleanup');
psql(`DELETE FROM lumen_hive_reader_prefs WHERE hive_account='${NAME}'`);
psql(`DELETE FROM lumen_credential_audit WHERE user_id='${user.userId}'`);
psql(`DELETE FROM lumen_auth_credential WHERE user_id='${user.userId}'`);
psql(`DELETE FROM lumen_user WHERE user_id='${user.userId}'`);

const realUserId = psql(`SELECT user_id FROM lumen_user WHERE display_name='${displayName}'`);
if (realUserId && !realUserId.includes('\n')) {
  psql(`DELETE FROM lumen_credential_audit WHERE user_id='${realUserId}'`);
  psql(`DELETE FROM lumen_auth_credential WHERE user_id='${realUserId}'`);
  psql(`DELETE FROM lumen_user WHERE user_id='${realUserId}'`);
}

const residueHarness = psql(`SELECT count(*) FROM lumen_user WHERE display_name='${NAME}'`);
const residueReal = psql(`SELECT count(*) FROM lumen_user WHERE display_name='${displayName}'`);
console.log(`residue check: lumen_user rows for '${NAME}' = ${residueHarness}, for '${displayName}' = ${residueReal}`);
ok(residueHarness === '0', 'harness test user fully removed from lumen_user', `count=${residueHarness}`);
ok(residueReal === '0', 'real-login test user fully removed from lumen_user', `count=${residueReal}`);

summary('lite-session-ttl-proof');
