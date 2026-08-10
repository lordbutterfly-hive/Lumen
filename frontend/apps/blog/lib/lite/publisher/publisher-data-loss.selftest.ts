/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * Self-test for FOUR data-loss defects in the Lumen lite publisher.
 *
 * Every case here was first written to FAIL against the code as it stood, so the
 * failure IS the reproduction. Each one drives the real service functions
 * (`createLitePost`, `takeDownPost`, `moderateUser`, `runPublisherOnce`) against a
 * real Postgres, with only the Hive broadcaster faked — because the whole class of
 * bug being hunted lives in the seam between "what the worker decided" and "what it
 * actually broadcast", and a mocked repository would hide exactly that.
 *
 *   B1  every edit of a PUBLISHED post is destroyed: the `!already` crash-guard
 *       skips the broadcast for an `update` (already === true by definition) and
 *       control falls through to markPostPublished(pruneBody) -> body = ''.
 *   B2  a post hidden at drain time burns its whole retry budget on terminal
 *       rejections, so restoring it can never bring it back — while queueHealth
 *       reports a perfectly empty queue.
 *   B3  a takedown queued for a user who is then banned is parked as 'holding'
 *       by holdPendingForUser (no job_type filter) and never executes.
 *   B4  a takedown of a lite REPLY builds its soft-delete op from the placeholder
 *       parent (`lite-<ulid>`) instead of the parent's real on-chain name, so Hive
 *       refuses it permanently ("The parent of a comment cannot change").
 *
 * SAFETY. This script writes and TRUNCATES. It refuses to start unless
 * LITE_DATABASE_URL names a database ending in `_selftest`, and it installs its own
 * in-memory broadcaster, so it can never reach a real Hive node. `fetch` is stubbed
 * for the same reason (the RC pre-flight would otherwise call out).
 *
 * Run (from apps/blog):
 *   LITE_ACCOUNTS_ENABLED=yes \
 *   LITE_FRONTEND_ACCOUNT_MAINNET=test-publisher \
 *   LITE_FRONTEND_ACCOUNT_MIRRORNET=test-publisher \
 *   LITE_FRONTEND_ACCOUNT_TESTNET=test-publisher \
 *   LITE_DATABASE_URL=postgresql://user:pw@127.0.0.1:55433/lite_selftest \
 *   npx tsx lib/lite/publisher/publisher-data-loss.selftest.ts
 */

const DB_URL = process.env.LITE_DATABASE_URL ?? '';
if (!/_selftest(\?.*)?$/.test(DB_URL)) {
  console.error(
    'REFUSING TO RUN: LITE_DATABASE_URL must point at a scratch database whose name ends in "_selftest".\n' +
      'This script truncates tables; it must never be aimed at the live lite database.'
  );
  process.exit(1);
}
// The RC pre-flight calls a Hive node. Stub it before anything imports it: the guard
// fails open on an unreachable endpoint, which is exactly what a test wants.
globalThis.fetch = (async () => {
  throw new Error('network disabled in self-test');
}) as unknown as typeof fetch;

