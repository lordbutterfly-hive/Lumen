/**
 * ★★★ ONE REQUEST PER PAGE, NOT ONE PER CARD (2026-09-10).
 *
 * See `app/api/comment-vote/batch/route.ts` for WHY the card has to ask at all (short
 * version: `active_votes` on a feed entry cannot answer "did I vote" -- the seed is
 * trimmed at build time and re-served for up to 18h, so a newer vote is simply not in
 * it, and the lookup that would have corrected that was gated on the same field).
 *
 * This is the part that makes asking affordable. Every `VotesComponent` that mounts
 * calls `lookupMyVote` and gets a promise back; the calls made in the same tick are
 * coalesced into ONE POST. A thirty-card feed therefore costs one request, which is
 * what lets the answer be correct without giving back the 684 KB of `active_votes`
 * the 2026-08-10 payload work removed.
 *
 * Deliberately a module-level batcher rather than a React context: `VotesComponent`
 * renders on the feed, both profile tabs, the post page, the comment thread and the
 * card drawer, and threading a provider through all of them to schedule a request is
 * more surface than the problem needs. The queue holds only in-flight keys.
 */

export interface MyVoteRow {
  voter: string;
  vote_percent: number;
  rshares: string;
}

interface Pending {
  author: string;
  permlink: string;
  resolve: (row: MyVoteRow | null) => void;
}

/** Matches the route's own cap, so a flush never bounces with `too_many_posts`. */
const MAX_BATCH = 60;

let queue: Pending[] = [];
let scheduled = false;

const keyOf = (author: string, permlink: string) => `${author.toLowerCase()}/${permlink}`;

async function flush(voter: string, batch: Pending[]): Promise<void> {
  try {
    const res = await fetch('/api/comment-vote/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voter,
        posts: batch.map(({ author, permlink }) => ({ author, permlink }))
      })
    });
    if (!res.ok) throw new Error(`batch vote lookup: HTTP ${res.status}`);
    const body = (await res.json()) as { votes?: Record<string, MyVoteRow> };
    const votes = body?.votes ?? {};
    for (const item of batch) item.resolve(votes[keyOf(item.author, item.permlink)] ?? null);
  } catch {
    // ★ RESOLVE NULL, NEVER REJECT. A failed lookup must leave the card exactly as the
    // entry described it -- which is today's behaviour -- rather than surfacing an
    // error on a control the reader did not touch. `null` is "no vote found", and the
    // caller already treats that as "fall back to `checkVote`".
    for (const item of batch) item.resolve(null);
  }
}

/**
 * "Has `voter` voted on this post?" Resolves `null` for no, and for a lookup that
 * could not be completed.
 *
 * The batching window is a microtask: everything that mounts in the same render pass
 * shares one request. Anything later opens a new batch.
 */
export function lookupMyVote(author: string, permlink: string, voter: string): Promise<MyVoteRow | null> {
  if (!author || !permlink || !voter) return Promise.resolve(null);
  return new Promise<MyVoteRow | null>((resolve) => {
    queue.push({ author, permlink, resolve });
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      const batch = queue;
      queue = [];
      scheduled = false;
      for (let i = 0; i < batch.length; i += MAX_BATCH) {
        void flush(voter, batch.slice(i, i + MAX_BATCH));
      }
    });
  });
}
