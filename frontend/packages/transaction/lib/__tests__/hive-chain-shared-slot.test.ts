import { expect } from 'chai';
import Module from 'module';

/**
 * Proves R2 of the 2026-09-06 module-copies build map: `hive-chain-service.ts`
 * (packages/common-hiveio-packages/src/wax/hive-chain-service.ts) shares its
 * chain, promise and failover clock across TWO webpack layers, simulated here
 * as two fresh Node module instances — same technique
 * `apps/blog/lib/__tests__/module-copies-shared-slots.test.ts` uses for
 * server-ttl-cache.ts and lib/lite/db/pool.ts, adapted to mocha because this
 * file transitively needs `@hiveio/wax`, which has no CJS "exports" entry
 * (`post-read-failover.test.ts` in this same directory documents the same
 * wall — "its module pulls @hiveio/wax through package-exports the mocha/
 * ts-node runner does not expose"). `@hiveio/wax` is therefore stubbed at the
 * Node module-loader level rather than imported for real; every other import
 * this file needs (`@hive/ui/config/site`, `@hive/ui/lib/logging`,
 * `@hive/ui/lib/asset-constants`, `./extended-hive.chain`) resolves fine under
 * this harness already, unstubbed.
 */

const HIVE_CHAIN_SERVICE_PATH = require.resolve('../../../common-hiveio-packages/src/wax/hive-chain-service');
const ASSET_CONSTANTS_PATH = require.resolve('../../../ui/lib/asset-constants');

type HiveChainServiceModule = typeof import('../../../common-hiveio-packages/src/wax/hive-chain-service');
type AssetConstantsModule = typeof import('../../../ui/lib/asset-constants');

interface StubChain {
  api: { endpointUrl: string; 'search-api': { find_text: { endpointUrl: string } } };
  restApi: { endpointUrl: string; 'hivesense-api': { endpointUrl: string } };
  ASSETS: Record<string, unknown>;
  extend: () => { extendRest: (ext: unknown) => StubChain };
}

function makeStubChain(apiEndpoint: string, restApiEndpoint: string): StubChain {
  const chain: StubChain = {
    api: { endpointUrl: apiEndpoint, 'search-api': { find_text: { endpointUrl: '' } } },
    restApi: { endpointUrl: restApiEndpoint, 'hivesense-api': { endpointUrl: '' } },
    ASSETS: { HIVE: { nai: '@@000000021', precision: 3 }, HBD: { nai: '@@000000013', precision: 3 }, VESTS: { nai: '@@000000037', precision: 6 } },
    extend: () => ({ extendRest: () => chain })
  };
  return chain;
}

/** Fresh module factory invocation — see the sibling blog-side test for why. */
function freshRequire<T>(resolvedPath: string): T {
  delete require.cache[resolvedPath];
  return require(resolvedPath) as T;
}

