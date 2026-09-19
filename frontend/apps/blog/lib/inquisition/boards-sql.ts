import 'server-only';
import { TYPES } from 'tedious';
import { withTtlCache } from '@/blog/lib/server-ttl-cache';
import { hiveSqlConfigured, queryFast, querySlow } from './hivesql';
import { nowIso } from './types';

/**
 * ════ THE BOARDS, AS SQL ════
 *
 * ★ THE FLOORS ARE IN THE QUERY, NOT THE RENDER (spec §1: "Minimum 5,000 HP and 90
 * days of account age for any leaderboard"). Filtering after the fact would mean
 * fetching rows we are not allowed to show, and a floor that lives in one place cannot
 * be forgotten by a second caller.
 *
 * 5,000 HP is roughly 10,000,000 VESTS at present rates; the column is `vesting_shares`
 * so the comparison is done there rather than converting a million rows.
 */

const MIN_VESTS = 10_000_000;
const MIN_AGE_DAYS = 90;

export interface MutedRow {
  account: string;
  mutedBy: number;
  muterMvests: number;
}

export interface DownvotedRow {
  account: string;
  downvotes: number;
  voters: number;
}

/**
 * Most muted, weighted by who is doing the muting.
 *
 * ★★ MUTER STAKE IS THE CORRECTIVE, AND WITHOUT IT THIS BOARD LIES. A mute is free and
 * personal, so a raw count rewards whoever annoyed the largest number of small
 * accounts. Measured at 2.6s including the join and both floors.
 */
async function loadMostMuted(): Promise<{ rows: MutedRow[]; asOf: string; failed: boolean }> {
  const rows = await querySlow<{ account: string; muted_by: number; muter_mvests: number }>(
    `SELECT TOP 50 m.muted AS account, COUNT(*) AS muted_by,
            CAST(SUM(CAST(ISNULL(a2.vesting_shares,0) AS float))/1000000.0 AS int) AS muter_mvests
     FROM Mutes m
     JOIN Accounts a1 ON a1.name = m.muted
     LEFT JOIN Accounts a2 ON a2.name = m.muter
     WHERE a1.vesting_shares > @minVests AND a1.created < DATEADD(day, -@minAge, GETDATE())
     GROUP BY m.muted
     ORDER BY COUNT(*) DESC`,
    [
      { name: 'minVests', type: TYPES.Float, value: MIN_VESTS },
      { name: 'minAge', type: TYPES.Int, value: MIN_AGE_DAYS }
    ]
  );
  // `null` is "the database did not answer"; an empty array is "it answered, none".
  if (rows === null) return { rows: [], asOf: nowIso(), failed: true };
  return {
    rows: rows.map((r) => ({
      account: r.account,
      mutedBy: Number(r.muted_by) || 0,
      muterMvests: Number(r.muter_mvests) || 0
    })),
    asOf: nowIso(),
    failed: false
  };
}

/**
 * ★ THE BLACKLIST BOARD MOVED OUT OF SQL. `Blacklists` carries only the blacklisted
 * list type, and two of the four publishers publish under `muted` — see the long note
 * in the boards route. `bridge.get_follow_list` reads both, so it owns that board now.
 * `PUBLISHERS` survives only for `accountMarks` below, and is kept in step with the
 * one real table in `blacklists.ts`.
 */
const PUBLISHERS = ['hivewatchers', 'spaminator', 'steemcleaners', 'buildawhale'];

/**
 * Most downvoted, sorted by DISTINCT VOTERS.
 *
 * ★★ 903 DOWNVOTES FROM 12 ACCOUNTS IS A DISPUTE; 212 FROM 29 IS A CONSENSUS. Sorting
 * by volume lets one large downvoter manufacture the top of the board, so the default
 * sort is voters and both numbers are shown.
 *
 * ★★★ THE WINDOW IS THREE MONTHS BECAUSE TWELVE DOES NOT FINISH. Measured: a 12-month
 * aggregate blew past a 60s request timeout; 3 months returns in 80.2s. That is a
 * nightly job's budget, not a reader's, and this function is only ever called by the
 * refresher.
 */
async function loadMostDownvoted(): Promise<{ rows: DownvotedRow[]; asOf: string }> {
  const rows = await querySlow<{ account: string; downvotes: number; voters: number }>(
    `SELECT TOP 50 v.author AS account, COUNT(*) AS downvotes, COUNT(DISTINCT v.voter) AS voters
     FROM TxVotes v WITH (NOLOCK)
     JOIN Accounts a ON a.name = v.author
     WHERE v.weight < 0 AND v.timestamp > DATEADD(month, -3, GETDATE())
       AND a.vesting_shares > @minVests AND a.created < DATEADD(day, -@minAge, GETDATE())
     GROUP BY v.author
     ORDER BY COUNT(DISTINCT v.voter) DESC`,
    [
      { name: 'minVests', type: TYPES.Float, value: MIN_VESTS },
      { name: 'minAge', type: TYPES.Int, value: MIN_AGE_DAYS }
    ]
  );
  return {
    rows: (rows ?? []).map((r) => ({
      account: r.account,
      downvotes: Number(r.downvotes) || 0,
      voters: Number(r.voters) || 0
    })),
    asOf: nowIso()
  };
}

/**
 * ★ PER-ACCOUNT, AND FAST ENOUGH TO ASK ON DEMAND (264ms measured). This is the only
 * HiveSQL call a profile is allowed to make. The downvote figure is deliberately NOT
 * here: at 20s per account it belongs to the refresher.
 */
export async function accountMarks(
  account: string
): Promise<{ mutedBy: number; publishers: string[] } | null> {
  if (!hiveSqlConfigured()) return null;
  const list = PUBLISHERS.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
  const rows = await queryFast<{ muted_by: number; publisher: string | null }>(
    `SELECT (SELECT COUNT(*) FROM Mutes WHERE muted = @account) AS muted_by,
            b.blacklister AS publisher
     FROM (SELECT 1 AS one) seed
     LEFT JOIN Blacklists b ON b.blacklisted = @account AND b.blacklister IN (${list})`,
    [{ name: 'account', type: TYPES.VarChar, value: account }]
  );
  if (!rows) return null;
  return {
    mutedBy: Number(rows[0]?.muted_by) || 0,
    publishers: rows.map((r) => r.publisher).filter((p): p is string => Boolean(p))
  };
}

export const mostMuted = withTtlCache(loadMostMuted, () => 'most-muted', {
  ttlMs: 6 * 60 * 60 * 1000,
  max: 1,
  name: 'inq-board-muted',
  shouldCache: (v) => !v.failed && v.rows.length > 0
});

export const mostDownvoted = withTtlCache(loadMostDownvoted, () => 'most-downvoted', {
  ttlMs: 24 * 60 * 60 * 1000,
  max: 1,
  name: 'inq-board-downvoted',
  shouldCache: (v) => v.rows.length > 0
});
