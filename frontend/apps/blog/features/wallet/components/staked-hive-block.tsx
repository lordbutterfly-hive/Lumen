'use client';

import Big from 'big.js';
import { Icons } from '@ui/components/icons';
import { GetDynamicGlobalPropertiesResponse } from '@hiveio/wax';
import { useTranslation } from '@/blog/i18n/client';
import { WalletFigures } from '../lib/wallet-derived';
import { formatTokenAmount } from '../lib/format-amount';
import PowerUpDialog from './dialogs/power-up-dialog';
import PowerDownDialog from './dialogs/power-down-dialog';
import StopPowerDownAlert from './dialogs/stop-power-down-alert';
import DelegatedOutPanel from './delegated-out-panel';

// W-2/W-3: both were rounded-[10px], and Stake was bg-surface-ok-7.
const STAKE_BUTTON_CLASS =
  'flex items-center gap-1.5 rounded-[14px] bg-surface-brand-12 px-[15px] py-2 text-[13px] leading-[20px] font-semibold text-ink-27 transition-colors hover:bg-surface-brand-17';
const UNSTAKE_BUTTON_CLASS =
  'flex items-center gap-1.5 rounded-[14px] border border-line-11 bg-surface-1 px-[15px] py-2 text-[13px] leading-[20px] font-semibold text-ink-7 transition-colors hover:bg-surface-16';

export default function StakedHiveBlock({
  username,
  figures,
  liquidHive,
  dynamicGlobal
}: {
  username: string;
  figures: WalletFigures;
  liquidHive: Big;
  dynamicGlobal: GetDynamicGlobalPropertiesResponse | null;
}) {
  const { t } = useTranslation('common_blog');
  const { vestingHp, netHp, movableHp, delegatedOutHp, hpApr, powerDown } = figures;

  return (
    <div className="mt-5 flex flex-col gap-5 border-l-2 border-line-2 pl-4">
      {/* ★ MOBILE OVERFLOW FIX (2026-08-14). No `flex-wrap` here meant the
          description block on the left and the HP-figures/Stake/Unstake
          column on the right were forced onto one line. The right column's
          own min width is set by its Stake+Unstake button row (two padded,
          non-breaking buttons) and by two tabular-nums lines that can't
          break (`wallet-hp-balance`) or only break at word boundaries
          (`wallet-hp-effective`, "{{value}} HP after delegations" as ONE
          string) — none of that can shrink to fit the ~60-90px that was left
          over after the badges row on the left took its share of a ~294px
          card content box at 390px. Left without room to wrap, the right
          column's box was pushed past x=390: the vestingHp headline number
          ("74,888.31…") and the hp_effective line ("69,538.635 HP afte…")
          are both right-aligned inside that pushed-out box, so their tails
          are what fell off the viewport edge, and the Unstake button — last
          in the row, so furthest right — went with them. `flex-wrap` lets
          the right column drop to its own full-width line instead, where
          all three of those fit comfortably unwrapped. */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-4">
        <div className="max-w-[520px]">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-[15px] leading-[24px] font-bold text-ink-4">{t('wallet.staked.title')}</span>
            {/* ink-8 not ink-10: #6b7280 on the #f1f3f5 chip ground is 4.35:1, under the 4.5:1 AA floor. ink-8 is 6.79:1 on the same ground. Same fix as the REP pill on the profile (2026-08-16). */}
            <span className="rounded-[7px] bg-surface-23 px-2 py-[2px] text-[12px] font-bold text-ink-8">
              {t('wallet.staked.badge')}
            </span>
            <span className="rounded-[7px] bg-surface-ok-5 px-2 py-[2px] text-[12px] font-bold text-ink-ok-2">
              {t('wallet.staked.apr', { apr: hpApr.toFixed(2) })}
            </span>
          </div>
          <p className="font-serif text-[14px] leading-[22px] text-ink-10">{t('wallet.staked.description')}</p>

          {powerDown.isActive ? (
            <div
              // W-3: was rounded-[10px]. A notice is a row; rows are 14px.
              className="mt-2.5 flex items-center gap-2.5 rounded-[14px] border border-line-warn-2 bg-surface-warn-3 px-3 py-2.5 text-[13px] leading-[20px] text-ink-warn-2"
              data-testid="wallet-power-down-notice"
            >
              <Icons.warning className="h-[15px] w-[15px] shrink-0 text-ink-warn-7" />
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
                    className="shrink-0 rounded-[7px] border border-line-brand-6 bg-surface-1 px-2.5 py-[2px] text-[12px] leading-[18px] font-bold text-ink-brand-6 hover:bg-surface-brand-4"
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
            <div className="font-sans text-[20px] font-bold tabular-nums text-ink-2" data-testid="wallet-hp-balance">
              {formatTokenAmount(vestingHp)}
            </div>
            {/* ★ W-11: ONE LABEL, ONE FORMAT, ON BOTH PAGES.
                This read "Total 69,519.353 HP" while the profile's own tile read
                "69,519 HP after delegations" for the same account and the same
                figure — two labels and two precisions for one number, and "Total"
                was the wrong word for it besides (it is smaller than the headline
                above, because it subtracts delegated-out HP). Both surfaces now
                use `profile.stats.hp_effective` and the wallet's 3-decimal token
                format. See features/account-profile/redesign/profile-stats-bar.tsx. */}
            <div className="text-[12px] tabular-nums text-ink-14" data-testid="wallet-hp-effective">
              {t('profile.stats.hp_effective', { value: formatTokenAmount(netHp) })}
            </div>
          </div>
          {/* ★ Defensive `flex-wrap` (2026-08-14). Not required to clear the
              reported bug on English copy — once the outer row above wraps,
              this pair fits the full ~294px card width unwrapped — but a
              longer translated "Stake"/"Unstake" label pair could reopen the
              same edge-clip on a narrower phone or a longer locale, and
              wrapping two buttons costs nothing on the layouts where it
              never triggers. */}
          <div className="flex flex-wrap items-center gap-2">
            <PowerUpDialog
              username={username}
              hiveBalance={liquidHive}
              trigger={
                <button
                  type="button"
                  className={STAKE_BUTTON_CLASS}
                  data-testid="wallet-stake-button"
                >
                  {t('wallet.staked.stake')}
                </button>
              }
            />
            <PowerDownDialog
              username={username}
              // ★ MOVABLE, not effective (2026-08-09). These dialogs SPEND stake, and
              // `netHp` includes HP delegated IN, which cannot be powered down or
              // re-delegated. Passing it let the Unstake dialog accept 30.030 HP on an
              // account that owned 0.000 — a transaction the chain was always going to
              // refuse, configured with no warning.
              // ★ Prop renamed netHp -> maxHp (2026-08-13, map item 10 rider). This
              // prop was literally named `netHp` while receiving `movableHp` — the
              // exact mislabel that let the sibling Delegate dialog reintroduce this
              // class of bug by passing `netHp` (the real net figure) through
              // unchanged. `maxHp` names what every caller must supply: the true
              // ceiling for whatever this dialog moves.
              maxHp={movableHp}
              trigger={
                <button
                  type="button"
                  className={UNSTAKE_BUTTON_CLASS}
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
      />
    </div>
  );
}
