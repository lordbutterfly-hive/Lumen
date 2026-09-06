/**
 * Proves the process-wide slots this build added (2026-09-06, module-copies
 * build map R1/R3/R5) actually behave like ONE store shared by two webpack
 * LAYERS, not two coincidentally-similar module-local ones — plain assertions,
 * no test runner, same style as `lib/feed/posts-prefetch-budget.test.ts`.
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/__tests__/module-copies-shared-slots.test.ts
 *
 * ★ `-r tsconfig-paths/register` IS NOT OPTIONAL HERE (2026-09-06 review fix
 * to this comment — the flag was already in `test:unit`'s own invocation, this
 * header just failed to say so): `server-ttl-cache.ts` imports
 * `@/blog/lib/cache-registry` by path alias, and that import is resolved at
 * RUNTIME the moment this file's `freshRequire` pulls it in — without the
 * flag active in the process, that `require` throws `MODULE_NOT_FOUND`.
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 *
 * ★ WHY `delete require.cache[...]` + a second `require` IS THE RIGHT
 * SIMULATION. Next's `rsc` and `instrument` webpack layers each compile this
 * file into its OWN module id with its OWN module-scope closure — same source,
 * two separate factory invocations, exactly what re-requiring a deleted cache
 * entry reproduces in plain Node. `Symbol.for` (not `Symbol()`) is what makes
 * the slot itself the SAME value across those two invocations, which is the one
 * thing this file cannot fake if the production code got it wrong: a module
 * using `Symbol()` here would still pass a naive "same object" check within one
 * `require`, but two independently-`require`d copies would get two DIFFERENT
 * symbols and silently stop sharing — which is exactly the class of bug R1/R3
 * fix and this file exists to catch a regression of.
 */
import Module from 'module';

let checks = 0;
let failures = 0;
const lines: string[] = [];

function out(s: string): void {
  lines.push(s);
}

