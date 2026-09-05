import type { IProfile } from '@hive/common-hiveio-packages/wax';
import { getLogger } from '@ui/lib/logging';
import { isBannedAuthor } from '@ui/config/lists/banned-authors';
import { getBridgeProfile, lookupAccounts } from '@transaction/lib/hive-api';
import { withTtlCache } from '@/blog/lib/server-ttl-cache';
import { liteConfig } from '@/blog/lib/lite/config';
import * as users from '@/blog/lib/lite/repositories/user-repository';
import { accountPrefixOf, normalizeSearchText } from './query';
import { hivesenseAuthorsByTopic } from './hivesense-search';
import { mapBounded } from './bounded';

const logger = getLogger('app');

/**
 * One card on the People tab. `reputation` is the badge number (already
 * converted by hivemind, e.g. 79.79), `null` for a lite account, which has no
 * chain reputation and must not be shown a made-up 25.
 */
export interface PersonResult {
  name: string;
  kind: 'hive' | 'lite';
  displayName: string;
  about: string;
  reputation: number | null;
  postCount: number | null;
  followers: number | null;
  /** A lite account's own picture (Lumen-hosted). `null` for Hive accounts: the avatar component resolves those by name. */
  avatarUrl: string | null;
}

/** Prefix section: names asked from hived, then hydrated. 16 is what one screen holds. */
const PREFIX_HIVE_LIMIT = 12;
const PREFIX_LITE_LIMIT = 8;
const PREFIX_RESULT_CAP = 16;
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

const ABOUT_MAX = 160;

/**
 * A loader's answer plus whether every profile behind it was actually read.
 * `complete: false` means some `get_profile` calls failed and their accounts
 * are in the list as bare name cards; it is served to the reader who asked
 * (a name is better than nothing) but NOT memoised, so the next reader gets a
 * fresh attempt instead of a minute of the degraded list.
 *
 * ★ FOUND ON PROD (2026-09-05, first checklist run): the Hive node answered
 * non-2xx for a few seconds, 10 of 12 `get_profile` calls for "gtg" failed,
 * the two survivors (`gtg.vsc`, `gtg345`) were memoised for 60s, and the exact
 * match `gtg` was simply gone from its own People tab.
 */
interface PeopleAnswer {
  people: PersonResult[];
  complete: boolean;
}

/**
 * 60s memo, same reasoning as the suggestions: a search result list is a
 * convenience, and two readers typing the same name within a minute should
 * cost one round of `get_profile` calls, not two. Failures and PARTIAL answers
 * are never stored (see `PeopleAnswer`).
 */
const peopleByPrefixMemo = withTtlCache(loadPeopleByPrefix, memoKey, {
  ttlMs: 60_000,
  max: 500,
  shouldCache: (value) => Boolean(value) && value.complete
});

