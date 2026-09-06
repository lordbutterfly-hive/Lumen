import { createHiveChain, IWaxOptionsChain, TWaxExtended, TWaxRestExtended } from '@hiveio/wax';
import { siteConfig } from '@hive/ui/config/site'; // Maybe move this to package specific only to config
import { ExtendedNodeApi, ExtendedRestApi } from './extended-hive.chain';
import { getLogger } from '@hive/ui/lib/logging';
import { initializeAssetConstants, isAssetConstantsInitialized } from '@hive/ui/lib/asset-constants';

export type HiveChain = TWaxExtended<ExtendedNodeApi, TWaxRestExtended<ExtendedRestApi>>;

const logger = getLogger('wax');

/**
 * ★★★ ONE CHAIN PER PROCESS, NOT PER WEBPACK LAYER (2026-09-06, module-copies
 * build map R2). Next compiles this file once per layer — proven live: the rsc
 * copy (every page render and app route handler) held a chain on
 * api.hive.blog while the instrument copy (instrumentation.ts's boot warm)
 * held a SEPARATE chain, built from a SEPARATE `createHiveChain()` call, on
 * api.openhive.network — two 64 MB wasm linear memories per worker
 * (`Creating instance of Wax Chain` logged twice per pid) with INDEPENDENT
 * failover state, so a node the rsc copy had already failed away from could
 * still be the one the instrument copy kept retrying.
 *
 * `hiveChainPromise`, `hiveChain` and `lastFailoverAt` — the three module-level
 * `let`s this used to be — now live in one process-wide slot, so every copy
 * that calls `getChain()`/`initChain()` shares the SAME promise, the SAME chain
 * object and the SAME failover clock. `setChainClient` still only runs once
 * per process (the first caller to find the slot empty), which is what makes
 * this a one-chain fix and not just a one-failover-clock fix.
 *
 * ★ WHAT IS DELIBERATELY *NOT* SHARED: `packages/ui/lib/asset-constants.ts`'s
 * `assetConfig`. It is cheap, pure, per-copy state, and it is read by CODE
 * running in whichever copy asked (e.g. `app/api/wallet/history/route.ts`'s own
 * copy) — sharing the chain does not make that copy's `assetConfig` correct on
 * its own, because the copy that never calls `createHiveChain()` (an ADOPTING
 * copy, one that finds `hiveChainPromise` already in the slot) would otherwise
 * never run `initializeAssetConstants` at all. `ensureAssetConstantsFor` below
 * is what closes that gap: it runs in every copy that awaits the chain,
 * creator and adopter alike, guarded by `isAssetConstantsInitialized()` so a
 * repeat call is a no-op. See that file's own header for why suffixes like
 * "HIVE"/"HBD" would otherwise silently vanish for an adopting copy's readers.
 *
 * ★ A NAMED BEHAVIOUR CHANGE, NOT A BUG (corrected 2026-09-06 review — the
 * first draft of this note named a specific caller that does not actually hit
 * it): `reuseHiveChain()` used to return `undefined` in the `ssr` layer's copy
 * during server-side rendering of a client component, because that copy NEVER
 * built a chain — layer isolation guaranteed it. `popover-card-data.tsx`'s
 * `hiveChainService.reuseHiveChain()` call was checked and does NOT exercise
 * this: Radix `PopoverContent` never mounts on the server, so that component
 * never runs its HP maths during SSR in the first place, changed behaviour or
 * not. The general claim stands for every OTHER caller, though: after this
 * change, `reuseHiveChain()`'s answer during SSR is `chain-or-undefined`
 * depending on whether ANY layer in this worker has already initialised the
 * shared chain — previously it was unconditionally `undefined` in the `ssr`
 * copy, guaranteed by layer isolation; now a chain built by the `rsc` or
 * `instrument` layer is visible there too, because they share the slot. This
 * is intentional (one chain, one truth) and is named here because it is
 * exactly the kind of per-layer semantic Q6 of the build map says to name
 * rather than silently change — it is a property of this file, not of any one
 * caller.
 *
 * ★★ `reuseHiveChain()` ALSO NOW RUNS `ensureAssetConstantsFor` BEFORE
 * RETURNING (2026-09-06 review). Without it, a copy that only ever calls
 * `reuseHiveChain()` — never `getChain()`/`initChain()` — could observe a
 * live, shared `hiveChain` whose `ASSETS` were never fed into THIS copy's own
 * `asset-constants.ts` (per-copy by design, see above), and any caller doing
 * HP/asset maths off the result (`convertToHP` and friends) would throw on an
 * uninitialised `assetConfig` despite `reuseHiveChain()` returning a real
 * chain. This closes that gap the same way the async paths already do.
 */
