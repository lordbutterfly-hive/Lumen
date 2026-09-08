'use client';

/**
 * One Magi account's balances: the seven-row ledger record Altera's balance
 * card shows (altera-app/src/lib/AccBalance.svelte:50-132), in the wallet's own
 * card grammar (hive-token-card.tsx, savings-slot-card.tsx's chip).
 *
 * Rows: HBD, HBD savings (sHBD), [HBD unstaking], HIVE, [Staked HIVE],
 * [HIVE unstaking], Bitcoin. Bracketed rows appear only when non-zero, as in
 * Altera. Amounts are base-unit integers formatted at the edge (3 decimals for
 * HIVE/HBD, 8 for BTC); nothing is put through a float before display.
 *
 * ★ A FAILED READ SAYS "COULDN'T CHECK" AND HIDES THE FIGURES. Never zeros
 * (magi-balance.ts:26-29). A definite "no Magi account yet" IS zeros, with the
 * deposit control right there.
 *
 * ★ EVERY LOGIN GETS THE SAME CONTROLS (owner, 2026-09-08: "BTC and EVM login
 * are all equal to Keychain"). Send pills on the HBD, HIVE and Bitcoin rows,
 * Receive / Withdraw / Swap in the header, for a Hive account and for a wallet
 * DID alike; only what SIGNS differs (lib/magi-rails.ts). Deposit from Hive is
 * the one Hive-only action, because it spends from a Hive L1 balance.
 */
import type { ComponentProps, ReactNode } from 'react';
import Big from 'big.js';
import { useTranslation } from '@/blog/i18n/client';
import { MagiFuelGauge } from '@/blog/features/creator-tokens/live/magi-fuel-gauge';
import { MAGI_MIN_RC_FOR_A_CALL, type MagiSpendingPowerState } from '@/blog/features/creator-tokens/live/use-magi-spending-power';
import { toMagiAccountId } from '@/blog/lib/lite/wallet/magi-assets';
import { formatSats } from '@/blog/lib/lite/wallet/magi-btc-balance';
import type { MagiAccountAssets } from '../../hooks/use-magi-assets';
import type { HiveMarketPrices } from '../../hooks/use-hive-market-prices';
import { formatTokenAmount, formatUsd } from '../../lib/format-amount';
import TokenIcon, { type TokenIconCurrency } from '../token-icon';
import type MagiDepositDialogComponent from '../dialogs/magi-deposit-dialog';
import type MagiBtcDepositDialogComponent from '../dialogs/magi-btc-deposit-dialog';
import type MagiSwapDialogComponent from '../dialogs/magi-swap-dialog';
import type MagiSendDialogComponent from '../dialogs/magi-send-dialog';
import type MagiReceiveDialogComponent from '../dialogs/magi-receive-dialog';
import type MagiWithdrawDialogComponent from '../dialogs/magi-withdraw-dialog';
import { lazyWalletDialog } from '../dialogs/shared/lazy-wallet-dialog';
import { isMagiSwapConfigured } from '../../lib/magi-swap-config';
import { isMagiL1Configured } from '../../lib/magi-l1-broadcast';

// ★ LAZY, like every wallet dialog (T3g, 2026-09-04): the form/mutation stack
// loads on the first click, not with the tab.
const MagiDepositDialog = lazyWalletDialog<ComponentProps<typeof MagiDepositDialogComponent>>(
  () => import('../dialogs/magi-deposit-dialog')
);
const MagiBtcDepositDialog = lazyWalletDialog<ComponentProps<typeof MagiBtcDepositDialogComponent>>(
  () => import('../dialogs/magi-btc-deposit-dialog')
);
const MagiSwapDialog = lazyWalletDialog<ComponentProps<typeof MagiSwapDialogComponent>>(
  () => import('../dialogs/magi-swap-dialog')
);
const MagiSendDialog = lazyWalletDialog<ComponentProps<typeof MagiSendDialogComponent>>(
  () => import('../dialogs/magi-send-dialog')
);
const MagiReceiveDialog = lazyWalletDialog<ComponentProps<typeof MagiReceiveDialogComponent>>(
  () => import('../dialogs/magi-receive-dialog')
);
const MagiWithdrawDialog = lazyWalletDialog<ComponentProps<typeof MagiWithdrawDialogComponent>>(
  () => import('../dialogs/magi-withdraw-dialog')
);

const CARD_CLASS = 'mb-3 rounded-panel border border-line-9 bg-surface-1 p-5';
const PRIMARY_BUTTON_CLASS =
  'rounded-card bg-surface-brand-12 px-[18px] py-2.5 text-[14px] leading-[22px] font-medium text-ink-27 transition-colors hover:bg-surface-brand-17';
const SECONDARY_BUTTON_CLASS =
  'lm-press rounded-card border border-line-11 bg-surface-1 px-4 py-2.5 text-[14px] leading-[22px] font-medium text-ink-7 transition-colors hover:bg-surface-16';
