import { buildSearchHref } from '@ui/lib/search-href';
import { accountPrefixOf, intendsPeople, normalizeSearchText, tagPrefixOf } from '@/blog/lib/search/query';
import type { SearchSuggestionsWire } from '@/blog/lib/chain-fetch';

/**
 * Turn "what the reader typed" + "what the server suggested" + "what they
 * searched before" into the flat, ordered list the listbox renders and the
 * arrow keys walk. Pure, so `lib/search/__tests__/search-logic.test.ts` pins
 * the order and the destinations.
 */
export type SuggestionRow =
  | { id: string; kind: 'posts'; query: string; href: string }
  | { id: string; kind: 'people'; query: string; href: string }
  | { id: string; kind: 'account'; name: string; accountKind: 'hive' | 'lite'; displayName?: string; href: string }
  | { id: string; kind: 'tag'; tag: string; href: string }
  | { id: string; kind: 'recent'; query: string; href: string };

export interface BuildSuggestionRowsInput {
  /** The raw field value. */
  text: string;
  /** The server's answer for the debounced text, or `null` while there is none. */
  suggestions: SearchSuggestionsWire | null;
  /** The reader's recent searches, most recent first. */
  recent: readonly string[];
}

/**
 * Empty field: the recent searches, nothing else (there is nothing to search
 * for yet). Otherwise the two actions come first, because Enter with nothing
 * highlighted performs the first of them, and a reader should be able to SEE
 * what Enter will do. `@name` swaps their order, since that is the reader
 * saying "a person". Accounts before topics: a name is more specific than a
 * tag prefix, and there are at most six of them.
 */
export function buildSuggestionRows(input: BuildSuggestionRowsInput): SuggestionRow[] {
  const text = normalizeSearchText(input.text);
  if (!text) {
    return input.recent.map((query) => ({
      id: `recent:${query.toLowerCase()}`,
      kind: 'recent',
      query,
      href: buildSearchHref(query)
    }));
  }

  const people = intendsPeople(text);
  const queryForActions = text.replace(/^@/, '') || text;
  const postsRow: SuggestionRow = {
    id: 'action:posts',
    kind: 'posts',
    query: queryForActions,
    href: buildSearchHref(queryForActions)
  };
  const peopleRow: SuggestionRow = {
    id: 'action:people',
    kind: 'people',
    query: queryForActions,
    href: buildSearchHref(queryForActions, 'relevance', 'people')
  };
  const rows: SuggestionRow[] = people ? [peopleRow, postsRow] : [postsRow, peopleRow];

  /**
   * ★ ONLY ROWS THAT STILL MATCH WHAT IS TYPED. The hook keeps the previous
   * answer on screen while the next one loads (`keepPreviousData`), which is
   * right for "phot" -> "photo" (the old rows are a superset) and wrong for
   * "photo" -> "httpsqa" (seen live 2026-09-05: `photo-808` listed under a
   * field that read "httpsqa" for the length of a round trip). Filtering by the
   * CURRENT prefix here makes a stale answer harmless: rows that cannot match
   * disappear on the keystroke, rows that still can stay until replaced.
   */
  const accountPrefix = accountPrefixOf(text);
  const tagPrefix = tagPrefixOf(text);
  for (const account of input.suggestions?.accounts ?? []) {
    if (!accountPrefix || !account.name.startsWith(accountPrefix)) continue;
    rows.push({
      id: `account:${account.name}`,
      kind: 'account',
      name: account.name,
      accountKind: account.kind,
      displayName: account.displayName,
      href: `/@${account.name}`
    });
  }
  for (const tag of input.suggestions?.tags ?? []) {
    if (!tagPrefix || !tag.startsWith(tagPrefix)) continue;
    rows.push({ id: `tag:${tag}`, kind: 'tag', tag, href: `/topics/${encodeURIComponent(tag)}` });
  }
  return rows;
}

/** The row Enter performs when nothing is highlighted: always the first action row. */
export function defaultRow(rows: readonly SuggestionRow[]): SuggestionRow | null {
  return rows.find((row) => row.kind === 'posts' || row.kind === 'people') ?? null;
}

/** Arrow-key movement with wrap-around; `-1` means "nothing highlighted". */
export function stepActiveIndex(current: number, delta: 1 | -1, count: number): number {
  if (count === 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  const next = current + delta;
  if (next < 0) return count - 1;
  if (next >= count) return 0;
  return next;
}
