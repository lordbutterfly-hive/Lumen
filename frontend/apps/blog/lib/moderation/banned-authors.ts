import type { Entry } from '@hive/common-hiveio-packages/wax';
import {
  bannedAuthorList,
  hasBannedAuthors,
  isBannedAuthor,
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
 * ★★★ A SQUATTED NAME IS NOT A BANNED NAME (2026-09-10, corrected the same day, after
 * an adversarial audit measured what the first version actually did).
 *
 * The first version made `isBannedAuthor` answer true for a squatted NAME. That is
 * wrong at the root, and the reason is the whole shape of this problem: the name is
 * the ONE THING the victim and the squatter share. Every bare-name consumer -- the
 * profile sub-layouts, the page titles and OG cards, the follow service -- asked "is
 * this name banned" and got back "yes" for the LITE ACCOUNT THAT WAS IMPERSONATED.
 *
 * Measured on production before this correction, against uncontested lite controls:
 *
 *   /@chadmasters/wallet  404      /@arsha/wallet     200
 *   /@chadmasters/feed    404      /@arsha/feed       200
 *   /@luxattack/wallet    404      /@menosoft/wallet  200
 *
 * The two victims lost their wallet, their friends feed, their page titles and the
 * ability to be followed; the two uncontested accounts kept everything. The feature
 * built to protect them was hurting them and nobody else.
 *
 * So `isBannedAuthor` is a NAME predicate again and answers from the env list alone.
 * On Lumen a bare name belongs to the lite account that had it first -- that is the
 * ruling `public-name.ts` already implements -- so the honest answer for a squatted
 * name is "not banned": the page under that name is the victim's.
 *
 * The squatter is hidden by `isSquatterAuthored` below, which is an ENTRY predicate,
 * because an entry is the only place the two identities are actually distinguishable.
 */
export { isBannedAuthor };

/**
 * ★★★ THE ONE PLACE THE TWO IDENTITIES ARE TELLABLE APART: WHO SIGNED IT.
 *
 * A lite account's post is broadcast by the shared publisher and carries a `_lite`
 * overlay (`lib/lite/render/attach-lite.ts`), which is forgery-resistant -- it is only
 * attached after the row's own `hiveAuthor` is checked against the entry's author. A
 * squatter's post is signed by their own Hive account and has no overlay.
 *
 * So: same name, opposite provenance. `author` matches a squatted name AND there is no
 * lite overlay means this content is the Hive account's, which is the account that took
 * the name, which is the one to hide. A lite entry under the same name is the victim's
 * and stays.
 */
export function isSquatterAuthored(entry: { author?: string | null; _lite?: unknown } | null | undefined): boolean {
  if (!entry) return false;
  if (entry._lite) return false;
  return isSquatterName(entry.author);
}

export const withoutBannedAuthors = withoutEnvBannedAuthors;

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
  // ★ NO `hasBannedAuthors()` EARLY RETURN. That asks the ENV list, which is EMPTY on
  // production -- so with it, every squatter passed through untouched no matter what
  // the squatter list said.
  return entries.filter((entry) => !isBannedEntry(entry));
}

/** True when this single entry must not be rendered at all. */
export function isBannedEntry(entry: Entry | null | undefined): boolean {
  if (!entry) return false;
  return (
    isBannedAuthor(entry.author) ||
    isBannedAuthor(entry._lite?.chainAuthor) ||
    isSquatterAuthored(entry)
  );
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

  const nodeOf = (key: string): { author?: string; replies?: unknown[]; _lite?: unknown } =>
    discussion[key] as unknown as { author?: string; replies?: unknown[]; _lite?: unknown };
  const childKeys = (key: string): string[] =>
    (nodeOf(key)?.replies ?? []).filter((child): child is string => typeof child === 'string');

  const doomed = new Set<string>();
  const mark = (key: string): void => {
    if (doomed.has(key)) return;
    doomed.add(key);
    for (const child of childKeys(key)) mark(child);
  };
  for (const key of Object.keys(discussion)) {
    const node = nodeOf(key);
    if (isBannedAuthor(node?.author) || isSquatterAuthored(node)) mark(key);
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