/** The Hive tab's Send pill, verbatim (hive-token-card.tsx SEND_BUTTON_CLASS), so the two tabs read as one wallet. */
const SEND_BUTTON_CLASS =
  'flex items-center gap-1.5 rounded-card bg-surface-brand-12 px-[18px] py-2.5 text-[14px] leading-[22px] font-medium text-ink-27 transition-colors hover:bg-surface-brand-17';

/** 3-decimal base units to a Big in whole units. */
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
  testId,
  action
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
  /** The row's control (a Send pill); wraps under the figures at 390 like the Hive card. */
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 border-b border-line-2 py-3 last:border-b-0" data-testid={testId}>
      <TokenIcon currency={icon} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] leading-[24px] font-semibold text-ink-2">{name}</span>
          <span className={`rounded-control px-2 py-[2px] text-caption font-medium ${chipTone === 'green' ? 'bg-surface-ok-5 text-ink-ok-2' : 'bg-surface-23 text-ink-8'}`}>
            {chip}
          </span>
        </div>
        <div className="font-ui text-caption text-ink-10">{description}</div>
      </div>
      <div className="text-right">
        <div className="font-num text-[16px] leading-[24px] font-semibold tabular-nums text-ink-2" data-testid={`${testId}-amount`}>
          {amount} <span className="font-medium text-ink-10">{unit}</span>
        </div>
        {/* A dash while the price is missing, never a fabricated $0 (estimated-value-strip.tsx:46-53). */}
        <div className="font-num text-caption tabular-nums text-ink-14">{usd ?? '—'}</div>
      </div>
      {action ? <div className="flex items-center">{action}</div> : null}
    </div>
  );
}

