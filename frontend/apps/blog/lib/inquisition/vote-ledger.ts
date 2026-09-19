import 'server-only';
import { TYPES } from 'tedious';
import { withTtlCache } from '@/blog/lib/server-ttl-cache';
import { queryReader, querySlow } from './hivesql';

/**
 * ════ WHAT EACH VOTE WAS WORTH ════
 *
 * ★★★ `active_votes` IS THE ONLY PLACE PER-VOTE VALUE EXISTS, AND NOT READING IT WAS
 * WHY THREE FIGURES WERE WRONG OR MISSING (2026-09-19).
 *
 * `TxVotes` stores a vote's PERCENTAGE and no rshares at all, so nothing there can say
 * what a downvote took. `Comments.net_rshares` / `vote_rshares` look like they can — and
 * that is the trap: **both are reset to 0 once a post pays out**. Measured on
 * @lordbutterfly's two most recent paid posts: `net_rshares 0, vote_rshares 0` against a
 * real `total_payout_value` of 3.991 and 14.469. So the "REMOVED" figure built on that
 * difference only ever saw posts still inside their seven-day payout window, and
 * reported **−$9** for an account whose real lifetime figure is **−$238.25**.
 *
 * `Comments.active_votes` is a JSON array that survives payout, one entry per vote:
 *   { percent, reputation, rshares, time, voter, weight }
 *
 * That gives all three of the figures the design asks for and one it asked for that I
 * had given up on:
 *
 *   REMOVED      Σ negative rshares, valued at the post's own payout rate
 *   TOP 3        the same sum grouped by voter, so the board can name who
 *   SELF-REWARD  the author's own rshares as a share of the post's positive rshares,
 *                valued the same way — in MONEY, which is what the spec demands
 *
 * ★★ VALUED AT EACH POST'S OWN PAYOUT, NOT AT TODAY'S RATE. `payout ÷ positive rshares`
 * is that post's actual dollars-per-rshare on the day it paid, so a 2018 downvote is
 * valued in 2018 money. Converting historic rshares at today's reward rate would have
 * been a different (and much wronger) number.
 *
 * ★★ COST, MEASURED: 883 posts and ~8 MB of vote JSON for @lordbutterfly, **12.1
 * seconds** end to end including the parse. That is far too slow for a render and
 * perfectly fine for a per-account figure cached for a day, which is what it is.
 */

export interface VoteLedger {
  /** USD taken off this account's posts by downvotes, over its whole history. */
  removedUsd: number;
  /** The heaviest downvoters by VALUE REMOVED, most first. */
  topDownvoters: { account: string; usd: number }[];
  /**
   * ★★★ THE HEAVIEST DOWNVOTERS BY COUNT, which is a different list and was being
   * printed under a count label. The Record's DOWNVOTES RECEIVED cell said "most:
   * @a $139, @b $78" — three names ranked by DOLLARS under a heading about DOWNVOTES,
   * with money figures beside them. Whoever downvoted most often and whoever took the
   * most value are not the same people, and the cell was naming the wrong three.
   */
  topByCount: { account: string; votes: number }[];
  /** EVERY downvoter and what they took, for cross-account aggregation. */
  byVoter: Map<string, number>;
  /** The posts that lost the most, most first. */
  topPosts: { permlink: string; usd: number }[];
  /** USD of this account's own rewards that came from its own votes. */
  selfRewardUsd: number;
  /** That, as a share of every reward the account's posts have paid. */
  selfRewardPct: number | null;
  /** Total payout across every root post, author + curator. */
  totalPayoutUsd: number;
  /** Root posts examined. */
  posts: number;
  /** Posts downvoted so hard they paid nothing, valued at the account's own median rate. */
  zeroedPosts: number;
}

interface VoteEntry {
  voter?: string;
  rshares?: number | string;
}

interface PostRow {
  permlink: string;
  total_payout_value: number;
  curator_payout_value: number;
  active_votes: string | null;
}

