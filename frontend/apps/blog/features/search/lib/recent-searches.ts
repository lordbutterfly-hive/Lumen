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

/** Most recent first; the same query typed again moves to the front instead of repeating. */
export function addRecentSearch(list: readonly string[], query: string): string[] {
  const clean = query.replace(/\s+/g, ' ').trim().slice(0, MAX_STORED_LENGTH);
  if (!clean) return [...list];
  const lower = clean.toLowerCase();
  const rest = list.filter((item) => item.toLowerCase() !== lower);
  return [clean, ...rest].slice(0, MAX_RECENT_SEARCHES);
}

/** Only an array of non-empty strings is trusted; anything else reads as "no history". */
export function parseRecentSearches(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.slice(0, MAX_STORED_LENGTH))
      .slice(0, MAX_RECENT_SEARCHES);
  } catch {
    return [];
  }
}

export function readRecentSearches(): string[] {
  try {
    return parseRecentSearches(window.localStorage.getItem(RECENT_SEARCHES_KEY));
  } catch {
    return [];
  }
}

export function rememberSearch(query: string): void {
  try {
    const next = addRecentSearch(readRecentSearches(), query);
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