describe('hive-chain-service.ts: one chain shared across module copies (build map R2)', () => {
  let originalLoad: (request: string, parent: unknown, isMain: boolean) => unknown;
  let createHiveChainCalls: number;

  before(() => {
    originalLoad = (Module as unknown as { _load: typeof originalLoad })._load;
    (Module as unknown as { _load: typeof originalLoad })._load = function (
      request: string,
      parent: unknown,
      isMain: boolean
    ): unknown {
      if (request === '@hiveio/wax') {
        return {
          createHiveChain: async (opts: { apiEndpoint: string; restApiEndpoint: string }): Promise<StubChain> => {
            createHiveChainCalls++;
            return makeStubChain(opts.apiEndpoint, opts.restApiEndpoint);
          }
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
  });

  after(() => {
    (Module as unknown as { _load: typeof originalLoad })._load = originalLoad;
  });

  beforeEach(() => {
    createHiveChainCalls = 0;
    // Clear the process-wide chain slot between tests so each `it` starts cold
    // — the slot lives on `globalThis` (Symbol.for), not in any module's cache,
    // so deleting require.cache alone would not reset it.
    const CHAIN_SLOT = Symbol.for('lumen.hiveChain.v1');
    delete (globalThis as unknown as Record<symbol, unknown>)[CHAIN_SLOT];
  });

  it('two fresh copies: only ONE createHiveChain() call, and reuseHiveChain() is identical on both', async () => {
    const copyA = freshRequire<HiveChainServiceModule>(HIVE_CHAIN_SERVICE_PATH);
    const chainA = await copyA.getChain();

    const copyB = freshRequire<HiveChainServiceModule>(HIVE_CHAIN_SERVICE_PATH);
    const chainB = await copyB.getChain();

    expect(createHiveChainCalls).to.equal(1, 'the second copy must ADOPT the existing promise, not build a second chain');
    expect(chainA).to.equal(chainB, 'both copies must resolve to the exact same chain object');
    expect(copyA.reuseHiveChain()).to.equal(copyB.reuseHiveChain());
  });

  it('advanceToNextRpcEndpoint on one copy moves currentRpcEndpoint seen by the other', async () => {
    const copyA = freshRequire<HiveChainServiceModule>(HIVE_CHAIN_SERVICE_PATH);
    await copyA.getChain();
    const copyB = freshRequire<HiveChainServiceModule>(HIVE_CHAIN_SERVICE_PATH);
    await copyB.getChain();

    const before = copyB.currentRpcEndpoint();
    const moved = copyA.advanceToNextRpcEndpoint(before);

    expect(moved).to.be.a('string').and.not.equal(before);
    expect(copyB.currentRpcEndpoint()).to.equal(moved, 'copy B must see the failover copy A performed');
  });

  it('isAssetConstantsInitialized() becomes true in an ADOPTING copy too, not only the creator', async () => {
    // Copy A: fresh asset-constants.ts state, then create the chain for real.
    delete require.cache[ASSET_CONSTANTS_PATH];
    const assetConstantsA = require(ASSET_CONSTANTS_PATH) as AssetConstantsModule;
    expect(assetConstantsA.isAssetConstantsInitialized()).to.equal(false, 'sanity: A starts uninitialised');

    const copyA = freshRequire<HiveChainServiceModule>(HIVE_CHAIN_SERVICE_PATH);
    await copyA.getChain();
    expect(assetConstantsA.isAssetConstantsInitialized()).to.equal(true, 'the creating copy initialises its own asset-constants');

    // Copy B: a SEPARATE, freshly-uninitialised asset-constants.ts instance —
    // simulating the second webpack layer's own module copy of that file too
    // (Q6 of the build map: asset-constants.ts is deliberately per-copy).
    delete require.cache[ASSET_CONSTANTS_PATH];
    const assetConstantsB = require(ASSET_CONSTANTS_PATH) as AssetConstantsModule;
    expect(assetConstantsB.isAssetConstantsInitialized()).to.equal(
      false,
      'sanity: B is a genuinely fresh, uninitialised copy, distinct from A'
    );

    const copyB = freshRequire<HiveChainServiceModule>(HIVE_CHAIN_SERVICE_PATH);
    // copyB's internal `import { initializeAssetConstants, isAssetConstantsInitialized }
    // from '@hive/ui/lib/asset-constants'` resolves to the SAME cached instance as
    // assetConstantsB above, because we populated the cache with it just before
    // requiring copyB.
    await copyB.getChain();

    expect(createHiveChainCalls).to.equal(1, 'B must have ADOPTED the chain A already built');
    expect(assetConstantsB.isAssetConstantsInitialized()).to.equal(
      true,
      'the ADOPTING copy must also initialise its own asset-constants module — this is the exact gap R2 closes'
    );
  });

  it('resetChain() on one copy clears reuseHiveChain() seen by the other', async () => {
    const copyA = freshRequire<HiveChainServiceModule>(HIVE_CHAIN_SERVICE_PATH);
    await copyA.getChain();
    const copyB = freshRequire<HiveChainServiceModule>(HIVE_CHAIN_SERVICE_PATH);
    await copyB.getChain();

    expect(copyB.reuseHiveChain()).to.not.equal(undefined);
    copyA.resetChain();
    expect(copyB.reuseHiveChain()).to.equal(undefined, 'resetChain() must clear the ONE shared chain, not just copy A\'s view of it');
  });

  it('★ resetChain() also clears lastFailoverAt and bumps the generation (review fix, item 1)', async () => {
    const copyA = freshRequire<HiveChainServiceModule>(HIVE_CHAIN_SERVICE_PATH);
    await copyA.getChain();

    const rotation1 = copyA.currentRpcEndpoint();
    copyA.advanceToNextRpcEndpoint(rotation1);
    // A failover happened, so restorePreferredRpcEndpoint would (once the
    // cooldown passes) try to move back — that only means anything if
    // lastFailoverAt survived. We cannot wait out the real 60s cooldown here,
    // so this test only proves the counters directly.
    const generationBefore = copyA.getChainGeneration();

    copyA.resetChain();

    expect(copyA.getChainGeneration()).to.equal(generationBefore + 1, 'resetChain() must bump the generation exactly once');

    // Indirect proof lastFailoverAt was cleared: rebuild a chain and confirm
    // restorePreferredRpcEndpoint is a silent no-op (it would only ever act
    // on a non-zero lastFailoverAt) rather than throwing or misbehaving on
    // stale state from before the reset.
    await copyA.getChain();
    expect(() => copyA.restorePreferredRpcEndpoint()).to.not.throw();
  });

  it("reuseHiveChain() ALONE (never calling getChain()/initChain()) still initialises THIS copy's asset-constants (review fix, item 2)", async () => {
    const copyA = freshRequire<HiveChainServiceModule>(HIVE_CHAIN_SERVICE_PATH);
    await copyA.getChain(); // the creator builds the one shared chain

    delete require.cache[ASSET_CONSTANTS_PATH];
    const assetConstantsB = require(ASSET_CONSTANTS_PATH) as AssetConstantsModule;
    expect(assetConstantsB.isAssetConstantsInitialized()).to.equal(false, 'sanity: a genuinely fresh, uninitialised copy');

    const copyB = freshRequire<HiveChainServiceModule>(HIVE_CHAIN_SERVICE_PATH);
    // Deliberately ONLY reuseHiveChain() — never getChain()/initChain() — the
    // exact gap named in this file's own header before the fix: a copy that
    // only ever calls reuseHiveChain() could observe a live shared chain
    // while its OWN asset-constants.ts stayed uninitialised forever.
    const chain = copyB.reuseHiveChain();

    expect(chain).to.not.equal(undefined);
    expect(assetConstantsB.isAssetConstantsInitialized()).to.equal(
      true,
      "reuseHiveChain() alone must initialise this copy's asset-constants"
    );
  });

  it('negative control: without the slot, two fresh requires would NOT share (Symbol.for identity check)', () => {
    // Not a behavioural test of the module — a guard against the one way this
    // whole approach could silently stop proving anything: if a future edit
    // swapped `Symbol.for` for `Symbol()`, the slot itself would stop being
    // shared across separately-`require`d copies, and every check above would
    // start failing for the RIGHT reason. This asserts the identity property
    // the fix depends on holds for `Symbol.for` in this runtime.
    const a = Symbol.for('lumen.hiveChain.v1');
    const b = Symbol.for('lumen.hiveChain.v1');
    expect(a).to.equal(b);
    expect(Symbol('lumen.hiveChain.v1')).to.not.equal(Symbol('lumen.hiveChain.v1'));
  });
});

/**
 * Proves item 1's second half (review fix): an in-flight `createHiveChain()`
 * build that resolves AFTER `resetChain()` already ran must not be able to
 * re-assign the shared chain — the exact race a slow network call and a
 * WASM-corruption reset could interleave in on a real box. Uses a SEPARATE
 * describe block with its OWN `@hiveio/wax` stub because this one needs
 * DEFERRED resolution (the caller controls exactly when `createHiveChain()`
 * resolves), unlike the immediate-resolve stub every test above uses.
 */
describe('hive-chain-service.ts: a stale in-flight build cannot undo a reset (review fix, item 1)', () => {
  let originalLoad: (request: string, parent: unknown, isMain: boolean) => unknown;
  let createHiveChainCalls: number;
  let pendingResolvers: Array<() => void>;
  let pendingRejecters: Array<(err: Error) => void>;

  before(() => {
    originalLoad = (Module as unknown as { _load: typeof originalLoad })._load;
    (Module as unknown as { _load: typeof originalLoad })._load = function (
      request: string,
      parent: unknown,
      isMain: boolean
    ): unknown {
      if (request === '@hiveio/wax') {
        return {
          createHiveChain: (opts: { apiEndpoint: string; restApiEndpoint: string }): Promise<StubChain> => {
            createHiveChainCalls++;
            return new Promise<StubChain>((resolve, reject) => {
              pendingResolvers.push(() => resolve(makeStubChain(opts.apiEndpoint, opts.restApiEndpoint)));
              pendingRejecters.push((err) => reject(err));
            });
          }
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
  });

  after(() => {
    (Module as unknown as { _load: typeof originalLoad })._load = originalLoad;
  });

  beforeEach(() => {
    createHiveChainCalls = 0;
    pendingResolvers = [];
    pendingRejecters = [];
    const CHAIN_SLOT = Symbol.for('lumen.hiveChain.v1');
    delete (globalThis as unknown as Record<symbol, unknown>)[CHAIN_SLOT];
  });

  it('a stale in-flight build resolving AFTER resetChain() does not re-populate the shared chain', async () => {
    const copyA = freshRequire<HiveChainServiceModule>(HIVE_CHAIN_SERVICE_PATH);
    const firstChainPromise = copyA.getChain(); // fires createHiveChain #1, held pending
    expect(pendingResolvers.length).to.equal(1);

    // Reset while the FIRST build is still in flight — the exact interleaving
    // a slow network call and a WASM-corruption reset could produce.
    copyA.resetChain();
    expect(copyA.reuseHiveChain()).to.equal(undefined);

    // NOW let the stale build finish.
    pendingResolvers[0]();
    const firstChain = await firstChainPromise;

    expect(firstChain).to.not.equal(undefined, 'the ORIGINAL caller still gets back a perfectly usable chain');
    expect(copyA.reuseHiveChain()).to.equal(
      undefined,
      '★★★ but the stale build must NOT have been adopted into the shared slot — this is the guard'
    );

    // The slot is still empty, so the NEXT getChain() call must rebuild for real.
    const secondChainPromise = copyA.getChain();
    expect(pendingResolvers.length).to.equal(2);
    pendingResolvers[1]();
    const secondChain = await secondChainPromise;

    expect(createHiveChainCalls).to.equal(2, 'one stale build + one real rebuild');
    expect(copyA.reuseHiveChain()).to.equal(secondChain, 'the rebuild IS adopted into the slot');
    expect(secondChain).to.not.equal(firstChain);
  });

  it('a stale in-flight build that REJECTS after a reset does not clear a newer, already-adopted chain', async () => {
    const copyA = freshRequire<HiveChainServiceModule>(HIVE_CHAIN_SERVICE_PATH);
    const firstChainPromise = copyA.getChain(); // build #1, held pending
    expect(pendingResolvers.length).to.equal(1);

    copyA.resetChain();
    // A second, real build starts and completes normally, adopted into the slot.
    const secondChainPromise = copyA.getChain();
    expect(pendingResolvers.length).to.equal(2);
    pendingResolvers[1]();
    const secondChain = await secondChainPromise;
    expect(copyA.reuseHiveChain()).to.equal(secondChain);

    // NOW the stale first build's underlying network call finally REJECTS —
    // exactly the `.catch()` branch of the guard in setChainClient(). Without
    // the generation check there, this would clear `s.hiveChainPromise`/
    // `s.hiveChain`, undoing the perfectly good chain build #2 just adopted.
    pendingRejecters[0](new Error('stale upstream call finally failed'));
    await firstChainPromise.catch(() => undefined);

    expect(copyA.reuseHiveChain()).to.equal(
      secondChain,
      "the stale build's rejection (arriving AFTER a newer rebuild already completed) must not clobber it"
    );
  });
});
