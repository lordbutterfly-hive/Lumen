import type { Entry } from '@hive/common-hiveio-packages/wax';
import { sorter, SortOrder } from './sorter';

/**
 * ★★★ THE COMMENT ORDER IS FROZEN WHILE YOU READ (2026-09-10, owner: "theres some
 * weird jumping when reading comments... it might do with reranking the comments
 * while im reading if i click upvote so it dissapears and jumps somewhere. that
 * should not happen while i read").
 *
 * That is exactly what it was. `sorter`'s `trending` key is pending + author +
 * curator payout, tie-broken on `net_rshares` (see `lib/sorter.ts`), and an upvote
 * moves BOTH. The vote's own optimistic cache patch changed the discussion data, the
 * memo that sorts re-ran, and the comment the reader had just voted on was re-ranked
 * out from under their cursor. Worse than a shuffle: the post page pages off THIS
 * order, so a comment that crossed a page boundary did not merely move, it left the
 * page entirely. "It disappears and jumps somewhere" is the same sentence as "the
 * sort key changed".
 *
 * So a fresh sort now runs when the reader asks a different question, not when the
 * numbers move under an unchanged one:
 *
 *   · sort selection changed -> sort fresh and adopt that order.
 *   · same selection, same set of comments -> KEEP the order already on screen,
 *     whatever the vote counts now say. This is the vote case, and it is the fix.
 *   · a comment arrived or left -> keep every comment already on screen exactly where
 *     it is, and place each NEW one where a fresh sort would put it RELATIVE to its
 *     neighbours. A reply landing mid-thread is not an excuse to re-rank the nine
 *     comments around it.
 *
 * The reader always has a way to force a fresh ranking: pick the sort again.
 *
 * Kept as a pure function over an explicit `state` rather than a hook, so the
 * behaviour above is testable without a signed-in browser casting a real vote --
 * `comment-order.selftest.ts` drives exactly that case.
 */
export interface CommentOrderState {
  sortType: SortOrder;
  keys: string[];
}

export const commentKeyOf = (entry: Entry) => `${entry.author}/${entry.permlink}`;

export function orderComments(
  list: Entry[],
  sortType: SortOrder,
  previous: CommentOrderState | null
): { ordered: Entry[]; state: CommentOrderState } {
  const fresh = [...list];
  sorter(fresh, sortType);

  if (!previous || previous.sortType !== sortType) {
    return { ordered: fresh, state: { sortType, keys: fresh.map(commentKeyOf) } };
  }

  const previousRank = new Map(previous.keys.map((key, index) => [key, index] as const));

  // A key we already showed keeps its rank. A key we have not shown before takes a
  // rank just past the last already-shown comment ABOVE it in the fresh sort, as a
  // fraction, so it slots between two frozen neighbours without disturbing either.
  const rank = new Map<string, number>();
  let lastKnownRank = -1;
  let newcomersSinceKnown = 0;
  for (const entry of fresh) {
    const key = commentKeyOf(entry);
    const known = previousRank.get(key);
    if (known !== undefined) {
      lastKnownRank = known;
      newcomersSinceKnown = 0;
      rank.set(key, known);
    } else {
      newcomersSinceKnown += 1;
      rank.set(key, lastKnownRank + newcomersSinceKnown / (fresh.length + 1));
    }
  }

  const ordered = [...list].sort(
    (a, b) => (rank.get(commentKeyOf(a)) ?? 0) - (rank.get(commentKeyOf(b)) ?? 0)
  );
  return { ordered, state: { sortType, keys: ordered.map(commentKeyOf) } };
}
