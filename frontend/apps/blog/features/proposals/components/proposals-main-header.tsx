'use client';

import { Icons } from '@ui/components/icons';
import PageMasthead from '@/blog/features/layouts/page-masthead';
import TooltipContainer from '@ui/components/tooltip-container';
import { useTranslation } from '@/blog/i18n/client';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import NewProposalDialog from './new-proposal-dialog';
import { SHOW_HELP_LINKS } from '@/blog/lib/help-visibility';

/** "Decentralized Hive Fund" heading + intro + the real New proposal dialog trigger. */
export default function ProposalsMainHeader() {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  // A lite account has no Hive keys and no way to pay the real HBD proposal fee —
  // the mutation backstop already refuses this (use-create-proposal-mutation.ts ->
  // refuseIfLite), but the dialog used to open the whole multi-field form and let
  // it go client-side "valid" before refusing only on Submit. Gate it here instead
  // so the trigger itself is disabled with a reason, and the form never opens.
  // ★ ITS OWN COPY, NOT THE VOTING COPY (2026-08-16, found by a QA pass).
  // This tooltip reused `proposals.lite_cannot_vote` — "Voting on proposals
  // needs a full Hive account. Upgrade to vote." — on a button that does not
  // vote. It SUBMITS a proposal, which additionally costs a real HBD fee, so
  // the reused sentence both named the wrong action and understated the
  // requirement.
  const isLiteBlocked = user.isLoggedIn && user.account_tier === 'lite';

  const trigger = (
    <button
      type="button"
      disabled={isLiteBlocked}
      className="flex shrink-0 items-center gap-1.5 rounded-control bg-surface-brand-12 px-[18px] py-[11px] font-sans text-sm font-semibold text-ink-27 transition-colors hover:bg-surface-brand-16 disabled:cursor-not-allowed disabled:opacity-50"
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
          <span className="font-normal italic text-ink-14">{t('proposals.header.subtitle')}</span>
        </>
      }
      actions={
        isLiteBlocked ? (
          <TooltipContainer title={t('proposals.lite_cannot_create')}>{trigger}</TooltipContainer>
        ) : (
          <NewProposalDialog>{trigger}</NewProposalDialog>
        )
      }
    >
      {/* ★ THE THIRD ROUTE INTO /help.html, HIDDEN 2026-08-27 (owner, "get rid of
          help as well"). It is labelled "FAQ" rather than "Help", which is why a
          grep for the word Help misses it — the destination is what matters, not
          the label.

          The SENTENCE has to change with it, not just the anchor. `intro` ends
          "...Read more in the", with the link and the full stop supplied by this
          JSX, so hiding only the `<a>` would render "Read more in the ." on the
          page. `intro_no_faq` is the same sentence without that trailing clause;
          flipping `SHOW_HELP_LINKS` restores both halves together. */}
      <p className="max-w-[620px] font-serif text-caption text-ink-10">
        {SHOW_HELP_LINKS ? (
          <>
            {t('proposals.header.intro')}{' '}
            <a href="/help.html" className="text-ink-brand-6 hover:underline">
              {t('proposals.header.faq_link')}
            </a>
            .
          </>
        ) : (
          t('proposals.header.intro_no_faq')
        )}
      </p>
    </PageMasthead>
  );
}
