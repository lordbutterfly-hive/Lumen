'use client';

/**
 * Read-only copy of features/wallet/components/magi/magi-account-card.tsx,
 * narrowed to the one Hive account a public wallet page can ever show (a lite
 * target's wallet DIDs are never resolved on this page, D4, so this card
 * only ever renders for a Hive username).
 *
 * WHAT WAS REMOVED AND WHY. Every action: the Deposit dialog in the header,
 * the Withdraw dialog in the header, and every row's Send pill. Someone
 * else's wallet page must carry zero signing surface (S1). A forgotten
 * "readOnly" flag on the private card is exactly the class of bug this
 * separate tree exists to make impossible. The `Row` component, `units()`
 * and the BTC-leg-or-blank total rule are copied verbatim from the private
 * card; only the `action` slot on `Row` and the header's action buttons are
 * gone, along with the props that only fed those actions (`entry.account`,
 * `canSign`, `ownLabel`).
 */

import Big from 'big.js';
import { useTranslation } from '@/blog/i18n/client';
import { formatSats } from '@/blog/lib/lite/wallet/magi-btc-balance';
import type { MagiAssets } from '@/blog/lib/lite/wallet/magi-assets';
import type { HiveMarketPrices } from '@/blog/features/wallet/hooks/use-hive-market-prices';
import { formatTokenAmount, formatUsd } from '@/blog/features/wallet/lib/format-amount';
import TokenIcon, { type TokenIconCurrency } from '@/blog/features/wallet/components/token-icon';
import { displayHandle } from '@/blog/features/creator-tokens/live/adapt';

const CARD_CLASS = 'mb-3 rounded-panel border border-line-9 bg-surface-1 p-5';

/** 3-decimal base units to a Big in whole units. Copied verbatim from magi-account-card.tsx. */
function units(baseUnits: number): Big {
  return new Big(baseUnits).div(1000);
}

function Row({
  icon,
  name,
  chip,
  chipTone = 'neutral',
  description,
  amount,
  unit,
  usd,
  testId
}: {
  icon: TokenIconCurrency;
  name: string;
  chip: string;
  chipTone?: 'neutral' | 'green';
  description: string;
  amount: string;
  unit: string;
  usd: string | null;
  testId: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 border-b border-line-2 py-3 last:border-b-0" data-testid={testId}>
      <TokenIcon currency={icon} size={36} />
      {/* The private card's rule: the text keeps a floor width and the figure
          wraps under it at 390 instead of squeezing the text into a column. */}
      <div className="min-w-0 flex-[1_1_220px]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] leading-[24px] font-semibold text-ink-2">{name}</span>
          <span className={`rounded-control px-2 py-[2px] text-caption font-medium ${chipTone === 'green' ? 'bg-surface-ok-5 text-ink-ok-2' : 'bg-surface-23 text-ink-8'}`}>
            {chip}
          </span>
        </div>
        <div className="font-ui text-caption text-ink-10">{description}</div>
      </div>
      <div className="ml-auto flex items-center gap-3.5">
        <div className="text-right">
          <div className="font-num text-[16px] leading-[24px] font-semibold tabular-nums text-ink-2" data-testid={`${testId}-amount`}>
            {amount} <span className="font-medium text-ink-10">{unit}</span>
          </div>
          {/* A dash while the price is missing, never a fabricated $0. */}
          <div className="font-num text-caption tabular-nums text-ink-14">{usd ?? '—'}</div>
        </div>
      </div>
    </div>
  );
}

