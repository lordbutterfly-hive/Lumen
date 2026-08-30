'use client';

import { useMemo } from 'react';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Link, Skeleton } from '@hive/ui';
import { cn } from '@ui/lib/utils';
import type { ITrendingTag } from '@hive/common-hiveio-packages/wax';

/**
 * ★ THROUGH OUR SERVER, NOT STRAIGHT TO A HIVE NODE (2026-08-12).
 *
 * This used to call `getTrendingTags` here in the browser. That function does
 * `await getChain()`, and `@hiveio/wax` has a single entry point, so importing
 * it from a `'use client'` widget mounted on nearly every page shell pulled the
 * whole ~2.3 MB wax bundle — WASM included — into the client graph of most
 * routes. Measured on the production build as an anonymous visitor:
 * `wax.common.wasm`, 2.34 MB, actually fetched, by a reader who will never sign
 * anything. `/api/trending-tags` returns the same list as plain JSON, cached,
 * and keeps the chain client on the server. See that route for the full note.
 */
async function fetchTrendingTags(): Promise<ITrendingTag[]> {
  const res = await fetch('/api/trending-tags');
  if (!res.ok) throw new Error(`trending tags request failed: HTTP ${res.status}`);
  const body = (await res.json()) as { tags?: ITrendingTag[] };
  return body.tags ?? [];
}
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
  if (!m) return null;
  /*
   * ★★ decodeURIComponent THROWS ON A LONE `%`, AND THIS RUNS DURING RENDER
   * (2026-08-30, found by audit hypothesis H20 and reproduced in a real browser).
   * `/topics/100%` raised URIError and took the whole page with it: topic links
   * 29 -> 0, body text down to 173 characters. React contains it, so there is no
   * crash dialog — just a blank page, which is the worst way to fail.
   *
   * The vector is author-controlled: post tag chips render `/topics/${tag}` from
   * `json_metadata.tags` with no encoding, and a tag is whatever the author typed.
   * A sweep of 600 live posts found 51 tags outside [a-z0-9-] — spaces, newlines,
   * leading `#` — and none containing `%`, so the mechanism is proven and the
   * trigger is not in the wild. That is a reason to fix it cheaply now, not a
   * reason to wait for someone to publish one.
   *
   * ★ THE PATTERN, worth more than this instance: `normalizeHandle` in
   * app/api/creator-profile/route.ts makes the IDENTICAL call and already wraps it,
   * falling back to the raw value. Same risk, same codebase, one guarded and one
   * not. Where a decode is unguarded is where to look next.
   */
  try {
    return decodeURIComponent(m[1]).toLowerCase();
  } catch {
    // Undecodable is not an error worth a blank page: it simply is not a topic we
    // can match against, which is the same answer as "no topic in this path".
    return m[1].toLowerCase();
  }
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
    queryFn: fetchTrendingTags,
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
  //
  // ★ SORTED INTO ONE CANONICAL ORDER FIRST (2026-08-16, QA Low 2: "the
  // right-rail Topics list reshuffles on every load — no stable ordering").
  // `mulberry32` above IS a fixed, deterministic permutation — but a fixed
  // seed only produces a fixed OUTPUT for a fixed INPUT order. `get_trending_tags`
  // is documented (see `getTrendingTags` in `packages/transaction/lib/hive.ts`)
  // as "ordered by top_posts descending", but that isn't guaranteed byte-stable
  // across separate calls — two ties, or scores that shift by one between two
  // nearly-simultaneous requests, reorder the raw array without changing its
  // membership. Once the STARTING array order differs at all, Fisher-Yates with
  // the same seed walks the same swap sequence over a different arrangement and
  // lands on a different final order — which is exactly the reported symptom:
  // overlapping but reordered lists ("Core/Engrave/Solar/Spanish" vs
  // "Engrave/Core/Silvergoldstackers/Solar/Witness/Curangel"), not a fresh
  // random hand each time.
  //
  // Sorting into one canonical order before the shuffle ever sees it removes
  // that sensitivity: `top_posts` descending (the same "frequency" the raw API
  // is meant to rank by in the first place), `name` ascending to break a tie
  // deterministically rather than leaving it to whatever order the response
  // happened to arrive in. For the same UTC day and the same qualifying set of
  // tags, the shuffle's input is now always identical, so its output is too.
  const pool = (tags ?? [])
    .filter((tag) => isBrowsableTopic(tag.name))
    .sort((a, b) => b.top_posts - a.top_posts || a.name.localeCompare(b.name))
    .slice(0, TOPIC_POOL);
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
      {/* ★ h2, NOT h3 (A8, 2026-08-18). This sits directly under the page's h1, so h3 skipped
      a level — a screen reader announcing "heading level 3" after "heading level 1"
      tells the listener a whole section is missing. Level is structure; size is the
      class list, and the class list is unchanged. */}
      <h2 className="mb-[14px] text-[15px] leading-[24px] font-bold text-ink-2">{t('right_rail.topics.heading')}</h2>
      {isLoading ? (
        <div className="flex flex-wrap gap-2" data-testid="right-rail-topics-loading">
          {Array.from({ length: MAX_TOPICS }).map((_, index) => (
            <Skeleton key={index} className="h-[26px] w-16 rounded-full" />
          ))}
        </div>
      ) : isError ? (
        <p className="text-caption text-ink-13" data-testid="right-rail-topics-error">
          {t('right_rail.topics.error')}
        </p>
      ) : topics.length === 0 ? (
        <p className="text-caption text-ink-13" data-testid="right-rail-topics-empty">
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
                    'inline-flex items-center gap-0.5 rounded-full border px-[11px] py-[5px] text-caption font-medium capitalize transition-colors',
                    current
                      ? 'border-line-brand-10 bg-surface-brand-5 text-ink-brand-6'
                      : 'border-line-8 bg-surface-11 text-ink-8 hover:border-line-brand-10 hover:bg-surface-brand-5 hover:text-ink-brand-6'
                  )}
                >
                  <span className={current ? 'text-ink-brand-6' : 'text-ink-brand-6/60'} aria-hidden="true">
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
