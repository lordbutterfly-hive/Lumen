'use client';

/**
 * Swap on Magi, from the Magi balance, for a full Hive account. See
 * ../../lib/magi-swap.ts for what is the SDK's and what is not, and why wallet
 * accounts are sent to Altera instead.
 *
 * Flow, in the order the SDK widget runs it (crosschain-sdk/packages/widget/src/
 * QuickSwap.tsx:77-139): quote from the pools, dry-run the exact op on the node
 * as the caller (through the proxy), refuse if the dry run fails or the caller's
 * resource credits cannot cover it, tighten `rc_limit` to the simulated cost,
 * sign with the ACTIVE key, broadcast.
 */
import { ReactNode, useEffect, useState } from 'react';
import Big from 'big.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@ui/components/hooks/use-toast';
import { handleError } from '@ui/lib/handle-error';
import { useTranslation } from '@/blog/i18n/client';
import type { SwapAsset } from '@vsc.eco/crosschain-core';
import { withSwapOpRcLimit } from '@vsc.eco/crosschain-core';
import { getMagiSwapConfig } from '../../lib/magi-swap-config';
import {
  SLIPPAGE_PRESETS_BPS,
  SWAP_INPUT_ASSETS,
  SWAP_OUTPUT_ASSETS,
  buildMagiSwapCustomJson,
  checkSwapRcViaProxy,
  customJsonFromSdkOp,
  formatSwapAmount,
  quoteSwap,
  toSdkConfig,
  type SwapInputAsset
} from '../../lib/magi-swap';
import { broadcastMagiCall, type MagiRailPhase } from '../../lib/magi-rails';
import type { TokenAccount } from '@/blog/features/creator-tokens/live/use-token-accounts';
import { toMagiAccountId } from '@/blog/lib/lite/wallet/magi-assets';
import { magiAssetsKey, magiBtcKey } from '../../hooks/use-magi-assets';
import WalletDialogShell from './shared/wallet-dialog-shell';
import { FieldError } from './shared/field-error';
import { formatSats } from '@/blog/lib/lite/wallet/magi-btc-balance';
import { readMagiAssets } from '@/blog/lib/lite/wallet/magi-assets';

const CHIP_CLASS = 'rounded-control border px-3 py-1.5 text-caption font-medium transition-colors';
const CHIP_ON = 'border-line-brand-10 bg-surface-brand-4 text-ink-brand-4';
const CHIP_OFF = 'border-line-11 bg-surface-1 text-ink-7 hover:bg-surface-16';

/** Moments after broadcast at which the Magi balances are re-read; the router settles once the block is processed. */
const RECHECK_DELAYS_MS = [8_000, 25_000, 60_000];

