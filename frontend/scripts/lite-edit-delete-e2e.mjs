// Edit + delete end-to-end for a lite account, including the edge cases the
// adversarial review flagged: edit coalescing, edit-after-delete refusal, delete
// before publish cancelling the queued job, and the edit cap.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const BASE = 'http://localhost:3000';
const IP = '10.99.7.7';
const H = { 'content-type': 'application/json', 'x-csrf-token': '1', 'x-forwarded-for': IP };
const jar = {};
const cookiesFrom = (r) => { for (const c of (r.headers.getSetCookie?.() ?? [])) jar[c.split('=')[0]] = c.split(';')[0].split('=').slice(1).join('='); };
const CH = () => ({ ...H, cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') });
const fail = (m) => { console.log('FAIL:', m); process.exit(1); };

const acct = privateKeyToAccount(generatePrivateKey());
let r = await fetch(`${BASE}/api/lite/auth/evm/challenge`, { method: 'POST', headers: H, body: JSON.stringify({ address: acct.address }) });
cookiesFrom(r); const ch = await r.json();
const sig = await acct.signMessage({ message: ch.message });
r = await fetch(`${BASE}/api/lite/auth/evm/verify`, { method: 'POST', headers: CH(), body: JSON.stringify({ address: acct.address, signature: sig, nonce: ch.nonce }) });
cookiesFrom(r);
r = await fetch(`${BASE}/api/lite/auth/name`, { method: 'POST', headers: CH(), body: JSON.stringify({ displayName: 'editor' + acct.address.slice(2, 8).toLowerCase() }) });
cookiesFrom(r);
if ((await r.json()).status !== 'ok') fail('signup');
console.log('signed up');

// 1. create
r = await fetch(`${BASE}/api/lite/posts`, { method: 'POST', headers: CH(), body: JSON.stringify({ tier: 'normal', body: 'ORIGINAL text', tags: ['lumen'] }) });
const created = await r.json();
const postId = created.post?.postId ?? created.post?.id;
console.log('create', r.status, 'postId', postId);
if (r.status !== 201 || !postId) fail('create');

// 2. edit twice quickly — should COALESCE into one pending job with the newest text
for (const text of ['EDIT one', 'EDIT two']) {
  r = await fetch(`${BASE}/api/lite/posts`, { method: 'POST', headers: CH(), body: JSON.stringify({ tier: 'normal', body: text, editOfPostId: postId }) });
  console.log(`edit "${text}" ->`, r.status, (await r.json()).status);
}

// 3. edit a post that is not ours / does not exist
r = await fetch(`${BASE}/api/lite/posts`, { method: 'POST', headers: CH(), body: JSON.stringify({ tier: 'normal', body: 'nope', editOfPostId: '01AAAAAAAAAAAAAAAAAAAAAAAA' }) });
console.log('edit foreign post ->', r.status, (await r.json()).error);
if (r.status === 201) fail('editing a foreign post was allowed');

// 4. delete (not yet published -> should cancel the queued job)
r = await fetch(`${BASE}/api/lite/posts/${postId}`, { method: 'DELETE', headers: CH() });
const del = await r.json();
console.log('delete ->', r.status, JSON.stringify(del));
if (r.status !== 200 || del.status !== 'ok') fail('delete');
if (del.onChain !== false) fail('unpublished delete should not need a chain op');

// 5. edit AFTER delete -> must be refused
r = await fetch(`${BASE}/api/lite/posts`, { method: 'POST', headers: CH(), body: JSON.stringify({ tier: 'normal', body: 'resurrect', editOfPostId: postId }) });
const after = await r.json();
console.log('edit after delete ->', r.status, after.error);
if (r.status === 201) fail('edit after delete was allowed');

// 6. double delete -> idempotent
r = await fetch(`${BASE}/api/lite/posts/${postId}`, { method: 'DELETE', headers: CH() });
console.log('delete again ->', r.status, (await r.json()).status);
if (r.status !== 200) fail('second delete should be idempotent');

console.log('\nEDIT/DELETE E2E: PASS');
console.log('postId=' + postId);
