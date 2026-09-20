import 'server-only';
import { withTtlCache } from '@/blog/lib/server-ttl-cache';

/**
 * ════ WHO IS MUTING THIS ACCOUNT, ASKED OF THE CHAIN ════
 *
 * ★★★ THE SQL MIRROR CANNOT ANSWER THIS AND WAS ANSWERING ANYWAY (found by audit,
 * 2026-09-20).
 *
 * HiveSQL's `Mutes` table is accurate read one way and close to useless read the other.
 * Ask it "who does X mute" and it is right: every one of @haejin's 632 outgoing mutes
 * matches his live ignore list. Ask it "who mutes X" — which is the only question this
 * feature asks — and coverage runs from 1% to 69% depending on whose follow lists
 * happened to be ingested:
 *
 *     account          Mutes table      the chain
 *     haejin                     7            651
 *     berniesanders              0            638
 *     themarkymark              65            171
 *     heimindanger             119            172
 *
 * That is not a scale factor that cancels out of a ranking. It reorders it, and it put
 * a zero on the profile of one of the most-muted accounts on Hive.
 *
 * ★★ SO THE COUNT COMES FROM `get_followers(account, start, 'ignore', limit)`, WHICH IS
 * THE CHAIN'S OWN ANSWER AND IS NOT A MIRROR OF ANYTHING. Measured: @haejin 651 in
 * 472ms, @berniesanders 638 in 147ms, @lordbutterfly 47 in 126ms. A profile already
 * waits ~12s on the vote ledger beside this, so a few hundred milliseconds for a figure
 * that is currently off by 90x is not a cost worth discussing.
 */

const ENDPOINT = process.env.REACT_APP_API_ENDPOINT || 'https://api.hive.blog';

/** One page of `get_followers`. The chain's own ceiling for this call. */
const PAGE = 1000;
/**
 * ★ A STOP, BECAUSE A PAGINATED LOOP AGAINST SOMEBODY ELSE'S NODE NEEDS ONE. Forty
 * pages is 40,000 muters, which no account on Hive is close to; the cap exists so a
 * malformed response can never turn one profile view into an unbounded request loop.
 */
const MAX_PAGES = 40;
const TIMEOUT_MS = 6000;

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 })
    });
    const json = (await res.json()) as { result?: T };
    return json.result ?? null;
  } catch {
    return null;
  }
}

export interface MuteRoll {
  /** How many accounts currently mute this one. */
  count: number;
  /** Their names, for anything that needs to weigh them rather than count them. */
  muters: string[];
  /**
   * ★★ TRUE WHEN `MAX_PAGES` STOPPED THE WALK, SO `count` IS A FLOOR AND NOT A TOTAL.
   * Caught by audit on this file's first draft: the cap was written directly under a
   * comment about a floor presented as a total being "the bug this feature has shipped
   * twice already", and then shipped without the flag. No account on Hive is near 40,000
   * muters, so this is expected to stay false forever — which is exactly why it would
   * never have been noticed if it ever became true.
   */
  partial: boolean;
}

/**
 * Every account currently muting `account`.
 *
 * ★★ RETURNS `null`, NEVER AN EMPTY ROLL, WHEN THE CHAIN DID NOT ANSWER. This is the
 * same rule the SQL layer follows and it exists because the two states render
 * differently: `null` is a dash that says "not read" on hover, and 0 is the claim that
 * nobody mutes this account. A failed request must never be able to make that claim.
 *
 * ★★ THE NAMES GO THROUGH A `Set`, SO THE `start` CONTRACT CANNOT DOUBLE-COUNT. Measured
 * on 2026-09-20, `start` is EXCLUSIVE: paging from `abraluckon` returns `acee` first.
 * Several Hive endpoints are inclusive instead, and the difference between the two is a
 * silent off-by-one per page. Deduplicating by name is correct under either contract, so
 * the count does not depend on which one this node implements today.
 */
async function loadMuteRoll(account: string): Promise<MuteRoll | null> {
  const seen = new Set<string>();
  let start = '';
  let answered = false;
  // ★ Set at every NATURAL end of the walk. Falling out of the loop instead means the
  // page cap stopped it, and the count is then a floor rather than a total.
  let finished = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await rpc<{ follower: string }[]>('condenser_api.get_followers', [
      account,
      start,
      'ignore',
      PAGE
    ]);
    // ★ A failed FIRST page is "we could not ask". A failed LATER page is a partial
    // answer, and a partial count presented as a total is the bug this feature has
    // shipped twice already — so it is also null rather than a floor.
    if (rows === null) return null;
    answered = true;
    if (rows.length === 0) {
      finished = true;
      break;
    }

    const before = seen.size;
    for (const row of rows) if (row?.follower) seen.add(row.follower);

    const last = rows[rows.length - 1]?.follower;
    // ★ NO PROGRESS MEANS STOP. Without this, an endpoint with an inclusive `start` and
    // a single remaining name would hand back the same row forever.
    if (!last || last === start || seen.size === before) {
      finished = true;
      break;
    }
    if (rows.length < PAGE) {
      finished = true;
      break;
    }
    start = last;
  }

  if (!answered) return null;
  return { count: seen.size, muters: [...seen], partial: !finished };
}

