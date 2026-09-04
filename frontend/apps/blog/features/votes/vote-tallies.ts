import type { Entry } from '@hive/common-hiveio-packages/wax';

export type MyVote = 'up' | 'down' | 'none';

export interface SplitTally {
  up: number;
  down: number;
}

/**
 * Split one post's vote count into the two numbers Hive actually keeps.
 *
 * ★★★ WHY IT IS DERIVED THIS WAY, AND WHAT IT CANNOT KNOW.
 *
 * Hive counts upvotes and downvotes separately and never nets them, but no
 * single field on `Entry` carries that split:
 *
 *   · `stats.total_votes` is the AUTHORITATIVE TOTAL (up + down). It is what
 *     every existing count on a card renders today, and it is the number the
 *     optimistic update in `use-vote-mutation.ts` already maintains.
 *   · `active_votes` is `{voter, rshares}[]`, so the SIGN of `rshares` is the
 *     only place the direction of somebody else's vote is recorded.
 *   · there is no `net_votes` on this type (checked: extended-hive.chain.ts).
 *
 * So: count the downvotes out of `active_votes`, and take the up tally as the
 * remainder of the authoritative total. That keeps the up number identical to
 * the one the app already shows (no regression on the figure readers know) and
 * derives the new down number from the only field that can express it.
 *
 * ★ MEASURED LIMIT, stated rather than hidden: Hivemind CAPS `active_votes` at
 * 1000 entries. Verified live against api.hive.blog on 2026-08-14 — a trending
 * post reported `stats.total_votes: 1220` alongside `active_votes.length: 1000`.
 * On a post past that cap a downvote sitting outside the returned window is not
 * counted, so `down` can under-report on very heavily voted posts. It cannot
 * over-report, and the up tally stays exactly as accurate as it is today
 * because it is anchored to the total. The alternative — taking BOTH numbers
 * from `active_votes` — would have made the up figure wrong by 220 on that same
 * post, which is far worse and would have been a visible regression.
 *
 * ★ MY OWN VOTE IS APPLIED SEPARATELY, and this is what makes the handoff's
 * transition table fall out for free rather than needing special cases:
 * `myVote` is sourced from the votes query (authoritative for me, and already
 * optimistic the instant I click), so this excludes me from the scraped `down`
 * count and adds me back from `myVote`. Then, with `up = total - down`:
 *
 *   none -> up    total+1 (by the mutation), down same        => up +1
 *   none -> down  total+1,                   down +1          => up same, down +1
 *   up   -> down  total same (still one vote), down +1         => up -1 AND down +1
 *   down -> up    total same,                 down -1          => up +1 AND down -1
 *   up   -> none  total-1,                    down same        => up -1
 *   down -> none  total-1,                    down -1          => up same, down -1
 *
 * which is the handoff's table exactly, including the "moved across" row, with
 * no arithmetic special-cased anywhere.
 */
export function splitTally(post: Entry, voter: string, myVote: MyVote): SplitTally {
  const activeVotes = Array.isArray(post.active_votes) ? post.active_votes : [];

  // Everyone else's downvotes. `rshares` is a number on this type, but it
  // arrives from JSON-RPC and very large values are sometimes serialised as
  // strings, so coerce before comparing rather than trusting `< 0` on a string.
  let othersDown = 0;
  for (const vote of activeVotes) {
    if (vote.voter === voter) continue;
    if (Number(vote.rshares) < 0) othersDown += 1;
  }

  const down = othersDown + (myVote === 'down' ? 1 : 0);

  // `total_votes` is absent on some shapes (comments coming back without
  // `stats`); `active_votes.length` is the best available stand-in and is exact
  // whenever the cap has not been hit.
  const total = post.stats?.total_votes ?? activeVotes.length;

  return { up: Math.max(0, total - down), down: Math.max(0, down) };
}