const CHAIN_SLOT = Symbol.for('lumen.hiveChain.v1');

interface HiveChainSlotState {
  hiveChainPromise: Promise<HiveChain> | undefined;
  hiveChain: HiveChain | undefined;
  lastFailoverAt: number;
  /**
   * ★★★ BUMPED BY `resetChain()` (2026-09-06 review fix). A per-process chain
   * has one consequence a per-copy one never had: OTHER modules that memoise
   * their OWN wrapped copy of this chain (`packages/transaction/lib/chain.ts`'s
   * `let chain`, which wraps whatever `getHiveChainService().getHiveChain()`
   * resolves to) have no way to notice a reset unless something tells them.
   * Before this field, `validate-hive-account.ts`'s WASM-corruption handler
   * called `resetChain()` (this slot) AND `resetTransactionChain()` (that
   * memo) — but only cleared ITS OWN copy's memo; every OTHER webpack layer's
   * `chain.ts` copy kept the pre-reset wrapped chain forever, since nothing
   * else ever called ITS `resetTransactionChain()`. `generation` is the fix:
   * `getChainGeneration()` lets any interested memo compare "what generation
   * did I cache this for?" against "what generation is it now?" on every read,
   * and rebuild on a mismatch — self-healing, with no reset call required.
   */
  generation: number;
}

function chainSlotState(): HiveChainSlotState {
  const carrier = globalThis as typeof globalThis & { [CHAIN_SLOT]?: HiveChainSlotState };
  carrier[CHAIN_SLOT] ??= { hiveChainPromise: undefined, hiveChain: undefined, lastFailoverAt: 0, generation: 0 };
  return carrier[CHAIN_SLOT];
}

/**
 * How many times `resetChain()` has run in this process. Exported so a
 * dependent memo outside this file (`packages/transaction/lib/chain.ts`) can
 * detect a reset it was never directly told about — see `generation`'s own
 * doc on `HiveChainSlotState` above.
 */
export const getChainGeneration = (): number => chainSlotState().generation;

/**
 * Initialise THIS copy's `asset-constants.ts` from the shared chain, exactly
 * once per copy — see this file's header note on why that state is
 * deliberately per-copy rather than moved into the shared slot.
 */
function ensureAssetConstantsFor(chain: HiveChain): HiveChain {
  if (!isAssetConstantsInitialized()) {
    initializeAssetConstants(chain.ASSETS);
  }
  return chain;
}

/**
 * ★ THE BROWSER AND THE SERVER DO NOT WANT THE SAME TIMEOUT (2026-08-09).
 *
 * This was a single `apiTimeout: 5_000` with the comment "To be adjusted", used
 * by both. Five seconds is right in a browser, where a stalled call blocks a
 * widget the reader can ignore and a shorter wait means a faster retry.
 *
 * It is wrong on the server, where the calls that matter are the ones that
 * cannot be skipped — verifying a sign-in signature against the chain. There a
 * timeout is not a slow widget, it is a person being told their sign-in failed.
 * Measured on this box: a login died on `AggregateError [ETIMEDOUT]` raised from
 * node's `internalConnectMultiple` (a TCP connect stall, not a slow node) while
 * a direct request to the same endpoint answered in 0.375 s.
 *
 * 8 s rather than something larger, deliberately: `fetchJson` aborts the
 * browser's own request at 30 s, and a login makes two chain calls each of
 * which may be retried once, so the server's worst case has to stay under that
 * budget or the reader gets an aborted request instead of our honest 503.
 *
 * `HIVE_API_TIMEOUT_MS` overrides both. In a browser bundle `process.env` has no
 * such key and this reads `undefined`, which falls through to the default — so
 * the override is a server-side dial, which is the only place it is needed.
 */
const BROWSER_API_TIMEOUT_MS = 5_000;
const SERVER_API_TIMEOUT_MS = 8_000;

