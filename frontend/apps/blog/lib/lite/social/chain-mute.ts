import { getFollowList } from '@transaction/lib/bridge-api';
import { getLogger } from '@ui/lib/logging';
import * as users from '../repositories/user-repository';
import { FollowActor } from './follow-actor';

const logger = getLogger('app');

/**
 * ★★★ THE DATA HALF OF "MUTE AND BLOCK ARE THE SAME THING" (owner ruling, 2026-08-12).
 *
 * `block-service.ts` and `block-filter.ts` already implement Lumen's Block, in full,
 * for both of its effects. What they never read is the chain: a PeakD/Ecency `ignore`
 * (Hive's "mute", `bridge.get_follow_list(name, 'muted')`) sat there unread, so muting
 * somebody on any OTHER Hive front end did nothing on Lumen. This file is the one place
 * that reads it, so every consumer — the viewer's own feed filter, the client-side
 * surfaces, and the owner-side thread filter — asks the SAME question the SAME way.
 *
 * ★ NOT `follow_type: 'ignore'`. `FollowListType` (wax) is
 * `'follow_blacklist' | 'follow_muted' | 'blacklisted' | 'muted'` — `'ignore'` is the
 * name of the underlying `follow` custom_json's `what` array, not a bridge API
 * parameter. Confirmed live against api.hive.blog for `lordbutterfly`:
 * `follow_type: 'muted'` -> 22 rows (the fixture this feature is proven against);
 * `follow_type: 'blacklisted'` -> 3; `follow_blacklist`/`follow_muted` (Hive's
 * "subscribe to someone else's list" feature) -> 0 for both, and Lumen never built a
 * UI for that feature at all (see the `/lists/*` routes' redirect).
 *
 * ★ SCOPE: `'muted'` (the ignore list) ONLY, not `'blacklisted'`. The owner's ruling
 * and every example in the brief are about mute; blacklist is a separate on-chain
 * mechanism Hivemind already renders through its own `observer`-keyed
 * `Entry.blacklists` field wherever a bridge call passes one (see
 * `lib/moderation/blacklist-reason.ts`), independent of this feature and independent
 * of effect (B) — Hivemind's blacklist collapse is per-VIEWER, it has no notion of
 * "hide this from every reader", so folding it into effect (B) here would be a claim
 * this file cannot back up. Merging it would mean either enforcing a mechanism nobody
 * asked to extend, or showing an entry as "blocked" in the merged list that this
 * filter does not actually act on — both worse than leaving it out. Noted as a
 * deliberate boundary, not an oversight.
 *
 * ★★★ CACHING — REUSING THE TWO EXISTING PRECEDENTS RATHER THAN A THIRD SHAPE.
 *
 * Effect (B) puts this on the hot path of every comment thread (one lookup per POST
 * OWNER, not per commenter — see `ownerChainMutedNamesOrThrow`'s doc for why the reach
 * is deliberately narrower than a Lumen block's). An uncached call here would add a
 * live `bridge.get_follow_list` round trip to every thread load, for a value that
 * changes about as often as `/api/trending-tags`' topic list — a reader muting someone
 * on PeakD is not a moment-to-moment event.
 *
 * So: a bounded, per-owner, in-memory Map (`feed-cache.ts`'s shape — TTL freshness,
 * LRU-ish eviction, single-flight for a COLD name) plus `/api/trending-tags`'
 * stale-while-revalidate posture (an owner already resolved once is served instantly
 * from cache forever after, refreshed in the background, never re-blocked on a live
 * call). No durable (Postgres) tier: unlike the assembled ranked feed this replaces
 * cheaply from the source of truth (one more chain call) after a restart, so paying
 * for cross-process persistence here would be complexity with no real payoff.
 *
 * ★★★ FAIL-CLOSED VS FAIL-OPEN — THE SAME ASYMMETRY `block-actor.ts`'s
 * `ActorLookupFailurePolicy` ALREADY DOCUMENTS, extended to this data source instead
 * of invented fresh:
 *
 *   effect (B) — `ownerChainMutedNamesOrThrow`. "Their replies under my content are
 *   served to nobody" is a promise a reader cannot opt out of, so an owner whose chain
 *   mute list has NEVER been resolved and cannot be resolved right now must not be
 *   treated as "mutes nobody" — that is effect (B) failing OPEN. Throws, and every
 *   caller in `block-filter.ts` already fails a thread ampty rather than unfiltered
 *   when ITS OWN Lumen-block resolution throws; this reuses that exact posture instead
 *   of inventing a second one.
 *
 *   effect (A) — `chainMutedKeysOfActor`. The viewer's own "I never see them"
 *   preference. Failing closed here would blank a reader's whole feed over a chain
 *   node hiccup, which `use-lumen-block.ts` and `/api/lite/block/list` already reason
 *   is the larger harm for this half. Degrades to "no chain mutes known right now" and
 *   logs, exactly like every other effect-(A) read in this codebase.
 *
 * Once ANY fetch for a given owner has ever succeeded, `chainMutedNamesOf` never
 * returns the "unknown" signal for them again — a later outage serves the stale copy,
 * same as trending tags. `null` is reserved for a name that has NEVER been resolved.
 */

