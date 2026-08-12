'use client';

import { ReactNode, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@ui/components/dialog';
import { Input } from '@ui/components/input';
import { Icons } from '@ui/components/icons';
import { fetchAccountExists } from '@/blog/lib/chain-fetch';
import { useTranslation } from '@/blog/i18n/client';
import { useSetProxyMutation } from './hooks/use-set-proxy-mutation';

interface SetProxyDialogProps {
  trigger: ReactNode;
  mode: 'set' | 'clear';
  currentProxy?: string;
}

/**
 * Complete "Set a proxy" dialog. `mode="set"` collects and validates an
 * account name (real `checkAccountExists` lookup, not just a regex) then
 * broadcasts `account_witness_proxy`. `mode="clear"` broadcasts the same
 * operation with an empty proxy string, which is how Hive clears a proxy.
 */
export default function SetProxyDialog({ trigger, mode, currentProxy }: SetProxyDialogProps) {
  const { t } = useTranslation('common_blog');
  const [open, setOpen] = useState(false);
  const [account, setAccount] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const proxyMutation = useSetProxyMutation();

  const reset = () => {
    setAccount('');
    setError('');
  };

  const handleSubmit = async () => {
    if (mode === 'clear') {
      await proxyMutation.mutateAsync('');
      setOpen(false);
      return;
    }

    const trimmed = account.trim().toLowerCase();
    if (!trimmed) return;

    setChecking(true);
    // ★ THROUGH OUR SERVER, NOT THE CHAIN CLIENT (2026-08-12). This called
    // `checkAccountExists` (a real chain lookup) directly on submit, which
    // downloads `wax.common.wasm`. See
    // `apps/blog/app/api/account-exists/route.ts`.
    const result = await fetchAccountExists(trimmed);
    setChecking(false);

    // A node error is NOT a verdict on the account — don't call a maybe-valid account "invalid".
    if (result.status === 'api_error') {
      setError(t('witnesses.proxy_dialog.verify_error'));
      return;
    }
    if (result.status === 'not_found') {
      setError(t('witnesses.proxy_dialog.invalid_account'));
      return;
    }

    await proxyMutation.mutateAsync(trimmed);
    setOpen(false);
    reset();
  };

  const busy = proxyMutation.isLoading || checking;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="rounded-2xl" data-testid="witnesses-proxy-dialog">
        <DialogHeader>
          <DialogTitle className="font-sans text-lg font-bold text-[#161511]">
            {mode === 'clear' ? t('witnesses.proxy_dialog.clear_title') : t('witnesses.proxy_dialog.set_title')}
          </DialogTitle>
          <DialogDescription className="font-serif text-sm text-[#6b7280]">
            {mode === 'clear'
              ? t('witnesses.proxy_dialog.clear_description', { proxy: currentProxy })
              : t('witnesses.proxy_dialog.set_description')}
          </DialogDescription>
        </DialogHeader>

        {mode === 'set' && (
          <div>
            <Input
              value={account}
              onChange={(event) => {
                setAccount(event.target.value);
                setError('');
              }}
              placeholder={t('witnesses.proxy_dialog.account_placeholder')}
              data-testid="witnesses-proxy-input"
              error={!!error}
              autoFocus
            />
            {error && (
              <p className="mt-1.5 font-sans text-xs text-[#c0392b]" data-testid="witnesses-proxy-error">
                {error}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={busy || (mode === 'set' && !account.trim())}
            data-testid="witnesses-proxy-submit"
            className="flex items-center justify-center gap-2 rounded-[11px] bg-[#c0392b] px-4 py-2.5 font-sans text-sm font-semibold text-white transition-colors hover:bg-[#96271b] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy && <Icons.spinner className="h-4 w-4 animate-spin" />}
            {mode === 'clear' ? t('witnesses.proxy_dialog.clear_confirm') : t('witnesses.proxy_dialog.set_confirm')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
