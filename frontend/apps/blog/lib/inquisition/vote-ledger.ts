import 'server-only';
import { TYPES } from 'tedious';
import { withTtlCache } from '@/blog/lib/server-ttl-cache';
import { queryReader, querySlow } from './hivesql';

/**
 * ════ WHAT EACH VOTE WAS WORTH, SUMMED ON THE SERVER ════
 *
 * ★★★ `active_votes` IS THE ONLY PLACE PER-VOTE VALUE EXISTS, AND PULLING IT ACROSS THE
 * WIRE DOES NOT SCALE. `TxVotes` stores a vote's PERCENTAGE and no rshares at all.
 * `Comments.net_rshares` / `vote_rshares` look usable and are the trap: **both are reset
 * to 0 once a post pays out**, so anything built on them only ever sees the last seven
 * days. That bug reported −$9 for an account whose real lifetime figure is −$513.
 *
 * So the value has to come from the `active_votes` JSON — and the first version of this
 * file read that JSON in Node. It worked on a modest account (@lordbutterfly: 883 posts,
 * 8 MB, 12.1s) and collapsed on the accounts the boards actually rank. Measured:
 *
 *     @haejin            7,308 posts    235 MB of vote JSON
 *     @acidyo            2,633 posts    195 MB
 *     @taskmaster4450le  4,084 posts    103 MB
 *     @erikah            3,738 posts     86 MB
 *
 * Forty of those is several gigabytes over TDS, parsed one object at a time. The board
 * build ran for twenty-two minutes and produced nothing at all.
 *
 * ★★★ `OPENJSON` MOVES THE WHOLE SUM TO THE SERVER. SQL Server parses `active_votes`
 * where it already lives and returns one row. Measured on the same data:
 *
 *     @erikah, 86 MB, whole-history totals          4.2s
 *     ten victim accounts, per-voter attribution   30.0s
 *
 * Nothing crosses the wire but the answer.
 *
 * ★★ THE RATE IS `payout / NET`, per post. Hive pays a post on its net rshares, so that
 * is the dollars-per-rshare that actually applied; dividing by the positive side alone
 * understates every removal by exactly the fraction the downvotes took. Posts whose net
 * fell to zero have no rate of their own and are excluded rather than guessed at.
 */

/** One post's vote totals. Every query below is built on this. */
const POST_TOTALS = `
  SELECT c.author, c.permlink,
         SUM(CASE WHEN j.rshares > 0 THEN CAST(j.rshares AS float) ELSE 0 END) AS pos,
         SUM(CASE WHEN j.rshares < 0 THEN -CAST(j.rshares AS float) ELSE 0 END) AS neg,
         MAX(CAST(c.total_payout_value AS float) + CAST(c.curator_payout_value AS float)) AS payout
  FROM Comments c WITH (NOLOCK)
  CROSS APPLY OPENJSON(c.active_votes) WITH (rshares bigint '$.rshares') AS j
  WHERE c.depth = 0 AND c.author IN (%AUTHORS%)
  GROUP BY c.author, c.permlink`;

const authorList = (n: number) => Array.from({ length: n }, (_, i) => `@a${i}`).join(',');
const authorParams = (names: string[]) =>
  names.map((name, i) => ({ name: `a${i}`, type: TYPES.VarChar, value: name }));

export interface VoteLedger {
  /** HBD taken off this account's posts by downvotes, over its whole history. */
  removedUsd: number;
  /** The heaviest downvoters by VALUE removed, most first. */
  topDownvoters: { account: string; usd: number }[];
  /** The heaviest downvoters by COUNT, which is a different list. */
  topByCount: { account: string; votes: number }[];
  /** HBD of this account's own rewards that came from its own votes. */
  selfRewardUsd: number;
  /** That, as a share of every reward the account's posts have paid. */
  selfRewardPct: number | null;
  totalPayoutUsd: number;
  posts: number;
}

interface TotalsRow {
  removed: number;
  total_payout: number;
  self_reward: number;
  posts: number;
}

interface VoterRow {
  voter: string;
  removed: number;
  dvs: number;
}