export default function PublicMagiAccountCard({
  username,
  assets,
  assetsLoading,
  assetsFailed,
  btcSats,
  btcLoading,
  btcFailed,
  btcUnavailable,
  prices
}: {
  username: string;
  assets: MagiAssets | null;
  assetsLoading: boolean;
  assetsFailed: boolean;
  btcSats: bigint | null;
  btcLoading: boolean;
  btcFailed: boolean;
  btcUnavailable: boolean;
  prices: HiveMarketPrices | null;
}) {
  const { t } = useTranslation('common_blog');

  const usdOf = (amount: Big, price: number | null | undefined): string | null =>
    typeof price === 'number' && price > 0 ? formatUsd(amount.toNumber() * price) : null;

  let total: Big | null = null;
  if (assets && prices) {
    const hbd = units(assets.hbdBaseUnits).plus(units(assets.hbdSavingsBaseUnits)).plus(units(assets.hbdUnstakingBaseUnits));
    const hive = units(assets.hiveBaseUnits).plus(units(assets.hiveConsensusBaseUnits)).plus(units(assets.hiveUnstakingBaseUnits));
    total = hbd.times(prices.hbdUsd).plus(hive.times(prices.hiveUsd));
    // ★ THE BTC LEG EITHER PRICES IN OR THE WHOLE TOTAL BLANKS. Copied
    // verbatim from magi-account-card.tsx: a total that silently drops a real
    // BTC balance is a SMALLER number than the truth, the same class of bug
    // as rendering a failed read as zero. The total stands only when the
    // Bitcoin contribution is known to be exactly right.
    if (btcUnavailable) {
      // No Bitcoin on this surface; HBD+HIVE is the whole account.
    } else if (btcSats !== null && btcSats === BigInt(0)) {
      // A real zero needs no price to contribute correctly.
    } else if (btcSats !== null && typeof prices.btcUsd === 'number') {
      total = total.plus(new Big(formatSats(btcSats)).times(prices.btcUsd));
    } else {
      total = null;
    }
  }

  return (
    <div className={CARD_CLASS} data-testid="public-magi-account-card">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <div className="text-[16px] leading-[24px] font-semibold text-ink-2">
            {t('wallet.magi.account_hive', { name: displayHandle(username) })}
          </div>
          <div className="font-ui text-caption text-ink-10">{t('wallet.magi.account_hive_meta')}</div>
        </div>
      </div>

      <div className="mt-3">
        {assetsFailed ? (
          <p className="py-3 font-ui text-caption text-ink-10" data-testid="public-magi-failed">
            {t('wallet.public.magi_failed')}
          </p>
        ) : assetsLoading || !assets ? (
          <p className="py-3 font-ui text-caption text-ink-14" data-testid="public-magi-loading">
            {t('wallet.public.magi_loading')}
          </p>
        ) : (
          <>
            <Row
              icon="HBD"
              name={t('wallet.magi.rows.hbd')}
              chip={t('wallet.magi.chip_on_magi')}
              description={t('wallet.magi.rows.hbd_sub')}
              amount={formatTokenAmount(units(assets.hbdBaseUnits))}
              unit="HBD"
              usd={usdOf(units(assets.hbdBaseUnits), prices?.hbdUsd)}
              testId="public-magi-row-hbd"
            />
            {assets.hbdUnstakingBaseUnits !== 0 ? (
              <Row
                icon="HBD"
                name={t('wallet.magi.rows.hbd_unstaking')}
                chip={t('wallet.magi.chip_unstaking')}
                description={t('wallet.magi.rows.hbd_unstaking_sub')}
                amount={formatTokenAmount(units(assets.hbdUnstakingBaseUnits))}
                unit="HBD"
                usd={usdOf(units(assets.hbdUnstakingBaseUnits), prices?.hbdUsd)}
                testId="public-magi-row-hbd-unstaking"
              />
            ) : null}
            <Row
              icon="HIVE"
              name={t('wallet.magi.rows.hive')}
              chip={t('wallet.magi.chip_on_magi')}
              description={t('wallet.magi.rows.hive_sub')}
              amount={formatTokenAmount(units(assets.hiveBaseUnits))}
              unit="HIVE"
              usd={usdOf(units(assets.hiveBaseUnits), prices?.hiveUsd)}
              testId="public-magi-row-hive"
            />
            {assets.hiveConsensusBaseUnits !== 0 ? (
              <Row
                icon="HIVE"
                name={t('wallet.magi.rows.hive_staked')}
                chip={t('wallet.magi.chip_consensus')}
                description={t('wallet.magi.rows.hive_staked_sub')}
                amount={formatTokenAmount(units(assets.hiveConsensusBaseUnits))}
                unit="HIVE"
                usd={usdOf(units(assets.hiveConsensusBaseUnits), prices?.hiveUsd)}
                testId="public-magi-row-hive-staked"
              />
            ) : null}
            {assets.hiveUnstakingBaseUnits !== 0 ? (
              <Row
                icon="HIVE"
                name={t('wallet.magi.rows.hive_unstaking')}
                chip={t('wallet.magi.chip_unstaking')}
                description={t('wallet.magi.rows.hive_unstaking_sub')}
                amount={formatTokenAmount(units(assets.hiveUnstakingBaseUnits))}
                unit="HIVE"
                usd={usdOf(units(assets.hiveUnstakingBaseUnits), prices?.hiveUsd)}
                testId="public-magi-row-hive-unstaking"
              />
            ) : null}
            {btcUnavailable ? null : btcFailed ? (
              <p className="py-3 font-ui text-caption text-ink-10" data-testid="public-magi-btc-failed">
                {t('wallet.public.magi_btc_failed')}
              </p>
            ) : btcLoading || btcSats === null ? (
              <p className="py-3 font-ui text-caption text-ink-14" data-testid="public-magi-btc-loading">
                {t('wallet.public.magi_loading')}
              </p>
            ) : (
              <Row
                icon="BTC"
                name={t('wallet.magi.rows.btc')}
                chip={t('wallet.magi.chip_on_magi')}
                description={t('wallet.magi.rows.btc_sub')}
                amount={formatSats(btcSats)}
                unit="BTC"
                usd={typeof prices?.btcUsd === 'number' ? formatUsd(Number(formatSats(btcSats)) * prices.btcUsd) : null}
                testId="public-magi-row-btc"
              />
            )}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-card border border-line-9 bg-surface-5 px-6 py-4">
              <div>
                <div className="text-[14px] leading-[22px] font-semibold text-ink-2">{t('wallet.magi.value_title')}</div>
                <div className="font-ui text-caption text-ink-10">{t('wallet.magi.value_description')}</div>
              </div>
              <span className="font-num text-[22px] leading-[30px] font-semibold tabular-nums text-ink-2" data-testid="public-magi-value">
                {total === null ? '—' : formatUsd(total.toNumber())}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
