'use client';

// ★ ACTIVE AUTHORITY (2026-08-01). Every operation in this file is a
// MONEY operation, and Hive requires ACTIVE authority for all of them
// (transfer, transfer_to_vesting, withdraw_vesting, delegate_vesting_shares,
// transfer_to_savings, transfer_from_savings, convert, recurrent_transfer).
//
// None of these hooks passed `requiredKeyType`, so it arrived at the signer as
// undefined and every signer resolves `requiredKeyType ?? this.keyType` — the
// key type the SESSION logged in with, which is `posting` (the Keychain
// sign-in sets it, because everything else Lumen does day to day is a posting
// action). `verifyAuthorityOrThrow` then rejects the transaction before
// broadcast with "does not have active authority".
//
// The chain is the backstop, so this was never a fund-loss risk — it was a
// 100%-failure one: not a single wallet money action could complete for the
// only full-Hive login Lumen still offers. Identical bug, identical fix, and
// the same comment already exists in creator-tokens/lib/vsc/broadcaster.ts and
// prediction-market/lib/vsc/broadcaster.ts.

import { asset } from '@hiveio/wax';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { refuseIfLite } from '@/blog/lib/lite/client/require-full-account';
import { KeyType } from '@smart-signer/types/common';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { transactionService } from '@transaction/index';
import { logger } from '@ui/lib/logger';

/** Delegate HP to another account (delegate_vesting_shares_operation). Amount 0 revokes it. */
export function useDelegateMutation() {
  const queryClient = useQueryClient();
  const { user } = useUserClient();
  return useMutation({
    mutationFn: async (params: { delegator: string; delegatee: string; hp: asset }) => {
      // A keyless Lumen account has no Hive account and no keys. The page and
      // right-rail already hide these controls, but a render-only tier gate is
      // NOT a gate (F-L22 family) — this is the backstop the sibling governance
      // hooks already carry (use-witness-vote-mutation.ts, use-proposal-vote-mutation.ts).
      refuseIfLite(user.account_tier, 'A Lumen Lite account has no Hive keys and cannot move funds. Upgrade to a full Hive account first.');
      const { delegatee, delegator, hp } = params;
      const broadcastResult = await transactionService.delegateVestingShares(delegator, delegatee, hp, {
        observe: true,
        requiredKeyType: KeyType.active
      });
      logger.info('Wallet: delegate broadcast: %o', { params, broadcastResult });
      return { ...params, broadcastResult };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['vestingDelegations', data.delegator] });
      queryClient.invalidateQueries({ queryKey: ['walletAccountData', data.delegator] });
    }
  });
}
