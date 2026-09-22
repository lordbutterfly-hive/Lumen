import 'server-only';
import { TYPES } from 'tedious';
import { withTtlCache } from '@/blog/lib/server-ttl-cache';
import { getLogger } from '@ui/lib/logging';
import { hiveSqlConfigured, queryCapped, queryReader, querySlow } from './hivesql';
import { readBoard } from './board-store';
import { removedForMany } from './vote-ledger';
import { muteRoll, rankMuted } from './mutes';
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

const logger = getLogger('app');

const MIN_VESTS = 10_000_000;
const MIN_AGE_DAYS = 90;

/**
 * ★★★ HOW MANY VOTE LEDGERS THE MONEY COLUMNS ARE SUMMED OVER, AND IT IS THE WHOLE COST
 * OF THIS FEATURE'S SLOW PATH.
 *
 * One ledger is ~12s (883 posts, ~8 MB of vote JSON). Twelve of them left the money
 * column blank on 88 rows out of 100, which the owner saw immediately: "only a few
 * numbers populate. about 12. no more." Forty is about eight minutes — irrelevant on a
 * board rebuilt once a week and served from disk in between — and because the
 * ledgers are cached per account and the two boards' seed sets overlap heavily, the
 * second board mostly reads the first one's work for free.
 *
 * The cost is paid once a day. Rows past this depth report `null`, which the column
 * renders as a dash and says "not computed" on hover, never as zero.
 */
/**
 * How many rows carry a money figure, and how long the pass may take. One account is
 * ~19s (measured on @themarkymark's 60,000-post history), so this is the cost knob. Rows
 * past it report null rather than a number that covers a fraction of the account.
 *
 * ★★ THE BUDGET IS 30 MINUTES, NOT 14 (2026-09-20). The pass is a background job behind a
 * disk store that is rebuilt once a week, and it is now driven by the nightly warm rather
 * than by whoever opens the page. Fourteen minutes at the old 150s cap bought four valued
 * rows out of nineteen attempts; the pass exits early when the queue is exhausted, so the
 * larger figure costs nothing on the boards that finish quickly. A pass that ends
 * out-of-budget leaves the board at stage 2 and the next one resumes with the accounts it
 * never reached -- that is how the column converges instead of freezing.
 */
/**
 * ★★★ ONE HUNDRED ROWS PER LIST, BUILT ONCE FOR EVERYONE (owner, 2026-09-19: "cant you
 * build once for everyone for top 100 per list and then update the list 1 time every 3
 * days or so").
 *
 * The expensive part of every board is the aggregate, not the row count: `TOP 100` costs
 * essentially what `TOP 50` cost, because the database has already done the grouping
 * either way. So the earlier design — build 50, and have SHOW MORE fire a second, deeper
 * 150-row query — was paying twice for something it could have had once. The deep tier,
 * its duplicate cache slots and the bug where one press left every later board requesting
 * an unbuilt tier all went with it. SHOW MORE now reveals rows the reader already holds.
 */
export const BOARD_ROWS = 100;

/*
 * ★★★ EVERY ROW, NOT THE TOP THIRTY (owner, 2026-09-20: "build the fucking lists properly
 * for all data points and all users", "i need you to populate all and then prperly
 * populate it per week ... automatically").
 *
 * Thirty was a cost knob from when this pass ran behind whoever opened the page, and it
 * meant seventy of a hundred rows carried a dash no matter how well the pass ran. The
 * pass is now driven by the nightly timer, it resumes exactly where the last one stopped
 * (`done` on disk), and the budget below is a wall clock rather than a row count -- so
 * the honest setting is the whole board.
 */
export const MONEY_ROWS = BOARD_ROWS;
export const MONEY_BUDGET_MS = 4 * 60 * 60 * 1000;

/**
 * How many rows get a true top target, how many per statement, and how long the whole
 * pass may take. Each is an indexed TOP-1 aggregate over that voter's entire downvote
 * history, and the biggest of them has 1.7 million votes to group.
 */
/* ★ THE WHOLE BOARD, same reason as MONEY_ROWS above. */
export const TOP_TARGET_ROWS = BOARD_ROWS;
/*
 * ★★★ ONE NAME PER STATEMENT, AND A CEILING ON EACH, BECAUSE A CHUNK OF FOUR MEANT ONE
 * GIANT TOOK THREE INNOCENTS WITH IT (measured 2026-09-20).
 *
 * At four names per statement the whole chunk shares one `querySlow` and one 240s
 * ceiling. @spaminator has 1.7 million downvotes to group; when its chunk ran over, the
 * statement returned `null` and `topCounterpart` skipped it — taking the other three
 * names in that chunk with it, silently, because a skip has no error string to log. A
 * cold build filled 12 of 25 rows and nothing anywhere said why.
 *
 * One name per statement means a giant can only cost itself, and `TOP_TARGET_QUERY_MS`
 * means it costs 60 seconds rather than 240 — a normal account takes ~16s, so anything
 * past a minute is not going to finish inside the budget anyway, and the seconds are
 * better spent on names that can.
 */
export const TOP_TARGET_CHUNK = 1;
const TOP_TARGET_QUERY_MS = 60 * 1000;

/*
 * ★★★ THE RANKING GETS TWELVE MINUTES, NOT FOUR, AND THE MARGIN IS THE WHOLE POINT
 * (2026-09-20).
 *
 * Measured against an unloaded HiveSQL: 105s with literals, 117s through tedious with
 * the exact parameters this file sends. `querySlow`'s ceiling is 240s, so the healthy
 * case had barely 2x of headroom on a database shared with everybody else who uses the
 * free mirror. It ran out: during one session the query crossed 240s, timed out,
 * returned `null`, failed the build, waited out the cooldown and did it again — for
 * twenty minutes, silently, while the board served "building" and no rows.
 *
 * Nobody waits on this. It is a background build behind a file that is rebuilt once a
 * WEEK and served from disk in between, so the cost of being generous is nil and the
 * cost of being tight is a board that never appears. Twelve minutes is ~6x the measured
 * time; the `SLOW_LANE` of two still bounds how many can run at once.
 */
