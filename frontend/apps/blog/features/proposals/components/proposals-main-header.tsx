'use client';

import { Icons } from '@ui/components/icons';
import PageMasthead from '@/blog/features/layouts/page-masthead';
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
      className="flex shrink-0 items-center gap-1.5 rounded-[11px] bg-[#c0392b] px-[18px] py-[11px] font-sans text-sm font-semibold text-white transition-colors hover:bg-[#a5301f] disabled:cursor-not-allowed disabled:opacity-50"
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
    /* X-1: proposals had a third page-header treatment of its own. Same masthead as
       home, topics and witnesses now. No mark: /proposals has no assigned glyph (R5). */
    <PageMasthead
      title={
        <>
          {t('proposals.header.title')}{' '}
          <span className="font-normal italic text-[#9ca3af]">{t('proposals.header.subtitle')}</span>
        </>
      }
      actions={
        isLiteBlocked ? (
          <TooltipContainer title={t('proposals.lite_cannot_vote')}>{trigger}</TooltipContainer>
        ) : (
          <NewProposalDialog>{trigger}</NewProposalDialog>
        )
      }
    >
      <p className="max-w-[620px] font-serif text-[13px] leading-[1.55] text-[#6b7280]">
        {t('proposals.header.intro')}{' '}
        <a href="/help.html" className="text-[#c0392b] hover:underline">
          {t('proposals.header.faq_link')}
        </a>
        .
      </p>
    </PageMasthead>
  );
}
