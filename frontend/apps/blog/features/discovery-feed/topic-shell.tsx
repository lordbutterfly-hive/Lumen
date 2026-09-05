'use client';

import { useRef } from 'react';
import { Trans } from 'react-i18next';
import { useInfiniteQuery } from '@tanstack/react-query';
import { FEED_AUTO_PAGE_CAP, useInfiniteScrollSentinel } from './hooks/use-infinite-scroll-sentinel';
import ScrollPagerFooter from './scroll-pager-footer';
import LeftRail from '@/blog/features/layouts/left-rail';
import RightRail from '@/blog/features/layouts/right-rail';
import PageMasthead from '@/blog/features/layouts/page-masthead';
import MediumPostCard from './medium-post-card';
import { filterVisiblePosts, useNsfwPreference } from '@/blog/lib/nsfw';
import { LumenLoader } from '@hive/ui';
import { useTranslation } from '@/blog/i18n/client';
import type { Entry } from '@hive/common-hiveio-packages/wax';
import { useTokenPriceChips } from '@/blog/features/creator-tokens/live/use-token-price-chips';
import { useRankLuminosity } from '@/blog/features/retention/hooks/use-rank-marks';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useTopicSeed } from './topic-seed-context';
import { fetchTopicPage, topicFeedKey, type TopicResponse } from './lib/topic-feed-client';

/**
 * A TOPIC IS THE FEED, FILTERED — not a different, older-looking page.
 *
 * ★ WHY THIS EXISTS (owner report, 2026-08-07). Clicking a topic in the right
 * rail dropped the reader out of Lumen and into the inherited denser community
 * layout: a different navigation column, a different post list, a different
 * visual language. Two products in one click.
 *
 * This renders the SAME three-column shell as the home feed, the SAME
 * `MediumPostCard`, and asks the SAME ranking engine for its order — just scoped
 * to one tag (`/api/feed/for-you?tag=<topic>`). When the ranker cannot serve,
 * that endpoint falls back to NEWEST-first within the topic rather than
 * trending, because a topic ranked by all-time payout reads as a dead topic.
 */


