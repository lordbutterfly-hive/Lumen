'use client';

import { ReactNode, useState } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@hive/ui';
import { useTranslation } from '@/blog/i18n/client';

/**
 * "Claim account tokens" from the Advanced rail. `pendingClaimedAccounts` is
 * real data straight off the account object.
 *
 * DECISION (2026-07-30, FRONTEND-REMAINING-2026-07-30.md row 4.6): this used
 * to be a full form — a "new account name" input plus a permanently-disabled
 * Submit button — which read as a broken feature rather than an honest one.
 * `create_claimed_account_operation` needs owner/active/posting authorities
 * plus a memo key for the NEW account, which means generating (and safely
 * surfacing) a fresh keypair/master password client-side before broadcasting.
 * That key-generation + backup flow doesn't exist anywhere in this codebase
 * (not in @smart-signer, not in the legacy @hive/wallet app either) and is a
 * feature in its own right — finishing it is out of scope for this pass, and
 * building it under a wallet/dialog cleanup task would be exactly the kind of
 * unreviewed, unscoped key-custody change this codebase explicitly avoids.
 * REMOVED instead of finished: the row still surfaces the real pending-token
 * count (useful, factual), but the dialog is now pure information with a
 * single Close button — no input field or disabled control implying a
 * transaction is one step away from working.
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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="rounded-panel font-sans sm:max-w-[440px]" data-testid="claim-account-dialog">
        <DialogHeader>
          <DialogTitle className="text-left text-xl text-ink-2">
            {t('wallet.dialogs.claim_account.title')}
          </DialogTitle>
          <DialogDescription className="text-left text-ink-10">
            {t('wallet.dialogs.claim_account.description')}
          </DialogDescription>
        </DialogHeader>
        <p className="rounded-control bg-surface-16 px-3 py-2 text-caption tabular-nums text-ink-7">
          {pendingClaimedAccounts > 0
            ? t('wallet.dialogs.claim_account.pending', { count: pendingClaimedAccounts })
            : t('wallet.dialogs.claim_account.pending_none')}
        </p>
        <p className="text-caption text-ink-10" data-testid="claim-account-todo-notice">
          {t('wallet.dialogs.claim_account.todo_notice')}
        </p>
        <DialogFooter className="mt-2 flex-row items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t('wallet.dialogs.common.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
