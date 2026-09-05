/**
 * The reader's own last searches, kept in this browser only.
 *
 * `localStorage` is the right store: a recent search is a convenience for the
 * person at this keyboard, never something to sync or to send anywhere. Every
 * read and write is wrapped, because the accessor itself throws in private
 * windows and in browsers set to block site data, and the header must render
 * with or without it.
 *
 * The list logic is pure (`addRecentSearch`, `parseRecentSearches`) so the
 * unit test pins de-duplication and the cap without a DOM.
 */

export const RECENT_SEARCHES_KEY = 'lumen:recent-searches';
export const MAX_RECENT_SEARCHES = 8;
const MAX_STORED_LENGTH = 60;

export type RecentScope = 'posts' | 'people';

/**
 * One remembered search: the text and WHERE it was searched, so reopening it
 * lands on the same tab (review 2026-09-05: a People search reopened as a
 * Posts search). `t` is omitted for posts, the default, to keep the stored
 * shape small and the pre-scope entries (plain strings) readable.
 */
export interface RecentSearch {
  q: string;
  t?: 'people';
}

/** Most recent first; the same query (any case, any scope) moves to the front instead of repeating. */
export function addRecentSearch(
  list: readonly RecentSearch[],
  query: string,
  scope: RecentScope = 'posts'
): RecentSearch[] {
  const clean = query.replace(/\s+/g, ' ').trim().slice(0, MAX_STORED_LENGTH);
  if (!clean) return [...list];
  const lower = clean.toLowerCase();
  const rest = list.filter((item) => item.q.toLowerCase() !== lower);
  const entry: RecentSearch = scope === 'people' ? { q: clean, t: 'people' } : { q: clean };
  return [entry, ...rest].slice(0, MAX_RECENT_SEARCHES);
}

/**
 * Only well-formed entries are trusted; anything else reads as "no history".
 * A plain string is the pre-scope shape and still means a posts search.
 */
export function parseRecentSearches(raw: string | null | undefined): RecentSearch[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries: RecentSearch[] = [];
    for (const item of parsed) {
      if (typeof item === 'string') {
        if (item.trim().length > 0) entries.push({ q: item.slice(0, MAX_STORED_LENGTH) });
        continue;
      }
      if (item && typeof item === 'object' && typeof (item as { q?: unknown }).q === 'string') {
        const q = (item as { q: string }).q;
        if (q.trim().length === 0) continue;
        const entry: RecentSearch = { q: q.slice(0, MAX_STORED_LENGTH) };
        if ((item as { t?: unknown }).t === 'people') entry.t = 'people';
        entries.push(entry);
      }
    }
    return entries.slice(0, MAX_RECENT_SEARCHES);
  } catch {
    return [];
  }
}

export function readRecentSearches(): RecentSearch[] {
  try {
    return parseRecentSearches(window.localStorage.getItem(RECENT_SEARCHES_KEY));
  } catch {
    return [];
  }
}

export function rememberSearch(query: string, scope: RecentScope = 'posts'): void {
  try {
    const next = addRecentSearch(readRecentSearches(), query, scope);
    window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
  } catch {
    /* storage blocked: the search still happens, it just is not remembered */
  }
}

export function clearRecentSearches(): void {
  try {
    window.localStorage.removeItem(RECENT_SEARCHES_KEY);
  } catch {
    /* same as above */
  }
}