/**
 * ★★★ A BOARD BUILD MUST NOT BORROW THE READER LANE, AND DOING SO MADE EVERY PROFILE
 * REPORT "could not be read" (2026-09-19).
 *
 * The inquisitor board runs thirty of these back to back. On `queryReader` — the fast,
 * three-slot lane a waiting reader uses — that build held a slot continuously, the
 * record's own query could not acquire one inside its three-second wait, `run` returned
 * `null`, and the profile correctly reported the record unavailable. Correct handling of
 * a self-inflicted starvation.
 *
 * So the lane is the CALLER'S choice: a reader waiting on a profile gets the fast lane, a
 * background aggregate queues on the slow one. The cache key is the account either way,
 * so whichever lane warms it, the other gets it free.
 */
async function loadVoteLedger(account: string, lane: 'reader' | 'background' = 'reader'): Promise<VoteLedger | null> {
  const query = lane === 'background' ? querySlow : queryReader;
  const rows = await query<PostRow>(
    `SELECT permlink, total_payout_value, curator_payout_value, active_votes
     FROM Comments WITH (NOLOCK)
     WHERE author = @account AND depth = 0`,
    [{ name: 'account', type: TYPES.VarChar, value: account }]
  );
  // ★ `null` is "we could not ask" and must not become a clean record. See hivesql.ts.
  if (rows === null) return null;

  let removedUsd = 0;
  let selfRewardUsd = 0;
  let totalPayoutUsd = 0;
  const byVoter = new Map<string, number>();
  const votesByVoter = new Map<string, number>();
  const byPost: { permlink: string; usd: number }[] = [];

  /*
   * ★★★ THE RATE IS `payout / NET`, NOT `payout / positive`, AND THE DIFFERENCE IS THE
   * WHOLE POINT OF THE FIGURE (found by adversarial review, 2026-09-19).
   *
   * Hive pays a post on its NET rshares, so the dollars-per-rshare that actually applied
   * is `payout / net`. Dividing by the positive side understates every removed figure by
   * exactly the fraction the downvotes took, which means the error is smallest where
   * nothing much happened and largest on the accounts this feature is about. Measured on
   * @lordbutterfly the two agree to three significant figures, because his downvotes are
   * negligible against his upvotes; on a heavily downvoted post they do not.
   *
   * ★★ AND A POST FLATTENED TO ZERO IS THE WORST CASE, NOT A BLANK. When net <= 0 the
   * post paid nothing, so there is no rate to read off it, and the previous code silently
   * skipped it — scoring the most damaged posts as $0 removed. They are now valued at
   * this account's OWN median rate (its other posts, its own era, not today's global
   * rate) and counted separately so the reader can be told.
   */
  const perPost: { payout: number; positive: number; negative: number; own: number; permlink: string }[] = [];

  for (const post of rows) {
    let votes: VoteEntry[];
    try {
      votes = JSON.parse(post.active_votes || '[]') as VoteEntry[];
    } catch {
      // A post whose vote blob will not parse is skipped, never counted as zero.
      continue;
    }
    if (!Array.isArray(votes)) continue;

    const payout = (Number(post.total_payout_value) || 0) + (Number(post.curator_payout_value) || 0);
    totalPayoutUsd += payout;

    let positive = 0;
    let negative = 0;
    let own = 0;
    for (const vote of votes) {
      const rshares = Number(vote.rshares) || 0;
      if (rshares > 0) {
        positive += rshares;
        if (vote.voter === account) own += rshares;
      } else {
        negative += -rshares;
      }
    }
    if (positive <= 0) continue;
    perPost.push({ payout, positive, negative, own, permlink: post.permlink });
  }

  // The account's own median dollars-per-rshare, from the posts that did pay.
  const rates = perPost
    .filter((p) => p.positive - p.negative > 0 && p.payout > 0)
    .map((p) => p.payout / (p.positive - p.negative))
    .sort((a, b) => a - b);
  const medianRate = rates.length > 0 ? rates[Math.floor(rates.length / 2)] : 0;

  let zeroedPosts = 0;
  for (const p of perPost) {
    const net = p.positive - p.negative;
    let rate: number;
    if (net > 0 && p.payout > 0) {
      rate = p.payout / net;
    } else {
      // ★ Flattened to nothing: no rate of its own, so use the account's median.
      if (medianRate <= 0) continue;
      rate = medianRate;
      zeroedPosts += 1;
    }

    const postRemoved = p.negative * rate;
    removedUsd += postRemoved;
    selfRewardUsd += p.own * rate;
    if (postRemoved > 0) byPost.push({ permlink: p.permlink, usd: postRemoved });

    if (p.negative > 0) {
      // Re-read the blob only for posts that actually carry a downvote.
      const post = rows.find((r) => r.permlink === p.permlink);
      let votes: VoteEntry[] = [];
      try {
        votes = JSON.parse(post?.active_votes || '[]') as VoteEntry[];
      } catch {
        votes = [];
      }
      for (const vote of votes) {
        const rshares = Number(vote.rshares) || 0;
        if (rshares < 0 && vote.voter) {
          byVoter.set(vote.voter, (byVoter.get(vote.voter) ?? 0) + -rshares * rate);
          votesByVoter.set(vote.voter, (votesByVoter.get(vote.voter) ?? 0) + 1);
        }
      }
    }
  }

  byPost.sort((a, b) => b.usd - a.usd);

  return {
    removedUsd,
    byVoter,
    topByCount: [...votesByVoter.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([acc, votes]) => ({ account: acc, votes })),
    topDownvoters: [...byVoter.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([acc, usd]) => ({ account: acc, usd })),
    topPosts: byPost.slice(0, 3),
    selfRewardUsd,
    // ★ `null`, not 0%, when nothing has ever paid out: a 0 would read as a finding.
    selfRewardPct: totalPayoutUsd > 0 ? (selfRewardUsd / totalPayoutUsd) * 100 : null,
    totalPayoutUsd,
    posts: rows.length,
    zeroedPosts
  };
}

