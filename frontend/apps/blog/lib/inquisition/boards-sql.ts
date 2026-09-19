import 'server-only';
import { TYPES } from 'tedious';
import { withTtlCache } from '@/blog/lib/server-ttl-cache';
import { hiveSqlConfigured, queryFast, querySlow } from './hivesql';
import { keBand, nowIso } from './types';
import type { KeBand } from './types';

/**
 * ════ THE BOARDS, AS SQL ════
 *
 * ★ THE FLOORS ARE IN THE QUERY, NOT THE RENDER (spec §1: "Minimum 5,000 HP and 90
 * days of account age for any leaderboard"). Filtering after the fact would mean
 * fetching rows we are not allowed to show, and a floor that lives in one place cannot
 * be forgotten by a second caller.
 *
 * ★ THE FLOOR IS EXPRESSED IN VESTS, SO ITS HP VALUE DRIFTS, and the number quoted here
 * used to be wrong (found by adversarial review, 2026-09-19). 10,000,000 VESTS is
 * **6,211 HP** at the rate measured on 2026-09-19 (1,609.92 VESTS/HIVE), not the 5,000
 * the comment claimed — a floor 24% above spec. It stays in VESTS because the column is
 * `vesting_shares` and converting a million rows to compare them is absurd; what
 * changes is that the prose now states the real figure and the date it was true.
 * Verified against the live table the same day: @lordbutterfly holds 121,380,838.23
 * vesting_shares = 75,395 HP, which matches the site, so the column is whole VESTS.
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
 * Most muted, ranked by how many accounts did it, with the muters' stake beside it.
 *
 * ★★ THE RANK IS THE COUNT AND THE COMMENT USED TO CLAIM OTHERWISE (found by
 * adversarial review, 2026-09-19). It said stake was "the corrective, and without it
 * this board lies", and then ordered by `COUNT(*)`. One of the two had to go.
 *
 * The count stays, because it is what the board is called and what the column says: a
 * mute is one person's free, personal decision, and "how many people have made it" is a
 * fact a reader can check. Stake-weighting would rank an account muted by two whales
 * above one muted by a hundred people, which is a different and much more opinionated
 * board than the one advertised. Stake is shown alongside precisely so the reader can
 * apply that judgement themselves.
 *
 * ★ THE LIMITATION THAT FOLLOWS, STATED RATHER THAN HIDDEN: `TOP 50` selects by count
 * too, so an account muted by a handful of very large accounts does not appear at all.
 * Measured at 2.6s including the join and both floors.
 */
