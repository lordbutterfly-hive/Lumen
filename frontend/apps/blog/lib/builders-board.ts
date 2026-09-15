import { getAccountPostsPage } from '@transaction/lib/bridge-api';
import { withTtlCache } from '@/blog/lib/server-ttl-cache';
import { shapeBuilderRow, mapBounded } from '@/blog/lib/builders-board-shape';
import type { BuilderRow } from '@/blog/lib/builders-board-shape';
import { BUILDERS } from '@/blog/lib/builders-roster';

export type { Builder, BuilderRow, BuilderPost } from '@/blog/lib/builders-board-shape';
export { BUILDERS } from '@/blog/lib/builders-roster';

/**
 * ★★★ HIVE BUILDERS — the right-rail card on HOME and TOPICS that tracks
 * development on Hive: what the people building it are shipping (owner,
 * 2026-09-15).
 *
 * Same shape as the Meritum departures board (`offerings-board.tsx`): one row
 * per builder, each row cycling through that builder's last three development
 * posts, one flip per half-minute. This module is the SERVER half — reading
 * what each builder has posted, cached, and handed to the browser as plain
 * JSON through `/api/builders-board`, for exactly the reason
 * `lib/trending-tags.ts` gives: a rail widget mounted on the two busiest
 * shells must never pull the chain client into the client bundle, and must
 * never cost every reader an upstream call. WHO the builders are is
 * `builders-roster.ts`; WHICH posts count is `builders-board-shape.ts`; both
 * are chain-free and unit-tested against real posts.
 */
/**
 * How many root posts to read per builder. A `dev`-mode person may have three
 * development posts spread across twenty ordinary ones, so the page has to be
 * deep enough to find them; twenty is what the Bridge hands back for
 * `sort: 'posts'` in one call, measured on every account above.
 */
const POSTS_TO_READ = 20;

/** Builders read at once. See `mapBounded`: the whole roster in one burst took a third of the worker's Hive socket pool. */
const READ_CONCURRENCY = 4;

const TEN_MINUTES_MS = 10 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function readBuildersBoard(): Promise<BuilderRow[]> {
  // A few builders at a time, none allowed to take the others down: one dead
  // account (renamed, or a node hiccup on that one call) drops one row, not
  // the card. `getAccountPostsPage` already retries and fails over across
  // nodes on its own, so nothing is wrapped here.
  const settled = await mapBounded(BUILDERS, READ_CONCURRENCY, (b) =>
    getAccountPostsPage('posts', b.account, '', '', '', POSTS_TO_READ)
  );
  const rows: BuilderRow[] = [];
  settled.forEach((result, i) => {
    if (result.status !== 'fulfilled') return;
    const row = shapeBuilderRow(BUILDERS[i], result.value?.entries);
    if (row) rows.push(row);
  });
  // Most recent development post first, so the top of the list is what is
  // being shipped NOW and the older rows are the ones a reader scrolls to.
  rows.sort((a, b) => (b.posts[0]?.created ?? '').localeCompare(a.posts[0]?.created ?? ''));
  return rows;
}

/**
 * ★ CACHED HARD, SERVED STALE, NEVER EMPTY. Same three decisions as
 * `getTrendingTagsCached`, for the same reasons: the board is global and
 * carries nothing personalised, so a long TTL costs no correctness; a slow or
 * rate-limited node keeps the last good board on screen while a refresh runs
 * behind the reader; and an empty answer is refused, because a 200 with no
 * rows would render as "no builders" and be cached as such for the TTL.
 *
 * ★ NAMED, and the name is unique in the tree — both checked by
 * `withttlcache-name-guard.test.ts` on every `test:unit` run.
 */
export const getBuildersBoardCached = withTtlCache((): Promise<BuilderRow[]> => readBuildersBoard(), () => 'builders-board', {
  name: 'builders-board',
  ttlMs: TEN_MINUTES_MS,
  staleWhileRevalidateMs: ONE_DAY_MS,
  max: 1,
  shouldCache: (rows) => Array.isArray(rows) && rows.length > 0
});
