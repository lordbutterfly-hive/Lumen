'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@hive/ui';
import { cn } from '@ui/lib/utils';
import { useTranslation } from '@/blog/i18n/client';
import { ProposalSort, ProposalTab } from '../lib/proposals-types';

const TABS: ProposalTab[] = ['all', 'active', 'upcoming', 'expired'];
const SORTS: ProposalSort[] = ['votes', 'newest', 'daily_pay', 'ending_soon'];

interface Props {
  tab: ProposalTab;
  onTabChange: (tab: ProposalTab) => void;
  sort: ProposalSort;
  onSortChange: (sort: ProposalSort) => void;
}

/** Segmented tab control (All/Active/Upcoming/Expired) + a real sort dropdown. */
export default function ProposalsToolbar({ tab, onTabChange, sort, onSortChange }: Props) {
  const { t } = useTranslation('common_blog');

  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-4" data-testid="proposals-toolbar">
      /* ★ WARM TAB TREATMENT (illumination SPEC.md §1, owner 2026-08-21: "fill the
         creators, wallet tokens and proposals tab bar gap"). Track on --amb-1 so it
         "follows the ground it sits on, never lighter" (§3); active pill on --lum-1
         with --lift-1 plus a soft warm glow. One step weaker than the nav rail (§4) —
         the rail is the anchor and the only surface at full strength.
      
         ★ THE GLOW IS AN INLINE STYLE, NOT A TAILWIND CLASS, and that is not a
         preference: a `/` inside a Tailwind arbitrary value is the OPACITY shorthand,
         so `shadow-[...rgb(var(--lum)/.85)]` never compiles and no rule is emitted at
         all. Measured on the feed's own tab bar, which shipped with `box-shadow: none`
         until it was caught. */
      <div role="tablist" className="flex gap-1.5 rounded-xl border border-line-6 bg-[var(--amb-1)] p-[5px]">
        {TABS.map((t2) => (
          <button
            key={t2}
            type="button"
            role="tab"
            aria-selected={tab === t2}
            style={tab === t2 ? { boxShadow: 'var(--lift-1), 0 0 12px -5px rgb(var(--lum) / 0.85)' } : undefined}
            onClick={() => onTabChange(t2)}
            data-testid={`proposals-tab-${t2}`}
            className={cn(
              'rounded-lg px-[15px] py-2 font-sans text-[14px] leading-[22px] font-semibold transition-colors',
              tab === t2
                ? 'bg-[var(--lum-1)] text-ink-2'
                : 'bg-transparent text-ink-10 hover:text-ink-2'
            )}
          >
            {t(`proposals.tabs.${t2}`)}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2 font-sans text-caption text-ink-10">
        <span id="proposals-sort-label">{t('proposals.toolbar.sort_label')}</span>
        <Select value={sort} onValueChange={(value) => onSortChange(value as ProposalSort)}>
          {/* Radix's SelectTrigger is role="combobox" and does not get an accessible
              name from its own visible content (same class as the four Preferences
              comboboxes, `apps/blog/features/account-settings/form.tsx`, and the
              submit-page reward-type select, `PostPublishingSection.tsx`). The
              "Sort by" text above already labels this control for sighted users;
              `aria-labelledby` wires that same text in for the accessibility tree
              instead of duplicating it. */}
          <SelectTrigger
            className="h-auto w-auto gap-1.5 rounded-control border-line-11 px-3.5 py-2 font-sans text-caption font-semibold text-ink-7"
            data-testid="proposals-sort-select"
            aria-labelledby="proposals-sort-label"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORTS.map((s) => (
              <SelectItem key={s} value={s}>
                {t(`proposals.sort.${s}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
