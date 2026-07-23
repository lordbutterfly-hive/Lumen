'use client';

import { ReactNode, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Input } from '@ui/components/input';
import { toast } from '@ui/components/hooks/use-toast';
import { useTranslation } from '@/blog/i18n/client';
import WalletDialogShell from './shared/wallet-dialog-shell';
import { FieldError } from './shared/field-error';

interface ClaimAccountFormValues {
  newAccountName: string;
}

/**
 * "Claim account tokens" from the Advanced rail. Real data: pendingClaimedAccounts
 * comes straight off the account object (create_claimed_account_operation is
 * already wired in @transaction — transactionService.createClaimedAccount).
 *
 * TODO(wallet): the submit handler is the one deliberately unfinished piece
 * on this page. create_claimed_account_operation needs owner/active/posting
 * authorities + a memo key for the NEW account, which means generating (and
 * safely surfacing) a fresh keypair/master password client-side before
 * broadcasting — that key-generation + backup flow doesn't exist anywhere in
 * this codebase yet (not in @smart-signer, not in the legacy @hive/wallet
 * app either) and is a feature in its own right. The dialog and its
 * validation are real; only the final broadcast call is stubbed.
 */
export default function ClaimAccountDialog({
  trigger,
  pendingClaimedAccounts
}: {
  trigger: ReactNode;
  pendingClaimedAccounts: number;
}) {
  const { t } = useTranslation('common_blog');
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<ClaimAccountFormValues>({ defaultValues: { newAccountName: '' } });

  const onSubmit = form.handleSubmit(async () => {
    setIsSubmitting(true);
    try {
      // TODO(wallet): call transactionService.createClaimedAccount(...) once
      // client-side key generation for the new account exists. See file
      // doc-comment above for why this can't be wired to a real signer yet.
      toast({
        title: t('wallet.dialogs.claim_account.title'),
        description: t('wallet.dialogs.claim_account.todo_notice'),
        variant: 'default'
      });
    } finally {
      setIsSubmitting(false);
    }
  });

  return (
    <WalletDialogShell
      trigger={trigger}
      title={t('wallet.dialogs.claim_account.title')}
      description={t('wallet.dialogs.claim_account.description')}
      open={open}
      onOpenChange={setOpen}
      onSubmit={onSubmit}
      submitLabel={t('wallet.dialogs.common.next')}
      cancelLabel={t('wallet.dialogs.common.cancel')}
      isSubmitting={isSubmitting}
      submitDisabled
    >
      <p className="rounded-[10px] bg-[#f6f7f8] px-3 py-2 text-[13px] text-[#3f4650]">
        {pendingClaimedAccounts > 0
          ? t('wallet.dialogs.claim_account.pending', { count: pendingClaimedAccounts })
          : t('wallet.dialogs.claim_account.pending_none')}
      </p>
      <div className="flex flex-col gap-1.5">
        <label className="text-[13px] font-semibold text-[#3f4650]">
          {t('wallet.dialogs.claim_account.new_account')}
        </label>
        <Input {...form.register('newAccountName')} placeholder="newusername" />
        <FieldError message={t('wallet.dialogs.claim_account.todo_notice')} />
      </div>
    </WalletDialogShell>
  );
}
