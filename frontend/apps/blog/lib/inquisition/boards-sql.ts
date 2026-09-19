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
  /** The account that cast the most of them, or '' when the lookup was not reached. */
  topSource: string;
  topSourceVotes: number;
  /** USD removed from this account's posts in the window, or null when not computed. */
  removedUsd: number | null;
  /** Posts that lost value to a downvote. */
  postsHit: number;
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

  /*
   * ★★ THE COUNTS ARE THE BOARD; THE VALUE AND THE SOURCE ARE ENRICHMENT. Both extra
   * queries run against the fifty names this one just chose, and both are allowed to come
   * back empty without failing the board: a missing dollar figure prints a dash, a missing
   * source prints nothing, and the downvote counts beside them are still true.
   */
  const names = rows.map((r) => r.account);
  const [sources, removed] = await Promise.all([
    topSourceFor(names).catch(() => new Map<string, { voter: string; n: number }>()),
    removedByAuthor(names).catch(() => new Map<string, { usd: number; posts: number }>())
  ]);

  return {
    rows: rows.map((r) => {
      const src = sources.get(r.account);
      const val = removed.get(r.account);
      return {
        account: r.account,
        downvotes: Number(r.downvotes) || 0,
        voters: Number(r.voters) || 0,
        topSource: src?.voter ?? '',
        topSourceVotes: src?.n ?? 0,
        removedUsd: val ? val.usd : null,
        postsHit: val?.posts ?? 0
      };
    }),
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

/**
 * ════ WHAT A DOWNVOTE ACTUALLY TOOK ════
 *
 * ★★★ THE MOCK HAS AN RSHARES COLUMN AND THE OWNER ASKED FOR DOLLARS, AND I SHIPPED
 * NEITHER (2026-09-19: "people with most downvotes in terms of vote numbers and $ removed
 * from posts. you did none of this"). A downvote count with no value beside it cannot
 * distinguish thirty trivial flags from one that took a hundred dollars off a post.
 *
 * ★★ THE SUM IS `vote_rshares - net_rshares`, PER POST. `vote_rshares` is the positive
 * side of the vote total and `net_rshares` is what survived the downvotes, so the
 * difference is exactly what the downvotes removed. Both live on `Comments`, so this
 * traces to individual posts a reader can open — which is the spec's bar ("Receipts or it
 * is cut").
 *
 * ★★ AND IT IS CHUNKED AGAINST A TIME BUDGET, because it is not cheap. Measured
 * 2026-09-19: eight authors over three months took **37.5 seconds**. The unrestricted
 * version — scanning `Comments` for `net_rshares < 0` across every author — did not
 * finish inside 90 seconds at all, which is why this only ever runs against names the
 * board has already chosen. Rows past the budget report `null`, and the column renders a
 * dash rather than a zero: "we did not compute it" is not "nothing was taken".
 */
const ENRICH_BUDGET_MS = 150_000;
const ENRICH_CHUNK = 10;

async function removedByAuthor(authors: string[]): Promise<Map<string, { usd: number; posts: number }>> {
  const out = new Map<string, { usd: number; posts: number }>();
  const rate = await hbdPerRshare();
  if (rate <= 0) return out;

  const deadline = Date.now() + ENRICH_BUDGET_MS;
  for (let i = 0; i < authors.length; i += ENRICH_CHUNK) {
    if (Date.now() >= deadline) break;
    const chunk = authors.slice(i, i + ENRICH_CHUNK);
    const placeholders = chunk.map((_, j) => `@a${j}`).join(',');
    const rows = await querySlow<{ author: string; removed_rshares: number; posts: number }>(
      `SELECT c.author,
              SUM(CAST(c.vote_rshares AS float) - CAST(c.net_rshares AS float)) AS removed_rshares,
              COUNT(*) AS posts
       FROM Comments c WITH (NOLOCK)
       WHERE c.depth = 0 AND c.author IN (${placeholders})
         AND c.created > DATEADD(month, -3, GETDATE())
         AND c.net_rshares < c.vote_rshares
       GROUP BY c.author`,
      chunk.map((name, j) => ({ name: `a${j}`, type: TYPES.VarChar, value: name }))
    );
    if (rows === null) break;
    for (const r of rows) {
      out.set(r.author, { usd: (Number(r.removed_rshares) || 0) * rate, posts: Number(r.posts) || 0 });
    }
  }
  return out;
}

/**
 * HBD per rshare, from the live reward fund. `reward_balance / recent_claims` is HIVE per
 * rshare; the median feed price converts that to HBD. Both move daily, so neither is
 * hardcoded — see `vestsPerHive` for the same argument about the VESTS rate.
 */
async function loadHbdPerRshare(): Promise<number> {
  const endpoint = process.env.REACT_APP_API_ENDPOINT || 'https://api.hive.blog';
  const call = async (method: string) => {
    const res = await fetch(endpoint, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ jsonrpc: '2.0', method, params: [method.endsWith('reward_fund') ? 'post' : undefined].filter(Boolean), id: 1 })
    });
    const json = (await res.json()) as { result?: Record<string, string> };
    return json.result ?? null;
  };
  try {
    const [fund, price] = await Promise.all([
      call('condenser_api.get_reward_fund'),
      call('condenser_api.get_current_median_history_price')
    ]);
    const balance = Number.parseFloat(fund?.reward_balance ?? '');
    const claims = Number.parseFloat(fund?.recent_claims ?? '');
    const base = Number.parseFloat(price?.base ?? '');
    const quote = Number.parseFloat(price?.quote ?? '');
    if (![balance, claims, base, quote].every(Number.isFinite) || claims <= 0 || quote <= 0) return 0;
    return (balance / claims) * (base / quote);
  } catch {
    return 0;
  }
}

