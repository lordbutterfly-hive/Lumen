'use client';

import { Icons } from '@ui/components/icons';
import TooltipContainer from '@ui/components/tooltip-container';
import { useTranslation } from '@/blog/i18n/client';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import NewProposalDialog from './new-proposal-dialog';

/** "Decentralized Hive Fund" heading + intro + the real New proposal dialog trigger. */
export default function ProposalsMainHeader() {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  // A lite account has no Hive keys and no way to pay the real HBD proposal fee —
  // the mutation backstop already refuses this (use-create-proposal-mutation.ts ->
  // refuseIfLite), but the dialog used to open the whole multi-field form and let
  // it go client-side "valid" before refusing only on Submit. Gate it here instead
  // so the trigger itself is disabled with a reason, and the form never opens.
  const isLiteBlocked = user.isLoggedIn && user.account_tier === 'lite';

  const trigger = (
    <button
      type="button"
      disabled={isLiteBlocked}
      className="flex shrink-0 items-center gap-1.5 rounded-[11px] bg-[#1a1a17] px-[18px] py-[11px] font-sans text-sm font-semibold text-white transition-colors hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
      data-testid="new-proposal-open"
    >
      <Icons.add className="h-[15px] w-[15px]" />
      {t('proposals.header.new_proposal')}
    </button>
  );

  return (
    // ★ flex-wrap (2026-08-08). At 390px the heading's own min-content plus the
    // 153px "New proposal" button came to more than the 342px of content box
    // available, and neither child could shrink further — the button is
    // `shrink-0` and the h1 is a 32px word. Measured: page scrollWidth 399
    // against a 390 viewport, with the button's right edge past the screen. The
    // button now drops to its own line at that width and nothing else moves;
    // at every width where both fit on one row (820px onwards) the row is
    // unchanged, because wrapping only happens when it must.
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="font-sans text-[32px] font-bold tracking-[-0.02em] text-[#161511]">
          {t('proposals.header.title')}
        </h1>
        <p className="mt-2 max-w-[620px] font-serif text-sm leading-[1.55] text-[#6b7280]">
          {t('proposals.header.intro')}{' '}
          <a href="/faq.html" className="text-[#c0392b] hover:underline">
            {t('proposals.header.faq_link')}
          </a>
          .
        </p>
      </div>
      {isLiteBlocked ? (
        <TooltipContainer title={t('proposals.lite_cannot_vote')}>{trigger}</TooltipContainer>
      ) : (
        <NewProposalDialog>{trigger}</NewProposalDialog>
      )}
    </div>
  );
}
