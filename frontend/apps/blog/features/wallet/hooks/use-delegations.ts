import { useQuery } from '@tanstack/react-query';
import { getChain } from '@transaction/lib/chain';
import { convertStringToBig } from '@ui/lib/helpers';
import { convertToHP } from '@ui/lib/utils';
import { GetDynamicGlobalPropertiesResponse } from '@hiveio/wax';
import { Chain } from '@transaction/lib/chain';

export interface DelegateeRow {
  name: string;
  hp: string;
}

const LIST_LIMIT = 100;

/**
 * Real outgoing vesting delegations for `username`, via
 * database_api.list_vesting_delegations (order=by_delegation, which is
 * indexed by delegator so a start of [username, ''] returns only this
 * account's rows first — filtered defensively below too since the API
 * doesn't stop at an exact delegator boundary).
 */
export function useDelegations(
  username: string,
  dynamicGlobal: GetDynamicGlobalPropertiesResponse | null,
  chain: Chain | null
) {
  return useQuery({
    queryKey: ['vestingDelegations', username],
    queryFn: async (): Promise<DelegateeRow[]> => {
      const hiveChain = await getChain();
      const { delegations } = await hiveChain.api.database_api.list_vesting_delegations({
        start: [username, ''],
        limit: LIST_LIMIT,
        order: 'by_delegation'
      });

      if (!dynamicGlobal || !chain) return [];

      return delegations
        .filter((d) => d.delegator === username)
        .map((d) => ({
          name: d.delegatee,
          hp: convertToHP(
            convertStringToBig(d.vesting_shares),
            chain,
            dynamicGlobal.total_vesting_shares,
            dynamicGlobal.total_vesting_fund_hive
          ).toFixed(3)
        }));
    },
    enabled: !!username && !!dynamicGlobal && !!chain
  });
}
