'use client';

import { Checkbox } from '@ui/components/checkbox';
import { Icons } from '@ui/components/icons';
import { useTranslation } from '@/blog/i18n/client';
import { UseWitnessFiltersResult } from './hooks/use-witness-filters';

const CHECKBOX_CLASS =
  'h-[18px] w-[18px] rounded-[6px] border-[1.5px] border-[#d5d8dd] data-[state=checked]:border-[#c0392b] data-[state=checked]:bg-[#c0392b] data-[state=checked]:text-white';

type FilterKey = 'active' | 'disabledOrStale' | 'top20' | 'approved';

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
    { key: 'disabledOrStale', label: t('witnesses.filters.disabled_stale') },
    { key: 'top20', label: t('witnesses.filters.top20') },
    { key: 'approved', label: t('witnesses.filters.approved') }
  ];

  return (
    <div data-testid="witnesses-filters-card">
      <div className="mb-4 font-sans text-[14.5px] font-bold text-[#161511]">{t('witnesses.filters.title')}</div>

      <div className="mb-2.5 font-sans text-[11px] font-bold uppercase tracking-[0.05em] text-[#9ca3af]">
        {t('witnesses.filters.witness_group')}
      </div>
      <div className="mb-[18px] flex flex-col gap-[11px]">
        {checkboxRows.map(({ key, label }) => (
          <label key={key} className="flex cursor-pointer items-center gap-2.5 font-sans text-sm text-[#3f4650]">
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

      <div className="mb-2.5 font-sans text-[11px] font-bold uppercase tracking-[0.05em] text-[#9ca3af]">
        {t('witnesses.filters.name_group')}
      </div>
      <div className="mb-4 flex items-center gap-[9px] rounded-[10px] border border-[#e4e6e9] px-3 py-[9px]">
        <Icons.search className="h-[15px] w-[15px] text-[#9ca3af]" />
        <input
          type="text"
          value={filters.search}
          onChange={(e) => setFilter('search', e.target.value)}
          placeholder={t('witnesses.filters.search_placeholder')}
          data-testid="witnesses-filter-search"
          className="w-full bg-transparent font-sans text-[13.5px] text-[#161511] outline-none placeholder:text-[#9ca3af]"
        />
      </div>

      <div className="mb-2.5 font-sans text-[11px] font-bold uppercase tracking-[0.05em] text-[#9ca3af]">
        {t('witnesses.filters.version_group')}
      </div>
      <select
        value={filters.version}
        onChange={(e) => setFilter('version', e.target.value)}
        data-testid="witnesses-filter-version"
        className="w-full rounded-[10px] border border-[#e4e6e9] px-3 py-[9px] font-sans text-[13.5px] text-[#161511] outline-none"
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
