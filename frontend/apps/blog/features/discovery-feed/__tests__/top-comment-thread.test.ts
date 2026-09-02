/**
 * The post card's descendant-thread derivation: the pure walk that turns the
 * block-filtered discussion map into the ordered, depth-tagged reply list the
 * drawer renders beneath the top comment. Plain assertions, no test runner (this
 * repo has none; same shape as `top-comment-picks.test.ts`).
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node -T -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     features/discovery-feed/__tests__/top-comment-thread.test.ts
 *
 * `-T` (transpile only) is required for the same reason `top-comment-picks.test.ts`
 * documents: `lib/top-comment-thread.ts` imports its `Entry` TYPE from
 * `@hive/common-hiveio-packages/wax` (erased under `-T`) and otherwise only pure
 * local code — it does NOT import `@ui/lib/utils`/`parseAsset`, precisely so this
 * test loads without Next's module graph. Types are still checked by
 * `tsc --noEmit`, which covers this file.
 */
import {
  deriveThread,
  MAX_VISUAL_DEPTH,
  THREAD_INLINE_CAP,
  THREAD_VIRTUALIZE_THRESHOLD
} from '../lib/top-comment-thread';
import { discussionKey } from '../lib/top-comment';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const TOP_AUTHOR = 'topauthor';
const TOP_PERMLINK = 'tc';
const topKey = discussionKey(TOP_AUTHOR, TOP_PERMLINK);

type Map_ = Record<string, any>;

interface Opt {
  payout?: string;
  rshares?: number;
  gray?: boolean;
  created?: string;
}

/** A discussion map seeded with just the top comment (no root post needed). */
function newThread(): Map_ {
  return {
    [topKey]: { author: TOP_AUTHOR, permlink: TOP_PERMLINK, body: 'the top comment', created: '2026-01-01' }
  };
}

function reply(map: Map_, author: string, permlink: string, parentA: string, parentP: string, o: Opt = {}): string {
  const key = discussionKey(author, permlink);
  map[key] = {
    author,
    permlink,
    body: `reply by ${author}`,
    created: o.created ?? '2026-01-02',
    parent_author: parentA,
    parent_permlink: parentP,
    active_votes: [],
    pending_payout_value: o.payout ?? '0.000 HBD',
    author_payout_value: '0.000 HBD',
    curator_payout_value: '0.000 HBD',
    net_rshares: o.rshares ?? 0,
    stats: { gray: o.gray ?? false }
  };
  return key;
}

console.log('top-comment thread derivation');

// ── 0. a real choice to make ─────────────────────────────────────────────────
const guard = newThread();
reply(guard, 'a', 'r1', TOP_AUTHOR, TOP_PERMLINK);
reply(guard, 'b', 'r2', TOP_AUTHOR, TOP_PERMLINK);
check('the fixture offers more than one reply', Object.keys(guard).length - 1 >= 2);

// ── 1. zero replies to the top comment ───────────────────────────────────────
const none = newThread();
const d0 = deriveThread(none, topKey);
check('0 replies -> no nodes', d0.nodes.length === 0, `nodes=${d0.nodes.length}`);
check('0 replies -> total 0, not truncated', d0.total === 0 && d0.truncated === false);

// ── 2. one reply ─────────────────────────────────────────────────────────────
const one = newThread();
const only = reply(one, 'solo', 'x', TOP_AUTHOR, TOP_PERMLINK);
const d1 = deriveThread(one, topKey);
check('1 reply -> exactly 1 node', d1.nodes.length === 1, `nodes=${d1.nodes.length}`);
check('the one reply is depth 1 (direct)', d1.nodes[0].depth === 1, `depth=${d1.nodes[0].depth}`);
check('the one reply is isLast', d1.nodes[0].isLast === true);
check('a single reply has no replyingToAuthor', d1.nodes[0].replyingToAuthor === undefined);
check('the node carries the right key', d1.nodes[0].key === only);

