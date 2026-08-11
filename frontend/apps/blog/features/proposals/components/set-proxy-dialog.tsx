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
  DialogTrigger,
  Input
} from '@hive/ui';
import TooltipContainer from '@ui/components/tooltip-container';
import { useTranslation } from '@/blog/i18n/client';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import DialogLogin from '@/blog/components/dialog-login';
import { isHiveAccountNameValid } from '@transaction/lib/validate-hive-account';
import { getAccount } from '@transaction/lib/hive-api';
import { useProxyMutation } from '../hooks/use-proxy-mutation';

interface Props {
  children: ReactNode;
  currentProxy: string;
}

/**
 * Real account_witness_proxy_operation dialog. Validates the account name format
 * AND that the account actually exists on chain before letting the user submit —
 * a typo here silently redirects all future governance votes to nobody.
 */
export default function SetProxyDialog({ children, currentProxy }: Props) {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  /**
   * ★ SAME DEFECT AS /witnesses (2026-08-11, class sweep). This branched render on
   * raw `user.isLoggedIn`, which cannot answer during SSR and reports "signed out"
   * on the client until `/api/users/me` returns — so a signed-in reader's trigger
   * button was wrapped in `DialogLogin` (opens the login modal instead of the real
   * proxy dialog) for up to several seconds after every page load. See
   * features/layouts/server-session.tsx.
   */
  const identity = useSessionIdentity();
  const mutation = useProxyMutation(user.username);
  const [open, setOpen] = useState(false);
  const [proxy, setProxy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  if (!identity.isLoggedIn) {
    return <DialogLogin>{children}</DialogLogin>;
  }

  // Structural backstop for the same gate `proxy-card.tsx` already applies at the
  // trigger (real `disabled` + reason there). `children` has no click handler of
  // its own outside `DialogTrigger`, so not wrapping it in one already makes it
  // inert if this dialog is ever mounted for a lite account some other way.
  //
  // ★ FOLLOW-THROUGH FIX (2026-08-11). This used to read only `user.account_tier`,
  // which `useSessionIdentity` does not carry — on a cold tab with a session
  // cookie and no localStorage seed, `identity.isLoggedIn` (checked above)
  // answers true immediately while `user.account_tier` is still `undefined`, so
  // this check false-negatived to "not lite" and let a lite account reach the
  // real dialog below, submit, and hit a raw signer error instead of the
  // friendly "lite accounts cannot vote" message. `account_tier` only becomes
  // trustworthy once `identity.clientAnswered` is true (same fetch that answers
  // `user.username` below), so the safe default is to treat the account as lite
  // — i.e. keep showing this blocked state — until the client has genuinely
  // answered, matching list-variant.tsx's write-gate precedent.
  if (!identity.clientAnswered || user.account_tier === 'lite') {
    return <TooltipContainer title={t('proposals.lite_cannot_vote')}>{children}</TooltipContainer>;
  }

  const submit = async (proxyValue: string) => {
    if (proxyValue) {
      setIsChecking(true);
      setError(null);
      try {
        const validFormat = await isHiveAccountNameValid(proxyValue);
        if (!validFormat) {
          setError(t('proposals.proxy_dialog.errors.invalid_format'));
          return;
        }
        if (proxyValue === user.username) {
          setError(t('proposals.proxy_dialog.errors.self_proxy'));
          return;
        }
        const account = await getAccount(proxyValue);
        if (!account?.name) {
          setError(t('proposals.proxy_dialog.errors.not_found', { proxy: proxyValue }));
          return;
        }
      } catch {
        // A node error here isn't a verdict on the account — surface it instead of a silent no-op.
        setError(t('proposals.proxy_dialog.errors.verify_failed'));
        return;
      } finally {
        setIsChecking(false);
      }
    }
    mutation.mutate(proxyValue, { onSuccess: () => setOpen(false) });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-w-[420px]" data-testid="set-proxy-dialog">
        <DialogHeader>
          <DialogTitle>{t('proposals.proxy_dialog.title')}</DialogTitle>
          <DialogDescription>{t('proposals.proxy_dialog.description')}</DialogDescription>
        </DialogHeader>

        {currentProxy ? (
          <p className="font-sans text-sm text-[#3f4650]" data-testid="set-proxy-current">
            {t('proposals.proxy_dialog.current', { proxy: currentProxy })}
          </p>
        ) : null}

        <label className="flex flex-col gap-1.5 text-sm">
          {t('proposals.proxy_dialog.input_label')}
          <Input
            value={proxy}
            onChange={(e) => {
              setProxy(e.target.value.trim().toLowerCase());
              setError(null);
            }}
            placeholder={t('proposals.proxy_dialog.input_placeholder')}
            maxLength={16}
            data-testid="set-proxy-input"
          />
          {error ? (
            <span className="text-xs text-destructive" data-testid="set-proxy-error">
              {error}
            </span>
          ) : null}
        </label>

        <DialogFooter className="gap-2 sm:flex-row-reverse">
          <Button
            onClick={() => submit(proxy)}
            disabled={!proxy || isChecking || mutation.isLoading}
            data-testid="set-proxy-submit"
          >
            {isChecking || mutation.isLoading
              ? t('proposals.proxy_dialog.submitting')
              : t('proposals.proxy_dialog.submit')}
          </Button>
          {currentProxy ? (
            <Button
              variant="outline"
              onClick={() => submit('')}
              disabled={mutation.isLoading}
              data-testid="set-proxy-clear"
            >
              {t('proposals.proxy_dialog.clear')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
