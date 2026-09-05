import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { enforceHivesenseRate } from '@/blog/lib/lite/antispam/rate-limit';
import { searchPeopleByPrefixCached, searchPeopleByTopicCached } from '@/blog/lib/search/people';
import { MIN_QUERY_LENGTH, normalizeSearchText } from '@/blog/lib/search/query';
import { takeSuggestToken } from '@/blog/lib/search/suggest-limiter';

const logger = getLogger('app');

const NO_STORE = { 'cache-control': 'private, no-store' };

/**
 * GET /api/search/people?q=<text>&mode=prefix|topic
 *
 * The People tab of /search, in two independently fetched sections:
 *
 *   `prefix` (default): accounts whose NAME starts with the text. hived
 *     `lookup_accounts` plus Lumen lite accounts, hydrated through parallel
 *     `bridge.get_profile` (~0.5s). Empty when the text cannot be an account
 *     name (a space, a capital letter, punctuation).
 *   `topic`: accounts whose POSTS are about the text, from Hivesense
 *     `authors/search` (1.8 to 2.7s measured). Fetched separately so the fast
 *     section is on screen while this one is still running, and so a Hivesense
 *     outage costs one optional section rather than the tab.
 *
 * Both memoised server-side (`lib/search/people.ts`). The topic leg counts
 * against the same per-IP Hivesense budget the proxy route uses, best-effort
 * like every limiter call in this repo (a limiter-store outage must not take a
 * read-only feature offline). The prefix leg takes a token from the same
 * in-memory per-IP bucket as `/api/search/suggest` (review 2026-09-05: `/api/*`
 * is exempt from the middleware page budget, and one anonymous GET here is a
 * `lookup_accounts` + up to twelve `get_profile` calls + a Postgres scan on a
 * miss). Keyed `people:` so a typing reader's suggest traffic and their People
 * tab do not spend each other's tokens. Takes `req` for the reason every route
 * here does.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const query = normalizeSearchText(req.nextUrl.searchParams.get('q'));
  const mode = req.nextUrl.searchParams.get('mode') === 'topic' ? 'topic' : 'prefix';
  if (query.length < MIN_QUERY_LENGTH) {
    return NextResponse.json([], { headers: NO_STORE });
  }
  if (mode === 'topic') {
    try {
      if (!(await enforceHivesenseRate(getClientIp(req)))) {
        return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: NO_STORE });
      }
    } catch {
      /* limiter unavailable: proceed */
    }
  } else if (!takeSuggestToken(`people:${getClientIp(req)}`)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { ...NO_STORE, 'retry-after': '5' } });
  }
  try {
    const people =
      mode === 'topic' ? await searchPeopleByTopicCached(query) : await searchPeopleByPrefixCached(query);
    return NextResponse.json(people, { headers: NO_STORE });
  } catch (error) {
    logger.warn(
      'search people (%s) failed for "%s": %s',
      mode,
      query,
      error instanceof Error ? error.message : String(error)
    );
    // 503, not 502: Cloudflare replaces an origin 502/504 body with its own error
    // page (verified on prod 2026-09-05, see /api/search), and the client reads
    // this code. `people-results.tsx` keys on the failure, not the status.
    return NextResponse.json(
      { error: 'people_unavailable' },
      { status: 503, headers: { ...NO_STORE, 'retry-after': '10' } }
    );
  }
}
