import 'server-only';
import { TYPES } from 'tedious';
import { withTtlCache } from '@/blog/lib/server-ttl-cache';
import { queryCapped, queryReader, querySlow } from './hivesql';

/**
 * ════ WHAT A DOWNVOTE REMOVED ════
 *
 * ★★★ THE PREVIOUS VERSION OF THIS FILE NEVER RAN AT ALL IN ONE DIRECTION. The scope was
 * interpolated between `FROM` and `CROSS APPLY`, producing
 * `FROM Comments c WHERE c.author = @a0 CROSS APPLY OPENJSON(...)` — invalid T-SQL,
 * *"Incorrect syntax near the keyword 'CROSS'"*. `connectAndRun` turns a SQL error into
 * `null`, and `null` correctly means "we could not ask", so every row of MOST DOWNVOTED
 * and every money figure on every profile rendered as a dash. I spent hours tuning
 * timeouts and budgets against what was an operator-ordering bug. The voter direction
 * used a `JOIN`, which is legal there, which is why the one number I ever measured
 * happened to work. Scope is now split into `%JOIN%` (before) and `%WHERE%` (after).
 *
 * ★★★ AND THE RATE MODEL WAS DOING WORK IT DID NOT NEED TO DO. For a post that PAID, the
 * value its downvotes removed is exactly known with no model at all:
 *
 *     payout = rho x net   =>   rho = payout / net   =>   removed = payout x neg / net
 *
 * That is exact, and it covers 68-100% of the value on every account audited. A modelled
 * rate is only needed for posts flattened to zero, which paid nothing and so have no rate
 * of their own. The old code applied the model everywhere and threw away the exact truth.
 *
 * ★★★ THE MODEL ALSO DELETED ROWS SILENTLY. The monthly rate table was joined with an
 * INNER join, so any post whose month produced no rate vanished from the sum. Two ways
 * that happened, both measured:
 *
 *   - HiveSQL leaves `last_payout = 1970-01-01` on a class of 2017-2020 posts (chain-
 *     verified: a @haejin post reads 1970 here and 2018-01-09 on chain). All 32,233 such
 *     posts in the audit sample bucket to month 197001, which has $0 of payout, so no
 *     rate exists and every one was dropped. Cost: **$61,764 on @steemcleaners alone, 66%
 *     of its figure.** Those are exactly the zeroed posts this was built to capture.
 *   - An account flattened on everything has no paying posts at all, so no month yields a
 *     rate. @offgridlife lost 1,485 downvoted posts worth $648, 29.5% of his figure.
 *
 * Both are fixed: epoch dates are re-derived as `created + 7 days`, and the rate is a
 * LEFT-JOINed ladder (month, then year, then the whole corpus) so a missing bucket falls
 * through instead of deleting the row.
 *
 * ★★ THE UNIT IS HBD, NOT USD, and the column now says so. `total_payout_value` is the
 * reward's HIVE value converted at the witness feed, verified against a post's own
 * `author_rewards x feed_price`. The feed prices HIVE in USD and treats HBD as $1 — which
 * held except in 2016-09..2018-07, when SBD traded up to **$6.93** (recovered three ways:
 * feed over the internal DEX rate, conversion-request execution prices, and the collapse
 * of conversion volume from 13,921/month to 61 when the market paid seven times peg).
 * Roughly 30-41% of an author's payout was actual SBD tokens, so realised value in that
 * window was up to **1.88x** the declared figure for a pre-2018 account. The published
 * number is the chain-declared one; calling it "$" implied a precision it does not have.
 *
 * ★ THE SUM HAPPENS ON THE SERVER. `active_votes` is the only place per-vote value lives,
 * and it is far too big to move: @haejin's posts carry 235 MB of it. `OPENJSON` parses it
 * where it already is and returns one row.
 */

/**
 * Per-post vote totals for a scope, plus a rate ladder built from the same corpus.
 *
 * `%JOIN%` goes before `CROSS APPLY` (a join must); `%WHERE%` goes after it (a filter
 * must). Getting that backwards is what made the author direction return nothing.
 */
