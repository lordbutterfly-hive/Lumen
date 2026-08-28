'use client';

// ACTIVE AUTHORITY, same bug class as use-delegate-mutation.ts (2026-08-01).
// claim_account_operation moves RC/HIVE out of the creator's account, so Hive
// requires ACTIVE authority to sign it — the Lumen Keychain login sets
// `keyType: posting` (everything else here is a posting action), so leaving
// `requiredKeyType` unset would have `verifyAuthorityOrThrow` reject the
// transaction before broadcast with "does not have active authority", the
// same 100%-failure mode already fixed for delegate/convert/recurring.

import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { refuseIfLite } from '@/blog/lib/lite/client/require-full-account';
import { KeyType } from '@smart-signer/types/common';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { transactionService } from '@transaction/index';
import { getAsset } from '@transaction/lib/utils';
import { logger } from '@ui/lib/logger';

/**
 * Burn Resource Credits to mint one Account Creation Token
 * (`claim_account_operation`). Fee 0 = pay with RC instead of HIVE. This is
 * the MINT side ("Claim account tokens" row) — spending a claimed token to
 * create a new account is a separate, still-unbuilt operation (see
 * claim-account-dialog.tsx's `todo_notice`).
 */
export function useClaimAccountMutation() {
  const queryClient = useQueryClient();
  const { user } = useUserClient();
  return useMutation({
    mutationFn: async (params: { creator: string }) => {
      // Render-only gating (the Advanced card is hidden for lite accounts) is
      // not a gate on its own — same backstop use-delegate-mutation.ts and the
      // governance hooks already carry.
      refuseIfLite(user.account_tier, 'A Lumen Lite account has no Hive keys and cannot claim an account token.');
      const fee = await getAsset('0.000', 'HIVE');
      const broadcastResult = await transactionService.claimAccount(params.creator, fee, {
        observe: true,
        requiredKeyType: KeyType.active
      });
      logger.info('Wallet: claim account broadcast: %o', { params, broadcastResult });
      return { ...params, broadcastResult };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['walletSummary', data.creator] });
    }
  });
}
