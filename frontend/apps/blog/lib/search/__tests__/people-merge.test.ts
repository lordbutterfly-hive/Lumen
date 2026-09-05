/**
 * People-tab merge invariants (the pure half of `lib/search/people.ts`), plain
 * assertions, no runner. Run with `pnpm --filter @hive/blog test:unit`, or:
 *   pnpm exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/search/__tests__/people-merge.test.ts
 *
 * WHAT IS PROVEN HERE
 *  1. a bare card is "this account exists" and nothing else
 *  2. toPerson / liteToPerson read the right fields and fall back to the handle
 *  3. merge precedence: full Hive card beats lite; lite beats a BARE Hive card;
 *     exact match first; followers descending; cap
 *  4. the memo rule: complete = the leg's TTL, partial = 5s, and 5s < the leg's TTL
 */
import assert from 'node:assert/strict';
import {
  PEOPLE_COMPLETE_TTL_MS,
  PEOPLE_PARTIAL_TTL_MS,
  PREFIX_RESULT_CAP,
  TOPIC_COMPLETE_TTL_MS,
  bareCard,
  clip,
  foldHydration,
  liteToPerson,
  mergePeople,
  peopleMemoTtl,
  toPerson,
  type PersonResult
} from '../people-merge';

let checks = 0;
let failures = 0;
function check(name: string, fn: () => void): void {
  checks += 1;
  try {
    fn();
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`);
  }
}

const full = (name: string, followers: number, extra: Partial<PersonResult> = {}): PersonResult => ({
  name,
  kind: 'hive',
  displayName: name,
  about: '',
  reputation: 60,
  postCount: 10,
  followers,
  avatarUrl: null,
  ...extra
});

check('bareCard: lowercase name, no numbers, no picture, Hive kind', () => {
  assert.deepEqual(bareCard('GTG'), {
    name: 'gtg',
    kind: 'hive',
    displayName: 'gtg',
    about: '',
    reputation: null,
    postCount: null,
    followers: null,
    avatarUrl: null
  });
});

check('clip collapses whitespace and cuts at 160 with an ellipsis', () => {
  assert.equal(clip('  a \n b  '), 'a b');
  const long = clip('x'.repeat(200));
  assert.equal(long.length, 160);
  assert.ok(long.endsWith('…'));
  assert.equal(clip(undefined as unknown as string), '');
});

check('toPerson reads profile metadata, falls back to the handle, never invents a picture', () => {
  const person = toPerson(
    {
      id: 1,
      name: 'GTG',
      created: '',
      active: '',
      post_count: 7398,
      reputation: 76.11,
      blacklists: [],
      stats: { rank: 0, followers: 10964, following: 1 },
      metadata: { profile: { name: ' Gandalf the Grey ', about: 'IT  Wizard' } }
    },
    'fallback'
  );
  assert.deepEqual(person, {
    name: 'gtg',
    kind: 'hive',
    displayName: 'Gandalf the Grey',
    about: 'IT Wizard',
    reputation: 76.11,
    postCount: 7398,
    followers: 10964,
    avatarUrl: null
  });
  const sparse = toPerson(
    { id: 2, name: '', created: '', active: '', post_count: 0, reputation: 25, blacklists: [], stats: { rank: 0, followers: 0, following: 0 }, metadata: {} },
    'Someone'
  );
  assert.equal(sparse.name, 'someone');
  assert.equal(sparse.displayName, 'someone');
});

check('liteToPerson: handle lowercased, profile name preferred, avatar from avatarUrl then profile_image', () => {
  assert.deepEqual(liteToPerson({ displayName: 'QA-Bob', avatarUrl: '', profile: { name: 'Bob', about: 'hi', profile_image: 'https://x/p.png' } }), {
    name: 'qa-bob',
    kind: 'lite',
    displayName: 'Bob',
    about: 'hi',
    reputation: null,
    postCount: null,
    followers: null,
    avatarUrl: 'https://x/p.png'
  });
  assert.equal(liteToPerson({ displayName: 'plain', avatarUrl: 'https://x/a.png' }).avatarUrl, 'https://x/a.png');
  assert.equal(liteToPerson({ displayName: 'plain' }).displayName, 'plain');
});

check('mergePeople: exact first, then followers descending, then name', () => {
  const out = mergePeople({
    prefix: 'gtg',
    hive: [full('gtgc', 3), full('gtg', 10964), full('gtg.witnesses', 87), full('gtgerry', 9), full('gtg345', 0), full('gtg.vsc', 0)],
    bareNames: new Set(),
    lite: []
  });
  assert.deepEqual(
    out.map((p) => p.name),
    ['gtg', 'gtg.witnesses', 'gtgerry', 'gtgc', 'gtg.vsc', 'gtg345']
  );
});

check('mergePeople: a full Hive card beats a lite row of the same name', () => {
  const out = mergePeople({
    prefix: 'qa',
    hive: [full('qa-bob', 5)],
    bareNames: new Set(),
    lite: [liteToPerson({ displayName: 'qa-bob', profile: { name: 'Lite Bob' } })]
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'hive');
});

check('mergePeople: a lite row beats a BARE Hive card of the same name (review 2026-09-05)', () => {
  const out = mergePeople({
    prefix: 'qa',
    hive: [bareCard('qa-bob'), full('qa-carol', 2)],
    bareNames: new Set(['qa-bob']),
    lite: [liteToPerson({ displayName: 'qa-bob', profile: { name: 'Lite Bob', about: 'a bio' }, avatarUrl: 'https://x/b.png' })]
  });
  const bob = out.find((p) => p.name === 'qa-bob');
  assert.ok(bob, 'qa-bob is present once');
  assert.equal(out.filter((p) => p.name === 'qa-bob').length, 1);
  assert.equal(bob!.kind, 'lite');
  assert.equal(bob!.displayName, 'Lite Bob');
  assert.equal(bob!.avatarUrl, 'https://x/b.png');
});

check('mergePeople: a bare card with no lite twin stays (the account exists), sorted among the small ones, and the exact match still leads', () => {
  const out = mergePeople({
    prefix: 'gtg',
    hive: [bareCard('gtg'), full('gtg.witnesses', 87), bareCard('gtgzz')],
    bareNames: new Set(['gtg', 'gtgzz']),
    lite: []
  });
  assert.deepEqual(out.map((p) => p.name), ['gtg', 'gtg.witnesses', 'gtgzz']);
});

check('mergePeople: the default cap is the literal 16 (one screen); the 17th candidate is cut, a custom cap is honoured', () => {
  assert.equal(PREFIX_RESULT_CAP, 16);
  const many = Array.from({ length: 30 }, (_, i) => full(`ab${String(i).padStart(2, '0')}`, 30 - i));
  const out = mergePeople({ prefix: 'ab', hive: many, bareNames: new Set(), lite: [] });
  assert.equal(out.length, 16);
  assert.equal(out[15].name, 'ab15', 'the sixteenth by followers is the last one kept');
  assert.ok(!out.some((p) => p.name === 'ab16'), 'the seventeenth is cut');
  assert.equal(mergePeople({ prefix: 'ab', hive: many, bareNames: new Set(), lite: [], cap: 3 }).length, 3);
});

const profileOf = (name: string, followers: number) => ({
  id: 1,
  name,
  created: '',
  active: '',
  post_count: 1,
  reputation: 50,
  blacklists: [],
  stats: { rank: 0, followers, following: 0 },
  metadata: { profile: { name: `Full ${name}` } }
});
const rejected = (): PromiseSettledResult<never> => ({ status: 'rejected', reason: new Error('429') });
const fulfilled = <T,>(value: T): PromiseSettledResult<T> => ({ status: 'fulfilled', value });

check('foldHydration: a failed call becomes a bare card AND is registered in bareNames; null is dropped; the leg is incomplete', () => {
  const leg = foldHydration(['GTG', 'gtg.vsc', 'unknown'], [rejected(), fulfilled(profileOf('gtg.vsc', 3)), fulfilled(null)]);
  assert.deepEqual(leg.people.map((p) => [p.name, p.kind, p.displayName]), [
    ['gtg', 'hive', 'gtg'],
    ['gtg.vsc', 'hive', 'Full gtg.vsc']
  ]);
  assert.deepEqual([...leg.bareNames], ['gtg'], 'the failed name is registered as bare');
  assert.equal(leg.complete, false);
});

check('foldHydration: no failures = complete with no bare names; every call failing throws; nothing wanted = complete', () => {
  const clean = foldHydration(['a', 'b'], [fulfilled(profileOf('a', 1)), fulfilled(profileOf('b', 2))]);
  assert.equal(clean.complete, true);
  assert.equal(clean.bareNames.size, 0);
  assert.throws(() => foldHydration(['a', 'b'], [rejected(), rejected()]), /every get_profile call failed/);
  assert.deepEqual(foldHydration([], []), { people: [], bareNames: new Set(), complete: true });
});

check('caller path: a Hive card that failed to hydrate loses to the lite row of the same name (foldHydration -> mergePeople)', () => {
  const leg = foldHydration(['qa-bob', 'qa-carol'], [rejected(), fulfilled(profileOf('qa-carol', 9))]);
  const out = mergePeople({
    prefix: 'qa',
    hive: leg.people,
    bareNames: leg.bareNames,
    lite: [liteToPerson({ displayName: 'qa-bob', profile: { name: 'Lite Bob' }, avatarUrl: 'https://x/b.png' })]
  });
  assert.deepEqual(out.map((p) => [p.name, p.kind, p.displayName]), [
    ['qa-carol', 'hive', 'Full qa-carol'],
    ['qa-bob', 'lite', 'Lite Bob']
  ]);
  assert.equal(leg.complete, false, 'and the answer would be memoised only briefly');
});

check('peopleMemoTtl: complete keeps the leg TTL, partial keeps 5s, and 5s is shorter than either leg', () => {
  assert.equal(peopleMemoTtl({ people: [], complete: true }, PEOPLE_COMPLETE_TTL_MS), PEOPLE_COMPLETE_TTL_MS);
  assert.equal(peopleMemoTtl({ people: [], complete: true }, TOPIC_COMPLETE_TTL_MS), TOPIC_COMPLETE_TTL_MS);
  assert.equal(peopleMemoTtl({ people: [bareCard('x')], complete: false }, PEOPLE_COMPLETE_TTL_MS), PEOPLE_PARTIAL_TTL_MS);
  assert.ok(PEOPLE_PARTIAL_TTL_MS > 0 && PEOPLE_PARTIAL_TTL_MS < PEOPLE_COMPLETE_TTL_MS && PEOPLE_PARTIAL_TTL_MS < TOPIC_COMPLETE_TTL_MS);
});

if (failures > 0) {
  console.error(`\nFAILED — ${failures} of ${checks} checks`);
  process.exit(1);
}
console.log(`PASS — ${checks} checks`);
