/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * Self-test for LITE quote reblogs (spec v2 8.1, test plan 8.4 A1/A5/A6/A7/A10/A15/A22):
 * the quote service, the real publisher drain, and the quote index together. Real
 * Postgres; the Hive node is a fake that enforces the two consensus rules these paths
 * collide with (a comment's parent can never change; an empty body is invalid) and a
 * stubbed `condenser_api.get_content` for the posts being quoted.
 *
 *   L1  a quote of a Hive post: post row, quote-container parent, create job, pending
 *       quote row and the reblog, together
 *   L2  a double submit returns the first quote and writes nothing more, also when two
 *       tabs submit at the same moment (A15)
 *   L3  the drain opens the quote container and publishes the quote: parent, author,
 *       body (caption, link line, lite footer), marker, declined payout; then `live` (A1)
 *   L4  an edit: same permlink, same parent, new text; the card text follows (A5)
 *   L5  a quote is not on the Comments tab; /api/lite/posts cannot edit it
 *   L6  the quoted post disappears before publishing: rejected, removed, never sent (A10)
 *   L7  removed while pending: never sent, the reblog stays (A6); with undo, it goes (A7)
 *   L8  removed after publishing, when Hive refuses a delete: blanked with a body Hive
 *       accepts, the marker kept
 *   L9  refusals: switched off, empty, too long, a comment, a quote, the owner's block
 *   L10 a Lumen (lite) post quoted: named by handle without @, linked at its Lumen URL
 *
 * SAFETY: refuses unless LITE_DATABASE_URL ends in `_selftest`; truncates tables.
 *
 * Run (from apps/blog):
 *   LITE_ACCOUNTS_ENABLED=yes LITE_QUOTE_REBLOGS_ENABLED=yes \
 *   LITE_FRONTEND_ACCOUNT_MAINNET=pub LITE_FRONTEND_ACCOUNT_MIRRORNET=pub LITE_FRONTEND_ACCOUNT_TESTNET=pub \
 *   LITE_DATABASE_URL=postgresql://user:pw@127.0.0.1:5433/lite_selftest \
 *   pnpm exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/lite/content/lite-quote.selftest.ts
 */
const DB_URL = process.env.LITE_DATABASE_URL || '';
if (!/_selftest(\?.*)?$/.test(DB_URL)) {
  console.error('REFUSING TO RUN: LITE_DATABASE_URL must name a scratch database ending in "_selftest".');
  process.exit(1);
}

type Fixture = Record<string, unknown>;
const chain = new Map<string, Fixture>();
// Only get_content is answered; every other call fails, and the RC pre-flight fails open.
globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
  const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string; params?: [string, string] };
  if (body.method !== 'condenser_api.get_content') throw new Error('network disabled in self-test');
  const [a, p] = body.params ?? ['', ''];
  const hit = chain.get(`${a}/${p}`);
  // Missing: an assertion error, as current nodes answer it (not an empty shell).
  if (!hit) {
    const error = { code: -32602, message: 'Assert Exception', data: { code: 10, extension: { assertion_expression: `Post ${a}/${p} does not exist` } } };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error }), { status: 200 });
  }
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: hit }), { status: 200 });
}) as typeof fetch;

import { DELETED_BODY } from '@transaction/lib/deleted-body';
import { User } from '@smart-signer/types/common';
import { query } from '../db/pool';
import { runMigrations } from '../db/migrate';
import { liteConfig } from '../config';
import type { SessionRef } from '../types';
import * as posts from '../repositories/post-repository';
import * as users from '../repositories/user-repository';
import * as quotes from '../repositories/quote-repository';
import * as containers from '../repositories/container-repository';
import { block } from '../repositories/block-repository';
import { CommentOp, PostBroadcaster, setBroadcaster } from '../publisher/broadcaster';
import { buildPermlink } from '../publisher/permlink';
import { runPublisherOnce } from '../publisher/worker';
import { createLitePost } from './post-service';
import { removeLiteQuote, saveLiteQuote } from './quote-service';