export default function TopicShell({ tag }: { tag: string }) {
  const { t } = useTranslation('common_blog');
  const seed = useTopicSeed();

  // ★ T3e (2026-09-04) — SKIP THE REFETCH ONLY WHEN THE SEED IS ALREADY THIS
  // VIEWER'S FINAL ANSWER, same shape as ForYouFeed's `awaitingRank`
  // (feed-tabs.tsx + feed-prefetch.ts, read-only reference for this fix).
  // `refetchOnMount: 'always'` below used to fire unconditionally, downloading
  // 102-165KB byte-identical to the SSR seed on EVERY view, anonymous or not.
  //
  // An anonymous seed IS the answer `/api/feed/for-you` would give an
  // anonymous request for this tag (the route never ranks for a signed-out
  // viewer — see anonymousTopicSeed's header in lib/feed/topic-cache.ts), so
  // refetching it changes nothing and is pure waste.
  //
  // A signed-in seed is NOT that: app/topics/[tag]/page.tsx seeds a signed-in
  // reader from that SAME anonymous fallback memo (only block-filtered), never
  // from a ranked or fully per-viewer answer — its own header comment says so
  // — so it is provisional by construction and must still be refetched to pick
  // up ranking and the reader's live block list; skipping it here would leave a
  // signed-in viewer on a blocked/unranked page forever. `source === 'recsys'`
  // additionally covers an already-ranked seed should one ever be introduced,
  // exactly like home's `personalised` check. `isLoggedIn` comes from
  // `useSessionIdentity`, backed by the same `getServerSessionUser()` cookie
  // read that decided the seed itself server-side, so the two never disagree.
  const { isLoggedIn } = useSessionIdentity();
  const seedIsFinal = !!seed && (!isLoggedIn || seed.page.source === 'recsys');

  // Same infinite scroll as the main feed — a topic is the feed, filtered, so it
  // must not stop after one page either.
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage, refetch } =
    useInfiniteQuery<TopicResponse>({
      queryKey: topicFeedKey(tag),
      queryFn: async ({ pageParam }) =>
        fetchTopicPage(tag, pageParam as { author?: string; permlink?: string } | undefined),
      // ★ THE POSTS CAN ALREADY BE IN THE PAGE (snappiness phase 4, 2026-09-03).
      // app/topics/[tag]/page.tsx seeds this from the server's memo of the
      // topic when it is warm, exactly as home is seeded, so a direct load
      // paints the posts in the first frame and a click needs no second round
      // trip. `initialDataUpdatedAt` is the memo's own timestamp, and the
      // `staleTime` / `refetchOnMount` pair below turn it into a rule: a seed
      // younger than a minute is final for this visit; an older one is shown
      // at once and refreshed ONCE, at mount, before the reader has started
      // reading (found in review: a seeded page makes no API call, and the
      // server memo is only refreshed by API calls, so without this a topic
      // that only ever got page loads would freeze). Cold topics: `undefined`,
      // and the fetch above runs as it always did.
      initialData: seed ? { pages: [seed.page], pageParams: [undefined] } : undefined,
      initialDataUpdatedAt: seed ? seed.at : undefined,
      getNextPageParam: (lastPage) => {
        if (!lastPage?.nextCursor) return undefined;
        if (!lastPage.entries || lastPage.entries.length === 0) return undefined;
        return lastPage.nextCursor;
      },
      // ★★★ THE FEED NEVER CHANGES UNDER A READER (2026-08-12) — this page IS
      // the ranked feed, filtered to one tag (see the file header), asking the
      // same `/api/feed/for-you` route, so it inherited the exact defect
      // ForYouFeed itself was fixed for on 2026-08-10 and this file was never
      // touched: `staleTime: StaleTime.MEDIUM` (2 minutes) with every automatic
      // refetch trigger left at its library default meant window focus,
      // reconnect or a remount could replace `data.pages` — and therefore this
      // topic's whole rendered list — with whatever the route answered next,
      // including a thin page from a recsys cold-start or a Hive node hiccup.
      // Same fix, same reasoning: nothing about a ranked page changing while a
      // reader is scrolled into it is time-critical, so every automatic
      // trigger is off.
          // ★ A FAILED READ MUST SURFACE FAST (2026-08-13). This query never overrode
    // React Query's default `retry: 3`, so a genuine failure sat behind three
    // attempts and ~7s of backoff — measured at 5.4s / 9.1s on real failures —
    // before the reader was told anything, behind an unlabelled spinner the whole
    // time. One retry absorbs a transient blip; three only postpone bad news.
      retry: 1,
      // Was `Infinity` / `false`: with a server seed those would also have
      // silenced the one refresh that keeps a seeded topic from freezing. Focus
      // and reconnect refetches stay off, so nothing changes under a reader.
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      // ★ 'always', NOT true, WHEN NOT `seedIsFinal` (2026-09-03, gated 09-04 —
      // see the T3e comment above `seedIsFinal`). React Query v4's
      // `refetchOnMount: true` only refetches a STALE query, and a seed <60s
      // old is fresh — so a signed-in reader seeded with the newest-first
      // fallback would never fetch the ranked feed and would be stuck on
      // unranked (and the phase-4 memo-refresh never fired either). 'always'
      // fetches on every mount regardless of staleness; the seed still paints
      // instantly and the ranked, fully block/mute-filtered feed swaps in
      // behind it. Found in review. `false` for an anonymous (or already-
      // ranked) seed: that seed IS the final answer, so no mount fetch is
      // owed at all — this is the T3e fix.
      refetchOnMount: seedIsFinal ? false : 'always'
    });

  // ★ A TOPIC IS THE FEED, FILTERED — including its faults. This carried the
  // same bare `inView` effect as `ForYouFeed`, so it fetched twice per scroll
  // gesture and grew without limit: measured on :3000 before this change, forty
  // scroll-to-bottom gestures on `/topics/hive-139531` left 191,617px of
  // document, 36,628 DOM elements, 1,262 images and 1.06GB of JS heap.
  // See hooks/use-infinite-scroll-sentinel.ts.
  const sentinel = useInfiniteScrollSentinel({
    hasNextPage,
    isFetching: isFetchingNextPage,
    isError,
    fetchNextPage,
    pagesLoaded: data?.pages?.length ?? 0,
    autoPageCap: FEED_AUTO_PAGE_CAP
  });

  const seen = new Set<string>();
  const nsfwPreference = useNsfwPreference();
  const rawEntries = (data?.pages ?? [])
    .flatMap((page) => page?.entries ?? [])
    .filter((e) => {
      const key = `${e.author}/${e.permlink}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  // NSFW `hide` filtering happens at the LIST so entries.length means "posts you
  // will actually see" — otherwise a fully-hidden page leaves a zero-height list
  // and the scroll sentinel auto-fetches forever. See lib/nsfw.ts.
  const entries = filterVisiblePosts(rawEntries, nsfwPreference);

  // ★★★ AN EMPTY ANSWER NEVER PAINTS OVER A FULL PAGE (2026-08-12) — mirrors
  // ForYouFeed's fix. `staleTime: Infinity` above stops the ordinary trigger,
  // but an explicit `invalidateQueries` (see use-lumen-block.ts) still forces a
  // refetch regardless of staleTime, and the route can still legitimately
  // answer thin. Holding the last non-empty list this page actually rendered
  // means the worst case is stale, not a topic that looks like it went silent.
  const lastRendered = useRef<Entry[]>([]);
  if (entries.length > 0) lastRendered.current = entries;
  const shown = entries.length > 0 ? entries : lastRendered.current;

  const ranked = data?.pages?.[0]?.source === 'recsys';

  // ★★★ THE `degraded` FLAG WAS DECLARED AND NEVER READ (2026-08-13, adversarial
  // review S10). `/api/feed/for-you` answers `{ entries: [], source:
  // 'trending-fallback', degraded: <reason> }` at HTTP 200 when it cannot rank —
  // an honest server admitting it fell back — and this page's `TopicResponse` type
  // carried `degraded?: string` from the day it was written while nothing ever
  // looked at it. So a degraded answer rendered as "Nothing here yet: no posts
  // carry the tag <x> right now", which is a confident editorial claim about the
  // topic, made on a read the server had just told us not to trust. Exactly the
  // class of lie `/api/account-posts` was fixed for; same fix, different route.
  //
  // Read across ALL pages, not just page 0: a degraded page 2 is the same fact.
  const degradedPage = (data?.pages ?? []).some((page) => !!page?.degraded);

  // ★★★ AND A DEGRADED PAGE **WITH** POSTS SAID NOTHING AT ALL (2026-09-05,
  // review of the topic patience window). `degradedPage` above is read on one
  // branch only — `shown.length === 0` — which was right for every reason that
  // existed when it was written, because they all arrived empty. `'building'`
  // does not: the route now answers the chronological page for this tag while
  // the ranked build keeps running (see the patience window and the joined-build
  // branch in app/api/feed/for-you/route.ts), so the reader gets a full page of
  // real posts in the wrong ORDER, labelled `ranked: false` by the masthead dot
  // and otherwise indistinguishable from a topic the ranker has finished with.
  // "Newest first" is true but it is not the whole truth — it reads as this
  // topic's settled state rather than a temporary one — so the same warming-up
  // hint the home feed shows over its fallback belongs here, and for the same
  // reason: the degradation is reported, not hidden.
  //
  // `!ranked` is what makes it disappear. When the ranked page lands, page 0's
  // `source` is `recsys` and a hint about a build that has finished would be a
  // second small lie. Behind `shown.length > 0` exactly like feed-tabs.tsx's
  // banner: over an empty list the empty/degraded state is the only honest
  // message on screen, and this would contradict it.
  const buildingPage = (data?.pages ?? []).some((page) => page?.degraded === 'building');

  // ★ A COMMUNITY ID IS NOT A READABLE TOPIC (owner ruling, 2026-08-07).
  // Communities are shown as tags, so `hive-13323` lands here — and "#hive-13323"
  // tells a reader nothing. The posts themselves carry the real name, so use it
  // for the heading and keep the raw id only as the sub-label.
  const isCommunityId = /^hive-\d+$/i.test(tag);
  const communityName = shown.find((e) => (e as { community_title?: string }).community_title)?.[
    'community_title' as keyof typeof shown[number]
  ] as string | undefined;
  const displayName = isCommunityId && communityName ? communityName : tag;
  const { prices } = useTokenPriceChips(shown.map((e) => e.author));
  /* §2 rank luminosity for the avatar glow — shares `useRankMarks`' request. */
  const luminosity = useRankLuminosity(shown.map((e) => e.author));

  return (
    <div className="relative mx-auto grid max-w-[1720px] grid-cols-1 gap-11 px-6 pb-20 pt-[26px] md:grid-cols-[200px_minmax(0,1fr)] md:px-11 xl:grid-cols-[200px_minmax(0,1fr)_312px]">
      <div
        className="pointer-events-none absolute bottom-20 left-[244px] top-[26px] hidden w-px bg-[#ececec] md:block"
        aria-hidden
      />

      <aside className="sticky top-24 hidden h-fit bg-background-secondary md:block">
        <LeftRail />
      </aside>

      <main className="min-w-0">
        {/* Masthead. Deliberately the SAME vocabulary as the rest of Lumen —
            Lora display, the warm radial wash the login card uses, the single
            #c0392b accent — because the whole point of this page is that a topic
            is the feed, not a second product. The only new idea is the oversized
            hairline "#", which anchors the eye without adding a colour or a font. */}
        <PageMasthead eyebrow={t('topic_page.masthead.eyebrow')} title={displayName} mark="hash">
          <span className="inline-flex items-center gap-1.5">
            <span
              className={`h-[6px] w-[6px] rounded-full ${ranked ? 'bg-[#2f7d4f]' : 'bg-[#c9a227]'}`}
              aria-hidden
            />
            {ranked ? t('topic_page.masthead.ranked_for_you') : t('topic_page.masthead.newest_first')}
          </span>
          {shown.length > 0 ? (
            <>
              <span className="text-[#dcd7d2]" aria-hidden>
                ·
              </span>
              <span className="tabular-nums">
                {t(shown.length === 1 ? 'topic_page.masthead.post_count_one' : 'topic_page.masthead.post_count_other', {
                  count: shown.length
                })}
              </span>
            </>
          ) : null}
          <span className="text-[#dcd7d2]" aria-hidden>
            ·
          </span>
          <span>{t('topic_page.masthead.only_posts_tagged', { tag })}</span>
        </PageMasthead>

        {/* Same shape, same tokens, same placement as `feed-tabs.tsx`'s degraded
            banner — this is that hint, scoped to a topic. */}
        {buildingPage && !ranked && shown.length > 0 ? (
          <p className="mb-4 rounded-control bg-[#fdf6e7] px-3 py-2 font-sans text-caption italic text-[#9a7b2e]">
            {t('topic_page.building_hint')}
          </p>
        ) : null}

        {isLoading ? (
          <LumenLoader size="lg" label={t('global.loading_posts')} />
        ) : isError && shown.length === 0 && !hasNextPage ? (
          // ★ `isError` ALONE IS NO LONGER THE GUARD, same fix as ForYouFeed: with
          // `shown` already holding the last good page, only "nothing at all to
          // show, and nothing more coming" is an actual dead end — a failed
          // background refetch rides out silently instead of replacing the topic
          // with an error line.
          <p className="py-12 text-center font-sans text-sm text-muted-foreground">
            {t('topic_page.load_error.message')}
          </p>
        ) : shown.length === 0 && degradedPage ? (
          // ★ AN EMPTY DEGRADED ANSWER IS NOT AN EMPTY TOPIC. The server said it
          // could not serve this properly, so this page says that and offers a
          // retry — it does NOT assert "no posts carry this tag", which is a
          // statement about the topic that we have no evidence for.
          <div className="rounded-panel border border-dashed border-[#e6e0da] bg-[#fdfcfb] px-8 py-14 text-center">
            <p className="mb-1 font-serif text-[20px] leading-[30px] font-semibold text-[#161511]">
              {t('topic_page.degraded_state.title')}
            </p>
            <p className="mx-auto mb-5 max-w-[42ch] text-[14px] leading-[22px] text-[#6b7280]">
              <Trans
                t={t}
                i18nKey="topic_page.degraded_state.description"
                values={{ tag }}
                components={{ tagName: <span className="font-semibold text-[#161511]" /> }}
              />
            </p>
            <button
              type="button"
              onClick={() => refetch()}
              // ★ BRAND TOKENS, NOT `--destructive` — THEY ARE DIFFERENT REDS
              // (corrected 2026-08-14 after this file briefly shipped the wrong one).
              // `--surface-brand-12` is `192 57 43`, byte-identical to the
              // `#c0392b` this used to hardcode, and `--surface-brand-17` is
              // `150 39 27` = the `#96271b` hover it used to hardcode — so the
              // rendered colour is unchanged and dark mode now works.
              // `--destructive` is `hsl(0,70%,51%)` = `rgb(218,43,43)`, a
              // VISIBLY different red that the vote control moved to
              // deliberately on 2026-08-13/14; using it here would have
              // silently restyled this button. globals.css annotates each brand
              // token with the literal it was generated from, so this is a
              // lookup, not a judgement call.
              className="inline-block rounded-card bg-surface-brand-12 px-5 py-2.5 text-[14px] leading-[22px] font-bold text-white hover:bg-surface-brand-17"
            >
              {t('topic_page.degraded_state.retry')}
            </button>
          </div>
        ) : shown.length === 0 ? (
          // Never a bare dead end: an empty topic still offers a way onward.
          <div className="rounded-panel border border-dashed border-[#e6e0da] bg-[#fdfcfb] px-8 py-14 text-center">
            <p className="mb-1 font-serif text-[20px] leading-[30px] font-semibold text-[#161511]">
              {t('topic_page.empty_state.title')}
            </p>
            <p className="mx-auto mb-5 max-w-[42ch] text-[14px] leading-[22px] text-[#6b7280]">
              <Trans
                t={t}
                i18nKey="topic_page.empty_state.description"
                values={{ tag }}
                components={{ tagName: <span className="font-semibold text-[#161511]" /> }}
              />
            </p>
            <a
              href="/"
              className="inline-block rounded-card bg-surface-brand-12 px-5 py-2.5 text-[14px] leading-[22px] font-bold text-white hover:bg-surface-brand-17"
            >
              {t('topic_page.empty_state.back_to_feed')}
            </a>
          </div>
        ) : (
          shown.map((entry) => (
            <MediumPostCard
                key={`${entry.author}-${entry.permlink}`}
                post={entry}
                price={prices.get(entry.author)}
              luminosity={luminosity.get((entry.author ?? '').toLowerCase())}
              />
          ))
        )}

        {/* ★ BUG 2 FIX (2026-08-12, FX3) — same fix, same reasoning as
            `feed-tabs.tsx`'s `ForYouFeed`/`EntryFeed`: this sentinel used to be
            gated on `shown.length > 0`, so a page where NSFW-hide filtering
            removed every post while the server still had more (`hasNextPage:
            true`) never mounted it — `ref` never attached, `inView` could
            never become true, and infinite scroll dead-ended on "Nothing here
            yet" with more content one page away. Mounted on `hasNextPage`
            alone; the effect above already guards against a request loop
            (`!isFetchingNextPage` before fetching, stops at `hasNextPage:
            false`), unchanged by this fix. */}
        <ScrollPagerFooter
          sentinel={sentinel}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          isError={isError}
          loadedCount={shown.length}
          loadingLabel={t('topic_page.pager.loading_more')}
          endLabel={shown.length > 0 ? t('topic_page.pager.end_of_topic', { tag }) : undefined}
          className="py-8 text-center font-sans text-caption text-[#6b7280]"
          testId="topic-pager"
        />
      </main>

      <aside className="sticky top-24 hidden h-fit bg-background-secondary xl:block">
        <RightRail />
      </aside>
    </div>
  );
}
