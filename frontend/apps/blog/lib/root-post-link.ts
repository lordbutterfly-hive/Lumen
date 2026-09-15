/**
 * The post a comment was made on, recovered from the comment itself.
 *
 * WHY THIS EXISTS. A comment card could tell you WHO you replied to
 * (`parent_author`) but never WHAT you replied to, and nothing on the card
 * reached the post. On a lite profile's Comments tab that left every row
 * orphaned: you could see your own reply and had no way back to the thread.
 *
 * WHY `url` AND NOT `root_author`/`root_permlink`. The Bridge API does not
 * return root fields on these entries. Measured against mainnet on 2026-09-14,
 * `bridge.get_account_posts{sort:"comments"}` returns exactly:
 *   url:  "/dog/@acidyo/dogfooding#@lumenpublisher/lumen-01m2gqpb…"
 *   title:"RE: dogfooding"
 * and no key beginning `root`. So the root post is the part of `url` before the
 * `#`, and its title is `title` with the Bridge's `RE: ` prefix removed. The
 * app-facing `Entry` type names `url` and `title` for this reason; it never
 * named `root_*` because they are not there to name.
 *
 * ★★ WHY THE LINK IS BUILT FROM A PERMLINK AND NEVER FROM A NAME. A lite
 * handle is by construction a name that was free on Hive, so anyone may later
 * register the matching Hive account — see `use-lite-overlay.ts` for the same
 * hazard on bylines. A link built out of a DISPLAY NAME (`/@<handle>/…`) is
 * therefore a link whose destination a stranger can come to own. `url` is
 * addressed by the chain author plus the permlink, and a permlink identifies
 * one row that already exists, so the squatter has nothing to take over. Both
 * shapes were confirmed to resolve on production before this shipped:
 *   /dog/@acidyo/dogfooding                                 -> 200
 *   /lumen/@lumenpublisher/lumen-c-01m14t5hxvdews58rf7c5rq5eb -> 200
 * The second is a reply to another lite post: the author segment is the shared
 * publishing account, the post page applies the identity overlay itself, and
 * the reader still lands on the right thread.
 */

/**
 * Exactly `/<category>/@<author>/<permlink>`, same origin, nothing else.
 *
 * `url` arrives from the Bridge API and is derived from on-chain fields, so it
 * is treated as untrusted input. The leading `/` followed by a NON-`/`
 * character is the part that matters: it rejects `//evil.example`, which the
 * browser reads as protocol-relative and would navigate off Lumen entirely. A
 * value that must start with `/` can never carry a scheme, so `javascript:` and
 * friends cannot appear either. `#` and `?` are excluded so a crafted value
 * cannot smuggle a fragment or query past the caller.
 */
const ROOT_PATH = /^\/[^/\s][^\s#?]*\/@[^/\s#?]+\/[^/\s#?]+$/;

/** The Bridge prefixes a comment's synthesized title with `RE: `. */
const RE_PREFIX = /^re:\s*/i;

export interface CommentLike {
  url?: string;
  title?: string;
  category?: string;
  depth?: number;
  parent_author?: string;
  parent_permlink?: string;
}

/**
 * Path to the root post, or null when it cannot be established.
 *
 * Returning null is deliberate. A comment at depth 2+ has a `parent_permlink`
 * that names ANOTHER COMMENT, not the post, so guessing from the parent there
 * would produce a confident link to the wrong place. Better no link than a
 * wrong one.
 */
export function rootPostHref(entry?: CommentLike | null): string | null {
  const fromUrl = (entry?.url ?? '').split('#')[0].trim();
  if (ROOT_PATH.test(fromUrl)) return fromUrl;

  // Only at depth 1 is the parent the root post itself.
  if (entry?.depth === 1 && entry.category && entry.parent_author && entry.parent_permlink) {
    const built = `/${entry.category}/@${entry.parent_author}/${entry.parent_permlink}`;
    if (ROOT_PATH.test(built)) return built;
  }
  return null;
}

/**
 * The root post's title, or null when this entry does not carry it.
 *
 * ★★ THE `RE: ` PREFIX IS THE PROOF, NOT A TIDY-UP (2026-09-15). This used to
 * return the title unchanged when the prefix was absent, which shipped a wrong
 * label to production for ~20 minutes. The Bridge always synthesizes a
 * comment's title as `RE: <root title>` — verified across 12 consecutive
 * mainnet comments, all prefixed. But `/api/account-posts` then applies the
 * LITE IDENTITY OVERLAY, and that overlay REPLACES `entry.title` with the lite
 * post's OWN title (see `use-lite-overlay.ts`: `LiteOverlay.title`). So for a
 * lite comment the field holds the comment's title, not the root's, and the
 * old fallback printed it as though it were the post you replied to: two
 * different labels, "test" and "Just trying out lumen", both pointing at the
 * same root post.
 *
 * So the prefix is the only evidence that this string describes the ROOT. No
 * prefix, no claim. The caller still has `rootPostHref`, which the overlay does
 * not touch, so the post stays reachable; it is only the label that is withheld.
 */
export function rootPostTitle(entry?: CommentLike | null): string | null {
  const raw = (entry?.title ?? '').trim();
  if (!raw || !RE_PREFIX.test(raw)) return null;
  const stripped = raw.replace(RE_PREFIX, '').trim();
  return stripped || null;
}
