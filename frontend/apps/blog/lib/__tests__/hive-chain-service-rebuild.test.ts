/**
 * UNIT TESTS for the 2026-09-06 review fixes to
 * `packages/common-hiveio-packages/src/wax/hive-chain-service.ts`:
 *
 *   1. The REST/hafah endpoint gets its OWN configured default
 *      (`siteConfig.restEndpoint` / `REACT_APP_REST_API_ENDPOINT`), no longer
 *      inherited from the JSON-RPC endpoint (`siteConfig.endpoint` /
 *      `REACT_APP_API_ENDPOINT`) — proven live from this box:
 *
 *          GET https://api.openhive.network/hafah-api/operation-types   404
 *          GET https://api.hive.blog/hafah-api/operation-types          200
 *
 *   2. `resetChain()` followed by a rebuild RE-INITIALISES this copy's
 *      `asset-constants.ts`, instead of `ensureAssetConstantsFor`'s
 *      `isAssetConstantsInitialized()` guard silently keeping the OLD
 *      (possibly WASM-corrupted) chain's ASSETS forever.
 *
 *   3. A build that LOSES the generation race (another `resetChain()` landed
 *      while its own `createHiveChain()` was still in flight) still gets its
 *      search/hivesense REST endpoint assigned before being handed back to
 *      the caller that started it — the discard branch used to `return`
 *      before that assignment ran at all.
 *
 * ★ WHY `@hiveio/wax` IS MONKEY-PATCHED, NOT MOCKED VIA A TEST FRAMEWORK.
 * `@hiveio/wax`'s package.json is `"type": "module"` with an `exports` map
 * carrying ONLY an `"import"` condition — a plain `require('@hiveio/wax')`
 * from this project's `commonjs` `test:unit` harness throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` before any code of ours ever runs, proven
 * empirically from this box:
 *
 *     node -e "require('@hiveio/wax')"
 *     -> Cannot find module or its corresponding type declarations... /
 *        ERR_PACKAGE_PATH_NOT_EXPORTED
 *
 * `require.resolve('@hiveio/wax')` fails the SAME way (resolution itself
 * throws), so there is no absolute path to key a `require.cache` entry off —
 * the only working seam is `Module._load`, patched here to intercept the
 * specifier `'@hiveio/wax'` by NAME before Node's real resolver ever runs.
 * This also means these tests never touch the network or a real WASM chain —
 * `createHiveChain` is fully synthetic, and the two curl results above (run
 * separately, see this fix's own PR/report) are what actually proves the
 * production 404.
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/__tests__/hive-chain-service-rebuild.test.ts
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 */

// ---------------------------------------------------------------------------
// 0. ENV, SET BEFORE ANYTHING ELSE IS REQUIRED. `configuredApiEndpoint` and
//    `configuredRestApiEndpoint` (packages/ui/config/public-vars.ts) are
//    computed ONCE, at module-import time, from `process.env` via
//    `@beam-australia/react-env` (server-side: `env(k)` reads
//    `process.env.REACT_APP_${k}` directly — confirmed from that package's
//    own `dist/index.js`). Deliberately DIFFERENT hosts, so any test that
//    accidentally reads the wrong one is loudly wrong rather than
//    coincidentally right.
// ---------------------------------------------------------------------------
const RPC_HOST = 'https://api.openhive.network'; // proven 404 on hafah-api above
const REST_HOST = 'https://api.hive.blog'; // proven 200 on hafah-api above
process.env.REACT_APP_API_ENDPOINT = RPC_HOST;
process.env.REACT_APP_REST_API_ENDPOINT = REST_HOST;

import Module from 'module';

let checks = 0;
let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  checks += 1;
  if (cond) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(name: string): void {
  console.log(`\n${name}`);
}

// ---------------------------------------------------------------------------
// 1. THE `@hiveio/wax` STUB. See this file's header for why `Module._load`
//    (not `require.cache`) is the seam.
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

let createHiveChainCalls = 0;
/** Every argument `createHiveChain` was called with, in order — proves what `getDefaultClientOptions()` actually produced. */
const capturedOptions: AnyRecord[] = [];
/** Resolvers for in-flight fake builds, FIFO — lets a test control exactly when a build "finishes", to race it against `resetChain()`. */
const pendingResolvers: Array<(chain: AnyRecord) => void> = [];

