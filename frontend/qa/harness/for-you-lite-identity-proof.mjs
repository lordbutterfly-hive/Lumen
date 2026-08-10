/**
 * ★★★ PROOF THAT A LITE POST KEEPS ITS IDENTITY THROUGH THE "For You" FEED —
 * DRIVEN OVER HTTP AGAINST THE RUNNING APP.
 *
 *   NODE_EXTRA_CA_CERTS=$HOME/hive-blog-rebuild/.tls/cert.pem \
 *     node qa/harness/for-you-lite-identity-proof.mjs
 *
 * ONE root cause, four user-visible failures. `/api/feed/for-you` rewrote a lite
 * post's `author` to its writer's handle and never attached `_lite`, so every
 * consumer that needs to know "this is a lite post" was left guessing from a name:
 *
 *   1. BLOCKING  — `block-actor.ts` classifies a `_lite`-less entry as a HIVE
 *      account and computes `h:<handle>`, while the edge is `u:<ULID>`. A blocked
 *      lite author was still served on the product's primary surface.
 *   2. TITLE/URL — Hivemind synthesises "RE: <parent title>" for every comment and
 *      every lite post is a comment, so the card showed the CONTAINER's title and
 *      the payload's `url` pointed at the container under the publishing account.
 *   3. CURSOR    — `cursorOf` handed back the re-attributed handle, the client
 *      replayed it as `start_author`, and `bridge.get_ranked_posts` threw
 *      `Post <handle>/<permlink> does not exist`. Infinite scroll dead-ended.
 *   4. ENGAGEMENT— `liteTargetServable` short-circuits on `author !== frontend`,
 *      which is exactly what the card hands back, so a taken-down post kept
 *      serving and accepting engagement through its display-name coordinates.
 *
 * ★ WHY A THIRD-PARTY READER IS IN EVERY BLOCK ASSERTION. Effect (A) — "I never
 * see them again" — is VIEWER-scoped, so "the author is gone from the blocker's
 * feed" also passes when the fix accidentally removed that author from EVERYONE's
 * feed (a fail-closed drop, a broken hydrate). That is a catastrophic regression
 * and the blocker's own screen cannot see it. So a second signed-in reader, who
 * has blocked nobody and follows the same author, asserts the opposite direction
 * at the same moment: they must STILL receive the post.
 *
 * WHAT IT TOUCHES AND CLEANS UP: two throwaway lite accounts (deleted at the end,
 * their follow/block rows cascade), rows in `lumen_block` (removed), and ONE
 * synthetic hidden `lumen_post` row for the takedown test (deleted). It publishes
 * nothing and broadcasts nothing.
 */

import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { liteSession } from '../../qa-harness.mjs';

const BASE = process.env.QA_BASE || 'https://localhost:3443';

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
/* http + psql                                                         */
/* ------------------------------------------------------------------ */

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

// Newlines are flattened because the statement is passed through
// `JSON.stringify`, which would turn a real newline into a literal `\n` inside
// the SQL — psql then reports `syntax error at or near "\"`.
const psql = (sql) =>
  execSync(
    `docker exec lumen-b12-pg psql -U qa -d lite -tAc ${JSON.stringify(sql.replace(/\s+/g, ' ').trim())}`,
    { encoding: 'utf8' }
  ).trim();

/** A page of the ranked feed, with the lite entries picked out. */
function liteEntriesOf(entries) {
  return (entries ?? []).filter((e) => /^lumen-[0-9a-hjkmnp-tv-z]{26}$/.test(e.permlink ?? ''));
}

/**
 * ★ POLL, DO NOT ASSERT ON AN EMPTY FEED. A brand-new reader's ranked feed is
 * built in the background on first request (measured 7-16s cold in the route's
 * own notes). An empty page proves nothing about identity — there is nothing to
 * inspect — so wait for a real one and abort honestly if it never arrives.
 * `_honesty.md` rule 8: a check with nothing to inspect must FAIL.
 */
