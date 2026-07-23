import { useCallback } from 'react';
import { getFindAccounts } from '@transaction/lib/hive-api';
import { useClaimRewardsMutation } from '@/blog/features/activity-log/hooks/use-claim-reward-mutation';

/**
 * "Claim now" on the HBD Savings slot. Hive doesn't have a separate claim op
 * for savings interest — interest is credited to savings_hbd_balance
 * automatically on its own schedule. What this button really claims is the
 * account's pending reward balance (reward_hive_balance / reward_hbd_balance
 * / reward_vesting_balance) via claim_reward_balance_operation — the same
 * real op and the same mutation the notifications "Redeem" button already
 * uses (features/activity-log/hooks/use-claim-reward-mutation). Reused as-is
 * rather than duplicated.
 */
export function useClaimNow(username: string) {
  const claimRewardMutation = useClaimRewardsMutation();

  const claim = useCallback(async () => {
    const { accounts } = await getFindAccounts(username);
    const account = accounts[0];
    if (!account) throw new Error(`Account not found: ${username}`);
    await claimRewardMutation.mutateAsync({ account });
  }, [username, claimRewardMutation]);

  return { claim, isPending: claimRewardMutation.isPending };
}
