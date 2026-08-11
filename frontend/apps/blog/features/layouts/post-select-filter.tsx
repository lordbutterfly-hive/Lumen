'use client';

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@ui/components/select';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslation } from '../../i18n/client';

const PostSelectFilter = ({ param }: { param?: string }) => {
  const { t } = useTranslation('common_blog');
  const router = useRouter();
  const path = usePathname();
  const currentPath = path ? `/${path.split('/')[1]}` : '/trending';
  const onValueChange = (next: string) => {
    if (param) {
      router.push(`${next}/${param}`, undefined);
    } else {
      router.push(next, undefined);
    }
  };
  return (
    <Select value={currentPath} onValueChange={onValueChange}>
      {/* Radix's Select.Trigger is role="combobox" — per the ARIA combobox
          pattern that role does NOT get its accessible name from content the
          way a button does, so the visible current value ("Trending", "Hot", …)
          left this reporting as a nameless combobox (verified via the a11y
          tree, same class as the four Preferences comboboxes). No adjacent
          visible label exists here to point `aria-labelledby` at, so a direct
          `aria-label` naming the CONTROL (not the current value) instead. */}
      <SelectTrigger
        className="bg-background"
        data-testid="posts-filter"
        aria-label={t('search_page.sort_by')}
      >
        <SelectValue placeholder={t('select_sort.posts_sort.trending')} />
      </SelectTrigger>
      <SelectContent data-testid="posts-filter-list">
        <SelectGroup>
          <SelectItem value="/trending">{t('select_sort.posts_sort.trending')}</SelectItem>
          <SelectItem value="/hot">{t('select_sort.posts_sort.hot')}</SelectItem>
          <SelectItem value="/created">{t('select_sort.posts_sort.new')}</SelectItem>
          <SelectItem value="/payout">{t('select_sort.posts_sort.payouts')}</SelectItem>
          <SelectItem value="/muted">{t('select_sort.posts_sort.muted')}</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
};

export default PostSelectFilter;
