import 'server-only';
import { TYPES } from 'tedious';
import { hiveSqlConfigured, queryFast } from './hivesql';
import { nowIso } from './types';

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

/** Four pages of 100 gave 340 distinct authors — enough breadth, still four requests. */
const FEED_PAGES = 4;

/**
 * Upstream requests the per-account counting pass may spend. The board is rebuilt once
 * every three days, so a few hundred requests to api.steemit.com is a reasonable ask;
 * doing it per reader would not be.
 */
const STEEM_COUNT_BUDGET = 400;
const PAGE_LIMIT = 100;

/** Hive launched 2020-03-20. A Steem post before that says nothing about crossposting. */
const HIVE_FORK_DATE = '2020-03-20';

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

/** Distinct authors on Steem's most recent posts, with each one's latest post time. */
async function recentSteemAuthors(): Promise<Map<string, string>> {
  const authors = new Map<string, string>();
  let start: { start_author?: string; start_permlink?: string } = {};

  for (let page = 0; page < FEED_PAGES; page += 1) {
    const query = { tag: '', limit: PAGE_LIMIT, ...start };
    const result = (await steem('condenser_api.get_discussions_by_created', [query])) as SteemPost[];
    if (!Array.isArray(result) || result.length === 0) break;

    for (const post of result) {
      const author = typeof post.author === 'string' ? post.author : null;
      const created = typeof post.created === 'string' ? post.created : null;
      if (!author || !created) continue;
      const held = authors.get(author);
      if (!held || created > held) authors.set(author, created);
    }

    const last = result[result.length - 1];
    if (!last?.author || !last?.permlink) break;
    // ★ The cursor must advance or the next request is byte-identical to this one.
    if (start.start_author === last.author && start.start_permlink === last.permlink) break;
    start = { start_author: last.author, start_permlink: last.permlink };
  }
  return authors;
}

export async function loadCrossposters(limit = 50): Promise<{
  rows: CrosspostRow[];
  asOf: string;
  candidates: number;
  matched: number;
  failed: boolean;
}> {
  if (!hiveSqlConfigured()) return { rows: [], asOf: nowIso(), candidates: 0, matched: 0, failed: true };

  let steemAuthors: Map<string, string>;
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
   * only. The length is bounded by the feed sample, well under the TDS parameter limit.
   */
  const names = [...steemAuthors.keys()].filter((n) => /^[a-z0-9.-]{3,16}$/.test(n));
  if (names.length === 0) return { rows: [], asOf: nowIso(), candidates: 0, matched: 0, failed: false };

  const placeholders = names.map((_, i) => `@a${i}`).join(',');
  const rows = await queryFast<{ author: string; hive_posts: number; last_hive: string | Date }>(
    `SELECT c.author, COUNT(*) AS hive_posts, MAX(c.created) AS last_hive
     FROM Comments c WITH (NOLOCK)
     WHERE c.depth = 0 AND c.author IN (${placeholders}) AND c.created > @fork
     GROUP BY c.author`,
    [
      ...names.map((name, i) => ({ name: `a${i}`, type: TYPES.VarChar, value: name })),
      { name: 'fork', type: TYPES.VarChar, value: HIVE_FORK_DATE }
    ]
  );
  // ★ `null` is "we could not ask", never an empty board. See hivesql.ts.
  if (rows === null) return { rows: [], asOf: nowIso(), candidates: names.length, matched: 0, failed: true };

  /*
   * ★★ THE COUNT COSTS ONE WALK PER ACCOUNT, SO IT RUNS AGAINST A BUDGET. Each account's
   * Steem blog is paged until it crosses the fork, up to `MAX_PROFILE_PAGES`. Across a
   * hundred candidates that is a few hundred requests to a chain we do not run — fine
   * once every three days behind the board store, not fine per reader. Accounts past the
   * budget keep their row and report a count of -1, which the table renders as "not
   * counted" rather than as zero.
   */
  const matchedAccounts = rows.map((r) => r.author);
  const counts = new Map<string, SteemPresence>();
  let budget = STEEM_COUNT_BUDGET;
  for (const account of matchedAccounts) {
    if (budget <= 0) break;
    try {
      const presence = await steemPostsSinceFork(account);
      budget -= presence?.requests ?? 1;
      if (presence) counts.set(account, presence);
    } catch {
      budget -= 1;
    }
  }

  const out: CrosspostRow[] = rows.map((r) => {
    const counted = counts.get(r.author);
    return {
      account: r.author,
      steemPosts: counted ? counted.posts : -1,
      partial: counted?.partial ?? false,
      lastSteem: counted?.lastPost || steemAuthors.get(r.author) || '',
      lastHive: new Date(r.last_hive).toISOString(),
      hivePosts: Number(r.hive_posts) || 0
    };
  });

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
const MAX_PROFILE_PAGES = 6;

export interface SteemPresence {
  posts: number;
  lastPost: string | null;
  /** The walk hit its page cap, so `posts` is a floor rather than a total. */
  partial: boolean;
  /** Upstream requests this walk actually cost, so a caller can budget. */
  requests: number;
}

export async function steemPostsSinceFork(account: string): Promise<SteemPresence | null> {
  const seen = new Set<string>();
  const spend: Spend = { n: 0 };
  let posts = 0;
  let lastPost: string | null = null;
  const done = (partial: boolean): SteemPresence => ({ posts, lastPost, partial, requests: spend.n });
  let startAuthor = '';
  let startPermlink = '';

  try {
    for (let page = 0; page < MAX_PROFILE_PAGES; page += 1) {
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
        if (created < HIVE_FORK_DATE) {
          crossedFork = true;
          break;
        }
        if (created < STEEM_COUNT_FROM) continue;
        posts += 1;
        if (!lastPost || created > lastPost) lastPost = created;
      }
      if (crossedFork) return done(false);
      if (result.length < PAGE_LIMIT) return done(false);
      if (startPermlink === cursorBefore) return done(false);
    }
    // ★ Ran out of pages before reaching the fork: the count is a floor, and says so.
    return done(true);
  } catch {
    // ★ An endpoint that will not answer is not a fact about the account.
    return null;
  }
}