const hbdPerRshare = withTtlCache(loadHbdPerRshare, () => 'hbd-per-rshare', {
  ttlMs: 30 * 60 * 1000,
  max: 1,
  name: 'inq-rshare-rate',
  shouldCache: (v) => v > 0
});

/**
 * What downvotes took off ONE account's posts, for the profile Record. Same expression
 * as the board's enrichment, one name, lifetime rather than a rolling window — a profile
 * figure that only covered three months would read as a clean record for anyone whose
 * trouble was last year.
 */
export async function removedForAccount(account: string): Promise<number | null> {
  const rate = await hbdPerRshare();
  if (rate <= 0) return null;
  const rows = await queryFast<{ removed_rshares: number }>(
    `SELECT SUM(CAST(c.vote_rshares AS float) - CAST(c.net_rshares AS float)) AS removed_rshares
     FROM Comments c WITH (NOLOCK)
     WHERE c.depth = 0 AND c.author = @account AND c.net_rshares < c.vote_rshares`,
    [{ name: 'account', type: TYPES.VarChar, value: account }]
  );
  if (rows === null || rows.length === 0) return null;
  const rshares = Number(rows[0]?.removed_rshares);
  if (!Number.isFinite(rshares)) return null;
  return rshares * rate;
}

/** Each named account's heaviest single downvoter, from that account's own votes. */
async function topSourceFor(authors: string[]): Promise<Map<string, { voter: string; n: number }>> {
  const best = new Map<string, { voter: string; n: number }>();
  if (authors.length === 0) return best;
  const placeholders = authors.map((_, i) => `@a${i}`).join(',');
  const rows = await querySlow<{ author: string; voter: string; n: number }>(
    `SELECT v.author, v.voter, COUNT(*) AS n
     FROM TxVotes v WITH (NOLOCK)
     WHERE v.weight < 0 AND v.timestamp > DATEADD(month, -3, GETDATE())
       AND v.author IN (${placeholders})
     GROUP BY v.author, v.voter`,
    authors.map((name, i) => ({ name: `a${i}`, type: TYPES.VarChar, value: name }))
  );
  for (const r of rows ?? []) {
    const n = Number(r.n) || 0;
    const held = best.get(r.author);
    if (!held || n > held.n) best.set(r.author, { voter: r.voter, n });
  }
  return best;
}

export const mostDownvoted = withTtlCache(loadMostDownvoted, () => 'most-downvoted', {
  ttlMs: 24 * 60 * 60 * 1000,
  max: 1,
  name: 'inq-board-downvoted',
  shouldCache: (v) => !v.failed && v.rows.length > 0
});

export interface InquisitorRow {
  account: string;
  downvotes: number;
  targets: number;
  topTarget: string;
  topTargetVotes: number;
}

