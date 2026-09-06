import { expect } from 'chai';
import Module from 'module';

/**
 * Proves item 1 of the 2026-09-06 review fix on the module-copies build map:
 * `packages/transaction/lib/chain.ts`'s own per-copy `chain` memo notices a
 * `resetChain()` that ran in `hive-chain-service.ts` (a DIFFERENT module,
 * possibly a DIFFERENT webpack layer) even though nothing ever called THIS
 * copy's `resetTransactionChain()` directly — via the shared generation
 * counter (`getChainGeneration()`).
 *
 * ★ WHY THIS FILE STUBS `@hive/common-hiveio-packages`, `./hive-chain-service`
 * AND `./chain-proxy` DIRECTLY, RATHER THAN REUSING
 * `hive-chain-shared-slot.test.ts`'s real-module-with-wax-stubbed APPROACH:
 * `chain.ts`'s OWN import chain (`./chain-proxy` -> `./api-logger` ->
 * `@ui/lib/logging`) hits a path-alias `@ui/*` that `packages/transaction`'s
 * own `tsconfig.test.json` has no mapping for — a PRE-EXISTING gap in this
 * package's test harness, unrelated to this fix, and out of scope to solve
 * generally here. Stubbing chain.ts's three direct dependencies surgically
 * avoids ever loading that chain at all, and is sufficient: this file is
 * about `chain.ts`'s OWN generation-comparison logic, not about
 * `hive-chain-service.ts` internals (already proven directly in
 * `hive-chain-shared-slot.test.ts`) or about the logging proxy.
 */

const CHAIN_PATH = require.resolve('../chain');

type ChainModule = typeof import('../chain');

function freshRequire<T>(resolvedPath: string): T {
  delete require.cache[resolvedPath];
  return require(resolvedPath) as T;
}

describe("chain.ts: getChain() notices hive-chain-service.ts's generation moving on (review fix, item 1)", () => {
  let originalLoad: (request: string, parent: unknown, isMain: boolean) => unknown;
  let generation: number;
  let getHiveChainCalls: number;

  before(() => {
    originalLoad = (Module as unknown as { _load: typeof originalLoad })._load;
    (Module as unknown as { _load: typeof originalLoad })._load = function (
      request: string,
      parent: unknown,
      isMain: boolean
    ): unknown {
      if (request === '@hive/common-hiveio-packages') {
        return { getChainGeneration: () => generation };
      }
      if (request === './hive-chain-service') {
        return {
          getHiveChainService: () => ({
            getHiveChain: async (): Promise<{ id: number }> => {
              getHiveChainCalls++;
              return { id: getHiveChainCalls };
            }
          })
        };
      }
      if (request === './chain-proxy') {
        return { wrapChainWithLogging: (chain: unknown) => chain };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
  });

  after(() => {
    (Module as unknown as { _load: typeof originalLoad })._load = originalLoad;
  });

  beforeEach(() => {
    generation = 0;
    getHiveChainCalls = 0;
  });

  it('repeat getChain() calls within one generation reuse the memo (baseline, unchanged behaviour)', async () => {
    const mod = freshRequire<ChainModule>(CHAIN_PATH);
    const a = await mod.getChain();
    const b = await mod.getChain();
    expect(getHiveChainCalls).to.equal(1);
    expect(a).to.equal(b);
  });

  it('★★★ a generation bump (a resetChain() this copy was never told about) forces a rebuild', async () => {
    const mod = freshRequire<ChainModule>(CHAIN_PATH);
    const a = await mod.getChain();
    expect(getHiveChainCalls).to.equal(1);

    // Simulate hive-chain-service.ts's resetChain() running in ANOTHER copy —
    // this copy's chain.ts is never told directly; only the shared generation
    // counter moves, exactly as `getChainGeneration()` is designed to expose.
    generation = 1;

    const b = await mod.getChain();
    expect(getHiveChainCalls).to.equal(2, 'the stale memo must be rebuilt, not reused, once the generation moved');
    expect(b).to.not.equal(a);

    const c = await mod.getChain();
    expect(getHiveChainCalls).to.equal(2, 'and the NEW memo is reused again until the generation moves once more');
    expect(c).to.equal(b);
  });

  it('resetTransactionChain() still forces an immediate rebuild within the SAME generation', async () => {
    const mod = freshRequire<ChainModule>(CHAIN_PATH);
    const a = await mod.getChain();
    mod.resetTransactionChain();
    const b = await mod.getChain();
    expect(getHiveChainCalls).to.equal(2, 'the explicit reset rebuilds even though the generation never moved');
    expect(b).to.not.equal(a);
  });

  it('negative control: without a generation bump OR resetTransactionChain(), the memo is never rebuilt', async () => {
    const mod = freshRequire<ChainModule>(CHAIN_PATH);
    await mod.getChain();
    await mod.getChain();
    await mod.getChain();
    expect(getHiveChainCalls).to.equal(1, 'proves checks above are not vacuously passing because every call rebuilds anyway');
  });
});
