/**
 * THE RUBRIC SLOT — the small brand-red label at the left of a card's byline.
 *
 * ★ WHY THIS IS A SHARED MODULE (2026-08-26). This logic lived inline in
 * `medium-post-card.tsx` and the profile COMMENT card had no fallback at all, so
 * a comment on a post with no community rendered an empty rubric slot — raised
 * twice before it was actioned. Copying twenty lines across would have set the
 * two surfaces up to drift, and the two owner rulings recorded below are exactly
 * the kind of thing that gets re-broken in the copy that nobody edited. One
 * function, one place to read the rules.
 *
 * Spec (handoff_identity_pill/SPEC.md, "Rubric fallback"): *"If a post has no
 * community, the rubric slot shows the post's first tag instead, capitalized, no
 * `#` prefix. If there is no tag either, the rubric is omitted (do not leave an
 * empty styled slot)."*
 *
 * ★ THE FALLBACK TAG IS NOT ALLOWED TO BE THE COMMUNITY. On a community post
 * `category` IS the community id (`hive-100067`), so a naive `tags[0] ??
 * category` would print a raw community id as a "tag" on exactly the posts that
 * already have a proper community name — and it looks like a bug, because it is
 * one. The community branch wins first, and the fallback skips any tag with that
 * SHAPE.
 *
 * ★★★ THE FIRST TAG, NOT THE SECOND (owner, 2026-08-25: "you used the second tg
 * instead of first tag"). This once read `t !== post.category`, which throws away
 * any tag equal to the category. On an ordinary non-community post the category
 * IS the first tag, so that filter skipped `tags[0]` every time and printed
 * `tags[1]`. The guard it was there to provide is narrower: a post carrying a
 * `community` id but no `community_title` never reaches the community branch, and
 * its category is a raw id like `hive-100067`, which must not print as a "tag".
 * Testing for that SHAPE keeps the protection without discarding a legitimate
 * first tag that merely happens to match the category. Proven against the chain:
 * @udabeu `deutsch,images` -> "Deutsch" (was "Images"); @wgonz
 * `dclub,technology` -> "Dclub".
 *
 * ★ ON COMMENTS the fallback resolves through `category`, because a reply
 * normally carries no `tags` of its own — its category is the ROOT post's, which
 * is precisely "the topic this reply sits under" and is the same thing the
 * community label would have said. Measured on @gtg's 20 most recent comments:
 * 5 have no community, all 5 have a meaningful category (`pypt`, `v4vapp`,
 * `blog`, `polish`, `v4vapp`) and none is a `hive-\d+` id, so the fallback fills
 * every previously-empty slot and invents nothing.
 *
 * `label` is what a reader sees, `tag` is what the URL uses; keeping them apart
 * is the same split `routeHandle`/`displayHandle` makes in creator-tokens, and
 * for the same reason — one of them is capitalized and the other must not be.
 */

/** A raw community id (`hive-100067`), which must never print as a tag. */
const COMMUNITY_ID = /^hive-\d+$/;

/** Only the fields the rubric needs, so this couples to no particular post type. */
export interface RubricSource {
  community?: string | null;
  community_title?: string | null;
  category?: string | null;
  json_metadata?: unknown;
}

export interface Rubric {
  /** Shown to the reader, capitalized. */
  label: string;
  /** Used in `/topics/<tag>`, never capitalized. */
  tag: string;
}

export function getPostRubric(post: RubricSource): Rubric | null {
  if (post.community && post.community_title) {
    return { label: post.community_title, tag: post.community };
  }

  let tags: unknown = undefined;
  try {
    const meta = typeof post.json_metadata === 'string' ? JSON.parse(post.json_metadata) : post.json_metadata;
    tags = (meta as { tags?: unknown } | null)?.tags;
  } catch {
    // A post with unparseable metadata still gets a rubric from its category.
  }

  const first = Array.isArray(tags)
    ? tags.find((t) => typeof t === 'string' && t.trim() && !COMMUNITY_ID.test(t.trim()))
    : undefined;

  const raw = (typeof first === 'string' ? first : post.category || '').trim().replace(/^#/, '');
  /* ★ The category can itself be a raw community id — a post that carries a
     `community` but no `community_title` lands here. Omitting the slot is the
     spec'd behaviour ("do not leave an empty styled slot"), and printing
     "Hive-100067" would be worse than printing nothing. */
  if (!raw || COMMUNITY_ID.test(raw)) return null;

  return { label: raw.charAt(0).toUpperCase() + raw.slice(1), tag: raw };
}
