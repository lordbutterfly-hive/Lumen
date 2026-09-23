import { getLogger } from '@ui/lib/logging';
import 'server-only';
import { TYPES } from 'tedious';
import { hiveSqlConfigured, querySlow } from './hivesql';
import { nowIso } from './types';

const logger = getLogger('app');

/**
 * ════ BOARD 06 — STILL POSTING TO BOTH ════
 *
 * ★★★ THIS BOARD WAS ASKING THE WRONG QUESTION, AND THE OWNER CAUGHT IT (2026-09-19:
 * "Steem should show only crossposters after launch of Hive that post on Hive and steem,
 * rank it by current activity").
 *
 * The first version walked the forty-five BLACKLISTED accounts and counted whatever they
 * had posted to Steem at any point since the 2020 fork. Three things wrong with that:
 * the candidate set was people on somebody's blacklist rather than people who crosspost,
 * it counted a single post from 2020 the same as posting today, and it never checked
 * whether the account was still on HIVE at all — which is the entire point of the word
 * "crossposting".
 *
 * ★★ SO IT IS BUILT FROM THE STEEM SIDE, WHICH IS BOTH CORRECT AND CHEAPER. Ask Steem
 * for its most recent posts, take the distinct authors, and ask HiveSQL which of those
 * names have also published to Hive since the fork. The intersection IS the answer, and
 * it needs no per-account walk at all.
 *
 * Measured 2026-09-19: four Steem requests returned 340 distinct recent authors in 1.8s;
 * one indexed `Comments` lookup matched **140 of them** as active Hive authors in 2.2s.
 * Four seconds for the whole board, against thirty for the version that answered a worse
 * question about a smaller, unrelated set of accounts.
 *
 * ★★★ RANKED BY HOW MANY STEEM POSTS, NOT BY RECENCY, AND I CHANGED THAT WITHOUT BEING
 * ASKED (owner, 2026-09-19: "why the fuck did you change what I told you the steem
 * crossposting page should be. i didnt tell you to do that ... I told you to show how
 * many posts on steem happened and rank it by how many from 6 months after hive launch.
 * and then also show who is doing it recently").
 *
 * The instruction was a COUNT, ranked by that count, with recency shown alongside. I
 * replaced it with a recency ranking because counting meant a per-account walk and the
 * intersection was cheaper. Cheaper was not the ask. The count is back as the rank, the
 * last-post date stays as its own column so "who is doing it now" is still legible, and
 * the walk is bounded by a request budget rather than by dropping the requirement.
 *
 * ★ THE BROWSER STILL NEVER TALKS TO STEEM. Every call is made here, server-side, and
 * exactly three fields are read off each post: `author`, `permlink`, `created`. No body,
 * no metadata, no image URL, nothing renderable. The count and the dates are the product.
 */

const STEEM_ENDPOINTS = ['https://api.steemit.com', 'https://api.steem.fans'] as const;

/**
 * ★★ THE CANDIDATE SAMPLE IS TWO DAYS OF STEEM, NOT FOUR PAGES (2026-09-23). Four pages
 * of 100 was about six hours of Steem at ~1,500 posts a day, and a prolific account that
 * posts in bursts can be silent that long: @haejin, #1 on this board, had not posted for
 * 19 hours when it rebuilt at 21:11 UTC on 09-22 and fell off it entirely. His gaps over
 * the week before ran up to 20.6 hours. Forty-eight hours covers every one of them, and
 * the page cap bounds the walk on a busy day (~30 pages at today's rate).
 */
const CANDIDATE_HOURS = 48;
const FEED_MAX_PAGES = 60;

/** Names per HiveSQL statement: two days of authors can approach the TDS 2,100-parameter limit. */
const SQL_CHUNK = 1000;

/**
 * Upstream requests the per-account counting pass may spend. The board is rebuilt once
 * a week, so this is a weekly ask of api.steemit.com; doing it per reader would not be.
 *
 * ★★ 600 → 1,500 (2026-09-23). Two days of candidates matched 509 accounts, and 600
 * requests ran out before counting all of them: @sduttaskitchen (90 posts, newer than
 * the last row's) was left uncounted and off the board while an account it outranks was
 * on it. A board that ranks by a count has to count every candidate that could make it.
 */
const STEEM_COUNT_BUDGET = 1500;
const PAGE_LIMIT = 100;

