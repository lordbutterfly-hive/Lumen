/**
 * Merge the three suggestion sources into one small, ordered answer. Pure, so
 * the ordering rules are pinned by `__tests__/search-logic.test.ts`.
 */

export interface AccountSuggestion {
  /** The `/@name` the row links to. */
  name: string;
  /** `lite` = a Lumen account that lives only in Postgres (no Hive account yet). */
  kind: 'hive' | 'lite';
  /** The profile's chosen display name when it differs from `name` (lite only today). */
  displayName?: string;
}

export interface SearchSuggestions {
  accounts: AccountSuggestion[];
  tags: string[];
}

/** Six people fit under the header field without pushing the topics off screen. */
export const MAX_ACCOUNT_SUGGESTIONS = 6;
export const MAX_TAG_SUGGESTIONS = 4;

/** What the lite repository hands over; kept structural so the test needs no DB type. */
export interface LiteAccountCandidate {
  displayName: string;
  profileName?: string | null;
}

export interface RankSuggestionsInput {
  /** The lowercase account prefix the sources were asked for (`null` = they were not asked). */
  prefix: string | null;
  /** The lowercase tag prefix, or `null` when the text cannot be a tag. */
  tagPrefix: string | null;
  /** Names from hived's `lookup_accounts`, already filtered to the prefix. */
  hiveNames: readonly string[];
  /** Lite accounts whose handle starts with the prefix. */
  liteUsers: readonly LiteAccountCandidate[];
  /** The browsable trending tag names (community ids and tribe tags already removed). */
  trendingTags: readonly string[];
}

/**
 * Ordering, in words:
 *   1. an EXACT match (the reader typed a whole name) goes first;
 *   2. then the shortest names, because they are the closest to what was typed
 *      (`photo` before `photo-curator` for the prefix `photo`);
 *   3. ties alphabetical, so the order is stable across two identical requests.
 * A lite handle that collides with a Hive name is dropped in favour of the Hive
 * one: `/@name` resolves the chain account first and only falls back to the lite
 * profile when no chain account exists (see `(user-profile)/layout.tsx`), so the
 * Hive row is the one that link would actually open.
 */
export function rankSuggestions(input: RankSuggestionsInput): SearchSuggestions {
  const { prefix, tagPrefix } = input;
  const accounts: AccountSuggestion[] = [];

  if (prefix) {
    const seen = new Set<string>();
    for (const name of input.hiveNames) {
      const lower = name.toLowerCase();
      if (!lower.startsWith(prefix) || seen.has(lower)) continue;
      seen.add(lower);
      accounts.push({ name: lower, kind: 'hive' });
    }
    for (const user of input.liteUsers) {
      const lower = user.displayName.toLowerCase();
      if (!lower.startsWith(prefix) || seen.has(lower)) continue;
      seen.add(lower);
      const displayName = (user.profileName ?? '').trim();
      accounts.push(
        displayName && displayName.toLowerCase() !== lower
          ? { name: lower, kind: 'lite', displayName }
          : { name: lower, kind: 'lite' }
      );
    }
    accounts.sort((a, b) => {
      const aExact = a.name === prefix ? 0 : 1;
      const bExact = b.name === prefix ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      if (a.name.length !== b.name.length) return a.name.length - b.name.length;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
  }

  const tags: string[] = [];
  if (tagPrefix) {
    const seen = new Set<string>();
    for (const raw of input.trendingTags) {
      const tag = raw.toLowerCase();
      if (!tag.startsWith(tagPrefix) || seen.has(tag)) continue;
      seen.add(tag);
      tags.push(tag);
    }
    // Same rule as accounts: exact, then shortest, then alphabetical.
    tags.sort((a, b) => {
      const aExact = a === tagPrefix ? 0 : 1;
      const bExact = b === tagPrefix ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      if (a.length !== b.length) return a.length - b.length;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }

  return {
    accounts: accounts.slice(0, MAX_ACCOUNT_SUGGESTIONS),
    tags: tags.slice(0, MAX_TAG_SUGGESTIONS)
  };
}
