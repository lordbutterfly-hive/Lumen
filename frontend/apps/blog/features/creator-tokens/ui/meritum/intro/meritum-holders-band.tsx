'use client';

import { Trans } from 'react-i18next';
import { useTranslation } from '@/blog/i18n/client';
import styles from './meritum-intro.module.css';

/**
 * THE SECOND BAND OF THE MERITUM INTRO — the followers-to-holders argument.
 *
 * Item 6 of the fixed order in `handoff_meritum_onboarding/README.md`: a white
 * band under the warm paper one, carrying the quote on the left and the three
 * struck-out objections plus the live pill on the right. It is a separate file
 * from `meritum-intro.tsx` only because the two together run past this repo's
 * file-length rule; it is not reusable and is not exported beyond the card.
 *
 * ★ WHITE ON WARM, ON PURPOSE. `bg-meritum-card` is `--surface-1`, the app's
 * plain card white — the same token the launch card uses. The colour change
 * against the masthead wash above (`--masthead-1..4`, the same gradient the
 * app's own PageMasthead uses) is the only thing separating the two halves
 * apart from one hairline, so it is not decoration and must not be collapsed
 * into the paper to "tidy up" the card.
 */

/** The prohibition mark beside each objection. Decorative: the line says "No …" itself. */
function ProhibitionIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      className="flex-none text-meritum-ink-brand"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="9" cy="9" r="7.1" />
      <path d="M6.3 6.3l5.4 5.4" />
    </svg>
  );
}

export default function MeritumHoldersBand() {
  const { t } = useTranslation('common_blog');

  /**
   * Literal keys, not a template built from an id list: the repo's translation
   * checker (`scripts/check-blog-translation-usage.js`) reads the argument of
   * every t call statically, and a computed key is invisible to it: the key
   * would silently
   * rot the first time someone renamed it. The `id` is only React's list key,
   * kept separate from the text so a translation that happened to duplicate
   * another line could not collapse two rows into one.
   */
  const objections = [
    { id: 'contracts', text: t('meritum.intro.no_contracts') },
    { id: 'liquidity', text: t('meritum.intro.no_liquidity') },
    { id: 'engineering', text: t('meritum.intro.no_engineering') }
  ];

  return (
    // `gap-x-10` is 40px against the reference's 48px, and it is part of the
    // measured fit documented on `.copyColumn` — 8px is what buys the two
    // columns their slack at a 1440px viewport. `gap-y` is the reference's.
    <div className="flex flex-wrap items-start gap-x-10 gap-y-[34px] border-t border-meritum-line-paper bg-meritum-card px-6 pb-9 pt-9 sm:px-11 sm:pb-[42px] sm:pt-10">
      <div className={styles.copyColumn}>
        {/* `tracking-tight` is -0.025em against the reference's -0.022em: a hair,
            so the app token wins per the handoff's own ground rule. */}
        <p className="max-w-[24ch] text-pretty font-ui text-30 font-medium leading-[1.22] tracking-tight text-meritum-ink">
          <Trans
            t={t}
            i18nKey="meritum.intro.quote"
            components={{ holders: <span className="font-medium text-meritum-ink-brand" /> }}
          />
        </p>
        <p className="mt-5 max-w-[42ch] font-ui text-17 text-meritum-ink-3">
          <Trans t={t} i18nKey="meritum.intro.quote_support" components={{ lead: <span className="font-medium text-meritum-ink" /> }} />
        </p>
      </div>

      <div className={styles.listColumn}>
        {/* The hairlines BETWEEN rows are the 1px gaps in a line-coloured stack,
            not three borders — so the list has no rule above the first row or
            below the last, which is what the reference shows. */}
        <div className="flex flex-col gap-px bg-meritum-line-card">
          {objections.map((objection) => (
            <div key={objection.id} className="flex items-center gap-3 bg-meritum-card px-0.5 py-[15px]">
              <ProhibitionIcon />
              <span className="font-ui text-16 text-meritum-ink-2">{objection.text}</span>
            </div>
          ))}
        </div>

        <div className="mt-[22px] flex flex-wrap items-center gap-3">
          <span className="font-ui text-17 font-medium text-meritum-ink">{t('meritum.intro.no_gatekeeping')}</span>
          <span className="inline-flex items-center gap-2 rounded-full border border-meritum-line-paper bg-meritum-paper px-[13px] py-1.5">
            {/* Same pulse and the same tracking as the tape's LIVE badge — two
                live markers on one screen that differed by 0.06em of tracking
                would read as a mistake, not as a distinction. */}
            <span className="mt-dot h-[7px] w-[7px] flex-none rounded-full bg-meritum-surface-brand" aria-hidden="true" />
            <span className="font-ui text-label font-medium uppercase tracking-meritum-eyebrow text-meritum-ink-brand">
              {t('meritum.intro.live_pill')}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
