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
 * ★ RANKED BY CURRENT ACTIVITY ON BOTH CHAINS — see the sort at the bottom of this file
 * for why "latest Steem post" alone is the wrong key. Recency is the whole signal:
 * "posted to both this morning" and "posted to Steem once in 2020" are not the same
 * claim, and the old board printed them in the same column.
 *
 * ★ THE BROWSER STILL NEVER TALKS TO STEEM. Every call is made here, server-side, and
 * exactly three fields are read off each post: `author`, `permlink`, `created`. No body,
 * no metadata, no image URL, nothing renderable. The count and the dates are the product.
 */

const STEEM_ENDPOINTS = ['https://api.steemit.com', 'https://api.steem.fans'] as const;

/** Four pages of 100 gave 340 distinct authors — enough breadth, still four requests. */
const FEED_PAGES = 4;
const PAGE_LIMIT = 100;

/** Hive launched 2020-03-20. A Steem post before that says nothing about crossposting. */
const HIVE_FORK_DATE = '2020-03-20';

export interface CrosspostRow {
  account: string;
  lastSteem: string;
  lastHive: string;
  hivePosts: number;
}

interface SteemPost {
  author?: string;
  permlink?: string;
  created?: string;
}

async function steemCall(endpoint: string, method: string, params: unknown): Promise<unknown> {
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

async function steem(method: string, params: unknown): Promise<unknown> {
  let last: unknown;
  for (const endpoint of STEEM_ENDPOINTS) {
    try {
      return await steemCall(endpoint, method, params);
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

export async function loadCrossposters(): Promise<{
  rows: CrosspostRow[];
  asOf: string;
  candidates: number;
  failed: boolean;
}> {
  if (!hiveSqlConfigured()) return { rows: [], asOf: nowIso(), candidates: 0, failed: true };

  let steemAuthors: Map<string, string>;
  try {
    steemAuthors = await recentSteemAuthors();
  } catch {
    return { rows: [], asOf: nowIso(), candidates: 0, failed: true };
  }
  if (steemAuthors.size === 0) return { rows: [], asOf: nowIso(), candidates: 0, failed: true };

  /*
   * ★★ THE NAMES COME FROM STEEM AND GO IN AS TDS PARAMETERS, NEVER AS SQL TEXT. They
   * are the one value in this feature that a third party controls: anybody can create a
   * Steem account and post under any name it will accept. Parameterised, a name is a
   * value and can never become syntax — and the `IN` list is built from placeholders
   * only. The length is bounded by the feed sample, well under the TDS parameter limit.
   */
  const names = [...steemAuthors.keys()].filter((n) => /^[a-z0-9.-]{3,16}$/.test(n));
  if (names.length === 0) return { rows: [], asOf: nowIso(), candidates: 0, failed: false };

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
  if (rows === null) return { rows: [], asOf: nowIso(), candidates: names.length, failed: true };

  const out: CrosspostRow[] = rows.map((r) => ({
    account: r.author,
    lastSteem: steemAuthors.get(r.author) ?? '',
    lastHive: new Date(r.last_hive).toISOString(),
    hivePosts: Number(r.hive_posts) || 0
  }));

  /*
   * ★★★ RANKED BY ACTIVITY ON **BOTH** CHAINS, WHICH IS THE ONLY RANK THAT MATCHES THE
   * WORD. Sorting by the latest Steem post alone put @muzack1 near the top on a Steem
   * post from today and a Hive post from February 2022 — an account that left Hive, not
   * an account crossposting to it. The sort key is therefore the EARLIER of the two last
   * posts: an account only rises when it has been active on Steem *and* on Hive
   * recently, and one long-dormant side holds it down however busy the other is.
   */
  const bothActive = (r: CrosspostRow) => (r.lastSteem < r.lastHive ? r.lastSteem : r.lastHive);
  out.sort((a, b) => {
    const cmp = bothActive(b).localeCompare(bothActive(a));
    return cmp !== 0 ? cmp : b.hivePosts - a.hivePosts;
  });

  return { rows: out.slice(0, 50), asOf: nowIso(), candidates: names.length, failed: false };
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

export async function steemPostsSinceFork(account: string): Promise<number | null> {
  const seen = new Set<string>();
  let posts = 0;
  let startAuthor = '';
  let startPermlink = '';

  try {
    for (let page = 0; page < MAX_PROFILE_PAGES; page += 1) {
      const query: Record<string, unknown> = { tag: account, limit: PAGE_LIMIT };
      if (startPermlink) {
        query.start_author = startAuthor;
        query.start_permlink = startPermlink;
      }
      const result = (await steem('condenser_api.get_discussions_by_blog', [query])) as SteemPost[];
      if (!Array.isArray(result) || result.length === 0) return posts;

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
        if (created < HIVE_FORK_DATE) {
          crossedFork = true;
          break;
        }
        posts += 1;
      }
      if (crossedFork) return posts;
      if (result.length < PAGE_LIMIT) return posts;
      if (startPermlink === cursorBefore) return posts;
    }
    return posts;
  } catch {
    // ★ An endpoint that will not answer is not a fact about the account.
    return null;
  }
}