interface CacheEntry {
  names: Set<string>;
  at: number;
}

/** Under this age, served with no chain call at all. Over it, STILL served
 *  instantly — a background refresh is started, never awaited by the request that
 *  triggered it. Ten minutes: generous, because a mute list is not a fast-moving
 *  value, and short enough that a fresh mute takes effect well within a session. */
const FRESH_MS = 10 * 60_000;

/** Bounded the same way `feed-cache.ts`'s viewer map is: oldest-inserted evicted
 *  first, so a crawler walking many distinct post authors cannot grow this map
 *  without limit. Map preserves insertion order, so `.keys().next()` is the oldest. */
const MAX_OWNERS = 5_000;

const cache = new Map<string, CacheEntry>();
/** One fetch in flight per name — a COLD name with many concurrent readers (a
 *  popular thread's first request of the process) must pay the chain call once,
 *  not once per concurrent reader. Also used to de-dupe a stale name's background
 *  refresh so a burst of requests does not start ten of them. */
const inflight = new Map<string, Promise<Set<string> | null>>();

function cachePut(name: string, names: Set<string>): void {
  if (!cache.has(name) && cache.size >= MAX_OWNERS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(name, { names, at: Date.now() });
}

async function fetchChainMuted(name: string): Promise<Set<string> | null> {
  try {
    const list = await getFollowList(name, 'muted');
    const names = new Set((list ?? []).map((row) => row.name.toLowerCase()));
    cachePut(name, names);
    return names;
  } catch (error) {
    logger.warn('chain-mute: bridge.get_follow_list(%s, muted) failed: %o', name, error);
    return null;
  }
}

/**
 * One Hive account's own chain mute (`ignore`) list, lower-cased account names.
 *
 * `null` ONLY when `hiveAccountName` has never been resolved before AND the live
 * fetch made to answer THIS call failed — see the file header for why every caller
 * must treat that, and only that, as "unknown" rather than "mutes nobody".
 */
export async function chainMutedNamesOf(hiveAccountName: string): Promise<Set<string> | null> {
  const name = hiveAccountName.trim().toLowerCase().replace(/^@/, '');
  if (!name) return new Set();

  const cached = cache.get(name);
  if (cached) {
    if (Date.now() - cached.at >= FRESH_MS && !inflight.has(name)) {
      const refresh = fetchChainMuted(name).finally(() => inflight.delete(name));
      inflight.set(name, refresh);
      // Nobody awaits this branch; only the failure needs a handled branch so it
      // does not surface as an unhandled rejection in the process.
      void refresh.catch(() => undefined);
    }
    // Served from cache even if a refresh was just kicked off above — the reader
    // in front of THIS request never waits on it. Same "anything stored is served
    // immediately, fixed behind the reader" rule `feed-cache.ts` documents.
    return cached.names;
  }

  const existing = inflight.get(name);
  if (existing) return existing;
  const fetchPromise = fetchChainMuted(name).finally(() => inflight.delete(name));
  inflight.set(name, fetchPromise);
  return fetchPromise;
}

/**
 * The Hive account name behind an actor, if it has one at all.
 *
 * A pure lite account (never linked to a real Hive account) returns `null` here,
 * and every caller reads that as "chain mutes do not apply to this person" — not as
 * a failure. That is correct and was confirmed by the owner directly: "Lite accounts
 * do not have Hive mutes. They only have Lumen blocks. That is fine and expected."
 * `hive` logins and upgraded Lumen users both resolve to a real name; a database
 * error resolving an upgraded user's row propagates (no catch here) so effect (B)'s
 * caller can fail closed on it exactly like every other lookup on that path.
 */
export async function hiveNameOfActor(actor: FollowActor): Promise<string | null> {
  if (actor.userId) {
    const row = await users.findUserById(actor.userId);
    return row?.hiveAccountName?.toLowerCase() ?? null;
  }
  return actor.hive ? actor.hive.toLowerCase() : null;
}

/** Batched `userId -> hiveAccountName` (lower-cased), for resolving a whole page of
 *  `_lite`-authored entries against a chain mute list in one query instead of one
 *  lookup per entry. Users with no linked Hive account are simply absent from the
 *  returned map — the caller reads that as "this author cannot be chain-muted". */
export async function hiveNamesByUserId(userIds: string[]): Promise<Map<string, string>> {
  const distinct = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (distinct.length === 0) return new Map();
  const rows = await users.findUsersByIds(distinct);
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.hiveAccountName) map.set(row.userId, row.hiveAccountName.toLowerCase());
  }
  return map;
}

