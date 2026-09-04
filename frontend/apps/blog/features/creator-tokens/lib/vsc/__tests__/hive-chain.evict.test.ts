/**
 * Behavioural test for getCreatorTokensHiveChain's EVICT-ON-REJECT (2026-09-04).
 *
 * This app has no unit-test runner (only ts-node assertion scripts + Playwright),
 * so this follows the repo convention of lib/__tests__/server-ttl-cache.test.ts:
 * plain asserts, exit 0 on pass / 1 on failure.
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     features/creator-tokens/lib/vsc/__tests__/hive-chain.evict.test.ts
 *
 * WHY THIS WORKS: @hiveio/wax cannot be resolved under ts-node's CJS resolver
 * (its package exports are ESM-only), so the internal `await import('@hiveio/wax')`
 * inside getCreatorTokensHiveChain REJECTS - which is exactly the transient
 * failure path (network blip / stale-chunk 404 after deploy) the fix guards.
 *
 * WHAT IS PROVEN:
 *   1. A misconfigured override (missing api/chain) rejects loudly.
 *   2. When a key's first load rejects, the cache EVICTS it, so a retry makes a
 *      FRESH attempt (a distinct rejection object) instead of replaying the one
 *      cached rejection forever (the bug: a poisoned cache bricks every Meritum
 *      sign on that key until a full reload).
 */
import { getCreatorTokensHiveChain } from '../hive-chain';

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (cond) {
    console.log('  ok   -', msg);
  } else {
    failures++;
    console.error('  FAIL -', msg);
  }
}

async function main(): Promise<void> {
  // 1. misconfiguration guard
  let misconfigRejected = false;
  try {
    await getCreatorTokensHiveChain({ apiEndpoint: '', chainId: '' });
  } catch {
    misconfigRejected = true;
  }
  check(misconfigRejected, 'misconfigured override (empty api/chain) rejects loudly');

  // 2. evict-on-reject
  const override = { apiEndpoint: 'https://example.invalid/', chainId: 'evict-test-chain' };
  const e1 = await getCreatorTokensHiveChain(override).then(() => null, (e) => e);
  check(e1 !== null, 'first load rejects (wax import unavailable under ts-node)');
  // let the .catch eviction microtask run
  await Promise.resolve();
  await Promise.resolve();
  const e2 = await getCreatorTokensHiveChain(override).then(() => null, (e) => e);
  check(e2 !== null, 'retry also rejects (import still unavailable)');
  check(
    e1 !== e2,
    'EVICTED: retry produced a FRESH rejection object, not the cached one (proves evict-on-reject; without it both calls share one poisoned promise and e1 === e2)'
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nall checks passed');
  process.exit(0);
}

void main();
