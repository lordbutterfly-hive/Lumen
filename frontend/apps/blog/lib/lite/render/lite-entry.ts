import { Entry } from '@hive/common-hiveio-packages/wax';
import { getPost } from '@transaction/lib/bridge-api';
import { LumenPost } from '../types';
import * as posts from '../repositories/post-repository';
import { dbPostToEntry } from './db-post-to-entry';
import { litePostIdOf } from './lite-post-id';
import { resolvePublicName } from './current-name';

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
export async function liteEntryForPost(
  post: LumenPost,
  observer = '',
  viewerUserId?: string
): Promise<Entry | null> {
  // Both moderation levels hide the post from general rendering. `author_only` is the
  // exception the caller can opt into by naming the viewer — the API route does that so
  // an author still sees their own limited post instead of a 404 on it.
  if (post.deletedLocally) return null;
  if (post.feedVisibility === 'hidden') return null;
  if (post.feedVisibility !== 'visible' && viewerUserId !== post.userId) return null;

  // The author's name TODAY, not the one frozen on the row. After an upgrade these
  // differ, and the whole point of keeping `user_id` stable is that the history
  // follows the person to their new Hive name.
  const publicName = await resolvePublicName(post);

  if (!post.hiveAuthor || !post.hivePermlink) return dbPostToEntry(post, publicName);

  let chainEntry: Entry | null = null;
  try {
    chainEntry = (await getPost(post.hiveAuthor, post.hivePermlink, observer)) ?? null;
  } catch (error) {
    // ★ A NODE HICCUP MUST NOT RENDER A CONFIDENT EMPTY POST (2026-08-12).
    //
    // This unconditionally swallowed the error and fell back to `dbPostToEntry(post,
    // ...)` — "Node trouble shouldn't blank the page", per the comment that used to
    // sit here. But by the time this line can even run, `post.hiveAuthor` and
    // `post.hivePermlink` are both set, which only happens after a successful
    // publish (`markPostPublished`, post-repository.ts) — and under the default
    // config (`pruneBodyAfterPublish`, on unless `LITE_PRUNE_BODY_AFTER_PUBLISH=no`)
    // that same publish already blanked `post.body` to `''`. So the "fallback" this
    // comment promised did not exist: rendering the row served a live, published
    // post as a normal 200 with an empty body — indistinguishable from an author who
    // genuinely wrote nothing — which is a worse failure than an honest error, not a
    // gentler one.
    //
    // The row IS a legitimate fallback when it still holds real content: pruning is
    // opt-in and off by default in some deployments, and nothing else about this
    // catch block changes for that case. Only pruned rows (the common case) need the
    // rest of this fix.
    if (post.body) {
      chainEntry = null;
    } else {
      // Nothing left to render this post from — surface the failure instead of
      // inventing an answer. Every consumer already has an honest path for a throw
      // here: `/api/lite/posts/[id]/route.ts` answers 500 `server_error` instead of
      // 200 with an empty body; `layout.tsx`'s `generateMetadata` falls back to
      // generic site metadata instead of a real title over no description; and the
      // post page's own outer catch (`content.tsx`'s caller, `page.tsx`) logs and
      // leaves `postData` unset, which renders `notFound()` rather than a blank
      // article. A 404 or a 500 on a transient blip is not perfect, but it is never
      // mistaken for "this post has no body" — which is the one thing this function
      // must not claim. Not retried in place: every one of those callers is a fresh
      // request a reader can simply reload, and doubling this call's latency here
      // would tax every real, permanent failure to buy back only the transient ones.
      throw error;
    }
  }
  if (!chainEntry) return dbPostToEntry(post, publicName);

  return {
    ...chainEntry,
    // Carried alongside the rewritten fields, not instead of them. Components that
    // ACT — follow, mute, a profile lookup — need the account that actually signed
    // this, and once `author` below has been replaced there is nowhere else to read
    // it from. Without this they fall back to the display name, which is not a Hive
    // account at all (see features/post-rendering/user-popover-card.tsx).
    _lite: {
      author: publicName,
      title: post.title || chainEntry.title,
      chainAuthor: post.hiveAuthor,
      // See LiteIdentity.userId — the identity the block filters key on.
      userId: post.userId
    },
    // The identity a reader should see. The permlink stays real, so links resolve.
    author: publicName,
    // Hivemind SYNTHESISES a title for any comment — it returns "RE: <parent title>"
    // regardless of the title actually broadcast — so every container child would
    // display as "RE: Lumen posts — <date>" instead of its own headline. The real
    // title is in our row (only the body is pruned after publish), so restore it.
    title: post.title || chainEntry.title,
    url: `/${chainEntry.category}/@${publicName}/${post.hivePermlink}`,
    // Every lite post is a container CHILD on chain (depth 1) because Hive caps root
    // posts at one per 5 minutes per account. It is still a primary post to a
    // reader, so present it as one: the post page gates title, tags, reblog and
    // "main post" treatment on depth === 0. A genuine reply keeps its real depth.
    depth: post.parentRef ? chainEntry.depth : 0
  };
}

/** Resolve a lite post from a permlink alone (author segment is never trusted). */
/**
 * Does Lumen have a record for this permlink at all?
 *
 * Distinguishes "this post exists but is withheld" (deleted or moderated → the honest
 * answer is 404) from "this is not one of ours" (→ let the chain answer). Without the
 * distinction, a removed lite post's URL falls through to a chain lookup keyed on the
 * URL's author segment — a name anyone can register — and serves their content instead.
 */
export async function liteRecordExists(permlink: string): Promise<boolean> {
  const postId = litePostIdOf({ permlink });
  if (!postId) return false;
  return Boolean(await posts.getPostById(postId));
}

export async function liteEntryForPermlink(
  permlink: string,
  observer = '',
  viewerUserId?: string
): Promise<Entry | null> {
  const postId = litePostIdOf({ permlink });
  if (!postId) return null;
  const post = await posts.getPostById(postId);
  if (!post) return null;
  // Viewer threaded through so an author still reaches their own limited-visibility
  // post at its URL. Without it the carve-out existed only on the JSON API and the page
  // still answered 404 to the one person allowed to see it.
  return liteEntryForPost(post, observer, viewerUserId);
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
