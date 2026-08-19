/**
 * The post card's per-session top-comment cache, and the reset that clears it.
 * Plain assertions, no test runner (this repo has none; same shape as
 * features/votes/__tests__/downvote-demotion.test.ts).
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node -T -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     features/discovery-feed/__tests__/top-comment-picks.test.ts
 *
 * `-T` (transpile only) is required and is not a shortcut: `lib/top-comment.ts`
 * imports its `Entry` type from `@hive/common-hiveio-packages/wax`, a workspace
 * package ts-node cannot resolve outside Next's own module graph, so a
 * type-checking run fails on the IMPORT rather than on anything this test asserts.
 * The types are still checked — by `tsc --noEmit -p tsconfig.json`, which covers
 * this file and passes. What runs here is the BEHAVIOUR.
 *
 * ★ WHY THE RANDOM PATH IS TESTED STATISTICALLY AND NOT BY EYE. `resetTopCommentPicks()`
 * clears a module-level Map; nothing observable says "the Map is empty". What IS
 * observable is that a cleared cache re-rolls. One trial cannot show that — a
 * re-roll can legitimately land on the same comment. So the test rolls across many
 * resets on a thread with many tied candidates: if the reset did nothing, every
 * reading would be the cached one and the distinct count would be exactly 1. With
 * 40 tied candidates and 30 resets, an unbroken run of identical picks has
 * probability 40^-29, which is not a flake, it is a failure.
 */
import { selectTopComment, resetTopCommentPicks, discussionKey } from '../lib/top-comment';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const ROOT_AUTHOR = 'alice';
const ROOT_PERMLINK = 'a-post';
const rootKey = discussionKey(ROOT_AUTHOR, ROOT_PERMLINK);

/** A thread of `n` sibling comments, none of them answered — i.e. all tied. */
function tiedThread(n: number): Record<string, any> {
  const map: Record<string, any> = {
    [rootKey]: { author: ROOT_AUTHOR, permlink: ROOT_PERMLINK, body: 'post', created: '2026-01-01', payout: 0 }
  };
  for (let i = 0; i < n; i++) {
    const key = discussionKey(`user${i}`, `c${i}`);
    map[key] = {
      author: `user${i}`,
      permlink: `c${i}`,
      body: `comment ${i}`,
      created: '2026-01-02',
      payout: 0,
      active_votes: [],
      parent_author: ROOT_AUTHOR,
      parent_permlink: ROOT_PERMLINK
    };
  }
  return map;
}

const TIED = 40;
const thread = tiedThread(TIED);

console.log('top-comment picks');

// ── 0. the test must have something to test ─────────────────────────────────
// A check with one candidate would pass every assertion below while proving
// nothing at all, so refuse to run rather than report a vacuous green.
const candidates = Object.keys(thread).length - 1;
check('the fixture offers many tied candidates', candidates === TIED, `${candidates} candidates`);
if (candidates < 2) {
  console.log('\nABORT: fixture is degenerate, the assertions below would be vacuous.');
  process.exit(1);
}

// ── 1. the cache holds within a session ─────────────────────────────────────
resetTopCommentPicks();
const first = selectTopComment(rootKey, thread);
check('a thread with comments resolves to one', first !== null);
const repeats = new Set<string>();
for (let i = 0; i < 50; i++) repeats.add(selectTopComment(rootKey, thread)!.key);
check('50 reads without a reset return the SAME comment', repeats.size === 1, `${repeats.size} distinct`);

// ── 2. the reset actually clears it ─────────────────────────────────────────
const acrossResets = new Set<string>();
for (let i = 0; i < 30; i++) {
  resetTopCommentPicks();
  acrossResets.add(selectTopComment(rootKey, thread)!.key);
}
check(
  '30 reads WITH a reset between them re-roll',
  acrossResets.size > 1,
  `${acrossResets.size} distinct of ${TIED} possible`
);

// ── 3. the reset does not damage the selection rule ─────────────────────────
// Rule 1 is "most DIRECT responses wins", and it must stay deterministic — a
// reset clears a cache, it does not turn the rule into a coin flip.
const answered = tiedThread(TIED);
const winnerKey = discussionKey('user7', 'c7');
for (let i = 0; i < 3; i++) {
  answered[discussionKey('replier' + i, 'r' + i)] = {
    author: 'replier' + i,
    permlink: 'r' + i,
    body: 'reply',
    created: '2026-01-03',
    payout: 0,
    active_votes: [],
    parent_author: 'user7',
    parent_permlink: 'c7'
  };
}
const winners = new Set<string>();
for (let i = 0; i < 20; i++) {
  resetTopCommentPicks();
  winners.add(selectTopComment(rootKey, answered)!.key);
}
check(
  'the most-answered comment still wins every time, reset or not',
  winners.size === 1 && winners.has(winnerKey),
  [...winners].join(', ')
);
const picked = selectTopComment(rootKey, answered)!;
check('and its direct-response count is COUNTED, not read off children', picked.directResponseCount === 3,
  `directResponseCount=${picked.directResponseCount}`);

// ── 4. a thread with no comments does not expand ────────────────────────────
resetTopCommentPicks();
const empty = { [rootKey]: thread[rootKey] };
check('a post with no comments returns null', selectTopComment(rootKey, empty) === null);
check('an undefined discussion returns null', selectTopComment(rootKey, undefined) === null);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
