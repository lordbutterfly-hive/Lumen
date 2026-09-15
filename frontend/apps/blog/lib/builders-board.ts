import { getAccountPostsPage } from '@transaction/lib/bridge-api';
import { withTtlCache } from '@/blog/lib/server-ttl-cache';
import { shapeBuilderRow } from '@/blog/lib/builders-board-shape';
import type { Builder, BuilderRow } from '@/blog/lib/builders-board-shape';

export type { Builder, BuilderRow, BuilderPost } from '@/blog/lib/builders-board-shape';

/**
 * ★★★ HIVE BUILDERS — the right-rail card on HOME and TOPICS that tracks
 * development on Hive: what the people building it are shipping (owner,
 * 2026-09-15).
 *
 * Same shape as the Meritum departures board (`offerings-board.tsx`): one row
 * per builder, each row cycling through that builder's last three development
 * posts, one flip per half-minute. This module is the SERVER half — who the
 * builders are and what they have posted — read once, cached, and handed to
 * the browser as plain JSON through `/api/builders-board`, for exactly the
 * reason `lib/trending-tags.ts` gives: a rail widget mounted on the two
 * busiest shells must never pull the chain client into the client bundle, and
 * must never cost every reader an upstream call. The rule that decides which
 * posts count is in `builders-board-shape.ts`, chain-free and unit-tested.
 *
 * ★ HOW THE ROSTER WAS BUILT (2026-09-15). The top 100 witnesses by vote plus
 * every dapp/product account I could name were pulled — 126 accounts, their
 * last 20 root posts each, with tags — and scored against the development
 * vocabulary. The score was a SCREEN, not the answer: the first pass read
 * "100% development" for tribe and curation accounts because `witness`,
 * `update` and an account's own name as a tag all matched. So the vocabulary
 * was tightened to words that name the act of building, and each row below
 * was then read by hand. Owner's exclusions: asgarth, good-karma, ecency,
 * peakd. Owner's additions: lordbutterfly, acidyo, holozing, and Scrobble —
 * which lives on @acidyo's posts tagged `scrobble` (`@scrobble` is a curation
 * compilation account and `@scrobble.life` has no root posts).
 *
 * Two modes, per `Builder` in the shape module: `all` for a product account
 * whose every post is the product shipping, `dev` for a person whose feed
 * mixes building with life, where only posts carrying the shared vocabulary or
 * that builder's own product tags are shown. Real builders whose last
 * development post is more than ~6 months old are left off (deathwing 02-07,
 * disregardfiat 02-27, v4vapp 02-09, vsc.network 2025-11, techcoderx 2025-11,
 * stoodkev 2024-10 — Keychain is carried by @keychain instead): a card titled
 * "Hive builders" that shows a year-old post is claiming something it cannot
 * back. Dropped after replaying real posts through the filter (2026-09-15):
 * quochuy (witness EARNINGS reports, not building), splinterlands (sticker
 * shop, a memorial card) and risingstargame (a birthday post). Keep the
 * reason next to any entry you add or remove.
 */
export const BUILDERS: readonly Builder[] = [
  // ── people ──────────────────────────────────────────────────────────────
  { account: 'lordbutterfly', mode: 'dev', tags: ['lumen', 'magi', 'hivewatch', 'freechain'] }, // Lumen, Magi, Hive Watch, Freechain. Not `frontend`: a rant carried it too
  { account: 'howo', mode: 'dev', tags: ['core', 'gopherd'] }, // core dev meetings, 2026-09-08
  { account: 'sagarkothari88', mode: 'dev', tags: ['hivesuite'] }, // HiveSuite, 2026-09-14
  { account: 'acidyo', mode: 'dev', tags: ['scrobble', 'holozing'] }, // Scrobble.life + Holozing MMO, 2026-09-12
  { account: 'emrebeyler', mode: 'dev', tags: ['hivescan', 'lighthive'] }, // hivescan.io, lighthive, 2026-08-13
  { account: 'gtg', mode: 'dev' }, // node ops / witness updates, 2026-07-18
  { account: 'engrave', mode: 'dev' }, // hiveprojects, witness updates, 2026-07-01
  { account: 'brianoflondon', mode: 'dev', tags: ['v4vapp', 'podping'] }, // V4V.app, Podping, 2026-08-16
  { account: 'imwatsi', mode: 'dev', tags: ['freebeings-dao', 'freebeings'] }, // HAF plug-and-play, FreeBeings, 2026-06-30
  { account: 'mahdiyari', mode: 'dev' }, // HafSQL, HAF, 2026-04-22
  { account: 'blocktrades', mode: 'dev' }, // HAF API stack, 2026-04-10
  // ── products (every post is the product shipping) ───────────────────────
  { account: 'snapie', mode: 'all' }, // 2026-08-31
  { account: 'thebeedevs', mode: 'all' }, // clive / wallet / cli, 2026-09-02
  { account: 'keychain', mode: 'all' }, // 2026-08-26
  { account: 'threespeak', mode: 'all' }, // 2026-09-13
  { account: 'actifit', mode: 'all' }, // 2026-08-21
  { account: 'terracore', mode: 'all' }, // 2026-08-08
  { account: 'hive-engine', mode: 'all' }, // 2026-07-14
  { account: 'liketu', mode: 'all' }, // 2026-07-12
  { account: 'holozing', mode: 'all' }, // 2026-08-14
  { account: 'hive.pizza', mode: 'dev', tags: ['moon', 'pizza', 'hivepizza'] } // MOON dev log, 2026-05-22
];

/**
 * How many root posts to read per builder. A `dev`-mode person may have three
 * development posts spread across twenty ordinary ones, so the page has to be
 * deep enough to find them; twenty is what the Bridge hands back for
 * `sort: 'posts'` in one call, measured on every account above.
 */
const POSTS_TO_READ = 20;

const TEN_MINUTES_MS = 10 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function readBuildersBoard(): Promise<BuilderRow[]> {
  // Every builder in parallel, none allowed to take the others down: one dead
  // account (renamed, or a node hiccup on that one call) drops one row, not
  // the card. `getAccountPostsPage` already retries and fails over across
  // nodes on its own, so nothing is wrapped here.
  const settled = await Promise.allSettled(
    BUILDERS.map((b) => getAccountPostsPage('posts', b.account, '', '', '', POSTS_TO_READ))
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
