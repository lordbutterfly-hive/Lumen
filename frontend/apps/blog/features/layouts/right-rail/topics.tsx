'use client';

import { useMemo } from 'react';
import { usePathname } from 'next/navigation';
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

/**
 * ★★ THE ORDER HAS TO SURVIVE A NAVIGATION (2026-08-10, fuckery list C10).
 *
 * This shuffled with `Math.random()` seeded per mount, so every navigation dealt a
 * fresh hand: home showed Polish, Rant, Scrobble, Travel; one click later the same
 * card read Chessbrothers, Scrobble, Spanish, Life. Nothing was broken, and that is
 * exactly why it was bad — a reader who half-remembers where a word sat cannot use
 * that memory, so the card reads as noise and stops being browsable.
 *
 * The point of the shuffle was turnover between VISITS, not churn between clicks.
 * A date-seeded PRNG keeps both: identical on every render and every route for the
 * whole UTC day, different tomorrow. Same input, same hand.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** UTC day as a stable integer seed: 2026-08-10 -> 20260810. */
function todaySeed(): number {
  const now = new Date();
  return now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
}

/** `/topics/photography` -> `photography`. Anything else -> null. */
function activeTopicFrom(pathname: string | null): string | null {
  if (!pathname) return null;
  const m = /^\/topics\/([^/?#]+)/.exec(pathname);
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}

const Topics = () => {
  const { t } = useTranslation('common_blog');
  const activeTopic = activeTopicFrom(usePathname());
  const {
    data: tags,
    isLoading,
    isError
  } = useQuery({
    queryKey: ['right-rail-trending-tags'],
    // Ask for far more than we show: community ids and tribe tags occupy most of
    // the head of this list, so a request for 12 yielded 0 usable topics.
    queryFn: () => getTrendingTags(120),
    staleTime: StaleTime.LONG,
    // ★ 20+ SECONDS OF GREY PILLS, TRACED (audit item O3). This card never hangs
    // forever — an RPC node that outright refuses the connection surfaces the
    // honest "Couldn't load trending topics." at ~12s, and one that silently
    // swallows the request (no response, no error — the worst case) still gets
    // there, at ~31s, because the shared wax client's own `apiTimeout` (see
    // `hive-chain-service.ts`) aborts each attempt at 5s. That 31s IS the
    // reported symptom: react-query's default `retry: 3` means THREE 5s
    // timeouts plus backoff between them, all against the SAME node — a retry
    // buys nothing here, because endpoint failover
    // (`advanceToNextRpcEndpoint`) is explicitly server-only ("browser: respect
    // the reader's node"), so a down node in the browser is down for every
    // attempt alike. One retry still absorbs a genuine one-off blip; capping it
    // here (rather than lowering the shared query-client default, which other,
    // non-decorative queries may have good reason to keep) turns the worst case
    // for this one decorative widget into ~11s without touching anything else
    // that reads `right-rail-trending-tags` or the client's global defaults.
    retry: 1
  });

  // ★ SAMPLED FROM A WIDE POOL (2026-08-07). Taking the top 9 of a trending list
  // meant the same nine words sat there every visit, for every reader, for as long
  // as those tags trended — a browse-by-topic card that never offers anything new
  // is decoration. We sample 9 out of the top ~40 browsable topics, so the card
  // turns over and surfaces the long tail instead of only the head. Deterministic
  // per UTC day (see mulberry32 above), so the hand is identical across routes.
  const pool = (tags ?? []).filter((tag) => isBrowsableTopic(tag.name)).slice(0, TOPIC_POOL);
  const topics = useMemo(() => {
    const names = pool.map((tag) => tag.name);
    const rand = mulberry32(todaySeed());
    for (let i = names.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [names[i], names[j]] = [names[j], names[i]];
    }
    const picked = names.slice(0, MAX_TOPICS);

    // ★ THE TOPIC YOU ARE READING BELONGS IN THE LIST OF TOPICS (C11). On
    // /topics/decentmemes the rail listed nine other topics and not that one, so
    // the card silently disagreed with the page around it and there was no "you
    // are here" anywhere in the rail. Pinned first, deduped, and it displaces the
    // last sampled tag rather than growing the card.
    if (activeTopic) {
      const rest = picked.filter((name) => name.toLowerCase() !== activeTopic);
      return [activeTopic, ...rest].slice(0, MAX_TOPICS);
    }
    return picked;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool.length, pool[0]?.name, activeTopic]);

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
          {topics.map((topic) => {
            const current = activeTopic === topic.toLowerCase();
            return (
              <li key={topic}>
                <Link
                  href={`/topics/${topic}`}
                  aria-current={current ? 'page' : undefined}
                  data-current={current ? 'true' : undefined}
                  className={cn(
                    'inline-flex items-center gap-0.5 rounded-full border px-[11px] py-[5px] text-[12.5px] font-medium capitalize transition-colors',
                    current
                      ? 'border-[#c0392b] bg-[#fdf2f0] text-[#c0392b]'
                      : 'border-[#ececec] bg-[#faf9f7] text-[#4b5563] hover:border-[#c0392b] hover:bg-[#fdf2f0] hover:text-[#c0392b]'
                  )}
                >
                  <span className={current ? 'text-[#c0392b]' : 'text-[#c0392b]/60'} aria-hidden="true">
                    #
                  </span>
                  {topic}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

export default Topics;
