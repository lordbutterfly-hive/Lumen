/**
 * Proves the self-engagement guard against a REAL Postgres, including the
 * chain-coordinate bypass found 2026-08-01.
 *
 *   cd apps/blog && npx tsx ../../scripts/lite-selfvote-e2e.ts
 *
 * THE BUG: a published lite post is authored ON CHAIN by the shared publishing
 * account, not by its lite author, and its permlink is `lumen-<own postId>`.
 * The guard compared the target AUTHOR against the caller's own handles, so a
 * caller could self-engage simply by addressing their own post through its
 * chain coordinates instead of its Lumen ones — defeating the guard at exactly
 * the point it exists for.
 *
 * The control cases matter as much as the exploit: the fix must NOT start
 * refusing votes on other people's lite posts, or on native Hive posts, which
 * is why the original code deliberately avoided a blanket lumen_post lookup.
 */

import { query } from '../apps/blog/lib/lite/db/pool';
import * as users from '../apps/blog/lib/lite/repositories/user-repository';
import * as posts from '../apps/blog/lib/lite/repositories/post-repository';
import { liteConfig } from '../apps/blog/lib/lite/config';
import { checkEngagementTarget } from '../apps/blog/lib/lite/content/engagement-target';
import { buildPermlink } from '../apps/blog/lib/lite/publisher/permlink';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1;
    console.log(`ok    ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

async function main() {
  const frontend = liteConfig.frontendAccount;
  if (!frontend) {
    console.error('LITE_FRONTEND_ACCOUNT_* not configured — cannot run.');
    process.exit(1);
  }

  const sfx = () => Math.floor(Math.random() * 1e9).toString(36);
  const author = await users.createUser({ displayName: `sv${sfx()}`.slice(0, 16) });
  const other = await users.createUser({ displayName: `ot${sfx()}`.slice(0, 16) });

  // A published post by `author`: chain author is the SHARED account.
  const post = await posts.createPost({
    userId: author.userId,
    displayNameSnapshot: author.displayName,
    tier: 'normal',
    title: 'self-vote target',
    body: 'body',
    tags: ['lumen']
  });
  const permlink = buildPermlink(post.postId);
  await posts.markPostPublished(post.postId, frontend, permlink);

  // ── 1. THE EXPLOIT: author addresses their OWN post by chain coordinates.
  {
    const verdict = await checkEngagementTarget(author, frontend, permlink);
    check(
      'author cannot self-engage via chain coordinates',
      !verdict.ok && verdict.code === 'self_engagement',
      JSON.stringify(verdict)
    );
  }

  // ── 2. The pre-existing path still refuses (addressed by Lumen handle).
  {
    const verdict = await checkEngagementTarget(author, author.displayName, permlink);
    check('author cannot self-engage via their Lumen handle', !verdict.ok && verdict.code === 'self_engagement');
  }

  // ── 3. ★ CONTROL: someone ELSE voting on that same lite post must still work.
  // If the fix over-reaches, lite posts become unvoteable — worse than the bug.
  {
    const verdict = await checkEngagementTarget(other, frontend, permlink);
    check('another user CAN engage the same lite post', verdict.ok, JSON.stringify(verdict));
  }

  // ── 4. ★ CONTROL: a native Hive post is untouched. This is why the original
  // code refused a blanket lumen_post lookup, and that reasoning still holds.
  {
    const verdict = await checkEngagementTarget(author, 'gtg', 'some-real-hive-post');
    check('native Hive post is still voteable', verdict.ok, JSON.stringify(verdict));
  }

  // ── 5. CONTROL: the lumen permlink SHAPE alone must not trigger a refusal
  // when the author is somebody else — only our own publishing account counts.
  {
    const verdict = await checkEngagementTarget(author, 'someoneelse', permlink);
    check('lumen-shaped permlink under a foreign author is allowed', verdict.ok);
  }

  // ── 6. CONTROL: an UNPUBLISHED post has no chain row; resolving must miss
  // cleanly rather than throw.
  {
    const ghost = buildPermlink('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    const verdict = await checkEngagementTarget(author, frontend, ghost);
    check('unresolvable lumen permlink does not throw and is allowed', verdict.ok);
  }

  await query('DELETE FROM lumen_post WHERE user_id = ANY($1)', [[author.userId, other.userId]]);
  await query('DELETE FROM lumen_user WHERE user_id = ANY($1)', [[author.userId, other.userId]]);

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) process.exit(1);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
