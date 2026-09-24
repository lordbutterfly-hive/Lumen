import type { Entry } from '@hive/common-hiveio-packages/wax';
import { containerFamilyOf } from '@/blog/lib/lite/container-family';

/**
 * ROLLING CONTAINER POSTS, and why they must never reach an algorithmic feed.
 *
 * `peak.snaps`, `ecency.waves` and `leothreads` are not people. They are the
 * publishing endpoints three frontends use to open a new short-form thread, on
 * a schedule, forever. The post itself is an empty shell; its whole body is
 * other people's replies filed underneath it. It is the same mechanism Lumen
 * uses for `lumen-c-<ulid>`.
 *
 * They accumulate hundreds of commenters because that is their JOB, so on any
 * engagement-ranked surface they win by construction, and the reader gets a
 * shell whose comments are strangers' snaps.
 *
 * ★★★ WHY THIS EXISTS SEPARATELY FROM recsys (2026-09-13, owner: "these
 * container posts should not be worked around ever").
 *
 * The ranker already drops them at the gate, in `filter_eligible`, before any
 * lane or quota (recsys/core/second_degree.py). But `/api/feed/for-you` FALLS
 * BACK to Hive's own ranked feed whenever recsys is unreachable, unconfigured
 * or slow - and that path never saw the rule, because the rule lived in the
 * service that was unavailable. A filter that only runs when the thing it
 * protects is healthy is not a filter.
 *
 * MEASURED on the live chain, 2026-09-13, while writing this:
 *
 *     bridge.get_ranked_posts trending  #1  ecency.waves/waves-20260913vb5x2z
 *     bridge.get_ranked_posts hot       #7  peak.snaps/snap-container-1789288560
 *
 * So on that day, with recsys down, the top slot of the anonymous home page was
 * an empty container. Not hypothetical - that was the state of the chain.
 *
 * ★ MATCHED ON AUTHOR ALONE, deliberately. recsys keeps a second, narrower rule
 * (`PopularConfig.container_markers`) that needs author AND permlink prefix,
 * for accounts that might one day publish something real. These three do not:
 * paginated `bridge.get_account_posts` over their root posts on 2026-09-13 gave
 * 240 posts each, back to 2025-12-16 / 2026-03-24 / 2026-02-28, with ZERO
 * non-container posts between them. A prefix is a third party's implementation
 * detail and can be renamed without telling anyone; the account cannot.
 *
 * ★ WHAT THIS DELIBERATELY DOES NOT TOUCH:
 *   - THE PROFILE. `/@ecency.waves` still lists their posts. A profile is a
 *     destination somebody asked for by name, not something a ranker chose for
 *     them, and an empty profile is a lie about the chain.
 *   - THE POST PAGE. A direct link to a container still renders. Hiding it
 *     would 404 a real Hive post that somebody was sent.
 *   - THE REPLIES INSIDE. Third-party container children are never sourced into
 *     our feeds in the first place (only `parent_author === ''` roots and our
 *     own lite posts are), and our own lite posts live under `lumen-c-…` roots -
 *     so "hide anything in a container" taken literally would delete the entire
 *     lite product. The rule is about the SHELL, never its contents.
 *
 * ★ KEEP IN STEP WITH recsys/recsys/config.py `PopularConfig.container_accounts`.
 * Two lists exist because this one has to work when recsys does not, which rules
 * out reading it from the service. `container-posts.selftest.ts` asserts the two
 * files agree, so the drift is caught here rather than on a feed.
 */
export const CONTAINER_ACCOUNTS: ReadonlySet<string> = new Set([
  'peak.snaps',
  'ecency.waves',
  'leothreads'
]);

/**
 * True when this entry is a container SHELL.
 *
 * `_lite.chainAuthor` is checked for the same reason `isBannedEntry` checks it:
 * a surface that relabels entries could otherwise carry the real signer in the
 * overlay while `author` reads as something else.
 */
export function isContainerEntry(entry: Entry | null | undefined): boolean {
  if (!entry) return false;
  const author = (entry.author || '').toLowerCase();
  const chainAuthor = (entry._lite?.chainAuthor || '').toLowerCase();
  if (CONTAINER_ACCOUNTS.has(author) || CONTAINER_ACCOUNTS.has(chainAuthor)) return true;
  /*
   * ★ LUMEN'S OWN SHELLS TOO (2026-09-24, quote reblog spec v2 6.2). Our publishing
   * account cannot go on the author list (every lite post is signed by it), so Lumen's
   * container ROOTS are matched by what they are instead: a root post (no parent) whose
   * permlink is a container permlink of either family, `lumen-c-` (Lumen posts) or
   * `lumen-q-` (reblog comments). A lite post is `lumen-<ulid>` and a reply is never a
   * root, so the contents are never touched, only the shell, the same rule as above.
   */
  return !entry.parent_author && containerFamilyOf(entry.permlink) !== null;
}

/** Drop container shells from a feed page. Order and identity of the rest are untouched. */
export function filterContainerEntries<T extends Entry>(entries: T[] | null | undefined): T[] {
  if (!entries || entries.length === 0) return entries ?? [];
  return entries.filter((entry) => !isContainerEntry(entry));
}
