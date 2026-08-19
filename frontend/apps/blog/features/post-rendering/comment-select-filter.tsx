'use client';

import { useTranslation } from '@/blog/i18n/client';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@ui/components/select';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

const CommentSelectFilter = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const sort = searchParams?.get('sort') ?? 'trending';
  const { t } = useTranslation('common_blog');

  return (
    <Select
      defaultValue={sort}
      onValueChange={(e) => {
        router.replace(`${pathname?.split('#')[0].split('?')[0]}?sort=${e}#comments`);
      }}
    >
      {/* ★ min-h-[24px], not h-5 (2026-08-19, WCAG 2.2 AA 2.5.8). h-5 (20px)
          measured 99.4x20 — width was fine, only the fixed height failed.
          Measured live: the enclosing "Sort:" row was already 24px tall
          before this change (governed by a taller sibling), so raising the
          trigger to 24px cost the row nothing. */}
      <SelectTrigger
        className="min-h-[24px] w-fit border-none bg-transparent text-ink-brand-7"
        data-testid="posts-filter"
        aria-label="Sort comments"
      >
        <SelectValue placeholder="Sort:" />
      </SelectTrigger>
      <SelectContent data-testid="posts-filter-list">
        <SelectGroup>
          <SelectItem value="trending">{t('select_sort.sort_comments.trending')}</SelectItem>
          <SelectItem value="votes">{t('select_sort.sort_comments.votes')}</SelectItem>
          <SelectItem value="new">{t('select_sort.sort_comments.age')}</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
};

export default CommentSelectFilter;