const getApiTimeout = (): number => {
  const configured = Number(process.env.HIVE_API_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return typeof window === 'object' ? BROWSER_API_TIMEOUT_MS : SERVER_API_TIMEOUT_MS;
};

/**
 * Hive nodes to fall back through, in order, when the current one cannot be
 * reached. Same list the health checker already offers readers.
 *
 * `HIVE_API_ENDPOINTS` (comma-separated) overrides it. That name has no
 * `REACT_APP_` prefix on purpose: it is a server-side dial, invisible to browser
 * bundles, and it is also the seam the failover test injects a dead node through.
 */
/*
 * ★★★ TWO DEAD NODES REMOVED (2026-08-20, owner-reported "Lumen crashes when I
 * click Following").
 *
 * The Following tab on a HIVE-keyed account calls `bridge.get_account_posts`
 * straight from the browser, so whichever endpoint this rotation hands out is
 * paid for directly by the reader. Measured from this machine:
 *
 *     https://api.hive.blog          200    388ms
 *     https://api.openhive.network   200    144ms
 *     https://api.deathwing.me       200    110ms
 *     https://rpc.mahdiyari.info     200    150ms
 *     https://anyx.io                502    376ms   <- removed
 *     https://hive-api.arcange.eu    000  12007ms   <- removed, and the bad one
 *
 * `anyx.io` at least fails fast. `hive-api.arcange.eu` does not answer at all:
 * it burns the whole request timeout, the query retries once, and the tab sits
 * dead for roughly twice the timeout before it can even show an error. The
 * server log for this instance is full of
 * `Request timed out: "POST https://hive-api.arcange.eu" (gave up after 8001ms)`.
 *
 * ★ THIS IS A LIVENESS LIST, NOT A CONSTANT. Nodes come back; this is the state
 * measured today, not a permanent judgement, and the two are removed rather than
 * reordered because a dead node anywhere in a rotation still gets handed out.
 * The durable fix is to pick by measured health rather than by list order, which
 * is a bigger change than this bug needs.
 *
 * ★ A READER CAN ALSO PIN A NODE. `getDefaultClientOptions` below reads
 * `localStorage['node-endpoint']`, which /healthchecker writes. A pin overrides
 * this list entirely, so anyone still seeing the hang after this change should
 * clear that key first — that is exactly the failure the /healthchecker
 * production gate was added to prevent.
 */
const FALLBACK_ENDPOINTS = [
  'https://api.hive.blog',
  'https://api.openhive.network',
  'https://api.deathwing.me',
  'https://rpc.mahdiyari.info'
];

const getEndpointRotation = (): string[] => {
  const configured = process.env.HIVE_API_ENDPOINTS;
  if (configured) {
    const list = configured.split(',').map((e) => e.trim()).filter(Boolean);
    if (list.length) return list;
  }
  // Whatever the app is configured to use comes first; the rest follow it.
  const primary = siteConfig.endpoint;
  return [primary, ...FALLBACK_ENDPOINTS.filter((e) => e !== primary)];
};

const getDefaultClientOptions = (): IWaxOptionsChain => {
  // I don't think this logic should be here, but for now it is easier to keep it. We have dedicated MemoryMixin (?)
  let jsonRpcNode: string | undefined = undefined;
  let restNode: string | undefined = undefined;
  // Check if user has selected a custom node in localStorage
  if (typeof window === 'object' && window.localStorage) {
    const storedJsonRpcEndpoint = window.localStorage.getItem('node-endpoint');
    if (storedJsonRpcEndpoint) {
      try {
        jsonRpcNode = JSON.parse(storedJsonRpcEndpoint);
      } catch (err) {
        logger.error('Error parsing stored node-endpoint from localStorage: %o', err);
      }
    }

    const storedRestEndpoint = window.localStorage.getItem('rest-node-endpoint');
    if (storedRestEndpoint) {
      try {
        restNode = JSON.parse(storedRestEndpoint);
      } catch (err) {
        logger.error('Error parsing stored rest-node-endpoint from localStorage: %o', err);
      }
    }
  }

  return {
    chainId: siteConfig.chainId,
    // ★ The rotation's FIRST entry is where we start. With no
    // `HIVE_API_ENDPOINTS` set that is `siteConfig.endpoint`, i.e. unchanged —
    // but when an operator lists nodes explicitly, "first in the list" has to
    // mean "the one we use", or the list is only half honoured and a failover
    // test can pass without ever touching the node it was told to start from.
    apiEndpoint: jsonRpcNode || getEndpointRotation()[0] || siteConfig.endpoint,
    apiTimeout: getApiTimeout(),
    restApiEndpoint: restNode || jsonRpcNode || siteConfig.endpoint,
  };
};

const getAIDefaultEndpoint = (): string | undefined => {
  if (typeof window === 'object' && window.localStorage) {
    const storedJsonRpcNode = window.localStorage.getItem('ai-search-endpoint');
    if (storedJsonRpcNode) {
      try {
        return JSON.parse(storedJsonRpcNode);
      } catch (err) {
        logger.error('Error parsing stored ai-search-endpoint from localStorage: %o', err);
      }
    }
  }

  return undefined;
};

/**
 * Check if an error is a WASM memory corruption error.
 * These errors indicate the WASM module state is corrupted and needs recreation.
 *
 * WORKAROUND: This is a temporary fix until WAX library handles WASM errors internally.
 * See: https://gitlab.syncad.com/hive/wax/-/issues/161
 */
export const isWasmMemoryError = (error: unknown): boolean => {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes('memory access out of bounds') ||
           msg.includes('unreachable') ||
           (error.name === 'RuntimeError' && msg.includes('wasm')) ||
           (error.name === 'WaxError' && msg.includes('wasm'));
  }
  return false;
};

