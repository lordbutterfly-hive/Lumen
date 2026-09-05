import { getLogger } from '@ui/lib/logging';
import { lookupAccounts } from '@transaction/lib/hive-api';
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
export const getSearchSuggestionsCached = withTtlCache(loadSuggestions, (query: string) => query, {
  ttlMs: 60_000,
  max: 2000,
  shouldCache: (value) => Boolean(value),
  staleWhileRevalidateMs: 300_000
});

async function loadSuggestions(query: string): Promise<SearchSuggestions> {
  const text = normalizeSearchText(query);
  const prefix = accountPrefixOf(text);
  const tagPrefix = tagPrefixOf(text);

  const [hive, lite, trending] = await Promise.all([
    prefix ? lookupAccounts(prefix, HIVE_LOOKUP_LIMIT) : Promise.resolve<string[]>([]),
    prefix ? loadLiteCandidates(prefix) : Promise.resolve<LiteAccountCandidate[]>([]),
    tagPrefix ? loadBrowsableTags() : Promise.resolve<string[]>([])
  ]);

  return rankSuggestions({ prefix, tagPrefix, hiveNames: hive, liteUsers: lite, trendingTags: trending });
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
    return rows.map((user) => ({ displayName: user.displayName, profileName: user.profile?.name ?? null }));
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