const PUB = liteConfig.frontendAccount;
let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

function put(author: string, permlink: string, fields: Fixture = {}): void {
  chain.set(`${author}/${permlink}`, { author, permlink, parent_author: '', parent_permlink: 'hive', depth: 0, title: 'How RC works', category: 'hive-139531', body: 'x', json_metadata: '{}', children: 0, net_rshares: 0, cashout_time: '2026-10-01T00:00:00', ...fields });
}

// ── the fake Hive node ───────────────────────────────────────────────────────
const ops: CommentOp[] = [];
const hardDeletes: string[] = [];
const onChain = new Set<string>();
const parentOf = new Map<string, string>();
let allowDelete = true;
const fake: PostBroadcaster = {
  async broadcastComment(op: CommentOp) {
    const parent = `${op.parentAuthor}/${op.parentPermlink}`;
    const pinned = parentOf.get(op.permlink);
    if (pinned && pinned !== parent) throw new Error('The parent of a comment cannot change.');
    if (op.body.length === 0) throw new Error('Body is empty');
    parentOf.set(op.permlink, parent);
    ops.push({ ...op });
    onChain.add(`${op.author}/${op.permlink}`);
    return { trxId: `trx-${ops.length}` };
  },
  async postExists(author: string, permlink: string) {
    return onChain.has(`${author}/${permlink}`) || chain.has(`${author}/${permlink}`);
  },
  async deleteComment(author: string, permlink: string) {
    hardDeletes.push(permlink);
    onChain.delete(`${author}/${permlink}`);
    return { trxId: `del-${hardDeletes.length}` };
  },
  async canDelete() {
    return allowDelete;
  }
} as unknown as PostBroadcaster;

const SESSION_REF: SessionRef = {};
const sessionOf = (userId: string) => ({ userId, account_tier: 'lite', isLoggedIn: true }) as unknown as User;

/** Drain until nothing is left to do (container root first, then children, paced). */
async function drainAll(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const { rows } = await query<{ n: string }>(`SELECT count(*)::text n FROM publish_job WHERE status = 'pending' AND next_attempt_at <= now()`);
    if (rows[0].n === '0') return;
    await runPublisherOnce('selftest');
  }
}

async function jobsOf(postId: string) {
  const { rows } = await query<{ job_type: string; status: string; last_error: string | null }>(
    `SELECT job_type, status, last_error FROM publish_job WHERE post_id = $1 ORDER BY created_at`,
    [postId]
  );
  return rows;
}

async function reblogActive(userId: string, author: string, permlink: string): Promise<boolean> {
  const { rows } = await query<{ active: boolean }>(
    `SELECT active FROM lumen_reblog WHERE reblogger_user_id = $1 AND target_author = $2 AND target_permlink = $3`,
    [userId, author, permlink]
  );
  return rows[0]?.active === true;
}

