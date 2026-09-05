/**
 * `account-posts-seed-cache` residency invariants — plain assertions, no test
 * runner (this repo has none; same style as lib/feed/posts-prefetch-budget.test.ts
 * and lib/__tests__/server-ttl-cache.test.ts).
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/feed/account-posts-seed-cache.test.ts
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 *
 * WHY THIS EXISTS. This cache had the same residency bug `server-ttl-cache.ts`
 * did, and it is the harder one to notice: entries are only ~127 KB each, so
 * nothing looks wrong until you multiply by a 300 cap and three cluster workers
 * (~38 MB per worker of pages that expired five minutes ago). Removal used to
 * happen only on a READ past the TTL or at the cap, and crawler traffic over
 * distinct accounts never re-reads a key, so the map simply filled and stayed
 * full. The three ways the fix can silently die are (a) the sweep deleting a
 * FRESH seed, which would cost real cache hits on the profile SSR path and show
 * up only as upstream load, (b) the sweep replacing rather than supplementing the
 * hard cap, which would unbound the map whenever nothing has expired, and (c) the
 * counters drifting from the map, which would make `/api/debug/mem` lie.
 *
 * ★ TIME IS INJECTED, NOT MOCKED, because the TTL is five MINUTES — see the
 * `now` parameter's own note in the module. The read path already took one.
 */
import {
  ACCOUNT_POSTS_SEED_MAX,
  ACCOUNT_POSTS_SEED_MS,
  accountPostsSeedStats,
  anonymousAccountPostsSeed,
  rememberAccountPostsSeed,
  resetAccountPostsSeedCache
} from './account-posts-seed-cache';

let checks = 0;
let failures = 0;
const lines: string[] = [];

function out(s: string): void {
  lines.push(s);
}