// ── 3. trending sort of a sibling group + deterministic key tiebreak ──────────
// gray demoted last (despite highest payout); then payout desc; ties -> rshares;
// then the immutable key. Mirrors lib/sorter.ts:19-28 + the added key tiebreak.
const sibs = newThread();
reply(sibs, 'r', 'gray', TOP_AUTHOR, TOP_PERMLINK, { payout: '100.000 HBD', gray: true });
reply(sibs, 'r', 'lo', TOP_AUTHOR, TOP_PERMLINK, { payout: '5.000 HBD' });
reply(sibs, 'r', 'hi2', TOP_AUTHOR, TOP_PERMLINK, { payout: '10.000 HBD', rshares: 100 });
reply(sibs, 'r', 'hi1', TOP_AUTHOR, TOP_PERMLINK, { payout: '10.000 HBD', rshares: 100 });
const d3 = deriveThread(sibs, topKey);
const order3 = d3.nodes.map((n) => n.key);
check(
  'trending order: hi1, hi2 (payout 10, key tiebreak), lo (5), gray last',
  JSON.stringify(order3) === JSON.stringify(['r/hi1', 'r/hi2', 'r/lo', 'r/gray']),
  order3.join(', ')
);
check('only the last sibling is isLast', d3.nodes[3].isLast === true && d3.nodes.slice(0, 3).every((n) => !n.isLast));

// ── 4. determinism: identical order across repeated derivations ───────────────
const orderA = deriveThread(sibs, topKey).nodes.map((n) => n.key).join(',');
const orderB = deriveThread(sibs, topKey).nodes.map((n) => n.key).join(',');
check('two derivations of the same map produce the identical order', orderA === orderB, orderA);

// ── 5. nesting: pre-order flatten with incrementing depth ────────────────────
// top -> p (depth1) -> c (depth2) -> g (depth3); and a sibling q (depth1) after.
const nest = newThread();
const p = reply(nest, 'p', 'p1', TOP_AUTHOR, TOP_PERMLINK, { payout: '2.000 HBD' });
const c = reply(nest, 'c', 'c1', 'p', 'p1');
const g = reply(nest, 'g', 'g1', 'c', 'c1');
const q = reply(nest, 'q', 'q1', TOP_AUTHOR, TOP_PERMLINK, { payout: '1.000 HBD' });
const d5 = deriveThread(nest, topKey);
const preorder = d5.nodes.map((n) => `${n.key}@${n.depth}`);
check(
  'pre-order DFS with depths: p(1) c(2) g(3) then sibling q(1)',
  JSON.stringify(preorder) === JSON.stringify([`${p}@1`, `${c}@2`, `${g}@3`, `${q}@1`]),
  preorder.join(', ')
);
check('total counts every descendant', d5.total === 4, `total=${d5.total}`);

// ── 6. depth cap: replyingToAuthor set only beyond MAX_VISUAL_DEPTH ──────────
// Build a single chain deeper than the cap and confirm the FIRST node past the
// cap carries replyingToAuthor = its parent's chain author, and shallower ones
// do not. The recursion continues (nodes keep appearing); only the label/indent
// change is the cap's job.
const deep = newThread();
let pa = TOP_AUTHOR;
let pp = TOP_PERMLINK;
const chainKeys: string[] = [];
for (let level = 1; level <= MAX_VISUAL_DEPTH + 2; level++) {
  const a = `lvl${level}`;
  const k = reply(deep, a, `d${level}`, pa, pp);
  chainKeys.push(k);
  pa = a;
  pp = `d${level}`;
}
const d6 = deriveThread(deep, topKey);
check('the whole chain is present past the cap', d6.nodes.length === MAX_VISUAL_DEPTH + 2, `nodes=${d6.nodes.length}`);
const atCap = d6.nodes.find((n) => n.depth === MAX_VISUAL_DEPTH)!;
const pastCap = d6.nodes.find((n) => n.depth === MAX_VISUAL_DEPTH + 1)!;
check('at the cap, no replyingToAuthor', atCap.replyingToAuthor === undefined, `depth ${MAX_VISUAL_DEPTH}`);
check(
  'past the cap, replyingToAuthor = the parent chain author',
  pastCap.replyingToAuthor === `lvl${MAX_VISUAL_DEPTH}`,
  `got: ${pastCap.replyingToAuthor}`
);

