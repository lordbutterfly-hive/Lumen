/**
 * `rebloggedByCacheTimeMs` pins the server behaviour fixed in
 * `features/list-of-posts/hooks/use-reblogged-by-query.ts` (2026-09-06,
 * worker-memory build map R1): a finite `cacheTime` arms a GC `setTimeout`
 * in query-core's `Query` constructor, and on the server that pins the
 * whole per-render `QueryClient` (see that file's doc comment for the full
 * mechanism). Plain assertions, no test runner (same style as
 * lib/feed/posts-prefetch-budget.test.ts).
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/reblogged-by-cache-time.test.ts
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 *
 * WHY A HELPER INSTEAD OF THE HOOK ITSELF: `useRebloggedByQuery` calls
 * `useUserClient`, a React hook, so invoking it outside a component render
 * would be a rules-of-hooks violation. And `isServer` (from
 * `@tanstack/react-query`) is a module-level constant derived from `typeof
 * window`, not something a plain Node script can flip to also exercise the
 * client branch. `rebloggedByCacheTimeMs` is a tiny pure function of an
 * injected boolean, exported next to the hook for exactly this reason, and
 * the hook passes it `isServer` unchanged.
 */
import { rebloggedByCacheTimeMs } from '../features/list-of-posts/hooks/use-reblogged-by-query';

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    failures += 1;
  }
}

// 1. THE FIX ITSELF. On the server, cacheTime must be Infinity, so
//    query-core's `isValidTimeout` check fails and no setTimeout is ever
//    armed, so nothing keeps that render's QueryClient reachable.
check('server (isServer=true): cacheTime is Infinity', rebloggedByCacheTimeMs(true) === Infinity);

// 2. THE CLIENT IS UNCHANGED. Still the original 1 hour 5 seconds, so the
//    browser's long-lived QueryClient keeps remembering the answer for a
//    while, exactly as before this fix.
check(
  'client (isServer=false): cacheTime is 3,605,000ms (1 hour 5 seconds)',
  rebloggedByCacheTimeMs(false) === 3605000
);

// 3. NEGATIVE CONTROL. Prove the two branches actually differ, so checks 1
//    and 2 are not both vacuously passing against a single constant value.
check(
  'negative control: server and client values differ',
  rebloggedByCacheTimeMs(true) !== rebloggedByCacheTimeMs(false)
);

// 4. THE SERVER VALUE IS SPECIFICALLY REJECTED BY isValidTimeout, not just
//    "large". query-core's own check is `typeof value === 'number' &&
//    value >= 0 && value !== Infinity`, so Infinity is the one number that
//    disables the timer; anything merely huge (e.g. Number.MAX_SAFE_INTEGER)
//    would still arm a (very long) real setTimeout.
function isValidTimeoutLikeQueryCore(value: number): boolean {
  return typeof value === 'number' && value >= 0 && value !== Infinity;
}
check(
  'server value fails query-core isValidTimeout (no timer armed)',
  !isValidTimeoutLikeQueryCore(rebloggedByCacheTimeMs(true))
);
check(
  'client value passes query-core isValidTimeout (timer armed, as intended)',
  isValidTimeoutLikeQueryCore(rebloggedByCacheTimeMs(false))
);

if (failures === 0) {
  console.log('\nreblogged-by-cache-time: ALL CHECKS PASSED');
  process.exit(0);
} else {
  console.error(`\nreblogged-by-cache-time: ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
