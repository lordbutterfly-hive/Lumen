import type { IHiveChainInterface } from '@hiveio/wax';

// ★ createHiveChain is imported LAZILY at its call site below (2026-09-04, perf).
// A static value import of @hiveio/wax here pulled wax + beekeeper (~100 KB gzip)
// into the app-wide first-load bundle, because this module is reached from the
// creator-tokens header pill (HeaderTokenPill -> useTokenPriceChip ->
// creator-tokens-data-source -> here), which is mounted app-wide even though it
// renders nothing for signed-out readers. Signed-out visitors never call
// getCreatorTokensHiveChain(), so the dynamic import() keeps wax out of their
// download entirely; a signed-in creator loads it on the first price read/write,
// which they trigger regardless. `IHiveChainInterface` stays a type-only import
// (erased at build, no runtime wax).

/**
 * A Hive chain instance that belongs to creator-tokens alone.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS: reads and writes were pointing at different networks.
 *
 * Found 2026-08-07, and it made every write in this feature unable to arrive:
 *
 *   * The contract lives on **Magi testnet**, whose L1 is the **Hive testnet**
 *     (proven by the deploy itself — it was broadcast to testnet.techcoderx.com
 *     and appeared on Magi testnet).
 *   * Reads go straight to the Magi testnet GraphQL, so they worked.
 *   * Writes went through `transactionService.processHiveAppOperation`, which
 *     uses the app's ONE global chain — configured for Hive **mainnet**, because
 *     that is where Lumen's lite posts publish.
 *
 * So a user would approve a signature, the transaction would land on Hive
 * mainnet carrying `net_id: vsc-testnet`, and no Magi testnet node would ever
 * see it. Silent, total, and invisible from the UI.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A SEPARATE CHAIN RATHER THAN SWITCHING THE GLOBAL ONE
 *
 * The obvious fix — point the app's chain at the testnet for the duration of a
 * creator-token write and put it back afterwards — is a race. The endpoint is
 * global and shared: a vote, a follow or a wallet read firing in that window
 * would be built against the wrong chain. Money paths must not depend on
 * nothing-else-happening-right-now.
 *
 * A Hive signature is bound to a chain id, so the chain id must be correct at
 * BUILD time, not just at broadcast time. `transactionService.signTransaction`
 * signs `txBuilder.sigDigest` — a digest the builder computed from ITS OWN
 * chain's id — so it is chain-agnostic, and the same signer (Keychain,
 * PeakVault, MetaMask, …) can sign a transaction built on this instance without
 * knowing anything about it. That is what makes the split clean instead of a
 * fork of the shared package.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * OFF BY DEFAULT. With neither env var set, the feature keeps using the app's
 * own chain exactly as before — so a deployment that puts creator-tokens on the
 * SAME chain as everything else needs no configuration and gets no override.
 * Both variables must be set together; one alone is a misconfiguration, not a
 * half-override (see assertions in getCreatorTokensHiveChain).
 */

export interface CreatorTokensChainOverride {
  /** Hive JSON-RPC node that feeds the Magi network the contract lives on. */
  apiEndpoint: string;
  /** The chain id that node's transactions are signed against. */
  chainId: string;
}

/**
 * Cached per (endpoint, chainId). Creating a wax chain is not free, and every
 * write in a session targets the same network, so this is created once. Keyed
 * rather than a bare singleton so a config change cannot silently serve a chain
 * built for the previous network.
 */
const chains = new Map<string, Promise<IHiveChainInterface>>();

export async function getCreatorTokensHiveChain(
  override: CreatorTokensChainOverride
): Promise<IHiveChainInterface> {
  const { apiEndpoint, chainId } = override;
  if (!apiEndpoint || !chainId) {
    // Deliberately loud. A half-configured override would silently fall back to
    // broadcasting on the wrong network — the exact failure this file exists to
    // remove — so refuse instead of guessing.
    throw new Error(
      'CREATOR_TOKENS_CHAIN_MISCONFIGURED: REACT_APP_CREATOR_TOKENS_HIVE_API and REACT_APP_CREATOR_TOKENS_HIVE_CHAIN_ID must be set together. Set both, or neither to use the app default chain.'
    );
  }
  const key = `${chainId}@${apiEndpoint}`;
  let chain = chains.get(key);
  if (!chain) {
    // The promise is assigned to the cache SYNCHRONOUSLY (no await between the
    // get above and the set below), so two concurrent first callers still share
    // one chain -- the lazy import() happens INSIDE this promise, not before it.
    chain = (async () => {
      const { createHiveChain } = await import('@hiveio/wax');
      return createHiveChain({
        chainId,
        apiEndpoint,
        apiTimeout: 10_000,
        restApiEndpoint: apiEndpoint
      });
    })();
    chains.set(key, chain);
  }
  return chain;
}