const VALUED = `
WITH p AS (
  SELECT c.ID,
         /* ★ Epoch dates: the mirror leaves 1970-01-01 on a class of rows. Payout is
            seven days after creation on this chain, which is chain-verified correct. */
         CASE WHEN c.last_payout < '2016-01-01' THEN DATEADD(day, 7, c.created) ELSE c.last_payout END AS paid_at,
         SUM(CASE WHEN j.rshares > 0 THEN CAST(j.rshares AS float) ELSE 0 END) AS pos,
         SUM(CASE WHEN j.rshares < 0 THEN -CAST(j.rshares AS float) ELSE 0 END) AS neg,
         MAX(CAST(c.total_payout_value AS float) + CAST(c.curator_payout_value AS float)) AS payout
  FROM Comments c WITH (NOLOCK)
  %JOIN%
  CROSS APPLY OPENJSON(c.active_votes) WITH (rshares bigint '$.rshares') AS j
  %WHERE%
  GROUP BY c.ID, c.last_payout, c.created
),
paid AS (
  SELECT *, DATEPART(year, paid_at) * 100 + DATEPART(month, paid_at) AS ym,
            DATEPART(year, paid_at) AS y
  FROM p WHERE pos - neg > 0 AND payout > 0
),
rm AS (SELECT ym, SUM(payout) / NULLIF(SUM(pos - neg), 0) AS rate FROM paid GROUP BY ym),
ry AS (SELECT y,  SUM(payout) / NULLIF(SUM(pos - neg), 0) AS rate FROM paid GROUP BY y),
ro AS (SELECT SUM(payout) / NULLIF(SUM(pos - neg), 0) AS rate FROM paid),
v AS (
  SELECT p.*,
         COALESCE(rm.rate, ry.rate, ro.rate) AS rate
  FROM p
  LEFT JOIN rm ON rm.ym = DATEPART(year, p.paid_at) * 100 + DATEPART(month, p.paid_at)
  LEFT JOIN ry ON ry.y  = DATEPART(year, p.paid_at)
  CROSS JOIN ro
)`;

/**
 * What a share `s` of a post's downvotes was worth. Exact when the post paid; modelled and
 * capped at what the post could ever have earned when it did not.
 */
const valueOf = (share: string) => `
  CASE WHEN v.pos - v.neg > 0 AND v.payout > 0
       THEN v.payout * (${share}) / (v.pos - v.neg)
       ELSE COALESCE(v.rate, 0) * (CASE WHEN v.neg <= v.pos THEN v.neg ELSE v.pos END)
            * (${share}) / NULLIF(v.neg, 0)
  END`;

/** The whole post's downvotes. */
const ALL_NEG = valueOf('v.neg');
/** One voter's share of them. */
const ONE_VOTER = valueOf('-CAST(j.rshares AS float)');

/**
 * How long one account's money query may take. Measured with the real SQL: a normal
 * account is ~19s, @steemcleaners 108.5s, @adm 66.8s, and @spaminator and @mack-bot both
 * exceed 240s. 150s keeps the big-but-possible ones and still fails fast on the two that
 * cannot be done at all, so they do not eat a board's whole budget.
 */
const PER_ACCOUNT_MS = 150_000;

export interface VoteLedger {
  /** HBD taken off this account's posts by downvotes, over its whole history. */
  removedUsd: number;
  topDownvoters: { account: string; usd: number }[];
  topByCount: { account: string; votes: number }[];
  selfRewardUsd: number;
  selfRewardPct: number | null;
  totalPayoutUsd: number;
  posts: number;
}

/** A NULL sum means "nothing computable", which is not the same as zero. */
const orNull = (v: unknown): number | null => {
  const n = Number(v);
  return v === null || v === undefined || !Number.isFinite(n) ? null : n;
};

