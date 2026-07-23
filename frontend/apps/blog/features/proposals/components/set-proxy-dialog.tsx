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
import { useTranslation } from '@/blog/i18n/client';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
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
  const mutation = useProxyMutation(user.username);
  const [open, setOpen] = useState(false);
  const [proxy, setProxy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  if (!user.isLoggedIn) {
    return <DialogLogin>{children}</DialogLogin>;
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
