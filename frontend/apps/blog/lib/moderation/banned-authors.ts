import type { Entry } from '@hive/common-hiveio-packages/wax';
import {
  bannedAuthorList,
  hasBannedAuthors,
  isBannedAuthor,
  withoutBannedAuthors,
  withoutBannedDiscussion
} from '@ui/config/lists/banned-authors';

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
export {
  bannedAuthorList,
  hasBannedAuthors,
  isBannedAuthor,
  withoutBannedAuthors,
  withoutBannedDiscussion
};

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