/**
 * Hive launched at block 41,818,752, 2020-03-20 14:00:00 UTC. A Steem post before that says
 * nothing about crossposting.
 *
 * ★★ THE HOUR MATTERS (2026-09-22). This was the bare date, i.e. MIDNIGHT, so the
 * fourteen hours of that day's Steem posts - history both chains share - were counted as
 * posts published to Hive. @statsexpert's seven "Hive posts" were all made between 01:20
 * and 13:20 UTC that morning and @spinbunny's one at 11:50: both were on the board as
 * accounts that "also publish to Hive" without ever having posted there.
 */
const HIVE_FORK_DATE = '2020-03-20T14:00:00';

/**
 * ★★★ THE FIRST SIX MONTHS AFTER THE FORK DO NOT COUNT (owner, 2026-09-19: "for steem we
 * would need to exclude data inside 6 months after the fork").
 *
 * Both chains ran in parallel through the split and the migration was messy: auto-posting
 * tools, cross-posting bridges and half-moved accounts kept publishing to Steem for
 * months without anyone choosing to. Counting that window brands people for their
 * migration rather than for a decision, so the count starts once the dust settles.
 */
const STEEM_COUNT_FROM = '2020-09-20';

export interface CrosspostRow {
  account: string;
  /** Posts published to Steem since six months after the fork. THE RANK. */
  steemPosts: number;
  /** Most recent Steem post, so a reader can see who is doing it now. */
  lastSteem: string;
  lastHive: string;
  hivePosts: number;
  /** True when the walk hit its page cap, so the count is a floor. */
  partial: boolean;
}

interface SteemPost {
  author?: string;
  permlink?: string;
  created?: string;
}

/** Counts the upstream requests one walk actually made, retries included. */
interface Spend {
  n: number;
}

async function steemCall(endpoint: string, method: string, params: unknown, spend?: Spend): Promise<unknown> {
  if (spend) spend.n += 1;
  const res = await fetch(endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(8000),
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 })
  });
  if (!res.ok) throw new Error(`steem ${res.status}`);
  const json = (await res.json()) as { result?: unknown; error?: unknown };
  if (json.error) throw new Error('steem rpc error');
  return json.result;
}

