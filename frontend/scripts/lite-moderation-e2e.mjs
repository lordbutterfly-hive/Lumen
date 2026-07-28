// Moderation end-to-end for lite accounts.
//
// What this proves, in order: a suspension actually STOPS an already-signed-in
// account (the whole point — the status column was previously decorative), that it
// parks rather than destroys queued work, that reinstating is a true undo, that a
// withdrawal (unfollow) still works while suspended, and that a moderator-hidden
// post cannot be edited back into existence by its author.
//
// Never calls /api/lite/publisher/drain — that BROADCASTS TO HIVE MAINNET.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const BASE = process.env.LUMEN_BASE_URL || 'http://localhost:3000';
const TOKEN = process.env.LITE_MODERATOR_TOKEN || 'dev-moderator-token-local-only';
const IP = '10.99.8.8';
const H = { 'content-type': 'application/json', 'x-csrf-token': '1', 'x-forwarded-for': IP };
const MOD = { 'content-type': 'application/json', 'x-lite-moderator-token': TOKEN, 'x-lite-moderator-actor': 'e2e' };

const jar = {};
const cookiesFrom = (r) => {
  for (const c of r.headers.getSetCookie?.() ?? []) jar[c.split('=')[0]] = c.split(';')[0].split('=').slice(1).join('=');
};
const CH = () => ({ ...H, cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') });

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const fail = (m) => {
  console.log('ABORT:', m);
  process.exit(1);
};

// ── sign up a fresh lite account ─────────────────────────────────────────────
const acct = privateKeyToAccount(generatePrivateKey());
let r = await fetch(`${BASE}/api/lite/auth/evm/challenge`, { method: 'POST', headers: H, body: JSON.stringify({ address: acct.address }) });
cookiesFrom(r);
const ch = await r.json();
const sig = await acct.signMessage({ message: ch.message });
r = await fetch(`${BASE}/api/lite/auth/evm/verify`, { method: 'POST', headers: CH(), body: JSON.stringify({ address: acct.address, signature: sig, nonce: ch.nonce }) });
cookiesFrom(r);
const displayName = 'moduser' + acct.address.slice(2, 8).toLowerCase();
r = await fetch(`${BASE}/api/lite/auth/name`, { method: 'POST', headers: CH(), body: JSON.stringify({ displayName }) });
cookiesFrom(r);
const signup = await r.json();
if (signup.status !== 'ok') fail(`signup: ${JSON.stringify(signup)}`);
console.log(`signed up as ${displayName} (${signup.user?.userId ?? '?'})`);

// ── a post, so there is queued work to park ──────────────────────────────────
r = await fetch(`${BASE}/api/lite/posts`, { method: 'POST', headers: CH(), body: JSON.stringify({ tier: 'normal', body: 'A post that predates the suspension.', tags: ['lumen'] }) });
const created = await r.json();
const postId = created.post?.postId;
if (r.status !== 201 || !postId) fail(`create: ${r.status} ${JSON.stringify(created)}`);
console.log('post created', postId);

// Baseline: it IS in the feed before anything is moderated, so the later absence
// check is proof of hiding rather than proof of pagination.
// The rendered permlink is `lite-<lowercased ULID>`, so compare case-insensitively —
// matching on the raw uppercase id silently never matches and the assertion passes
// for the wrong reason.
const feedHas = async (id) => {
  const res = await fetch(`${BASE}/api/lite/posts?limit=50`, { headers: CH() });
  return JSON.stringify(await res.json()).toLowerCase().includes(id.toLowerCase());
};
check('post visible in the feed to begin with', await feedHas(postId));

// ── 1. suspend, hiding their content ─────────────────────────────────────────
r = await fetch(`${BASE}/api/lite/moderation/user`, {
  method: 'POST',
  headers: MOD,
  body: JSON.stringify({ displayName, action: 'suspend', reason: 'e2e: spam', hideContent: true })
});
const suspended = await r.json();
check('suspend accepted', r.status === 200 && suspended.user?.status === 'suspended', JSON.stringify(suspended.user));
check('queued job parked, not cancelled', suspended.jobsHeld === 1, `jobsHeld=${suspended.jobsHeld}`);
check('their posts hidden in Lumen', suspended.postsHidden === 1, `postsHidden=${suspended.postsHidden}`);

// ── 2. the live session must stop working ────────────────────────────────────
r = await fetch(`${BASE}/api/lite/posts`, { method: 'POST', headers: CH(), body: JSON.stringify({ tier: 'normal', body: 'Should never exist.', tags: ['lumen'] }) });
const blocked = await r.json();
check('suspended session cannot post', r.status === 403 && blocked.code === 'account_suspended', `${r.status} ${blocked.code}`);

r = await fetch(`${BASE}/api/lite/follow`, { method: 'POST', headers: CH(), body: JSON.stringify({ followeeName: 'someone' }) });
check('suspended session cannot follow', r.status === 403, `status ${r.status}`);

r = await fetch(`${BASE}/api/lite/vote`, { method: 'POST', headers: CH(), body: JSON.stringify({ author: 'x', permlink: 'y', weight: 10000 }) });
check('suspended session cannot vote', r.status === 403, `status ${r.status}`);

// A withdrawal must still be possible — 404 (nobody by that name) is fine, 403 is not.
r = await fetch(`${BASE}/api/lite/unfollow`, { method: 'POST', headers: CH(), body: JSON.stringify({ followeeName: 'someone' }) });
check('suspended session may still UNfollow', r.status !== 403, `status ${r.status}`);

r = await fetch(`${BASE}/api/lite/vote`, { method: 'POST', headers: CH(), body: JSON.stringify({ author: 'x', permlink: 'y', weight: 0 }) });
check('suspended session may still clear a vote', r.status !== 403, `status ${r.status}`);

// A suspended account must not be able to upgrade its way out: that burns one of our
// account-creation tokens and produces a full Hive account we can no longer moderate.
r = await fetch(`${BASE}/api/account/upgrade`, { method: 'POST', headers: CH(), body: JSON.stringify({ newName: `${displayName}x` }) });
const upgrade = await r.json();
check('suspended session cannot upgrade to a Hive account', r.status === 403 && upgrade.code === 'account_suspended', `${r.status} ${upgrade.code}`);

// ── 3. hidden content is out of the feed ─────────────────────────────────────
check('hidden post is out of the feed', !(await feedHas(postId)));

// ── 4. reinstate is a true undo ──────────────────────────────────────────────
r = await fetch(`${BASE}/api/lite/moderation/user`, {
  method: 'POST',
  headers: MOD,
  body: JSON.stringify({ displayName, action: 'reinstate', hideContent: true })
});
const reinstated = await r.json();
check('reinstate accepted', r.status === 200 && reinstated.user?.status === 'active', JSON.stringify(reinstated.user));
check('parked job released', reinstated.jobsReleased === 1, `jobsReleased=${reinstated.jobsReleased}`);
check('posts restored', reinstated.postsRestored === 1, `postsRestored=${reinstated.postsRestored}`);

r = await fetch(`${BASE}/api/lite/posts`, { method: 'POST', headers: CH(), body: JSON.stringify({ tier: 'normal', body: 'Posting again after reinstatement.', tags: ['lumen'] }) });
const second = await r.json();
const secondId = second.post?.postId;
check('reinstated account can post again', r.status === 201, `status ${r.status}`);

// ── 5. per-post moderation ───────────────────────────────────────────────────
r = await fetch(`${BASE}/api/lite/moderation/post`, {
  method: 'POST',
  headers: MOD,
  body: JSON.stringify({ postId: secondId, visibility: 'hidden', reason: 'e2e: rule 4' })
});
const hidden = await r.json();
check('post hidden', r.status === 200 && hidden.visibility === 'hidden', JSON.stringify(hidden));

// The author must not be able to edit a removed post back into existence.
r = await fetch(`${BASE}/api/lite/posts`, { method: 'POST', headers: CH(), body: JSON.stringify({ tier: 'normal', body: 'Undoing the moderator.', editOfPostId: secondId }) });
const reEdit = await r.json();
check('author cannot edit a hidden post', r.status === 403 && reEdit.code === 'moderated', `${r.status} ${reEdit.code}`);

// A takedown on a post that has NOT been broadcast yet must cancel its queued job,
// so the content never reaches Hive at all. (The published case queues a delete job
// instead; that path is not exercised here because proving it would mean
// broadcasting to mainnet.)
r = await fetch(`${BASE}/api/lite/posts`, { method: 'POST', headers: CH(), body: JSON.stringify({ tier: 'normal', body: 'Queued, then taken down before publishing.', tags: ['lumen'] }) });
const doomed = (await r.json()).post?.postId;
r = await fetch(`${BASE}/api/lite/moderation/post`, {
  method: 'POST',
  headers: MOD,
  body: JSON.stringify({ postId: doomed, visibility: 'hidden', reason: 'e2e: takedown', takedown: true })
});
const takedown = await r.json();
check('takedown before publish cancels the queued job', takedown.cancelledJobs === 1, JSON.stringify(takedown));

// ── 6. the trail ─────────────────────────────────────────────────────────────
r = await fetch(`${BASE}/api/lite/moderation/actions?limit=10`, { headers: MOD });
const log = await r.json();
const actions = (log.actions ?? []).map((a) => a.action);
check('moderation log records every action', ['suspend', 'reinstate', 'hide'].every((a) => actions.includes(a)), actions.join(','));
check('log records who and why', (log.actions ?? []).some((a) => a.actor === 'e2e' && a.reason === 'e2e: spam'), '');

// ── 7. the guard itself ──────────────────────────────────────────────────────
r = await fetch(`${BASE}/api/lite/moderation/user`, {
  method: 'POST',
  headers: { ...MOD, 'x-lite-moderator-token': 'wrong-token' },
  body: JSON.stringify({ displayName, action: 'ban', reason: 'should not work' })
});
check('wrong moderator token refused', r.status === 401, `status ${r.status}`);

r = await fetch(`${BASE}/api/lite/moderation/user`, {
  method: 'POST',
  headers: MOD,
  body: JSON.stringify({ displayName, action: 'suspend' })
});
check('suspension without a reason refused', r.status === 400, `status ${r.status}`);

r = await fetch(`${BASE}/api/lite/moderation/post`, {
  method: 'POST',
  headers: MOD,
  body: JSON.stringify({ permlink: 'not-a-lumen-permlink', visibility: 'hidden', reason: 'x' })
});
check('non-Lumen permlink refused', r.status === 400, `status ${r.status}`);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
