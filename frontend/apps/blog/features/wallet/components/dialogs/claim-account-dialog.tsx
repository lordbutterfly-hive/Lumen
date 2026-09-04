'use client';

import { ReactNode, useState } from 'react';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { useTranslation } from '@/blog/i18n/client';
import { useClaimAccountMutation } from '../../hooks/use-claim-account-mutation';
import WalletDialogShell from './shared/wallet-dialog-shell';

/**
 * "Claim account tokens" from the Advanced rail. `pendingClaimedAccounts` is
 * real data straight off the account object.
 *
 * FIXED (2026-08-28): the Submit button here now burns Resource Credits to
 * MINT one Account Creation Token (`claim_account_operation` — creator + fee
 * + extensions, no new keys). That is a different chain operation from
 * SPENDING an already-claimed token to create a new account
 * (`create_claimed_account_operation`), which is what the removed form below
 * (DECISION, 2026-07-30, FRONTEND-REMAINING-2026-07-30.md row 4.6) was
 * actually blocked on: that op needs owner/active/posting authorities plus a
 * memo key for the NEW account, i.e. generating and safely surfacing a fresh
 * keypair client-side, which doesn't exist anywhere in this codebase. The
 * `todo_notice` below still describes that real gap accurately — only the
 * mint half of "claim account tokens" was ever unimplemented rather than
 * blocked, and the previous dialog conflated the two and shipped neither.
 */
export default function ClaimAccountDialog({
  trigger,
  username,
  pendingClaimedAccounts,
  defaultOpen
}: {
  trigger: ReactNode;
  username: string;
  pendingClaimedAccounts: number;
  /** See lazy-wallet-dialog.tsx — set on this dialog's first (lazy) load. */
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation('common_blog');
  const [open, setOpen] = useState(defaultOpen ?? false);
  const claimAccountMutation = useClaimAccountMutation();

  const onSubmit = async () => {
    try {
      await claimAccountMutation.mutateAsync({ creator: username });
      toast({
        title: t('wallet.dialogs.common.success_title'),
        description: t('wallet.advanced.claim_account.label'),
        variant: 'success'
      });
      setOpen(false);
    } catch (error) {
      handleError(error, { method: 'walletClaimAccount', params: { username } });
    }
  };

  return (
    <WalletDialogShell
      trigger={trigger}
      title={t('wallet.dialogs.claim_account.title')}
      description={t('wallet.dialogs.claim_account.description')}
      open={open}
      onOpenChange={setOpen}
      onSubmit={onSubmit}
      submitLabel={t('wallet.dialogs.claim_account.submit')}
      cancelLabel={t('wallet.dialogs.common.cancel')}
      isSubmitting={claimAccountMutation.isPending}
    >
      <p
        className="rounded-control bg-surface-16 px-3 py-2 text-caption tabular-nums text-ink-7"
        data-testid="claim-account-pending"
      >
        {pendingClaimedAccounts > 0
          ? t('wallet.dialogs.claim_account.pending', { count: pendingClaimedAccounts })
          : t('wallet.dialogs.claim_account.pending_none')}
      </p>
      <p className="text-caption text-ink-10" data-testid="claim-account-todo-notice">
        {t('wallet.dialogs.claim_account.todo_notice')}
      </p>
    </WalletDialogShell>
  );
}