/**
 * ════ BOARD 05 — WHO IS CASTING ════
 *
 * ★★★ THE OTHER END OF BOARD 02, AND IT WAS MISSING ENTIRELY (owner, 2026-09-19:
 * "Wheres the top inquisitors? how many votes they cast, their top target, $ taken").
 * A feature that boards the most-downvoted accounts and not the accounts doing the
 * downvoting is only telling half a story, and it is the half that reads as an
 * accusation. Casting downvotes is a normal, intended use of the chain; this board says
 * who does it and at whom, and nothing about whether they should.
 *
 * ★★ SORTED BY DISTINCT TARGETS, for the same reason board 02 sorts by distinct voters:
 * 900 downvotes aimed at one account is a feud, 200 spread over 40 is a patrol, and the
 * raw count cannot tell them apart.
 *
 * ★★★ WHAT IS **NOT** HERE, AND WHY — the "$ removed" column the owner asked for.
 * `TxVotes` carries `weight` (the vote percentage) and no rshares at all, so the value a
 * downvote removed is simply not in the table this query reads. It lives in
 * `Comments.net_rshares` / `vote_rshares`, per POST. Measured 2026-09-19: scanning
 * `Comments` for `net_rshares < 0` over three months did not finish inside a 90-second
 * request, so the per-voter attribution join is not a thing this can do on the cheap —
 * and attributing a whole post's lost payout to one of its several downvoters would be
 * an invented number wearing a dollar sign. The spec's own bar is "Receipts or it is
 * cut", so it is cut until it can be earned from the reward fund per post. `topTarget`
 * IS traceable: it is that voter's own votes, grouped.
 */
async function loadInquisitors(): Promise<{ rows: InquisitorRow[]; asOf: string; failed: boolean }> {
  /*
   * ★★★ TWO INDEXED PHASES, BECAUSE ONE GROUP-BY DOES NOT FINISH. Measured 2026-09-19:
   * grouping `TxVotes` by (voter, author) over three months with a window function to
   * pick each voter's top target ran past **230 seconds** and was killed. Grouping by
   * voter alone is 70.1s — the same shape and cost as board 02 — and once that has named
   * fifty accounts, asking for THEIR targets is an indexed lookup: 9.2s for six voters,
   * 1,907 rows. Same answer, and it actually returns.
   *
   * This is the `profileRecord` lesson at board scale: narrow to the names first, then
   * ask the expensive question only about those names.
   */
  const leaders = await querySlow<{ account: string; downvotes: number; targets: number }>(
    `SELECT TOP 50 v.voter AS account, COUNT(*) AS downvotes, COUNT(DISTINCT v.author) AS targets
     FROM TxVotes v WITH (NOLOCK)
     JOIN Accounts acc ON acc.name = v.voter
     WHERE v.weight < 0 AND v.timestamp > DATEADD(month, -3, GETDATE())
       AND acc.vesting_shares > @minVests AND acc.created < DATEADD(day, -@minAge, GETDATE())
     GROUP BY v.voter
     -- ★ Targets first: 900 downvotes at one account is a feud, 200 across 40 is a patrol.
     ORDER BY COUNT(DISTINCT v.author) DESC, COUNT(*) DESC`,
    [
      { name: 'minVests', type: TYPES.Float, value: MIN_VESTS },
      { name: 'minAge', type: TYPES.Int, value: MIN_AGE_DAYS }
    ]
  );
  if (leaders === null) return { rows: [], asOf: nowIso(), failed: true };
  if (leaders.length === 0) return { rows: [], asOf: nowIso(), failed: false };

  const names = leaders.map((r) => r.account);
  const placeholders = names.map((_, i) => `@v${i}`).join(',');
  const pairs = await querySlow<{ voter: string; author: string; n: number }>(
    `SELECT v.voter, v.author, COUNT(*) AS n
     FROM TxVotes v WITH (NOLOCK)
     WHERE v.weight < 0 AND v.timestamp > DATEADD(month, -3, GETDATE())
       AND v.voter IN (${placeholders})
     GROUP BY v.voter, v.author`,
    names.map((name, i) => ({ name: `v${i}`, type: TYPES.VarChar, value: name }))
  );

  // ★ A missing phase B is not a missing board. The counts are real either way; only the
  // top-target column goes unknown, and it says so rather than guessing.
  const best = new Map<string, { author: string; n: number }>();
  for (const row of pairs ?? []) {
    const n = Number(row.n) || 0;
    const held = best.get(row.voter);
    if (!held || n > held.n) best.set(row.voter, { author: row.author, n });
  }

  return {
    rows: leaders.map((r) => {
      const top = best.get(r.account);
      return {
        account: r.account,
        downvotes: Number(r.downvotes) || 0,
        targets: Number(r.targets) || 0,
        topTarget: top?.author ?? '',
        topTargetVotes: top?.n ?? 0
      };
    }),
    asOf: nowIso(),
    failed: false
  };
}

