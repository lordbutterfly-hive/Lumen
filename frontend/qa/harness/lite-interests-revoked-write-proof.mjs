/**
 * PROOF: a revoked / suspended / banned lite session cannot write interests, and
 * a lite handle never lands in the HIVE-reader table.
 *
 *   node qa/harness/lite-interests-revoked-write-proof.mjs
 *
 * Needs the app running (QA_BASE, default http://localhost:3000) and the QA
 * Postgres container `lumen-b12-pg`.
 *
 * ★ THE BUG THIS PINS DOWN. `/api/lite/interests` asked `requireActiveLiteUser`
 * whether the caller could act, and then — if the answer was NO — carried on into
 * the branch written for Hive readers, which is gated on nothing but
 * `session.user.username` being present. So the auth check was decorative: a
 * cookie that 401s on `/api/lite/profile` returned 200 here and wrote a row.
 *
 * It also wrote it under the WRONG KEY. `session.user.username` for a lite
 * account is their Lumen display name, so the picks were filed in
 * `lumen_hive_reader_prefs` — the table keyed by Hive account name. The ranker
 * reads a lite user's interests from `lumen_user`, so the row the UI wrote is not
 * the row anything reads, and if a real Hive account is ever registered under
 * that name it inherits a stranger's preferences.
 *
 * WHAT IS PROVEN
 *   1. A revoked lite session (stale epoch) is refused by POST and writes nothing
 *      — to either table.
 *   2. A suspended and a banned lite session are refused too.
 *   3. GET does not leak the same way: a revoked lite session is not served the
 *      Hive-reader row for its own display name.
 *   4. A VALID lite session still saves normally, into `lumen_user.interests`,
 *      and never into `lumen_hive_reader_prefs`. (Without this the fix could be
 *      "refuse everyone", which would pass 1-3 and break the product.)
 */

import { call, ensureTestUser, mintLiteSession, ok, psql, summary } from './lite-session.mjs';

const NAME = 'qaintrst1';
const user = ensureTestUser(NAME, '01KZQAINTEREST00000000001');

const clean = () => {
  psql(`DELETE FROM lumen_hive_reader_prefs WHERE hive_account='${NAME}'`);
  psql(`UPDATE lumen_user SET interests='[]'::jsonb, interests_set_at=NULL WHERE user_id='${user.userId}'`);
};
const hiveRow = () =>
  psql(`SELECT interests::text FROM lumen_hive_reader_prefs WHERE hive_account='${NAME}'`);
const liteRow = () => psql(`SELECT interests::text FROM lumen_user WHERE user_id='${user.userId}'`);

const save = (session, picks) =>
  call('/api/lite/interests', session, { method: 'POST', body: JSON.stringify({ interests: picks }) });

console.log(`user=${NAME} (${user.userId})\n`);

/* ------------------------------------------------------------ 1. revoked */
console.log('1. a revoked session (stale epoch) cannot write');
clean();
psql(`UPDATE lumen_user SET session_epoch=5 WHERE user_id='${user.userId}'`);
const revoked = await mintLiteSession(user, 0);

const probe = await call('/api/lite/profile', revoked);
ok(probe.status === 401, 'the same cookie is refused by /api/lite/profile', `-> ${probe.status}`);

let res = await save(revoked, ['art', 'poetry']);
let body = await res.json();
ok(res.status === 401 || res.status === 403, 'POST /api/lite/interests refuses it', `-> ${res.status} ${JSON.stringify(body)}`);
ok(hiveRow() === '', 'nothing was written to lumen_hive_reader_prefs', `row=${JSON.stringify(hiveRow())}`);
ok(liteRow() === '[]', 'nothing was written to lumen_user.interests', `interests=${liteRow()}`);

/* ------------------------------------------------- 2. suspended / banned */
console.log('\n2. a suspended and a banned session cannot write either');
for (const status of ['suspended', 'banned']) {
  clean();
  psql(`UPDATE lumen_user SET session_epoch=0, status='${status}' WHERE user_id='${user.userId}'`);
  const session = await mintLiteSession(user, 0);
  res = await save(session, ['art']);
  body = await res.json();
  ok(
    res.status === 401 || res.status === 403,
    `a ${status} account is refused`,
    `-> ${res.status} ${JSON.stringify(body)}`
  );
  ok(hiveRow() === '', `${status}: lumen_hive_reader_prefs untouched`, `row=${JSON.stringify(hiveRow())}`);
  ok(liteRow() === '[]', `${status}: lumen_user.interests untouched`, `interests=${liteRow()}`);
}
psql(`UPDATE lumen_user SET status='active' WHERE user_id='${user.userId}'`);

/* --------------------------------------------------------------- 3. GET */
console.log('\n3. GET does not read a lite handle out of the Hive-reader table');
clean();
// Plant a row under the lite user's DISPLAY NAME, as the buggy POST used to.
psql(
  `INSERT INTO lumen_hive_reader_prefs (hive_account, interests, interests_set_at)
     VALUES ('${NAME}', '["politics"]'::jsonb, now())
     ON CONFLICT (hive_account) DO UPDATE SET interests = EXCLUDED.interests`
);
psql(`UPDATE lumen_user SET session_epoch=7 WHERE user_id='${user.userId}'`);
const revokedGet = await mintLiteSession(user, 0);
res = await call('/api/lite/interests', revokedGet);
body = await res.json();
ok(
  !JSON.stringify(body.selected ?? []).includes('politics'),
  'a revoked lite session is not served the Hive-reader row for its own name',
  `selected=${JSON.stringify(body.selected)} eligible=${body.eligible}`
);
psql(`DELETE FROM lumen_hive_reader_prefs WHERE hive_account='${NAME}'`);

/* ---------------------------------------------------- 4. the happy path */
console.log('\n4. a valid lite session still saves — into the right table');
clean();
psql(`UPDATE lumen_user SET session_epoch=0 WHERE user_id='${user.userId}'`);
const good = await mintLiteSession(user, 0);
res = await save(good, ['art', 'poetry']);
body = await res.json();
ok(res.status === 200, 'POST /api/lite/interests -> 200', JSON.stringify(body));
ok(liteRow().includes('poetry'), 'saved to lumen_user.interests', `interests=${liteRow()}`);
ok(hiveRow() === '', 'and NOT to lumen_hive_reader_prefs', `row=${JSON.stringify(hiveRow())}`);
res = await call('/api/lite/interests', good);
body = await res.json();
ok(
  Array.isArray(body.selected) && body.selected.includes('poetry'),
  'GET reads them back',
  `selected=${JSON.stringify(body.selected)}`
);

clean();
psql(`UPDATE lumen_user SET session_epoch=0, status='active' WHERE user_id='${user.userId}'`);
summary('lite-interests-revoked-write-proof');