/**
 * Reset the chain singleton to force recreation with fresh WASM state.
 * Call this when WASM memory errors are detected.
 *
 * WORKAROUND: This is a temporary fix until WAX library handles WASM errors internally.
 * See: https://gitlab.syncad.com/hive/wax/-/issues/161
 */
export const resetChain = (): void => {
  logger.warn('Resetting WAX chain singleton due to WASM error - see wax#161');
  const s = chainSlotState();
  s.hiveChainPromise = undefined;
  s.hiveChain = undefined;
  // ★ CLEAR THE FAILOVER CLOCK TOO (2026-09-06 review fix). A fresh chain
  // starts on the preferred endpoint (`getDefaultClientOptions`); a stale
  // `lastFailoverAt` surviving the reset would let `restorePreferredRpcEndpoint`
  // believe a failover happened on a chain that no longer exists, or race the
  // cooldown against the NEW chain's own first real failover.
  s.lastFailoverAt = 0;
  // ★ BUMP THE GENERATION — see `HiveChainSlotState.generation`'s own doc.
  // Every dependent memo's next read notices this reset even if it never
  // received an explicit reset call of its own.
  s.generation += 1;
};

/**
 * ★ FAIL OVER TO THE NEXT HIVE NODE (2026-08-09). SERVER ONLY.
 *
 * Retrying an unreachable node harder does not help when that node is simply
 * down, and sign-in cannot be completed without SOME node — a signature can only
 * be checked against the chain.
 *
 * Deliberately not done in the browser: a reader can pick their own node in the
 * health checker, and that choice is stored. Silently moving them off it would
 * override a setting they made on purpose. On the server there is no such
 * preference to respect — only a job that has to get done.
 *
 * This mutates the process-wide chain, which is the honest trade: the chain is a
 * singleton, so one request discovering a dead node moves every later request to
 * a live one. It only ever advances on a real failure, so a healthy node is never
 * abandoned.
 *
 * @returns the endpoint now in use, or undefined if nothing was changed.
 */
/**
 * When we last moved off the preferred node, and therefore when it is worth
 * trying again. See `restorePreferredRpcEndpoint`.
 */
const PREFERRED_RETRY_AFTER_MS = 60_000;

/**
 * ★★★ COMPARE-AND-SWAP, BECAUSE FAILURES ARRIVE IN CROWDS (2026-08-18).
 *
 * `failedEndpoint` is the endpoint the caller was actually talking to when it
 * failed. Without it this function had a herd problem: a dead node does not fail
 * one request, it fails every request in flight, and each of those callers used
 * to advance the rotation independently. Thirty concurrent readers discovering
 * the same dead node would step thirty times, sail past every healthy node, and
 * quite possibly land back on the dead one — turning one bad node into an outage.
 *
 * Passing what you failed on makes the move idempotent: whoever gets there first
 * moves the process off that node, and everyone else arriving with the same
 * stale endpoint is told "already handled" and simply retries on the new one.
 */
