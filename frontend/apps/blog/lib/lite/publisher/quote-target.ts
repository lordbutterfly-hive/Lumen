import { liteConfig } from '../config';
import * as posts from '../repositories/post-repository';
import { litePostIdOf } from '../render/lite-post-id';
import type { PostBroadcaster } from './broadcaster';

/**
 * Just before a lite quote reblog is published: is the post it quotes still there
 * (quote reblog spec v2 8.4, A10)? A Lumen post is read from our own table, where
 * deleted or moderated counts as gone; a Hive post is asked of the node. Returns null
 * when it is still there, otherwise the reason. A node error propagates (the worker
 * retries it), so an unreachable node is never read as "gone".
 */
export async function quoteTargetGone(
  broadcaster: PostBroadcaster,
  target: { author: string; permlink: string }
): Promise<string | null> {
  const litePostId =
    target.author === liteConfig.frontendAccount ? litePostIdOf({ permlink: target.permlink }) : undefined;
  if (litePostId) {
    const row = await posts.getPostById(litePostId);
    if (!row || row.deletedLocally) return 'was deleted';
    if (row.feedVisibility !== 'visible') return 'was removed';
    return null;
  }
  return (await broadcaster.postExists(target.author, target.permlink)) ? null : 'no longer exists on Hive';
}
