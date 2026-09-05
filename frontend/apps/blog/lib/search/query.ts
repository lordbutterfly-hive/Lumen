/**
 * Pure helpers shared by the typeahead route, the People route and the header
 * field. No I/O here, so the unit test (`__tests__/search-logic.test.ts`) can pin
 * every rule below without a server.
 *
 * ★ WHY THE THREE SHAPES ARE SEPARATE. One box feeds three very different
 * backends: hived's account index wants a lowercase Hive-charset prefix,
 * `/topics/<tag>` wants a tag, and `find_text` wants free text. Deciding "what
 * could this text be" once, here, is what lets the suggest route skip a Hive
 * call for "hello world" (no account can contain a space) instead of asking and
 * getting nothing back 140ms later.
 */

/** Below this the typeahead does not ask: one letter matches thousands of accounts. */
export const MIN_QUERY_LENGTH = 2;

/**
 * Above this the text is cut before it reaches any backend. Long enough for any
 * real search phrase; short enough that the 60s suggestion memo cannot be filled
 * with unique 500-character keys by a script (the page schema still allows 500
 * for `q` on /search itself, which is not memoised).
 */
export const MAX_QUERY_LENGTH = 60;

/**
 * A PREFIX of a Hive account name: Hive names are `^[a-z][a-z0-9.-]{2,15}$` by
 * consensus, so a prefix starts with a letter and stays inside that charset.
 * Two characters minimum matches `MIN_QUERY_LENGTH`.
 */
const HIVE_ACCOUNT_PREFIX = /^[a-z][a-z0-9.-]{1,15}$/;

/** A tag as `/topics/<tag>` accepts it: lowercase, digits, hyphens, 2 to 32 chars. */
const TAG_SHAPE = /^[a-z0-9][a-z0-9-]{1,31}$/;

/** Invisible characters that `normalizeSearchPattern` in hive-api.ts also strips. */
const INVISIBLE = /[\u200B-\u200D\uFEFF\u00AD]/g;

/**
 * Trim, drop invisible characters, collapse whitespace, cap the length. Case is
 * KEPT: the posts search is case-insensitive upstream, and the header shows the
 * reader's own text back in "Search posts for ...".
 */
export function normalizeSearchText(raw: string | null | undefined): string {
  return String(raw ?? '')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

/**
 * The account prefix this text could be, or `null` when no Hive account can
 * start with it. A leading `@` is the reader saying "a person", so it is
 * stripped rather than rejected. Lowercased because Hive names are.
 */
export function accountPrefixOf(text: string): string | null {
  const candidate = normalizeSearchText(text).replace(/^@/, '').toLowerCase();
  if (candidate.length < MIN_QUERY_LENGTH) return null;
  return HIVE_ACCOUNT_PREFIX.test(candidate) ? candidate : null;
}

/**
 * The tag prefix this text could be, or `null`. A leading `#` is stripped;
 * spaces become hyphens because that is how multi-word tags exist on Hive
 * (`hive-engine`, `street-photography`).
 */
export function tagPrefixOf(text: string): string | null {
  const candidate = normalizeSearchText(text).replace(/^#/, '').toLowerCase().replace(/\s+/g, '-');
  if (candidate.length < MIN_QUERY_LENGTH) return null;
  return TAG_SHAPE.test(candidate) ? candidate : null;
}

/** `@name` typed into the box means "find a person", not "find posts about @name". */
export function intendsPeople(text: string): boolean {
  return normalizeSearchText(text).startsWith('@');
}

/** True when the text is worth sending to the suggest route at all. */
export function isSuggestable(text: string): boolean {
  return normalizeSearchText(text).length >= MIN_QUERY_LENGTH;
}
