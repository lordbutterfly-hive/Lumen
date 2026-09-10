import type { Entry } from '@hive/common-hiveio-packages/wax';
import {
  bannedAuthorList,
  hasBannedAuthors,
  isBannedAuthor as envBannedAuthor,
  withoutBannedAuthors as withoutEnvBannedAuthors
} from '@ui/config/lists/banned-authors';
import { isSquatterName } from '@/blog/lib/lite/moderation/squatter-list';

/**
 * Lumen's view of the global author ban list.
 *
 * The list and the predicate live in `@ui/config/lists/banned-authors` because
 * `packages/transaction` — the chain-API layer where the ban is actually
 * enforced — cannot import from an app. This module is the blog's front door to
 * it: the same predicate, plus the two or three `Entry`-shaped conveniences the
 * app's own routes and server components want. Nothing here re-implements the
 * rule; if you need to know whether a name is banned, it is still one function.
 */
export { bannedAuthorList, hasBannedAuthors };

/**
 * ★★★ TWO SOURCES, ONE PREDICATE (2026-09-10). The env list above is names a human
 * decided to ban. The second source is names the product identifies itself: a Hive
 * account registered AFTER a Lumen lite account of the same name, by someone other
 * than our own creator -- squatting, which on this product is impersonation, because
 * every name-keyed surface used to resolve that name to the lite account's history.
 * See `lib/lite/moderation/squatter-list.ts` for why that list cannot be an env var
 * and why this stays synchronous.
 *
 * Everything downstream is unchanged: this is still ONE function to ask, and every
 * existing caller (the profile layout, `filterBannedEntries`, the discussion filter,
 * search, metadata) picks up the second source without knowing it exists.
 */
export function isBannedAuthor(name: string | null | undefined): boolean {
  return envBannedAuthor(name) || isSquatterName(name);
}

/**
 * Same two sources, same shape as the upstream helper it wraps: the caller still says
 * where the name lives on its own row, and both lists are applied in one pass.
 */
export function withoutBannedAuthors<T>(
  rows: T[] | null | undefined,
  pick: (row: T) => string | null | undefined
): T[] {
  const kept = withoutEnvBannedAuthors(rows, pick);
  if (kept.length === 0) return kept;
  return kept.filter((row) => !isSquatterName(pick(row)));
}

/**
 * Drop every banned author's post from a feed page.
 *
 * ★ CHECKS BOTH NAMES ON THE ENTRY, and it has to. By the time an entry reaches
 * a feed response its `author` may have been REWRITTEN to a Lumen display name
 * (`hydrate` in the For You route does this, and `attachLiteIdentities` sets
 * `_lite.chainAuthor`), so the on-chain account that actually signed the post
 * can be hiding in `_lite.chainAuthor` while `author` reads as something else.
 * Testing only the visible name would let a banned account through any surface
 * that relabels its entries.
 */
export function filterBannedEntries<T extends Entry>(entries: T[] | null | undefined): T[] {
  if (!entries || entries.length === 0) return entries ?? [];
  if (!hasBannedAuthors()) return entries;
  return entries.filter(
    (entry) => !isBannedAuthor(entry?.author) && !isBannedAuthor(entry?._lite?.chainAuthor)
  );
}

/** True when this single entry must not be rendered at all. */
export function isBannedEntry(entry: Entry | null | undefined): boolean {
  if (!entry) return false;
  return isBannedAuthor(entry.author) || isBannedAuthor(entry._lite?.chainAuthor);
}

/**
 * ★★★ THE COMMENT-THREAD FILTER THAT NOTHING HAD EVER CALLED (2026-09-10).
 *
 * `withoutBannedDiscussion` was written for exactly this map shape -- it walks
 * `replies`, prunes a banned author's whole subtree and rewrites the surviving
 * parents' child lists -- and a grep for its callers returns NOTHING. So the ban
 * reached feeds (`filterBannedEntries`) and profiles (the layout's `bail`) but never
 * a comment thread: a banned account's replies rendered normally under every post,
 * on the surface where a griefer is most visible. Found while checking whether the
 * squatter ban actually hid a live squatter's reply. It did not, and neither did the
 * env list, for anyone, ever.
 *
 * Reimplemented here rather than fixed upstream for one reason beyond the two
 * sources: the upstream version early-returns on `!hasBannedAuthors()`, which asks
 * the ENV list only. With the env list empty -- which is its state on production
 * today -- it would return the thread untouched no matter how many squatters were in
 * it. This asks `isBannedAuthor`, which is both sources.
 *
 * Same pruning semantics as upstream, deliberately: a banned author's replies go with
 * them, because a thread that keeps the children of a hidden comment shows answers to
 * something nobody can see.
 */
export function withoutBannedDiscussion<T>(
  discussion: Record<string, T> | null | undefined
): Record<string, T> | null | undefined {
  if (!discussion) return discussion;

  const nodeOf = (key: string): { author?: string; replies?: unknown[] } =>
    discussion[key] as unknown as { author?: string; replies?: unknown[] };
  const childKeys = (key: string): string[] =>
    (nodeOf(key)?.replies ?? []).filter((child): child is string => typeof child === 'string');

  const doomed = new Set<string>();
  const mark = (key: string): void => {
    if (doomed.has(key)) return;
    doomed.add(key);
    for (const child of childKeys(key)) mark(child);
  };
  for (const key of Object.keys(discussion)) {
    if (isBannedAuthor(nodeOf(key)?.author)) mark(key);
  }
  if (doomed.size === 0) return discussion;

  const kept: Record<string, T> = {};
  for (const key of Object.keys(discussion)) {
    if (doomed.has(key)) continue;
    const node = discussion[key];
    kept[key] = childKeys(key).some((child) => doomed.has(child))
      ? ({
          ...(node as object),
          replies: (nodeOf(key).replies ?? []).filter(
            (child) => typeof child !== 'string' || !doomed.has(child)
          )
        } as T)
      : node;
  }
  return kept;
}
