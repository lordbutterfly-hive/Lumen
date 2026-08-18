
import {HealthCheckerService, ApiChecker } from "@hiveio/healthchecker-component";
import { useEffect, useState } from "react";
import { hiveChainService} from "@transaction/lib/hive-chain-service"
import { hbauthService } from '@smart-signer/lib/hbauth-service';
import { useLocalStorage } from 'usehooks-ts';
import { siteConfig } from "@ui/config/site";
import env from '@beam-australia/react-env';
import { configuredImagesEndpoint } from '@ui/config/public-vars';

/**
 * ★★★ THIS LIST OFFERED NODES THE BROWSER IS FORBIDDEN TO CONTACT (found 2026-08-18).
 *
 * It was a hardcoded array of ten, while the Content-Security-Policy that decides
 * what the browser may actually connect to is built from
 * `REACT_APP_ALLOWED_HIVE_API_NODES` (`packages/middleware/lib/csp.ts`). Nobody
 * connected the two, and they drifted: measured live on this deployment, clicking
 * "Switch to Best" made the browser attempt all ten and **eight were refused by
 * CSP before a single request left the page** — 96 `Refused to connect` console
 * errors, and no network traffic at all.
 *
 * The damage is not cosmetic. There is no automatic failover in the browser
 * (`hive-chain-service.ts:178-193` returns early on purpose, so as not to override
 * a node the user picked deliberately). So a reader who pressed "Set Main" on any
 * of those eight pinned themselves to an endpoint they can never reach, in
 * localStorage, permanently, with nothing to recover them and no error that names
 * the cause. Two of the blocked ones were the FASTEST healthy nodes measured
 * (hiveapi.actifit.io 0.092s, api.deathwing.me 0.106s), so the page was at its most
 * dangerous when it was most useful.
 *
 * Deriving the candidates from the same variable the CSP is built from makes that
 * drift impossible rather than merely fixed — the page can now only ever offer what
 * the browser is permitted to reach. Same discipline `csp.ts` already applies to the
 * Magi/creator-tokens grants, which are derived from the variables those features
 * read rather than restated by hand.
 *
 * The image host is filtered out: it is in that variable because `connect-src` needs
 * it for the proxy-auth token fetch, but it is not a Hive API node and must never be
 * offered as one.
 */
const FALLBACK_ENDPOINTS = ['https://api.hive.blog', 'https://api.openhive.network'];

function allowedApiEndpoints(): string[] {
  const raw = env('ALLOWED_HIVE_API_NODES');
  if (!raw) return FALLBACK_ENDPOINTS;
  const imagesHost = configuredImagesEndpoint;
  const nodes = raw
    .split(/[ ,]+/)
    .map((node) => node.trim().replace(/\/+$/, ''))
    .filter(Boolean)
    .filter((node) => node !== imagesHost);
  return nodes.length > 0 ? nodes : FALLBACK_ENDPOINTS;
}

const DEFAULTS_ENDPOINTS = allowedApiEndpoints();

/**
 * React hook to prepare everything to call and get HC service. Put necessary params there and create HC for component.
 * @param key identificator of HC instance
 * @param apiCheckers list of checkers for HC
 * @param endpointKey where your endpoint is stored in localstorage
 * @param hiveChainServiceMethod name of hive chain service method to handle data change in Wax
 * @param defaultEndpoints write this for custom list of default API providers
 * @param enableLogs true for HC messages
 * @returns
 */
export const useHealthChecker = (
  key: string,
  apiCheckers: ApiChecker<any>[] | undefined,
  endpointKey: string,
  hiveChainServiceMethod: (newEndpoint: string) => Promise<void>,
  defaultEndpoints: string[] = DEFAULTS_ENDPOINTS,
  enableLogs: boolean = false
) => {
  const [healthCheckerService, setHealthCheckerService] = useState<HealthCheckerService>();
  const [endpoint] = useLocalStorage(endpointKey, siteConfig.endpoint);

  const changeEndpoint = async (newEndpoint: string | null) => {
    if (newEndpoint) {
      const bindedHiveChainServiceMethod = hiveChainServiceMethod.bind(hiveChainService);
      await bindedHiveChainServiceMethod(newEndpoint);
    }
  }

  const startHealthCheckerService = async () => {
    if (apiCheckers) {
      const hcService = new HealthCheckerService(
        key,
        apiCheckers,
        defaultEndpoints,
        endpoint,
        changeEndpoint,
        enableLogs
      );
      setHealthCheckerService(hcService);
    }
  }

useEffect(() => {
  if (!apiCheckers) return;

  const hcService = new HealthCheckerService(
    key,
    apiCheckers,
    defaultEndpoints,
    endpoint,
    changeEndpoint,
    enableLogs
  );
  setHealthCheckerService(hcService);

  return () => {
    // Clear the local instance of HC on unmount
    hcService.stopCheckingProcess();
  };
}, [apiCheckers]);

  return healthCheckerService;
}
