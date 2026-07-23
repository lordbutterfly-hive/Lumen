import { Entry } from '@hive/common-hiveio-packages/wax';
import * as posts from '../repositories/post-repository';

/**
 * Post-publish attribution overlay (spec §E.1). A proxy post is on-chain authored
 * by the frontend account; without this, every lite post would render as authored
 * by "lumen.posts". `resolveLiteAuthor` maps a published (author, permlink) back
 * to the lite user; `rewriteProxyEntry` presents the entry as theirs.
 */

export interface LiteAuthorMapping {
  userId: string;
  displayName: string;
  postId: string;
}

export async function resolveLiteAuthor(
  hiveAuthor: string,
  hivePermlink: string
): Promise<LiteAuthorMapping | null> {
  const post = await posts.resolveByHive(hiveAuthor, hivePermlink);
  if (!post) return null;
  return { userId: post.userId, displayName: post.displayNameSnapshot, postId: post.postId };
}

/**
 * MVP overlay: swap author + url to the display identity so the existing card
 * renders it as the user's own. (A non-destructive `displayAuthor` overlay plus a
 * reader-facing "via Lumen" marker is the §K-deferred alternative.)
 */
export function rewriteProxyEntry(entry: Entry, mapping: LiteAuthorMapping): Entry {
  return {
    ...entry,
    author: mapping.displayName,
    url: `/@${mapping.displayName}/${entry.permlink}`
  };
}
