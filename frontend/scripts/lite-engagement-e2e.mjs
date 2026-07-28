// Proves the READ side of Lumen-local engagement against the running dev server.
//
// lumen_vote / lumen_reblog were write-only: the vote button read `active_votes` and
// the reblog button read `getRebloggedBy`, both from Hivemind, which has never heard of
// a Lumen-local vote. So a lite vote lit up and then vanished on the next refetch or
// reload. This asserts the whole round trip — cast, read back, retract, read back.
//
// Touches no publisher endpoint: votes and reblogs never reach Hive by design.
import ecc from '/home/clauderfly/hive-blog-rebuild/node_modules/.pnpm/@bitcoinerlab+secp256k1@1.2.0/node_modules/@bitcoinerlab/secp256k1/dist/index.js';
import { ECPairFactory } from 'ecpair';
import * as bitcoin from 'bitcoinjs-lib';
import pkg from 'bip322-js';
const { Signer } = pkg;

const ECPair = ECPairFactory(ecc);
const BASE = 'http://localhost:3000';
const CSRF = { 'content-type': 'application/json', 'x-csrf-token': '1' };
const TARGET = { author: 'blocktrades', permlink: 'engagement-readback-test' };

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

function cookiesFrom(res, jar) {
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of set) jar[c.split('=')[0]] = c.split(';')[0].split('=').slice(1).join('=');
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

// ── sign up a fresh keyless BTC lite account ────────────────────────────────
const kp = ECPair.makeRandom({ compressed: true });
const { address } = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey });
const jar = {};

let r = await fetch(`${BASE}/api/lite/auth/btc/challenge`, { method: 'POST', headers: CSRF, body: JSON.stringify({ address }) });
cookiesFrom(r, jar);
const ch = await r.json();
if (!ch.message) { console.log('FAIL: no challenge', ch); process.exit(1); }

const signature = Signer.sign(kp.toWIF(), address, ch.message);
const sigB64 = typeof signature === 'string' ? signature : signature.toString('base64');
r = await fetch(`${BASE}/api/lite/auth/btc/verify`, { method: 'POST', headers: { ...CSRF, cookie: cookieHeader(jar) }, body: JSON.stringify({ address, signature: sigB64, nonce: ch.nonce }) });
cookiesFrom(r, jar);
const vr = await r.json();
if (vr.status !== 'needs_name' && vr.status !== 'authenticated') { console.log('FAIL: verify', vr); process.exit(1); }

const name = 'eng' + Date.now().toString(36).slice(-7);
if (vr.status === 'needs_name') {
  r = await fetch(`${BASE}/api/lite/auth/name`, { method: 'POST', headers: { ...CSRF, cookie: cookieHeader(jar) }, body: JSON.stringify({ displayName: name }) });
  cookiesFrom(r, jar);
  const nr = await r.json();
  if (nr.status !== 'ok') { console.log('FAIL: signup', nr); process.exit(1); }
}
console.log(`signed in as @${name}\n`);

const authed = { ...CSRF, cookie: cookieHeader(jar) };
const readEngagement = async (headers = authed) => {
  const params = new URLSearchParams(TARGET);
  const res = await fetch(`${BASE}/api/lite/engagement?${params}`, { headers });
  return { status: res.status, body: await res.json() };
};

// ── 1. before anything: clean slate ─────────────────────────────────────────
console.log('1. a post nobody engaged with reads as clean');
{
  const { status, body } = await readEngagement();
  check('endpoint responds', status === 200, String(status));
  check('no vote', Array.isArray(body.votes) && body.votes.length === 0, JSON.stringify(body.votes));
  check('not reblogged', body.reblogged === false);
}

// ── 2. cast a vote, then READ IT BACK (the bug) ─────────────────────────────
console.log('\n2. a cast vote is readable afterwards');
{
  r = await fetch(`${BASE}/api/lite/vote`, { method: 'POST', headers: authed, body: JSON.stringify({ ...TARGET, weight: 10000 }) });
  check('vote accepted', r.status === 200, String(r.status));

  const { body } = await readEngagement();
  check('vote comes back', body.votes.length === 1, JSON.stringify(body.votes));
  check('voter is the lite handle', body.votes[0]?.voter === name, body.votes[0]?.voter);
  check('weight preserved', body.votes[0]?.vote_percent === 10000, String(body.votes[0]?.vote_percent));
  check('weight is a string, matching wax IVoteListItem', typeof body.votes[0]?.weight === 'string');
  check('flagged _temporary (not chain data)', body.votes[0]?._temporary === true);
  check('vote counted', body.voteCount === 1, String(body.voteCount));
}

// ── 3. reblog, read back ────────────────────────────────────────────────────
console.log('\n3. a reblog is readable afterwards');
{
  r = await fetch(`${BASE}/api/lite/reblog`, { method: 'POST', headers: authed, body: JSON.stringify(TARGET) });
  check('reblog accepted', r.status === 200, String(r.status));
  const { body } = await readEngagement();
  check('reblogged reads true', body.reblogged === true);
  check('reblog counted', body.reblogCount === 1, String(body.reblogCount));
}

// ── 4. another session must not inherit this user's state ───────────────────
console.log('\n4. engagement is per-user, not global');
{
  const { body } = await readEngagement(CSRF); // no cookies
  check('anonymous sees no vote of its own', body.votes.length === 0);
  check('anonymous sees no reblog of its own', body.reblogged === false);
  check('but public totals are visible', body.voteCount === 1 && body.reblogCount === 1, JSON.stringify(body));
}

// ── 5. retraction is readable too ───────────────────────────────────────────
console.log('\n5. retracting is readable');
{
  r = await fetch(`${BASE}/api/lite/vote`, { method: 'POST', headers: authed, body: JSON.stringify({ ...TARGET, weight: 0 }) });
  check('vote cleared', r.status === 200, String(r.status));
  r = await fetch(`${BASE}/api/lite/reblog`, { method: 'POST', headers: authed, body: JSON.stringify({ ...TARGET, undo: true }) });
  check('reblog undone', r.status === 200, String(r.status));

  const { body } = await readEngagement();
  check('vote gone', body.votes.length === 0, JSON.stringify(body.votes));
  check('reblog gone', body.reblogged === false);
  check('counts back to zero', body.voteCount === 0 && body.reblogCount === 0, JSON.stringify(body));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
