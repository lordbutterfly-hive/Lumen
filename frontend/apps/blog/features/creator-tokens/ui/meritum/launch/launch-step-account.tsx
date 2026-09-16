'use client';

import { FC } from 'react';
import { UserAvatarImg } from '@ui/components';
import { useTranslation } from '@/blog/i18n/client';
import { PrimaryAction } from './launch-controls';
import { MeritumEligibilityNotice, useMeritumEligibility } from '../../meritum-eligibility';

/**
 * STEP 1 — the bound account.
 *
 * The account, whatever this account cannot do yet, and one confirmation.
 * Nothing here is a decision: the reader is being told what they are about to
 * be tied to, and asked whether it is them. It is deliberately the shortest
 * screen in the flow — everything a creator has to weigh is on steps 2 and 3.
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
  /*
    ★★★ THREE PROPS LEFT THIS SCREEN ON 2026-09-17, and none of them silently.

    `launchHoldHbd` and `rules` existed only to feed the billing disclosure
    below the card, and that disclosure is deleted — see the block comment in
    the body for why. Step 3 still takes both (`launch-step-terms.tsx`), so
    `use-meritum-launch.ts` keeps computing them; it is only this screen that
    no longer asks.

    `isLite` was already dead before this commit and the linter had been saying
    so ("'isLite' is defined but never used"). It was the input to the old
    `lite_note` line, which 2026-08-16 replaced with <MeritumEligibilityNotice>
    — a component that reads the rail's own capability flags through
    `useMeritumEligibility()` and needs nothing threaded down (see its own note
    at the call site, and the comment on `useMeritumEligibility` itself). The
    prop, its doc, its argument at the call site and the `flow.block === 'lite'`
    expression that computed it all go together, because a prop nobody reads is
    a claim that this screen behaves differently for a lite account, and it does
    not.
  */
  onConfirm: () => void;
}

const LaunchStepAccount: FC<LaunchStepAccountProps> = ({ handle, account, onConfirm }) => {
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
          <div className="truncate font-ui text-20 font-medium text-meritum-ink">
            {known ? handle : t('meritum_launch.account_unknown')}
          </div>
          <div className="font-ui text-caption text-meritum-ink-muted">{t('meritum_launch.bound_sub')}</div>
        </div>
        <span className="ml-auto text-label font-medium uppercase tracking-label text-meritum-ink-muted font-ui">
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

        ★★★ AND SO IS THE BILLING DISCLOSURE THAT REPLACED IT (2026-09-17, owner).
        It was written in 2026-08-17 to fix a real defect: the recurring $10
        month was only disclosed on step 3, after a reader had already written
        three offers, so steps 1-2 read as free. It brought the cost forward by
        reusing step 3's own strings (`term_launch_value`, `term_listed_label` +
        `term_listed_value`), and on 2026-09-12 it was rule-set branched so it
        would not quote a charge the v3 bytecode had stopped making.

        THE DEFECT IT FIXED NO LONGER EXISTS. With the 10 HBD month removed from
        the contract there is no late reveal to bring forward, and what the
        branch left on screen was two sentences about a fee that is not charged:
        "Your first month is included" (there are no months) and "To stay listed
        on Lumen: No monthly fee" (an answer to a question nobody is now asked).
        Naming an absent cost on the first screen of the flow invents the very
        doubt this block was added to remove. Owner: "since theres no fee, you
        can remove the whole text since it doesnt make sense."

        ★ THE LAUNCH-TIME HBD HOLD IS STILL DISCLOSED, on step 3's terms ledger
        (`term_launch_label`), where it is one row among the terms a creator
        actually accepts — and the fuel gauge there quotes it as a live figure
        when the balance is short. So nothing about what a launch COSTS was lost
        with this block; only the recurring charge that no longer exists. If a
        recurring cost is ever reintroduced, it comes back HERE, on the screen
        where the reader first decides, and the 2026-08-17 reasoning above is
        the reason why.
      */}

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
          className="rounded-card border border-meritum-line-card bg-meritum-paper px-4 py-3 font-ui text-14 leading-[22px] text-meritum-ink-3"
        />
      </div>

      <div className="mt-7 flex justify-center">
        <PrimaryAction label={t('meritum_launch.confirm_identity')} onClick={onConfirm} />
      </div>
    </div>
  );
};

export default LaunchStepAccount;
