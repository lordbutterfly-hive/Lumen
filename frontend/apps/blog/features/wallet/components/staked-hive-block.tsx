'use client';

import Big from 'big.js';
import { AlertCircle } from 'lucide-react';
import { GetDynamicGlobalPropertiesResponse } from '@hiveio/wax';
import { Chain } from '@transaction/lib/chain';
import { useTranslation } from '@/blog/i18n/client';
import { WalletFigures } from '../lib/wallet-derived';
import { formatTokenAmount } from '../lib/format-amount';
import PowerUpDialog from './dialogs/power-up-dialog';
import PowerDownDialog from './dialogs/power-down-dialog';
import StopPowerDownAlert from './dialogs/stop-power-down-alert';
import DelegatedOutPanel from './delegated-out-panel';

export default function StakedHiveBlock({
  username,
  figures,
  liquidHive,
  dynamicGlobal,
  chain
}: {
  username: string;
  figures: WalletFigures;
  liquidHive: Big;
  dynamicGlobal: GetDynamicGlobalPropertiesResponse | null;
  chain: Chain | null;
}) {
  const { t } = useTranslation('common_blog');
  const { vestingHp, netHp, delegatedOutHp, hpApr, powerDown } = figures;

  return (
    <div className="mt-5 flex flex-col gap-5 border-l-2 border-[#f1f3f5] pl-4">
      <div className="flex items-start justify-between gap-4">
        <div className="max-w-[520px]">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-[15px] font-bold text-[#2a2822]">{t('wallet.staked.title')}</span>
            <span className="rounded-[7px] bg-[#f1f3f5] px-2 py-[2px] text-[11.5px] font-bold text-[#6b7280]">
              {t('wallet.staked.badge')}
            </span>
            <span className="rounded-[7px] bg-[#e9f5ee] px-2 py-[2px] text-[11.5px] font-bold text-[#2f7d4f]">
              {t('wallet.staked.apr', { apr: hpApr.toFixed(2) })}
            </span>
          </div>
          <p className="font-serif text-[13.5px] leading-[1.5] text-[#6b7280]">{t('wallet.staked.description')}</p>

          {powerDown.isActive ? (
            <div
              className="mt-2.5 flex items-center gap-2.5 rounded-[10px] border border-[#f6e2c4] bg-[#fef6ec] px-3 py-2.5 text-[12.5px] text-[#8a5a20]"
              data-testid="wallet-power-down-notice"
            >
              <AlertCircle className="h-[15px] w-[15px] shrink-0 text-[#c98a2b]" />
              <span className="flex-1">
                {t('wallet.staked.power_down_notice', {
                  days: powerDown.daysUntilNext,
                  amount: powerDown.nextPaymentHp.toFixed(3),
                  weeks: powerDown.weeksLeft
                })}
              </span>
              <StopPowerDownAlert
                username={username}
                trigger={
                  <button
                    type="button"
                    className="shrink-0 rounded-[7px] border border-[#d99] bg-white px-2.5 py-[2px] text-[11px] font-bold text-[#c0392b] hover:bg-[#fdf2f1]"
                    data-testid="wallet-stop-power-down"
                  >
                    {t('wallet.staked.stop')}
                  </button>
                }
              />
            </div>
          ) : null}
        </div>

        <div className="flex flex-col items-end gap-2.5">
          <div className="text-right">
            <div className="font-sans text-[20px] font-bold tabular-nums text-[#161511]" data-testid="wallet-hp-balance">
              {formatTokenAmount(vestingHp)}
            </div>
            <div className="text-[12px] tabular-nums text-[#9ca3af]">
              {t('wallet.staked.total_label', { amount: formatTokenAmount(netHp) })}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <PowerUpDialog
              username={username}
              hiveBalance={liquidHive}
              trigger={
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded-[10px] bg-[#2f7d4f] px-[15px] py-2 text-[13px] font-semibold text-white hover:bg-[#256640]"
                  data-testid="wallet-stake-button"
                >
                  {t('wallet.staked.stake')}
                </button>
              }
            />
            <PowerDownDialog
              username={username}
              netHp={netHp}
              trigger={
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded-[10px] border border-[#e4e6e9] bg-white px-[15px] py-2 text-[13px] font-semibold text-[#3f4650] hover:bg-[#f6f7f8]"
                  data-testid="wallet-unstake-button"
                >
                  {t('wallet.staked.unstake')}
                </button>
              }
            />
          </div>
        </div>
      </div>

      <DelegatedOutPanel
        username={username}
        delegatedOutHp={delegatedOutHp}
        dynamicGlobal={dynamicGlobal}
        chain={chain}
      />
    </div>
  );
}
