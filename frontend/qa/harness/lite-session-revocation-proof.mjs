/**
 * PROOF: signing out ONE device signs out ONE device, and a captured cookie is
 * not a lockout weapon.
 *
 *   node qa/harness/lite-session-revocation-proof.mjs
 *
 * Needs the app running (QA_BASE, default http://localhost:3000) and the QA
 * Postgres container `lumen-b12-pg`.
 *
 * ★ THE POINT OF THE THIRD SESSION. A sign-out test driven from the device that
 * signed out proves nothing — that device's cookie is gone either way. The
 * question is what happened to everyone ELSE, so this holds three cookies for one
 * account (laptop / phone / tablet) and asks the SERVER about each after every
 * step. A "log out everywhere" that quietly logged out one device, and a "log out
 * here" that quietly logged out all three, are indistinguishable without them.
 *
 * WHAT IS PROVEN
 *   1. Three concurrent sessions for one account all act.
 *   2. Device sign-out revokes ONLY the calling session — the other two keep
 *      working — and does NOT advance the account-wide `session_epoch`.
 *   3. The signed-out cookie itself is dead server-side, so a COPY of it captured
 *      beforehand cannot act either. (This is the property the 2026-08-06
 *      epoch-bump bought, and it is kept without the collateral damage.)
 *   4. `logout-all` still revokes EVERYTHING: the epoch advances and every
 *      remaining session is refused.
 *   5. A stale cookie — one that 401s on a normal route — is refused by BOTH
 *      logout routes and advances nothing. Before this build it returned 200 and
 *      bumped the epoch, which killed the victim's freshly re-authenticated
 *      session and could be replayed forever.
 *   6. A LEGACY cookie (issued before per-device ids existed, carrying no
 *      `sessionId`) still signs out — it falls back to the account-wide bump,
 *      because there is no id to revoke.
 */

import {
  BASE,
  call,
  clearRevocations,
  ensureTestUser,
  epochOf,
  mintLiteSession,
  ok,
  psql,
  summary
} from './lite-session.mjs';

const NAME = 'qarevoke1';
const user = ensureTestUser(NAME, '01KZQAREVOKE00000000000001');
clearRevocations(user.userId);
console.log(`base=${BASE}  user=${NAME} (${user.userId})  epoch=${epochOf(user.userId)}\n`);

const acts = async (session) => (await call('/api/lite/profile', session)).status;

/* ------------------------------------------------------ 1. three live sessions */
console.log('1. three concurrent sessions for one account');
const laptop = await mintLiteSession(user, 0);
const phone = await mintLiteSession(user, 0);
const tablet = await mintLiteSession(user, 0);
ok((await acts(laptop)) === 200, 'laptop acts', `GET /api/lite/profile -> ${await acts(laptop)}`);
ok((await acts(phone)) === 200, 'phone acts', `GET /api/lite/profile -> ${await acts(phone)}`);
ok((await acts(tablet)) === 200, 'tablet acts', `GET /api/lite/profile -> ${await acts(tablet)}`);

/* ------------------------------------- 2 + 3. sign out ON THE PHONE, only */
console.log('\n2. the phone signs out — one device, not the account');
const epochBefore = epochOf(user.userId);
const out = await call('/api/lite/auth/logout', phone, { method: 'POST' });
const outBody = await out.json();
ok(out.status === 200, 'phone POST /api/lite/auth/logout -> 200', JSON.stringify(outBody));

const epochAfter = epochOf(user.userId);
ok(
  epochAfter === epochBefore,
  'the account-wide session_epoch did NOT move',
  `session_epoch ${epochBefore} -> ${epochAfter} (a per-device action must not revoke the account)`
);

const laptopAfter = await acts(laptop);
const tabletAfter = await acts(tablet);
ok(laptopAfter === 200, 'laptop STILL signed in', `GET /api/lite/profile -> ${laptopAfter}`);
ok(tabletAfter === 200, 'tablet STILL signed in', `GET /api/lite/profile -> ${tabletAfter}`);

console.log('\n3. the signed-out cookie is dead server-side (a captured copy cannot act)');
const phoneAfter = await acts(phone);
ok(phoneAfter === 401, "the phone's own cookie is refused", `GET /api/lite/profile -> ${phoneAfter}`);
const phoneWrite = await call('/api/lite/interests', phone, {
  method: 'POST',
  body: JSON.stringify({ interests: ['art'] })
});
ok(
  phoneWrite.status === 401 || phoneWrite.status === 403,
  'the revoked cookie cannot WRITE either',
  `POST /api/lite/interests -> ${phoneWrite.status} ${JSON.stringify(await phoneWrite.json())}`
);

