/**
 * comment-order: the vote case, the sort-change case and the new-reply case.
 * Run:  npx tsx apps/blog/lib/comment-order.selftest.ts
 */
import type { Entry } from '@hive/common-hiveio-packages/wax';
import { orderComments, commentKeyOf, type CommentOrderState } from './comment-order';
import { SortOrder } from './sorter';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (ok) { pass += 1; console.log('PASS ', name); }
  else { fail += 1; console.log('FAIL ', name, got === undefined ? '' : JSON.stringify(got)); }
}

const mk = (author: string, payout: number, rshares = payout * 1000): Entry =>
  ({
    author,
    permlink: `p-${author}`,
    pending_payout_value: `${payout.toFixed(3)} HBD`,
    author_payout_value: '0.000 HBD',
    curator_payout_value: '0.000 HBD',
    net_rshares: rshares,
    active_votes: [],
    created: `2026-09-0${(author.charCodeAt(0) % 9) + 1}T00:00:00`,
    stats: { gray: false }
  }) as unknown as Entry;

const keys = (l: Entry[]) => l.map(commentKeyOf);

// ── 1. FIRST RENDER: a plain trending sort ───────────────────────────────────
const first = [mk('anna', 1), mk('bob', 5), mk('cara', 3)];
const r1 = orderComments(first, SortOrder.trending, null);
check('first render sorts by payout, highest first',
  keys(r1.ordered).join(',') === 'bob/p-bob,cara/p-cara,anna/p-anna', keys(r1.ordered));

// ── 2. THE VOTE CASE: anna's payout overtakes everyone, order must NOT move ──
const afterVote = [mk('anna', 99), mk('bob', 5), mk('cara', 3)];
const r2 = orderComments(afterVote, SortOrder.trending, r1.state);
check('an upvote does NOT re-rank the list the reader is on',
  keys(r2.ordered).join(',') === 'bob/p-bob,cara/p-cara,anna/p-anna', keys(r2.ordered));
check('a fresh sort of the same data WOULD have moved it (the bug this prevents)',
  keys(orderComments(afterVote, SortOrder.trending, null).ordered)[0] === 'anna/p-anna');

// ── 3. SORT CHANGED: the reader asked a different question, re-rank ──────────
const r3 = orderComments(afterVote, SortOrder.new, r2.state);
check('changing the sort DOES re-rank',
  keys(r3.ordered).join(',') !== keys(r2.ordered).join(','), keys(r3.ordered));

// ── 4. A NEW REPLY ARRIVES: everyone already on screen keeps their place ─────
const withNew = [...afterVote, mk('dave', 4)];
const r4 = orderComments(withNew, SortOrder.trending, r2.state);
const withoutDave = keys(r4.ordered).filter((k) => k !== 'dave/p-dave');
check('a new comment does not disturb the comments already on screen',
  withoutDave.join(',') === 'bob/p-bob,cara/p-cara,anna/p-anna', withoutDave);
check('the new comment is placed where a fresh sort puts it (payout 4: under bob 5, over cara 3)',
  keys(r4.ordered).join(',') === 'bob/p-bob,dave/p-dave,cara/p-cara,anna/p-anna', keys(r4.ordered));

// ── 5. A NEW TOP COMMENT still lands at the top ─────────────────────────────
const withTop = [...afterVote, mk('zoe', 1000)];
const r5 = orderComments(withTop, SortOrder.trending, r2.state);
check('a new comment that outranks everything lands first',
  keys(r5.ordered)[0] === 'zoe/p-zoe', keys(r5.ordered));

// ── 6. A COMMENT LEAVES: the rest keep their order ─────────────────────────
const minusCara = afterVote.filter((c) => c.author !== 'cara');
const r6 = orderComments(minusCara, SortOrder.trending, r2.state);
check('removing a comment leaves the others in place',
  keys(r6.ordered).join(',') === 'bob/p-bob,anna/p-anna', keys(r6.ordered));

// ── 7. STABILITY: repeated recomputes on unchanged data are a fixed point ───
let st: CommentOrderState | null = r2.state;
let last = keys(r2.ordered).join(',');
for (let i = 0; i < 5; i += 1) {
  const r = orderComments(afterVote, SortOrder.trending, st);
  st = r.state;
  if (keys(r.ordered).join(',') !== last) { last = 'DRIFTED'; break; }
}
check('five recomputes on unchanged data do not drift', last !== 'DRIFTED', last);

console.log(`\n==== ${pass} pass / ${fail} fail ====`);
process.exit(fail === 0 ? 0 : 1);
