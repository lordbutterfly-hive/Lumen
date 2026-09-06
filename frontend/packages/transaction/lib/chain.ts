import type { ExtendedNodeApi, ExtendedRestApi } from '@hive/common-hiveio-packages/wax';
import { getHiveChainService } from './hive-chain-service';
import { getChainGeneration } from '@hive/common-hiveio-packages';
import type { TWaxExtended, TWaxRestExtended } from '@hiveio/wax';
import { wrapChainWithLogging } from './chain-proxy';

export type Chain = TWaxExtended<ExtendedNodeApi, TWaxRestExtended<ExtendedRestApi>>;

let chain: Promise<Chain> | undefined = undefined;
/**
 * ★★★ THIS COPY'S OWN STALENESS CLOCK (2026-09-06, review fix on the
 * module-copies build map's R2). `chain` above wraps whatever
 * `getHiveChainService().getHiveChain()` resolves to — which, since R2, is
 * the ONE process-wide chain `hive-chain-service.ts` shares across every
 * webpack layer. But THIS memo is not shared: `chain.ts` is bundled once per
 * layer too, so each copy keeps its OWN wrapped chain in its OWN `let chain`,
 * same as before R2.
 *
 * That used to be harmless because the underlying chain never changed under
 * it. It stopped being harmless the moment `resetChain()` could reset the
 * SHARED chain: `validate-hive-account.ts`'s WASM-corruption handler calls
 * `resetChain()` (clears the shared slot) and `resetTransactionChain()`
 * (clears only the CALLING copy's `chain`) — every OTHER layer's `chain.ts`
 * copy never got a `resetTransactionChain()` call, so it kept returning its
 * wrapped reference to the pre-reset chain forever, even though
 * `hive-chain-service.ts` had already moved on to a fresh one underneath it.
 *
 * `chainGeneration` fixes this without needing every copy to be told about
 * every reset: it records which generation (`getChainGeneration()`) this
 * copy's `chain` was built against, and `getChain()` below compares that
 * against the CURRENT generation on every call — a mismatch means the shared
 * chain has been reset since, so the memo is stale and is rebuilt.
 */
let chainGeneration: number | undefined = undefined;

export const getChain = (): Promise<Chain> => {
  const currentGeneration = getChainGeneration();
  if (chain && chainGeneration === currentGeneration) return chain;

  chainGeneration = currentGeneration;
  chain = getHiveChainService().getHiveChain().then(wrapChainWithLogging).catch((error) => {
    chain = undefined; // Clear cache so next call retries
    throw error;
  });
  return chain;
};

/**
 * Reset the transaction-layer chain cache.
 * Must be called alongside resetChain() from hive-chain-service
 * to ensure WASM error recovery clears both layers.
 *
 * ★ STILL WORTH CALLING EXPLICITLY (2026-09-06 review fix) even though
 * `getChain()`'s generation check above would eventually catch the same
 * reset on its own: this clears the CURRENT copy's memo immediately, so the
 * very next `getChain()` call in THIS copy rebuilds without even needing to
 * compare generations. Every OTHER copy relies on the generation check alone,
 * since nothing calls their `resetTransactionChain()`.
 */
export const resetTransactionChain = (): void => {
  chain = undefined;
};
