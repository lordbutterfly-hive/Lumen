import 'server-only';
import { withTtlCache } from '@/blog/lib/server-ttl-cache';
import type { SteemActivity } from './types';
import { HIVE_FORK_ISO, nowIso } from './types';

/**
 * ════ STEEM, AT ARM'S LENGTH ════
 *
 * Hive is a fork of Steem, so the account names are the same on both chains. "Has
 * this account posted to Steem since the fork" is therefore answerable, and it is the
 * one number in this feature that people assert constantly and nobody checks.
 *
 * ★★★ THE BROWSER NEVER TALKS TO STEEM (owner: "be careful there ... dont break the
 * server or catch viruses"). Every call is made here, server-side, and the page gets
 * a count and a date. Three things follow from that and all three are the point:
 * the Steem origin never enters our CSP, a reader's network tab never shows a request
 * to a chain they did not ask about, and a slow or hostile endpoint costs us a
 * timeout instead of costing them a hung page.
 *
 * ★★ THE RESPONSE IS TREATED AS HOSTILE. Exactly three fields are read off each post
 * — `created`, `author`, `permlink` — and nothing else is kept. No `body`, no
 * `json_metadata`, no image URL, no title. None of it is rendered, so there is no
 * path from a Steem post's contents to a Lumen reader's screen. The count and the
 * date are the product; the posts are not.
 *
 * ★ TWO ENDPOINTS, PROBED. `api.steemit.com` and `api.steem.fans` both answered
 * `condenser_api.get_dynamic_global_properties` on 2026-09-19;
 * `steemapi.boylikegirl.club` returned 502 and is not in the list.
 *
 * ★ AND IT IS NOT ON THE PROFILE (owner: "dont put that on the profile page for steem
 * that only goes into the inquisition dashboard"). The design mock has a STEEM cell
 * in the profile Record strip. It is not built. This module is imported by the
 * dashboard route and by nothing else.
 */

const STEEM_ENDPOINTS = ['https://api.steemit.com', 'https://api.steem.fans'] as const;

/** One page is plenty: we need a count since a fixed date, not an archive. */
const PAGE_LIMIT = 100;
/*
 * ★★ 3 PAGES SATURATED AT 298 AND THE BOARD SORTED ON THE SATURATED VALUE. Eleven of
 * twenty-five live rows hit the ceiling, so `bitcoinflood 298` and `justyy 298` were
 * ordered against each other by nothing at all. The cap is raised, and — more
 * importantly — a capped row is no longer ranked as if its number were real: see the
 * route, which sorts complete rows above partial ones.
 */
const MAX_PAGES = 12;

interface SteemPost {
  created?: string;
  author?: string;
  permlink?: string;
}

async function steemCall(endpoint: string, method: string, params: unknown): Promise<unknown> {
  const res = await fetch(endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(3000),
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

/**
 * Posts published to Steem after the Hive hardfork.
 *
 * ★ PAGED BACKWARDS AND STOPPED AT THE FORK. `get_discussions_by_blog` returns newest
 * first, so the walk can stop the moment it crosses 2020-03-20 — which for almost
 * every account is the first page. `MAX_PAGES` bounds the exception.
 *
 * ★★ A RESHARE IS NOT A POST. The blog feed includes reblogs, which are somebody
 * else's writing appearing under this account. `author === account` is what makes the
 * number mean "published", and it is the difference between a fair figure and one
 * that inflates for anyone who reshares.
 */
async function loadSteem(account: string): Promise<SteemActivity> {
  const seen = new Set<string>();
  let postsSinceFork = 0;
  let lastPost: string | null = null;
  let partial = false;
  let startAuthor = '';
  let startPermlink = '';

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query: Record<string, unknown> = { tag: account, limit: PAGE_LIMIT };
    if (startPermlink) {
      query.start_author = startAuthor;
      query.start_permlink = startPermlink;
    }
    const result = (await steem('condenser_api.get_discussions_by_blog', [query])) as SteemPost[];
    if (!Array.isArray(result) || result.length === 0) {
      return { postsSinceFork, lastPost, partial: false, asOf: nowIso() };
    }

    let crossedFork = false;
    for (const post of result) {
      const created = typeof post.created === 'string' ? post.created : null;
      const author = typeof post.author === 'string' ? post.author : null;
      const permlink = typeof post.permlink === 'string' ? post.permlink : null;
      if (!created || !author || !permlink) continue;

      const key = `${author}/${permlink}`;
      // The pagination cursor repeats the last item on the next page.
      if (seen.has(key)) continue;
      seen.add(key);
      startAuthor = author;
      startPermlink = permlink;

      /*
       * ★★★ THE REBLOG FILTER MUST COME FIRST, AND GETTING THAT ORDER WRONG PUT FOUR
       * WRONG INTEGERS NEXT TO FOUR REAL NAMES (found by adversarial review,
       * 2026-09-19). The fork test used to run BEFORE this line, and
       * `get_discussions_by_blog` is ordered by blog-entry id, not by `created` — a
       * reblog of an old post appears wherever it was resteemed. So one pre-fork
       * reblog ended the walk, and the function returned `partial: false`, so the
       * board printed a bare number rather than `N+`.
       *
       * Measured: @logiczombie aborted at feed index 2 on a 2017 @frankbacon reblog,
       * @ned at index 1 on a 2016 @tlc reblog, @fundition at 3, @bullionstackers at
       * 13. All four were published as "1". The board's lower half was ranking people
       * by how early a pre-fork reblog happened to sit in their feed.
       *
       * Somebody else's old post says nothing about when THIS account last posted, so
       * it cannot end the walk. Only the account's OWN pre-fork post does.
       */
      if (author !== account) continue;
      if (created < HIVE_FORK_ISO) {
        crossedFork = true;
        break;
      }
      postsSinceFork += 1;
      if (!lastPost || created > lastPost) lastPost = created;
    }

    if (crossedFork) return { postsSinceFork, lastPost, partial: false, asOf: nowIso() };
    if (result.length < PAGE_LIMIT) return { postsSinceFork, lastPost, partial: false, asOf: nowIso() };
    if (page === MAX_PAGES - 1) partial = true;
  }

  return { postsSinceFork, lastPost, partial, asOf: nowIso() };
}

/**
 * A day. The number moves at the speed of somebody deciding to post on Steem, and
 * the whole point of the figure is that for most accounts it has not moved in years.
 */
export const steemActivity = withTtlCache(loadSteem, (account: string) => account, {
  ttlMs: 24 * 60 * 60 * 1000,
  max: 500,
  name: 'inq-steem'
});
