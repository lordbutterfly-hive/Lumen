import { ensureSquatterList, isSquatterName } from '@/blog/lib/lite/moderation/squatter-list';
import { getLogger } from '@ui/lib/logging';
import { isBannedAuthor } from '@ui/config/lists/banned-authors';
import { getBridgeProfile, lookupAccounts } from '@transaction/lib/hive-api';
import { withTtlCache } from '@/blog/lib/server-ttl-cache';
import { liteConfig } from '@/blog/lib/lite/config';
import * as users from '@/blog/lib/lite/repositories/user-repository';
import { accountPrefixOf, normalizeSearchText } from './query';
import { hivesenseAuthorsByTopic } from './hivesense-search';
import { mapBounded } from './bounded';
import {
  PEOPLE_COMPLETE_TTL_MS,
  TOPIC_COMPLETE_TTL_MS,
  foldHydration,
  liteToPerson,
  mergePeople,
  peopleMemoTtl,
  type HydratedLeg,
  type PeopleAnswer,
  type PersonResult
} from './people-merge';

export type { PersonResult } from './people-merge';

const logger = getLogger('app');

/** Prefix section: names asked from hived, then hydrated. */
const PREFIX_HIVE_LIMIT = 12;
const PREFIX_LITE_LIMIT = 8;
/** Topic section: Hivesense answers 5 to 8 names for a topic in practice. */
const TOPIC_LIMIT = 8;
/** `get_profile` calls in flight per request; see `mapBounded`. */
const PROFILE_CONCURRENCY = 4;

/**
 * The memo key is the query as the loaders read it (trimmed, lowercased),
 * never the raw text: everything downstream lowercases (`accountPrefixOf`),
 * so `Photo` and `photo` are one answer, and one answer must be one entry.
 * Left raw, case variants would each miss the memo and each take a slot in
 * its LRU (review 2026-09-05).
 */
const memoKey = (query: string): string => normalizeSearchText(query).toLowerCase();

/**
 * Same reasoning as the suggestions: a search result list is a convenience,
 * and two readers typing the same name within a minute should cost one round
 * of `get_profile` calls, not two. A complete answer keeps for the leg's own
 * TTL; a degraded one for `PEOPLE_PARTIAL_TTL_MS` (see `people-merge.ts` for
 * why a partial answer is memoised at all). Rejections are never stored.
 */
// ★ NAMED (2026-09-06, review fix) — see server-ttl-cache.ts's header note.
const peopleByPrefixMemo = withTtlCache(loadPeopleByPrefix, memoKey, {
  name: 'peopleByPrefix',
  ttlMs: PEOPLE_COMPLETE_TTL_MS,
  max: 500,
  shouldCache: (value) => Boolean(value),
  ttlFor: (value) => peopleMemoTtl(value, PEOPLE_COMPLETE_TTL_MS)
});

/** Hivesense is slow (1.8 to 2.7s measured) and its answer for a topic is stable for far longer than a minute. */
// ★ NAMED (2026-09-06, review fix) — see server-ttl-cache.ts's header note.
const peopleByTopicMemo = withTtlCache(loadPeopleByTopic, memoKey, {
  name: 'peopleByTopic',
  ttlMs: TOPIC_COMPLETE_TTL_MS,
  max: 500,
  shouldCache: (value) => Boolean(value),
  ttlFor: (value) => peopleMemoTtl(value, TOPIC_COMPLETE_TTL_MS)
});

export async function searchPeopleByPrefixCached(query: string): Promise<PersonResult[]> {
  return (await peopleByPrefixMemo(query)).people;
}

export async function searchPeopleByTopicCached(query: string): Promise<PersonResult[]> {
  return (await peopleByTopicMemo(query)).people;
}