async function main(): Promise<void> {
  if (!PUB || !liteConfig.quoteReblogsEnabled || !liteConfig.enabled) {
    console.error('Set LITE_ACCOUNTS_ENABLED=yes, LITE_QUOTE_REBLOGS_ENABLED=yes and LITE_FRONTEND_ACCOUNT_*. Aborting.');
    process.exit(1);
  }
  await runMigrations();
  await query('TRUNCATE lumen_user, lumen_container, lumen_quote, lumen_block, rate_counter CASCADE');
  setBroadcaster(fake);
  const alice = (await users.createUser({ displayName: 'alice' })).userId;
  const erin = (await users.createUser({ displayName: 'erin' })).userId;
  put('bob', 'how-rc-works');

  console.log('L1  a quote of a Hive post');
  const r1 = await saveLiteQuote(sessionOf(alice), SESSION_REF, 'bob', 'how-rc-works', '  Clearest RC explainer.  ');
  const q1 = r1.ok ? r1.value : null;
  check('accepted, pending, caption trimmed', !!q1 && q1.state === 'pending' && q1.bodyCache === 'Clearest RC explainer.', JSON.stringify(r1));
  const post1 = q1?.litePostId ? await posts.getPostById(q1.litePostId) : null;
  check('its post row is a quote of bob/how-rc-works', post1?.parentRef?.type === 'quote' && post1.parentRef.target.permlink === 'how-rc-works');
  const pin1 = post1 ? await posts.getPublishParent(post1.postId) : null;
  check('pinned under a QUOTE container of the publisher', pin1?.author === PUB && !!pin1?.permlink.startsWith('lumen-q-'), JSON.stringify(pin1));
  check('the quote row names the post and its future permlink', !!post1 && q1?.quotePermlink === buildPermlink(post1.postId) && q1?.quoteAuthor === PUB && q1?.containerPermlink === pin1?.permlink);
  check('a create job is queued', !!post1 && (await jobsOf(post1.postId)).some((j) => j.job_type === 'create' && j.status === 'pending'));
  check('the reblog came with it', await reblogActive(alice, 'bob', 'how-rc-works'));

  console.log('L2  double submit');
  const r2 = await saveLiteQuote(sessionOf(alice), SESSION_REF, 'bob', 'how-rc-works', 'Clearest RC explainer.');
  check('the same quote comes back', r2.ok && r2.value.quoteId === q1?.quoteId);
  const { rows: quotePosts } = await query<{ n: string }>(`SELECT count(*)::text n FROM lumen_post WHERE user_id = $1 AND parent_ref ->> 'type' = 'quote'`, [alice]);
  check('...and no second post row was written', quotePosts[0].n === '1', quotePosts[0].n);
  // Two tabs at once: both pass the "already quoted?" read before either commits, so
  // only the unique index and the rollback stand between them and two posts.
  put('bob', 'race');
  const [ra, rb] = await Promise.all([
    saveLiteQuote(sessionOf(alice), SESSION_REF, 'bob', 'race', 'Tab one.'),
    saveLiteQuote(sessionOf(alice), SESSION_REF, 'bob', 'race', 'Tab two.')
  ]);
  const { rows: racePosts } = await query<{ n: string }>(
    `SELECT count(*)::text n FROM lumen_post WHERE user_id = $1 AND parent_ref -> 'target' ->> 'permlink' = 'race'`,
    [alice]
  );
  const { rows: raceJobs } = await query<{ n: string }>(
    `SELECT count(*)::text n FROM publish_job j JOIN lumen_post p ON p.post_id = j.post_id WHERE p.user_id = $1 AND p.parent_ref -> 'target' ->> 'permlink' = 'race'`,
    [alice]
  );
  check('two tabs at once: one quote, one post, one job (the loser rolled back)', ra.ok && rb.ok && ra.value.quoteId === rb.value.quoteId && racePosts[0].n === '1' && raceJobs[0].n === '1', `${racePosts[0].n} posts, ${raceJobs[0].n} jobs`);

  console.log('L3  the drain publishes it');
  await drainAll();
  const root = ops.find((o) => o.parentAuthor === '' && o.permlink === pin1?.permlink);
  check('the quote container root went out first', !!root && root.title.startsWith('Lumen reblog comments') && ops.indexOf(root) === 0, JSON.stringify(ops.map((o) => o.permlink)));
  const child = ops.find((o) => o.permlink === q1?.quotePermlink);
  const meta = child ? JSON.parse(child.jsonMetadata) : {};
  check('the quote went out under the quote container, as the publisher', child?.parentAuthor === PUB && child?.parentPermlink === pin1?.permlink && child?.author === PUB);
  check('body: caption, link line with @bob, lite footer', !!child && child.body.startsWith('Clearest RC explainer.\n\nReblogged from @bob: [How RC works](') && /Posted via Lumen by alice/.test(child.body), JSON.stringify(child?.body));
  check('marker and lite fields in the metadata', meta.type === 'lumen_quote' && meta.quote_of?.permlink === 'how-rc-works' && meta.lumen_user_id === alice, JSON.stringify(meta));
  check('payout declined, like every lite post', child?.declinePayout === true);
  check('the quote is live now', (await quotes.findById(q1!.quoteId))?.state === 'live');

  console.log('L4  edit');
  const r4 = await saveLiteQuote(sessionOf(alice), SESSION_REF, 'bob', 'how-rc-works', 'Edited: still the clearest.');
  check('the edit is accepted on the same quote, card text follows', r4.ok && r4.value.quoteId === q1?.quoteId && r4.value.bodyCache === 'Edited: still the clearest.', JSON.stringify(r4));
  await drainAll();
  const edits = ops.filter((o) => o.permlink === q1?.quotePermlink);
  const last = edits[edits.length - 1];
  check('broadcast again: same permlink, same parent, new text', edits.length === 2 && last.parentPermlink === pin1?.permlink && last.body.startsWith('Edited: still the clearest.'), JSON.stringify(edits.map((e) => e.body.slice(0, 30))));
  check('the edit keeps the marker', JSON.parse(last.jsonMetadata).type === 'lumen_quote');

  console.log('L5  not a comment');
  const comments = await posts.getUserPosts(alice, { limit: 50, kind: 'comments' });
  const postsTab = await posts.getUserPosts(alice, { limit: 50, kind: 'posts' });
  check('not on the Comments tab, not on the Posts tab as a post', !comments.some((p) => p.postId === post1?.postId) && !postsTab.some((p) => p.postId === post1?.postId));
  const viaPosts = await createLitePost(sessionOf(alice), { tier: 'normal', body: 'hijack', editOfPostId: post1!.postId }, SESSION_REF);
  check('/api/lite/posts cannot edit a quote', viaPosts.status === 'error');

  console.log('L6  the quoted post disappears before publishing');
  put('carol', 'gone-soon');
  const r6 = await saveLiteQuote(sessionOf(alice), SESSION_REF, 'carol', 'gone-soon', 'Worth a read.');
  chain.delete('carol/gone-soon');
  const before6 = ops.length;
  await drainAll();
  const q6 = r6.ok ? await quotes.findById(r6.value.quoteId) : null;
  const jobs6 = r6.ok && r6.value.litePostId ? await jobsOf(r6.value.litePostId) : [];
  check('rejected with a reason, nothing broadcast', jobs6.some((j) => j.status === 'rejected' && /reblogged post no longer exists/.test(j.last_error ?? '')) && ops.length === before6, JSON.stringify(jobs6));
  check('the quote is removed and its post deleted (the sweep never re-queues it)', q6?.state === 'removed' && (await posts.getPostById(q6.litePostId!))?.deletedLocally === true);

  console.log('L7  removed while pending');
  put('dave', 'p1');
  put('dave', 'p2');
  const r7 = await saveLiteQuote(sessionOf(alice), SESSION_REF, 'dave', 'p1', 'One.');
  await removeLiteQuote(alice, 'dave', 'p1', false);
  const r7b = await saveLiteQuote(sessionOf(alice), SESSION_REF, 'dave', 'p2', 'Two.');
  await removeLiteQuote(alice, 'dave', 'p2', true);
  const before7 = ops.length;
  await drainAll();
  check('neither reaches Hive', ops.length === before7 && !ops.some((o) => r7.ok && o.permlink === r7.value.quotePermlink));
  check('both quotes removed', r7.ok && r7b.ok && (await quotes.findById(r7.value.quoteId))?.state === 'removed' && (await quotes.findById(r7b.value.quoteId))?.state === 'removed');
  check('without undo the reblog stays; with undo it goes', (await reblogActive(alice, 'dave', 'p1')) && !(await reblogActive(alice, 'dave', 'p2')));

  console.log('L8  removed after publishing, Hive refuses a delete');
  allowDelete = false;
  await removeLiteQuote(alice, 'bob', 'how-rc-works', false);
  await drainAll();
  const blank = ops.filter((o) => o.permlink === q1?.quotePermlink).pop();
  const blankMeta = blank ? JSON.parse(blank.jsonMetadata) : {};
  check('blanked with a body Hive accepts, same parent', blank?.body === DELETED_BODY && blank.parentPermlink === pin1?.permlink, JSON.stringify(blank?.body));
  check('the marker is kept and it says deleted', blankMeta.type === 'lumen_quote' && blankMeta.deleted === true);
  check('the quote is removed', (await quotes.findById(q1!.quoteId))?.state === 'removed');
  allowDelete = true;

  console.log('L9  refusals');
  (liteConfig as { quoteReblogsEnabled: boolean }).quoteReblogsEnabled = false;
  const off = await saveLiteQuote(sessionOf(alice), SESSION_REF, 'bob', 'how-rc-works', 'x');
  (liteConfig as { quoteReblogsEnabled: boolean }).quoteReblogsEnabled = true;
  check("switched off: 'disabled'", !off.ok && off.reason === 'disabled');
  const empty = await saveLiteQuote(sessionOf(alice), SESSION_REF, 'bob', 'how-rc-works', '   ');
  check("empty: 'empty' (that is a plain reblog)", !empty.ok && empty.reason === 'empty');
  const long = await saveLiteQuote(sessionOf(alice), SESSION_REF, 'bob', 'how-rc-works', 'x'.repeat(281));
  check("281 characters: 'too_long'", !long.ok && long.reason === 'too_long');
  put('carol', 're-bob', { parent_author: 'bob', parent_permlink: 'how-rc-works', depth: 1 });
  const cmt = await saveLiteQuote(sessionOf(alice), SESSION_REF, 'carol', 're-bob', 'x');
  check("a comment: 'not_a_post'", !cmt.ok && cmt.reason === 'not_a_post');
  put('dave', 'lumen-rq-0000000000000000', { parent_author: PUB, parent_permlink: 'lumen-q-01bbb', depth: 1 });
  const qq = await saveLiteQuote(sessionOf(alice), SESSION_REF, 'dave', 'lumen-rq-0000000000000000', 'x');
  check("a quote: 'is_a_quote' (A22)", !qq.ok && qq.reason === 'is_a_quote');
  await block({ hive: 'frank' }, { userId: erin });
  put('frank', 'mine');
  const blk = await saveLiteQuote(sessionOf(erin), SESSION_REF, 'frank', 'mine', 'x');
  check("the owner blocked them: 'blocked'", !blk.ok && blk.reason === 'blocked');

  console.log('L10 a Lumen post quoted');
  const erinPost = await createLitePost(sessionOf(erin), { tier: 'normal', body: 'Photos from the coast' }, SESSION_REF);
  if (erinPost.status !== 'ok') throw new Error('fixture post failed');
  const erinPermlink = buildPermlink(erinPost.post.postId);
  put(PUB, erinPermlink, { parent_author: PUB, parent_permlink: 'lumen-c-01zzz', depth: 1, title: 'Photos from the coast', category: 'lumen' });
  const r10 = await saveLiteQuote(sessionOf(alice), SESSION_REF, PUB, erinPermlink, 'Lovely.');
  const lite10 = r10.ok && r10.value.litePostId ? await posts.getPostById(r10.value.litePostId) : null;
  check('named by handle, no @, linked at its Lumen URL', !!lite10 && lite10.body.includes(`Reblogged from a post by erin on Lumen: [Photos from the coast](`) && lite10.body.includes(`/lumen/@erin/${erinPermlink})`) && !lite10.body.includes('@erin:') && !lite10.body.includes(`@${PUB}`), JSON.stringify(lite10?.body));

  await query('TRUNCATE lumen_user, lumen_container, lumen_quote, lumen_block, rate_counter CASCADE');
  console.log(failures === 0 ? `PASS — ${checks} checks` : `FAIL — ${failures} of ${checks} checks failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('FAIL — the self-test threw:', error);
  process.exit(1);
});