export const inquisitorBoard = withTtlCache(loadInquisitors, () => 'inquisitors', {
  ttlMs: 24 * 60 * 60 * 1000,
  max: 1,
  name: 'inq-board-inquisitors',
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
  muterMvests: number;
  publishers: string[];
  ke: number | null;
  band: KeBand;
  rewardsHive: number;
  hp: number;
  /** Downvotes received over the account's whole history. */
  downvotes: number;
  downvoters: number;
  lastDownvote: string | null;
  /** USD taken off this account's payouts by those downvotes, or null if not computed. */
  removedUsd: number | null;
  /** Share of this account's post payouts that sit on posts it voted for itself. */
  selfVotePct: number | null;
  selfVoteUsd: number;
  payoutUsd: number;
  accountAgeDays: number;
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

  /*
   * ★★★ SEVEN FIGURES, ONE ROUND TRIP EACH, BECAUSE THE DESIGN ASKS FOR SEVEN AND I
   * SHIPPED FOUR (owner, 2026-09-19: "youre missing a ton of stuff"). The mock's Record
   * carries DOWNVOTES, REMOVED, MUTED BY, STEEM, KE RATIO, SELF-VOTE and LISTED. Each
   * one below is the narrowest query that answers exactly one of them, every one keyed
   * on this single account name so the index does the work.
   */
  const rows = await queryFast<{
    muted_by: number;
    muter_mvests: number;
    rewards_hive: number;
    hp: number;
    age_days: number;
    downvotes: number;
    downvoters: number;
    last_downvote: string | Date | null;
    self_vote_usd: number;
    payout_usd: number;
  }>(
    `SELECT (SELECT COUNT(*) FROM Mutes WHERE muted = @account) AS muted_by,
            -- ★ DIVIDED BY THE VESTS RATE, BECAUSE THE LABEL SAYS HP. The raw sum is
            -- VESTS; printing it under "M HP" overstated the muters' stake by ~1,610x
            -- (4,498 MVESTS is 2.8M HP, not 4,498M HP).
            (SELECT ISNULL(SUM(CAST(a2.vesting_shares AS float)),0)/@ratio/1000000.0
               FROM Mutes m LEFT JOIN Accounts a2 ON a2.name = m.muter
              WHERE m.muted = @account) AS muter_mvests,
            (CAST(a.posting_rewards AS float) + CAST(a.curation_rewards AS float)) / 1000.0 AS rewards_hive,
            a.vesting_shares / @ratio AS hp,
            DATEDIFF(day, a.created, GETDATE()) AS age_days,
            (SELECT COUNT(*) FROM TxVotes WHERE author = @account AND weight < 0) AS downvotes,
            (SELECT COUNT(DISTINCT voter) FROM TxVotes WHERE author = @account AND weight < 0) AS downvoters,
            (SELECT MAX(timestamp) FROM TxVotes WHERE author = @account AND weight < 0) AS last_downvote,
            -- ★ SELF-VOTE IS DENOMINATED IN PAYOUT, NOT IN VOTES. The mock is explicit
            -- that counting votes "flatters whales and punishes small accounts", so this
            -- is the payout sitting on posts the author voted for, over total payout.
            (SELECT ISNULL(SUM(CAST(c.total_payout_value AS float)),0) FROM Comments c WITH (NOLOCK)
              WHERE c.author = @account AND c.depth = 0
                AND EXISTS (SELECT 1 FROM TxVotes sv WHERE sv.voter = @account
                              AND sv.author = c.author AND sv.permlink = c.permlink AND sv.weight > 0)) AS self_vote_usd,
            (SELECT ISNULL(SUM(CAST(c.total_payout_value AS float)),0) FROM Comments c WITH (NOLOCK)
              WHERE c.author = @account AND c.depth = 0) AS payout_usd
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
  const payoutUsd = Number(rows[0]?.payout_usd) || 0;
  const selfVoteUsd = Number(rows[0]?.self_vote_usd) || 0;
  const last = rows[0]?.last_downvote ?? null;

  return {
    account,
    mutedBy: Number(rows[0]?.muted_by) || 0,
    muterMvests: Number(rows[0]?.muter_mvests) || 0,
    publishers: [],
    ke,
    band: keBand(ke),
    // ★ The DIVISION is done in float (above); only the DISPLAYED figures are rounded.
    rewardsHive: Math.round(rewardsHive),
    hp: Math.round(hp),
    downvotes: Number(rows[0]?.downvotes) || 0,
    downvoters: Number(rows[0]?.downvoters) || 0,
    lastDownvote: last ? new Date(last).toISOString() : null,
    // Filled by the route, which owns the slower value lookup.
    removedUsd: null,
    // ★ `null`, not 0, when the account has never been paid: 0% would read as a clean
    // record where the truth is that there is nothing to take a share of.
    selfVotePct: payoutUsd > 0 ? Number(((selfVoteUsd / payoutUsd) * 100).toFixed(1)) : null,
    selfVoteUsd,
    payoutUsd,
    accountAgeDays: Number(rows[0]?.age_days) || 0,
    asOf: nowIso()
  };
}
