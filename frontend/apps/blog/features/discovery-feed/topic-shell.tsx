'use client';

import { useEffect, useRef } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useInView } from 'react-intersection-observer';
import LeftRail from '@/blog/features/layouts/left-rail';
import RightRail from '@/blog/features/layouts/right-rail';
import PageMasthead from '@/blog/features/layouts/page-masthead';
import MediumPostCard from './medium-post-card';
import { filterVisiblePosts, useNsfwPreference } from '@/blog/lib/nsfw';
import { PostListSkeleton } from '@hive/ui';
import { Entry } from '@hive/common-hiveio-packages/wax';

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

interface TopicResponse {
  entries: Entry[];
  source: string;
  degraded?: string;
  nextCursor?: { author: string; permlink: string } | null;
}

const LIMIT = 30;

export default function TopicShell({ tag }: { tag: string }) {
  const { ref, inView } = useInView();

  // Same infinite scroll as the main feed — a topic is the feed, filtered, so it
  // must not stop after one page either.
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery<TopicResponse>({
      queryKey: ['topicFeed', tag],
      queryFn: async ({ pageParam }) => {
        const cursor = pageParam as { author?: string; permlink?: string } | undefined;
        const params = new URLSearchParams({ tag, limit: String(LIMIT) });
        if (cursor?.author && cursor?.permlink) {
          params.set('startAuthor', cursor.author);
          params.set('startPermlink', cursor.permlink);
        }
        const res = await fetch(`/api/feed/for-you?${params.toString()}`);
        if (!res.ok) throw new Error(`topic ${res.status}`);
        return (await res.json()) as TopicResponse;
      },
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
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false
    });

  useEffect(() => {
    if (inView && hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [inView, hasNextPage, isFetchingNextPage, fetchNextPage]);

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

  // ★ A COMMUNITY ID IS NOT A READABLE TOPIC (owner ruling, 2026-08-07).
  // Communities are shown as tags, so `hive-13323` lands here — and "#hive-13323"
  // tells a reader nothing. The posts themselves carry the real name, so use it
  // for the heading and keep the raw id only as the sub-label.
  const isCommunityId = /^hive-\d+$/i.test(tag);
  const communityName = shown.find((e) => (e as { community_title?: string }).community_title)?.[
    'community_title' as keyof typeof shown[number]
  ] as string | undefined;
  const displayName = isCommunityId && communityName ? communityName : tag;

  return (
    <div className="relative mx-auto grid max-w-[1720px] grid-cols-1 gap-11 px-6 pb-20 pt-[26px] md:grid-cols-[200px_minmax(0,1fr)] md:px-11 xl:grid-cols-[200px_minmax(0,1fr)_312px]">
      <div
        className="pointer-events-none absolute bottom-20 left-[244px] top-[26px] hidden w-px bg-[#ececec] md:block"
        aria-hidden
      />

      <aside className="sticky top-24 hidden h-fit md:block">
        <LeftRail />
      </aside>

      <main className="min-w-0">
        {/* Masthead. Deliberately the SAME vocabulary as the rest of Lumen —
            Lora display, the warm radial wash the login card uses, the single
            #c0392b accent — because the whole point of this page is that a topic
            is the feed, not a second product. The only new idea is the oversized
            hairline "#", which anchors the eye without adding a colour or a font. */}
        <PageMasthead eyebrow="Topic" title={displayName} mark="hash">
          <span className="inline-flex items-center gap-1.5">
            <span
              className={`h-[6px] w-[6px] rounded-full ${ranked ? 'bg-[#2f7d4f]' : 'bg-[#c9a227]'}`}
              aria-hidden
            />
            {ranked ? 'Ranked for you' : 'Newest first'}
          </span>
          {shown.length > 0 ? (
            <>
              <span className="text-[#dcd7d2]" aria-hidden>
                ·
              </span>
              <span className="tabular-nums">{shown.length} posts</span>
            </>
          ) : null}
          <span className="text-[#dcd7d2]" aria-hidden>
            ·
          </span>
          <span>only posts tagged {tag}</span>
        </PageMasthead>

        {isLoading ? (
          <PostListSkeleton count={5} />
        ) : isError && shown.length === 0 && !hasNextPage ? (
          // ★ `isError` ALONE IS NO LONGER THE GUARD, same fix as ForYouFeed: with
          // `shown` already holding the last good page, only "nothing at all to
          // show, and nothing more coming" is an actual dead end — a failed
          // background refetch rides out silently instead of replacing the topic
          // with an error line.
          <p className="py-12 text-center font-sans text-sm text-muted-foreground">
            We couldn’t load this topic just now. Try again in a moment.
          </p>
        ) : shown.length === 0 ? (
          // Never a bare dead end: an empty topic still offers a way onward.
          <div className="rounded-[20px] border border-dashed border-[#e6e0da] bg-[#fdfcfb] px-8 py-14 text-center">
            <p className="mb-1 font-serif text-[19px] font-semibold text-[#161511]">Nothing here yet</p>
            <p className="mx-auto mb-5 max-w-[42ch] text-[13.5px] leading-[1.6] text-[#6b7280]">
              No posts carry the tag <span className="font-semibold text-[#161511]">{tag}</span> right now. This page
              only ever shows that one tag, so it stays empty until someone posts under it.
            </p>
            <a
              href="/"
              className="inline-block rounded-[13px] bg-[#c0392b] px-5 py-2.5 text-[14px] font-bold text-white hover:bg-[#96271b]"
            >
              Back to your feed
            </a>
          </div>
        ) : (
          shown.map((entry) => (
            <MediumPostCard key={`${entry.author}-${entry.permlink}`} post={entry} />
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
        {hasNextPage ? (
          <div ref={ref} className="py-8 text-center font-sans text-[13px] text-[#6b7280]">
            {isFetchingNextPage ? 'Loading more…' : ''}
          </div>
        ) : null}
        {!hasNextPage && shown.length > 0 ? (
          <p className="py-8 text-center font-sans text-[13px] text-[#6b7280]">That’s everything under #{tag}.</p>
        ) : null}
      </main>

      <aside className="sticky top-24 hidden h-fit xl:block">
        <RightRail />
      </aside>
    </div>
  );
}
