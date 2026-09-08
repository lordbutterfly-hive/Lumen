'use client';

/**
 * Deposit Bitcoin onto Magi: a deposit address from the BTC mapping bot, with a QR
 * code. The mechanism is Altera's (altera-app/src/lib/sendswap/stages/deposit/
 * BitcoinMainnetDeposit.svelte: ask the bot for `deposit_to=<account>`, show the
 * address as text and as a `bitcoin:` QR); the request goes through this app's
 * own same-origin route (app/api/magi/btc-deposit-address), which only ever mints
 * an address for one of the signed-in reader's OWN Magi accounts.
 *
 * Same dialog chrome as every wallet dialog (dialogs/shared/wallet-dialog-shell.tsx),
 * without the form: there is nothing to submit, only something to copy.
 */
import { ReactNode, useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { csrfHeaderName } from '@smart-signer/lib/csrf-protection';
import { Button } from '@ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@ui/components/dialog';
import { CircleSpinner } from 'react-spinners-kit';
import { useTranslation } from '@/blog/i18n/client';

interface DepositAddress {
  address: string;
  network: 'mainnet' | 'testnet';
}

async function requestDepositAddress(account: string): Promise<DepositAddress> {
  const res = await fetch('/api/magi/btc-deposit-address', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [csrfHeaderName]: '1' },
    body: JSON.stringify({ account }),
    cache: 'no-store'
  });
  const json = (await res.json().catch(() => null)) as { address?: unknown; network?: unknown; error?: unknown } | null;
  if (!res.ok || !json || typeof json.address !== 'string') {
    throw new Error(typeof json?.error === 'string' ? json.error : `HTTP ${res.status}`);
  }
  return { address: json.address, network: json.network === 'testnet' ? 'testnet' : 'mainnet' };
}

export default function MagiBtcDepositDialog({
  trigger,
  account,
  defaultOpen
}: {
  trigger: ReactNode;
  /** The Magi account id the deposit credits: `hive:<name>` or a `did:pkh:…`. */
  account: string;
  /** See use-wallet-dialog.ts; set by lazy-wallet-dialog.tsx on first load. */
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation('common_blog');
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const [result, setResult] = useState<DepositAddress | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await requestDepositAddress(account);
      setResult(next);
      // `bitcoin:` URIs are what wallets read as "pay this address" (Altera does the same).
      setQr(await QRCode.toDataURL(`bitcoin:${next.address}`, { width: 220, margin: 1 }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [account]);

  useEffect(() => {
    if (open && !result && !loading && !error) void load();
  }, [open, result, loading, error, load]);

  const onCopy = () => {
    if (!result) return;
    try {
      void navigator.clipboard?.writeText(result.address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable; the address is on screen to copy by hand */
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="rounded-panel font-ui sm:max-w-[440px]" data-testid="magi-btc-deposit-dialog">
        <DialogHeader>
          <DialogTitle className="text-left text-xl text-ink-2">{t('wallet.magi.btc_deposit.title')}</DialogTitle>
          <DialogDescription className="text-left text-ink-10">{t('wallet.magi.btc_deposit.description')}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-3 py-6 text-caption text-ink-10" role="status" data-testid="magi-btc-deposit-loading">
            <CircleSpinner loading size={16} />
            {t('wallet.magi.btc_deposit.loading')}
          </div>
        ) : error ? (
          <div className="rounded-card border border-line-warn-2 bg-surface-warn-4 px-4 py-3 text-caption text-ink-warn-3" data-testid="magi-btc-deposit-failed">
            {t('wallet.magi.btc_deposit.failed')}{' '}
            <button type="button" onClick={() => void load()} className="font-medium underline">
              {t('wallet.magi.btc_deposit.retry')}
            </button>
          </div>
        ) : result ? (
          <div className="flex flex-col gap-3" data-testid="magi-btc-deposit-ready">
            {qr ? (
              <div className="flex justify-center rounded-card border border-line-9 bg-surface-1 p-3">
                <img src={qr} alt="" width={220} height={220} />
              </div>
            ) : null}
            <div>
              <div className="mb-1 text-caption font-medium text-ink-7">{t('wallet.magi.btc_deposit.address')}</div>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-control bg-surface-23 px-3 py-2 font-mono text-caption text-ink-2" data-testid="magi-btc-deposit-address">
                  {result.address}
                </code>
                <button
                  type="button"
                  onClick={onCopy}
                  className="lm-press flex-none rounded-control border border-line-11 bg-surface-1 px-3 py-2 text-caption font-medium text-ink-7 hover:bg-surface-16"
                >
                  {copied ? t('wallet.magi.btc_deposit.copied') : t('wallet.magi.btc_deposit.copy')}
                </button>
              </div>
            </div>
            {result.network === 'testnet' ? (
              <p className="rounded-card border border-line-warn-2 bg-surface-warn-4 px-4 py-3 text-caption text-ink-warn-3" data-testid="magi-btc-deposit-testnet">
                {t('wallet.magi.btc_deposit.testnet_note')}
              </p>
            ) : null}
            <p className="text-caption text-ink-10">{t('wallet.magi.btc_deposit.only_btc')}</p>
            <p className="text-caption text-ink-10">{t('wallet.magi.btc_deposit.confirmations')}</p>
          </div>
        ) : null}

        <DialogFooter className="mt-2 flex-row items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            {t('wallet.dialogs.common.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
