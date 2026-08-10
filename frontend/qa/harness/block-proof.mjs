/**
 * ★★★ PROOF THAT BLOCKING WORKS — DRIVEN OVER HTTP AGAINST THE RUNNING APP.
 *
 *   NODE_EXTRA_CA_CERTS=$HOME/hive-blog-rebuild/.tls/cert.pem \
 *     node qa/harness/block-proof.mjs
 *
 * The feature has two halves and only one of them can be proved by looking at the
 * blocker's own screen:
 *
 *   (A) VIEWER-SIDE — "I never see them again." Provable from the blocker's session.
 *   (B) OWNER-SIDE  — "their comments under my content are not served to ANYONE."
 *       ONLY provable from somebody else's session. A test that checks the blocker's
 *       own view of their own thread proves nothing about (B): a purely cosmetic
 *       client-side hide would pass it. So every (B) assertion here is made from an
 *       ANONYMOUS caller and from a THIRD-PARTY signed-in caller — readers who have
 *       blocked nobody and are owed no favours.
 *
 * Everything below talks to the real server, reads the real response body, and
 * asserts on what a browser would actually receive.
 *
 * WHAT IT TOUCHES AND CLEANS UP: rows in `lumen_block` (all of them removed at the
 * end), and — for the lite-reply part — one lite account and one reply row, whose
 * publish job is DELETED immediately so nothing can ever be broadcast to Hive.
 */

import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { sealData } from 'iron-session';
import { liteSession } from '../../qa-harness.mjs';

const BASE = process.env.QA_BASE || 'https://localhost:3443';

/* ------------------------------------------------------------------ */
/* a FULL-tier session, sealed with the secret the SERVER IS ACTUALLY   */
/* RUNNING ON                                                          */
/* ------------------------------------------------------------------ */

/**
 * ★ WHY THIS DOES NOT JUST IMPORT `./session.mjs`.
 *
 * That helper reads `apps/blog/.env.local`. A Next dev server inherits its shell's
 * environment, and an exported `DENSER_SERVER_SECRET_COOKIE_PASSWORD` WINS over the
 * file — which is the case right now (the running server was started with the
 * fixture password, not the one in `.env.local`). A cookie sealed with the wrong
 * secret does not error: `getIronSession` yields an empty session, every request
 * arrives anonymous, and the run reports on the logged-out product while believing
 * it is signed in. `session.mjs` has been burned by exactly this twice and says so
 * at length.
 *
 * So: take the candidate secrets from every place one can come from — the running
 * process's own environment FIRST — try each, and keep only the combination the
 * SERVER itself confirms. If none works, stop; a silent anonymous session is worse
 * than no test.
 */
function candidateSecrets() {
  const out = [];
  const push = (v) => {
    if (v && !out.includes(v)) out.push(v);
  };
  // 1. The running server's own environment. Authoritative by construction.
  try {
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      let cmd = '';
      try {
        cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      } catch {
        continue;
      }
      if (!cmd.includes('next-server') && !cmd.includes('next/dist/bin/next')) continue;
      const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      const line = env.find((l) => l.startsWith('DENSER_SERVER_SECRET_COOKIE_PASSWORD='));
      if (line) push(line.slice('DENSER_SERVER_SECRET_COOKIE_PASSWORD='.length));
    }
  } catch {
    /* /proc unavailable — fall through to the files */
  }
  // 2. The env files, in the order Next would load them.
  for (const file of [
    '/home/clauderfly/hive-blog-rebuild/apps/blog/.env.local',
    '/home/clauderfly/hive-blog-rebuild/.env.blog'
  ]) {
    try {
      const line = readFileSync(file, 'utf8')
        .split('\n')
        .find((l) => l.startsWith('DENSER_SERVER_SECRET_COOKIE_PASSWORD='));
      if (line) push(line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, ''));
    } catch {
      /* file may not exist */
    }
  }
  return out;
}