async function loadVoteLedger(
  account: string,
  lane: 'reader' | 'background' = 'reader'
): Promise<VoteLedger | null> {
  const query = lane === 'background' ? querySlow : queryReader;
  const cte = POST_TOTALS.replace('%AUTHORS%', '@a0');

  /*
   * ★ `self_reward` is the author's own positive rshares valued at the same per-post
   * rate: the share of their payouts that came from their own votes, in MONEY rather
   * than in vote count, which is what the design asks for and what a count cannot give.
   */
  const totals = await query<TotalsRow>(
    `WITH p AS (${cte})
     SELECT
       SUM(p.neg * p.payout / NULLIF(p.pos - p.neg, 0)) AS removed,
       SUM(p.payout) AS total_payout,
       (SELECT ISNULL(SUM(CAST(j.rshares AS float) * p2.payout / NULLIF(p2.pos - p2.neg, 0)), 0)
          FROM Comments c2 WITH (NOLOCK)
          CROSS APPLY OPENJSON(c2.active_votes) WITH (rshares bigint '$.rshares', voter nvarchar(20) '$.voter') AS j
          JOIN p AS p2 ON p2.author = c2.author AND p2.permlink = c2.permlink
         WHERE c2.author = @a0 AND c2.depth = 0 AND j.voter = @a0 AND j.rshares > 0
           AND p2.pos - p2.neg > 0) AS self_reward,
       COUNT(*) AS posts
     FROM p
     WHERE p.pos - p.neg > 0`,
    authorParams([account])
  );
  // ★ `null` is "we could not ask" and must not become a clean record. See hivesql.ts.
  if (totals === null || totals.length === 0) return null;

  const voters = await query<VoterRow>(
    `WITH p AS (${cte})
     SELECT TOP 20 j.voter,
            SUM(-CAST(j.rshares AS float) * p.payout / NULLIF(p.pos - p.neg, 0)) AS removed,
            COUNT(*) AS dvs
     FROM Comments c WITH (NOLOCK)
     CROSS APPLY OPENJSON(c.active_votes) WITH (rshares bigint '$.rshares', voter nvarchar(20) '$.voter') AS j
     JOIN p ON p.author = c.author AND p.permlink = c.permlink
     WHERE c.author = @a0 AND c.depth = 0 AND j.rshares < 0 AND p.pos - p.neg > 0
     GROUP BY j.voter
     ORDER BY SUM(-CAST(j.rshares AS float) * p.payout / NULLIF(p.pos - p.neg, 0)) DESC`,
    authorParams([account])
  );

  const rows = voters ?? [];
  const removedUsd = Number(totals[0]?.removed) || 0;
  const totalPayoutUsd = Number(totals[0]?.total_payout) || 0;
  const selfRewardUsd = Number(totals[0]?.self_reward) || 0;

  return {
    removedUsd,
    topDownvoters: rows.slice(0, 3).map((r) => ({ account: r.voter, usd: Number(r.removed) || 0 })),
    // ★ A DIFFERENT LIST FROM A DIFFERENT SORT. Whoever downvoted most often and whoever
    // took the most value are rarely the same people; each cell names its own three.
    topByCount: [...rows]
      .sort((a, b) => (Number(b.dvs) || 0) - (Number(a.dvs) || 0))
      .slice(0, 3)
      .map((r) => ({ account: r.voter, votes: Number(r.dvs) || 0 })),
    selfRewardUsd,
    // ★ `null`, not 0%, when nothing has ever paid out: a 0 would read as a finding.
    selfRewardPct: totalPayoutUsd > 0 ? (selfRewardUsd / totalPayoutUsd) * 100 : null,
    totalPayoutUsd,
    posts: Number(totals[0]?.posts) || 0
  };
}

/**
 * ★★ CACHED PER ACCOUNT, because an armed profile and both boards can want the same one.
 * The key is the account alone: whichever lane warms it, the other reads it free.
 */
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
 * ════ WHO TOOK IT, ACROSS MANY ACCOUNTS ════
 *
 * The green figure on the inquisitors board: one statement over the whole seed set,
 * grouped by the voter rather than by the victim. 30.0s for ten victims, against a JS
 * version that never returned at all.
 *
 * ★ THE LABEL HAS TO SAY WHAT THIS COVERS: value removed from the accounts in the seed,
 * not from every post on Hive. A voter whose targets fall outside it reports nothing,
 * which the column renders as a dash and never as zero.
 */
export async function removedByVoterAcross(
  accounts: string[]
): Promise<{ byVoter: Map<string, number>; covered: number }> {
  const byVoter = new Map<string, number>();
  if (accounts.length === 0) return { byVoter, covered: 0 };

  const list = authorList(accounts.length);
  const cte = POST_TOTALS.replace('%AUTHORS%', list);
  const rows = await querySlow<{ voter: string; removed: number }>(
    `WITH p AS (${cte})
     SELECT j.voter, SUM(-CAST(j.rshares AS float) * p.payout / NULLIF(p.pos - p.neg, 0)) AS removed
     FROM Comments c WITH (NOLOCK)
     CROSS APPLY OPENJSON(c.active_votes) WITH (rshares bigint '$.rshares', voter nvarchar(20) '$.voter') AS j
     JOIN p ON p.author = c.author AND p.permlink = c.permlink
     WHERE c.depth = 0 AND c.author IN (${list})
       AND j.rshares < 0 AND p.pos - p.neg > 0
     GROUP BY j.voter`,
    authorParams(accounts)
  );
  if (rows === null) return { byVoter, covered: 0 };
  for (const row of rows) byVoter.set(row.voter, Number(row.removed) || 0);
  return { byVoter, covered: accounts.length };
}

/**
 * What downvotes took off each of these accounts, for the most-downvoted board. Same
 * shape, grouped the other way, and it replaces forty sequential per-account reads with
 * one statement.
 */
export async function removedByAuthorAcross(accounts: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (accounts.length === 0) return out;

  const cte = POST_TOTALS.replace('%AUTHORS%', authorList(accounts.length));
  const rows = await querySlow<{ author: string; removed: number }>(
    `WITH p AS (${cte})
     SELECT p.author, SUM(p.neg * p.payout / NULLIF(p.pos - p.neg, 0)) AS removed
     FROM p
     WHERE p.pos - p.neg > 0
     GROUP BY p.author`,
    authorParams(accounts)
  );
  if (rows === null) return out;
  for (const row of rows) out.set(row.author, Number(row.removed) || 0);
  return out;
}