function AssetPicker({ label, value, options, onChange, testId }: { label: string; value: string; options: readonly string[]; onChange: (v: string) => void; testId: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-caption font-medium text-ink-7">{label}</span>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={o} type="button" role="radio" aria-checked={value === o} onClick={() => onChange(o)} className={`${CHIP_CLASS} ${value === o ? CHIP_ON : CHIP_OFF}`} data-testid={`${testId}-${o.toLowerCase()}`}>
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Any Magi account swaps here (2026-09-08): a Hive login signs the SDK's
 * custom_json with its active key; an EVM or Bitcoin login signs the same
 * instruction as a container call with its wallet (lib/magi-rails.ts). The
 * router accepts either — see buildMagiSwapCustomJson.
 */
export default function MagiSwapDialog({ trigger, account, defaultOpen }: { trigger: ReactNode; account: TokenAccount; defaultOpen?: boolean }) {
  const { t } = useTranslation('common_blog');
  const queryClient = useQueryClient();
  const swapConfig = getMagiSwapConfig();
  const username = toMagiAccountId(account.id);
  const [phase, setPhase] = useState<MagiRailPhase | null>(null);
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const [assetIn, setAssetIn] = useState<SwapInputAsset>('HBD');
  const [assetOut, setAssetOut] = useState<SwapAsset>('HIVE');
  const [amount, setAmount] = useState('');
  const [slippageBps, setSlippageBps] = useState(100);
  const [submitting, setSubmitting] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  // Balance ON Magi for the input asset, from the same read the tab shows.
  const balance = useQuery({
    queryKey: magiAssetsKey(username),
    queryFn: () => readMagiAssets(username),
    enabled: open,
    staleTime: 20_000
  });
  const available: Big | null = balance.data
    ? new Big(assetIn === 'HBD' ? balance.data.hbdBaseUnits : balance.data.hiveBaseUnits).div(1000)
    : null;

  const amountValid = /^\d+(\.\d{1,3})?$/.test(amount.trim()) && Number(amount) > 0;
  const exceeds = available !== null && amountValid && new Big(amount).gt(available);
  const sameAsset = (assetIn as string) === assetOut;

  const quote = useQuery({
    queryKey: ['wallet', 'magiSwapQuote', swapConfig?.network ?? '', assetIn, assetOut, amount.trim(), slippageBps],
    enabled: open && swapConfig !== null && amountValid && !sameAsset,
    staleTime: 5_000,
    refetchInterval: 15_000,
    retry: 1,
    // ★ Quoted from the router's own chain state through the proxy, never the
    // indexer (security review M1); see lib/magi-swap.ts.
    queryFn: () => {
      if (!swapConfig) throw new Error('swap not configured');
      return quoteSwap(swapConfig.dexRouterContractId, { assetIn, assetOut, amountIn: amount.trim(), slippageBps });
    }
  });

  useEffect(() => {
    setRefusal(null);
  }, [assetIn, assetOut, amount, slippageBps]);

  if (!swapConfig) return null;

  const onSubmit = async () => {
    if (!quote.data || !amountValid || sameAsset || exceeds) return;
    setSubmitting(true);
    setRefusal(null);
    try {
      const config = toSdkConfig(swapConfig);
      const draft: unknown = ['custom_json', buildMagiSwapCustomJson(username, quote.data, config)];
      const rc = await checkSwapRcViaProxy(username, draft);
      if (!rc.simOk) {
        setRefusal(t('wallet.magi.swap.sim_failed', { reason: rc.errMsg ?? rc.err ?? 'unknown' }));
        return;
      }
      if (!rc.sufficient) {
        setRefusal(t('wallet.magi.swap.not_enough_rc', { hbd: (Number(rc.rcShortfall) / 1000).toFixed(3) }));
        return;
      }
      const tightened = customJsonFromSdkOp(withSwapOpRcLimit(draft, rc.broadcastRcLimit));
      const result = await broadcastMagiCall(account, tightened, { onPhase: setPhase });
      toast({
        title: result.status === 'confirmed' ? t('wallet.magi.swap.success_title') : t('wallet.magi.send.unconfirmed_title'),
        description: t('wallet.magi.swap.success_body', {
          amountIn: formatSwapAmount(quote.data.amountIn.raw, assetIn),
          assetIn,
          minOut: assetOut === 'BTC' ? formatSats(quote.data.preview.minAmountOut) : formatSwapAmount(quote.data.preview.minAmountOut, assetOut),
          assetOut,
          txId: result.id
        }),
        variant: result.status === 'confirmed' ? 'success' : undefined
      });
      for (const delay of RECHECK_DELAYS_MS) {
        window.setTimeout(() => {
          void queryClient.invalidateQueries({ queryKey: magiAssetsKey(username) });
          void queryClient.invalidateQueries({ queryKey: magiBtcKey(username) });
        }, delay);
      }
      setOpen(false);
      setAmount('');
    } catch (error) {
      handleError(error, { method: 'magiSwap', params: { assetIn, assetOut, amount } });
    } finally {
      setSubmitting(false);
      setPhase(null);
    }
  };

  const preview = quote.data?.preview ?? null;
  const fmtOut = (raw: bigint) => (assetOut === 'BTC' ? formatSats(raw) : formatSwapAmount(raw, assetOut));

  return (
    <WalletDialogShell
      trigger={trigger}
      title={t('wallet.magi.swap.title')}
      description={t('wallet.magi.swap.description')}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setRefusal(null);
        }
      }}
      onSubmit={onSubmit}
      submitLabel={t('wallet.magi.swap.submit')}
      cancelLabel={t('wallet.dialogs.common.cancel')}
      isSubmitting={submitting}
      // ★ Fail closed on every input the op depends on (security review L1, L2):
      // no balance read yet or a failed one (the sibling deposit dialog gates the
      // same way), no quote, a quote whose output or floor rounded to zero (the
      // SDK would write the floor as "0" = accept anything), or a stale quote.
      submitDisabled={
        balance.isLoading ||
        !balance.data ||
        !quote.data ||
        !preview ||
        preview.expectedOutput <= BigInt(0) ||
        preview.minAmountOut <= BigInt(0) ||
        !amountValid ||
        sameAsset ||
        exceeds ||
        quote.isFetching
      }
    >
      <AssetPicker label={t('wallet.magi.swap.from')} value={assetIn} options={SWAP_INPUT_ASSETS} onChange={(v) => setAssetIn(v as SwapInputAsset)} testId="magi-swap-from" />
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <label htmlFor="magi-swap-amount" className="text-caption font-medium text-ink-7">
            {t('wallet.dialogs.common.amount')}
          </label>
          <button
            type="button"
            className="text-caption text-ink-brand-6 hover:underline"
            onClick={() => available !== null && setAmount(available.toFixed(3))}
            disabled={available === null}
          >
            {t('wallet.magi.swap.balance', { amount: available === null ? '…' : available.toFixed(3), asset: assetIn })}
          </button>
        </div>
        <input
          id="magi-swap-amount"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.000"
          className="h-10 w-full rounded-control border border-line-11 bg-surface-1 px-3 font-num text-[15px] text-ink-2 outline-none focus:border-line-brand-10"
          data-testid="magi-swap-amount"
        />
        <FieldError message={exceeds ? t('wallet.dialogs.common.amount_exceeds_balance') : undefined} />
      </div>
      <AssetPicker label={t('wallet.magi.swap.to')} value={assetOut} options={SWAP_OUTPUT_ASSETS} onChange={(v) => setAssetOut(v as SwapAsset)} testId="magi-swap-to" />
      <div className="flex flex-col gap-1.5">
        <span className="text-caption font-medium text-ink-7">{t('wallet.magi.swap.slippage')}</span>
        <div className="flex flex-wrap gap-2" role="radiogroup">
          {SLIPPAGE_PRESETS_BPS.map((bps) => (
            <button key={bps} type="button" role="radio" aria-checked={slippageBps === bps} onClick={() => setSlippageBps(bps)} className={`${CHIP_CLASS} ${slippageBps === bps ? CHIP_ON : CHIP_OFF}`}>
              {(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-card border border-line-9 bg-surface-5 px-4 py-3 text-caption" data-testid="magi-swap-quote">
        {sameAsset ? (
          <span className="text-ink-10">{t('wallet.magi.swap.same_asset')}</span>
        ) : !amountValid ? (
          <span className="text-ink-14">{t('wallet.magi.swap.enter_amount')}</span>
        ) : quote.isLoading ? (
          <span className="text-ink-14">{t('wallet.magi.swap.quote_loading')}</span>
        ) : quote.isError ? (
          <span className="text-ink-warn-3">{t('wallet.magi.swap.quote_failed')}</span>
        ) : quote.data === null || !preview || preview.expectedOutput <= BigInt(0) ? (
          <span className="text-ink-warn-3">{t('wallet.magi.swap.no_pool')}</span>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-ink-10">{t('wallet.magi.swap.expected')}</dt>
            <dd className="text-right font-num tabular-nums text-ink-2">
              {fmtOut(preview.expectedOutput)} {assetOut}
            </dd>
            <dt className="text-ink-10">{t('wallet.magi.swap.min_received')}</dt>
            <dd className="text-right font-num tabular-nums text-ink-2">
              {fmtOut(preview.minAmountOut)} {assetOut}
            </dd>
            <dt className="text-ink-10">{t('wallet.magi.swap.fee')}</dt>
            <dd className="text-right font-num tabular-nums text-ink-2">
              {fmtOut(preview.totalFee)} {assetOut}
              {preview.hop1Fee ? ` + ${formatSwapAmount(preview.hop1Fee.totalFee, preview.hop1Fee.asset.toUpperCase() as SwapAsset)} ${preview.hop1Fee.asset.toUpperCase()}` : ''}
            </dd>
            <dt className="text-ink-10">{t('wallet.magi.swap.route')}</dt>
            <dd className="text-right text-ink-2">{preview.hops === 2 ? `${assetIn} → HBD → ${assetOut}` : `${assetIn} → ${assetOut}`}</dd>
          </dl>
        )}
      </div>
      {refusal ? (
        <p className="rounded-card border border-line-warn-2 bg-surface-warn-4 px-4 py-3 text-caption text-ink-warn-3" data-testid="magi-swap-refusal">
          {refusal}
        </p>
      ) : null}
      <p className="text-caption text-ink-10" data-testid="magi-swap-note">{phase ? t(`wallet.magi.phase.${phase}`) : t('wallet.magi.swap.note')}</p>
    </WalletDialogShell>
  );
}
