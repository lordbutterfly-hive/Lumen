import type { Entry } from '@hive/common-hiveio-packages/wax';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHICH COMMENT THE POST CARD OPENS ONTO
 * Built to `LUMEN-DOCS/lora-spec/handoff_post_card/SPEC.md` §5.
 *
 * The rule, run in order, stopping at the first that resolves:
 *
 *   1. score = (votes + replies) * (authorReplied ? 2 : 1). Highest wins.
 *   2. Tie: highest raw votes.
 *   3. No comments: return null. The card does not expand, and no empty state,
 *      disabled affordance or placeholder is rendered in its place.
 *
 * Superseded 2026-08-20 by the card-expansion spec §3. The previous rule was
 * "most direct replies, random among ties", which ignored votes entirely.
 *
 * ★ WHAT IS DELIBERATELY *NOT* IN THE SCORE: payout and recency. Payout surfaces
 * whoever is already winning, recency surfaces whoever spoke last. This rule
 * answers exactly one question, and it is a reader's question: which thread would
 * I join. Votes and the author's own reply WERE on this exclusion list until
 * 2026-08-20; §3 moved both into the score, and the spec's worked example is why
 * — on "The vote that pays a stranger" ada has 96 votes and 0 replies against
 * tomasz's 41 votes, 12 replies and an author answer, 96 to 106. Votes alone
 * would show ada.
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
 * ★★ THE PICK IS CACHED PER POST PER SESSION, AND THAT IS STILL LOAD-BEARING —
 * but for a different reason than it used to be. The score is DETERMINISTIC, so
 * there is no longer a random roll for a re-render to change. What the cache buys
 * now is §3's "do not re-rank on the reader's own vote": voting the shown comment
 * raises its own score and could swap which comment is displayed, and swapping
 * the text under the pointer mid-hover is worse than a stale winner. The Map
 * holds the winner steady while that vote is in flight.
 *
 * ★ WIRED 2026-08-19 — it had none. `top-comment-session-reset.tsx`, mounted
 * globally in `features/layouts/providers.tsx`, watches the signed-in identity
 * and calls `resetTopCommentPicks()` on every change. Identity rather than a
 * logout handler because sign-out reaches the client from four directions and
 * they only converge on `[QUERY_KEY.user]`; that file's header names all four.
 * With a deterministic score this reset is a much smaller thing than it was: it
 * no longer changes which comment a given thread resolves to, it only drops
 * held-steady winners so a new session re-reads current vote counts.
 *
 * ★ NO RNG, SO NO SSR HAZARD. The previous implementation called `Math.random()`
 * and needed an argument for why that could not produce a hydration mismatch.
 * The score removed the call, so the question is moot: the same discussion map
 * resolves to the same comment on a server and a client alike.
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
  /**
   * The raw node, carried through for the drawer's VOTE (card-expansion spec §7,
   * wired 2026-08-20). `VotesComponent` takes an `Entry` — it reads the author,
   * the permlink, the payout window and the active votes off it — and reusing
   * the shipped control is what gives the drawer every tier/auth guard for free
   * instead of a second hand-rolled vote. The flat fields above stay because the
   * drawer renders from them; this is for the control, not for the markup.
   */
  entry: Entry;
}

/** `${author}/${permlink}` — the key `bridge.get_discussion` uses for its map. */
export function discussionKey(author: string, permlink: string): string {
  return `${author}/${permlink}`;
}

/**
 * The winner is held ONCE per post per session. Keyed on the ROOT post's key,
 * valued with the chosen comment's key, so a re-fetch of the same thread — or a
 * re-render after the reader votes — resolves to the same comment instead of
 * re-scoring against the vote they just cast (§3).
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
    directResponseCount,
    entry
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

  /*
   * ★★★ THE SCORE, from the 2026-08-20 card-expansion spec §3:
   *
   *     score = (votes + replies) * (authorReplied ? 2 : 1)
   *
   * replacing "most direct replies, random among ties". Three things changed and
   * each one matters:
   *
   *  1. VOTES AND REPLIES COUNT THE SAME, one point each. A reply is a person who
   *     wrote something back, which on this network is at least as much signal as
   *     a vote.
   *  2. A REPLY FROM THE POST'S AUTHOR DOUBLES THE TOTAL. The author choosing to
   *     answer is the strongest available marker that a thread is alive.
   *  3. TIES BREAK ON RAW VOTES, not at random.
   *
   * The spec's own worked example is the argument: on "The vote that pays a
   * stranger", ada has 96 votes and 0 replies while tomasz has 41 votes, 12
   * replies and an author answer — 96 against 106. Votes alone would show ada.
   *
   * ★ THIS MAKES THE PICK DETERMINISTIC, which quietly demotes the session cache
   * below. That cache exists so a random pick could not change under the reader
   * between one hover and the next; with a formula there is nothing to re-roll.
   * It is KEPT because it still holds the winner steady while a reader's own vote
   * is in flight — see the re-rank note below, which is the case §3 actually
   * cares about — but `resetTopCommentPicks()` is now a much smaller thing than
   * it was.
   *
   * ★ DO NOT RE-RANK ON THE READER'S OWN VOTE (§3). Voting the shown comment
   * changes its score and could swap which comment is displayed. Swapping the
   * text under the pointer mid-hover is worse than a stale winner, and the cache
   * is what prevents it.
   */
  const rootAuthor = rootKey.split('/')[0];
  const authorRepliedTo = new Set<string>();
  for (const entry of Object.values(discussion)) {
    if (entry?.author !== rootAuthor) continue;
    if (!entry?.parent_author || !entry?.parent_permlink) continue;
    authorRepliedTo.add(discussionKey(entry.parent_author, entry.parent_permlink));
  }

  const netUpvotes = (entry: Entry): number =>
    Array.isArray(entry?.active_votes)
      ? entry.active_votes.filter((v) => Number(v?.rshares ?? 0) > 0).length
      : 0;

  const score = ([key, entry]: [string, Entry]): number =>
    (netUpvotes(entry) + (counts.get(key) ?? 0)) * (authorRepliedTo.has(key) ? 2 : 1);

  let best = comments[0];
  for (const c of comments.slice(1)) {
    const d = score(c) - score(best);
    // Ties break on raw votes (§3), and only then on nothing at all — the first
    // encountered wins, which is stable for a given discussion map.
    if (d > 0 || (d === 0 && netUpvotes(c[1]) > netUpvotes(best[1]))) best = c;
  }

  const [chosenKey, chosenEntry] = best;
  picked.set(rootKey, chosenKey);
  return toTopComment(chosenKey, chosenEntry, counts.get(chosenKey) ?? 0);
}
