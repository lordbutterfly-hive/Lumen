import type { Entry } from '@hive/common-hiveio-packages/wax';

/**
 * The PURE half of the builders board: types and the shaping rule, with no
 * chain client behind them.
 *
 * ★ WHY THIS IS A SEPARATE FILE (2026-09-15, found by the first `test:unit`
 * run). `lib/builders-board.ts` imports `getAccountPostsPage` from
 * `@transaction/lib/bridge-api`, which imports `@hiveio/wax`. Under ts-node
 * that resolves to wax's ESM `exports` map and throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` at import time — so a test that imported the
 * loader module aborted the WHOLE `test:unit` run at the first failing file,
 * and every suite alphabetically after it (including the two source-scanning
 * guards) silently never ran. The rule that decides what a row is has no
 * business depending on the chain; it lives here, the loader imports it, and
 * the test imports only this.
 */

/** How many of a builder's latest posts a row can cycle through. */
export const POSTS_PER_BUILDER = 4;

/** One row of the board: a builder and the posts their row flips between. */
export interface BuilderRow {
  account: string;
  posts: BuilderPost[];
}

export interface BuilderPost {
  permlink: string;
  category: string;
  title: string;
  /** ISO-ish chain timestamp, exactly as the Bridge gives it (no `Z`). */
  created: string;
}

/**
 * The Bridge page for one builder -> the row the card renders, or null when
 * there is nothing honest to show.
 *
 * ★ ROOT POSTS ONLY. `sort: 'posts'` already asks for that, but a reblog
 * arrives with `author` set to the ORIGINAL author, and a row headed "@howo"
 * that flips to somebody else's title is a wrong row. Anything not authored
 * by the account itself is dropped here, whatever the Bridge returned.
 *
 * ★ A ROW WITH NO POSTS IS NO ROW. An empty page, a failed read, a builder
 * whose only recent activity is reblogs — all return null and the account
 * simply does not appear, the way the Meritum board drops a creator with an
 * empty shop. A rail card explains nothing about a missing row; it would
 * have to explain an empty one.
 */
export function shapeBuilderRow(
  account: string,
  entries: readonly Entry[] | null | undefined
): BuilderRow | null {
  if (!entries || entries.length === 0) return null;
  const own = account.toLowerCase();
  const posts: BuilderPost[] = [];
  for (const e of entries) {
    if ((e.author ?? '').toLowerCase() !== own) continue;
    const title = (e.title ?? '').trim();
    if (!e.permlink || !e.category || !title) continue;
    posts.push({ permlink: e.permlink, category: e.category, title, created: e.created });
    if (posts.length >= POSTS_PER_BUILDER) break;
  }
  return posts.length > 0 ? { account, posts } : null;
}
