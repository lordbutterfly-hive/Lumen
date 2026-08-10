'use client';

import { useTranslation } from '@/blog/i18n/client';
import PageMasthead from '@/blog/features/layouts/page-masthead';
import { WitnessViewMode } from './lib/types';

const TOGGLE_WRAP_CLASS =
  'flex shrink-0 rounded-[11px] border border-[#ebedf0] bg-[#f4f5f7] p-1 font-sans text-[13px] font-semibold';

const TOGGLE_BTN_BASE = 'rounded-[9px] px-4 py-[7px] transition-colors';
const TOGGLE_BTN_ACTIVE = 'bg-white text-[#161511] shadow-[0_1px_2px_rgba(20,18,10,0.08)]';
const TOGGLE_BTN_INACTIVE = 'text-[#6b7280] hover:text-[#161511]';

interface WitnessesHeaderProps {
  viewMode: WitnessViewMode;
  onViewModeChange: (mode: WitnessViewMode) => void;
}

/**
 * Page title + intro copy + the General/Params segmented toggle that
 * switches which columns `WitnessesTable` renders.
 */
export default function WitnessesHeader({ viewMode, onViewModeChange }: WitnessesHeaderProps) {
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
      actions={
        <div className={TOGGLE_WRAP_CLASS} role="tablist" aria-label={t('witnesses.view_toggle.aria_label')}>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'general'}
            data-testid="witnesses-view-general"
            className={`${TOGGLE_BTN_BASE} ${viewMode === 'general' ? TOGGLE_BTN_ACTIVE : TOGGLE_BTN_INACTIVE}`}
            onClick={() => onViewModeChange('general')}
          >
            {t('witnesses.view_toggle.general')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'params'}
            data-testid="witnesses-view-params"
            className={`${TOGGLE_BTN_BASE} ${viewMode === 'params' ? TOGGLE_BTN_ACTIVE : TOGGLE_BTN_INACTIVE}`}
            onClick={() => onViewModeChange('params')}
          >
            {t('witnesses.view_toggle.params')}
          </button>
        </div>
      }
    >
      <p className="max-w-[620px] font-serif text-[13px] leading-[1.55] text-[#6b7280]">{t('witnesses.intro')}</p>
    </PageMasthead>
  );
}
