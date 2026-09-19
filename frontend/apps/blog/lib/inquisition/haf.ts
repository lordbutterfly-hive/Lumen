import 'server-only';

/**
 * ════ THE HAF CLIENT: SERVER-SIDE, BOUNDED, FAILING OVER ════
 *
 * ★★★ THE REVERSE LOOKUP EXISTS, AND THE SPEC SAID IT DID NOT.
 * `INQUISITION-MODE-SPEC.md` §5 calls "downvotes received" the biggest build item in
 * the feature and says no RPC returns the aggregate, so it needs an indexer. I
 * repeated that. The owner pushed back — "you can pull all this data yourself, im
 * 100% sure, theres sql stuf live, services payed by dhf" — and was right.
 *
 * `GET {hafah}/accounts/{name}/operations?operation-types=0` returns every
 * `vote_operation` the account is INVOLVED IN, and each carries `voter`, `author`
 * and `weight`. So `author === name && weight < 0` is exactly "downvotes received",
 * and `operation-types=18` with `id: 'follow'`, `what: ['ignore']` is "mutes
 * received". Verified 2026-09-19 against api.syncad.com: @lordbutterfly returns
 * `total_operations: 241248` on the vote type, with bodies in that shape.
 *
 * ★★ THE VOLUME IS THE PROBLEM, NOT THE LOOKUP, and this file exists to say no to
 * it. 241k operations for one account is not something a render path may walk. Every
 * read here is bounded three ways — a page size, a page cap, and a time floor — and
 * a read that hits the cap comes back `partial: true` rather than pretending to be a
 * total. A number we cannot stand behind does not go on the board.
 *
 * ★ HAF is DHF-funded public infrastructure with no auth and no key. Two endpoints,
 * probed at build time and both answering; the pair fails over the same way the Magi
 * node list does. `server-only` at the top because the browser must never hold these
 * URLs: it keeps them out of the CSP and out of a reader's network tab.
 */

/** Both answered on 2026-09-19. Ordered by observed freshness, not preference. */
const HAF_ENDPOINTS = [
  'https://api.syncad.com/hafah-api',
  'https://api.hive.blog/hafah-api'
] as const;

/** From `/operation-types`, read live rather than guessed. */
export const OP = {
  vote: 0,
  customJson: 18,
  authorReward: 51,
  curationReward: 52
} as const;

export interface HafOp {
  op: { type: string; value: Record<string, unknown> };
  block: number;
  timestamp: string;
  operation_id: string;
}

export interface HafPage {
  total_operations: number;
  total_pages: number;
  operations_result: HafOp[];
}

/**
 * ★ ONE UPSTREAM ATTEMPT, HARD-STOPPED. `AbortSignal.timeout` rather than a race
 * against a `setTimeout`, so a hung socket is actually released instead of leaking
 * while a promise loses a race.
 */
async function once(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
    // These are public aggregates; Next's own fetch cache would hold them past the
    // point our TTL cache is responsible for, and two caches over one value is how
    // a stale number outlives its own expiry.
    cache: 'no-store'
  });
  if (!res.ok) throw new Error(`haf ${res.status}`);
  return res.json();
}

/**
 * Tries each endpoint once, in order. Does NOT retry the same endpoint: a HAF node
 * that just refused or timed out will do it again inside the window a reader is
 * willing to wait, and the second node is the cheaper answer.
 */
export async function hafGet(path: string, timeoutMs = 4000): Promise<unknown> {
  let last: unknown;
  for (const base of HAF_ENDPOINTS) {
    try {
      return await once(`${base}${path}`, timeoutMs);
    } catch (error) {
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error('haf: every endpoint failed');
}

export interface WalkBounds {
  /** Stop after this many pages, whatever is left. */
  maxPages: number;
  /** Operations per request. HAF's own ceiling applies on top. */
  pageSize: number;
  /** ISO timestamp. Passed to HAF as `from-block`, which filters server-side. */
  since: string;
}

export interface WalkResult {
  ops: HafOp[];
  /** True when the page cap stopped the walk, so the caller has a floor, not a total. */
  partial: boolean;
  /** Operations in the requested WINDOW, as HAF counts them. */
  totalOperations: number;
}

/**
 * Walks an account's operations of one type, NEWEST FIRST, within a time window.
 *
 * ★★★ TWO THINGS I GOT WRONG AND MEASURED MY WAY OUT OF (2026-09-19). Written down
 * because both are invisible until you print timestamps, and both return a confident
 * zero rather than an error.
 *
 *   1. HAF PAGES ASCEND IN TIME. My first version assumed newest-first, walked from
 *      page 1, hit a 2016 operation on the very first row, decided it had passed the
 *      time floor and returned. Three accounts came back with "0 downvotes received"
 *      and nothing looked broken. Measured: @acidyo's page 1 is 2016-05-24; the last
 *      page is today.
 *   2. FILTERING IN JS IS THE WRONG PLACE. @acidyo has 1,964,323 vote operations, so
 *      even paging correctly, a twelve-month window is hundreds of requests. The
 *      endpoint takes `from-block` AS A TIMESTAMP and filters server-side: the same
 *      account drops to 255,193 operations across 256 pages, and the newest page
 *      alone carries 114 received downvotes.
 *
 * So: one request with no `page` to learn `total_pages` (omitting it returns the LAST
 * page, which is the newest), then descend. `page=total_pages` is today,
 * `page=1` is the far edge of the window — verified by printing both.
 */
export async function walkAccountOps(
  account: string,
  opType: number,
  { maxPages, pageSize, since }: WalkBounds
): Promise<WalkResult> {
  const base =
    `/accounts/${encodeURIComponent(account)}/operations` +
    `?operation-types=${opType}&page-size=${pageSize}&from-block=${encodeURIComponent(since)}`;

  const head = (await hafGet(base)) as HafPage;
  const ops: HafOp[] = [...(head?.operations_result ?? [])];
  const totalOperations = head?.total_operations ?? 0;
  const totalPages = head?.total_pages ?? 1;

  // The head request already consumed the newest page.
  let fetched = 1;
  for (let page = totalPages - 1; page >= 1; page -= 1) {
    if (fetched >= maxPages) return { ops, partial: true, totalOperations };
    const body = (await hafGet(`${base}&page=${page}`)) as HafPage;
    const batch = body?.operations_result ?? [];
    fetched += 1;
    if (batch.length === 0) break;
    ops.push(...batch);
  }

  return { ops, partial: false, totalOperations };
}

/** ISO timestamp for `months` ago, which is what `from-block` compares against. */
export function monthsAgo(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 19);
}