/**
 * ★ EFFECT (B) — the POST OWNER's chain mute reach, for one thread/parent.
 *
 * `owner: null` means this content has no Lumen-known owner to speak for it (see
 * `resolvePostOwnerActor`'s "shared publishing account is not an owner" note) — that
 * is a real, non-failure answer, and returns an empty set rather than throwing.
 *
 * ★★★ ROOT-OWNER-ONLY, DELIBERATELY — READ THIS BEFORE "FIXING" IT. A Lumen block's
 * effect (B) walks EVERY ancestor in a thread (`applyOwnerBlocksToThread`'s
 * ancestor walk): any comment's author can be a blocker of a reply under THEM, not
 * just the root post's author. This function does not do that. It is called once per
 * thread (or once per distinct parent, in the one-hop authored-entries filter) against
 * the OWNER ALREADY IN HAND, and extending it to every ancestor would mean one
 * `bridge.get_follow_list` per COMMENTER in a thread rather than one per POST — an
 * unbounded, uncached-until-first-hit fan-out on the hottest read in the product. The
 * brief scopes this the same way: "a POST OWNER's chain mutes... needs the post
 * owner's mute list... a chain call per post owner". The residual gap this leaves is
 * the same SHAPE as `applyOwnerBlocksToAuthoredEntries`'s documented one-hop gap: a
 * reply nested under an intermediate COMMENTER's own PeakD mutes (as opposed to the
 * root post author's) is not hidden by this function. A Lumen block against that same
 * pairing still works, because that walk is already paid for by the thread page it
 * runs on regardless.
 *
 * Throws (fail closed, effect B's posture) only when this owner's chain identity is
 * genuinely unknown right now — never when they simply have none.
 */
export async function ownerChainMutedNamesOrThrow(owner: FollowActor | null): Promise<Set<string>> {
  if (!owner) return new Set();
  const hiveName = await hiveNameOfActor(owner);
  if (!hiveName) return new Set();
  const names = await chainMutedNamesOf(hiveName);
  if (names === null) {
    throw new Error(`chain mute list for @${hiveName} could not be resolved and was never cached`);
  }
  return names;
}

/**
 * ★ EFFECT (A) — the VIEWER's own chain mutes, as block-filter node keys.
 *
 * Mirrors `block-repository.listBlockedKeysOf`'s output shape (`u:`/`h:` keys) so a
 * caller can union the two sets and hand the result to `filterBlockedForViewer`
 * unchanged. `names` is returned alongside for callers (the client-facing block list)
 * that match on the plain lower-cased author string instead of a prefixed key.
 *
 * Degrades to `{ keys: [], names: [] }` on any failure — see the file header for why
 * this half fails OPEN rather than closed, unlike `ownerChainMutedNamesOrThrow`.
 */
export async function chainMutedKeysOfActor(
  actor: FollowActor
): Promise<{ keys: string[]; names: string[] }> {
  try {
    const hiveName = await hiveNameOfActor(actor);
    if (!hiveName) return { keys: [], names: [] };
    const muted = await chainMutedNamesOf(hiveName);
    if (!muted || muted.size === 0) return { keys: [], names: [] };

    // An upgraded Lumen user among the muted names should also match on their
    // `u:<id>` key — an entry from them may be identified either way, exactly the
    // reasoning `buildEntryActorResolver` already documents for the SAME name.
    const upgraded = await users.findUsersByHiveAccountNames([...muted]);
    const upgradedIdByName = new Map(
      upgraded
        .filter((row): row is typeof row & { hiveAccountName: string } => Boolean(row.hiveAccountName))
        .map((row) => [row.hiveAccountName.toLowerCase(), row.userId])
    );
    const keys = [...muted].map((name) => {
      const userId = upgradedIdByName.get(name);
      return userId ? `u:${userId}` : `h:${name}`;
    });
    return { keys, names: [...muted] };
  } catch (error) {
    logger.warn('chain-mute: viewer chain-mute read failed, degrading to none: %o', error);
    return { keys: [], names: [] };
  }
}
