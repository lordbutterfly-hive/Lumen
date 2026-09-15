/**
 * UNIT TESTS for `lib/feed/accepted-new-posts.ts` — the "Show N new posts"
 * acceptance that has to survive leaving the page, including a full document
 * load (measured on the production build: a topic navigation from home IS one).
 *
 * Run by `pnpm --filter @hive/blog test:unit` under ts-node; own harness,
 * exits non-zero on failure, same as every sibling in lib/feed.
 */
import type { Entry } from '@hive/common-hiveio-packages/wax';
import {
  readAcceptedNewPosts,
  writeAcceptedNewPosts,
  resetAcceptedNewPostsForTests,
  MAX_AGE_MS,
  type StorageLike
} from './accepted-new-posts';

let checks = 0;
let failures = 0;
function ok(label: string, pass: boolean, detail = '') {
  checks++;
  if (pass) console.log(`  ok    ${label}`);
  else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** An in-memory Storage: what a tab's sessionStorage is, minus the browser. */
function fakeStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k)
  };
}
const post = (author: string, permlink: string): Entry => ({ author, permlink } as unknown as Entry);
const T0 = 1_700_000_000_000;

console.log('\nfresh module, no storage');
resetAcceptedNewPostsForTests();
ok('nothing for any viewer', readAcceptedNewPosts('alice', null, T0).length === 0);
ok('nothing for the anonymous viewer', readAcceptedNewPosts('', null, T0).length === 0);

console.log('\nin-page round trip (module slot)');
const s1 = fakeStorage();
const accepted = [post('gtg', 'a'), post('blocktrades', 'b')];
writeAcceptedNewPosts('alice', accepted, s1, T0);
ok('a later read returns what was written', readAcceptedNewPosts('alice', s1, T0 + 1000).length === 2);
ok('it is the same array — the slot, not a parse', readAcceptedNewPosts('alice', s1, T0 + 1000) === accepted);
ok('and it was mirrored to storage', s1.map.size === 1);

console.log('\nTHE FIX: a document load (module reset) restores from storage');
resetAcceptedNewPostsForTests(); // what a full navigation does to every module
const restored = readAcceptedNewPosts('alice', s1, T0 + 60_000);
ok('the acceptance comes back after the module was wiped', restored.length === 2 && restored[1].permlink === 'b');
ok('a second read now hits the re-seeded slot', readAcceptedNewPosts('alice', s1, T0 + 60_000) === restored);

console.log('\nkeyed on the viewer');
ok('another viewer reads empty from the slot', readAcceptedNewPosts('bob', s1, T0 + 60_000).length === 0);
resetAcceptedNewPostsForTests();
ok('another viewer reads empty from storage too', readAcceptedNewPosts('bob', s1, T0 + 60_000).length === 0);
ok('the anonymous viewer reads empty', readAcceptedNewPosts('', s1, T0 + 60_000).length === 0);
writeAcceptedNewPosts('bob', [post('x', 'y')], s1, T0 + 60_000);
resetAcceptedNewPostsForTests();
ok('a write for a new viewer replaces the old one in storage', readAcceptedNewPosts('alice', s1, T0 + 60_000).length === 0);
ok('and the new viewer reads theirs', readAcceptedNewPosts('bob', s1, T0 + 60_000).length === 1);

console.log('\nbounded by age');
const s2 = fakeStorage();
writeAcceptedNewPosts('alice', accepted, s2, T0);
ok('just inside the window: kept', readAcceptedNewPosts('alice', s2, T0 + MAX_AGE_MS).length === 2);
resetAcceptedNewPostsForTests();
ok('just past the window: treated as empty (storage path)', readAcceptedNewPosts('alice', s2, T0 + MAX_AGE_MS + 1).length === 0);
writeAcceptedNewPosts('alice', accepted, s2, T0);
ok('just past the window: treated as empty (slot path)', readAcceptedNewPosts('alice', s2, T0 + MAX_AGE_MS + 1).length === 0);
ok('a clock that went backwards is not trusted either', readAcceptedNewPosts('alice', s2, T0 - 1).length === 0);

console.log('\nnever breaks the feed on a bad or hostile storage');
resetAcceptedNewPostsForTests();
const s3 = fakeStorage();
s3.setItem('lumen.feed.acceptedNewPosts.v1', '{not json');
ok('corrupt JSON reads as empty', readAcceptedNewPosts('alice', s3, T0).length === 0);
s3.setItem('lumen.feed.acceptedNewPosts.v1', JSON.stringify({ viewer: 'alice', at: T0, entries: 'nope' }));
ok('wrong shape reads as empty', readAcceptedNewPosts('alice', s3, T0).length === 0);
const throwing: StorageLike = {
  getItem: () => { throw new Error('quota'); },
  setItem: () => { throw new Error('quota'); },
  removeItem: () => { throw new Error('quota'); }
};
let threw = false;
try { writeAcceptedNewPosts('alice', accepted, throwing, T0); } catch { threw = true; }
ok('a throwing setItem is swallowed', !threw);
ok('and the slot still serves in-page navigation', readAcceptedNewPosts('alice', throwing, T0 + 1).length === 2);
resetAcceptedNewPostsForTests();
threw = false;
let got: Entry[] = [post('z', 'z')];
try { got = readAcceptedNewPosts('alice', throwing, T0); } catch { threw = true; }
ok('a throwing getItem is swallowed and reads as empty', !threw && got.length === 0);

console.log('\ntest seam');
writeAcceptedNewPosts('alice', accepted, null, T0);
resetAcceptedNewPostsForTests();
ok('reset empties the slot', readAcceptedNewPosts('alice', null, T0).length === 0);

if (failures === 0) {
  console.log(`\naccepted-new-posts: ALL ${checks} CHECKS PASSED`);
  process.exit(0);
} else {
  console.error(`\naccepted-new-posts: ${failures}/${checks} CHECK(S) FAILED`);
  process.exit(1);
}
