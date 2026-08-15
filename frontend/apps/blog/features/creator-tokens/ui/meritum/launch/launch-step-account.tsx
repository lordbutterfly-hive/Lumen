'use client';

import { FC } from 'react';
import { UserAvatarImg } from '@ui/components';
import { useTranslation } from '@/blog/i18n/client';
import { PrimaryAction } from './launch-controls';

/**
 * STEP 1 — the bound account.
 *
 * The account, three facts about what binding means, and one confirmation.
 * Nothing here is a decision: the reader is being told what they are about to
 * be tied to, and asked whether it is them.
 *
 * ★ THE HANDLE COMES FROM THE SESSION, NEVER FROM A PLACEHOLDER. `@hbd-temp`
 * in the reference and `@—` in the old wizard both reached real readers on the
 * first screen of a flow whose entire premise is "a token bound to your
 * account". If the session has not answered yet, this panel says so instead of
 * inventing a name.
 */

export interface LaunchStepAccountProps {
  /** `@name`, or '' while the session has not answered. */
  handle: string;
  /** Bare account name for the avatar. */
  account: string;
  /** True when this account has no Hive keys and therefore cannot sign. */
  isLite: boolean;
  onConfirm: () => void;
}

const LaunchStepAccount: FC<LaunchStepAccountProps> = ({ handle, account, isLite, onConfirm }) => {
  const { t } = useTranslation('common_blog');
  const known = handle !== '';

  const facts = [
    { id: 'one', value: '1', label: t('meritum_launch.fact_one_market') },
    { id: 'zero', value: '0', label: t('meritum_launch.fact_no_rename') },
    { id: 'name', value: known ? handle.slice(1) : '?', label: t('meritum_launch.fact_only_name') }
  ];

  return (
    <div className="mt-step">
      <div className="mt-[26px] flex items-center gap-[15px] rounded-2xl border border-meritum-line-card bg-meritum-rail px-5 py-4">
        {account ? (
          <UserAvatarImg username={account} apiSize="medium" pixelSize={46} radiusClassName="rounded-[13px]" />
        ) : (
          <span aria-hidden="true" className="h-[46px] w-[46px] flex-shrink-0 rounded-[13px] bg-meritum-line-input" />
        )}
        <div className="min-w-0">
          <div className="truncate font-serif text-20 font-semibold text-meritum-ink">
            {known ? handle : t('meritum_launch.account_unknown')}
          </div>
          <div className="font-serif text-13 text-meritum-ink-muted">{t('meritum_launch.bound_sub')}</div>
        </div>
        <span className="ml-auto text-12 font-bold uppercase tracking-[0.16em] text-meritum-ink-muted">
          {t('meritum_launch.bound_badge')}
        </span>
      </div>

      {/* Stat tiles, not a description list: the figure reads first and the
          label explains it, which is the reverse of dt/dd's own semantics. */}
      <div className="mt-[26px] grid grid-cols-3 gap-[34px] border-t border-meritum-line-card pt-[22px]">
        {facts.map((fact) => (
          <div key={fact.id}>
            <div className="truncate font-serif text-24 font-semibold text-meritum-ink">{fact.value}</div>
            <div className="mt-1 font-serif text-12 text-meritum-ink-muted">{fact.label}</div>
          </div>
        ))}
      </div>

      {isLite ? (
        <p className="mt-5 font-serif text-14 text-meritum-ink-3">
          {t('meritum_launch.lite_note')}{' '}
          <a href="/upgrade" className="font-semibold text-meritum-ink-link hover:underline">
            {t('meritum_launch.lite_upgrade')}
          </a>
        </p>
      ) : null}

      <div className="mt-7 flex justify-center">
        <PrimaryAction label={t('meritum_launch.confirm_identity')} onClick={onConfirm} />
      </div>
    </div>
  );
};

export default LaunchStepAccount;