export default function MagiAccountCard({
  entry,
  prices,
  btcUnavailable,
  ownLabel
}: {
  entry: MagiAccountAssets;
  prices: HiveMarketPrices | null;
  btcUnavailable: boolean;
  /** How to name this account in the card header. */
  ownLabel: ReactNode;
}) {
  const { t } = useTranslation('common_blog');
  const { account, assets, assetsLoading, assetsFailed, btcSats, btcLoading, btcFailed } = entry;
  const accountId = toMagiAccountId(account.id);
  const isHive = account.kind === 'hive';
  // What signs: a Hive login needs the Magi L1 chain configured; a wallet login signs with its wallet.
  const canSign = isHive ? isMagiL1Configured() : account.canSign;
  const hbdBalance = assets ? units(assets.hbdBaseUnits) : new Big(0);
  const hiveBalance = assets ? units(assets.hiveBaseUnits) : new Big(0);
  const btcBalance = btcSats !== null ? new Big(formatSats(btcSats)) : null;
  const withdrawBalances = { HBD: hbdBalance, HIVE: hiveBalance, ...(btcUnavailable || btcBalance === null ? {} : { BTC: btcBalance }) };
  const sendPill = (asset: 'HBD' | 'HIVE' | 'BTC', balance: Big) =>
    canSign ? (
      <MagiSendDialog
        account={account}
        asset={asset}
        balance={balance}
        trigger={
          <button type="button" className={SEND_BUTTON_CLASS} data-testid={`wallet-magi-send-${asset.toLowerCase()}-button`}>
            {t('wallet.magi.actions.send')}
          </button>
        }
      />
    ) : null;

  const usdOf = (amount: Big, price: number | null | undefined): string | null =>
    typeof price === 'number' && price > 0 ? formatUsd(amount.toNumber() * price) : null;

  // The fuel gauge is the creator-tokens component, fed from THIS read so the
  // tab makes no second balance request for it.
  const fuelState: MagiSpendingPowerState = {
    power: assets
      ? {
          balance: { account: accountId, hbdBaseUnits: assets.hbdBaseUnits, blockHeight: assets.blockHeight },
          rc: { account: accountId, amount: assets.rc.amount, maxRcs: assets.rc.maxRcs },
          cannotTransact: assets.rc.amount <= 0
        }
      : null,
    isLoading: assetsLoading,
    failed: assetsFailed,
    unavailable: false,
    cannotTransact: assets !== null && assets.rc.amount < MAGI_MIN_RC_FOR_A_CALL,
    affordability: () => 'unknown',
    remedy: () => null
  };

  let total: Big | null = null;
  if (assets && prices) {
    const hbd = units(assets.hbdBaseUnits).plus(units(assets.hbdSavingsBaseUnits)).plus(units(assets.hbdUnstakingBaseUnits));
    const hive = units(assets.hiveBaseUnits).plus(units(assets.hiveConsensusBaseUnits)).plus(units(assets.hiveUnstakingBaseUnits));
    total = hbd.times(prices.hbdUsd).plus(hive.times(prices.hiveUsd));
    // ★ THE BTC LEG EITHER PRICES IN OR THE WHOLE TOTAL BLANKS (scrutiny B, 2026-09-08).
    // A total that silently drops a real BTC balance is a SMALLER number than the
    // truth — the same class as rendering a failed read as zero. So the total
    // stands only when the Bitcoin contribution is known to be exactly right:
    //  - the mapping contract isn't configured (no BTC row at all), or
    //  - BTC is a confirmed zero (contributes $0 whatever the price is), or
    //  - BTC is known AND a BTC/USD price exists.
    // Anything else — BTC still loading/failed, or a nonzero balance while
    // CoinGecko omits a BTC price (a documented-normal case,
    // use-hive-market-prices.ts) — means we cannot form an honest total, so it
    // shows a dash, exactly as the BTC row itself does.
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
    <div className={CARD_CLASS} data-testid={`wallet-magi-account-${account.kind}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <div className="text-[16px] leading-[24px] font-semibold text-ink-2">{ownLabel}</div>
          {account.address ? (
            <div className="break-all font-mono text-caption text-ink-10" title={account.id}>
              {account.address}
            </div>
          ) : (
            <div className="font-ui text-caption text-ink-10">{t('wallet.magi.account_hive_meta')}</div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* A Hive login signs Hive L1 transactions on the chain the Magi
              network reads; without that chain configured, Deposit / Withdraw /
              Swap are not offered to it (never a fallback to the app default
              chain, see lib/magi-l1-broadcast.ts). A wallet login signs Magi
              containers with its wallet and needs no L1 chain. */}
          {isHive && isMagiL1Configured() ? (
            <MagiDepositDialog
              username={account.id}
              trigger={
                <button type="button" className={PRIMARY_BUTTON_CLASS} data-testid="wallet-magi-deposit-button">
                  {t('wallet.magi.actions.deposit')}
                </button>
              }
            />
          ) : null}
          <MagiReceiveDialog
            account={account}
            trigger={
              <button type="button" className={isHive ? SECONDARY_BUTTON_CLASS : PRIMARY_BUTTON_CLASS} data-testid="wallet-magi-receive-button">
                {t('wallet.magi.actions.receive')}
              </button>
            }
          />
          {canSign ? (
            <MagiWithdrawDialog
              account={account}
              balances={withdrawBalances}
              trigger={
                <button type="button" className={SECONDARY_BUTTON_CLASS} data-testid="wallet-magi-withdraw-button">
                  {t('wallet.magi.actions.withdraw')}
                </button>
              }
            />
          ) : null}
          {canSign && isMagiSwapConfigured() ? (
            <MagiSwapDialog
              account={account}
              trigger={
                <button type="button" className={SECONDARY_BUTTON_CLASS} data-testid="wallet-magi-swap-button">
                  {t('wallet.magi.actions.swap')}
                </button>
              }
            />
          ) : null}
          <MagiBtcDepositDialog
            account={accountId}
            trigger={
              <button type="button" className={SECONDARY_BUTTON_CLASS} data-testid="wallet-magi-btc-deposit-button">
                {t('wallet.magi.actions.deposit_btc')}
              </button>
            }
          />
        </div>
      </div>

      <div className="mt-3">
        {assetsFailed ? (
          <p className="py-3 font-ui text-caption text-ink-10" data-testid="wallet-magi-failed">
            {t('wallet.magi.failed')}
          </p>
        ) : assetsLoading || !assets ? (
          <p className="py-3 font-ui text-caption text-ink-14" data-testid="wallet-magi-loading">
            {t('wallet.magi.loading')}
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
              testId="wallet-magi-row-hbd"
              action={sendPill('HBD', hbdBalance)}
            />
            <Row
              icon="HBD"
              name={t('wallet.magi.rows.shbd')}
              chip="sHBD"
              chipTone="green"
              description={t('wallet.magi.rows.shbd_sub')}
              amount={formatTokenAmount(units(assets.hbdSavingsBaseUnits))}
              unit="HBD"
              usd={usdOf(units(assets.hbdSavingsBaseUnits), prices?.hbdUsd)}
              testId="wallet-magi-row-shbd"
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
                testId="wallet-magi-row-hbd-unstaking"
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
              testId="wallet-magi-row-hive"
              action={sendPill('HIVE', hiveBalance)}
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
                testId="wallet-magi-row-hive-staked"
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
                testId="wallet-magi-row-hive-unstaking"
              />
            ) : null}
            {btcUnavailable ? null : btcFailed ? (
              <p className="py-3 font-ui text-caption text-ink-10" data-testid="wallet-magi-btc-failed">
                {t('wallet.magi.btc_failed')}
              </p>
            ) : btcLoading || btcSats === null ? (
              <p className="py-3 font-ui text-caption text-ink-14" data-testid="wallet-magi-btc-loading">
                {t('wallet.magi.loading')}
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
                testId="wallet-magi-row-btc"
                action={btcBalance !== null ? sendPill('BTC', btcBalance) : null}
              />
            )}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-card border border-line-9 bg-surface-5 px-4 py-3">
              <div>
                <div className="text-[14px] leading-[22px] font-semibold text-ink-2">{t('wallet.magi.value_title')}</div>
                <div className="font-ui text-caption text-ink-10">{t('wallet.magi.value_description')}</div>
              </div>
              <span className="font-num text-[22px] leading-[30px] font-semibold tabular-nums text-ink-2" data-testid="wallet-magi-value">
                {total === null ? '—' : formatUsd(total.toNumber())}
              </span>
            </div>
          </>
        )}
        <MagiFuelGauge state={fuelState} kind={account.kind} className="mt-4 border-t border-line-2 pt-4" />
      </div>
    </div>
  );
}