/**
 * ★ CACHED A DAY, LIKE THE RECORD IT FEEDS. Muting is a human act on a human timescale;
 * nobody's mute count moves meaningfully within a day, and the profile record this sits
 * inside is cached for exactly as long.
 *
 * ★ `shouldCache` REFUSES A NULL, so one bad minute at the API cannot pin a profile to
 * "not read" for a day.
 */
export const muteRoll = withTtlCache(loadMuteRoll, (account: string) => account, {
  ttlMs: 24 * 60 * 60 * 1000,
  max: 300,
  name: 'inq-mute-roll',
  shouldCache: (value) => value !== null
});

/**
 * ════ THE MOST-MUTED BOARD ════
 *
 * ★★★ RANKED FROM THE CHAIN, BECAUSE THE TABLE IT USED TO RANK FROM CANNOT ANSWER THE
 * QUESTION (see the measurements at the top of this file).
 *
 * The board needs two things the profile card does not: a list of WHO to ask about, and
 * a guarantee that the list does not miss anybody. The chain has no "most muted"
 * endpoint — `get_followers` answers for one account at a time — so the candidates come
 * from the operation log and the counts come from the chain.
 *
 * ★★ WHY THE OPERATION LOG IS A SAFE PLACE TO GET CANDIDATES. To be muting somebody
 * today you must have issued a mute operation at some point, and every one of those is a
 * `follow` custom_json carrying `ignore` in its `what` array. So
 * `ever-muted-by >= currently-muted-by` for every account without exception, and an
 * account cannot be heavily muted today without appearing here. The log over-counts
 * freely — mute, unmute, mute again is three rows — and that does not matter, because
 * nothing is ranked on it. It only decides who gets asked.
 *
 * ★★ AND IT IS SLICED BY YEAR, BECAUSE THE WHOLE-HISTORY VERSION DOES NOT FINISH.
 * `json LIKE '%ignore%'` cannot use an index, so it reads every follow operation Hive
 * has ever recorded; run across all years it timed out twice at 280s. One year measured
 * **142s**. Eleven of those is ~26 minutes for a job that runs once a WEEK, each query
 * comfortably inside its ceiling, and the gaps between them hand the database back to
 * everybody else using the free mirror rather than holding it for half an hour.
 *
 * ★ `MIN_OPS_PER_YEAR` KEEPS THE RESULT SET SMALL WITHOUT LOSING ANYBODY THAT MATTERS.
 * A candidate needs to clear it in ONE year, not every year, because appearing in the
 * pool once is all it takes — the exact figure then comes from the chain. An account
 * with hundreds of muters accumulated over a decade clears three-in-a-year many times
 * over; what the threshold actually discards is the enormous tail of accounts muted by
 * one or two people, which no top-100 board was ever going to show.
 */
const FIRST_YEAR = 2016;
const MIN_OPS_PER_YEAR = 3;
const CANDIDATES = 400;

export interface MutedBoardRow {
  account: string;
  mutedBy: number;
  muters: string[];
}

/**
 * Accounts worth asking the chain about, from the mute operation log.
 *
 * `runSlice` is injected so this file does not import the SQL layer (which imports this
 * one); the caller supplies the query runner.
 */
export async function muteCandidates(
  runSlice: (fromIso: string, toIso: string, minOps: number) => Promise<{ account: string; ops: number }[] | null>
): Promise<string[] | null> {
  const total = new Map<string, number>();
  const thisYear = new Date().getUTCFullYear();
  let answered = 0;

  for (let year = FIRST_YEAR; year <= thisYear; year++) {
    const rows = await runSlice(`${year}-01-01`, `${year + 1}-01-01`, MIN_OPS_PER_YEAR);
    // ★ One unreadable slice is a gap in the POOL, not a wrong number on the board:
    // every account that does make it in still gets an exact count from the chain.
    if (rows === null) continue;
    answered += 1;
    for (const row of rows) {
      if (!row.account) continue;
      total.set(row.account, (total.get(row.account) ?? 0) + Number(row.ops || 0));
    }
  }

  // ★ Not one slice answered: that is "we could not ask", and it must not become a board.
  if (answered === 0) return null;
  return [...total.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, CANDIDATES)
    .map(([account]) => account);
}

/**
 * The board: exact current mute counts for the candidate pool, worst first.
 *
 * ★★ THE COUNTS ARE SEQUENTIAL AND DELIBERATELY SO. Four hundred `get_followers` calls
 * against a public node, once a week, one at a time. Measured 126-472ms each, so the
 * whole pass is roughly a minute. Firing them in parallel would be faster and would be
 * exactly the behaviour that got this machine blocked by HiveSQL earlier the same day.
 */
export async function rankMuted(
  runSlice: (fromIso: string, toIso: string, minOps: number) => Promise<{ account: string; ops: number }[] | null>,
  limit: number
): Promise<MutedBoardRow[] | null> {
  const candidates = await muteCandidates(runSlice);
  if (candidates === null) return null;

  const rows: MutedBoardRow[] = [];
  for (const account of candidates) {
    const roll = await muteRoll(account);
    if (!roll) continue;
    if (roll.count > 0) rows.push({ account, mutedBy: roll.count, muters: roll.muters });
  }
  if (rows.length === 0) return null;
  return rows.sort((a, b) => b.mutedBy - a.mutedBy).slice(0, limit);
}
