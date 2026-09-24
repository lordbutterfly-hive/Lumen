import * as posts from '../repositories/post-repository';
import { liteConfig } from '../config';
import { litePostIdOf } from '../render/lite-post-id';
import { FollowActor } from './follow-actor';
import { actorForDisplayedName } from './block-actor';

/*
 * Moved here unchanged from block-filter.ts (2026-09-24) so code that only needs "who
 * owns this post" (the quote reblog service) can load it without block-filter's chain
 * imports, which ts-node-run self-tests cannot load. block-filter re-exports it, so
 * every existing caller is unchanged.
 */

/**
 * Who owns the post at these coordinates, as a block-graph node.
 *
 * ★ THE SHARED PUBLISHING ACCOUNT IS NOT AN OWNER. Every Lumen post is signed on
 * chain by one account, so `@<that account>/<permlink>` is the canonical chain URL of
 * somebody else's post. Reading the author segment as the owner would make one system
 * account the blocker-of-record for every lite post on the site. The permlink is the
 * thing that identifies a Lumen post, so it decides first.
 */
export async function resolvePostOwnerActor(
  author: string,
  permlink: string
): Promise<FollowActor | null> {
  const postId = litePostIdOf({ permlink });
  if (postId) {
    // ★★★ NO `.catch(() => null)` HERE, AND THAT IS THE WHOLE POINT (2026-08-12).
    //
    // This read used to swallow its own failure and return `null`, which reads
    // downstream as "resolved fine, and nobody owns this post". That is a
    // different sentence from "the database did not answer", and the difference
    // is load-bearing: `applyOwnerBlocksToAuthoredEntries` was hardened earlier
    // TODAY to tell those two apart — resolved-null stays visible (the container
    // -root case), a throw withholds the entry — and this inner catch quietly
    // defeated that guard by never letting a throw reach it. The outer try/catch
    // was correct and simply never fired.
    //
    // So a failure propagates. Every caller already fails closed on it: the three
    // effect-(B) filters mark the parent unresolvable and withhold its entries,
    // and `/api/lite/posts/replies` answers with an empty list. Effect (B) is the
    // half a reader cannot opt out of — "cannot prove this is safe to serve"
    // must never resolve to "serve it".
    //
    // ★ The lesson, for the third time today: hardening a caller is worthless if
    // the callee eats the error first. Check the whole path, not the boundary.
    const row = await posts.getPostById(postId);
    if (row) return { userId: row.userId };
  }
  const clean = (author ?? '').trim().replace(/^@/, '').toLowerCase();
  if (!clean) return null;
  // Defensive: if the URL names the publishing account but the permlink was not one
  // of ours, there is no Lumen owner to speak for — better no filter than the wrong
  // one. (`frontendAccount` is '' when lite accounts are unconfigured.)
  if (liteConfig.frontendAccount && clean === liteConfig.frontendAccount.toLowerCase()) {
    return null;
  }
  return actorForDisplayedName(clean, 'hive');
}