function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (ok) {
    out(`  ok    ${name}`);
  } else {
    failures++;
    out(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(name: string): void {
  out(`\n${name}`);
}

/**
 * Force a fresh module factory invocation for `resolvedPath`, the same way a
 * second webpack layer gets its own closure over the same source. Must be
 * called with an ALREADY-RESOLVED path (via `require.resolve`), not a
 * specifier, so the cache key matches exactly.
 */
function freshRequire<T>(resolvedPath: string): T {
  delete require.cache[resolvedPath];
  return require(resolvedPath) as T;
}

type ServerTtlCacheModule = typeof import('../server-ttl-cache');
type CacheRegistryModule = typeof import('../cache-registry');
type PoolModule = typeof import('../lite/db/pool');

async function main(): Promise<void> {
  const serverTtlCachePath = require.resolve('../server-ttl-cache');
  const cacheRegistry = require('../cache-registry') as CacheRegistryModule;

  // ── R1: two fresh module copies of a NAMED cache share one store ──────────
  section('R1. server-ttl-cache.ts — named caches share one store across module copies');
  {
    cacheRegistry.resetCacheRegistry();

    const name = 'module-copies-test:shared-a';
    const modA = freshRequire<ServerTtlCacheModule>(serverTtlCachePath);
    let loadsA = 0;
    const cacheA = modA.withTtlCache(
      async (k: string): Promise<string> => {
        loadsA++;
        return `A#${loadsA}`;
      },
      (k: string) => k,
      { name, ttlMs: 10_000, max: 10 }
    );
    // The map's own test spec (R1): prime through `.set`, then prove the SECOND
    // fresh copy reads it back without ever calling its own loader.
    cacheA.set('k', 'primed-by-A');

    const modB = freshRequire<ServerTtlCacheModule>(serverTtlCachePath);
    let loadsB = 0;
    const cacheB = modB.withTtlCache(
      async (k: string): Promise<string> => {
        loadsB++;
        return `B#${loadsB}`;
      },
      (k: string) => k,
      { name, ttlMs: 10_000, max: 10 }
    );

    check(
      'both fresh copies report size 1 for the one shared entry',
      cacheA.stats().size === 1 && cacheB.stats().size === 1,
      JSON.stringify([cacheA.stats(), cacheB.stats()])
    );

    const readViaB = await cacheB('k');
    check('the SECOND copy reads the value the FIRST copy primed', readViaB === 'primed-by-A', readViaB);
    check('and never invoked its own loader to get it', loadsB === 0, `loadsB=${loadsB}`);

    const readViaA = await cacheA('k');
    check('reading it back via the FIRST copy agrees', readViaA === 'primed-by-A', readViaA);

    const stats = cacheRegistry.allCacheStats()[name];
    check('the registry sees exactly 2 copies registered under this name', stats?.copies === 2, JSON.stringify(stats));
    check(
      '★ and reports `shared: true` — one store seen twice, not two stores summed',
      stats?.shared === true,
      JSON.stringify(stats)
    );
    check(
      '★★ and `size` is 1, NOT 2 — a doubled reading would mean the registry is ' +
        'still summing two identical copies of one shared Map (the pre-R4 bug)',
      stats?.size === 1,
      JSON.stringify(stats)
    );
  }

  // ── R1: a name collision with different options throws at module load ────
  section('R1. a second copy disagreeing on ttlMs/max throws rather than silently sharing');
  {
    const name = 'module-copies-test:mismatch';
    const modA = freshRequire<ServerTtlCacheModule>(serverTtlCachePath);
    modA.withTtlCache(async (k: string) => k, (k: string) => k, { name, ttlMs: 10_000, max: 10 });

    const modB = freshRequire<ServerTtlCacheModule>(serverTtlCachePath);
    let threw: unknown;
    try {
      // Same name, different `max` — must not silently adopt the existing store.
      modB.withTtlCache(async (k: string) => k, (k: string) => k, { name, ttlMs: 10_000, max: 999 });
    } catch (err) {
      threw = err;
    }
    check('a mismatched `max` under the same name throws', threw instanceof Error, String(threw));

    const modC = freshRequire<ServerTtlCacheModule>(serverTtlCachePath);
    let threwTtl: unknown;
    try {
      // Same name, different `ttlMs`.
      modC.withTtlCache(async (k: string) => k, (k: string) => k, { name, ttlMs: 5_000, max: 10 });
    } catch (err) {
      threwTtl = err;
    }
    check('a mismatched `ttlMs` under the same name also throws', threwTtl instanceof Error, String(threwTtl));
  }

  // ── R1: SAME-COPY collision with a DIFFERENT loader, MATCHING ttlMs/max ──
  //
  // ★★★ (2026-09-06 review fix) THE GAP THE ttlMs/max CHECK ABOVE CANNOT SEE.
  // Six of today's real named caches share {ttlMs: 30_000, max: 100}
  // (discussion, community, followList, followers, following, plus any
  // future one) — a typo'd or copy-pasted `name` colliding with one of those,
  // for a totally different loader, would sail straight through the ttlMs/max
  // check above and silently share ONE store between two unrelated caches.
  // This section proves the loader/keyOf identity guard catches exactly that,
  // and — just as importantly — that it does NOT fire for the legitimate
  // cross-copy case every other section here relies on.
  section('R1. a SAME-COPY name reuse for a DIFFERENT loader throws, even when ttlMs/max match');
  {
    const name = 'module-copies-test:same-copy-collision';
    const modA = freshRequire<ServerTtlCacheModule>(serverTtlCachePath);
    // First cache under this name in this (freshly required) copy.
    modA.withTtlCache(async (k: string) => `first:${k}`, (k: string) => k, { name, ttlMs: 30_000, max: 100 });

    let threw: unknown;
    try {
      // SAME copy (modA), SAME name, matching ttlMs/max, but a genuinely
      // DIFFERENT loader/keyOf — the shape a copy-paste mistake produces.
      modA.withTtlCache(async (k: string) => `second:${k}`, (k: string) => k, { name, ttlMs: 30_000, max: 100 });
    } catch (err) {
      threw = err;
    }
    check(
      'a second, different loader under the same name in the SAME copy throws at module load',
      threw instanceof Error,
      String(threw)
    );

    // Control: re-registering with the EXACT SAME loader/keyOf references
    // (not a fresh closure) must NOT throw — this is what makes the guard a
    // collision detector rather than a "name used more than once" ban.
    const sameLoader = async (k: string): Promise<string> => `idempotent:${k}`;
    const sameKeyOf = (k: string): string => k;
    const idempotentName = 'module-copies-test:same-loader-twice';
    modA.withTtlCache(sameLoader, sameKeyOf, { name: idempotentName, ttlMs: 30_000, max: 100 });
    let threwIdempotent: unknown;
    try {
      modA.withTtlCache(sameLoader, sameKeyOf, { name: idempotentName, ttlMs: 30_000, max: 100 });
    } catch (err) {
      threwIdempotent = err;
    }
    check('re-registering the IDENTICAL loader/keyOf reference under one name does not throw', threwIdempotent === undefined, String(threwIdempotent));

    // Control: the SAME name, SAME ttlMs/max, but from a SEPARATE fresh copy
    // (modB) with its OWN different loader — this is legitimate cross-copy
    // ADOPTION, not a collision, and must still succeed exactly like the
    // very first section of this file proved.
    const modB = freshRequire<ServerTtlCacheModule>(serverTtlCachePath);
    let threwCrossCopy: unknown;
    try {
      modB.withTtlCache(async (k: string) => `modB:${k}`, (k: string) => k, { name, ttlMs: 30_000, max: 100 });
    } catch (err) {
      threwCrossCopy = err;
    }
    check(
      '★ a DIFFERENT (fresh) copy adopting the same name/ttlMs/max does NOT throw — the guard is per-copy, not global',
      threwCrossCopy === undefined,
      String(threwCrossCopy)
    );
  }

  // ── R1 negative control: UNNAMED caches stay module-local across copies ───
  //
  // If this ever passed for the wrong reason (every cache silently shared),
  // every "the store is process-wide" check above would be meaningless: a
  // build with no `name` handling at all could satisfy them by accident. This
  // is what proves the sharing is opt-in, exactly as `server-ttl-cache.ts`'s
  // own header states.
  section('negative control — an UNNAMED cache is NOT shared across fresh copies');
  {
    const modD = freshRequire<ServerTtlCacheModule>(serverTtlCachePath);
    const cacheD = modD.withTtlCache(async (k: string) => `D:${k}`, (k: string) => k, { ttlMs: 10_000, max: 10 });
    cacheD.set('k', 'only-in-D');

    const modE = freshRequire<ServerTtlCacheModule>(serverTtlCachePath);
    const cacheE = modE.withTtlCache(async (k: string) => `E:${k}`, (k: string) => k, { ttlMs: 10_000, max: 10 });

    check('the second copy\'s unnamed cache does NOT see the first copy\'s entry', cacheE.stats().size === 0, JSON.stringify(cacheE.stats()));
    const readViaE = await cacheE('k');
    check('and computes its own value instead of adopting the other copy\'s', readViaE === 'E:k', readViaE);
  }

  // ── R3: two fresh module copies of lib/lite/db/pool.ts share one Pool ─────
  section('R3. lib/lite/db/pool.ts — one Pool per process, not per module copy');
  {
    process.env.LITE_DATABASE_URL = 'postgres://test:test@127.0.0.1:5432/lumen_test';

    let poolConstructions = 0;
    class StubPool {
      public readonly options: unknown;
      constructor(options: unknown) {
        poolConstructions++;
        this.options = options;
      }
      on(): this {
        return this;
      }
    }

    // ★ STUB `pg` VIA Node's OWN MODULE LOADER, NOT A LIBRARY. `pg` is loaded
    // as a single external module in the real build (server-external-packages)
    // and resolves fine under plain `require`, so this is purely to COUNT
    // constructions cheaply without opening a real socket — the map's own R3
    // test spec ("getPool() twice with Pool stubbed, assert one construction").
    const originalLoad = (Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown })._load;
    (Module as unknown as { _load: typeof originalLoad })._load = function (
      request: string,
      parent: unknown,
      isMain: boolean
    ): unknown {
      if (request === 'pg') {
        return { Pool: StubPool };
      }
      return originalLoad.call(this, request, parent, isMain);
    };

    try {
      const poolPath = require.resolve('../lite/db/pool');
      const modF = freshRequire<PoolModule>(poolPath);
      const poolF = modF.getPool();

      const modG = freshRequire<PoolModule>(poolPath);
      const poolG = modG.getPool();

      check('exactly one Pool was constructed across two fresh module copies', poolConstructions === 1, `constructions=${poolConstructions}`);
      check('and both copies\' getPool() return the SAME instance', poolF === poolG, String(poolF === poolG));
    } finally {
      (Module as unknown as { _load: typeof originalLoad })._load = originalLoad;
    }
  }
}

main()
  .then(() => {
    out('');
    out(
      failures === 0
        ? `PASS — ${checks} checks, R1/R3 shared-slot sharing proven with its negative control`
        : `FAIL — ${failures} of ${checks} checks failed`
    );
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.log(`${lines.join('\n')}\n\nFAIL — the suite itself threw: ${String(err)}`);
    process.exit(1);
  });