// ── 7. pointer-cycle guard: a malformed self/loop parent must terminate ──────
const cyc = newThread();
const n1 = reply(cyc, 'x', 'n1', TOP_AUTHOR, TOP_PERMLINK);
// make n2 point at n1, and then corrupt n1 to also point at n2 (a 2-cycle).
const n2 = reply(cyc, 'x', 'n2', 'x', 'n1');
cyc[n1].parent_author = 'x';
cyc[n1].parent_permlink = 'n2';
// n1 is now BOTH a child of the top comment (by the childrenOf pass it was indexed
// under top) AND part of a cycle; the visited-set must stop infinite recursion.
const d7 = deriveThread(cyc, topKey);
check('a parent-pointer cycle terminates', Array.isArray(d7.nodes), `nodes=${d7.nodes.length}`);
check('the cycle guard yields no duplicate keys', new Set(d7.nodes.map((n) => n.key)).size === d7.nodes.length);
void n2;

// ── 8. virtualization: total > threshold -> head slice + truncated ───────────
const many = newThread();
const N = THREAD_VIRTUALIZE_THRESHOLD + 5;
for (let i = 0; i < N; i++) {
  // zero-padded permlink so lexicographic key order is the natural order
  reply(many, 'm', `p${String(i).padStart(3, '0')}`, TOP_AUTHOR, TOP_PERMLINK);
}
const d8 = deriveThread(many, topKey);
check(`over ${THREAD_VIRTUALIZE_THRESHOLD} nodes -> truncated`, d8.truncated === true);
check('truncated to the inline cap', d8.nodes.length === THREAD_INLINE_CAP, `nodes=${d8.nodes.length}`);
check('total still reports the full count', d8.total === N, `total=${d8.total}`);

// small thread is NOT truncated
const few = newThread();
for (let i = 0; i < THREAD_VIRTUALIZE_THRESHOLD; i++) reply(few, 'f', `p${i}`, TOP_AUTHOR, TOP_PERMLINK);
const d8b = deriveThread(few, topKey);
check(`exactly ${THREAD_VIRTUALIZE_THRESHOLD} nodes is NOT truncated`, d8b.truncated === false && d8b.nodes.length === THREAD_VIRTUALIZE_THRESHOLD);

// custom thresholds honoured
const d8c = deriveThread(few, topKey, { inlineCap: 3, virtualizeThreshold: 2 });
check('custom thresholds slice to the given cap', d8c.truncated === true && d8c.nodes.length === 3);

// ── 9. robustness: a missing depth field does not matter (depth is walked) ────
const noDepthField = newThread();
const nd1 = reply(noDepthField, 'z', 'z1', TOP_AUTHOR, TOP_PERMLINK);
reply(noDepthField, 'z', 'z2', 'z', 'z1');
// none of the fixture entries ever set `depth`, yet:
const d9 = deriveThread(noDepthField, topKey);
check('depths are computed by the walk with no `depth` field present', d9.nodes[0].depth === 1 && d9.nodes[1].depth === 2, d9.nodes.map((n) => n.depth).join(','));
void nd1;

// ── 10. guards: undefined map / absent top comment ───────────────────────────
check('undefined map -> empty', deriveThread(undefined, topKey).nodes.length === 0);
check('a top-comment key not in the map -> empty', deriveThread(newThread(), 'ghost/nope').nodes.length === 0);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
