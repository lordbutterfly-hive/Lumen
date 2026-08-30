'use client';

import { FC } from 'react';
import { UserAvatarImg } from '@ui/components';
import { useTranslation } from '@/blog/i18n/client';
import { PrimaryAction } from './launch-controls';
import { MeritumEligibilityNotice, useMeritumEligibility } from '../../meritum-eligibility';

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
  const eligibility = useMeritumEligibility();
  const { t } = useTranslation('common_blog');
  const known = handle !== '';

  return (
    <div className="mt-step">
      <div className="mt-[26px] flex items-center gap-[15px] rounded-2xl border border-meritum-line-card bg-meritum-rail px-5 py-4">
        {account ? (
          <UserAvatarImg username={account} apiSize="medium" pixelSize={46} radiusClassName="rounded-card" />
        ) : (
          <span aria-hidden="true" className="h-[46px] w-[46px] flex-shrink-0 rounded-card bg-meritum-line-input" />
        )}
        <div className="min-w-0">
          <div className="truncate font-serif text-20 font-semibold text-meritum-ink">
            {known ? handle : t('meritum_launch.account_unknown')}
          </div>
          <div className="font-serif text-caption text-meritum-ink-muted">{t('meritum_launch.bound_sub')}</div>
        </div>
        <span className="ml-auto text-label font-bold uppercase tracking-label text-meritum-ink-muted">
          {t('meritum_launch.bound_badge')}
        </span>
      </div>

      {/*
        ★ THE 3-TILE STAT BLOCK IS GONE (2026-08-17, verified UX defect #4).
        All three figures duplicated something already on this same screen:
        "1 · token market per account" restated `bound_sub` above ("Signed in ·
        one market per account"); "0 · ways to rename or move it" restated what
        `term_final_value` said on step 3 ("cannot be closed, renamed, or moved
        to another account") — that row has since been deleted outright (owner,
        2026-08-30, see launch-step-terms.tsx), which retires the duplication
        argument but not the conclusion; and the account-name tile just repeated
        the handle already shown, full-width, in the card above it — except
        `truncate` with no `title` clipped it (`testera…`) where the card above
        does not. A tile that only repeats a neighbour, worse, is not
        information, it is noise that also breaks.

        ★ AND THIS IS WHERE THE $10/MONTH GOES INSTEAD (defect #1). The old
        wizard only disclosed the recurring cost on step 3, inside the terms
        list, after a reader had already written three offers. Steps 1-2 read
        as free. Reusing the exact two strings step 3's terms list already
        renders (`term_launch_value`, `term_listed_label` + `term_listed_value`)
        — no new copy, same facts, just told on the screen where the reader
        first decides to do this at all, as plain text, not a tooltip.
      */}
      <div className="mt-[26px] border-t border-meritum-line-card pt-[22px] font-serif text-caption text-meritum-ink-muted">
        <p>{t('meritum_launch.term_launch_value')}</p>
        <p className="mt-1.5">
          <span className="font-semibold text-meritum-ink-3">{t('meritum_launch.term_listed_label')}:</span>{' '}
          {t('meritum_launch.term_listed_value')}
        </p>
      </div>

      {/* ★ 2026-08-16, owner. This used to say "This account cannot sign
          transactions yet" to EVERY lite account, which is wrong twice: a
          Google-only account has no Magi account at all (so there is nothing to
          sign WITH, and nothing to hold either), and a wallet-bound account can
          already hold — what it cannot do is issue a Meritum, because a Meritum
          is issued against a Hive identity. One component now answers both, off
          the rail's own capability flags. Meritum palette passed in, so the
          notice does not import a `surface-warn-*` box onto this screen. */}
      <div className="mt-5">
        <MeritumEligibilityNotice
          surface="launch"
          who={eligibility}
          className="rounded-card border border-meritum-line-card bg-meritum-paper px-4 py-3 font-serif text-14 leading-[22px] text-meritum-ink-3"
        />
      </div>

      <div className="mt-7 flex justify-center">
        <PrimaryAction label={t('meritum_launch.confirm_identity')} onClick={onConfirm} />
      </div>
    </div>
  );
};

export default LaunchStepAccount;