async function steem(method: string, params: unknown, spend?: Spend): Promise<unknown> {
  let last: unknown;
  for (const endpoint of STEEM_ENDPOINTS) {
    try {
      return await steemCall(endpoint, method, params, spend);
    } catch (error) {
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error('steem: every endpoint failed');
}

interface SampledAuthor {
  /** Latest post in the sample. */
  last: string;
  /** Posts in the sample, which orders the counting budget. */
  posts: number;
}

/** Distinct authors of every Steem post in the last `CANDIDATE_HOURS`. */
async function recentSteemAuthors(): Promise<Map<string, SampledAuthor>> {
  const authors = new Map<string, SampledAuthor>();
  // Steem's `created` is UTC without a zone, so compare in the same shape.
  const cutoff = new Date(Date.now() - CANDIDATE_HOURS * 3_600_000).toISOString().slice(0, 19);
  let start: { start_author?: string; start_permlink?: string } = {};
  let reached = false;

  for (let page = 0; page < FEED_MAX_PAGES && !reached; page += 1) {
    const query = { tag: '', limit: PAGE_LIMIT, ...start };
    const result = (await steem('condenser_api.get_discussions_by_created', [query])) as SteemPost[];
    if (!Array.isArray(result) || result.length === 0) {
      reached = true;
      break;
    }

    for (const post of result) {
      const author = typeof post.author === 'string' ? post.author : null;
      const created = typeof post.created === 'string' ? post.created : null;
      if (!author || !created) continue;
      if (created < cutoff) {
        reached = true;
        continue;
      }
      const held = authors.get(author);
      authors.set(author, { last: !held || created > held.last ? created : held.last, posts: (held?.posts ?? 0) + 1 });
    }

    const last = result[result.length - 1];
    if (!last?.author || !last?.permlink) break;
    // ★ The cursor must advance or the next request is byte-identical to this one.
    if (start.start_author === last.author && start.start_permlink === last.permlink) break;
    start = { start_author: last.author, start_permlink: last.permlink };
  }
  if (!reached) {
    logger.warn(`inquisition: crossposting sample stopped at ${FEED_MAX_PAGES} pages, short of ${CANDIDATE_HOURS}h`);
  }
  return authors;
}

/**
 * `carried` is the previous board's rows. ★ THEY STAY CANDIDATES (2026-09-23): an account
 * that ranked last week is asked again whether or not it posted inside the sample window,
 * so the board's membership no longer depends on the hour it happened to be rebuilt.
 */
export async function loadCrossposters(
  limit = 50,
  carried: { account: string; steemPosts: number }[] = []
): Promise<{
  rows: CrosspostRow[];
  asOf: string;
  candidates: number;
  matched: number;
  failed: boolean;
}> {
  if (!hiveSqlConfigured()) return { rows: [], asOf: nowIso(), candidates: 0, matched: 0, failed: true };

  let steemAuthors: Map<string, SampledAuthor>;
  try {
    steemAuthors = await recentSteemAuthors();
  } catch {
    return { rows: [], asOf: nowIso(), candidates: 0, matched: 0, failed: true };
  }
  if (steemAuthors.size === 0) return { rows: [], asOf: nowIso(), candidates: 0, matched: 0, failed: true };

  /*
   * ★★ THE NAMES COME FROM STEEM AND GO IN AS TDS PARAMETERS, NEVER AS SQL TEXT. They
   * are the one value in this feature that a third party controls: anybody can create a
   * Steem account and post under any name it will accept. Parameterised, a name is a
   * value and can never become syntax — and the `IN` list is built from placeholders
   * only, in chunks of `SQL_CHUNK` so two days of authors stays under the TDS limit.
   */
  const names = [...new Set([...steemAuthors.keys(), ...carried.map((c) => c.account)])].filter((n) =>
    /^[a-z0-9.-]{3,16}$/.test(n)
  );
  if (names.length === 0) return { rows: [], asOf: nowIso(), candidates: 0, matched: 0, failed: false };

  const rows: { author: string; hive_posts: number; last_hive: string | Date }[] = [];
  for (let i = 0; i < names.length; i += SQL_CHUNK) {
    const part = names.slice(i, i + SQL_CHUNK);
    const placeholders = part.map((_, j) => `@a${j}`).join(',');
    // ★ This is a BACKGROUND build, so it queues on the slow lane. It was on the reader
    // lane, which is the exact borrowing that broke every profile once already.
    const got = await querySlow<{ author: string; hive_posts: number; last_hive: string | Date }>(
      `SELECT c.author, COUNT(*) AS hive_posts, MAX(c.created) AS last_hive
       FROM Comments c WITH (NOLOCK)
       WHERE c.depth = 0 AND c.author IN (${placeholders}) AND c.created > @fork
       GROUP BY c.author`,
      [
        ...part.map((name, j) => ({ name: `a${j}`, type: TYPES.VarChar, value: name })),
        { name: 'fork', type: TYPES.VarChar, value: HIVE_FORK_DATE }
      ]
    );
    // ★ `null` is "we could not ask", never an empty board. See hivesql.ts.
    if (got === null) return { rows: [], asOf: nowIso(), candidates: names.length, matched: 0, failed: true };
    rows.push(...got);
  }

  /*
   * ★★ THE COUNT COSTS ONE WALK PER ACCOUNT, SO IT RUNS AGAINST A BUDGET. Each account's
   * Steem blog is paged back to the start of the window (`STEEM_WINDOW_DAYS`), which is
   * one to three pages for almost everybody — against six pages each before, which
   * exhausted the budget after sixty-odd accounts and left thirty rows saying "not
   * counted". Across a hundred candidates this is a few hundred requests to a chain we do
   * not run: fine once a week behind the board store, not fine per reader. Accounts past
   * the budget keep their row and report a count of -1, which the table renders as "not
   * counted" rather than as zero.
   *
   * ★ THE LIKELIEST TOP ROWS ARE COUNTED FIRST (2026-09-23). Two days of candidates is a
   * larger matched set than six hours was, so the budget can run out; spend it on last
   * week's count or the sample's posts scaled to ninety days, whichever is larger, so an
   * account that runs out of budget is one that would not have made the board anyway.
   */
  const prior = new Map(carried.map((c) => [c.account, c.steemPosts]));
  const scale = (STEEM_WINDOW_DAYS * 24) / CANDIDATE_HOURS;
  const likely = (a: string) => Math.max(prior.get(a) ?? 0, (steemAuthors.get(a)?.posts ?? 0) * scale);
  const matchedAccounts = rows.map((r) => r.author).sort((a, b) => likely(b) - likely(a));
  const counts = new Map<string, SteemPresence>();
  let budget = STEEM_COUNT_BUDGET;
  for (const account of matchedAccounts) {
    if (budget <= 0) break;
    try {
      const presence = await steemPostsSinceFork(account, {
        since: windowStart(STEEM_WINDOW_DAYS),
        maxPages: STEEM_WINDOW_PAGES
      });
      budget -= presence?.requests ?? 1;
      if (presence) counts.set(account, presence);
    } catch {
      budget -= 1;
    }
  }

  // ★ Said, not silent: an uncounted account is invisible on the board.
  if (counts.size < matchedAccounts.length) {
    logger.warn(
      `inquisition: crossposting counted ${counts.size} of ${matchedAccounts.length} matched accounts; the request budget ran out`
    );
  }

  const out: CrosspostRow[] = rows
    .map((r) => {
      const counted = counts.get(r.author);
      return {
        account: r.author,
        steemPosts: counted ? counted.posts : -1,
        partial: counted?.partial ?? false,
        lastSteem: counted?.lastPost || steemAuthors.get(r.author)?.last || '',
        lastHive: new Date(r.last_hive).toISOString(),
        hivePosts: Number(r.hive_posts) || 0
      };
    })
    // ★ A carried account that has stopped posting to Steem counts 0 in the window: it is
    // no longer crossposting, and a row reading "0" would say it still is.
    .filter((row) => row.steemPosts !== 0);

  // ★ The count is the rank; recency breaks ties and has its own column.
  out.sort((a, b) => (b.steemPosts === a.steemPosts ? b.lastSteem.localeCompare(a.lastSteem) : b.steemPosts - a.steemPosts));

  /*
   * ★ `matched` IS HOW MANY CROSSPOST, `rows` IS HOW MANY ARE SHOWN, AND CONFLATING THEM
   * PRINTED A FALSEHOOD: the footer read "50 of 340" when 140 accounts actually matched,
   * because it counted the slice rather than the result.
   */
  return { rows: out.slice(0, limit), asOf: nowIso(), candidates: names.length, matched: out.length, failed: false };
}

/**
 * ════ ONE ACCOUNT'S STEEM OUTPUT, FOR THE PROFILE RECORD ════
 *
 * ★★ A RESHARE IS NOT A POST, AND THE FORK TEST MUST COME SECOND. `get_discussions_by_blog`
 * is ordered by blog-entry id, not by `created`, so a reblog of somebody else's 2017 post
 * can sit anywhere in the feed. Testing the fork date before filtering reshares ended the
 * walk on a stranger's old post and published the result as this account's own count —
 * measured wrong for four accounts before it was caught. Filter by author first.
 */
/*
 * ★★★ SIX PAGES WAS A CEILING EVERYBODY HIT, WHICH IS A BOARD THAT RANKS NOTHING (found
 * live 2026-09-20, owner: "steem is shwoing 595+ for all").
 *
 * Six pages of 100 is 600 blog entries, minus the handful of reshares filtered out of
 * each, which is why 595 appeared on row after row: it is not a count, it is the cap
 * wearing a number. Of the 100 rows on the board, 63 were capped, 30 said "not counted"
 * because the request budget ran out at six pages each, and SEVEN carried a real total.
 *
 * Forty pages is the ceiling for a PROFILE, where the walk runs once a week in the
 * background for one account and only a genuinely prolific one spends all forty. The
 * BOARD does not use this at all any more -- see `STEEM_WINDOW_DAYS`.
 */
const MAX_PROFILE_PAGES = 40;

/**
 * ★★ THE BOARD COUNTS A WINDOW, NOT A LIFETIME, AND IT IS BOTH CHEAPER AND SHARPER.
 *
 * "Still keeping a foot in the old country" is a question about now, and the blurb always
 * said the candidates are drawn from Steem's recent authors precisely to find "the ones
 * still at it rather than everyone who ever was". A lifetime total cannot answer that once
 * everyone saturates: the top 100 rows all read 576-595 and the ranking degenerated into
 * the order the walk happened to stop in.
 *
 * Ninety days is a few hundred posts even for a heavy poster, so the walk ends naturally
 * after one to three pages instead of at a cap, the whole matched set fits inside the
 * request budget with room to spare, and the number on screen is a real count again.
 * The lifetime-since-the-fork figure is still on the profile strip, where it is one
 * account at a time and can afford forty pages.
 */
const STEEM_WINDOW_DAYS = 90;
/*
 * ★ TWENTY PAGES, SO THE CAP SITS ABOVE A THOUSAND (owner, 2026-09-23: "above 1000 would be
 * clear for everyone except him"). Ten pages printed "991+" for both @haejin and
 * @web2.support, a cap wearing a number; at twenty, only an account past ~2,000 posts in
 * ninety days carries the "+".
 */
const STEEM_WINDOW_PAGES = 20;

function windowStart(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export interface SteemPresence {
  posts: number;
  lastPost: string | null;
  /** The walk hit its page cap, so `posts` is a floor rather than a total. */
  partial: boolean;
  /** Upstream requests this walk actually cost, so a caller can budget. */
  requests: number;
}

export interface WalkOptions {
  /**
   * Count posts published on or after this date AND stop walking once the account's own
   * posts are older than it. Defaults to the fork-plus-six-months cutoff, where the walk
   * keeps going to `HIVE_FORK_DATE` so a post inside the migration window is skipped
   * rather than ending the walk early.
   */
  since?: string;
  maxPages?: number;
}

export async function steemPostsSinceFork(
  account: string,
  opts: WalkOptions = {}
): Promise<SteemPresence | null> {
  const countFrom = opts.since ?? STEEM_COUNT_FROM;
  const stopBefore = opts.since ?? HIVE_FORK_DATE;
  const maxPages = opts.maxPages ?? MAX_PROFILE_PAGES;
  const seen = new Set<string>();
  const spend: Spend = { n: 0 };
  let posts = 0;
  let lastPost: string | null = null;
  const done = (partial: boolean): SteemPresence => ({ posts, lastPost, partial, requests: spend.n });
  let startAuthor = '';
  let startPermlink = '';

  try {
    for (let page = 0; page < maxPages; page += 1) {
      const query: Record<string, unknown> = { tag: account, limit: PAGE_LIMIT };
      if (startPermlink) {
        query.start_author = startAuthor;
        query.start_permlink = startPermlink;
      }
      const result = (await steem('condenser_api.get_discussions_by_blog', [query], spend)) as SteemPost[];
      if (!Array.isArray(result) || result.length === 0) return done(false);

      const cursorBefore = startPermlink;
      let crossedFork = false;
      for (const post of result) {
        const author = typeof post.author === 'string' ? post.author : null;
        const permlink = typeof post.permlink === 'string' ? post.permlink : null;
        const created = typeof post.created === 'string' ? post.created : null;
        if (!author || !permlink || !created) continue;
        const key = `${author}/${permlink}`;
        if (seen.has(key)) continue;
        seen.add(key);
        startAuthor = author;
        startPermlink = permlink;
        // ★ Reshare filter FIRST — see the note above.
        if (author !== account) continue;
        // ★ The WALK still stops at the fork; only the COUNT starts six months later,
        // so a post inside the window is skipped rather than ending the walk early.
        if (created < stopBefore) {
          crossedFork = true;
          break;
        }
        if (created < countFrom) continue;
        posts += 1;
        if (!lastPost || created > lastPost) lastPost = created;
      }
      if (crossedFork) return done(false);
      if (result.length < PAGE_LIMIT) return done(false);
      if (startPermlink === cursorBefore) return done(false);
    }
    // ★ Ran out of pages before reaching the fork: the count is a floor, and says so.
    return done(true);
  } catch (error) {
    // ★★ AN ACCOUNT THAT DOES NOT EXIST ON STEEM HAS ZERO STEEM POSTS (2026-09-22). Every
    // Hive account created after the 2020 fork is unknown to Steem, and Steem answers
    // `get_discussions_by_blog` for it with an RPC error, which this walk turned into
    // `null` ("not read") and the record into a PARTIAL one that no nightly pass could
    // ever complete: 56 of the 102 stuck records were exactly this. One `get_accounts`
    // settles it: no account there means none since the fork, a real zero.
    if (String(error).includes('steem rpc error')) {
      try {
        const found = (await steem('condenser_api.get_accounts', [[account]], spend)) as unknown[];
        if (Array.isArray(found) && found.length === 0) {
          return { posts: 0, lastPost: null, partial: false, requests: spend.n };
        }
      } catch (lookupError) {
        logger.warn(`inquisition: steem account lookup for @${account} failed: ${String(lookupError)}`);
      }
    }
    // ★ An endpoint that will not answer is not a fact about the account. It IS a fact
    // about the walk, so it is logged (2026-09-22: 56 records had a silent null here).
    logger.warn(`inquisition: steem walk for @${account} failed after ${spend.n} request(s): ${String(error)}`);
    return null;
  }
}
