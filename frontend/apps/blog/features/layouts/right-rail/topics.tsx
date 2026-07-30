'use client';

import { useQuery } from '@tanstack/react-query';
import { Link, Skeleton } from '@hive/ui';
import { cn } from '@ui/lib/utils';
import { getTrendingTags } from '@transaction/lib/hive';
import { StaleTime } from '@/blog/lib/react-query';
import { useTranslation } from '@/blog/i18n/client';

const MAX_TOPICS = 9;
// get_trending_tags can include the blank root tag and a handful of
// moderation/system tags that aren't meaningful as a "browse by topic" link.
const EXCLUDED_TAGS = new Set(['', 'nsfw', 'test']);

const Topics = () => {
  const { t } = useTranslation('common_blog');
  const {
    data: tags,
    isLoading,
    isError
  } = useQuery({
    queryKey: ['right-rail-trending-tags'],
    queryFn: () => getTrendingTags(MAX_TOPICS + EXCLUDED_TAGS.size),
    staleTime: StaleTime.LONG
  });

  const topics = (tags ?? [])
    .filter((tag) => !EXCLUDED_TAGS.has(tag.name))
    .slice(0, MAX_TOPICS)
    .map((tag) => tag.name);

  return (
    <section data-testid="right-rail-topics">
      <h3 className="mb-[14px] text-[14.5px] font-bold text-[#161511]">{t('right_rail.topics.heading')}</h3>
      {isLoading ? (
        <div className="flex flex-wrap gap-2" data-testid="right-rail-topics-loading">
          {Array.from({ length: MAX_TOPICS }).map((_, index) => (
            <Skeleton key={index} className="h-[26px] w-16 rounded-full" />
          ))}
        </div>
      ) : isError ? (
        <p className="text-xs text-[#8a8a8a]" data-testid="right-rail-topics-error">
          {t('right_rail.topics.error')}
        </p>
      ) : topics.length === 0 ? (
        <p className="text-xs text-[#8a8a8a]" data-testid="right-rail-topics-empty">
          {t('right_rail.topics.empty')}
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2" data-testid="right-rail-topics-list">
          {topics.map((topic) => (
            <li key={topic}>
              <Link
                href={`/trending/${topic}`}
                className={cn(
                  'inline-flex items-center rounded-full border border-[#e4e6e9] px-3 py-1 text-xs capitalize text-[#4b5563] transition-colors hover:border-[#c0392b] hover:text-[#c0392b]'
                )}
              >
                {topic}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

export default Topics;
