import type { IProfile } from '@hive/common-hiveio-packages/wax';

/**
 * The PURE half of the People tab: the card shapes, the merge of the Hive and
 * Lumen-lite legs, and the memo rule. No I/O, no server imports, so
 * `__tests__/people-merge.test.ts` can pin every rule under plain ts-node
 * (review 2026-09-05: the first test file never reached this code, so the
 * incident fix had no test behind it).
 */

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

/**
 * A loader's answer plus whether EVERY leg behind it was actually read: every
 * `get_profile` answered, and the lite database answered. `complete: false`
 * means something failed and the list is degraded (bare name cards for the
 * accounts whose profile could not be read, or no lite accounts at all).
 *
 * ★ FOUND ON PROD (2026-09-05, first checklist run): the Hive node answered
 * non-2xx for a few seconds, 10 of 12 `get_profile` calls for "gtg" failed,
 * the two survivors were memoised for 60s, and the exact match `gtg` was
 * simply gone from its own People tab.
 */
export interface PeopleAnswer {
  people: PersonResult[];
  complete: boolean;
}

/** A complete answer is a convenience worth a minute; a topic answer far longer (Hivesense is slow and stable). */
export const PEOPLE_COMPLETE_TTL_MS = 60_000;
export const TOPIC_COMPLETE_TTL_MS = 300_000;
/**
 * ★ A PARTIAL ANSWER IS MEMOISED TOO, BRIEFLY (review 2026-09-05). Refusing
 * to store it removed the shield during the exact incident it was written
 * for: while the node is flaky nothing is ever complete, so every request
 * re-ran `lookup_accounts` plus up to twelve `get_profile` calls behind only
 * the per-IP bucket. Five seconds holds a flapping node at one round per
 * query per five seconds, and is short enough that the next complete answer
 * replaces the degraded one almost at once (a complete answer earns the full
 * TTL, see `peopleMemoTtl`).
 */
export const PEOPLE_PARTIAL_TTL_MS = 5_000;

/** What one screen holds. */
export const PREFIX_RESULT_CAP = 16;

const ABOUT_MAX = 160;

/** How long a memo entry lives: the leg's own TTL when complete, the short one when degraded. */
export function peopleMemoTtl(answer: PeopleAnswer, completeTtlMs: number): number {
  return answer.complete ? completeTtlMs : PEOPLE_PARTIAL_TTL_MS;
}

/** One line of bio on a card; the profile page has the rest. */
export function clip(text: string): string {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > ABOUT_MAX ? `${clean.slice(0, ABOUT_MAX - 1).trimEnd()}…` : clean;
}

/** What we know about an account whose profile could not be read right now: that it exists. */
export function bareCard(name: string): PersonResult {
  return {
    name: name.toLowerCase(),
    kind: 'hive',
    displayName: name.toLowerCase(),
    about: '',
    reputation: null,
    postCount: null,
    followers: null,
    avatarUrl: null
  };
}

export function toPerson(profile: IProfile, fallbackName: string): PersonResult {
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

/** The fields of a lite user row this needs; structural so the test needs no repository type. */
export interface LiteUserLike {
  displayName: string;
  avatarUrl?: string | null;
  profile?: { name?: string; about?: string; profile_image?: string } | null;
}

export function liteToPerson(user: LiteUserLike): PersonResult {
  return {
    name: user.displayName.toLowerCase(),
    kind: 'lite',
    displayName: (user.profile?.name || user.displayName).trim(),
    about: clip(user.profile?.about ?? ''),
    reputation: null,
    postCount: null,
    followers: null,
    avatarUrl: user.avatarUrl || user.profile?.profile_image || null
  };
}

/** One hydrated Hive leg: the cards, which of them are bare, and whether every profile answered. */
export interface HydratedLeg {
  people: PersonResult[];
  bareNames: Set<string>;
  complete: boolean;
}

/**
 * Fold the settled `get_profile` outcomes (same order as `wanted`) into a leg.
 * A REJECTED call keeps its account as a bare card and registers the name in
 * `bareNames`, which is what lets `mergePeople` prefer a lite row over it; a
 * profile that answers `null` (hivemind does not know the account) is dropped.
 * Every call rejected is not an answer at all and throws, so a node outage is
 * never served or memoised as "nobody by that name". Pure: the caller
 * (`people.ts`) only does the network part.
 */
export function foldHydration(
  wanted: readonly string[],
  settled: readonly PromiseSettledResult<IProfile | null>[]
): HydratedLeg {
  const bareNames = new Set<string>();
  const people: PersonResult[] = [];
  let failures = 0;
  settled.forEach((outcome, index) => {
    const name = (wanted[index] ?? '').toLowerCase();
    if (!name) return;
    if (outcome.status === 'rejected') {
      failures += 1;
      bareNames.add(name);
      people.push(bareCard(name));
      return;
    }
    const profile = outcome.value;
    if (!profile || !profile.name) return;
    people.push(toPerson(profile, name));
  });
  if (wanted.length > 0 && failures === wanted.length) {
    throw new Error('search people: every get_profile call failed');
  }
  return { people, bareNames, complete: failures === 0 };
}

export interface MergePeopleInput {
  /** The lowercase prefix that was searched; the exact match goes first. */
  prefix: string;
  /** Hydrated Hive cards, bare cards included. */
  hive: readonly PersonResult[];
  /** Names among `hive` that are bare cards (their profile could not be read). */
  bareNames: ReadonlySet<string>;
  /** Lumen lite accounts matching the prefix. */
  lite: readonly PersonResult[];
  cap?: number;
}

/**
 * One list from two legs. Precedence for a name present in both:
 *   * a FULL Hive card wins: `/@name` opens the chain account first and only
 *     falls back to the lite profile when no chain account exists;
 *   * a BARE Hive card loses to the lite row (review 2026-09-05): a bare card
 *     says only "this exists on chain", the lite row carries a display name,
 *     a bio and a picture, and hiding those behind an empty card helps nobody.
 * Then: exact match first, followers descending (bare and lite cards have
 * none, so they sort among the small ones), name as the tiebreak, capped.
 */
export function mergePeople(input: MergePeopleInput): PersonResult[] {
  const cap = input.cap ?? PREFIX_RESULT_CAP;
  const byName = new Map<string, PersonResult>();
  for (const person of input.hive) byName.set(person.name, person);
  for (const person of input.lite) {
    const existing = byName.get(person.name);
    if (!existing || input.bareNames.has(person.name)) byName.set(person.name, person);
  }
  return [...byName.values()]
    .sort((a, b) => {
      const aExact = a.name === input.prefix ? 0 : 1;
      const bExact = b.name === input.prefix ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      return (b.followers ?? 0) - (a.followers ?? 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    })
    .slice(0, cap);
}
