'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Skeleton } from '@hive/ui';
import { cn } from '@ui/lib/utils';
import { getTrendingTags } from '@transaction/lib/hive';
import { StaleTime } from '@/blog/lib/react-query';
import { useTranslation } from '@/blog/i18n/client';

const MAX_TOPICS = 9;
// Sample from a wider slice so the card is not the same nine words every visit.
const TOPIC_POOL = 40;
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

  // ★ RANDOMISED FROM A WIDE POOL (2026-08-07). Taking the top 9 of a trending
  // list meant the same nine words sat there every visit, for every reader, for
  // as long as those tags trended — a browse-by-topic card that never offers
  // anything new is decoration. We now sample 9 out of the top ~40 browsable
  // topics, so the card turns over between visits and surfaces the long tail
  // instead of only the head.
  //
  // Seeded per mount rather than per render: re-shuffling on every re-render
  // would make the tags jump under the reader's cursor.
  const pool = (tags ?? []).filter((tag) => isBrowsableTopic(tag.name)).slice(0, TOPIC_POOL);
  const topics = useMemo(() => {
    const names = pool.map((tag) => tag.name);
    for (let i = names.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [names[i], names[j]] = [names[j], names[i]];
    }
    return names.slice(0, MAX_TOPICS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool.length, pool[0]?.name]);

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
                href={`/topics/${topic}`}
                className={cn(
                  'inline-flex items-center gap-0.5 rounded-full border border-[#ececec] bg-[#faf9f7] px-[11px] py-[5px] text-[12.5px] font-medium capitalize text-[#4b5563] transition-colors',
                  'hover:border-[#c0392b] hover:bg-[#fdf2f0] hover:text-[#c0392b]'
                )}
              >
                <span className="text-[#c0392b]/60" aria-hidden>
                  #
                </span>
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