import { User } from '@smart-signer/types/common';
import { liteConfig } from '../config';
import { query } from '../db/pool';
import { LumenPost, PublishJob, SessionRef } from '../types';
import * as posts from '../repositories/post-repository';
import * as jobs from '../repositories/publish-job-repository';
import * as users from '../repositories/user-repository';
import * as containers from '../repositories/container-repository';
import { createLitePost, takeDownPost, reconcileOrphans, recoverStranded } from '../content/post-service';
import { moderateUser, moderatePost } from '../moderation/moderation-service';
import { CommentOp, PostBroadcaster, setBroadcaster } from './broadcaster';
import { buildPermlink } from './permlink';
import { runPublisherOnce } from './worker';

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: string): void {
  checks += 1;
  if (ok) console.log(`ok    ${name}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

// ── the fake Hive node ───────────────────────────────────────────────────────
interface FakeBroadcaster extends PostBroadcaster {
  ops: CommentOp[];
  hardDeletes: string[];
  /** Permlinks the fake node believes exist. */
  onChain: Set<string>;
}

/**
 * A Hive stand-in that enforces the one consensus rule these bugs collide with:
 * a comment's parent can never change (hive_evaluator_social.cpp:294/302). It
 * remembers the parent each permlink was first broadcast under and throws the
 * real message if a later op names a different one.
 */
function fakeBroadcaster(opts: { canDelete?: boolean } = {}): FakeBroadcaster {
  const parentOf = new Map<string, string>();
  const fake: FakeBroadcaster = {
    ops: [],
    hardDeletes: [],
    onChain: new Set<string>(),
    async broadcastComment(op: CommentOp) {
      const pinned = parentOf.get(op.permlink);
      const parent = `${op.parentAuthor}/${op.parentPermlink}`;
      if (pinned && pinned !== parent) {
        throw new Error('The parent of a comment cannot change.');
      }
      parentOf.set(op.permlink, parent);
      fake.ops.push({ ...op });
      fake.onChain.add(op.permlink);
      return { trxId: `trx-${fake.ops.length}` };
    },
    async postExists(_author: string, permlink: string) {
      return fake.onChain.has(permlink);
    },
    async deleteComment(_author: string, permlink: string) {
      fake.hardDeletes.push(permlink);
      fake.onChain.delete(permlink);
      return { trxId: `del-${fake.hardDeletes.length}` };
    },
    async canDelete() {
      return opts.canDelete ?? true;
    }
  };
  return fake;
}

// ── fixtures ─────────────────────────────────────────────────────────────────
const PUB = liteConfig.frontendAccount;

async function resetDb(): Promise<void> {
  await query('TRUNCATE lumen_user, lumen_container, lumen_moderation_action, rate_counter CASCADE');
}

function session(userId: string): User {
  return { userId, account_tier: 'lite' } as unknown as User;
}

/**
 * The cookie half of a session. A fresh row is epoch 0 with nothing revoked, so an
 * empty ref is the "signed in normally" case — `createLitePost` now takes it
 * explicitly rather than defaulting, so a caller cannot forget to pass one.
 */
const SESSION_REF: SessionRef = {};

async function newUser(name: string): Promise<string> {
  const u = await users.createUser({ displayName: name });
  return u.userId;
}

/** Create through the real intake service, so the job and the parent pin are real. */
async function writePost(
  userId: string,
  body: string,
  parentRef?: { type: 'chain'; author: string; permlink: string }
): Promise<LumenPost> {
  const res = await createLitePost(session(userId), { tier: 'normal', body, parentRef }, SESSION_REF);
  if (res.status !== 'ok') throw new Error(`createLitePost failed: ${res.code} ${res.message}`);
  // Open the container this post was slotted into: every case below is about what
  // happens AFTER a post can publish, not about container opening.
  const pin = await posts.getPublishParent(res.post.postId);
  if (pin) {
    const container = await containers.findByPermlink(pin.author, pin.permlink);
    if (container && !container.publishedAt) await containers.markPublished(container.containerId);
  }
  return res.post;
}

/** Put a post on chain the way a successful drain would, including the fake node. */
async function publishIt(post: LumenPost, fake: FakeBroadcaster): Promise<void> {
  const permlink = buildPermlink(post.postId);
  const pin = await posts.getPublishParent(post.postId);
  await fake.broadcastComment({
    parentAuthor: pin?.author ?? '',
    parentPermlink: pin?.permlink ?? '',
    author: PUB,
    permlink,
    title: post.title,
    body: post.body,
    jsonMetadata: '{}',
    declinePayout: true
  });
  await posts.markPostPublished(post.postId, PUB, permlink, { pruneBody: false });
  await query(`UPDATE publish_job SET status = 'published' WHERE post_id = $1 AND job_type = 'create'`, [
    post.postId
  ]);
}

async function jobRows(
  postId: string
): Promise<{ job_type: string; status: string; last_error: string | null }[]> {
  const { rows } = await query<{ job_type: string; status: string; last_error: string | null }>(
    `SELECT job_type, status, last_error FROM publish_job WHERE post_id = $1 ORDER BY created_at`,
    [postId]
  );
  return rows;
}

async function drainOnce(): Promise<string> {
  return runPublisherOnce('selftest');
}

/**
 * Put a post into the state the 38 stranded live rows are in: every job terminal AND
 * the `maxGenerations` ceiling (3) reached, so the bounded orphan sweep can never
 * pick it up again. One dead job is not enough — the sweep would simply retry it,
 * which is the whole reason the ceiling exists and the whole reason a deliberate
 * recovery step has to exist alongside it.
 */
async function killJobsPastTheCeiling(postId: string, reason: string): Promise<void> {
  await query(`UPDATE publish_job SET status = 'rejected', last_error = $2 WHERE post_id = $1`, [
    postId,
    reason
  ]);
  await query(
    `INSERT INTO publish_job (job_id, post_id, job_type, status, idempotency_key, payload_snapshot, last_error)
     SELECT job_id || suffix, post_id, job_type, 'rejected', idempotency_key || suffix,
            payload_snapshot, $2
       FROM publish_job, (VALUES ('-g2'), ('-g3')) AS s(suffix)
      WHERE post_id = $1 AND job_id NOT LIKE '%-g%'`,
    [postId, reason]
  );
}

// ── B1 · an edit of a published post must reach Hive, and must not be erased ──
async function b1EditOfPublishedPost(): Promise<void> {
  console.log('\n── B1  an edit of a PUBLISHED post ─────────────────────────────');
  await resetDb();
  const fake = fakeBroadcaster();
  setBroadcaster(fake);

  const userId = await newUser('editor1');
  const post = await writePost(userId, 'ORIGINAL BODY');
  await publishIt(post, fake);

  // The real edit path: same call the composer makes when saving an edit.
  const edited = await createLitePost(
    session(userId),
    {
      tier: 'normal',
      body: 'EDITED BODY — the text the reader must end up seeing',
      editOfPostId: post.postId
    },
    SESSION_REF
  );
  check('B1 the edit is accepted', edited.status === 'ok', JSON.stringify(edited));

  const queued = (await jobRows(post.postId)).filter((j) => j.job_type === 'update');
  check('B1 an update job is queued', queued.length === 1, JSON.stringify(queued));

  const before = fake.ops.length;
  const outcome = await drainOnce();
  const broadcast = fake.ops.slice(before);

  check('B1 the drain processed the update', outcome === 'processed', `outcome=${outcome}`);
  check(
    'B1 THE EDIT WAS BROADCAST TO HIVE',
    broadcast.length === 1 && broadcast[0].body.includes('EDITED BODY'),
    broadcast.length === 0
      ? 'NOTHING was broadcast — the edit never left the database'
      : JSON.stringify(broadcast.map((o) => o.body.slice(0, 40)))
  );
  check(
    'B1 the edit targets the same permlink (an edit, not a new post)',
    broadcast[0]?.permlink === buildPermlink(post.postId),
    `permlink=${broadcast[0]?.permlink}`
  );

  const after = await posts.getPostById(post.postId);
  // Pruning is the intended hybrid model — but only ever AFTER the content reached
  // Hive. The defect is pruning a body that was never broadcast.
  const chainBody = fake.ops[fake.ops.length - 1]?.body ?? '';
  check(
    'B1 the edited text survives somewhere real (chain, or the DB if pruning is off)',
    chainBody.includes('EDITED BODY') || (after?.body ?? '').includes('EDITED BODY'),
    `chain="${chainBody.slice(0, 40)}" db="${(after?.body ?? '').slice(0, 40)}"`
  );
}

// ── B2 · a hidden post must not burn its retry budget, and must be visible ────
async function b2HiddenPostStranded(): Promise<void> {
  console.log('\n── B2  a post hidden at drain time ─────────────────────────────');
  await resetDb();
  const fake = fakeBroadcaster();
  setBroadcaster(fake);

  const userId = await newUser('stranded1');
  const post = await writePost(userId, 'CONTENT THAT MUST NOT BE STRANDED');

  // A moderator hides it while its create job is still queued — or a ban sweep does,
  // or any of the other ways feed_visibility leaves 'visible' for a while.
  await posts.setFeedVisibility(post.postId, 'hidden');

  // Three drains with the orphan sweep in between: exactly what the live queue did,
  // one job per drain, until the 3-generation ceiling was reached.
  for (let i = 0; i < 3; i++) {
    await reconcileOrphans(25);
    await drainOnce();
  }
  const generations = await jobs.countJobsForPost(post.postId);

  // The moderator changes their mind.
  await posts.setFeedVisibility(post.postId, 'visible');
  await reconcileOrphans(25);
  const outcome = await drainOnce();
  const live = await posts.getPostById(post.postId);

  check(
    'B2 a temporary hide does not exhaust the post\'s publish generations',
    generations < 3,
    `the post accumulated ${generations} job generations while hidden — the ceiling is 3, so listOrphaned can never see it again`
  );
  check(
    'B2 THE RESTORED POST REACHES HIVE',
    Boolean(live?.hivePermlink),
    `hive_permlink is still ${live?.hivePermlink ?? 'NULL'} after restore + drain (outcome=${outcome})`
  );

  // And the operator surface: a queue holding stranded content must not read empty.
  await resetDb();
  const u2 = await newUser('stranded2');
  const p2 = await writePost(u2, 'ALSO STRANDED');
  await posts.setFeedVisibility(p2.postId, 'hidden');
  for (let i = 0; i < 3; i++) {
    await reconcileOrphans(25);
    await drainOnce();
  }
  await posts.setFeedVisibility(p2.postId, 'visible');
  const health = await jobs.queueHealth();
  // `strandedPosts` is the field this fix adds; read it defensively so this file
  // compiles and RUNS against the unfixed code too — that run is the reproduction.
  const stranded = (health as { strandedPosts?: number }).strandedPosts ?? 0;
  check(
    'B2 queue health does NOT report a healthy queue while content is stranded',
    stranded > 0 || health.pending > 0 || health.holding > 0,
    `queueHealth reported pending=${health.pending} holding=${health.holding} stranded=${stranded} while a visible post sits off-chain`
  );
}

// ── B2b · reinstating a user must revive their unpublished posts ──────────────
async function b2ReinstateRequeues(): Promise<void> {
  console.log('\n── B2b reinstating a banned user ───────────────────────────────');
  await resetDb();
  const fake = fakeBroadcaster();
  setBroadcaster(fake);

  const userId = await newUser('bannedwriter');
  const post = await writePost(userId, 'WRITTEN BEFORE THE BAN');

  await moderateUser({ actor: 'selftest', userId, action: 'ban', reason: 'test', hideContent: true });
  // The drain runs while they are banned: nothing of theirs may be published.
  await reconcileOrphans(25);
  await drainOnce();
  const duringBan = await posts.getPostById(post.postId);
  check(
    'B2b nothing is published while the author is banned',
    !duringBan?.hivePermlink,
    `hive_permlink=${duringBan?.hivePermlink}`
  );

  await moderateUser({ actor: 'selftest', userId, action: 'reinstate', hideContent: true });
  await reconcileOrphans(25);
  await drainOnce();
  const after = await posts.getPostById(post.postId);
  check(
    'B2b reinstating the author publishes the post that was held',
    Boolean(after?.hivePermlink),
    `hive_permlink is still ${after?.hivePermlink ?? 'NULL'}; jobs=${JSON.stringify(
      await jobRows(post.postId)
    )}`
  );

  // ── the harder half: the job DIED while the account was down ──────────────
  // A ban lasts days; drains keep running; a job can be cancelled or exhausted in
  // that time. Releasing 'holding' rows cannot reach those, so a reinstate that only
  // releases leaves the author's work permanently off-chain — the stranded state
  // arrived at through the front door.
  await resetDb();
  const userId2 = await newUser('bannedwriter2');
  const post2 = await writePost(userId2, 'ITS JOB DIED DURING THE BAN');
  await moderateUser({ actor: 'selftest', userId: userId2, action: 'ban', reason: 'test', hideContent: true });
  // Dead, and past the generation ceiling — so the bounded orphan sweep cannot see
  // it either. Only the reinstate itself can put this post back on the road.
  await killJobsPastTheCeiling(post2.postId, 'died during the ban');

  await moderateUser({ actor: 'selftest', userId: userId2, action: 'reinstate', hideContent: true });
  await reconcileOrphans(25);
  await drainOnce();
  const revived = await posts.getPostById(post2.postId);
  check(
    'B2b reinstating also revives a post whose job DIED during the ban',
    Boolean(revived?.hivePermlink),
    `hive_permlink is still ${revived?.hivePermlink ?? 'NULL'}; jobs=${JSON.stringify(
      await jobRows(post2.postId)
    )}`
  );
}

// ── B2d · the stranded state must be countable, and recoverable ──────────────
async function b2dStrandedIsVisibleAndRecoverable(): Promise<void> {
  console.log('\n── B2d a post left with only dead jobs ─────────────────────────');
  await resetDb();
  const fake = fakeBroadcaster();
  setBroadcaster(fake);

  const userId = await newUser('stranded3');
  const post = await writePost(userId, 'THE 38 POSTS LOOKED EXACTLY LIKE THIS');
  // The live shape, exactly: visible, undeleted, off-chain, and THREE terminal jobs
  // — the `maxGenerations` ceiling, which is what puts it beyond the orphan sweep
  // forever. Written directly because the fixed code can no longer reach this state;
  // the 38 rows in the production database are still in it.
  await killJobsPastTheCeiling(post.postId, 'moderated before publishing');

  const health = await jobs.queueHealth();
  check(
    'B2d queue health COUNTS a post that is served but off-chain with nothing working on it',
    health.strandedPosts === 1,
    `strandedPosts=${health.strandedPosts} (pending=${health.pending} holding=${health.holding} rejected=${health.rejected})`
  );
  check(
    'B2d the orphan sweep alone cannot rescue it (that is why a recovery step exists)',
    (await reconcileOrphans(25)) === 0 && !(await posts.getPostById(post.postId))?.hivePermlink,
    'reconcileOrphans repaired it, so the deliberate recovery step would be redundant'
  );

  const report = await recoverStranded(100);
  check('B2d recovery finds it', report.stranded === 1 && report.requeued === 1, JSON.stringify(report));

  const outcome = await drainOnce();
  const recovered = await posts.getPostById(post.postId);
  check(
    'B2d THE RECOVERED POST REACHES HIVE',
    Boolean(recovered?.hivePermlink),
    `outcome=${outcome}; jobs=${JSON.stringify(await jobRows(post.postId))}`
  );
  check(
    'B2d and health reads clean afterwards',
    (await jobs.queueHealth()).strandedPosts === 0,
    JSON.stringify(await jobs.queueHealth())
  );

  // Running it twice must not queue a second broadcast of the same permlink.
  await resetDb();
  const u = await newUser('stranded4');
  const p = await writePost(u, 'RECOVERY MUST BE IDEMPOTENT');
  await killJobsPastTheCeiling(p.postId, 'moderated before publishing');
  const first = await recoverStranded(100);
  const second = await recoverStranded(100);
  check(
    'B2d recovery is safe to run twice',
    first.requeued === 1 && second.requeued === 0,
    `first=${JSON.stringify(first)} second=${JSON.stringify(second)}`
  );
}

// ── B3 · a takedown must survive the author being banned ─────────────────────
async function b3TakedownThenBan(): Promise<void> {
  console.log('\n── B3  takedown, then the author is banned ─────────────────────');
  await resetDb();
  const fake = fakeBroadcaster();
  setBroadcaster(fake);

  const userId = await newUser('abuser1');
  const post = await writePost(userId, 'CONTENT THE MODERATOR IS REMOVING');
  await publishIt(post, fake);
  const permlink = buildPermlink(post.postId);

  const takedown = await takeDownPost(post.postId);
  check('B3 the takedown is queued', takedown.queuedDelete, JSON.stringify(takedown));

  // The moderator now also bans the author — the natural next click.
  await moderateUser({ actor: 'selftest', userId, action: 'ban', reason: 'abuse', hideContent: true });

  const outcome = await drainOnce();
  check(
    'B3 THE DELETE STILL EXECUTES AFTER THE BAN',
    !fake.onChain.has(permlink),
    `the comment is still on chain (drain outcome=${outcome}); jobs=${JSON.stringify(
      await jobRows(post.postId)
    )}`
  );
}

// ── B4 · a takedown of a lite REPLY must name the parent's real chain permlink ─
async function b4TakedownOfReply(): Promise<void> {
  console.log('\n── B4  takedown of a lite reply ────────────────────────────────');
  await resetDb();
  // canDelete false: Hive refuses a hard delete once a comment has replies or votes,
  // and `canDelete` also fails CLOSED on an unreachable node — so this is the path a
  // node blip alone routes into.
  const fake = fakeBroadcaster({ canDelete: false });
  setBroadcaster(fake);

  const parentAuthorId = await newUser('threadstarter');
  const parent = await writePost(parentAuthorId, 'THE POST BEING REPLIED TO');
  await publishIt(parent, fake);

  // Exactly the shape the live rows carry: the reply captured the parent's LOCAL
  // placeholder permlink, not the name it published under.
  const replierId = await newUser('replier1');
  const reply = await writePost(replierId, 'A REPLY', {
    type: 'chain',
    author: PUB,
    permlink: `lite-${parent.postId.toLowerCase()}`
  });
  check(
    'B4 the reply really is pinned to the placeholder parent (the live row shape)',
    (await posts.getPublishParent(reply.postId))?.permlink === `lite-${parent.postId.toLowerCase()}`,
    JSON.stringify(await posts.getPublishParent(reply.postId))
  );

  // Publish the reply the way the worker does — resolving the placeholder to the
  // parent's real on-chain name at broadcast time.
  await reconcileOrphans(25);
  const createOutcome = await drainOnce();
  const publishedReply = await posts.getPostById(reply.postId);
  check(
    'B4 the reply publishes',
    Boolean(publishedReply?.hivePermlink),
    `outcome=${createOutcome} jobs=${JSON.stringify(await jobRows(reply.postId))}`
  );

  // ★ THE ROW SHAPE THAT ACTUALLY EXISTS IN PRODUCTION. Replies published before the
  // parent was written down still carry the placeholder in `publish_parent_permlink`
  // — and `setPublishParent` (rightly) refuses to rewrite the pin of a post that is
  // already on chain, so those rows keep it. Put the row back into that state, or
  // this case silently tests only posts created after the fix and the delete path's
  // own resolution goes uncovered. Live example: 01KZCP8RW3QYSKPZN35RF76W4E.
  await query(`UPDATE lumen_post SET publish_parent_permlink = $2 WHERE post_id = $1`, [
    reply.postId,
    `lite-${parent.postId.toLowerCase()}`
  ]);

  const replyPermlink = buildPermlink(reply.postId);
  await takeDownPost(reply.postId);
  const outcome = await drainOnce();
  const rows = await jobRows(reply.postId);

  check(
    'B4 THE REPLY TAKEDOWN EXECUTES',
    rows.some((r) => r.job_type === 'delete' && r.status === 'published'),
    `drain outcome=${outcome}; jobs=${JSON.stringify(rows)}`
  );
  const lastOp = fake.ops[fake.ops.length - 1];
  check(
    'B4 the soft-delete blanked the reply on chain',
    lastOp?.permlink === replyPermlink && lastOp.body === '',
    `last op = ${JSON.stringify(lastOp && { permlink: lastOp.permlink, body: lastOp.body })}`
  );
}

// ── B4b · the pin must record the parent the post actually published under ────
async function b4bPinRecordsRealParent(): Promise<void> {
  console.log('\n── B4b the recorded parent after a reply publishes ─────────────');
  await resetDb();
  const fake = fakeBroadcaster();
  setBroadcaster(fake);

  const parentAuthorId = await newUser('threadstarter2');
  const parent = await writePost(parentAuthorId, 'PARENT POST');
  await publishIt(parent, fake);

  const replierId = await newUser('replier2');
  const reply = await writePost(replierId, 'REPLY TEXT', {
    type: 'chain',
    author: PUB,
    permlink: `lite-${parent.postId.toLowerCase()}`
  });
  await reconcileOrphans(25);
  await drainOnce();

  const pin = await posts.getPublishParent(reply.postId);
  check(
    'B4b the stored publish parent is the parent\'s REAL chain permlink',
    pin?.permlink === buildPermlink(parent.postId),
    `stored ${pin?.author}/${pin?.permlink}, expected ${PUB}/${buildPermlink(parent.postId)}`
  );
  // Same value the comment thread is assembled from — a stale pin means the reply
  // never merges into the thread it belongs to.
  const inThread = await posts.listRepliesToChainPost(PUB, buildPermlink(parent.postId));
  check(
    'B4b the reply appears in its parent\'s thread',
    inThread.some((r) => r.postId === reply.postId),
    `listRepliesToChainPost returned ${inThread.length} row(s)`
  );
}

// ── B2c · a moderator restore must re-queue the post ─────────────────────────
async function b2cUnhideRequeues(): Promise<void> {
  console.log('\n── B2c hide, then unhide ───────────────────────────────────────');
  await resetDb();
  const fake = fakeBroadcaster();
  setBroadcaster(fake);

  const userId = await newUser('hidden1');
  const post = await writePost(userId, 'HIDDEN THEN RESTORED');

  await moderatePost({ actor: 'selftest', postId: post.postId, visibility: 'hidden', reason: 'test' });
  await reconcileOrphans(25);
  await drainOnce();
  const hidden = await posts.getPostById(post.postId);
  check('B2c nothing is published while hidden', !hidden?.hivePermlink, `${hidden?.hivePermlink}`);

  await moderatePost({ actor: 'selftest', postId: post.postId, visibility: 'visible', reason: 'restored' });
  await reconcileOrphans(25);
  await drainOnce();
  const restored = await posts.getPostById(post.postId);
  check(
    'B2c restoring visibility publishes the post',
    Boolean(restored?.hivePermlink),
    `hive_permlink is still ${restored?.hivePermlink ?? 'NULL'}; jobs=${JSON.stringify(
      await jobRows(post.postId)
    )}`
  );
}

async function main(): Promise<void> {
  if (!PUB) {
    console.error('LITE_FRONTEND_ACCOUNT_* is not set — the payload builder has no author. Aborting.');
    process.exit(1);
  }
  if (!liteConfig.enabled) {
    console.error('LITE_ACCOUNTS_ENABLED must be "yes" or the worker refuses to run. Aborting.');
    process.exit(1);
  }
  console.log(`publishing account: @${PUB}   database: ${DB_URL.replace(/:\/\/[^@]*@/, '://***@')}`);

  // Optional case filter, so a mutation check can re-run only the case that covers
  // the line it broke: `npx tsx ...selftest.ts B1 B4`. Every broadcast costs a real
  // 3.5-second pacing wait, so a full pass is minutes and a targeted one is seconds.
  const only = process.argv.slice(2).map((a) => a.toUpperCase());
  const wanted = (id: string) => only.length === 0 || only.includes(id);
  const cases: [string, () => Promise<void>][] = [
    ['B1', b1EditOfPublishedPost],
    ['B2', b2HiddenPostStranded],
    ['B2B', b2ReinstateRequeues],
    ['B2C', b2cUnhideRequeues],
    ['B2D', b2dStrandedIsVisibleAndRecoverable],
    ['B3', b3TakedownThenBan],
    ['B4', b4TakedownOfReply],
    ['B4B', b4bPinRecordsRealParent]
  ];
  for (const [id, run] of cases) if (wanted(id)) await run();

  if (checks === 0) {
    // A filter that matches nothing must be an error, not a silent green run.
    console.error(`no cases matched ${JSON.stringify(only)}`);
    process.exit(1);
  }
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