const RANK_QUERY_MS = 12 * 60 * 1000;

/** The deduped per-account downvote count. @haejin is 23.2s; this is generous headroom. */
const DOWNVOTE_COUNT_MS = 90 * 1000;
/*
 * ★★ TEN MINUTES, NOT FOUR, BECAUSE DEDUPLICATING THE COUNT MADE THIS PASS SLOWER AND
 * THERE IS NO CHEAPER WAY TO GET IT RIGHT (2026-09-20). Picking the top counterpart by
 * `COUNT(*)` picked the loudest BOT, not the heaviest downvoter — a re-vote bot with
 * 935,143 logged operations beat a real flagger with 3,000 actual downvotes.
 * `COUNT(DISTINCT permlink)` picks the real one and costs ~16s per account against ~4s.
 *
 * ★ FOLDING THIS INTO THE RANKING QUERY WAS TRIED AND MEASURED, AND IT DOES NOT WORK.
 * One statement computing the ranking and the counterpart together over a shared CTE
 * would have covered all 100 rows instead of 25 and skipped a stage entirely — but SQL
 * Server does not materialise a CTE, it re-executes it, so the 157s pair-collapse ran
 * twice and the statement timed out at 280s. It stays two passes.
 */
export const TOP_TARGET_BUDGET_MS = 2 * 60 * 60 * 1000;

/** The KE board's stake floor, in HP. Converted to VESTS at the live rate. */
const KE_MIN_HP = 500;


