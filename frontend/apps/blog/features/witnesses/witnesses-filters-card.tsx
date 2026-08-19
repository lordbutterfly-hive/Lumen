'use client';

import { Checkbox } from '@ui/components/checkbox';
import { Icons } from '@ui/components/icons';
import { useTranslation } from '@/blog/i18n/client';
import { UseWitnessFiltersResult } from './hooks/use-witness-filters';

const CHECKBOX_CLASS =
  'h-[18px] w-[18px] rounded-control border-2 border-line-20 data-[state=checked]:border-line-brand-10 data-[state=checked]:bg-surface-brand-12 data-[state=checked]:text-ink-27';

type FilterKey = 'active' | 'disabled' | 'stale' | 'top20' | 'approved';

/**
 * Right-rail Filters card: Active / Disabled-Stale / Top 20 / Approved
 * checkboxes, a name search box, and a version dropdown — all wired to
 * `useWitnessFilters` and applied client-side against the already-fetched
 * witness rows (no separate network round trip per filter).
 */
export default function WitnessesFiltersCard({
  filters,
  setFilter,
  toggleFilter,
  availableVersions
}: UseWitnessFiltersResult) {
  const { t } = useTranslation('common_blog');

  const checkboxRows: { key: FilterKey; label: string }[] = [
    { key: 'active', label: t('witnesses.filters.active') },
    { key: 'disabled', label: t('witnesses.filters.disabled') },
    { key: 'stale', label: t('witnesses.filters.stale') },
    { key: 'top20', label: t('witnesses.filters.top20') },
    { key: 'approved', label: t('witnesses.filters.approved') }
  ];

  return (
    <div data-testid="witnesses-filters-card">
      <div className="mb-4 font-sans text-[15px] leading-[24px] font-bold text-ink-2">{t('witnesses.filters.title')}</div>

      <div className="mb-2.5 font-sans text-label font-bold uppercase tracking-[0.05em] text-ink-14">
        {t('witnesses.filters.witness_group')}
      </div>
      <div className="mb-[18px] flex flex-col gap-[11px]">
        {checkboxRows.map(({ key, label }) => (
          <label key={key} className="flex cursor-pointer items-center gap-2.5 font-sans text-sm text-ink-7">
            <Checkbox
              className={CHECKBOX_CLASS}
              checked={filters[key]}
              onCheckedChange={() => toggleFilter(key)}
              data-testid={`witnesses-filter-${key}`}
            />
            {label}
          </label>
        ))}
      </div>

      <div className="mb-2.5 font-sans text-label font-bold uppercase tracking-[0.05em] text-ink-14">
        {t('witnesses.filters.name_group')}
      </div>
      <div className="mb-4 flex items-center gap-[9px] rounded-control border border-line-11 px-3 py-[9px]">
        <Icons.search className="h-[15px] w-[15px] text-ink-14" />
        <input
          type="text"
          value={filters.search}
          onChange={(e) => setFilter('search', e.target.value)}
          placeholder={t('witnesses.filters.search_placeholder')}
          aria-label={t('witnesses.filters.search_placeholder')}
          data-testid="witnesses-filter-search"
          className="w-full bg-transparent font-sans text-[14px] leading-[22px] text-ink-2 outline-none placeholder:text-ink-14"
        />
      </div>

      <div className="mb-2.5 font-sans text-label font-bold uppercase tracking-[0.05em] text-ink-14">
        {t('witnesses.filters.version_group')}
      </div>
      <select
        value={filters.version}
        onChange={(e) => setFilter('version', e.target.value)}
        aria-label={t('witnesses.filters.version_group')}
        data-testid="witnesses-filter-version"
        /* W-13 / X-6: this was a native select with the OS chrome on it, the only
           control on the page not drawn in the house style. `appearance-none` plus an
           inline chevron gives it the same border, radius and focus behaviour as
           every other control, without pulling in the Radix select for one field. */
        className="w-full appearance-none rounded-control border border-line-11 bg-surface-1 bg-[length:11px] bg-[right_12px_center] bg-no-repeat px-3 py-[9px] pr-9 font-sans text-[14px] leading-[22px] text-ink-2 outline-none focus-visible:border-line-brand-10"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 8' fill='none'%3E%3Cpath d='M1 1.5L6 6.5L11 1.5' stroke='%236b7280' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")"
        }}
      >
        <option value="any">{t('witnesses.filters.any_version')}</option>
        {availableVersions.map((version) => (
          <option key={version} value={version}>
            {version}
          </option>
        ))}
      </select>
    </div>
  );
}
