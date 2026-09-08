'use client';

/**
 * Receive on Magi: this account's ledger id (`hive:<name>` or the wallet DID),
 * as text and as a QR, with a copy action. Altera has no separate receive
 * screen — its recipient field takes exactly this id — so this is the address
 * card that counterpart needs. Deposits FROM Hive or FROM a Bitcoin wallet are
 * the two deposit dialogs, linked from the hints.
 */
import { ReactNode, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { toast } from '@ui/components/hooks/use-toast';
import { useTranslation } from '@/blog/i18n/client';
import { toMagiAccountId } from '@/blog/lib/lite/wallet/magi-assets';
import type { TokenAccount } from '@/blog/features/creator-tokens/live/use-token-accounts';
import WalletDialogShell from './shared/wallet-dialog-shell';

export default function MagiReceiveDialog({
  trigger,
  account,
  defaultOpen
}: {
  trigger: ReactNode;
  account: TokenAccount;
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation('common_blog');
  const id = toMagiAccountId(account.id);
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    QRCode.toDataURL(id, { width: 220, margin: 1 })
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      .catch(() => setQr(null));
    return () => {
      cancelled = true;
    };
  }, [open, id]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      toast({ title: t('wallet.magi.receive.copied'), description: id, variant: 'success' });
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard refused (permissions, insecure context): the id is on screen to select.
    }
  };

  return (
    <WalletDialogShell
      trigger={trigger}
      title={t('wallet.magi.receive.title')}
      description={t('wallet.magi.receive.description')}
      open={open}
      onOpenChange={setOpen}
      onSubmit={copy}
      submitLabel={copied ? t('wallet.magi.receive.copied') : t('wallet.magi.receive.copy')}
      cancelLabel={t('wallet.dialogs.common.cancel')}
      isSubmitting={false}
    >
      <div className="flex flex-col items-center gap-3">
        {qr ? (
          <img src={qr} alt="" width={220} height={220} className="rounded-card border border-line-9 bg-white p-2" data-testid="magi-receive-qr" />
        ) : (
          <div className="h-[236px] w-[236px] rounded-card border border-line-9 bg-surface-5" aria-hidden />
        )}
        <div className="flex w-full flex-col gap-1.5">
          <span className="text-caption font-medium text-ink-7">{t('wallet.magi.receive.address')}</span>
          <code className="w-full break-all rounded-control bg-surface-23 px-3 py-2 font-mono text-caption text-ink-2" data-testid="magi-receive-address">
            {id}
          </code>
        </div>
      </div>
      <p className="text-caption text-ink-10">
        {account.kind === 'hive' ? t('wallet.magi.receive.hive_hint') : t('wallet.magi.receive.btc_hint')}
      </p>
    </WalletDialogShell>
  );
}