/**
 * ★★ CACHED PER ACCOUNT, BECAUSE TWO BOARDS AND EVERY PROFILE WANT THE SAME 12 SECONDS.
 * The downvoted board needs each listed account's ledger, the inquisitors board sums the
 * same ledgers by voter, and an armed profile reads one. Without a cache that is the same
 * 8 MB pulled three times; with it, whichever asks first pays and the rest are free.
 */
// ★ The key is the account alone: whichever lane warms it, the other reads it free.
export const voteLedger = withTtlCache(
  loadVoteLedger,
  (account: string, _lane?: 'reader' | 'background') => account,
  {
    ttlMs: 24 * 60 * 60 * 1000,
    max: 120,
    name: 'inq-vote-ledger',
    // ★ `null` is "we could not ask" and is never cached as an answer.
    shouldCache: (value) => value !== null
  }
);

/**
 * ════ WHO TOOK IT, ACROSS ACCOUNTS ════
 *
 * ★★★ THE GREEN FIGURE ON THE INQUISITORS BOARD, AND THE CHEAP WAY ROUND A QUERY THAT
 * WILL NOT RUN (owner, 2026-09-19: "Wheres on that page in green $ amount they took off
 * posts").
 *
 * The direct question — "for every top downvoter, what did their downvotes take off
 * every post they touched" — needs `Comments` filtered by a correlated `EXISTS` over
 * `TxVotes` across three months. Measured 2026-09-19: **it did not finish in 230
 * seconds** and was killed. There is no index that makes it cheap.
 *
 * So it is asked from the other end. The most-downvoted accounts are already known, and
 * one vote ledger per account already returns every voter who took value off it. Running
 * that over the top N of them and summing by voter gives a real, traceable number for
 * each inquisitor, at a cost that is bounded by N rather than by the size of the chain.
 *
 * ★★ AND THE LABEL SAYS WHAT IT IS. This is value removed **from the accounts on the
 * most-downvoted board**, not from every post on Hive. An inquisitor who only downvotes
 * accounts outside that set shows nothing here, which is why the column can say "not
 * computed" and never "zero".
 */
export async function removedByVoterAcross(
  accounts: string[]
): Promise<{ byVoter: Map<string, number>; covered: number }> {
  const byVoter = new Map<string, number>();
  let covered = 0;
  for (const account of accounts) {
    let ledger: VoteLedger | null = null;
    try {
      ledger = await voteLedger(account, 'background');
    } catch {
      ledger = null;
    }
    if (!ledger) continue;
    covered += 1;
    for (const [voter, usd] of ledger.byVoter) {
      byVoter.set(voter, (byVoter.get(voter) ?? 0) + usd);
    }
  }
  return { byVoter, covered };
}
