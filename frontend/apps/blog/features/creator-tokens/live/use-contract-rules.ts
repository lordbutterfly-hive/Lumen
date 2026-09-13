'use client';

import { useQuery } from '@tanstack/react-query';
import { getCreatorTokensDataSource } from '../lib/creator-tokens-data-source';
import type { ContractRules } from '../types';

/**
 * THE CONTRACT-LEVEL RULE SET — which bytecode the chain is running right now.
 *
 * Extracted from use-meritum-launch.ts on 2026-09-12, unchanged in behaviour:
 * same query key, same staleTime, same 'v1' default. It moved because a SECOND
 * screen needs the answer and two independent reads of "which contract is live"
 * is exactly how one screen ends up contradicting another. Sharing the query key
 * means both read one cache entry and cannot disagree, even mid-flip.
 *
 * WHY CONTRACT-LEVEL AND NOT `market.rules`. A `Market` carries its own `rules`,
 * but the screens that need this have no market: the launch wizard runs before
 * one exists, and Creator Studio's empty state is by definition the
 * no-market-yet case. `readRules` reads the deployed bytecode's CID and caches
 * it, so it answers without one.
 *
 * ★ THE DEFAULT IS 'v1' AND THAT IS THE SAFE DIRECTION, inherited deliberately.
 * v1 is the harsher story — a wind-down rather than an inflow stop, and a
 * recurring charge rather than none. Being briefly over-cautious is
 * recoverable; asserting the gentler rule set against a harsher chain is the
 * one direction contract-rules.ts warns costs somebody (its header, item 4).
 *
 * ★★ THE SAME DEFAULT IS A KNOWN RESIDUAL AFTER THE v3 ACTIVATION. A failed
 * chain read then makes a screen disclose a 10 HBD month that no longer exists.
 * It still fails toward over-disclosure, which is why it is left as-is rather
 * than flipped quietly: changing it is a judgement about which way to be wrong,
 * and it belongs to whoever owns the contract, not to this hook.
 */
export function useContractRules(): ContractRules {
  const dataSource = getCreatorTokensDataSource();
  const query = useQuery({
    queryKey: ['meritum', 'contract-rules'],
    queryFn: () => dataSource!.readRules(),
    enabled: dataSource !== null,
    staleTime: 60_000
  });
  return query.data ?? 'v1';
}