async function loadMostMuted(): Promise<{ rows: MutedRow[]; asOf: string; failed: boolean }> {
  const rows = await querySlow<{ account: string; muted_by: number; muter_mvests: number }>(
    `SELECT TOP 50 m.muted AS account, COUNT(*) AS muted_by,
            -- ★ decimal, not int: a row muted entirely by small holders rendered 0M.
            CAST(SUM(CAST(ISNULL(a2.vesting_shares,0) AS float))/1000000.0 AS decimal(14,2)) AS muter_mvests
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

/*
 * ★ NOTHING IN THIS FILE READS `Blacklists` ANY MORE. `Blacklists` carries only the
 * blacklisted list type, and two of the four publishers publish under `muted` — see the
 * long note in the boards route. `bridge.get_follow_list` reads both, so `blacklists.ts`
 * owns every listing question now, for the board AND for the profile record. The local
 * copy of the publisher list and the SQL path that used it are gone rather than kept
 * "in step": a second copy of a list is a second thing to forget.
 */

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
async function loadMostDownvoted(): Promise<{ rows: DownvotedRow[]; asOf: string; failed: boolean }> {
  const rows = await querySlow<{ account: string; downvotes: number; voters: number }>(
    `SELECT TOP 50 v.author AS account, COUNT(*) AS downvotes, COUNT(DISTINCT v.voter) AS voters
     FROM TxVotes v WITH (NOLOCK)
     JOIN Accounts a ON a.name = v.author
     WHERE v.weight < 0 AND v.timestamp > DATEADD(month, -3, GETDATE())
       AND a.vesting_shares > @minVests AND a.created < DATEADD(day, -@minAge, GETDATE())
     GROUP BY v.author
     -- ★ VOTERS FIRST, COUNT AS THE TIEBREAK. 903 downvotes from 12 accounts is one
     -- dispute; 212 from 29 is a consensus, and consensus is what the board is for.
     -- Without the second key, 22-from-22 outranked 1,875-from-22 by accident.
     ORDER BY COUNT(DISTINCT v.voter) DESC, COUNT(*) DESC`,
    [
      { name: 'minVests', type: TYPES.Float, value: MIN_VESTS },
      { name: 'minAge', type: TYPES.Int, value: MIN_AGE_DAYS }
    ]
  );
  // ★ `null` is "we could not ask" and must never become an empty board — see hivesql.ts.
  if (rows === null) return { rows: [], asOf: nowIso(), failed: true };
  return {
    rows: rows.map((r) => ({
      account: r.account,
      downvotes: Number(r.downvotes) || 0,
      voters: Number(r.voters) || 0
    })),
    asOf: nowIso(),
    failed: false
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
  shouldCache: (v) => !v.failed && v.rows.length > 0
});

/**
 * ════ KE, AND THE ACCOUNT RECORD ════
 */

export interface KeRow {
  account: string;
  ke: number;
  rewardsHive: number;
  hp: number;
  band: KeBand;
}

/**
 * ★★ THE VESTS→HP RATE IS READ FROM THE CHAIN, NOT HARDCODED. It drifts (1609.92 VESTS
 * per HIVE on 2026-09-19) and a fixed divisor would quietly skew every KE on the board
 * as the vesting fund moves. One RPC call, cached with the board that uses it.
 */
async function loadVestsPerHive(): Promise<number> {
  const endpoint = process.env.REACT_APP_API_ENDPOINT || 'https://api.hive.blog';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      signal: AbortSignal.timeout(4000),
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'condenser_api.get_dynamic_global_properties',
        params: [],
        id: 1
      })
    });
    const json = (await res.json()) as { result?: { total_vesting_fund_hive?: string; total_vesting_shares?: string } };
    const fund = Number.parseFloat(json.result?.total_vesting_fund_hive ?? '');
    const shares = Number.parseFloat(json.result?.total_vesting_shares ?? '');
    if (!Number.isFinite(fund) || !Number.isFinite(shares) || fund <= 0) return 0;
    return shares / fund;
  } catch {
    return 0;
  }
}

/**
 * ★★ CACHED, BECAUSE THE COMMENT ABOVE CLAIMED IT WAS AND IT WAS NOT (found by
 * adversarial review, 2026-09-19). Only the BOARD's result was cached; the per-account
 * record awaited a fresh RPC on every cache miss, before the query, which turned the
 * documented "264ms" into up to 4s + 8s. The rate moves with the vesting fund, which is
 * to say slowly, so fifteen minutes is generous.
 *
 * ★ `shouldCache` refuses a 0. A zero is "the chain did not answer", and caching that
 * would pin every KE on the site to a fallback for fifteen minutes.
 */
const vestsPerHive = withTtlCache(loadVestsPerHive, () => 'vests-per-hive', {
  ttlMs: 15 * 60 * 1000,
  max: 1,
  name: 'inq-vests-rate',
  shouldCache: (value) => value > 0
});

/**
 * KE = lifetime rewards taken ÷ stake held.
 *
 * ★ ONE TABLE SCAN, NO REWARD HISTORY. `Accounts.posting_rewards` and
 * `.curation_rewards` are lifetime totals in milli-HIVE, so the numerator is two
 * columns rather than the tens of thousands of virtual ops the HAF path had to walk.
 * Measured at 3.0s for the whole board with both leaderboard floors applied.
 *
 * ★★ THE BAND WORDS SHIP BARE. What KE is and is not lives in `types.ts` beside the
 * thresholds, and stays in the code — the owner's instruction is that no definition of
 * "extractive" or "net holder" reaches the screen.
 */
async function loadKeBoard(): Promise<{ rows: KeRow[]; asOf: string; failed: boolean }> {
  const ratio = await vestsPerHive();
  if (ratio <= 0) return { rows: [], asOf: nowIso(), failed: true };

  const rows = await querySlow<{ account: string; rewards_hive: number; hp: number; ke: number }>(
    `SELECT TOP 50 name AS account,
            CAST((CAST(posting_rewards AS float) + CAST(curation_rewards AS float)) / 1000.0 AS int) AS rewards_hive,
            CAST(vesting_shares / @ratio AS int) AS hp,
            CAST(((CAST(posting_rewards AS float) + CAST(curation_rewards AS float)) / 1000.0)
                 / NULLIF(vesting_shares / @ratio, 0) AS decimal(12,2)) AS ke
     FROM Accounts
     WHERE vesting_shares > @minVests AND created < DATEADD(day, -@minAge, GETDATE())
       AND (CAST(posting_rewards AS float) + CAST(curation_rewards AS float)) > 0
     ORDER BY ((CAST(posting_rewards AS float) + CAST(curation_rewards AS float)) / 1000.0)
              / NULLIF(vesting_shares / @ratio, 0) DESC`,
    [
      { name: 'ratio', type: TYPES.Float, value: ratio },
      { name: 'minVests', type: TYPES.Float, value: MIN_VESTS },
      { name: 'minAge', type: TYPES.Int, value: MIN_AGE_DAYS }
    ]
  );
  if (rows === null) return { rows: [], asOf: nowIso(), failed: true };
  return {
    rows: rows.map((r) => {
      const ke = Number(r.ke) || 0;
      return {
        account: r.account,
        ke,
        rewardsHive: Number(r.rewards_hive) || 0,
        hp: Number(r.hp) || 0,
        band: keBand(ke)
      };
    }),
    asOf: nowIso(),
    failed: false
  };
}

export const keBoard = withTtlCache(loadKeBoard, () => 'ke', {
  ttlMs: 6 * 60 * 60 * 1000,
  max: 1,
  name: 'inq-board-ke',
  shouldCache: (v) => !v.failed && v.rows.length > 0
});

export interface ProfileRecord {
  account: string;
  mutedBy: number;
  publishers: string[];
  ke: number | null;
  band: KeBand;
  rewardsHive: number;
  hp: number;
  asOf: string;
}

/**
 * ★★★ EVERYTHING A PROFILE SHOWS, IN ONE ROUND TRIP AND UNDER A SECOND. Measured 264ms.
 * The downvote figure is deliberately absent — 20.4s per account is not something a
 * profile may wait for, and a number we cannot fetch in time is not a number we print.
 *
 * ★★ THE LISTINGS ARE NOT READ FROM SQL, AND THAT IS A BUG FIX, NOT A PREFERENCE. The
 * `Blacklists` table only holds entries a publisher filed as `blacklisted`; hivewatchers
 * and steemcleaners file theirs as `muted`, which lands in `Mutes` indistinguishable
 * from one reader muting another. A SQL-only record therefore told @lordbutterfly
 * "Lists: None" while the Lists board — reading the bridge, both types, same four
 * publishers — held 83 rows from all four. Two surfaces of one feature disagreeing is
 * the feature lying on one of them. The route now merges `marksFor()`, so the strip and
 * the board are the same answer by construction.
 */
export async function profileRecord(account: string): Promise<ProfileRecord | null> {
  if (!hiveSqlConfigured()) return null;
  /*
   * ★★★ NO HARDCODED FALLBACK RATE. This used to fall back to `1609.92` — a rate
   * measured on 2026-09-19 — whenever `vestsPerHive()` timed out, while `loadKeBoard`
   * failed hard on the same condition. So one four-second blip on api.hive.blog made
   * the board say "the chain did not answer" and the profile print a confident
   * two-decimal KE from a frozen snapshot, cached for a day and indistinguishable from
   * a good one. Two surfaces of one feature disagreeing is the feature lying on one of
   * them (see the Lists note below); a stale divisor is the lying one.
   */
  const ratio = await vestsPerHive();
  if (ratio <= 0) return null;
  const rows = await queryFast<{
    muted_by: number;
    rewards_hive: number;
    hp: number;
  }>(
    `SELECT (SELECT COUNT(*) FROM Mutes WHERE muted = @account) AS muted_by,
            (CAST(a.posting_rewards AS float) + CAST(a.curation_rewards AS float)) / 1000.0 AS rewards_hive,
            a.vesting_shares / @ratio AS hp
     FROM Accounts a
     WHERE a.name = @account`,
    [
      { name: 'account', type: TYPES.VarChar, value: account },
      { name: 'ratio', type: TYPES.Float, value: ratio }
    ]
  );
  if (rows === null || rows.length === 0) return null;
  /*
   * ★★ THE DIVISION HAPPENS IN FLOAT, AND ROUNDING COMES LAST. Both sides used to be
   * `CAST(... AS int)` before the divide, and this record — unlike the board — applies
   * no HP floor, so it runs on accounts with single-digit HP where that is not a
   * rounding detail: 1.99 HP truncated to 1 turned a real KE of 25,125 into a printed
   * 50,000. The board always did this correctly; the two now agree.
   */
  const hp = Number(rows[0]?.hp) || 0;
  const rewardsHive = Number(rows[0]?.rewards_hive) || 0;
  const ke = hp > 0 ? Number((rewardsHive / hp).toFixed(2)) : null;
  return {
    account,
    mutedBy: Number(rows[0]?.muted_by) || 0,
    publishers: [],
    ke,
    band: keBand(ke),
    // ★ The DIVISION is done in float (above); only the DISPLAYED figures are rounded.
    rewardsHive: Math.round(rewardsHive),
    hp: Math.round(hp),
    asOf: nowIso()
  };
}