async function loadVoteLedger(
  account: string,
  lane: 'reader' | 'background' = 'reader'
): Promise<VoteLedger | null> {
  const query = lane === 'background' ? querySlow : queryReader;
  const cte = VALUED.replace('%JOIN%', '').replace('%WHERE%', 'WHERE c.author = @a0');
  const p = [{ name: 'a0', type: TYPES.VarChar, value: account }];

  const totals = await query<{ removed: number; total_payout: number; posts: number }>(
    `${cte}
     SELECT SUM(${ALL_NEG}) AS removed, SUM(v.payout) AS total_payout, COUNT(*) AS posts
     FROM v`,
    p
  );
  // ★ `null` is "we could not ask" and must not become a clean record. See hivesql.ts.
  if (totals === null || totals.length === 0) return null;

  const voters = await query<{ voter: string; removed: number; dvs: number }>(
    `${cte}
     SELECT TOP 20 j.voter, SUM(${ONE_VOTER}) AS removed, COUNT(*) AS dvs
     FROM v
     JOIN Comments c WITH (NOLOCK) ON c.ID = v.ID
     CROSS APPLY OPENJSON(c.active_votes) WITH (rshares bigint '$.rshares', voter nvarchar(20) '$.voter') AS j
     WHERE j.rshares < 0
     GROUP BY j.voter
     ORDER BY SUM(${ONE_VOTER}) DESC`,
    p
  );

  /*
   * ★ SELF-REWARD is the author's own POSITIVE rshares valued the same way: the share of
   * their payouts that came from their own votes, in money rather than in vote count.
   */
  const self = await query<{ self_reward: number }>(
    `${cte}
     SELECT SUM(CASE WHEN v.pos - v.neg > 0 AND v.payout > 0
                     THEN v.payout * CAST(j.rshares AS float) / (v.pos - v.neg)
                     ELSE 0 END) AS self_reward
     FROM v
     JOIN Comments c WITH (NOLOCK) ON c.ID = v.ID
     CROSS APPLY OPENJSON(c.active_votes) WITH (rshares bigint '$.rshares', voter nvarchar(20) '$.voter') AS j
     WHERE j.voter = @a0 AND j.rshares > 0`,
    p
  );

  const rows = voters ?? [];
  const totalPayoutUsd = Number(totals[0]?.total_payout) || 0;
  const selfRewardUsd = Number(self?.[0]?.self_reward) || 0;

  return {
    removedUsd: orNull(totals[0]?.removed) ?? 0,
    topDownvoters: rows.slice(0, 3).map((r) => ({ account: r.voter, usd: Number(r.removed) || 0 })),
    // ★ A different list from a different sort: whoever downvoted most often and whoever
    // took the most value are rarely the same people.
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

export const voteLedger = withTtlCache(
  loadVoteLedger,
  (account: string, _lane?: 'reader' | 'background') => account,
  {
    ttlMs: 7 * 24 * 60 * 60 * 1000,
    max: 200,
    name: 'inq-vote-ledger',
    shouldCache: (value) => value !== null
  }
);

/**
 * What ONE downvoter took, across every post they hit. Scoped by the voter's own votes,
 * never by a seed of victims — a seed covering 1.2% of someone's targets produced $881
 * where the truth is $45,000.
 */
async function loadRemovedByVoter(voter: string): Promise<number | null> {
  const join = `JOIN (SELECT DISTINCT v2.author, v2.permlink
                      FROM TxVotes v2 WITH (NOLOCK)
                      WHERE v2.voter = @v AND v2.weight < 0) AS tgt
                  ON tgt.author = c.author AND tgt.permlink = c.permlink`;
  const cte = VALUED.replace('%JOIN%', join).replace('%WHERE%', '');

  const rows = await queryCapped<{ removed: number }>(
    `${cte}
     SELECT SUM(${ONE_VOTER}) AS removed
     FROM v
     JOIN Comments c WITH (NOLOCK) ON c.ID = v.ID
     CROSS APPLY OPENJSON(c.active_votes) WITH (rshares bigint '$.rshares', voter nvarchar(20) '$.voter') AS j
     WHERE j.voter = @v AND j.rshares < 0`,
    [{ name: 'v', type: TYPES.VarChar, value: voter }],
    PER_ACCOUNT_MS
  );
  if (rows === null || rows.length === 0) return null;
  // ★ A NULL sum is "nothing computable", not $0.00. Returning 0 here printed a positive
  // claim — "this account took nothing" — where the design intends a dash.
  return orNull(rows[0]?.removed);
}

export const removedByVoter = withTtlCache(loadRemovedByVoter, (voter: string) => voter, {
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  max: 300,
  name: 'inq-removed-by-voter',
  shouldCache: (value) => value !== null
});

/**
 * The money column for a board, one account at a time under a wall-clock budget. Rows past
 * the budget report `null`, which renders as a dash: a figure covering a fraction of
 * someone's activity, printed beside a correct target count, is worse than no figure.
 */
export async function removedForMany(
  names: string[],
  kind: 'voter' | 'author',
  budgetMs: number
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const deadline = Date.now() + budgetMs;
  for (const name of names) {
    if (Date.now() >= deadline) break;
    try {
      const value =
        kind === 'voter' ? await removedByVoter(name) : ((await voteLedger(name, 'background'))?.removedUsd ?? null);
      if (value !== null && value !== undefined) out.set(name, value);
    } catch {
      // One unreadable account does not fail the column for the rest.
    }
  }
  return out;
}
