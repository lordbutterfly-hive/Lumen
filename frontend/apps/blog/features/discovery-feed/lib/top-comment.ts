import type { Entry } from '@hive/common-hiveio-packages/wax';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHICH COMMENT THE POST CARD OPENS ONTO
 * Built to `LUMEN-DOCS/lora-spec/handoff_post_card/SPEC.md` §5.
 *
 * The rule, run in order, stopping at the first that resolves:
 *
 *   1. Most DIRECT responses wins — replies to the comment, not its whole subtree.
 *   2. Tie: random among the tied.
 *   3. All zero: random among all. A post where nothing has been answered has no
 *      best comment; do not quietly fall back to payout or recency.
 *   4. No comments: return null. The card does not expand, and no empty state,
 *      disabled affordance or placeholder is rendered in its place.
 *
 * ★ WHAT IS DELIBERATELY *NOT* A TIEBREAKER: payout, vote count, recency, and the
 * post author's own reply. Each of those produces a materially different feed —
 * payout surfaces whoever is already winning, recency surfaces whoever spoke last,
 * the author's reply surfaces the author twice. This rule answers exactly one
 * question, and it is a reader's question: which thread would I join.
 *
 * ★★★ "DIRECT" IS COMPUTED, NOT READ OFF A FIELD, AND THAT MATTERS.
 * `Entry.children` from Hivemind is the count of the WHOLE subtree beneath a
 * comment, not its direct replies. Using it would rank a comment with one reply
 * that itself started a 30-deep argument above a comment that eight different
 * people answered — the opposite of what the rule is for. `/api/discussion`
 * returns the full thread as a `Record<'author/permlink', Entry>` map, and every
 * node carries `parent_author` / `parent_permlink`, so the exact direct count is a
 * single pass over that map. No extra request, no approximation.
 *
 * ★★ THE PICK IS CACHED PER POST PER SESSION, AND THAT IS LOAD-BEARING.
 * If the random pick happened per render, the card would change its mind between
 * one hover and the next and the feed would stop feeling like a place. The Map
 * below is the whole mechanism. `resetTopCommentPicks()` must be called on logout
 * and on a feed reset so a session's picks do not outlive it.
 *
 * ★ WIRED 2026-08-19 — it had none. `top-comment-session-reset.tsx`, mounted
 * globally in `features/layouts/providers.tsx`, watches the signed-in identity
 * and calls this on every change. Identity rather than a logout handler because
 * sign-out reaches the client from four directions and they only converge on
 * `[QUERY_KEY.user]`; that file's header names all four.
 *
 * ★ WHY `Math.random()` IS SAFE HERE DESPITE SSR. This module is only ever reached
 * from the drawer, and the drawer's thread is fetched lazily on hover/focus — a
 * client-only event. Nothing here runs during server rendering, so there is no
 * server pick for a client pick to disagree with, and no hydration mismatch. If
 * this is ever called during render on the server, that stops being true; seed the
 * pick from the post id instead of changing anything else.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** The shape the card's drawer renders. Deliberately flat — the drawer needs no `Entry`. */
export interface TopComment {
  key: string;
  author: string;
  permlink: string;
  body: string;
  created: string;
  payout: number;
  upvotes: number;
  /** Replies to THIS comment. Not `Entry.children`, which is the whole subtree. */
  directResponseCount: number;
}

/** `${author}/${permlink}` — the key `bridge.get_discussion` uses for its map. */
export function discussionKey(author: string, permlink: string): string {
  return `${author}/${permlink}`;
}

/**
 * Random is picked ONCE per post per session. Keyed on the ROOT post's key, valued
 * with the chosen comment's key, so a re-fetch of the same thread re-resolves to the
 * same comment rather than re-rolling.
 */
const picked = new Map<string, string>();

/** Call on logout or feed reset so the session's picks do not outlive it. */
export function resetTopCommentPicks(): void {
  picked.clear();
}

/**
 * Count direct replies for every node in the discussion map, in one pass.
 * A node whose parent is not in the map (the root's own parent, or a comment whose
 * parent was filtered out by the block list) simply contributes nothing.
 */
function directResponseCounts(discussion: Record<string, Entry>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of Object.values(discussion)) {
    if (!entry?.parent_author || !entry?.parent_permlink) continue;
    const parent = discussionKey(entry.parent_author, entry.parent_permlink);
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  return counts;
}

function toTopComment(key: string, entry: Entry, directResponseCount: number): TopComment {
  return {
    key,
    author: entry.author,
    permlink: entry.permlink,
    body: entry.body ?? '',
    created: entry.created,
    // `payout` is already a number on Entry; the card formats it, this does not.
    payout: typeof entry.payout === 'number' ? entry.payout : 0,
    // Net upvotes, matching what the vote control shows: `active_votes` includes
    // downvotes, so counting the array length would overstate a contested comment.
    upvotes: Array.isArray(entry.active_votes)
      ? entry.active_votes.filter((v) => Number(v?.rshares ?? 0) > 0).length
      : 0,
    directResponseCount
  };
}

/**
 * @param rootKey  `${author}/${permlink}` of the POST, which is also the cache key.
 * @param discussion the map `/api/discussion` returns, root post included.
 * @returns the comment to open onto, or null when the card must not expand.
 */
export function selectTopComment(rootKey: string, discussion: Record<string, Entry> | undefined): TopComment | null {
  if (!discussion) return null;

  const counts = directResponseCounts(discussion);

  // Every node EXCEPT the root post. `bridge.get_discussion` always includes the
  // root, so filtering it out here is not optional — without it a post with no
  // comments would "open onto itself".
  const comments = Object.entries(discussion).filter(([key]) => key !== rootKey);
  if (comments.length === 0) return null; // rule 4

  // A pick already made this session wins, as long as the comment still exists.
  // If it has since been deleted or blocked out of the thread, fall through and
  // pick again rather than showing nothing.
  const cachedKey = picked.get(rootKey);
  if (cachedKey) {
    const hit = comments.find(([key]) => key === cachedKey);
    if (hit) return toTopComment(hit[0], hit[1], counts.get(hit[0]) ?? 0);
  }

  const max = Math.max(...comments.map(([key]) => counts.get(key) ?? 0));
  // Rule 3 collapses into rule 2: when `max` is 0, every comment is tied, so the
  // "all zero" case is the "everything tied" case and needs no separate branch.
  const tied = comments.filter(([key]) => (counts.get(key) ?? 0) === max); // rules 1-3
  const [chosenKey, chosenEntry] =
    tied.length === 1 ? tied[0] : tied[Math.floor(Math.random() * tied.length)];

  picked.set(rootKey, chosenKey);
  return toTopComment(chosenKey, chosenEntry, counts.get(chosenKey) ?? 0);
}
