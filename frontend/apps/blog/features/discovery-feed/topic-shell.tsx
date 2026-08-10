'use client';

import { useEffect } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useInView } from 'react-intersection-observer';
import LeftRail from '@/blog/features/layouts/left-rail';
import RightRail from '@/blog/features/layouts/right-rail';
import PageMasthead from '@/blog/features/layouts/page-masthead';
import MediumPostCard from './medium-post-card';
import { filterVisiblePosts, useNsfwPreference } from '@/blog/lib/nsfw';
import { PostListSkeleton } from '@hive/ui';
import { Entry } from '@hive/common-hiveio-packages/wax';
import { StaleTime } from '@/blog/lib/react-query';

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
      staleTime: StaleTime.MEDIUM
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

  const ranked = data?.pages?.[0]?.source === 'recsys';

  // ★ A COMMUNITY ID IS NOT A READABLE TOPIC (owner ruling, 2026-08-07).
  // Communities are shown as tags, so `hive-13323` lands here — and "#hive-13323"
  // tells a reader nothing. The posts themselves carry the real name, so use it
  // for the heading and keep the raw id only as the sub-label.
  const isCommunityId = /^hive-\d+$/i.test(tag);
  const communityName = entries.find((e) => (e as { community_title?: string }).community_title)?.[
    'community_title' as keyof typeof entries[number]
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
          {entries.length > 0 ? (
            <>
              <span className="text-[#dcd7d2]" aria-hidden>
                ·
              </span>
              <span className="tabular-nums">{entries.length} posts</span>
            </>
          ) : null}
          <span className="text-[#dcd7d2]" aria-hidden>
            ·
          </span>
          <span>only posts tagged {tag}</span>
        </PageMasthead>

        {isLoading ? (
          <PostListSkeleton count={5} />
        ) : isError ? (
          <p className="py-12 text-center font-sans text-sm text-muted-foreground">
            We couldn’t load this topic just now. Try again in a moment.
          </p>
        ) : entries.length === 0 ? (
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
          entries.map((entry) => (
            <MediumPostCard key={`${entry.author}-${entry.permlink}`} post={entry} />
          ))
        )}

        {entries.length > 0 && hasNextPage ? (
          <div ref={ref} className="py-8 text-center font-sans text-[13px] text-[#6b7280]">
            {isFetchingNextPage ? 'Loading more…' : ''}
          </div>
        ) : null}
        {entries.length > 0 && !hasNextPage ? (
          <p className="py-8 text-center font-sans text-[13px] text-[#6b7280]">That’s everything under #{tag}.</p>
        ) : null}
      </main>

      <aside className="sticky top-24 hidden h-fit xl:block">
        <RightRail />
      </aside>
    </div>
  );
}