/* --------------------------------------------- 5. the stale-cookie weapon */
console.log('\n4. a stale cookie cannot advance the epoch on EITHER logout route');
// The victim revokes (epoch 0 -> 1) and signs back in; the attacker still holds a
// copy of the old cookie. Before this build, replaying it here bumped the epoch
// and killed the brand-new session — repeatably, forever.
psql(`UPDATE lumen_user SET session_epoch=1 WHERE user_id='${user.userId}'`);
const stale = await mintLiteSession(user, 0);
const reauthed = await mintLiteSession(user, 1);
ok((await acts(stale)) === 401, 'the stale cookie is refused on a normal route', `-> ${await acts(stale)}`);

let before = epochOf(user.userId);
let res = await call('/api/lite/auth/logout', stale, { method: 'POST' });
let after = epochOf(user.userId);
ok(res.status === 401, 'stale cookie POST /api/lite/auth/logout -> 401', JSON.stringify(await res.json()));
ok(after === before, 'it advanced nothing', `session_epoch ${before} -> ${after}`);

before = after;
res = await call('/api/lite/auth/logout-all', stale, { method: 'POST' });
after = epochOf(user.userId);
ok(res.status === 401, 'stale cookie POST /api/lite/auth/logout-all -> 401', JSON.stringify(await res.json()));
ok(after === before, 'it advanced nothing', `session_epoch ${before} -> ${after}`);

ok(
  (await acts(reauthed)) === 200,
  'the re-authenticated session SURVIVED the replay',
  `GET /api/lite/profile -> ${await acts(reauthed)}`
);

/* --------------------------------------------------- 4. logout-all still works */
console.log('\n5. logout-all still revokes every device');
psql(`UPDATE lumen_user SET session_epoch=0 WHERE user_id='${user.userId}'`);
const deskA = await mintLiteSession(user, 0);
const deskB = await mintLiteSession(user, 0);
const deskC = await mintLiteSession(user, 0);
ok(
  (await acts(deskA)) === 200 && (await acts(deskB)) === 200 && (await acts(deskC)) === 200,
  'three fresh sessions act',
  `${await acts(deskA)}/${await acts(deskB)}/${await acts(deskC)}`
);
before = epochOf(user.userId);
res = await call('/api/lite/auth/logout-all', deskA, { method: 'POST' });
after = epochOf(user.userId);
ok(res.status === 200, 'deskA POST /api/lite/auth/logout-all -> 200', JSON.stringify(await res.json()));
ok(after === before + 1, 'the account-wide epoch DID advance', `session_epoch ${before} -> ${after}`);
const [a, b, c] = [await acts(deskA), await acts(deskB), await acts(deskC)];
ok(a === 401 && b === 401 && c === 401, 'all three devices are signed out', `${a}/${b}/${c}`);

/* -------------------------------------------------------- 6. legacy cookies */
console.log('\n6. a legacy cookie (no per-device id) still signs out');
psql(`UPDATE lumen_user SET session_epoch=0 WHERE user_id='${user.userId}'`);
const legacy = await mintLiteSession(user, 0, null);
const alsoLegacy = await mintLiteSession(user, 0, null);
ok((await acts(legacy)) === 200, 'a legacy cookie still acts (nobody is signed out by this build)', `-> ${await acts(legacy)}`);
before = epochOf(user.userId);
res = await call('/api/lite/auth/logout', legacy, { method: 'POST' });
after = epochOf(user.userId);
ok(res.status === 200, 'legacy POST /api/lite/auth/logout -> 200', JSON.stringify(await res.json()));
ok(
  after === before + 1,
  'with no id to revoke it falls back to the account-wide bump',
  `session_epoch ${before} -> ${after} — the honest answer for a cookie that predates per-device ids`
);
ok((await acts(alsoLegacy)) === 401, 'so the other legacy session goes too (unavoidable, and it self-heals as cookies rotate)', `-> ${await acts(alsoLegacy)}`);

psql(`UPDATE lumen_user SET session_epoch=0 WHERE user_id='${user.userId}'`);
clearRevocations(user.userId);
psql(`DELETE FROM lumen_hive_reader_prefs WHERE hive_account='${NAME}'`);
summary('lite-session-revocation-proof');