/** Hivesense is slow (1.8 to 2.7s measured) and its answer for a topic is stable for far longer than a minute. */
const peopleByTopicMemo = withTtlCache(loadPeopleByTopic, memoKey, {
  ttlMs: 300_000,
  max: 500,
  shouldCache: (value) => Boolean(value) && value.complete
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

  const [hiveNames, liteRows] = await Promise.all([
    lookupAccounts(prefix, PREFIX_HIVE_LIMIT),
    loadLiteRows(prefix)
  ]);

  const { people: hive, complete } = await hydrateHiveProfiles(hiveNames);
  const taken = new Set(hive.map((person) => person.name));
  const lite = liteRows
    .filter((user) => !taken.has(user.displayName.toLowerCase()))
    .map(
      (user): PersonResult => ({
        name: user.displayName.toLowerCase(),
        kind: 'lite',
        displayName: (user.profile?.name || user.displayName).trim(),
        about: clip(user.profile?.about ?? ''),
        reputation: null,
        postCount: null,
        followers: null,
        avatarUrl: user.avatarUrl || user.profile?.profile_image || null
      })
    );

  // Exact match first, then the accounts most people would mean: by followers.
  // A lite account, or a bare card, has no follower count; it sorts among the small ones.
  const people = [...hive, ...lite]
    .sort((a, b) => {
      const aExact = a.name === prefix ? 0 : 1;
      const bExact = b.name === prefix ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      return (b.followers ?? 0) - (a.followers ?? 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    })
    .slice(0, PREFIX_RESULT_CAP);
  return { people, complete };
}

async function loadPeopleByTopic(query: string): Promise<PeopleAnswer> {
  const topic = memoKey(query);
  if (!topic) return { people: [], complete: true };
  const names = await hivesenseAuthorsByTopic(topic, TOPIC_LIMIT);
  // Hivesense order is the ranking here; hydration keeps it.
  return hydrateHiveProfiles(names);
}

async function loadLiteRows(prefix: string) {
  if (!liteConfig.enabled || !liteConfig.databaseUrl) return [];
  try {
    return await users.searchLiteUsersByPrefix(prefix, PREFIX_LITE_LIMIT);
  } catch (error) {
    logger.warn('search people: lite lookup failed: %s', error instanceof Error ? error.message : String(error));
    return [];
  }
}

/**
 * `bridge.get_profile` for every name, at most `PROFILE_CONCURRENCY` in flight
 * (12 fully parallel measured 326ms on api.openhive.network 2026-09-05; four
 * at a time is ~3 rounds, still well under a second, and bounds the fan-out one
 * anonymous request can cause). Settled per name: an account whose profile
 * call FAILED stays in the list as a bare card (name only; hived already said
 * the account exists), and the answer is flagged incomplete so it is not
 * memoised. A profile that answers `null` (hivemind does not know the account)
 * is dropped. If EVERY call fails the caller gets an error rather than a list
 * of bare cards, so a node outage is not served as an answer at all.
 */
async function hydrateHiveProfiles(names: readonly string[]): Promise<PeopleAnswer> {
  const wanted = names.filter((name) => name && !isBannedAuthor(name));
  if (wanted.length === 0) return { people: [], complete: true };
  const settled = await mapBounded(wanted, PROFILE_CONCURRENCY, (name) => getBridgeProfile(name));
  const people: PersonResult[] = [];
  let failures = 0;
  settled.forEach((outcome, index) => {
    const name = wanted[index].toLowerCase();
    if (outcome.status === 'rejected') {
      failures += 1;
      people.push(bareCard(name));
      return;
    }
    const profile = outcome.value;
    if (!profile || !profile.name) return;
    people.push(toPerson(profile, name));
  });
  if (failures === wanted.length) {
    throw new Error('search people: every get_profile call failed');
  }
  return { people, complete: failures === 0 };
}

/** What we know about an account whose profile could not be read right now: that it exists. */
function bareCard(name: string): PersonResult {
  return {
    name,
    kind: 'hive',
    displayName: name,
    about: '',
    reputation: null,
    postCount: null,
    followers: null,
    avatarUrl: null
  };
}

function toPerson(profile: IProfile, fallbackName: string): PersonResult {
  const meta = profile.metadata?.profile ?? {};
  const name = (profile.name || fallbackName).toLowerCase();
  const displayName = (meta.name ?? '').trim() || name;
  return {
    name,
    kind: 'hive',
    displayName,
    about: clip(meta.about ?? ''),
    reputation: typeof profile.reputation === 'number' ? profile.reputation : null,
    postCount: typeof profile.post_count === 'number' ? profile.post_count : null,
    followers: typeof profile.stats?.followers === 'number' ? profile.stats.followers : null,
    avatarUrl: null
  };
}

/** One line of bio on a card; the profile page has the rest. */
function clip(text: string): string {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > ABOUT_MAX ? `${clean.slice(0, ABOUT_MAX - 1).trimEnd()}…` : clean;
}
