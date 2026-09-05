import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getClientIp } from '@/blog/lib/lite/http/ip';
import { getSearchSuggestionsCached } from '@/blog/lib/search/suggest';
import { MIN_QUERY_LENGTH, normalizeSearchText } from '@/blog/lib/search/query';
import { takeSuggestToken } from '@/blog/lib/search/suggest-limiter';

const logger = getLogger('app');

const NO_STORE = { 'cache-control': 'private, no-store' };

/**
 * GET /api/search/suggest?q=<text>
 *
 * The header typeahead. Answers `{ accounts, tags }` for what the reader has
 * typed so far: Hive accounts (hived `lookup_accounts`), Lumen lite accounts
 * (Postgres) and browsable trending topics, merged and ranked in
 * `lib/search/suggest-rank.ts`.
 *
 * ★ TAKES `req` (see `feedback_next_route_handler_frozen_at_build`): a `GET()`
 * without the Request argument is prerendered once at build time and never
 * sees a query string again.
 *
 * ★ `private, no-store`, and the memo is server-side. The middleware stamps
 * every `/api/search*` response `no-store` anyway (its Set-Cookie rule), so a
 * `public` header here would be a lie; the 60s `withTtlCache` in
 * `lib/search/suggest.ts` is where the repeats are absorbed.
 *
 * A query below the minimum answers an EMPTY result with 200 rather than 400:
 * the client never sends one, and a shared cache or a curious script should
 * not be able to turn "too short" into an error log line.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const query = normalizeSearchText(req.nextUrl.searchParams.get('q'));
  if (query.length < MIN_QUERY_LENGTH) {
    return NextResponse.json({ accounts: [], tags: [] }, { headers: NO_STORE });
  }
  if (!takeSuggestToken(getClientIp(req))) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { ...NO_STORE, 'retry-after': '5' } });
  }
  try {
    const suggestions = await getSearchSuggestionsCached(query);
    return NextResponse.json(suggestions, { headers: NO_STORE });
  } catch (error) {
    logger.warn('search suggest failed for "%s": %s', query, error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: 'suggest_unavailable' }, { status: 502, headers: NO_STORE });
  }
}