export const advanceToNextRpcEndpoint = (failedEndpoint?: string): string | undefined => {
  if (typeof window === 'object') return undefined; // browser: respect the reader's node
  const s = chainSlotState();
  if (!s.hiveChain) return undefined;

  const rotation = getEndpointRotation();
  if (rotation.length < 2) return undefined;

  const current = s.hiveChain.api.endpointUrl;
  // Someone else already moved us off the node this caller failed on.
  if (failedEndpoint && failedEndpoint !== current) return undefined;

  const index = rotation.findIndex((e) => e === current);
  const next = rotation[(index + 1) % rotation.length];
  if (!next || next === current) return undefined;

  logger.warn('Hive node %s unreachable — failing over to %s', current, next);
  s.hiveChain.api.endpointUrl = next;
  s.lastFailoverAt = Date.now();
  return next;
};

/**
 * ★★★ COME BACK TO THE PREFERRED NODE WHEN IT RECOVERS (2026-08-18).
 *
 * Failover alone is a one-way door: a single blip on the configured node moved
 * the whole process onto a fallback and left it there for the life of the
 * process. Nodes recover, and the head of the rotation is the head for a reason
 * — it is what the deployment chose. Staying on a random fallback for days
 * because of one timeout is not resilience, it is drift.
 *
 * So after a cooldown we go back and try the preferred node again. If it is still
 * down, the next failure costs exactly one request and moves us off it again,
 * which is the price of ever discovering that it recovered. If it is healthy, we
 * are home with no operator involved.
 *
 * Called at the START of a guarded operation rather than on a timer: a timer
 * would keep firing on an idle server, and there is nothing to recover for if
 * nobody is asking.
 */
export const restorePreferredRpcEndpoint = (): void => {
  if (typeof window === 'object') return;
  const s = chainSlotState();
  if (!s.hiveChain) return;
  if (!s.lastFailoverAt) return;
  if (Date.now() - s.lastFailoverAt < PREFERRED_RETRY_AFTER_MS) return;

  const preferred = getEndpointRotation()[0];
  if (!preferred || s.hiveChain.api.endpointUrl === preferred) {
    s.lastFailoverAt = 0;
    return;
  }
  logger.info('Cooldown elapsed — trying the preferred Hive node %s again', preferred);
  s.hiveChain.api.endpointUrl = preferred;
  s.lastFailoverAt = 0;
};

/** The endpoint currently in use, for callers that need to report or compare it. */
export const currentRpcEndpoint = (): string | undefined => chainSlotState().hiveChain?.api.endpointUrl;

export const setRpcEndpoint = (newEndpoint: string): void => {
  logger.info('Changing chain.api.endpointUrl with newEndpoint: %o', newEndpoint);

  // We should ensure the call flow is correct (init first -> modify next)
  const s = chainSlotState();
  if (!s.hiveChain) {
    throw new Error('Wax Chain is not initialized yet. Call initChain() first.');
  }

  s.hiveChain.api.endpointUrl = newEndpoint;

  window.localStorage.setItem('node-endpoint', JSON.stringify(newEndpoint));
};

export const setRestApiEndpoint = (newEndpoint: string): void => {
  logger.info('Changing chain.restApi.endpointUrl with newEndpoint: %o', newEndpoint);

  // We should ensure the call flow is correct (init first -> modify next)
  const s = chainSlotState();
  if (!s.hiveChain) {
    throw new Error('Wax Chain is not initialized yet. Call initChain() first.');
  }

  s.hiveChain.restApi.endpointUrl = newEndpoint;
  window.localStorage.setItem('rest-node-endpoint', JSON.stringify(newEndpoint));
};

export const setAiEndpoint = (newEndpoint: string): void => {
  logger.info('Changing chain.restApi["hivesense-api"].endpointUrl with newEndpoint: %o', newEndpoint);

  // We should ensure the call flow is correct (init first -> modify next)
  const s = chainSlotState();
  if (!s.hiveChain) {
    throw new Error('Wax Chain is not initialized yet. Call initChain() first.');
  }

  // Always use the same endpoint as the main API for hivesense-api
  s.hiveChain.restApi['hivesense-api'].endpointUrl = newEndpoint;
  s.hiveChain.api['search-api'].find_text.endpointUrl = newEndpoint;

  window.localStorage.setItem('ai-search-endpoint', JSON.stringify(newEndpoint));
};