async function rankedFeed(who, query, { attempts = 10 } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await who.call(`/api/feed/for-you?${query}`);
    if ((last.body?.entries ?? []).length > 0 && last.body?.source === 'recsys') return last.body;
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  return last?.body ?? { entries: [] };
}

async function main() {
  console.log(`Target: ${BASE}`);
  psql('DELETE FROM lumen_block');

  /* ================================================================ */
  section('0. FIXTURE — a lite author the ranker can actually surface');
  /* ================================================================ */

  // Chosen from the database rather than hard-coded: whoever has the most
  // published, visible lite posts is the author whose posts recsys will fill an
  // `in_network` lane with once somebody follows them.
  const row = psql(
    `SELECT u.display_name || '|' || u.user_id || '|' || count(*)
       FROM lumen_post p JOIN lumen_user u ON u.user_id = p.user_id
      WHERE p.hive_permlink IS NOT NULL
        AND p.feed_visibility = 'visible'
        AND p.deleted_locally = false
        AND u.hive_account_name IS NULL
      GROUP BY u.display_name, u.user_id
      ORDER BY count(*) DESC LIMIT 1`
  );
  const [authorHandle, authorUserId, authorPosts] = row.split('|');
  check(
    'a lite author with published posts exists to test with',
    Boolean(authorHandle) && Number(authorPosts) >= 3,
    `@${authorHandle} (${authorUserId}) with ${authorPosts} published posts`
  );
  if (!authorHandle) {
    console.log('\n  ABORT: no published lite author in this database. Nothing to prove.');
    process.exit(2);
  }
  const publisher = psql(
    `SELECT DISTINCT hive_author FROM lumen_post WHERE user_id = '${authorUserId}' AND hive_author IS NOT NULL LIMIT 1`
  );

  /* ================================================================ */
  section('1. SETUP — two readers who follow that author');
  /* ================================================================ */

  const blocker = await liteSession(`0x${randomBytes(32).toString('hex')}`, 'fyblocker');
  const blockerCaller = caller(blocker.cookies, blocker.username);
  const third = await liteSession(`0x${randomBytes(32).toString('hex')}`, 'fythird');
  const thirdCaller = caller(third.cookies, third.username);
  check(
    'two lite readers signed up',
    Boolean(blocker.username) && Boolean(third.username),
    `@${blocker.username}, @${third.username}`
  );

  for (const who of [blockerCaller, thirdCaller]) {
    const r = await who.call('/api/lite/follow', {
      method: 'POST',
      body: { followeeName: authorHandle }
    });
    check(`@${who.label} follows @${authorHandle}`, r.status === 200, `status=${r.status}`);
  }

  /* ================================================================ */
  section('2. IDENTITY ON THE SERVED PAGE — `_lite`, title, url');
  /* ================================================================ */

  const page = await rankedFeed(blockerCaller, 'limit=30&refresh=1');
  const entries = page.entries ?? [];
  const lite = liteEntriesOf(entries);
  check(
    'the ranked page contains lite posts to inspect',
    lite.length > 0,
    `${lite.length} of ${entries.length} entries, source=${page.source}`
  );
  if (lite.length === 0) {
    console.log(
      '\n  ABORT: the ranker returned no lite posts for a reader who follows a lite author. ' +
        'Refusing to assert on nothing.'
    );
    process.exit(2);
  }

  check(
    '★ every lite entry carries `_lite`',
    lite.every((e) => e._lite),
    `${lite.filter((e) => e._lite).length}/${lite.length} carry it`
  );
  check(
    '★ every lite entry carries `_lite.userId` — the key blocking resolves on',
    lite.every((e) => e._lite?.userId === authorUserId),
    `sample=${JSON.stringify(lite[0]._lite ?? null)}`
  );
  check(
    '`_lite.chainAuthor` is the shared publishing account',
    lite.every((e) => e._lite?.chainAuthor === publisher),
    `expected @${publisher}, got ${JSON.stringify([...new Set(lite.map((e) => e._lite?.chainAuthor))])}`
  );

  // The title Hivemind synthesises for a container child, which is what a reader
  // was being shown for EVERY lite post on the site.
  const stillRe = lite.filter((e) => /^RE: /.test(e.title ?? ''));
  check(
    '★ no lite entry is served with the container\'s synthesised "RE: …" title',
    stillRe.length === 0,
    `${stillRe.length} of ${lite.length} still "RE: …" (e.g. ${JSON.stringify(stillRe[0]?.title ?? '')})`
  );
  {
    // Compared against the row Lumen actually holds — the only place the real
    // title exists once the body is pruned at publish time.
    const bad = [];
    for (const e of lite.slice(0, 8)) {
      const real = psql(
        `SELECT title FROM lumen_post WHERE hive_permlink = '${e.permlink.replace(/'/g, "''")}'`
      );
      if (real && real !== e.title) bad.push(`${e.permlink}: served="${e.title}" db="${real}"`);
    }
    check(
      '★ the served title is the title in the database',
      bad.length === 0,
      bad.length ? bad[0] : `${Math.min(8, lite.length)} entries compared against lumen_post`
    );
  }

  const badUrl = lite.filter(
    (e) => e.url !== `/${e.category}/@${e.author}/${e.permlink}`
  );
  check(
    '★ the served url points at the writer\'s post, not the container',
    badUrl.length === 0,
    badUrl.length
      ? `e.g. ${badUrl[0].url}`
      : `e.g. ${lite[0].url}`
  );
  check(
    'the url no longer names the publishing account or a container permlink',
    !lite.some((e) => (e.url ?? '').includes(`@${publisher}`) || (e.url ?? '').includes('lumen-c-')),
    `sample=${lite[0].url}`
  );

  /* ================================================================ */
  section('3. CURSOR — infinite scroll past a lite post');
  /* ================================================================ */

  // A lite post's chain coordinates are what Hive can page from; the
  // re-attributed handle is not a chain author at all. Prove BOTH directions
  // against the real upstream, through our own route.
  const sample = lite[0];
  {
    const dead = await blockerCaller.call(
      `/api/feed/for-you?limit=10&startAuthor=${encodeURIComponent(sample.author)}` +
        `&startPermlink=${encodeURIComponent(sample.permlink)}`
    );
    check(
      'baseline: the HANDLE spelling is a dead end (Hive has no such post)',
      (dead.body?.entries ?? []).length === 0,
      `@${sample.author}/${sample.permlink} -> ${(dead.body?.entries ?? []).length} entries`
    );
    const alive = await blockerCaller.call(
      `/api/feed/for-you?limit=10&startAuthor=${encodeURIComponent(publisher)}` +
        `&startPermlink=${encodeURIComponent(sample.permlink)}`
    );
    check(
      '★ the CHAIN spelling pages normally, so the cursor has a working form',
      (alive.body?.entries ?? []).length > 0,
      `@${publisher}/${sample.permlink} -> ${(alive.body?.entries ?? []).length} entries`
    );
  }

  // Now the cursor the route actually emits. Slice the stored page to a length
  // whose LAST entry is a lite post — otherwise this section is vacuous.
  const liteIndex = entries.findIndex((e) => liteEntriesOf([e]).length > 0);
  check(
    'a page can be sliced so that its last entry is a lite post',
    liteIndex >= 0,
    `first lite entry at index ${liteIndex}`
  );
  if (liteIndex >= 0) {
    const sliced = await blockerCaller.call(`/api/feed/for-you?limit=${liteIndex + 1}`);
    const last = (sliced.body?.entries ?? []).slice(-1)[0];
    const cursor = sliced.body?.nextCursor;
    check(
      'the sliced page really does end on a lite post (guards the check below)',
      Boolean(last) && liteEntriesOf([last]).length > 0,
      `last=${last?.author}/${last?.permlink}`
    );
    check(
      '★ the cursor for a lite post is its CHAIN author, not the handle',
      cursor?.author === publisher && cursor?.permlink === last?.permlink,
      `nextCursor=${JSON.stringify(cursor)} (handle would be @${last?.author})`
    );
    const replay = await blockerCaller.call(
      `/api/feed/for-you?limit=10&startAuthor=${encodeURIComponent(cursor?.author ?? '')}` +
        `&startPermlink=${encodeURIComponent(cursor?.permlink ?? '')}`
    );
    check(
      '★ replaying that cursor returns a real next page (no dead end)',
      (replay.body?.entries ?? []).length > 0,
      `${(replay.body?.entries ?? []).length} entries, source=${replay.body?.source}`
    );
  }

  /* ================================================================ */
  section('4. BLOCKING — the primary surface, with a third-party oracle');
  /* ================================================================ */

  const thirdPage = await rankedFeed(thirdCaller, 'limit=30&refresh=1');
  const countFor = (body) =>
    liteEntriesOf(body?.entries).filter((e) => e._lite?.userId === authorUserId || e.author === authorHandle)
      .length;

  check(
    'baseline: the blocker receives that author\'s posts',
    countFor(page) > 0,
    `${countFor(page)} entries by @${authorHandle}`
  );
  check(
    'baseline: the THIRD-PARTY reader receives them too',
    countFor(thirdPage) > 0,
    `${countFor(thirdPage)} entries by @${authorHandle}`
  );

  {
    const r = await blockerCaller.call('/api/lite/block', {
      method: 'POST',
      body: { targetName: authorHandle, targetKind: 'lumen' }
    });
    check(
      `@${blocker.username} blocks the lite author`,
      r.status === 200 && r.body?.ok === true,
      `status=${r.status} body=${JSON.stringify(r.body)}`
    );
    check(
      'the edge is stored as u:<ULID> on both sides',
      psql(`SELECT count(*) FROM lumen_block WHERE blocked_user_id = '${authorUserId}' AND active`) === '1',
      psql(`SELECT blocker_key || ' -> ' || blocked_key FROM lumen_block WHERE active`)
    );
  }

  // NO `refresh=1`: the stored page still CONTAINS the author, so this exercises
  // the response filter in `GET` — the guarantee — rather than the ranker hint.
  const afterBlock = await blockerCaller.call('/api/feed/for-you?limit=30');
  check(
    '★ the blocked lite author is gone from the blocker\'s served feed',
    countFor(afterBlock.body) === 0,
    `${countFor(afterBlock.body)} entries by @${authorHandle} remain ` +
      `(page has ${(afterBlock.body?.entries ?? []).length} entries, cache=${afterBlock.body?.cache})`
  );

  const thirdAfter = await thirdCaller.call('/api/feed/for-you?limit=30');
  check(
    '★ THIRD-PARTY ORACLE: a reader who blocked nobody STILL receives them ' +
      '(so the filter removed a PERSON for a READER, not the post class)',
    countFor(thirdAfter.body) > 0,
    `${countFor(thirdAfter.body)} entries by @${authorHandle} for @${third.username}`
  );

  {
    await blockerCaller.call('/api/lite/unblock', {
      method: 'POST',
      body: { targetName: authorHandle, targetKind: 'lumen' }
    });
    const restored = await blockerCaller.call('/api/feed/for-you?limit=30');
    check(
      'unblocking restores them for the blocker',
      countFor(restored.body) > 0,
      `${countFor(restored.body)} entries by @${authorHandle}`
    );
  }

  /* ================================================================ */
  section('4b. A PAGE STORED BEFORE THE FIX — the hole that outlives the deploy');
  /* ================================================================ */

  // `lumen_feed_store` holds pages ASSEMBLED EARLIER, and the route serves them
  // straight to the reader. A row written before the identity fix has `author`
  // already rewritten to the handle and no `_lite` at all — which is precisely the
  // shape blocking cannot resolve. Fixing `hydrate` does not touch those rows, so
  // this reproduces one exactly and checks what the reader actually receives.
  const legacy = await liteSession(`0x${randomBytes(32).toString('hex')}`, 'fylegacy');
  const legacyCaller = caller(legacy.cookies, legacy.username);
  check('a third reader signed up for the legacy-page case', Boolean(legacy.username), `@${legacy.username}`);

  {
    const r = await legacyCaller.call('/api/lite/block', {
      method: 'POST',
      body: { targetName: authorHandle, targetKind: 'lumen' }
    });
    check(`@${legacy.username} blocks the lite author`, r.status === 200, `status=${r.status}`);
  }

  // Copied from a page we know contains this author, with `_lite` stripped from
  // every entry — the pre-fix shape, byte for byte. `built_at = now()` so it is
  // served as FRESH and no background rebuild can quietly repair it mid-test.
  // This reader has never requested a feed in this process, so the memory tier
  // cannot answer ahead of the row.
  psql(
    `INSERT INTO lumen_feed_store (viewer, feed_version, ranked, built_limit, keys, entries, lanes, built_at)
     SELECT '${legacy.username}', feed_version, ranked, built_limit, keys,
            (SELECT jsonb_agg(e - '_lite') FROM jsonb_array_elements(entries) e),
            lanes, now()
       FROM lumen_feed_store WHERE viewer = '${blocker.username}'`
  );
  const legacyRow = psql(
    `SELECT count(*) FROM lumen_feed_store, LATERAL jsonb_array_elements(entries) e
      WHERE viewer = '${legacy.username}' AND e->>'permlink' LIKE 'lumen-%' AND NOT (e ? '_lite')`
  );
  check(
    'the stored page really is in the pre-fix shape (lite entries, no `_lite`)',
    Number(legacyRow) > 0,
    `${legacyRow} lite entries with no _lite`
  );

  const legacyServed = await legacyCaller.call('/api/feed/for-you?limit=30');
  check(
    '★ a lite post the server cannot attribute is NOT served to a reader who ' +
      'blocked its author (the pre-fix rows cannot outlive the fix)',
    countFor(legacyServed.body) === 0,
    `${countFor(legacyServed.body)} entries by @${authorHandle}, ` +
      `page has ${(legacyServed.body?.entries ?? []).length} (cache=${legacyServed.body?.cache})`
  );
  check(
    'the rest of that page is still served (withholding, not blanking)',
    (legacyServed.body?.entries ?? []).length > 0,
    `${(legacyServed.body?.entries ?? []).length} entries survive`
  );
  check(
    'and its cursor is still a chain author, so the reader can still scroll',
    !legacyServed.body?.nextCursor ||
      !/^lumen-/.test(legacyServed.body.nextCursor.permlink ?? '') ||
      legacyServed.body.nextCursor.author === publisher,
    `nextCursor=${JSON.stringify(legacyServed.body?.nextCursor)}`
  );

  await legacyCaller.call('/api/lite/unblock', {
    method: 'POST',
    body: { targetName: authorHandle, targetKind: 'lumen' }
  });

  /* ================================================================ */
  section('5. ENGAGEMENT — a taken-down post, addressed by its DISPLAY NAME');
  /* ================================================================ */

  // A synthetic row rather than hiding a real one: this must not disturb any
  // other feed, and it is deleted at the end either way. `hive_permlink` follows
  // the exact shape `publisher/permlink.ts` mints, because that shape is what the
  // guard keys on.
  // ★ `post_id` and `hive_permlink` are NOT independent: a Lumen permlink is
  // `lumen-<lowercased post id>` and every resolver in the app recovers the id
  // straight back out of it. A probe row whose two halves disagree would be
  // unresolvable and the test would pass for the wrong reason.
  const hiddenId = psql(
    `INSERT INTO lumen_post (post_id, user_id, display_name_snapshot, tier, title, body,
                             feed_visibility, publish_mode, hive_author, hive_permlink)
     SELECT upper(t.x), '${authorUserId}', '${authorHandle}', 'normal', 'takedown probe', '',
            'hidden', 'proxy', '${publisher}', 'lumen-' || t.x
       FROM (SELECT substr(md5(random()::text), 1, 26) AS x) t
     RETURNING post_id || '|' || hive_permlink`
  );
  // ★ FIRST LINE ONLY. `psql -tAc` prints the RETURNING row AND the command tag
  // ("INSERT 0 1") for a writing statement. Taking the whole output glued the tag
  // onto the permlink, which then matched no row — and every takedown assertion
  // in this section passed/failed for that reason instead of the real one. Caught
  // by reading the evidence string, which had the tag in it.
  const [hiddenPostId, hiddenPermlink] = hiddenId.split('\n')[0].trim().split('|');
  check(
    'a hidden lite post exists to probe',
    Boolean(hiddenPermlink),
    `${hiddenPostId} -> @${publisher}/${hiddenPermlink} (feed_visibility=hidden)`
  );

  {
    const chainCoords = await thirdCaller.call(
      `/api/lite/engagement?author=${publisher}&permlink=${hiddenPermlink}`
    );
    check(
      'baseline: the CHAIN spelling is already refused (404)',
      chainCoords.status === 404,
      `status=${chainCoords.status} body=${JSON.stringify(chainCoords.body)}`
    );
    const displayCoords = await thirdCaller.call(
      `/api/lite/engagement?author=${authorHandle}&permlink=${hiddenPermlink}`
    );
    check(
      '★ the DISPLAY-NAME spelling — the one the card hands the client — is refused too',
      displayCoords.status === 404,
      `status=${displayCoords.status} body=${JSON.stringify(displayCoords.body)}`
    );
    const vote = await thirdCaller.call('/api/lite/vote', {
      method: 'POST',
      body: { author: authorHandle, permlink: hiddenPermlink, weight: 10000 }
    });
    check(
      '★ a VOTE through the display-name coordinates is refused (target_unavailable)',
      vote.status === 404 && vote.body?.error === 'target_unavailable',
      `status=${vote.status} body=${JSON.stringify(vote.body)}`
    );
    const rows = psql(
      `SELECT count(*) FROM lumen_vote WHERE target_permlink = '${hiddenPermlink}'`
    );
    check('no vote row was written for the hidden post', rows === '0', `rows=${rows}`);

    // A post that is NOT taken down must still be engageable through the same
    // display-name coordinates, or the guard has simply broken voting.
    const okPermlink = psql(
      `SELECT hive_permlink FROM lumen_post
        WHERE user_id = '${authorUserId}' AND feed_visibility = 'visible'
          AND deleted_locally = false AND hive_permlink IS NOT NULL LIMIT 1`
    );
    const live = await thirdCaller.call(
      `/api/lite/engagement?author=${authorHandle}&permlink=${okPermlink}`
    );
    check(
      'a VISIBLE lite post is still served through the same coordinates (not over-blocked)',
      live.status === 200,
      `@${authorHandle}/${okPermlink} -> status=${live.status}`
    );
    const liveVote = await thirdCaller.call('/api/lite/vote', {
      method: 'POST',
      body: { author: authorHandle, permlink: okPermlink, weight: 10000 }
    });
    check(
      'and a vote on it still succeeds',
      liveVote.status === 200,
      `status=${liveVote.status} body=${JSON.stringify(liveVote.body)}`
    );
    psql(`DELETE FROM lumen_vote WHERE target_permlink = '${okPermlink}'`);
  }

  /* ================================================================ */
  section('6. CLEANUP');
  /* ================================================================ */

  psql('DELETE FROM lumen_block');
  // The vote row too: a PRE-fix run writes one (that is the bug), and leaving it
  // behind would inflate the hidden post's tally forever.
  psql(`DELETE FROM lumen_vote WHERE target_permlink = '${hiddenPermlink}'`);
  psql(`DELETE FROM lumen_post WHERE post_id = '${hiddenPostId}'`);
  for (const handle of [blocker.username, third.username, legacy.username]) {
    if (handle) {
      psql(`DELETE FROM lumen_feed_store WHERE viewer = '${handle}'`);
      psql(`DELETE FROM lumen_feed_served WHERE viewer = '${handle}'`);
      psql(`DELETE FROM lumen_user WHERE display_name = '${handle}'`);
    }
  }
  check(
    'no block rows and no probe post left behind',
    psql('SELECT count(*) FROM lumen_block') === '0' &&
      psql(`SELECT count(*) FROM lumen_post WHERE post_id = '${hiddenPostId}'`) === '0',
    'cleaned'
  );

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
