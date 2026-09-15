import { getAccountPostsPage } from '@transaction/lib/bridge-api';
import { withTtlCache } from '@/blog/lib/server-ttl-cache';
import { POSTS_PER_BUILDER, shapeBuilderRow } from '@/blog/lib/builders-board-shape';
import type { BuilderRow } from '@/blog/lib/builders-board-shape';

export type { BuilderRow, BuilderPost } from '@/blog/lib/builders-board-shape';

/**
 * ★★★ THE BUILDERS BOARD — the right-rail card on HOME and TOPICS that shows
 * what the people building on Hive are publishing (owner, 2026-09-15: "the
 * card shows work done by active builders on the Hive blockchain. their
 * posts").
 *
 * Same shape as the Meritum departures board (`offerings-board.tsx`): one row
 * per builder, each row cycling through that builder's latest posts. This
 * module is the SERVER half — who the builders are and what they have posted —
 * read once, cached, and handed to the browser as plain JSON through
 * `/api/builders-board`, for exactly the reason `lib/trending-tags.ts` gives:
 * a rail widget mounted on the two busiest shells must never pull the chain
 * client into the client bundle, and must never cost every reader an upstream
 * call. The shaping rule itself is in `builders-board-shape.ts` so it can be
 * tested without a chain — see that file for why the split is load-bearing.
 *
 * ★ THE LIST IS A PLACEHOLDER UNTIL THE OWNER PICKS. These eight were chosen
 * by one measurable test, run 2026-09-15 against api.hive.blog: a builder
 * account whose most recent root post is within the last ~90 days. Accounts
 * that failed it (blocktrades 04-10, mahdiyari 04-22, techcoderx 2025-11,
 * good-karma 2024) were left out, not because they are not builders but
 * because a "what are builders doing" card that shows a two-year-old post is
 * lying about the "doing". The owner has asked to choose the final roster
 * themselves; this list exists so the card renders something real to look at
 * meanwhile. Keep it short and keep the recency test next to it.
 */
export const BUILDER_ACCOUNTS: readonly string[] = [
  'howo', // core dev meetings, 2026-09-08
  'arcange', // HBD stabiliser / infra, 2026-09-03
  'emrebeyler', // hivescan.io block explorer, 2026-08-13
  'asgarth', // PeakD, 2026-08-11
  'sagarkothari88', // HiveSuite, 2026-09-14
  'ecency', // Ecency, 2026-09-09
  'engrave', // hiveprojects / infra, 2026-07-01
  'gtg' // witness / node ops, 2026-07-18
];

const TEN_MINUTES_MS = 10 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function readBuildersBoard(): Promise<BuilderRow[]> {
  // Every builder in parallel, none allowed to take the others down: one dead
  // account (renamed, or a node hiccup on that one call) drops one row, not
  // the card. `getAccountPostsPage` already retries and fails over across
  // nodes on its own, so nothing is wrapped here.
  const settled = await Promise.allSettled(
    BUILDER_ACCOUNTS.map((account) => getAccountPostsPage('posts', account, '', '', '', POSTS_PER_BUILDER * 2))
  );
  const rows: BuilderRow[] = [];
  settled.forEach((result, i) => {
    if (result.status !== 'fulfilled') return;
    const row = shapeBuilderRow(BUILDER_ACCOUNTS[i], result.value?.entries);
    if (row) rows.push(row);
  });
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