async function loadPeopleByPrefix(query: string): Promise<PeopleAnswer> {
  const prefix = accountPrefixOf(query);
  if (!prefix) return { people: [], complete: true };

  const [hiveNames, liteLeg] = await Promise.all([lookupAccounts(prefix, PREFIX_HIVE_LIMIT), loadLiteLeg(prefix)]);
  const hiveLeg = await hydrateHiveProfiles(hiveNames);

  /**
   * ★★★ A SQUATTER'S HIVE CARD NEVER REACHES THE MERGE (2026-09-10).
   *
   * Measured before this: `?q=chadmasters` returned ONLY the attacker's Hive card
   * (reputation 25) and the impersonated lite account was gone from search entirely,
   * while uncontested controls (`arsha`, `menosoft`) returned their lite rows. Two
   * separate failures in one result -- the attacker shown, the victim erased -- because
   * `mergePeople` lets a Hive row hold a name and this file's own import was the
   * ENV-only predicate, and that list is empty on production.
   *
   * Dropped BEFORE the merge, not after, so it also cannot overwrite the lite row the
   * merge is about to keep. Awaited, because the predicate is synchronous over a list
   * loaded in the background and a cold worker would filter nobody.
   */
  await ensureSquatterList();
  const hivePeople = hiveLeg.people.filter((person) => !isSquatterName(person.name));

  return {
    people: mergePeople({
      prefix,
      hive: hivePeople,
      bareNames: hiveLeg.bareNames,
      lite: liteLeg.rows.map(liteToPerson)
    }),
    // Either leg failing makes the answer degraded (review 2026-09-05: a lite
    // database error used to be swallowed into "no lite accounts" and memoised
    // for the full minute as if that were the truth).
    complete: hiveLeg.complete && liteLeg.ok
  };
}

async function loadPeopleByTopic(query: string): Promise<PeopleAnswer> {
  const topic = memoKey(query);
  if (!topic) return { people: [], complete: true };
  const names = await hivesenseAuthorsByTopic(topic, TOPIC_LIMIT);
  /**
   * ★ THE SIBLING MODE IN THIS SAME FILE WAS FIXED AND THIS ONE WAS NOT (2026-09-11).
   *
   * `loadPeopleByPrefix` above awaits `ensureSquatterList()` and drops squatters before
   * merging, added 2026-09-10 with a comment explaining exactly why. Topic mode kept
   * calling `hydrateHiveProfiles` straight, and that helper only knows the ENV list,
   * which is empty on production -- so a squatter who has posted about a topic still
   * surfaced with their real Hive card, avatar and reputation, under a name that
   * click-throughs to their victim.
   */
  await ensureSquatterList();
  const clean = names.filter((name) => !isSquatterName(name));
  // Hivesense order is the ranking here; hydration keeps it.
  const leg = await hydrateHiveProfiles(clean);
  return { people: leg.people, complete: leg.complete };
}

/**
 * The lite leg. Disabled lite accounts are not a failure (there is nothing to
 * read); a database error is, and says so, so the answer is memoised only
 * briefly and the next reader gets a fresh attempt.
 */
async function loadLiteLeg(prefix: string): Promise<{ rows: import("@/blog/lib/lite/types").LumenUser[]; ok: boolean }> {
  if (!liteConfig.enabled || !liteConfig.databaseUrl) return { rows: [], ok: true };
  try {
    return { rows: await users.searchLiteUsersByPrefix(prefix, PREFIX_LITE_LIMIT), ok: true };
  } catch (error) {
    logger.warn('search people: lite lookup failed: %s', error instanceof Error ? error.message : String(error));
    return { rows: [], ok: false };
  }
}

/**
 * `bridge.get_profile` for every name, at most `PROFILE_CONCURRENCY` in flight
 * (12 fully parallel measured 326ms on api.openhive.network 2026-09-05; four
 * at a time is ~3 rounds, still well under a second, and bounds the fan-out one
 * anonymous request can cause). What a failed, empty or successful call means
 * is decided in `foldHydration` (pure, unit tested): a failed call keeps its
 * account as a bare card and flags the leg incomplete, a null profile is
 * dropped, and every call failing throws so a node outage is never served or
 * memoised as an answer.
 */
async function hydrateHiveProfiles(names: readonly string[]): Promise<HydratedLeg> {
  const wanted = names.filter((name) => name && !isBannedAuthor(name));
  if (wanted.length === 0) return { people: [], bareNames: new Set(), complete: true };
  const settled = await mapBounded(wanted, PROFILE_CONCURRENCY, (name) => getBridgeProfile(name));
  return foldHydration(wanted, settled);
}
