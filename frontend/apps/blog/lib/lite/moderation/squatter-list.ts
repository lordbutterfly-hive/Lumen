import { getLogger } from '@ui/lib/logging';
import * as users from '../repositories/user-repository';
import { liteConfig } from '../config';

const logger = getLogger('app');

/** How long a loaded list is trusted. Squatters appear at human speed, not machine speed. */
const TTL_MS = 5 * 60_000;

export interface SquatterRecord {
  name: string;
  creator: string | null;
  hiveCreated: Date;
  liteCreated: Date;
}

let cache = new Map<string, SquatterRecord>();
let loadedAt = 0;
let inFlight: Promise<void> | null = null;

/**
 * ★★★ THE SQUATTER BAN LIST (2026-09-10, owner: "if created after lite account,
 * banned from feeds, comments, hidden from everyone, flags a warning").
 *
 * `@ui/config/lists/banned-authors` is the GLOBAL list and it is env-driven, which is
 * right for a name a human decided to ban: it is legible in the browser as well as on
 * the server, and adding one is a config change plus a restart. This list is the other
 * kind -- names the product itself identifies, continuously, from evidence -- so it
 * cannot live in an env var. It is derived from the lite database instead.
 *
 * ★ THE PREDICATE STAYS SYNCHRONOUS. Every consumer of `isBannedAuthor` is a filter
 * running over feed pages, comment trees and voter lists, and several are synchronous
 * by construction. So the list is held in memory and refreshed on a TTL in the
 * background; a call never waits on Postgres and never fails because Postgres is down.
 * A stale list is the safe direction here -- it means a newly-detected squatter stays
 * visible for at most five minutes, never that an innocent account is hidden.
 *
 * ★ SERVER ONLY, STATED PLAINLY. This hides a squatter from everything Lumen renders.
 * It does NOT reach the handful of surfaces that call a Hive node directly from the
 * browser (notifications, the voters popover, reblogged-by, follower pagination) --
 * `banned-authors.ts` documents that same split for the env list, and closing it needs
 * the names to reach the client, which is a separate piece of work.
 */
export function primeSquatterList(): void {
  void loadSquatterList();
}

/**
 * ★★★ THE SYNC PREDICATE ANSWERS "NO" ON A COLD CACHE, SO ANYTHING THAT MUST BE
 * RIGHT THE FIRST TIME AWAITS THIS (2026-09-10, caught in local verification before
 * ship: `/@daveks` still served the squatter's Hive account because the layout asked
 * `isSquatterName` on a freshly-booted worker, the load had only just been kicked
 * off, and an empty cache says "not a squatter").
 *
 * For a feed filter that window is harmless -- one page renders with a squatter still
 * in it, the next does not. For the PROFILE ROUTE it is not: that call decides whose
 * account the URL belongs to, and getting it wrong hands the victim's page back to
 * the attacker for as long as the worker takes to warm. So the profile route awaits,
 * and the filters keep the cheap synchronous read.
 */
export async function ensureSquatterList(): Promise<void> {
  await loadSquatterList();
}

function loadSquatterList(): Promise<void> {
  if (inFlight) return inFlight;
  if (loadedAt > 0 && Date.now() - loadedAt < TTL_MS) return Promise.resolve();
  inFlight = users
    .listSquattedNames(liteConfig.accountCreatorAccount || '')
    .then((rows) => {
      const next = new Map<string, SquatterRecord>();
      for (const row of rows) next.set(row.name, row);
      cache = next;
      loadedAt = Date.now();
      if (next.size > 0) {
        logger.warn('squatter ban list: %d name(s) hidden: %s', next.size, [...next.keys()].join(', '));
      }
    })
    .catch((error) => {
      // Keep whatever we had. An empty list because the datastore blinked would
      // un-hide every squatter at once, which is worse than serving a stale one.
      logger.warn(error, 'squatter ban list: refresh failed, keeping the previous list');
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Is this Hive account name a detected squatter? Synchronous by design; see above. */
export function isSquatterName(name: string | null | undefined): boolean {
  if (!name) return false;
  primeSquatterList();
  return cache.has(name.trim().replace(/^@/, '').toLowerCase());
}

/** The evidence behind a ban, for the notice shown on that account's page. */
export function squatterRecord(name: string | null | undefined): SquatterRecord | null {
  if (!name) return null;
  primeSquatterList();
  return cache.get(name.trim().replace(/^@/, '').toLowerCase()) ?? null;
}

/** Test/ops hook: force the next read to reload. */
export function resetSquatterList(): void {
  cache = new Map();
  loadedAt = 0;
}
