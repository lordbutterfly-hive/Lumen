/**
 * F4 — PART 2 of the runtime proof: run the REAL filtering code, not a
 * reimplementation, in a brand-new Node process (no dev-server restart
 * involved — this process's own `process.env` is set at its own start-up,
 * which is exactly how `packages/ui/config/lists/banned-authors.ts` is
 * documented to read `REACT_APP_BANNED_AUTHORS` server-side: plain
 * `process.env`, not the browser's `window.__ENV` snapshot).
 *
 * Input: the REAL discussion payload captured live from the running server in
 * `bpcvoter-ban-proof.mjs` Part 1 (22 bpcvoter* nodes out of 79 total, in the
 * POB thread, BEFORE this fix's config is live).
 *
 * Proves: with `apps/blog/.env.local`'s NEW list applied, the exact same
 * `withoutBannedDiscussion` function the server calls removes every bpcvoter*
 * node AND repairs every surviving parent's `replies` pointer — the same
 * acceptance bar `qa/harness/block-proof.mjs` uses for the block feature.
 *
 * Run: pnpm exec ts-node qa/harness/bpcvoter-ban-module-proof.ts
 * (from repo root — ts-node lives in the repo root node_modules)
 */

// Set BEFORE importing the module under test: `bannedSet()` in
// banned-authors.ts is lazily resolved and memoised on first call, so this
// must land before any predicate runs — see that file's own comment on why.
process.env.REACT_APP_BANNED_AUTHORS =
  'kgakakillerg, bpcvoter, bpcvoter1, bpcvoter2, bpcvoter3, bpcvoter4';

import { readFileSync } from 'node:fs';
// eslint-disable-next-line @typescript-eslint/no-var-requires
import {
  withoutBannedDiscussion,
  isBannedAuthor,
  bannedAuthorList
} from '../../packages/ui/config/lists/banned-authors';

const DUMP_PATH =
  '/tmp/claude-1004/-home-clauderfly/7a75b7b2-e72e-4770-80f8-965e167e7e8d/scratchpad/pob-discussion-captured.json';
const BPCVOTER = /^bpcvoter[0-9]*$/;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, evidence?: string) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}${evidence ? `  — ${evidence}` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${evidence ? `  — ${evidence}` : ''}`);
  }
}
function section(t: string) {
  console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);
}

section('0. THE REAL MODULE, WITH THE NEW LIST, IN A FRESH PROCESS');
console.log(`  Resolved ban list: ${bannedAuthorList().join(', ')}`);
check(
  'the real predicate now bans every bpcvoter* account',
  ['bpcvoter', 'bpcvoter1', 'bpcvoter2', 'bpcvoter3', 'bpcvoter4'].every((n) => isBannedAuthor(n)),
  'isBannedAuthor() true for all 5'
);
check(
  'the real predicate leaves an unrelated name alone',
  !isBannedAuthor('lordbutterfly'),
  'isBannedAuthor("lordbutterfly") === false'
);

section('1. THE CAPTURED, REAL, PRE-BAN DISCUSSION PAYLOAD');
const raw = JSON.parse(readFileSync(DUMP_PATH, 'utf8')) as Record<
  string,
  { author: string; permlink: string; replies?: unknown[] }
>;
const beforeKeys = Object.keys(raw);
const beforeBpcvoterKeys = beforeKeys.filter((k) => BPCVOTER.test(raw[k].author));
console.log(`  ${beforeKeys.length} total entries, ${beforeBpcvoterKeys.length} bpcvoter*-authored.`);
check(
  'the captured data is non-empty and not vacuous',
  beforeKeys.length > 0 && beforeBpcvoterKeys.length > 0,
  `${beforeKeys.length} entries, ${beforeBpcvoterKeys.length} bpcvoter*`
);

section('2. RUN THE REAL FILTER (same function the server calls)');
const filtered = withoutBannedDiscussion(raw) ?? {};
const afterKeys = Object.keys(filtered);
const afterBpcvoterKeys = afterKeys.filter((k) => BPCVOTER.test(filtered[k].author));

console.log(`  ${afterKeys.length} entries remain (was ${beforeKeys.length}).`);
check(
  '★ every bpcvoter* comment node is gone',
  afterBpcvoterKeys.length === 0,
  `0 of ${beforeBpcvoterKeys.length} remain`
);
check(
  'exactly the bpcvoter*-authored nodes were removed (no over- or under-pruning of unrelated authors)',
  beforeKeys.length - afterKeys.length === beforeBpcvoterKeys.length,
  `removed ${beforeKeys.length - afterKeys.length} nodes vs ${beforeBpcvoterKeys.length} bpcvoter*-authored nodes ` +
    `(equal means no legitimate commenter's subtree was caught in the crossfire, and no bpcvoter subtree survived)`
);

// ★ No surviving entry's `replies` array may still point at a removed key — the
// exact dangling-reference class `block-proof.mjs` checks for the block feature.
const danglingRefs = afterKeys.flatMap((k) =>
  (Array.isArray(filtered[k].replies) ? (filtered[k].replies as unknown[]) : [])
    .filter((ref): ref is string => typeof ref === 'string')
    .filter((ref) => !(ref in filtered))
);
check(
  '★ no surviving parent still points at a removed bpcvoter* child (replies array repaired)',
  danglingRefs.length === 0,
  danglingRefs.length ? `dangling: ${JSON.stringify(danglingRefs.slice(0, 5))}` : 'clean'
);

check(
  'sanity: kgakakillerg (already-banned) is still absent — the union with the new names did not break the existing ban',
  !afterKeys.some((k) => filtered[k].author === 'kgakakillerg'),
  'confirmed'
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
