import { Entry } from '@hive/common-hiveio-packages/wax';
import { getPost } from '@transaction/lib/bridge-api';
import { LumenPost } from '../types';
import * as posts from '../repositories/post-repository';
import { dbPostToEntry } from './db-post-to-entry';
import { litePostIdOf } from './lite-post-id';

/**
 * Server-side resolution of a lite post for rendering — the piece that makes
 * attribution actually work.
 *
 * WHY THIS EXISTS, and why the obvious approach fails:
 *
 * A published lite post is authored on chain by the shared publishing account, so
 * without an overlay every one of them renders as written by that account rather
 * than by the person who wrote it. The tempting fix — rewrite the entry's author and
 * url to the Lumen display name — produces a URL the app CANNOT resolve: a lite
 * display name is not a Hive account, `isUsernameValid` is only an offline format
 * check, and the post page fetches through Hivemind, which knows nothing about that
 * name. Every link (permalink, feed card, comment count, all four share buttons)
 * would 404.
 *
 * The way out is that a Lumen permlink already identifies the post by itself —
 * `lumen-<lowercased ULID>` when published, `lite-<ULID>` before that. So the author
 * segment of the URL is not needed and is never trusted: we resolve from the
 * permlink, fetch the real on-chain object under its REAL author, and only then
 * present the lite identity. Pretty URLs and correct bylines, no dead links.
 */

/**
 * Build the renderable entry for a lite post.
 *
 * Published: fetch the real on-chain object (which also supplies the body, since
 * `pruneBodyAfterPublish` drops it from our row) and overlay the lite identity.
 * Not yet published: render straight from the row.
 */
export async function liteEntryForPost(post: LumenPost, observer = ''): Promise<Entry | null> {
  if (post.deletedLocally || post.feedVisibility === 'hidden') return null;

  if (!post.hiveAuthor || !post.hivePermlink) return dbPostToEntry(post);

  let chainEntry: Entry | null = null;
  try {
    chainEntry = (await getPost(post.hiveAuthor, post.hivePermlink, observer)) ?? null;
  } catch {
    // Node trouble shouldn't blank the page — fall back to what we still hold.
    chainEntry = null;
  }
  if (!chainEntry) return dbPostToEntry(post);

  return {
    ...chainEntry,
    // The identity a reader should see. The permlink stays real, so links resolve.
    author: post.displayNameSnapshot,
    // Hivemind SYNTHESISES a title for any comment — it returns "RE: <parent title>"
    // regardless of the title actually broadcast — so every container child would
    // display as "RE: Lumen posts — <date>" instead of its own headline. The real
    // title is in our row (only the body is pruned after publish), so restore it.
    title: post.title || chainEntry.title,
    url: `/${chainEntry.category}/@${post.displayNameSnapshot}/${post.hivePermlink}`,
    // Every lite post is a container CHILD on chain (depth 1) because Hive caps root
    // posts at one per 5 minutes per account. It is still a primary post to a
    // reader, so present it as one: the post page gates title, tags, reblog and
    // "main post" treatment on depth === 0. A genuine reply keeps its real depth.
    depth: post.parentRef ? chainEntry.depth : 0
  };
}

/** Resolve a lite post from a permlink alone (author segment is never trusted). */
export async function liteEntryForPermlink(permlink: string, observer = ''): Promise<Entry | null> {
  const postId = litePostIdOf({ permlink });
  if (!postId) return null;
  const post = await posts.getPostById(postId);
  if (!post) return null;
  return liteEntryForPost(post, observer);
}

/**
 * The REAL on-chain coordinates of a lite post, for anything that must query Hive
 * directly rather than render our overlay — the comment thread being the case that
 * matters.
 *
 * `getDiscussion(author, permlink)` on a post page uses the author from the URL,
 * which for a lite post is a display name Hivemind has never heard of, so it always
 * returns nothing and every reply under a lite post is invisible. Callers should try
 * the normal fetch, then retry with these coordinates.
 */
export async function liteChainCoordinates(
  permlink: string
): Promise<{ author: string; permlink: string } | null> {
  const postId = litePostIdOf({ permlink });
  if (!postId) return null;
  const post = await posts.getPostById(postId);
  if (!post?.hiveAuthor || !post.hivePermlink) return null;
  return { author: post.hiveAuthor, permlink: post.hivePermlink };
}
