import { createHiveChain, IWaxOptionsChain, TWaxExtended, TWaxRestExtended } from '@hiveio/wax';
import { siteConfig } from '@hive/ui/config/site'; // Maybe move this to package specific only to config
import { ExtendedNodeApi, ExtendedRestApi } from './extended-hive.chain';
import { getLogger } from '@hive/ui/lib/logging';
import { initializeAssetConstants } from '@hive/ui/lib/asset-constants';

export type HiveChain = TWaxExtended<ExtendedNodeApi, TWaxRestExtended<ExtendedRestApi>>;

const logger = getLogger('wax');

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

let hiveChainPromise: Promise<HiveChain> | undefined = undefined;
// This should be just a reference retrieved from the hiveChainPromise.
let hiveChain: HiveChain | undefined = undefined;

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
  hiveChainPromise = undefined;
  hiveChain = undefined;
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
let lastFailoverAt = 0;
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
  if (!hiveChain) return undefined;

  const rotation = getEndpointRotation();
  if (rotation.length < 2) return undefined;

  const current = hiveChain.api.endpointUrl;
  // Someone else already moved us off the node this caller failed on.
  if (failedEndpoint && failedEndpoint !== current) return undefined;

  const index = rotation.findIndex((e) => e === current);
  const next = rotation[(index + 1) % rotation.length];
  if (!next || next === current) return undefined;

  logger.warn('Hive node %s unreachable — failing over to %s', current, next);
  hiveChain.api.endpointUrl = next;
  lastFailoverAt = Date.now();
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
  if (!hiveChain) return;
  if (!lastFailoverAt) return;
  if (Date.now() - lastFailoverAt < PREFERRED_RETRY_AFTER_MS) return;

  const preferred = getEndpointRotation()[0];
  if (!preferred || hiveChain.api.endpointUrl === preferred) {
    lastFailoverAt = 0;
    return;
  }
  logger.info('Cooldown elapsed — trying the preferred Hive node %s again', preferred);
  hiveChain.api.endpointUrl = preferred;
  lastFailoverAt = 0;
};

/** The endpoint currently in use, for callers that need to report or compare it. */
export const currentRpcEndpoint = (): string | undefined => hiveChain?.api.endpointUrl;

export const setRpcEndpoint = (newEndpoint: string): void => {
  logger.info('Changing chain.api.endpointUrl with newEndpoint: %o', newEndpoint);

  // We should ensure the call flow is correct (init first -> modify next)
  if (!hiveChain) {
    throw new Error('Wax Chain is not initialized yet. Call initChain() first.');
  }

  hiveChain.api.endpointUrl = newEndpoint;

  window.localStorage.setItem('node-endpoint', JSON.stringify(newEndpoint));
};

export const setRestApiEndpoint = (newEndpoint: string): void => {
  logger.info('Changing chain.restApi.endpointUrl with newEndpoint: %o', newEndpoint);

  // We should ensure the call flow is correct (init first -> modify next)
  if (!hiveChain) {
    throw new Error('Wax Chain is not initialized yet. Call initChain() first.');
  }

  hiveChain.restApi.endpointUrl = newEndpoint;
  window.localStorage.setItem('rest-node-endpoint', JSON.stringify(newEndpoint));
};

export const setAiEndpoint = (newEndpoint: string): void => {
  logger.info('Changing chain.restApi["hivesense-api"].endpointUrl with newEndpoint: %o', newEndpoint);

  // We should ensure the call flow is correct (init first -> modify next)
  if (!hiveChain) {
    throw new Error('Wax Chain is not initialized yet. Call initChain() first.');
  }

  // Always use the same endpoint as the main API for hivesense-api
  hiveChain.restApi['hivesense-api'].endpointUrl = newEndpoint;
  hiveChain.api['search-api'].find_text.endpointUrl = newEndpoint;

  window.localStorage.setItem('ai-search-endpoint', JSON.stringify(newEndpoint));
};

// This is intentionally non-async method as we don't want any race condition for hiveChainPromise !== undefined check
const setChainClient = (options: Partial<IWaxOptionsChain> = {}): Promise<HiveChain> => {
  const clientOptions = {
    ...getDefaultClientOptions(),
    ...options
  };
  logger.info('Creating instance of Wax Chain with options: %o', clientOptions);

  hiveChainPromise = createHiveChain(clientOptions).then((hiveChainInitialized) => {
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

    hiveChain = extended;

    // Initialize asset constants from wax's chain.ASSETS
    initializeAssetConstants(hiveChain.ASSETS);

    const aiEndpoint = getAIDefaultEndpoint();

    // Always use the same endpoint as the main API for hivesense-api
    hiveChain.restApi['hivesense-api'].endpointUrl = aiEndpoint || clientOptions.restApiEndpoint;
    if (aiEndpoint) {
      hiveChain.api['search-api'].find_text.endpointUrl = aiEndpoint;
    }

    return hiveChain;
  }).catch((error) => {
    hiveChainPromise = undefined; // Clear cache so next call retries
    hiveChain = undefined;
    throw error;
  });

  return hiveChainPromise;
};

export const initChain = (): Promise<HiveChain> => {
  if (hiveChainPromise)
    return hiveChainPromise;

  return setChainClient();
}

export const reuseHiveChain = (): HiveChain | undefined => {
  return hiveChain;
};

export const getChain = (): Promise<HiveChain> => {
  if (hiveChainPromise)
    return hiveChainPromise;

  return initChain();
};
