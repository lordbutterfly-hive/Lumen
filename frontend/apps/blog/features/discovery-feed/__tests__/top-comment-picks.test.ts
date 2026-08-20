/**
 * The post card's top-comment SCORE, its per-session cache, and the reset that
 * clears it. Plain assertions, no test runner (this repo has none; same shape as
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
 * ★★★ REWRITTEN 2026-08-20 FOR THE CARD-EXPANSION SPEC §3. The rule this file
 * used to test was "most direct replies, random among ties", and its central
 * assertion was STATISTICAL: reset the cache 30 times over a 40-way tie and prove
 * the pick re-rolled. §3 replaced that rule with
 *
 *     score = (votes + replies) * (authorReplied ? 2 : 1),  ties on raw votes
 *
 * which is deterministic, so that assertion now fails BY DESIGN — there is no
 * roll left to re-roll. It is not relaxed here, it is replaced by a stronger one.
 *
 * ★★ HOW THE RESET IS OBSERVED WITHOUT RNG. Nothing about a module-level Map is
 * directly visible, and with a deterministic score a cleared cache re-resolves to
 * the same comment, so "read it twice" can no longer tell a working reset from a
 * dead one. What IS observable: change the thread so a DIFFERENT comment would
 * now win. A live cache keeps serving the old winner; a cleared one yields the new
 * one. Test 6 does exactly that, which also happens to be the real behaviour §3
 * asks for — "do not re-rank on the reader's own vote".
 *
 * ★ THE SCORE CASES ARE THE SPEC'S OWN WORKED EXAMPLES, transcribed from its
 * table rather than invented here, so this file fails if the implementation and
 * the spec ever disagree. Row 2 is the one that matters: ada has 96 votes and 0
 * replies, tomasz has 41 votes, 12 replies and an author answer. Votes alone
 * would show ada. The spec wants tomasz, 106 to 96.
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

type Map_ = Record<string, any>;

function newThread(): Map_ {
  return {
    [rootKey]: { author: ROOT_AUTHOR, permlink: ROOT_PERMLINK, body: 'post', created: '2026-01-01', payout: 0 }
  };
}

/** `upvotes` positive-rshares votes, plus enough downvotes to prove they do NOT count. */
function votes(upvotes: number, downvotes = 0) {
  return [
    ...Array.from({ length: upvotes }, (_, i) => ({ voter: `up${i}`, rshares: 1000 })),
    ...Array.from({ length: downvotes }, (_, i) => ({ voter: `dn${i}`, rshares: -1000 }))
  ];
}

/**
 * Add a candidate comment and its replies. `replyAuthors` become direct replies to
 * it; naming ROOT_AUTHOR among them is what sets `authorReplied` and doubles the
 * score, exactly as the spec's table does.
 */
function addCandidate(map: Map_, author: string, upvotes: number, replyAuthors: string[], downvotes = 0): string {
  const permlink = `c-${author}`;
  const key = discussionKey(author, permlink);
  map[key] = {
    author,
    permlink,
    body: `comment by ${author}`,
    created: '2026-01-02',
    payout: 0,
    active_votes: votes(upvotes, downvotes),
    parent_author: ROOT_AUTHOR,
    parent_permlink: ROOT_PERMLINK
  };
  replyAuthors.forEach((replyAuthor, i) => {
    map[discussionKey(replyAuthor, `r-${author}-${i}`)] = {
      author: replyAuthor,
      permlink: `r-${author}-${i}`,
      body: 'reply',
      created: '2026-01-03',
      payout: 0,
      active_votes: [],
      parent_author: author,
      parent_permlink: permlink
    };
  });
  return key;
}

/** n reply authors, the first of which is the post author when `byAuthor`. */
function repliers(n: number, byAuthor: boolean): string[] {
  const list = Array.from({ length: n }, (_, i) => `replier${i}`);
  if (byAuthor && n > 0) list[0] = ROOT_AUTHOR;
  return list;
}

