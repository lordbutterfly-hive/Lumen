import env from '@beam-australia/react-env';

/**
 * GLOBAL AUTHOR BAN LIST — chain accounts Lumen refuses to render, anywhere.
 *
 * ★ THIS IS THE ONLY LIST. One list, one predicate, imported everywhere. If you
 * are about to write `author === 'someone'` anywhere in this codebase, stop and
 * add the name to the config instead.
 *
 * WHY IT IS NOT THE LITE MODERATION PATH. `lumen_moderation_action` bans a LITE
 * user by `user_id` — a row in our own database, for an account Lumen created and
 * therefore owns. A full Hive account is neither: it exists on a public
 * blockchain, we did not issue it, we cannot delete it, and no amount of
 * database moderation touches it. Every surface that reads from Hivemind —
 * feeds, comment trees, profiles, search, voter lists, follower lists,
 * notifications — will serve that account's content verbatim forever. The only
 * thing Lumen controls is what Lumen RENDERS, so the ban has to live at the
 * point where chain data enters the product, which is exactly where this
 * predicate is applied.
 *
 * WHERE THE NAMES COME FROM — two variables, both optional, unioned:
 *
 *   REACT_APP_BANNED_AUTHORS   read through react-env, so it is legible on the
 *                              SERVER *and* in the browser. This is the one to
 *                              use. It matters that the browser can see it:
 *                              several surfaces (notifications, the voters
 *                              popover, reblogged-by, follower pagination) call
 *                              a public Hive node DIRECTLY from the client, and
 *                              our server is not in that request path at all.
 *                              Without a value here those calls come back
 *                              unfiltered.
 *
 *   LUMEN_BANNED_AUTHORS       plain server-side env, mirroring how the LITE_*
 *                              vars are read in `apps/blog/lib/lite/config.ts`.
 *                              Never reaches the browser. Use it only if the
 *                              list itself must stay private — and understand
 *                              that a name listed ONLY here is stripped from
 *                              everything Lumen server-renders but not from the
 *                              browser's own direct-to-chain calls.
 *
 * Both accept the same shape: names separated by commas, whitespace or
 * semicolons, with or without a leading `@`, in any case.
 *
 *     REACT_APP_BANNED_AUTHORS=kgakakillerg
 *     REACT_APP_BANNED_AUTHORS=kgakakillerg, @spammer2 troll3
 *
 * Adding the next troll is a one-line config change and a restart. No code edit,
 * no rebuild — react-env regenerates `/__ENV.js` from the environment on boot.
 */

/** Hive account names are lower-case; normalise so `@Troll` and `troll` are one name. */
function normalise(name: string): string {
  return name.trim().toLowerCase().replace(/^@+/, '');
}

function parseList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw.split(/[\s,;]+/).map(normalise).filter(Boolean);
}

/**
 * Resolved LAZILY and then memoised, deliberately.
 *
 * On the client `env()` reads `window.__ENV`, which is installed by a script tag
 * `/__ENV.js`. Reading it at module-evaluation time is a race — a module that
 * happens to evaluate first would memoise an EMPTY ban list for the life of the
 * page, and the ban would silently not apply. Resolving on first use puts the
 * read after hydration, where the value is always there.
 */
let cached: Set<string> | null = null;

function bannedSet(): Set<string> {
  if (cached) return cached;
  const fromPublic = parseList(env('BANNED_AUTHORS'));
  // Guarded so bundlers that inline `process.env` in browser builds cannot throw.
  const fromServer =
    typeof process !== 'undefined' && process.env ? parseList(process.env.LUMEN_BANNED_AUTHORS) : [];
  cached = new Set([...fromPublic, ...fromServer]);
  return cached;
}

/** Test seam only — lets a test change the environment and re-read it. */
export function resetBannedAuthorsCache(): void {
  cached = null;
}

/** The resolved list, for diagnostics and logging. Never used to make decisions. */
export function bannedAuthorList(): string[] {
  return [...bannedSet()].sort();
}

/** True when at least one name is configured — lets hot paths skip work entirely. */
export function hasBannedAuthors(): boolean {
  return bannedSet().size > 0;
}

/**
 * THE PREDICATE. Everything else in this file, and every caller in the app, is
 * built on this one function.
 */
export function isBannedAuthor(name: string | null | undefined): boolean {
  if (!name) return false;
  const set = bannedSet();
  if (set.size === 0) return false;
  return set.has(normalise(name));
}

/**
 * Drop every row whose identity field names a banned account.
 *
 * `pick` says where the name lives, because it is called `author` on a post,
 * `voter` on a vote, `follower` on a follow edge and `name` on an account — one
 * filter, four shapes. Returns the input array untouched when nothing is banned,
 * so the common case allocates nothing.
 */
export function withoutBannedAuthors<T>(
  rows: T[] | null | undefined,
  pick: (row: T) => string | null | undefined
): T[] {
  if (!rows || rows.length === 0) return rows ?? [];
  if (!hasBannedAuthors()) return rows;
  return rows.filter((row) => !isBannedAuthor(pick(row)));
}

/**
 * Same, for the `{ "author/permlink": Entry }` map `bridge.get_discussion`
 * returns — a comment tree, not a list.
 *
 * ★ REPLIES ARE PRUNED WITH THEIR PARENT. Every node carries a `replies` array
 * of child keys, and the renderer walks it. Deleting a banned node while leaving
 * its key in some other node's `replies` would leave a dangling reference in the
 * tree the browser receives; worse, a reply written by ANYONE under a banned
 * comment would be orphaned and could be re-parented by the client's flattening
 * pass, which would surface the banned thread's context anyway. So the whole
 * subtree beneath a banned comment goes with it.
 */
export function withoutBannedDiscussion<T>(
  discussion: Record<string, T> | null | undefined
): Record<string, T> | null | undefined {
  if (!discussion || !hasBannedAuthors()) return discussion;

  // Read the two fields structurally. The chain type declares `replies` as
  // `Array<unknown>`; in a `get_discussion` map its members are the string keys
  // of this same map, which is what the walk below relies on.
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
    // Rewrite the surviving parent's child list so it cannot point at a node
    // that is no longer in the map.
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
