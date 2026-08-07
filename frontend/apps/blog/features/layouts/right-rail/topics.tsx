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

/**
 * ★ WHAT COMES BACK FROM `get_trending_tags` IS MOSTLY NOT TOPICS.
 *
 * Measured against api.hive.blog 2026-08-06, the top of the list was:
 * `hbd`, `burnpost`, `hive-13323`, `hive-105017`, `hive-163772`, `hive-110713`,
 * `hive-124838`, `hive-193552`, `hive-194913` — rendered, that is a Topics card
 * reading "Hbd · Burnpost · Hive-13323 · Hive-105017 …", which tells a reader
 * nothing and invites a click into a numbered void.
 *
 * Two kinds of noise, excluded for two different reasons:
 *
 *  * `hive-<digits>` are COMMUNITY ids, not topics. They dominate the ranking
 *    because a community post carries its id as the first tag. They are also
 *    exactly the surface that was deliberately removed from this rail, so
 *    smuggling them back in under a different heading would undo that.
 *
 *  * reward-token TRIBE tags (`pob`, `neoxian`, `cent`, `palnet`, …) are added
 *    to route rewards, not to say what a post is about — the same reasoning,
 *    with the same evidence, as `lib/lite/interests/taxonomy.ts`. A post tagged
 *    `pob` can be about anything at all.
 *
 * Tribes that ARE genuinely topical (`leofinance`, `splinterlands`, `actifit`)
 * are left in on purpose: they name one subject each.
 */
const COMMUNITY_ID = /^hive-\d+$/i;
const REWARD_TRIBE_TAGS = new Set([
  'pob', 'proofofbrain', 'neoxian', 'cent', 'waivio', 'waiv', 'pimp', 'archon',
  'palnet', 'creativecoin', 'vyb', 'ctp', 'alive', 'oneup', 'lassecash', 'bbh',
  'burnpost', 'hbd', 'hive', 'ecency', 'peakd', 'listnerds', 'dbuzz',
  // Meta tags about the act of posting rather than any subject: `posh` marks a
  // cross-post to Twitter, `curation`/`blog` label the format.
  'posh', 'curation', 'blog'
]);

function isBrowsableTopic(name: string): boolean {
  const tag = name.toLowerCase();
  return !EXCLUDED_TAGS.has(tag) && !COMMUNITY_ID.test(tag) && !REWARD_TRIBE_TAGS.has(tag);
}

const Topics = () => {
  const { t } = useTranslation('common_blog');
  const {
    data: tags,
    isLoading,
    isError
  } = useQuery({
    queryKey: ['right-rail-trending-tags'],
    // Ask for far more than we show: community ids and tribe tags occupy most of
    // the head of this list, so a request for 12 yielded 0 usable topics.
    queryFn: () => getTrendingTags(120),
    staleTime: StaleTime.LONG
  });

  const topics = (tags ?? [])
    .filter((tag) => isBrowsableTopic(tag.name))
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