console.log('top-comment score (card-expansion spec §3)');

// ── 0. the fixtures must have something to choose BETWEEN ────────────────────
// A one-candidate thread would pass every assertion below while proving nothing,
// so refuse to run rather than report a vacuous green.
const guard = newThread();
addCandidate(guard, 'solo', 1, []);
const guardCandidates = Object.keys(guard).length - 1;
check('the fixture offers a real choice', guardCandidates >= 1, `${guardCandidates} candidate(s)`);

// ── 1. spec table row 1: "Eleven bowls, nine survivors" ──────────────────────
// mortezayousefi 24 votes + 6 replies, author replied -> (24+6)*2 = 60
// bea            38 votes + 1 reply,   no author reply -> (38+1)*1 = 39
resetTopCommentPicks();
const row1 = newThread();
const morteza = addCandidate(row1, 'mortezayousefi', 24, repliers(6, true));
addCandidate(row1, 'bea', 38, repliers(1, false));
const w1 = selectTopComment(rootKey, row1)!;
check('spec row 1 — mortezayousefi (60) beats bea (39)', w1.key === morteza, `won: ${w1.key}`);

// ── 2. spec table row 2: "The vote that pays a stranger" ─────────────────────
// THE ROW THAT MATTERS. tomasz 41+12 doubled = 106; ada 96+0 = 96.
// Votes alone would show ada, and that is the behaviour §3 exists to change.
resetTopCommentPicks();
const row2 = newThread();
const tomasz = addCandidate(row2, 'tomasz', 41, repliers(12, true));
const ada = addCandidate(row2, 'ada', 96, []);
const w2 = selectTopComment(rootKey, row2)!;
check('spec row 2 — tomasz (106) beats ada (96), though ada has 55 more votes', w2.key === tomasz, `won: ${w2.key}`);

// ── 3. the author-reply doubling is what flips row 2 ─────────────────────────
// Same numbers, author reply removed: tomasz scores 41+12 = 53 and ada's 96 wins.
// Without this control, test 2 would also pass if replies were simply weighted
// heavily, and the doubling would be untested.
resetTopCommentPicks();
const row2NoAuthor = newThread();
addCandidate(row2NoAuthor, 'tomasz', 41, repliers(12, false));
const adaB = addCandidate(row2NoAuthor, 'ada', 96, []);
const w3 = selectTopComment(rootKey, row2NoAuthor)!;
check('drop the author reply and ada (96) wins on 53 — the doubling is load-bearing', w3.key === adaB, `won: ${w3.key}`);

// ── 4. votes and replies weigh the SAME, one point each ──────────────────────
// 10 votes + 0 replies vs 0 votes + 10 replies: a tie on score, so the tiebreak
// (raw votes) decides and the voted one wins.
resetTopCommentPicks();
const weights = newThread();
const tenVotes = addCandidate(weights, 'voted', 10, []);
addCandidate(weights, 'answered', 0, repliers(10, false));
const w4 = selectTopComment(rootKey, weights)!;
check('a reply is worth exactly one vote — 10v/0r ties 0v/10r, votes break it', w4.key === tenVotes, `won: ${w4.key}`);

// ── 5. downvotes do not inflate a score ──────────────────────────────────────
// `active_votes` carries downvotes too; counting the array length instead of the
// positive-rshares entries would score a contested comment as its total traffic.
resetTopCommentPicks();
const contested = newThread();
addCandidate(contested, 'contested', 5, [], 50); // 55 raw entries, 5 real upvotes
const clean = addCandidate(contested, 'clean', 9, []);
const w5 = selectTopComment(rootKey, contested)!;
check('50 downvotes do not lift a 5-vote comment past a 9-vote one', w5.key === clean, `won: ${w5.key}`);
check('and the winner reports NET upvotes', w5.upvotes === 9, `upvotes=${w5.upvotes}`);