let buildTag = 0;
/**
 * A fresh fake chain, split into the two objects real wax produces at two
 * different points: `raw` is what `createHiveChain(...)` itself resolves to
 * (before `.extend()`/`.extendRest()`), and `finalChain` is what
 * `raw.extend().extendRest({...})` returns — the object `hive-chain-service.ts`
 * actually mutates (`restApi['hivesense-api'].endpointUrl = ...`) and hands
 * back to its own caller. Distinguishable ASSETS per build via `buildTag`.
 */
function makeFakeChain(): { raw: AnyRecord; finalChain: AnyRecord } {
  buildTag += 1;
  const tag = buildTag;
  const assets = {
    HIVE: { nai: '@@000000021', precision: 3, buildTag: tag },
    HBD: { nai: '@@000000013', precision: 3, buildTag: tag },
    VESTS: { nai: '@@000000037', precision: 6, buildTag: tag }
  };
  const restApi: AnyRecord = {
    endpointUrl: undefined,
    'hivesense-api': { endpointUrl: undefined },
    'hafah-api': {},
    'hivemind-api': {}
  };
  const api: AnyRecord = { endpointUrl: undefined, 'search-api': { find_text: { endpointUrl: undefined } } };
  const finalChain: AnyRecord = { ASSETS: assets, api, restApi, buildTag: tag };
  // Real wax: `hiveChainInitialized.extend<T>().extendRest<T>({...})`. Generics
  // are erased at runtime, so the compiled call is `.extend().extendRest({...})`
  // — zero and one runtime argument respectively.
  const raw: AnyRecord = { extend: () => ({ extendRest: (_restExtensionConfig: unknown) => finalChain }) };
  return { raw, finalChain };
}

function fakeCreateHiveChain(options: AnyRecord): Promise<AnyRecord> {
  createHiveChainCalls += 1;
  capturedOptions.push(options);
  return new Promise((resolve) => {
    pendingResolvers.push(resolve);
  });
}

const fakeWaxModule = { createHiveChain: fakeCreateHiveChain };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const originalLoad = (Module as any)._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === '@hiveio/wax') return fakeWaxModule;
  return originalLoad.call(this, request, parent, isMain);
};

/**
 * Resolve the OLDEST still-pending fake build. Resolves `createHiveChain()`'s
 * promise with the RAW (pre-extend) object — exactly what real wax hands
 * back — and returns `finalChain`, the object `hive-chain-service.ts`'s own
 * `.then()` will extend, mutate and (win or lose the generation race) return
 * to its caller, so a test can assert on the SAME object its `await` sees.
 */
function resolveNextBuild(): AnyRecord {
  const resolve = pendingResolvers.shift();
  if (!resolve) throw new Error('resolveNextBuild: no pending build to resolve — test setup is wrong');
  const { raw, finalChain } = makeFakeChain();
  resolve(raw);
  return finalChain;
}

// ---------------------------------------------------------------------------
// 2. LOAD THE REAL MODULES UNDER TEST (only after the stub above is armed).
// ---------------------------------------------------------------------------
type HiveChainServiceModule = typeof import('../../../../packages/common-hiveio-packages/src/wax/hive-chain-service');
type AssetConstantsModule = typeof import('../../../../packages/ui/lib/asset-constants');

