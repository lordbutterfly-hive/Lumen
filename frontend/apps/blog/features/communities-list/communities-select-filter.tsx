'use client';

import { useState } from 'react';

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@ui/components/select';
import { useTranslation } from '@/blog/i18n/client';

const CommunitiesSelectFilter = ({
  filter,
  handleChangeFilter
}: {
  filter: string;
  handleChangeFilter: (e: string) => void;
}) => {
  const { t } = useTranslation('common_blog');
  const [state, setState] = useState(() => filter);
  return (
    <Select
      defaultValue="rank"
      value={state}
      onValueChange={(e) => {
        handleChangeFilter(e);
        setState(e);
      }}
    >
      {/* Same class as post-select-filter.tsx: role="combobox" does not get an
          accessible name from content, so the visible current value ("Rank",
          "Subscribers", …) left this nameless (verified via the a11y tree —
          raw CDP node reported `role: combobox, name: ""`). No adjacent
          visible label exists here, so a direct `aria-label` names the
          control rather than any one of its values. */}
      <SelectTrigger
        className="w-fit bg-white"
        data-testid="communities-filter"
        aria-label={t('search_page.sort_by')}
      >
        <SelectValue placeholder="Select a filter" />
      </SelectTrigger>
      <SelectContent data-testid="communities-filter-item">
        <SelectGroup>
          <SelectItem value="rank">{t('select_sort.communitie_sort.rank')}</SelectItem>
          <SelectItem value="subs">{t('select_sort.communitie_sort.subscribers')}</SelectItem>
          <SelectItem value="new">{t('select_sort.communitie_sort.new')}</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
};

export default CommunitiesSelectFilter;