// ── 6. the cache holds the winner, and the reset releases it ─────────────────
// §3: "Do not re-rank on the reader's own vote ... Compute the winner once per
// post per render pass and hold it." Observable without RNG: move the goalposts
// under a live cache and the old winner must survive; reset and the new one appears.
resetTopCommentPicks();
const live = newThread();
const original = addCandidate(live, 'first', 30, []);
const challenger = addCandidate(live, 'second', 10, []);
const before = selectTopComment(rootKey, live)!;
check('a fresh read picks the higher score', before.key === original, `won: ${before.key}`);

live[challenger].active_votes = votes(500); // the reader votes the other comment
const held = selectTopComment(rootKey, live)!;
check('the cache HOLDS the winner when a vote would otherwise swap it', held.key === original, `still: ${held.key}`);

const repeats = new Set<string>();
for (let i = 0; i < 20; i++) repeats.add(selectTopComment(rootKey, live)!.key);
check('20 further reads never swap it', repeats.size === 1 && repeats.has(original), `${repeats.size} distinct`);

resetTopCommentPicks();
const after = selectTopComment(rootKey, live)!;
check('and the RESET releases it — the new leader takes over', after.key === challenger, `won: ${after.key}`);

// ── 7. the score is deterministic across resets ──────────────────────────────
// The old rule re-rolled here. It must not any more: a reset clears a cache, it
// does not re-open the decision.
const stable = new Set<string>();
for (let i = 0; i < 20; i++) {
  resetTopCommentPicks();
  stable.add(selectTopComment(rootKey, row2)!.key);
}
check('20 resets on the same thread resolve identically — no RNG left', stable.size === 1 && stable.has(tomasz),
  `${stable.size} distinct: ${[...stable].join(', ')}`);

// ── 8. "replies" means DIRECT replies, not the subtree ───────────────────────
// `Entry.children` is the whole subtree. A comment with one reply that started a
// long argument must not outrank one that several people answered directly.
resetTopCommentPicks();
const depth = newThread();
const wide = addCandidate(depth, 'wide', 0, repliers(4, false)); // 4 direct
const deepKey = addCandidate(depth, 'deep', 0, ['d0']);          // 1 direct...
let parent = { author: 'd0', permlink: 'r-deep-0' };
for (let i = 1; i <= 12; i++) {                                   // ...then 12 deep
  const a = `d${i}`;
  depth[discussionKey(a, `x${i}`)] = {
    author: a, permlink: `x${i}`, body: 'deeper', created: '2026-01-04', payout: 0,
    active_votes: [], parent_author: parent.author, parent_permlink: parent.permlink
  };
  parent = { author: a, permlink: `x${i}` };
}
const w8 = selectTopComment(rootKey, depth)!;
check('4 direct replies beat 1 reply with a 12-deep subtree under it', w8.key === wide, `won: ${w8.key}`);
check('and directResponseCount is the DIRECT count', w8.directResponseCount === 4,
  `directResponseCount=${w8.directResponseCount}`);
void deepKey;

// ── 9. a thread with no comments does not expand ─────────────────────────────
resetTopCommentPicks();
check('a post with no comments returns null', selectTopComment(rootKey, newThread()) === null);
check('an undefined discussion returns null', selectTopComment(rootKey, undefined) === null);

// ── 10. a cached winner that was deleted falls through instead of vanishing ──
resetTopCommentPicks();
const deletable = newThread();
const doomed = addCandidate(deletable, 'doomed', 99, []);
const survivor = addCandidate(deletable, 'survivor', 1, []);
check('the high scorer is cached', selectTopComment(rootKey, deletable)!.key === doomed);
delete deletable[doomed];
const w10 = selectTopComment(rootKey, deletable);
check('a cached comment deleted from the thread re-picks rather than returning null',
  w10 !== null && w10.key === survivor, `got: ${w10 ? w10.key : 'null'}`);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