const hcs = require('@hive/common-hiveio-packages/wax') as HiveChainServiceModule;
const assetConstants = require('@hive/ui/lib/asset-constants') as AssetConstantsModule;

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // SECTION A (Fix 1) — the REST endpoint resolves to its OWN configured
  // host, not the RPC host.
  // -------------------------------------------------------------------------
  section('A. Fix 1 — REST endpoint uses its own config, not the RPC endpoint');
  {
    const chain1Promise = hcs.getChain();
    check('the first getChain() call triggers exactly one createHiveChain()', createHiveChainCalls === 1, String(createHiveChainCalls));
    const chain1 = resolveNextBuild();
    await chain1Promise;

    const opts = capturedOptions[0];
    check('apiEndpoint (JSON-RPC) is the configured RPC host', opts.apiEndpoint === RPC_HOST, opts.apiEndpoint);
    check('restApiEndpoint is the configured REST host, NOT the RPC host', opts.restApiEndpoint === REST_HOST, opts.restApiEndpoint);
    check('the two endpoints actually differ (the bug this fix closes made them identical)', opts.apiEndpoint !== opts.restApiEndpoint);

    // `getAIDefaultEndpoint()` returns `undefined` outside a browser, so
    // `hivesense-api.endpointUrl` falls through to `clientOptions.restApiEndpoint`
    // — the same value observed above, now read back off the actual chain
    // object handed to the caller, not just the options passed in.
    check(
      "the chain's search/hivesense endpoint is also the REST host (clientOptions.restApiEndpoint fallback)",
      chain1.restApi['hivesense-api'].endpointUrl === REST_HOST,
      chain1.restApi['hivesense-api'].endpointUrl
    );
  }

  // -------------------------------------------------------------------------
  // SECTION B (Fix 2) — resetChain() + rebuild re-initialises asset constants.
  // -------------------------------------------------------------------------
  section('B. Fix 2 — reset + rebuild re-initialises asset constants');
  {
    check('asset constants are initialised after the first build', assetConstants.isAssetConstantsInitialized() === true);
    const configAfterBuild1 = assetConstants.getAssetConfig() as AnyRecord;
    const buildTagAfter1 = configAfterBuild1.HIVE.buildTag;

    hcs.resetChain();
    const chain2Promise = hcs.getChain();
    check(
      'resetChain() cleared the slot, so getChain() triggers a SECOND createHiveChain()',
      createHiveChainCalls === 2,
      String(createHiveChainCalls)
    );
    const chain2 = resolveNextBuild();
    await chain2Promise;

    check('the rebuild produced a genuinely different chain object', chain2.ASSETS !== configAfterBuild1, '');
    check(
      'asset constants now reflect chain #2 (buildTag advanced), not the stale chain #1 values ' +
        '(the exact bug: the OLD guard placement would have left this at buildTag #1 forever)',
      (assetConstants.getAssetConfig() as AnyRecord).HIVE.buildTag === chain2.ASSETS.HIVE.buildTag &&
        (assetConstants.getAssetConfig() as AnyRecord).HIVE.buildTag !== buildTagAfter1,
      `before=${buildTagAfter1} after=${(assetConstants.getAssetConfig() as AnyRecord).HIVE.buildTag} chain2=${chain2.ASSETS.HIVE.buildTag}`
    );
  }

  // -------------------------------------------------------------------------
  // SECTION C (Fix 3) — a build that loses the generation race (discarded,
  // not adopted into the shared slot) still gets its search endpoint set.
  // -------------------------------------------------------------------------
  section('C. Fix 3 — a discarded (stale) build still carries the search endpoint');
  {
    hcs.resetChain(); // clear the slot so the next getChain() genuinely rebuilds
    const callsBefore = createHiveChainCalls;
    const staleChainPromise = hcs.getChain(); // starts build #N, generation G — left PENDING
    check('the race\'s own build call happened', createHiveChainCalls === callsBefore + 1, String(createHiveChainCalls));

    // A SECOND reset lands while build #N's own createHiveChain() is still
    // in flight — simulating another caller's WASM-corruption reset arriving
    // mid-build. This bumps the generation, making build #N's eventual
    // resolution STALE (`s.generation !== generationAtStart`).
    hcs.resetChain();

    const staleChain = resolveNextBuild(); // build #N finally "finishes"
    const resolved = await staleChainPromise;

    check('the stale build still resolves (its own caller is not left hanging)', resolved === staleChain);
    check(
      "the stale build's search/hivesense REST endpoint IS assigned (Fix 3 — used to `return` before this ran)",
      staleChain.restApi['hivesense-api'].endpointUrl === REST_HOST,
      String(staleChain.restApi['hivesense-api'].endpointUrl)
    );
    check(
      'the stale build was NOT adopted into the shared slot — reuseHiveChain() does not return it',
      hcs.reuseHiveChain() !== staleChain
    );
  }

  console.log(`\nhive-chain-service-rebuild: createHiveChain called ${createHiveChainCalls} time(s) total`);

  if (failures === 0) {
    console.log(`\nhive-chain-service-rebuild: ALL CHECKS PASSED (${checks} checks)`);
    process.exit(0);
  } else {
    console.error(`\nhive-chain-service-rebuild: ${failures} of ${checks} CHECK(S) FAILED`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('hive-chain-service-rebuild: UNCAUGHT ERROR', error);
  process.exit(1);
});
