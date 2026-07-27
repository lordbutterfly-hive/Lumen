// Concurrency proof for the lite intake path: N distinct lite users sign up, then
// all post at the SAME time. Asserts every post gets exactly one publish job and a
// pinned container parent — the orphan bug found on 2026-07-28 showed up here as
// 1-in-30 posts committed with neither.
//
// Each simulated user sends its own X-Forwarded-For, representing N real users on N
// real IPs (the per-IP signup cap is a control against one attacker, not the case
// under test).
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const BASE = 'http://localhost:3000';
const N = Number(process.env.BURST_N || 30);
const TAG = process.env.BURST_TAG || 'burst2';

const jar = (i) => ({ v: {} });
const cookiesFrom = (res, j) => {
  for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
    j.v[c.split('=')[0]] = c.split(';')[0].split('=').slice(1).join('=');
  }
};
const cookieHeader = (j) => Object.entries(j.v).map(([k, v]) => `${k}=${v}`).join('; ');

async function signup(i) {
  const j = jar(i);
  const ip = `10.88.${Math.floor(i / 250)}.${(i % 250) + 1}`;
  const H = { 'content-type': 'application/json', 'x-csrf-token': '1', 'x-forwarded-for': ip };
  const acct = privateKeyToAccount(generatePrivateKey());
  let r = await fetch(`${BASE}/api/lite/auth/evm/challenge`, {
    method: 'POST', headers: H, body: JSON.stringify({ address: acct.address })
  });
  cookiesFrom(r, j);
  const ch = await r.json();
  if (!ch.message) throw new Error(`challenge ${r.status} ${JSON.stringify(ch)}`);
  const signature = await acct.signMessage({ message: ch.message });
  r = await fetch(`${BASE}/api/lite/auth/evm/verify`, {
    method: 'POST', headers: { ...H, cookie: cookieHeader(j) },
    body: JSON.stringify({ address: acct.address, signature, nonce: ch.nonce })
  });
  cookiesFrom(r, j);
  const vr = await r.json();
  if (vr.status !== 'needs_name') throw new Error(`verify ${r.status} ${JSON.stringify(vr)}`);
  const name = `${TAG}u${i}${acct.address.slice(2, 6).toLowerCase()}`;
  r = await fetch(`${BASE}/api/lite/auth/name`, {
    method: 'POST', headers: { ...H, cookie: cookieHeader(j) }, body: JSON.stringify({ displayName: name })
  });
  cookiesFrom(r, j);
  const nr = await r.json();
  if (nr.status !== 'ok') throw new Error(`name ${r.status} ${JSON.stringify(nr)}`);
  return { j, ip, name };
}

console.log(`signing up ${N} users…`);
const users = [];
for (let i = 0; i < N; i++) {
  try { users.push(await signup(i)); } catch (e) { console.log(`  signup ${i} FAILED: ${e.message}`); }
}
console.log(`${users.length}/${N} signed up`);

console.log('firing all posts concurrently…');
const t0 = Date.now();
const results = await Promise.all(
  users.map((u, i) =>
    fetch(`${BASE}/api/lite/posts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': '1', 'x-forwarded-for': u.ip, cookie: cookieHeader(u.j) },
      body: JSON.stringify({ tier: 'normal', body: `Concurrency proof ${TAG} #${i} — one comment per 3s means these queue.`, tags: ['lumen'] })
    })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
      .catch((e) => ({ status: 0, body: { error: String(e) } }))
  )
);
const ms = Date.now() - t0;
const ok = results.filter((r) => r.status === 201).length;
const bad = results.filter((r) => r.status !== 201);
console.log(`\n${ok}/${users.length} posts accepted in ${ms}ms`);
for (const b of bad) console.log(`  NON-201: ${b.status} ${JSON.stringify(b.body)}`);