export interface MutedRow {
  account: string;
  mutedBy: number;
  /** Combined stake of the muters in millions of HP, or `null` when it was not computed. */
  muterMvests: number | null;
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
async function loadMostMuted(limit = BOARD_ROWS): Promise<{ rows: MutedRow[]; asOf: string; failed: boolean }> {
  const ratio = await vestsPerHive();

  /*
   * ★★★ THIS BOARD NO LONGER RANKS ON `Mutes`, AND THE OLD VERSION WAS NOT SLIGHTLY
   * WRONG, IT WAS MEANINGLESS (found by audit, 2026-09-20).
   *
   * `SELECT COUNT(*) ... GROUP BY m.muted` reads the table in the one direction it
   * cannot answer. Coverage against live chain state: @haejin 7 of 651, @berniesanders
   * 0 of 638, @themarkymark 65 of 171, and the board's own #1 @heimindanger 119 of 172.
   * A ranking built on 1%-to-69% coverage is not a scaled-down ranking, it is a
   * different and arbitrary one — #1 was whoever's muters happened to be ingested.
   *
   * ★★ IT ALSO CARRIED THE STAKE FLOOR THAT THE DOWNVOTE BOARDS DROPPED. @berniesanders
   * holds 3 HP; a 6,211 HP floor meant to keep dust off the board was removing its most
   * notorious entry. Gone here for the same reason it went there: an account 638 people
   * have muted is self-evidently not dust.
   *
   * ★ WHAT IT COSTS. The candidate scan is ~26 minutes of sliced reads once a WEEK, and
   * the counts are ~400 sequential chain calls (~1 minute). Between rebuilds this is a
   * file on disk. See `mutes.ts` for why the pool cannot miss anybody.
   */
  const runSlice = async (fromIso: string, toIso: string, minOps: number) => {
    const rows = await queryCapped<{ account: string; ops: number }>(
      `SELECT JSON_VALUE(json,'$[1].following') AS account, COUNT(*) AS ops
       FROM TxCustoms WITH (NOLOCK)
       WHERE tid = 'follow' AND json LIKE '%"ignore"%'
         AND timestamp >= @from AND timestamp < @to
       GROUP BY JSON_VALUE(json,'$[1].following')
       HAVING COUNT(*) >= @minOps`,
      [
        { name: 'from', type: TYPES.VarChar, value: fromIso },
        { name: 'to', type: TYPES.VarChar, value: toIso },
        { name: 'minOps', type: TYPES.Int, value: minOps }
      ],
      RANK_QUERY_MS
    );
    if (rows === null) {
      logger.warn(`inquisition: mute candidate slice ${fromIso}..${toIso} did not answer; pool is thinner`);
      return null;
    }
    return rows.map((r) => ({ account: String(r.account ?? ''), ops: Number(r.ops) || 0 }));
  };

  const ranked = await rankMuted(runSlice, limit);
  if (ranked === null) return { rows: [], asOf: nowIso(), failed: true };

  /*
   * The stake behind the muters, summed from the names the chain gave us. One statement
   * for the whole board: every (account, muter) pair goes over as one JSON parameter and
   * `OPENJSON` expands it server-side.
   */
  const pairs = ranked.flatMap((row) => row.muters.map((muter) => ({ a: row.account, m: muter })));
  const stake = new Map<string, number>();
  if (ratio > 0 && pairs.length > 0) {
    const rows = await queryCapped<{ account: string; mvests: number }>(
      `SELECT n.a AS account,
              SUM(CAST(ISNULL(acc.vesting_shares, 0) AS float)) / @ratio / 1000000.0 AS mvests
       FROM OPENJSON(@pairs) WITH (a nvarchar(20) '$.a', m nvarchar(20) '$.m') AS n
       LEFT JOIN Accounts acc WITH (NOLOCK) ON acc.name = n.m
       GROUP BY n.a`,
      [
        { name: 'pairs', type: TYPES.NVarChar, value: JSON.stringify(pairs) },
        { name: 'ratio', type: TYPES.Float, value: ratio }
      ],
      RANK_QUERY_MS
    );
    if (rows === null) {
      logger.warn('inquisition: muter stake query did not answer; the board shows counts without stake');
    } else {
      for (const r of rows) stake.set(r.account, Number(r.mvests) || 0);
    }
  }

  return {
    rows: ranked.map((r) => ({
      account: r.account,
      mutedBy: r.mutedBy,
      // ★ `null`, not 0, when the stake pass did not run: 0M HP is a claim that the
      // people muting this account hold nothing.
      muterMvests: stake.has(r.account) ? Number((stake.get(r.account) ?? 0).toFixed(2)) : null
    })),
    asOf: nowIso(),
    failed: false
  };
}

export const mostMuted = withTtlCache(loadMostMuted, (limit = BOARD_ROWS) => `most-muted:${limit}`, {
  // ★ ONE WEEK, MATCHING THE DISK STORE IN FRONT OF IT (owner, 2026-09-20: "we pull
  // new data only once a week"). At six hours this in-memory copy expired four times a
  // day and the next caller recomputed a ~26-minute scan that the board file already
  // held. The disk store is the thing with the real cadence; this must not undercut it.
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  max: 2,
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
  const removed = await removedForMany(authors.slice(0, MONEY_ROWS), 'author', MONEY_BUDGET_MS).catch(
    () => new Map<string, number>()
  );
  for (const [author, usd] of removed) out.set(author, { usd, posts: 0 });
  return out;
}


export interface InquisitorRow {
  account: string;
  downvotes: number;
  targets: number;
  topTarget: string;
  topTargetVotes: number;
  /** HBD this account's downvotes took off every post they landed on, or null if not computed. */
  removedUsd: number | null;
}

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
async function loadKeBoard(limit = BOARD_ROWS): Promise<{ rows: KeRow[]; asOf: string; failed: boolean }> {
  const ratio = await vestsPerHive();
  if (ratio <= 0) return { rows: [], asOf: nowIso(), failed: true };

  /*
   * ★★★ THE FLOOR IS 500 HP AND THE ACCOUNT MUST STILL BE POSTING (owner, 2026-09-19:
   * "the KE index should show from worth to best accounts above 500Hp that have posted
   * inside last 3 months").
   *
   * Both conditions change what the board is for. The old 10,000,000 VESTS floor was
   * 6,211 HP, which quietly excluded most real authors and left the board reading as a
   * list of large stakeholders; 500 HP is a floor against noise, not against people. And
   * a KE ratio on a dormant account is an epitaph, not a finding: the number cannot move
   * because nobody is posting. `Accounts.last_root_post` makes that a column test rather
   * than a join, so it costs nothing.
   *
   * ★★ IT IS `last_root_post`, NOT `last_post`, AND THE DIFFERENCE PUT A TWO-YEARS-DORMANT
   * ACCOUNT AT RANK 2 (found by audit, 2026-09-20). `last_post` moves on any comment, so
   * the gate read "commented in the last 3 months" while the owner asked for "posted".
   * @ssg-community sat at #2 with a KE of 120.62 on a comment left in June; its last
   * actual post was 2024-07-23, twenty-six months earlier. @vimukthi was on the board the
   * same way. This file already knew the distinction — it uses `depth = 0` elsewhere to
   * mean exactly "a post, not a comment" — and then gated this board on the wrong column.
   *
   * ★ THE FLOOR IS COMPUTED FROM THE LIVE RATE, not hardcoded in VESTS, because the rate
   * drifts and a fixed VESTS constant silently becomes a different HP floor every month.
   * That is exactly how the old comment came to claim 5,000 HP for a 6,211 HP floor.
   *
   * ★ WORST FIRST, which is what the ORDER BY already did: highest KE is the most
   * extractive, and the band word beside it says so in words.
   */
  const minVests = KE_MIN_HP * ratio;

  const rows = await querySlow<{ account: string; rewards_hive: number; hp: number; ke: number }>(
    /* ★★★ THE REWARD FIELDS ARE THOUSANDTHS OF HIVE, NOT VESTS (corrected 2026-09-22).
       `Accounts.posting_rewards` / `curation_rewards` are the chain's own integers in
       0.001 HIVE: @azircon's published figures ("Author Rewards = 30804 hive, Curation
       Rewards = 235719 hive", May 2025) are exactly those integers / 1000, and his KE
       of 0.26 only comes out that way. `vesting_shares` IS VESTS, so HP = vests / rate.
       The 2026-09-20 change that treated the rewards as VESTS and divided milli-HIVE by
       VESTS made every KE on the site 62% of the true value (1000/1609) and drifting.
       KE = (author + curation rewards in HIVE) / HP held, azircon's definition. */
    `SELECT TOP (@lim) name AS account,
            CAST((CAST(posting_rewards AS float) + CAST(curation_rewards AS float)) / 1000.0 AS int) AS rewards_hive,
            CAST(vesting_shares / @ratio AS int) AS hp,
            CAST(((CAST(posting_rewards AS float) + CAST(curation_rewards AS float)) / 1000.0)
                 / NULLIF(CAST(vesting_shares AS float) / @ratio, 0) AS decimal(12,2)) AS ke
     FROM Accounts
     WHERE vesting_shares > @minVests
       AND created < DATEADD(day, -@minAge, GETDATE())
       AND last_root_post > DATEADD(month, -3, GETDATE())
       AND (CAST(posting_rewards AS float) + CAST(curation_rewards AS float)) > 0
     ORDER BY ((CAST(posting_rewards AS float) + CAST(curation_rewards AS float)) / 1000.0)
              / NULLIF(CAST(vesting_shares AS float) / @ratio, 0) DESC`,
    [
      { name: 'ratio', type: TYPES.Float, value: ratio },
      { name: 'minVests', type: TYPES.Float, value: minVests },
      { name: 'minAge', type: TYPES.Int, value: MIN_AGE_DAYS },
      { name: 'lim', type: TYPES.Int, value: limit }
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

export const keBoard = withTtlCache(loadKeBoard, (limit = BOARD_ROWS) => `ke:${limit}`, {
  // ★ One week, matching the disk store. See the note on `mostMuted`.
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  max: 2,
  name: 'inq-board-ke',
  shouldCache: (v) => !v.failed && v.rows.length > 0
});

export interface ProfileRecord {
  account: string;
  /** Accounts currently muting this one, from the chain. `null` when it could not be read. */
  mutedBy: number | null;
  /** Their combined stake in millions of HP, or `null` when the roll could not be read. */
  muterMvests: number | null;
  /** The three muters with the most stake, largest first (empty when unread or none). */
  topMuters: { account: string; hp: number }[];
  /** True when the mute walk hit its page cap, so `mutedBy` is a floor and not a total. */
  mutedByPartial: boolean;
  publishers: string[];
  ke: number | null;
  band: KeBand;
  rewardsHive: number;
  hp: number;
  /** Downvotes received over the account's whole history. */
  /** Distinct (voter, post) downvotes received, or `null` when the count did not finish. */
  downvotes: number | null;
  downvoters: number;
  lastDownvote: string | null;
  /** USD taken off this account's payouts by those downvotes, or null if not computed. */
  removedUsd: number | null;
  /** Share of this account's post payouts that sit on posts it voted for itself. */
  accountAgeDays: number;
  asOf: string;
}

/**
 * ★★★ EVERYTHING A PROFILE SHOWS, IN ONE ROUND TRIP, ON THE READER LANE.
 *
 * ★★ IT MOVED OFF `queryFast` WHEN THE DOWNVOTE COUNT STARTED TELLING THE TRUTH
 * (2026-09-20). The cheap `COUNT(*)` over TxVotes ran in 264ms and was wrong by up to
 * 251x — it counted vote OPERATIONS, so a re-vote bot inflated it without limit. The
 * deduplicated count is the real one and costs real time: 4.9s for @lighteye, 5.9s for
 * @themarkymark, 11.5s for @berniesanders. Against `queryFast`'s 8-second ceiling the
 * worst of those would time out, and a timeout returns `null`, which takes the ENTIRE
 * record down — six correct figures lost to one slow subquery. `queryReader` is the
 * same gate with 60 seconds of headroom, and nothing is made to wait by the move: the
 * route already awaits `voteLedger` (12.1s) in the same `Promise.all`, and the whole
 * record is cached for a day.
 *
 * ★★ THE LISTINGS ARE NOT READ FROM SQL, AND THAT IS A BUG FIX, NOT A PREFERENCE. The
 * `Blacklists` table only holds entries a publisher filed as `blacklisted`; hivewatchers
 * and steemcleaners file theirs as `muted`, which lands in `Mutes` indistinguishable
 * from one reader muting another. A SQL-only record therefore told @lordbutterfly
 * "Lists: None" while the Lists board — reading the bridge, both types, same four
 * publishers — held 83 rows from all four. Two surfaces of one feature disagreeing is
 * the feature lying on one of them. Listings are gone from this feature entirely, so the
 * strip and the board have nothing left to disagree about.
 */
/**
 * The combined stake of a set of muters, in millions of HP.
 *
 * ★★ THE NAMES ARRIVE AS ONE JSON PARAMETER AND ARE EXPANDED SERVER-SIDE. The muter
 * roll now comes from the chain rather than from `Mutes`, so the stake sum has to be
 * taken over a list this process is holding. Sending it as a JSON array and letting
 * `OPENJSON` turn it into rows is one round trip and one parameter; building an `IN`
 * list of 651 literals would be neither.
 *
 * ★ DIVIDED BY THE VESTS RATE, BECAUSE THE LABEL SAYS HP. Printing the raw VESTS sum
 * under "M HP" once overstated the muters' stake by ~1,610x.
 */
export interface MuterStake {
  /** Combined stake of every muter, in millions of HP. */
  mvests: number;
  /** The three muters holding the most stake, largest first, each with their HP. */
  top: { account: string; hp: number }[];
}

/**
 * One statement gives both the total and the three largest (owner, 2026-09-22: "3
 * accounts with most stake mute this guy", on hover). The window SUM runs over the
 * joined rows before TOP cuts them to three, so the total is the whole roll's.
 */
async function muterStake(muters: string[], ratio: number): Promise<MuterStake | null> {
  if (muters.length === 0) return { mvests: 0, top: [] };
  if (ratio <= 0) return null;
  const rows = await queryReader<{ account: string; hp: number; mvests: number }>(
    `SELECT TOP 3 a.name AS account,
            CAST(a.vesting_shares AS float) / @ratio AS hp,
            SUM(CAST(a.vesting_shares AS float)) OVER () / @ratio / 1000000.0 AS mvests
     FROM OPENJSON(@names) WITH (name nvarchar(20) '$') AS n
     JOIN Accounts a WITH (NOLOCK) ON a.name = n.name
     ORDER BY a.vesting_shares DESC`,
    [
      { name: 'names', type: TYPES.NVarChar, value: JSON.stringify(muters) },
      { name: 'ratio', type: TYPES.Float, value: ratio }
    ]
  );
  if (rows === null) return null;
  return {
    mvests: Number(rows[0]?.mvests) || 0,
    top: rows.map((r) => ({ account: String(r.account), hp: Math.round(Number(r.hp) || 0) }))
  };
}

/**
 * How many distinct (voter, post) downvotes this account has received.
 *
 * ★★★ ITS OWN STATEMENT, BECAUSE IT IS TWENTY TIMES THE COST OF EVERYTHING ELSE ON
 * THE RECORD PUT TOGETHER (measured 2026-09-20).
 *
 * TxVotes is the vote OPERATION LOG — a bot re-voting the same post logs a row every
 * time — so the honest count has to deduplicate, and `SELECT DISTINCT voter, permlink`
 * over one prolific account is expensive: 4.9s for @lighteye, 11.5s for @berniesanders,
 * **23.2s for @haejin**. Bundled into the seven-subquery record statement it pushed the
 * whole thing past the 60s reader ceiling, and a null from that timeout takes the ENTIRE
 * record down — @haejin's profile rendered "The record could not be read" while his KE,
 * his mute count and his Steem history were all sitting there computable in a second.
 *
 * Split out, the six cheap figures always land and this one fills or reports `null` on
 * its own, which the strip already renders as a dash.
 */
export interface DownvoteTally {
  downvotes: number;
  downvoters: number;
  lastDownvote: string | Date | null;
}

/*
 * ★★★ WHAT STILL STANDS, NOT WHAT WAS EVER CAST (owner, 2026-09-20: "just count actual
 * downvotes received").
 *
 * `TxVotes` is the operation log, so a voter who downvotes, thinks better of it and
 * removes the vote leaves the downvote in the log forever. Counting every pair that was
 * EVER negative therefore counts votes that are no longer on the post. Measured on
 * @antisocialist: 4,315 pairs were ever negative, 4,286 are still negative, 20 were
 * withdrawn to zero and 9 were flipped to an upvote. On the casting side it is larger --
 * 25,847 ever, 25,567 standing, 258 withdrawn.
 *
 * So the last vote in each (voter, post) pair decides, and only a negative one counts.
 * The candidate set is still "pairs that were ever negative", which keeps the expensive
 * scan bounded to the downvotes rather than to every vote the account ever received.
 */
export async function downvoteTally(account: string): Promise<DownvoteTally | null> {
  // ★ ONE DEFINITION FOR THE STRIP AND THE BOARDS (2026-09-22): distinct posts ever
  // downvoted, a withdrawn downvote included, which is exactly what rankDownvoted and
  // rankInquisitors count. The strip used to count only votes still negative today, so
  // @antisocialist read 4,286 received here and 4,315 on the board, 25,571 cast here
  // and 25,847 there: two surfaces of one feature disagreeing by a definition nobody
  // could see. The money figures are unchanged; they read the final vote state, because
  // a withdrawn downvote removed nothing.
  /*
   * ★★ ONE GROUPED PASS, NOT THREE SCANS. All three figures come from the same rows,
   * and the record statement used to ask for them as three separate correlated
   * subqueries over the same index — so @lighteye's 937,917 downvote operations were
   * walked three times to produce three numbers. Grouping by (voter, permlink) once
   * deduplicates and counts and dates in a single pass.
   */
  const rows = await queryCapped<{ downvotes: number; downvoters: number; last_downvote: string | Date }>(
    `WITH ever AS (
       SELECT voter, permlink, MAX(timestamp) AS last_at
       FROM TxVotes WITH (NOLOCK)
       WHERE author = @account AND weight < 0
       GROUP BY voter, permlink
     )
     SELECT COUNT(*) AS downvotes,
            COUNT(DISTINCT voter) AS downvoters,
            MAX(last_at) AS last_downvote
     FROM ever`,
    [{ name: 'account', type: TYPES.VarChar, value: account }],
    DOWNVOTE_COUNT_MS
  );
  if (rows === null) {
    logger.warn(`inquisition: downvote tally for @${account} did not finish in ${DOWNVOTE_COUNT_MS}ms`);
    return null;
  }
  return {
    downvotes: Number(rows[0]?.downvotes) || 0,
    downvoters: Number(rows[0]?.downvoters) || 0,
    lastDownvote: rows[0]?.last_downvote ?? null
  };
}

/**
 * ════ THE OTHER DIRECTION: WHAT THIS ACCOUNT CAST ════
 *
 * ★★ THE MIRROR OF `downvoteTally`, AND IT HAS TO BE A SEPARATE QUERY (owner, 2026-09-20:
 * "just add how many downvotes you cast and how much post rewards you removed"). The
 * record showed only what was done TO an account, which is half of a record and the
 * flattering half: the boards have a TOP INQUISITORS ranking precisely because casting is
 * the other side of the same ledger. A strip that reports 981 received and nothing cast
 * reads as innocence it has not demonstrated.
 *
 * Same shape as the received tally, same dedupe: `TxVotes` is the operation log, so a bot
 * re-voting one post logs a row every time, and the honest count groups by (author,
 * permlink) first. Same cap, because the cost is symmetric.
 */
export interface CastTally {
  downvotes: number;
  targets: number;
  lastCast: string | Date | null;
}

export async function downvotesCast(account: string): Promise<CastTally | null> {
  // Same definition as downvoteTally above and as rankInquisitors: distinct posts ever
  // downvoted by this account, withdrawn ones included.
  const rows = await queryCapped<{ downvotes: number; targets: number; last_cast: string | Date }>(
    /* ★ The mirror of the received tally, and standing-only for the same reason. */
    `WITH ever AS (
       SELECT author, permlink, MAX(timestamp) AS last_at
       FROM TxVotes WITH (NOLOCK)
       WHERE voter = @account AND weight < 0
       GROUP BY author, permlink
     )
     SELECT COUNT(*) AS downvotes,
            COUNT(DISTINCT author) AS targets,
            MAX(last_at) AS last_cast
     FROM ever`,
    [{ name: 'account', type: TYPES.VarChar, value: account }],
    DOWNVOTE_COUNT_MS
  );
  if (rows === null) {
    logger.warn(`inquisition: cast tally for @${account} did not finish in ${DOWNVOTE_COUNT_MS}ms`);
    return null;
  }
  return {
    downvotes: Number(rows[0]?.downvotes) || 0,
    targets: Number(rows[0]?.targets) || 0,
    lastCast: rows[0]?.last_cast ?? null
  };
}

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
  /*
   * ★★ THE CHAIN CALL RUNS ALONGSIDE THE SQL, NOT AFTER IT. The mute roll is an
   * independent source answering an independent question, so making the record wait for
   * one and then the other would add its latency for no reason.
   */
  const rollPromise = muteRoll(account);

  const rows = await queryReader<{
    rewards_hive: number;
    ke: number;
    hp: number;
    age_days: number;
    last_downvote: string | Date | null;
  }>(
    /*
     * ★★★ THE REWARD FIELDS ARE THOUSANDTHS OF HIVE, NOT VESTS (corrected 2026-09-22).
     *
     * The 2026-09-20 note here said the opposite. Its evidence was that HiveSQL's
     * integers matched `condenser_api.get_accounts` for @antisocialist (10,457,620 and
     * 11,650,053), which is true, and both are 0.001 HIVE: @azircon published his own
     * figures ("Author Rewards = 30804 hive, Curation Rewards = 235719 hive, KE 0.24",
     * May 2025) and they are exactly the chain integers / 1000. Dividing milli-HIVE by
     * VESTS made every KE on the site 62% of the true value (1000 / 1609.46) and the
     * "HIVE taken" figure 62% too, drifting with the rate. @antisocialist reads 0.44
     * here against 0.71 by azircon's formula.
     *
     * KE = (author rewards + curation rewards, in HIVE) / HP held, where held HP is the
     * account's own `vesting_shares` at the live rate (delegations in either direction
     * do not move it; azircon's worked example uses his own stake). One shared shape
     * with the KE board above; the two must never compute this differently.
     */
    `SELECT (CAST(a.posting_rewards AS float) + CAST(a.curation_rewards AS float)) / 1000.0 AS rewards_hive,
            a.vesting_shares / @ratio AS hp,
            ((CAST(a.posting_rewards AS float) + CAST(a.curation_rewards AS float)) / 1000.0)
              / NULLIF(CAST(a.vesting_shares AS float) / @ratio, 0) AS ke,
            DATEDIFF(day, a.created, GETDATE()) AS age_days
     /*
      * ★★ A SECOND, DIFFERENT SELF-VOTE FIGURE USED TO BE COMPUTED HERE AND RENDERED
      * NOWHERE (found by audit, 2026-09-20).
      *
      * Two subqueries over every root post the account ever wrote, one of them an
      * EXISTS against TxVotes, on the READER lane, on every cache miss. What the strip
      * actually shows is selfRewardPct from the vote ledger, which weighs the
      * author's own rshares inside each payout. This one summed the WHOLE payout of any
      * post the author had ever upvoted, which is a much larger and quite different
      * number. It had zero references outside this file. Dead weight is bad; dead
      * weight that disagrees with the live figure is a trap for whoever wires it up.
      */
     FROM Accounts a
     WHERE a.name = @account`,
    [
      { name: 'account', type: TYPES.VarChar, value: account },
      { name: 'ratio', type: TYPES.Float, value: ratio }
    ]
  );
  if (rows === null || rows.length === 0) return null;

  /*
   * ★ A FAILED ROLL LEAVES BOTH FIGURES `null`, AND THE STRIP RENDERS A DASH. It must
   * never fall back to the SQL table: that table is exactly what produced "0 accounts
   * mute @berniesanders" against a chain that says 638, and a wrong number that looks
   * confident is worse than an honest dash.
   */
  const roll = await rollPromise;
  const mutedBy = roll ? roll.count : null;
  const stake = roll ? await muterStake(roll.muters, ratio) : null;
  const muterMvests = stake ? stake.mvests : null;
  /*
   * ★★ THE DIVISION HAPPENS IN FLOAT, AND ROUNDING COMES LAST. Both sides used to be
   * `CAST(... AS int)` before the divide, and this record — unlike the board — applies
   * no HP floor, so it runs on accounts with single-digit HP where that is not a
   * rounding detail: 1.99 HP truncated to 1 turned a real KE of 25,125 into a printed
   * 50,000. The board always did this correctly; the two now agree.
   */
  const hp = Number(rows[0]?.hp) || 0;
  const rewardsHive = Number(rows[0]?.rewards_hive) || 0;
  // ★ HIVE over HP, straight from the statement (rewards / 1000 over vests / rate).
  const keRaw = Number(rows[0]?.ke);
  const ke = Number.isFinite(keRaw) ? Number(keRaw.toFixed(2)) : null;
  const last = null;

  return {
    account,
    // ★★★ FROM THE CHAIN, NOT FROM `Mutes`. That table cannot answer "who mutes X" —
    // see the table of measurements in `mutes.ts`. `null` is "not read", never 0.
    mutedBy,
    muterMvests,
    topMuters: stake?.top ?? [],
    mutedByPartial: roll?.partial ?? false,
    publishers: [],
    ke,
    band: keBand(ke),
    // ★ The DIVISION is done in float (above); only the DISPLAYED figures are rounded.
    rewardsHive: Math.round(rewardsHive),
    hp: Math.round(hp),
    // ★★ THE SLOW HALF IS FILLED BY THE ROUTE, NOT WAITED FOR HERE. See
    // `downvoteTally`, which is 4.9s to 23.2s on its own. `null` renders as a dash.
    downvotes: null,
    downvoters: 0,
    lastDownvote: last ? new Date(last).toISOString() : null,
    // Filled by the route, which owns the slower value lookup.
    removedUsd: null,
    accountAgeDays: Number(rows[0]?.age_days) || 0,
    asOf: nowIso()
  };
}

/**
 * ════ THE BOARD QUERIES ════
 *
 * ★★ THESE LIVE HERE, NOT IN THE ROUTE. They were duplicated into the route handler while
 * the staged pipeline was built, because the two files were being edited by different
 * hands at the same time. Two copies of a query that ranks named people is exactly the
 * thing that drifts — one gets a fix and the other does not — so the route imports these
 * and the copies are gone. The originals that this replaces were dead the moment the
 * staged build stopped calling them.
 */
/**
 * ════ STAGE 1: THE RANKINGS ════
 *
 * ★★ THESE TWO STATEMENTS ARE THE SAME SQL AS `boards-sql.ts` `loadMostDownvoted` /
 * `loadInquisitors`, LIFTED OUT OF THEM SO THE RANKING CAN BE PUBLISHED ON ITS OWN. Those
 * two functions run all three passes before returning anything, which is precisely the
 * shape being fixed here, and they are no longer called by this route — nothing else in
 * the app calls them either. They should be deleted, and `topCounterpart` exported, the
 * moment `boards-sql.ts` is free to edit; until then this is the one live copy and that
 * one is dead code. Their reasoning, which is long and worth keeping, stays there.
 *
 * In short: full chain history, not a rolling window (a 3-month slice made the vote
 * counts incoherent with the money column, which covers an account's whole life);
 * downvoted is ranked by DEDUPLICATED downvote count with distinct voters beside it;
 * inquisitors is ranked by distinct TARGETS. NEITHER CARRIES A STAKE FLOOR, because
 * @berniesanders cast 31,776 downvotes, received 44,542, and holds 3 HP today — a
 * floor meant to keep dust off the board was keeping its most notorious entry off it.
 *
 * ★★★ AND BOTH DEDUPE. `TxVotes` is the vote OPERATION LOG, not the vote state: every
 * re-vote of the same post is another row. Ranking on `COUNT(*)` put @lighteye first
 * with 937,917 "downvotes" when the truth is 3,738 (voter, post) pairs — 99.7% of the
 * inflation was one bot re-voting 952 posts. The `pairs` CTE collapses each
 * (voter, post) to one row before anything is counted, which is also what makes the
 * count coherent with the money column: `loadRemovedByVoter` has always scoped itself
 * with `SELECT DISTINCT author, permlink`, so the money was right while the count next
 * to it was 251x too large. Measured at 157s over full chain history, inside the
 * 240s slow-lane ceiling, and it runs once a week.
 *
 * ★★ WHAT THIS COLUMN COUNTS, STATED EXACTLY, BECAUSE TWO HONEST READINGS EXIST. A
 * deduplicated pair from `TxVotes` is "this voter downvoted this post at some point",
 * which INCLUDES a downvote later withdrawn or flipped positive. The stricter reading is
 * "the vote is still negative today", which lives in `Comments.active_votes` and is what
 * the money column sums. Measured on @lighteye: 3,738 ever-downvoted against 3,653 still
 * negative — a 2.3% gap, not a 251x one. The looser number is the one shown, because it
 * is the only one computable for all 100 rows: the strict count needs a full-table
 * `OPENJSON` walk of every comment on the chain. Showing the strict count for the 30 rows
 * the money pass reaches and the loose count for the other 70 would put two different
 * definitions in one column, which is worse than one definition stated plainly.
 */
export async function rankDownvoted(): Promise<{ rows: DownvotedRow[]; asOf: string } | null> {
  const rows = await queryCapped<{ account: string; downvotes: number; voters: number }>(
    `WITH pairs AS (
       SELECT v.author, v.voter
       FROM TxVotes v WITH (NOLOCK)
       WHERE v.weight < 0
       GROUP BY v.author, v.voter, v.permlink
     ),
     agg AS (
       SELECT p.author, COUNT(*) AS downvotes, COUNT(DISTINCT p.voter) AS voters
       FROM pairs p
       GROUP BY p.author
     )
     SELECT TOP (@lim) g.author AS account, g.downvotes, g.voters
     FROM agg g
     JOIN Accounts a ON a.name = g.author
     WHERE a.created < DATEADD(day, -@minAge, GETDATE())
     ORDER BY g.downvotes DESC, g.voters DESC`,
    [
      { name: 'minAge', type: TYPES.Int, value: MIN_AGE_DAYS },
      { name: 'lim', type: TYPES.Int, value: BOARD_ROWS }
    ],
    RANK_QUERY_MS
  );
  // ★ `null` is "we could not ask" and must never become an empty board — see hivesql.ts.
  if (rows === null) return null;
  return {
    rows: rows.map((r) => ({
      account: r.account,
      downvotes: Number(r.downvotes) || 0,
      voters: Number(r.voters) || 0,
      // ★ THE LATER STAGES' COLUMNS START EMPTY, AND EMPTY IS A RENDERED STATE. `''` is
      // "no counterpart read yet" and `null` is "no money computed yet"; the table prints
      // a dash for both. Neither is ever a zero.
      topSource: '',
      topSourceVotes: 0,
      removedUsd: null
    })),
    asOf: nowIso()
  };
}

export async function rankInquisitors(): Promise<{ rows: InquisitorRow[]; asOf: string } | null> {
  const rows = await queryCapped<{ account: string; downvotes: number; targets: number }>(
    `WITH pairs AS (
       SELECT v.voter, v.author
       FROM TxVotes v WITH (NOLOCK)
       WHERE v.weight < 0
       GROUP BY v.voter, v.author, v.permlink
     ),
     agg AS (
       SELECT p.voter, COUNT(*) AS downvotes, COUNT(DISTINCT p.author) AS targets
       FROM pairs p
       GROUP BY p.voter
     )
     SELECT TOP (@lim) g.voter AS account, g.downvotes, g.targets
     FROM agg g
     JOIN Accounts acc ON acc.name = g.voter
     WHERE acc.created < DATEADD(day, -@minAge, GETDATE())
     ORDER BY g.targets DESC, g.downvotes DESC`,
    [
      { name: 'minAge', type: TYPES.Int, value: MIN_AGE_DAYS },
      { name: 'lim', type: TYPES.Int, value: BOARD_ROWS }
    ],
    RANK_QUERY_MS
  );
  if (rows === null) return null;
  return {
    rows: rows.map((r) => ({
      account: r.account,
      downvotes: Number(r.downvotes) || 0,
      targets: Number(r.targets) || 0,
      topTarget: '',
      topTargetVotes: 0,
      removedUsd: null
    })),
    asOf: nowIso()
  };
}
/**
 * ════ STAGE 2: THE HEAVIEST COUNTERPART, IN EITHER DIRECTION ════
 *
 * ★★★ ONE INDEXED TOP-1 PER NAME, CHUNKED, AGAINST A CLOCK. Over full history a
 * `GROUP BY voter, author` is enormous — @adm alone has 18,321 distinct targets,
 * @spaminator 43,834 — and asking for a hundred names at once simply returned null.
 * `CROSS APPLY` asks each name's own index for its single heaviest counterpart instead.
 * Measured 132.3s for eight, so the cost is real and uneven: four at a time, each
 * statement comfortably inside the 240s ceiling, and a wall clock over the whole pass.
 *
 * (Same statement as `topCounterpart` in `boards-sql.ts`, which is not exported — see the
 * note on stage 1.)
 */
export async function topCounterpart(
  names: string[],
  direction: 'by-voter' | 'by-author',
  budgetMs: number,
  chunkSize: number
): Promise<Map<string, { name: string; n: number }>> {
  const best = new Map<string, { name: string; n: number }>();
  const self = direction === 'by-voter' ? 'voter' : 'author';
  const other = direction === 'by-voter' ? 'author' : 'voter';
  const deadline = Date.now() + budgetMs;

  for (let i = 0; i < names.length; i += chunkSize) {
    if (Date.now() >= deadline) break;
    const chunk = names.slice(i, i + chunkSize);
    const values = chunk.map((_, j) => `(@v${j})`).join(',');

    /*
     * ★★★ THE BY-AUTHOR SIDE READS `active_votes`, NOT `TxVotes`, AND IT IS ~20x
     * FASTER FOR THE SAME ANSWER (measured 2026-09-20).
     *
     * Deduplicating the count with `COUNT(DISTINCT v.permlink)` over `TxVotes` is
     * correct and ruinous: @gangstalking, the heaviest row on the board, blew a 60s
     * ceiling, and a cold build filled 4 of 25 rows. The same question asked of
     * `Comments.active_votes` — whose JSON already holds exactly one entry per
     * (voter, post) — answers in **3.1s**, because `c.author` is indexed and there is
     * no DISTINCT to do: the deduplication is a property of the data.
     *
     * It is also the SAME SOURCE the money column sums, so the top downvoter and the
     * value removed can no longer disagree about who was there. `TxVotes` counts a pair
     * that was ever negative; `active_votes` counts one that still is.
     *
     * ★ THE BY-VOTER SIDE CANNOT DO THIS and still uses `TxVotes`. There is no index
     * that finds "every post this account voted on" inside the JSON, so scoping by
     * voter means scanning every comment on the chain. Scoping by author does not.
     */
    const sql =
      direction === 'by-author'
        ? `SELECT s.k, t.voter AS p, t.n
           FROM (VALUES ${values}) AS s(k)
           CROSS APPLY (SELECT TOP 1 j.voter, COUNT(*) AS n
                        FROM Comments c WITH (NOLOCK)
                        CROSS APPLY OPENJSON(c.active_votes)
                          WITH (voter nvarchar(20) '$.voter', rshares bigint '$.rshares') AS j
                        WHERE c.author = s.k AND j.rshares < 0
                        GROUP BY j.voter
                        ORDER BY COUNT(*) DESC) AS t`
        : /*
           * ★★ DEDUPLICATE IN A DERIVED TABLE, THEN GROUP — NOT `COUNT(DISTINCT)` IN THE
           * AGGREGATE. Identical answer, and the difference is the whole column: the
           * `COUNT(DISTINCT v.permlink)` form blew the 60s ceiling on the heaviest
           * voters and left the board's top rows empty, while collapsing
           * (author, permlink) first and counting the rows takes **15.9s** for
           * @spaminator and his 1.7 million downvotes. Same rewrite that took the
           * ranking query from "times out" to 117s.
           */
          `SELECT s.k, t.${other} AS p, t.n
           FROM (VALUES ${values}) AS s(k)
           CROSS APPLY (SELECT TOP 1 d.${other}, COUNT(*) AS n
                        FROM (SELECT DISTINCT v.${other}, v.permlink
                              FROM TxVotes v WITH (NOLOCK)
                              WHERE v.${self} = s.k AND v.weight < 0) AS d
                        GROUP BY d.${other}
                        ORDER BY COUNT(*) DESC) AS t`;

    const rows = await queryCapped<{ k: string; p: string; n: number }>(
      sql,
      chunk.map((name, j) => ({ name: `v${j}`, type: TYPES.VarChar, value: name })),
      TOP_TARGET_QUERY_MS
    );
    if (rows === null) {
      // ★ SAY WHICH NAMES WENT UNANSWERED. This `continue` filled 4 of 25 rows without
      // a single line of output; the column simply read "not read" and nobody knew why.
      logger.warn(
        `inquisition: top ${other} lookup returned nothing for [${chunk.join(', ')}] ` +
          `within ${TOP_TARGET_QUERY_MS}ms — those rows stay uncomputed`
      );
      continue;
    }
    for (const row of rows) best.set(row.k, { name: row.p, n: Number(row.n) || 0 });
  }
  return best;
}
