import { getLogger } from '@ui/lib/logging';
import { lookupAccounts } from '@transaction/lib/hive-api';
import { ensureSquatterList, isSquatterName } from '@/blog/lib/lite/moderation/squatter-list';
import { withTtlCache } from '@/blog/lib/server-ttl-cache';
import { getTrendingTagsCached } from '@/blog/lib/trending-tags';
import { liteConfig } from '@/blog/lib/lite/config';
import * as users from '@/blog/lib/lite/repositories/user-repository';
import { accountPrefixOf, normalizeSearchText, tagPrefixOf } from './query';
import { rankSuggestions, type LiteAccountCandidate, type SearchSuggestions } from './suggest-rank';
import { isBrowsableTopic } from './topics';

const logger = getLogger('app');

/** How many Hive names to ask for. More than the six shown, so a lite handle or an exact match can displace one. */
const HIVE_LOOKUP_LIMIT = 8;
const LITE_LOOKUP_LIMIT = 5;

/**
 * One suggestion answer per normalised query, 60s fresh + 5 minutes served
 * stale while refreshing. Suggestions are a convenience, not a fact: a name
 * created in the last minute simply appears a minute later. The memo is what
 * turns "every debounced keystroke of every reader" into "one Hive call per
 * distinct prefix per minute".
 *
 * `shouldCache` accepts an empty answer on purpose (nobody is called `zq`, and
 * asking hived again in a second will not change that). A REJECTION still
 * stores nothing, per `server-ttl-cache.ts` property 1.
 */
// Key = the query as the loader reads it (trimmed, lowercased): `Photo` and
// `photo` are one answer and must be one memo entry (review 2026-09-05).
// ★ NAMED (2026-09-06, review fix) — see server-ttl-cache.ts's header note.
export const getSearchSuggestionsCached = withTtlCache(
  loadSuggestions,
  (query: string) => normalizeSearchText(query).toLowerCase(),
  {
    name: 'searchSuggestions',
    ttlMs: 60_000,
    max: 2000,
    shouldCache: (value) => Boolean(value),
    staleWhileRevalidateMs: 300_000
  }
);

async function loadSuggestions(query: string): Promise<SearchSuggestions> {
  const text = normalizeSearchText(query);
  const prefix = accountPrefixOf(text);
  const tagPrefix = tagPrefixOf(text);

  const [hive, lite, trending] = await Promise.all([
    prefix ? lookupAccounts(prefix, HIVE_LOOKUP_LIMIT) : Promise.resolve<string[]>([]),
    prefix ? loadLiteCandidates(prefix) : Promise.resolve<LiteAccountCandidate[]>([]),
    tagPrefix ? loadBrowsableTags() : Promise.resolve<string[]>([])
  ]);

  /**
   * ★★★ THE HEADER SEARCH BOX NEVER GOT THE FIX ITS SIBLING GOT (2026-09-11).
   *
   * `/api/search/people` drops squatters before merging (see `lib/search/people.ts`,
   * fixed 2026-09-10 with this same pair of lines). This route -- the typeahead that
   * runs on every keystroke in the header, and by far the more used of the two -- was
   * never updated, and `rankSuggestions` explicitly prefers a Hive name over a
   * colliding lite handle. So typing a squatted name showed ONLY the attacker, and the
   * impersonated account was unreachable from the product's primary way of finding
   * people. Measured on production 2026-09-11: `?q=chadmasters` returned
   * `[{"name":"chadmasters","kind":"hive"}]`, while uncontested controls correctly
   * returned `kind:"lite"`.
   *
   * Dropped BEFORE the rank for the same reason people.ts drops before the merge: the
   * collision rule in `rankSuggestions` is first-wins, so a squatter left in the Hive
   * list would still evict the lite row. Awaited, because the predicate reads a cache
   * that a cold worker has not loaded yet and would otherwise filter nobody.
   */
  await ensureSquatterList();
  const hiveNames = hive.filter((name) => !isSquatterName(name));

  return rankSuggestions({ prefix, tagPrefix, hiveNames, liteUsers: lite, trendingTags: trending });
}

/**
 * The lite half never fails the request: with lite accounts disabled (or the
 * database unreachable) the reader still gets Hive accounts and topics. The
 * Hive half above is allowed to reject, which is what keeps a Hive outage out
 * of the memo.
 */
async function loadLiteCandidates(prefix: string): Promise<LiteAccountCandidate[]> {
  if (!liteConfig.enabled || !liteConfig.databaseUrl) return [];
  try {
    const rows = await users.searchLiteUsersByPrefix(prefix, LITE_LOOKUP_LIMIT);
    return rows.map((user) => ({
      displayName: user.displayName,
      profileName: user.profile?.name ?? null,
      avatarUrl: user.avatarUrl || user.profile?.profile_image || null
    }));
  } catch (error) {
    logger.warn('search suggest: lite lookup failed: %s', error instanceof Error ? error.message : String(error));
    return [];
  }
}

/**
 * The trending list is already memoised for an hour with a day of stale serve
 * (`lib/trending-tags.ts`), so this costs nothing per keystroke. A failure there
 * means "no topic rows", not "no suggestions".
 */
async function loadBrowsableTags(): Promise<string[]> {
  try {
    const tags = await getTrendingTagsCached();
    return tags.map((tag) => tag.name).filter(isBrowsableTopic);
  } catch {
    return [];
  }
}