function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) {
    failures++;
    out(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(name: string): void {
  out(`\n${name}`);
}

/**
 * The cache only ever inspects `entries.length`, so a marker object is enough.
 *
 * ★ TYPED `never[]`, NOT `Entry[]`, AND THAT IS A TEST-HARNESS CONSTRAINT RATHER
 * THAN A STYLE CHOICE. Importing the wax `Entry` type here would make ts-node
 * resolve `@hive/common-hiveio-packages/wax`, and this suite runs under
 * `moduleResolution: node`, which cannot read that package's `exports` subpaths
 * (the module under test only `import type`s it, so it is erased there and never
 * resolved). `never[]` is assignable to every array type, so the calls below
 * type-check against the real signature exactly as production does — verified by
 * the project-wide `tsc --noEmit`, which DOES resolve wax properly.
 */
const seed = (tag: string): never[] => [{ author: tag }] as unknown as never[];

const HALF = Math.floor(ACCOUNT_POSTS_SEED_MAX / 2); // 150

function main(): void {
  // ── 1. the pre-existing contract ──────────────────────────────────────────
  section('1. pre-existing contract');
  {
    resetAccountPostsSeedCache();
    const T = 1_000_000;
    rememberAccountPostsSeed('blog', 'alice', seed('a'), T);
    check('a written seed reads back', anonymousAccountPostsSeed('blog', 'alice', T) !== null);
    check('an empty seed is never stored', (rememberAccountPostsSeed('blog', 'bob', [], T), anonymousAccountPostsSeed('blog', 'bob', T) === null));
    check('a key past the TTL reads as a miss', anonymousAccountPostsSeed('blog', 'alice', T + ACCOUNT_POSTS_SEED_MS) === null);
    check('the account is case-folded in the key', anonymousAccountPostsSeed('blog', 'ALICE', T) !== null);
  }

  // ── 2. the sweep ──────────────────────────────────────────────────────────
  section('2. the expiry sweep');
  {
    // 2a. ★ A FRESH SEED IS NEVER SWEPT. Every entry here is written at the same
    //     instant and read back at that instant, so a correct sweep frees nothing
    //     however often it runs — and it does run, which the first check proves.
    resetAccountPostsSeedCache();
    const T = 1_000_000;
    for (let i = 0; i < HALF + 10; i++) rememberAccountPostsSeed('blog', `fresh${i}`, seed(`f${i}`), T);
    const st = accountPostsSeedStats();
    check('sweeps DID run (past max/2), so the check is not vacuous', st.sweeps > 0, JSON.stringify(st));
    check('★ but no fresh seed is swept', st.swept === 0, JSON.stringify(st));
    check('and none was evicted either (well under the cap)', st.evictions === 0, JSON.stringify(st));
    check('all of them are resident', st.size === HALF + 10, JSON.stringify(st));
    check('and a sample still reads back', anonymousAccountPostsSeed('blog', 'fresh0', T) !== null);
  }
  {
    // 2b. ★★ THE BUG ITSELF. Fill past max/2, move the clock beyond the TTL, then
    //     write once. Before the sweep that write reclaimed NOTHING and the 160
    //     dead seeds sat there until the cap evicted them one by one, hundreds of
    //     writes later. Now the single write frees them down to max/2.
    resetAccountPostsSeedCache();
    const T = 1_000_000;
    for (let i = 0; i < HALF + 10; i++) rememberAccountPostsSeed('blog', `old${i}`, seed(`o${i}`), T);
    const before = accountPostsSeedStats();
    check('precondition: the map is past max/2 and holds only dead-to-be seeds', before.size === HALF + 10, JSON.stringify(before));

    const LATER = T + ACCOUNT_POSTS_SEED_MS + 1;
    rememberAccountPostsSeed('blog', 'brandnew', seed('n'), LATER);
    const st = accountPostsSeedStats();
    check('★★ the expired seeds are reclaimed on write', st.swept === 10, JSON.stringify(st));
    check('★★ down to max/2, plus the new entry', st.size === HALF + 1, JSON.stringify(st));
    check('★★ and the cap never had to evict a thing', st.evictions === 0, JSON.stringify(st));
    check('the new seed is readable', anonymousAccountPostsSeed('blog', 'brandnew', LATER) !== null);
  }
  {
    // 2c. THE HARD BOUND IS UNCHANGED. The sweep supplements insertion-order
    //     eviction, it does not replace it: with nothing expired there is nothing
    //     to reclaim, and the cap alone must still keep the map finite. This is
    //     what makes the cache safe against a crawler at any TTL.
    resetAccountPostsSeedCache();
    const T = 1_000_000;
    const OVER = 100;
    for (let i = 0; i < ACCOUNT_POSTS_SEED_MAX + OVER; i++) {
      rememberAccountPostsSeed('blog', `c${i}`, seed(`c${i}`), T);
    }
    const st = accountPostsSeedStats();
    check('size never exceeds the cap', st.size === ACCOUNT_POSTS_SEED_MAX, JSON.stringify(st));
    check('the overflow is counted as evictions', st.evictions === OVER, JSON.stringify(st));
    check('and nothing was swept (nothing had expired)', st.swept === 0, JSON.stringify(st));
    check('the oldest key is the one that went', anonymousAccountPostsSeed('blog', 'c0', T) === null);
    check('and the newest is still there', anonymousAccountPostsSeed('blog', `c${ACCOUNT_POSTS_SEED_MAX + OVER - 1}`, T) !== null);
  }
  {
    // 2d. THE COUNTERS TRACK THE MAP, so `/api/debug/mem` cannot quietly lie.
    resetAccountPostsSeedCache();
    const zero = accountPostsSeedStats();
    check('reset clears size and every counter', zero.size === 0 && zero.sweeps === 0 && zero.swept === 0 && zero.evictions === 0, JSON.stringify(zero));
    check('this cache never loads, so inFlight is always 0', zero.inFlight === 0, JSON.stringify(zero));
    rememberAccountPostsSeed('blog', 'x', seed('x'), 1_000_000);
    check('size follows a write', accountPostsSeedStats().size === 1, JSON.stringify(accountPostsSeedStats()));
    resetAccountPostsSeedCache();
  }
}

main();
out('');
out(
  failures === 0
    ? `PASS — ${checks} checks, the sweep proven against fresh seeds and the hard cap`
    : `FAIL — ${failures} of ${checks} checks failed`
);
// eslint-disable-next-line no-console
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