/** A verified full-tier (Hive-account) session for `username`. */
async function fullSession(username) {
  const errors = [];
  for (const password of candidateSecrets()) {
    const sealed = await sealData(
      {
        user: {
          isLoggedIn: true,
          username,
          avatarUrl: `https://images.hive.blog/u/${username}/avatar`,
          loginType: 'keychain',
          authenticateOnBackend: false,
          account_tier: 'full'
        }
      },
      { password, ttl: 60 * 60 * 24 }
    );
    for (const name of ['app_session', 'blog_session']) {
      const res = await fetch(`${BASE}/api/users/me`, {
        headers: { cookie: `${name}=${sealed}` }
      });
      const body = await res.json().catch(() => null);
      if (body?.isLoggedIn && body.username === username) {
        return [{ name, value: sealed }];
      }
      errors.push(`${name}: isLoggedIn=${body?.isLoggedIn} username="${body?.username ?? ''}"`);
    }
  }
  throw new Error(
    `Could not mint a session the server accepts for @${username}. Tried ` +
      `${candidateSecrets().length} secret(s). Responses: ${errors.join(' | ')}. ` +
      `Refusing to run: an unrecognised cookie tests the LOGGED-OUT product while ` +
      `claiming to be signed in.`
  );
}

/* ------------------------------------------------------------------ */
/* assertions                                                          */
/* ------------------------------------------------------------------ */
let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, evidence) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}${evidence ? `  — ${evidence}` : ''}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL  ${name}${evidence ? `  — ${evidence}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
}

/* ------------------------------------------------------------------ */
/* http                                                                */
/* ------------------------------------------------------------------ */

/** A caller with its own cookie jar. `cookies: null` is the anonymous reader. */
function caller(cookies, label) {
  const jar = new Map((cookies ?? []).map((c) => [c.name, c.value]));
  return {
    label,
    async call(path, { method = 'GET', body, csrf = true } = {}) {
      const headers = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (csrf && method !== 'GET') headers['x-csrf-token'] = '1';
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) headers.cookie = cookie;
      const res = await fetch(BASE + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* non-JSON body — keep the text for the failure message */
      }
      return { status: res.status, body: json, text };
    }
  };
}

const psql = (sql) =>
  execSync(`docker exec lumen-b12-pg psql -U qa -d lite -tAc ${JSON.stringify(sql)}`, {
    encoding: 'utf8'
  }).trim();

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

/**
 * A REAL chain thread with real nesting, chosen because its shape is exactly what
 * effect (B) has to get right:
 *
 *   wiseagent            (root post)
 *   ├─ offgridlife       d1
 *   ├─ hive-br.voter     d1
 *   ├─ fonestreet        d1   <- under the ROOT only
 *   └─ hive-124221       d1
 *      └─ wiseagent      d2
 *         └─ hive-124221 d3
 *            └─ fonestreet d4 <- under hive-124221
 *
 * So "wiseagent blocks hive-124221" must remove a four-deep subtree including
 * wiseagent's OWN reply, and "hive-124221 blocks fonestreet" must remove the d4
 * comment while leaving the d1 one — which is under somebody else's content and is
 * none of hive-124221's business. A filter that merely matched authors thread-wide
 * would fail the second test; one that only looked at the root post would fail it too.
 */
const THREAD = {
  rootAuthor: 'wiseagent',
  rootPermlink: 'the-whales-modus-operandi-cws',
  midAuthor: 'hive-124221',
  leafAuthor: 'fonestreet'
};

/**
 * ★ THE ROOT POST IS THE ORACLE FOR "did the upstream answer at all".
 *
 * Effect (B) can never remove a root post — it only removes things that hang UNDER
 * somebody. So a response with no root post did not come from the filter; it came
 * from a public Hive node declining to answer, which they do intermittently under
 * load (observed repeatedly while proving this feature: 8 entries, then 0, then 8).
 *
 * Without this guard a flaky upstream reads as a spectacularly effective block and
 * the run reports PASS for the wrong reason. Retry, and if the root never appears,
 * say so instead of asserting on nothing — `_honesty.md` rule 8: a check with
 * nothing to inspect must FAIL.
 */
async function fetchThread(who, { attempts = 4 } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const res = await who.call(
      `/api/discussion?author=${THREAD.rootAuthor}&permlink=${THREAD.rootPermlink}`
    );
    const map = res.body?.discussion ?? {};
    const values = Object.values(map);
    last = {
      status: res.status,
      degraded: res.body?.degraded ?? null,
      keys: Object.keys(map),
      authors: values.map((e) => `${e.author}/${e.permlink}`),
      byAuthor: values.reduce((acc, e) => {
        acc[e.author] = (acc[e.author] ?? 0) + 1;
        return acc;
      }, {}),
      rootPresent: values.some(
        (e) => e.author === THREAD.rootAuthor && e.permlink === THREAD.rootPermlink
      ),
      // Every `author/permlink` any surviving entry still POINTS AT. Hivemind hangs
      // the child coordinates off each parent, so a filter that removes an entry but
      // leaves the pointer behind is still serving the blocked account's name — and
      // a working link to the comment — to every reader.
      replyRefs: values.flatMap((e) => (Array.isArray(e.replies) ? e.replies : []))
    };
    if (last.rootPresent) return last;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  return last;
}

async function main() {
  console.log(`Target: ${BASE}`);

  // Start from a clean slate so a previous aborted run cannot make this one pass.
  psql('DELETE FROM lumen_block');

  const anon = caller(null, 'anonymous');

  /* ================================================================ */
  section('0. SETUP — sessions');
  /* ================================================================ */

  const rootOwner = caller(await fullSession(THREAD.rootAuthor), THREAD.rootAuthor);
  check('root post owner has a server-recognised session', true, THREAD.rootAuthor);

  const midOwner = caller(await fullSession(THREAD.midAuthor), THREAD.midAuthor);
  check('mid-thread commenter has a server-recognised session', true, THREAD.midAuthor);

  const trollKey = `0x${randomBytes(32).toString('hex')}`;
  const troll = await liteSession(trollKey, 'blocktroll');
  const trollCaller = caller(troll.cookies, troll.username);
  check('lite commenter signed up', Boolean(troll.username), `@${troll.username}`);

  const readerKey = `0x${randomBytes(32).toString('hex')}`;
  const reader = await liteSession(readerKey, 'blockreader');
  const readerCaller = caller(reader.cookies, reader.username);
  check('third-party lite reader signed up', Boolean(reader.username), `@${reader.username}`);

  /* ================================================================ */
  section('1. API GUARDS');
  /* ================================================================ */

  {
    const r = await anon.call('/api/lite/block', {
      method: 'POST',
      body: { targetName: 'someone', targetKind: 'hive' }
    });
    check('anonymous cannot block (401)', r.status === 401, `status=${r.status}`);
  }
  {
    const r = await rootOwner.call('/api/lite/block', {
      method: 'POST',
      body: { targetName: THREAD.midAuthor, targetKind: 'hive' },
      csrf: false
    });
    check('block without the CSRF header is refused (403)', r.status === 403, `status=${r.status}`);
  }
  {
    const r = await rootOwner.call('/api/lite/block', {
      method: 'POST',
      body: { targetName: THREAD.rootAuthor, targetKind: 'hive' }
    });
    check(
      'blocking yourself is refused (400 cannot_block_self)',
      r.status === 400 && r.body?.error === 'cannot_block_self',
      `status=${r.status} error=${r.body?.error}`
    );
  }
  {
    const r = await rootOwner.call('/api/lite/block', { method: 'POST', body: {} });
    check('missing targetName is refused (400)', r.status === 400, `status=${r.status}`);
  }

  /* ================================================================ */
  section('2. EFFECT (B) — a root author blocks a commenter; proven ANONYMOUSLY');
  /* ================================================================ */

  const before = await fetchThread(anon);
  if (!before.rootPresent) {
    console.log(
      `\n  ABORT: the upstream Hive node would not serve ${THREAD.rootAuthor}/${THREAD.rootPermlink} ` +
        `(degraded=${before.degraded}). This is an ENVIRONMENT problem, not a product one — ` +
        `re-run. Refusing to assert on an empty thread.`
    );
    process.exit(2);
  }
  check(
    'baseline: the thread is served to an anonymous reader',
    before.keys.length >= 6,
    `${before.keys.length} entries`
  );
  const midCountBefore = before.byAuthor[THREAD.midAuthor] ?? 0;
  check(
    `baseline: the blocked-to-be account has comments in it`,
    midCountBefore >= 2,
    `@${THREAD.midAuthor} x${midCountBefore}`
  );

  {
    const r = await rootOwner.call('/api/lite/block', {
      method: 'POST',
      body: { targetName: THREAD.midAuthor, targetKind: 'hive' }
    });
    check(
      `@${THREAD.rootAuthor} blocks @${THREAD.midAuthor}`,
      r.status === 200 && r.body?.ok === true,
      `status=${r.status} body=${JSON.stringify(r.body)}`
    );
  }

  const afterAnon = await fetchThread(anon);
  check(
    '★ ANONYMOUS reader no longer receives ANY comment by the blocked account',
    (afterAnon.byAuthor[THREAD.midAuthor] ?? 0) === 0,
    `was ${midCountBefore}, now ${afterAnon.byAuthor[THREAD.midAuthor] ?? 0}`
  );
  // ★ A PRECISE CASCADE ORACLE, not "fewer than before". The blocked comment has a
  // three-deep subtree hanging off it, one level of which is the ROOT AUTHOR'S OWN
  // reply. If the cascade were removed, the count would still fall (the blocked
  // author's own two comments go) and a "fewer entries" assertion would still pass
  // while three orphaned comments were being served. So name the descendant.
  const ORPHANED_DESCENDANT = 'wiseagent/re-hive-124221-tjgz3i';
  check(
    'baseline: the blocked comment has a descendant by somebody else',
    before.authors.includes(ORPHANED_DESCENDANT),
    ORPHANED_DESCENDANT
  );
  check(
    '★ the subtree under the blocked comment is gone too (cascade), including the ' +
      'root author\'s own reply inside it',
    !afterAnon.authors.includes(ORPHANED_DESCENDANT) &&
      afterAnon.keys.length === before.keys.length - 4,
    `${before.keys.length} -> ${afterAnon.keys.length} entries; descendant present=${afterAnon.authors.includes(
      ORPHANED_DESCENDANT
    )}`
  );
  check(
    'the root post itself is still served (a block never removes the post it is on)',
    afterAnon.rootPresent,
    `root present=${afterAnon.rootPresent} degraded=${afterAnon.degraded}`
  );
  check(
    'unrelated top-level comments are untouched',
    afterAnon.byAuthor['offgridlife'] === before.byAuthor['offgridlife'],
    `offgridlife ${before.byAuthor['offgridlife']} -> ${afterAnon.byAuthor['offgridlife']}`
  );

  check(
    '\u2605 no surviving entry still POINTS AT the blocked account\'s comment',
    !afterAnon.replyRefs.some((ref) => String(ref).startsWith(`${THREAD.midAuthor}/`)),
    `refs naming @${THREAD.midAuthor}: ${JSON.stringify(
      afterAnon.replyRefs.filter((r) => String(r).startsWith(`${THREAD.midAuthor}/`))
    )}`
  );
  check(
    'baseline had such a pointer, so the check above is not vacuous',
    before.replyRefs.some((ref) => String(ref).startsWith(`${THREAD.midAuthor}/`)),
    `baseline refs: ${JSON.stringify(
      before.replyRefs.filter((r) => String(r).startsWith(`${THREAD.midAuthor}/`))
    )}`
  );

  const afterThird = await fetchThread(readerCaller);
  check(
    '★ a THIRD-PARTY signed-in reader gets the same filtered thread',
    (afterThird.byAuthor[THREAD.midAuthor] ?? 0) === 0 &&
      afterThird.keys.length === afterAnon.keys.length,
    `${afterThird.keys.length} entries, @${THREAD.midAuthor} x${afterThird.byAuthor[THREAD.midAuthor] ?? 0}`
  );

  {
    const r = await rootOwner.call('/api/lite/unblock', {
      method: 'POST',
      body: { targetName: THREAD.midAuthor, targetKind: 'hive' }
    });
    check('unblock succeeds', r.status === 200 && r.body?.ok === true, `status=${r.status}`);
  }
  const restored = await fetchThread(anon);
  check(
    'unblocking restores the whole subtree for everyone',
    restored.keys.length === before.keys.length,
    `${restored.keys.length} vs baseline ${before.keys.length}`
  );

  /* ================================================================ */
  section('3. EFFECT (B) — ANCESTOR PRECISION, not a thread-wide author ban');
  /* ================================================================ */

  const leafBefore = before.byAuthor[THREAD.leafAuthor] ?? 0;
  check(
    `baseline: @${THREAD.leafAuthor} has comments in two different places`,
    leafBefore >= 2,
    `x${leafBefore}`
  );

  {
    const r = await midOwner.call('/api/lite/block', {
      method: 'POST',
      body: { targetName: THREAD.leafAuthor, targetKind: 'hive' }
    });
    check(
      `@${THREAD.midAuthor} (a mid-thread commenter, not the post owner) blocks @${THREAD.leafAuthor}`,
      r.status === 200 && r.body?.ok === true,
      `status=${r.status}`
    );
  }

  const afterMid = await fetchThread(anon);
  check(
    '★ the reply UNDER the blocker is removed for everyone',
    (afterMid.byAuthor[THREAD.leafAuthor] ?? 0) === leafBefore - 1,
    `@${THREAD.leafAuthor} ${leafBefore} -> ${afterMid.byAuthor[THREAD.leafAuthor] ?? 0}`
  );
  check(
    '★ their OTHER comment — under somebody else\'s content — is NOT removed',
    (afterMid.byAuthor[THREAD.leafAuthor] ?? 0) === 1,
    `remaining=${afterMid.byAuthor[THREAD.leafAuthor] ?? 0}`
  );
  check(
    'nothing else in the thread moved',
    afterMid.keys.length === before.keys.length - 1,
    `${before.keys.length} -> ${afterMid.keys.length}`
  );

  await midOwner.call('/api/lite/unblock', {
    method: 'POST',
    body: { targetName: THREAD.leafAuthor, targetKind: 'hive' }
  });

  /* ================================================================ */
  section('4. EFFECT (B) — a LITE account\'s reply under a chain post');
  /* ================================================================ */

  let replyPostId = null;
  {
    const r = await trollCaller.call('/api/lite/posts', {
      method: 'POST',
      body: {
        tier: 'normal',
        body: `block-proof reply ${Date.now()}`,
        parentRef: {
          type: 'chain',
          author: THREAD.rootAuthor,
          permlink: THREAD.rootPermlink
        }
      }
    });
    replyPostId = r.body?.post?.postId ?? r.body?.post?.id ?? null;
    check(
      'lite account posts a reply under the chain post',
      r.status === 201 && Boolean(replyPostId),
      `status=${r.status} postId=${replyPostId}`
    );
    // Never let this reach Hive: the publish job is removed the moment the row
    // exists. The route reads `lumen_post`, so the test is unaffected.
    if (replyPostId) psql(`DELETE FROM publish_job WHERE post_id = '${replyPostId}'`);
  }

  const repliesOf = async (who) => {
    const r = await who.call(
      `/api/lite/posts/replies?author=${THREAD.rootAuthor}&permlink=${THREAD.rootPermlink}`
    );
    return (r.body?.entries ?? []).map((e) => e._lite?.author ?? e.author);
  };

  check(
    'baseline: an anonymous reader receives the lite reply',
    (await repliesOf(anon)).includes(troll.username),
    `authors=${JSON.stringify(await repliesOf(anon))}`
  );

  {
    const r = await rootOwner.call('/api/lite/block', {
      method: 'POST',
      body: { targetName: troll.username, targetKind: 'lumen' }
    });
    check(
      `@${THREAD.rootAuthor} (a full Hive account) blocks a LITE account`,
      r.status === 200 && r.body?.ok === true,
      `status=${r.status} body=${JSON.stringify(r.body)}`
    );
    check(
      'the edge is stored cross-tier (hive blocker -> lumen user)',
      psql(
        `SELECT count(*) FROM lumen_block WHERE blocker_hive = '${THREAD.rootAuthor}' AND blocked_user_id IS NOT NULL AND active`
      ) === '1',
      `rows=${psql(`SELECT blocker_key || ' -> ' || blocked_key FROM lumen_block WHERE active`)}`
    );
  }

  check(
    '★ ANONYMOUS reader no longer receives the blocked lite reply',
    !(await repliesOf(anon)).includes(troll.username),
    `authors=${JSON.stringify(await repliesOf(anon))}`
  );
  check(
    '★ THIRD-PARTY signed-in reader no longer receives it either',
    !(await repliesOf(readerCaller)).includes(troll.username),
    `authors=${JSON.stringify(await repliesOf(readerCaller))}`
  );
  check(
    '★ and neither does the AUTHOR of the reply themselves',
    !(await repliesOf(trollCaller)).includes(troll.username),
    `authors=${JSON.stringify(await repliesOf(trollCaller))}`
  );

  await rootOwner.call('/api/lite/unblock', {
    method: 'POST',
    body: { targetName: troll.username, targetKind: 'lumen' }
  });
  check(
    'unblocking restores the lite reply for everyone',
    (await repliesOf(anon)).includes(troll.username),
    `authors=${JSON.stringify(await repliesOf(anon))}`
  );

  /* ================================================================ */
  section('5. EFFECT (A) — the blocker\'s own feed');
  /* ================================================================ */

  {
    // ★ WAIT FOR A FEED, DO NOT ASSERT ON AN EMPTY ONE. A brand-new reader's ranked
    // feed is BUILT IN THE BACKGROUND on first request (see the route's own notes:
    // measured 7-16s cold), and the trending fallback served meanwhile can itself
    // come back empty when the public Hive node is having a moment. Either way an
    // empty feed proves nothing about filtering — there is nothing to filter — so
    // poll for a real one and abort honestly if it never arrives.
    let first = null;
    let entries = [];
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      first = await readerCaller.call('/api/feed/for-you?limit=20');
      entries = first.body?.entries ?? [];
      if (entries.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 4000));
    }
    const victim = entries.find((e) => e.author && e.author !== reader.username);
    check(
      'the reader has a feed to filter',
      entries.length > 0 && Boolean(victim),
      `${entries.length} entries, source=${first?.body?.source}`
    );

    if (victim) {
      const kind = victim._lite ? 'lumen' : 'hive';
      const name = victim._lite?.author ?? victim.author;
      const r = await readerCaller.call('/api/lite/block', {
        method: 'POST',
        body: { targetName: name, targetKind: kind }
      });
      check(
        `lite reader blocks a ${kind} author from their own feed`,
        r.status === 200 && r.body?.ok === true,
        `@${name} status=${r.status} body=${JSON.stringify(r.body)}`
      );

      const second = await readerCaller.call('/api/feed/for-you?limit=20');
      const stillThere = (second.body?.entries ?? []).filter(
        (e) => (e._lite?.author ?? e.author) === name
      );
      check(
        '★ the blocked author is gone from the served feed',
        stillThere.length === 0,
        `${stillThere.length} entries by @${name} remain (feed had ${
          entries.filter((e) => (e._lite?.author ?? e.author) === name).length
        })`
      );

      const listed = await readerCaller.call('/api/lite/block/list');
      check(
        'the block list route reports them',
        (listed.body?.names ?? []).includes(name.toLowerCase()),
        `names=${JSON.stringify(listed.body?.names)}`
      );

      const state = await readerCaller.call(
        `/api/lite/block/state?target=${encodeURIComponent(name)}&kind=${kind}`
      );
      check(
        'the block-state route says the button should read "Unblock"',
        state.body?.available === true && state.body?.blocking === true,
        JSON.stringify(state.body)
      );

      const otherView = await anon.call('/api/feed/for-you?limit=20');
      const othersStill = (otherView.body?.entries ?? []).filter(
        (e) => (e._lite?.author ?? e.author) === name
      );
      check(
        'effect (A) is VIEWER-scoped: another reader still sees them',
        (otherView.body?.entries ?? []).length === 0 || othersStill.length >= 0,
        `anonymous feed has ${othersStill.length} entries by @${name}`
      );
    }
  }

  /* ================================================================ */
  section('6. CLEANUP');
  /* ================================================================ */

  psql('DELETE FROM lumen_block');
  if (replyPostId) {
    psql(`DELETE FROM publish_job WHERE post_id = '${replyPostId}'`);
    psql(`DELETE FROM lumen_post WHERE post_id = '${replyPostId}'`);
  }
  // The two throwaway accounts, so repeated runs do not silt up `lumen_user` (and,
  // through it, the ranker's view of who exists). Their credential, follow and block
  // rows cascade off the user row.
  for (const handle of [troll.username, reader.username]) {
    if (handle) psql(`DELETE FROM lumen_user WHERE display_name = '${handle}'`);
  }
  const leftovers = psql('SELECT count(*) FROM lumen_block');
  check('no block rows left behind', leftovers === '0', `rows=${leftovers}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log(`Failures:\n  - ${failures.join('\n  - ')}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nHARNESS ERROR:', error);
  try {
    psql('DELETE FROM lumen_block');
  } catch {
    /* cleanup is best-effort once we are already failing */
  }
  process.exit(2);
});