// This is intentionally non-async method as we don't want any race condition for
// hiveChainPromise !== undefined check. The assignment to `s.hiveChainPromise`
// below still happens synchronously, before any `await`, so that invariant now
// holds across every module copy sharing the slot, not just within one.
const setChainClient = (options: Partial<IWaxOptionsChain> = {}): Promise<HiveChain> => {
  const clientOptions = {
    ...getDefaultClientOptions(),
    ...options
  };
  logger.info('Creating instance of Wax Chain with options: %o', clientOptions);

  const s = chainSlotState();
  // ★★★ THE GENERATION THIS ATTEMPT BELONGS TO (2026-09-06 review fix).
  // `createHiveChain(...)` is a real network/wasm-build call, so this promise
  // can still be in flight when `resetChain()` runs for a DIFFERENT reason
  // (another caller hit a WASM error on the chain THIS call has not even
  // produced yet). Without this guard, the in-flight `.then()` below would
  // resolve after the reset and reassign `s.hiveChain`/`s.hiveChainPromise` to
  // the now-superseded chain, silently undoing the reset for every copy.
  const generationAtStart = s.generation;
  const promise: Promise<HiveChain> = createHiveChain(clientOptions).then((hiveChainInitialized) => {
    const extended = hiveChainInitialized.extend<ExtendedNodeApi>().extendRest<ExtendedRestApi>({
      'hivesense-api': {
        posts: {
          urlPath: "posts",
          search: {
            urlPath: "search",
            method: "GET"
          },
          author: {
            urlPath: "{author}",
            permlink: {
              urlPath: "{permlink}",
              similar: {
                urlPath: "similar",
                method: "GET"
              }
            }
          },
          byIds: {
            urlPath: "by-ids",
            method: "POST"
          },
          byIdsQuery: {
            urlPath: "by-ids-query",
            method: "GET"
          }
        },
        authors: {
          urlPath: "authors",
          search: {
            urlPath: "search",
            method: "GET"
          }
        },
      },
      method: "GET",
      'hivemind-api': {
        "accountsOperations": {
          urlPath: 'accounts/{account-name}/operations',
        }
      },
      'hafah-api': {
        'operation-types': {
          urlPath: 'operation-types'
        }
      }
    });

    // ★ THE GUARD: if `resetChain()` (or a newer `setChainClient()` call it
    // provoked) ran while `createHiveChain()` above was still in flight, this
    // attempt is stale — do not let it clobber whatever the reset/rebuild put
    // in the slot. The caller who started THIS specific call still gets a
    // perfectly usable chain back; it is just not adopted into the shared slot.
    if (s.generation !== generationAtStart) {
      logger.warn('Discarding a stale Wax Chain build superseded by a reset (generation moved on)');
      return extended;
    }

    s.hiveChain = extended;

    // Initialize THIS (creating) copy's asset constants from wax's chain.ASSETS.
    // An adopting copy — one that never runs this `.then()` because it found
    // `hiveChainPromise` already in the slot — gets its own turn via
    // `ensureAssetConstantsFor` in `initChain`/`getChain` below.
    ensureAssetConstantsFor(extended);

    const aiEndpoint = getAIDefaultEndpoint();

    // Always use the same endpoint as the main API for hivesense-api
    extended.restApi['hivesense-api'].endpointUrl = aiEndpoint || clientOptions.restApiEndpoint;
    if (aiEndpoint) {
      extended.api['search-api'].find_text.endpointUrl = aiEndpoint;
    }

    return extended;
  }).catch((error) => {
    // Same guard on the failure path: a stale attempt failing after a reset
    // must not clear out whatever the reset (or a newer attempt) already put
    // in the slot.
    if (s.generation === generationAtStart) {
      s.hiveChainPromise = undefined; // Clear cache so next call retries
      s.hiveChain = undefined;
    }
    throw error;
  });

  s.hiveChainPromise = promise;
  return promise;
};

export const initChain = (): Promise<HiveChain> => {
  const existing = chainSlotState().hiveChainPromise;
  if (existing) return existing.then(ensureAssetConstantsFor);

  return setChainClient();
}

export const reuseHiveChain = (): HiveChain | undefined => {
  const chain = chainSlotState().hiveChain;
  // ★ SEE THIS FILE'S HEADER NOTE. A copy that only ever calls
  // `reuseHiveChain()` still needs ITS OWN `asset-constants.ts` initialised
  // before a caller does HP/asset maths off the result.
  if (chain) ensureAssetConstantsFor(chain);
  return chain;
};

export const getChain = (): Promise<HiveChain> => {
  const existing = chainSlotState().hiveChainPromise;
  if (existing) return existing.then(ensureAssetConstantsFor);

  return initChain();
};
