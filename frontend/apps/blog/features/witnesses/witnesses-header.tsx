'use client';

import { useTranslation } from '@/blog/i18n/client';
import PageMasthead from '@/blog/features/layouts/page-masthead';


/**
 * ★ THE GENERAL / PARAMS TOGGLE IS GONE (owner ruling, 2026-08-10). The parameters
 * view was a second table of witness-published settings that nobody asked this page
 * for; the general view is the page. Removing the switch also removes the whole class
 * of bugs it carried: the two tabs truncated the statement column differently, only
 * one of them showed the HBD rate, and the tab state had to be mirrored into the URL.
 */
interface WitnessesHeaderProps {}

/**
 * Page title + intro copy + the General/Params segmented toggle that
 * switches which columns `WitnessesTable` renders.
 */
export default function WitnessesHeader() {
  const { t } = useTranslation('common_blog');

  return (
    /* ★ W-4: this was bare text on the page background. The container was already
       the hero width, so the shell had simply never been applied. No mark: witnesses
       has no assigned glyph and inventing one here would violate R5. */
    <PageMasthead
      title={
        <>
          {t('witnesses.title')}{' '}
          <span className="font-normal italic text-[#9ca3af]">{t('witnesses.subtitle')}</span>
        </>
      }
    >
      <p className="max-w-[620px] font-serif text-[13px] leading-[20px] text-[#6b7280]">{t('witnesses.intro')}</p>
    </PageMasthead>
  );
}
