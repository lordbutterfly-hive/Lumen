import { useQuery } from '@tanstack/react-query';
import { fetchDynamicGlobalProperties } from '@/blog/lib/chain-fetch';

/**
 * ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). Same rule as
 * `use-account.ts` — `getDynamicGlobalProperties` reached `getChain()` in the
 * browser. See `apps/blog/app/api/dynamic-global-properties/route.ts`.
 */
export const useDynamicGlobalData = () =>
  useQuery({
    queryKey: ['dynamicGlobalData'],
    queryFn: () => fetchDynamicGlobalProperties()
  });
