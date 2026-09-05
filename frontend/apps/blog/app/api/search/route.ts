import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getByText } from '@transaction/lib/hive-api';
import { mergeLumenEngagement } from '@/blog/lib/lite/repositories/engagement-repository';
import { hivesenseSearchPosts } from '@/blog/lib/search/hivesense-search';

const logger = getLogger('app');

/**
 * ★ Same rule as `/api/account`. `features/search/search-results.tsx` called
 * `getByText` directly on every non-empty search — `/search` is public, so
 * every visitor who used search downloaded `wax.common.wasm`.
 *
 * ★ MERGES LUMEN ENGAGEMENT (2026-08-13, O2-votes.md item 1's server half --
 * `searchByText` was one of the surfaces named there where a Lumen vote/reblog
 * reverted to the chain-only count on reload because nothing on the server side
 * of this route had ever called `getEngagementTotals`). See
 * `mergeLumenEngagement`'s own doc for the full mechanism and why it copies
 * rather than mutates.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const pattern = (req.nextUrl.searchParams.get('pattern') ?? '').trim();
  const sort = (req.nextUrl.searchParams.get('sort') ?? 'relevance').trim();
  const author = (req.nextUrl.searchParams.get('author') ?? '').trim();
  const observer = (req.nextUrl.searchParams.get('observer') ?? '').trim();
  const startAuthor = (req.nextUrl.searchParams.get('start_author') ?? '').trim();
  const startPermlink = (req.nextUrl.searchParams.get('start_permlink') ?? '').trim();
  const limitParam = req.nextUrl.searchParams.get('limit');
  const limit = limitParam && Number.isFinite(Number(limitParam)) ? Math.min(Number(limitParam), 50) : 20;
  if (!pattern) {
    return NextResponse.json({ error: 'pattern_required' }, { status: 400 });
  }
  try {
    let results;
    try {
      results = await getByText({
        pattern,
        sort,
        author,
        limit,
        observer,
        start_author: startAuthor,
        start_permlink: startPermlink
      });
    } catch (error) {
      /**
       * ★ A SECOND BACKEND FOR THE FIRST PAGE (2026-09-05). Hivemind's search
       * plugin runs on two of the six nodes in the fallback list and `getByText`
       * is deliberately not retried across nodes (see its own doc), so a search
       * outage was total. Hivesense (api.hive.blog, a different service on a
       * different node) is tried before giving up, with three limits:
       *   * never for the deterministic statement timeout: that one is the
       *     reader asking for "Newest" on a broad word, and the page has copy
       *     for it that a 10s semantic detour would only delay;
       *   * never for a later page: a fallback list has no cursor, so answering
       *     page 2 from it would duplicate or replace what is already on screen
       *     (`search-results.tsx` keeps loaded results on a failed `fetchNextPage`);
       *   * never for an author-scoped search, which Hivesense cannot express.
       * If the fallback fails too, the ORIGINAL error is what gets classified
       * and logged, so the log says what actually broke.
       */
      const firstPage = !startAuthor && !startPermlink;
      if (firstPage && !author && !isStatementTimeout(error)) {
        try {
          // No `observer` on the fallback, deliberately: it only personalises
          // mute/blacklist context, and Hivesense answers HTTP 400 for an observer
          // it does not know (measured 2026-09-05 with `observer=Lumen_User`, which
          // is also what made hivemind reject the first attempt). A fallback that
          // fails for the same reason as the primary is not a fallback.
          results = await hivesenseSearchPosts({ q: pattern, limit });
          logger.warn('search: find_text failed for "%s", served %d Hivesense results instead', pattern, results.length);
        } catch (fallbackError) {
          logger.warn(
            'search: Hivesense fallback failed too for "%s": %s',
            pattern,
            fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
          );
          throw error;
        }
      } else {
        throw error;
      }
    }
    const merged = await mergeLumenEngagement(results);
    return NextResponse.json(merged, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error) {
    logger.error(error, 'search lookup failed for "%s"', pattern);
    /**
     * ★★★ SAY WHICH KIND OF FAILURE IT IS (2026-08-18).
     *
     * Everything used to collapse to `search_unavailable`, so the client could
     * not tell a transient blip from the one failure this search reliably has:
     * sorting by Newest on a broad term makes Hivemind's own Postgres abort with
     * `57014`, a statement timeout, every single time (measured 3 of 3 at
     * 5.1-5.4s, and on every node in the fallback list that runs the search
     * plugin at all — it is a backend limit, not a node choice).
     *
     * Retrying that cannot succeed, and the retry is expensive: measured end to
     * end in the browser, one attempt plus one retry took **12.4s** before the
     * reader was told anything. Naming the cause here lets the client skip the
     * retry for exactly this case and keep it for everything else, instead of
     * having to give up retrying altogether.
     */
    /**
     * ★★ 503, NOT 502 (2026-09-05, verified on prod through the edge). Cloudflare
     * replaces an origin's 502/504 response with its own error page: the origin
     * answered `{"error":"search_timeout"}` (seen over loopback on the box) and
     * the browser received `text/plain` "error code: 502". So the code this
     * route was so careful to name never reached the client, and the client's
     * retry predicate could not skip the deterministic timeout: measured 13.3s
     * for /search?q=hive&s=created in production (two 5.8s attempts). Other 5xx
     * codes pass through Cloudflare unchanged; a search index that cannot answer
     * is a 503 in the RFC's own words anyway. `retry-after` says what the
     * message says: nothing changes for a while.
     */
    const timeout = isStatementTimeout(error);
    return NextResponse.json(
      { error: timeout ? 'search_timeout' : 'search_unavailable' },
      { status: 503, headers: { 'cache-control': 'private, no-store', 'retry-after': timeout ? '60' : '10' } }
    );
  }
}

/**
 * Both spellings of the same abort: api.hive.blog forwards Postgres `57014`
 * "canceling statement due to statement timeout"; api.openhive.network answers
 * `result: null`, which `getByText` now rethrows with "statement timeout" in
 * the message so this one test covers both nodes.
 */
function isStatementTimeout(error: unknown): boolean {
  return /57014|statement timeout|canceling statement/i.test(errorDetail(error));
}

/**
 * ★ THE CODE IS NOT IN THE MESSAGE (found 2026-09-05 on the dev box, which reads
 * api.hive.blog). wax wraps a JSON-RPC error as `WaxUnknownRequestError` whose
 * MESSAGE is only "Received non 2xx-3xx http response code ... #502"; the
 * Postgres `57014` body lives on `error.response.response.error`. Testing the
 * message alone therefore never matched on that node, and the Newest timeout
 * fell through to a 10s Hivesense detour before answering `search_unavailable`
 * (measured 15.8s). Only the RESPONSE half is read, never `request.data`: that
 * carries the reader's own pattern, and a search for the words "statement
 * timeout" must not classify itself as one.
 */
function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error ?? '');
  const response = (error as { response?: { response?: unknown } }).response;
  let body = '';
  if (response && typeof response === 'object' && response.response !== undefined) {
    try {
      body = JSON.stringify(response.response).slice(0, 4000);
    } catch {
      body = '';
    }
  }
  return `${error.message} ${body}`;
}
