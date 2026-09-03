import { litePostIdOf } from '@/blog/lib/lite/render/lite-post-id';
import { isContainerPermlink } from '@/blog/lib/lite/publisher/container';

/**
 * ★★★ A COMMENT URL OPENS THE POST AND SCROLLS TO THE COMMENT — there is no
 * standalone comment page (owner, 2026-09-03: the "single comment's thread / view
 * the full context / view the direct parent" page that notifications landed on is
 * noise; a comment belongs under its post).
 *
 * Every comment link in the app (notifications, the comment card's own link, the
 * profile Comments tab, other front ends' links, old shares) funnels into the one
 * `/[category]/@author/permlink` route, so a single redirect there fixes them all.
 * The target costs nothing: the bridge's own `url` for a reply is exactly
 *     /{category}/@{root_author}/{root_permlink}#@{author}/{permlink}
 * — the fragment is the DOM id `comment-list-item.tsx` puts on every comment, and
 * `comments-section.tsx` resolves it on arrival (switching to the right comments
 * page first, then scrolling + highlighting). A 308 keeps every existing link alive
 * and hands crawlers the post's metadata.
 *
 * The fragment names the CHAIN author (Hivemind's `url`), and that is what the
 * thread's DOM ids use too — `comment-list-item.tsx` stamps `@{author}/{permlink}`
 * from the entry's chain fields, which `attachLiteIdentitiesToDiscussion` leaves
 * intact (it adds `_lite`, it does not rewrite `author`). Verified live 2026-09-03:
 * a redirected comment URL landed on the post and scrolled to the comment.
 *
 * Returns the redirect target, or `null` to render the page as-is. Pure, so the
 * gate is unit-checkable. Redirect only when ALL hold:
 *  1. it is a reply on chain (`depth > 0`);
 *  2. it is NOT a Lumen-native post — a lite post is a depth-1 chain comment by
 *     construction (`litePostIdOf`) and must keep rendering as a post;
 *  3. its `url` carries a root path + `#@author/permlink` fragment, and that root
 *     is NOT a rolling Lumen container (`lumen-c-…` under the gateway account),
 *     which is not a page a reader should land on — those keep today's standalone
 *     view.
 */
export interface RedirectableEntry {
  depth?: number;
  url?: string;
  permlink?: string;
  json_metadata?: unknown;
}

export function commentPageRedirectTarget(postData: RedirectableEntry | null | undefined): string | null {
  if (!postData) return null;
  const depth = Number(postData.depth ?? 0);
  if (!(depth > 0)) return null;
  if (litePostIdOf(postData)) return null;
  const url = postData.url ?? '';
  const hash = url.indexOf('#@');
  if (!url.startsWith('/') || hash <= 0) return null;
  const rootPath = url.slice(0, hash);
  const rootPermlink = rootPath.slice(rootPath.lastIndexOf('/') + 1);
  if (!rootPermlink || isContainerPermlink(rootPermlink)) return null;
  return url;
}
