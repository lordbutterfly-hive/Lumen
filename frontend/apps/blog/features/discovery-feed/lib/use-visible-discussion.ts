'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Entry } from '@hive/common-hiveio-packages/wax';
import { fetchDiscussion } from '@/blog/lib/lite/client/discussion-fetch';
import { isBlockedEntry, useLumenBlockList } from '@/blog/lib/lite/client/use-lumen-block';
import { discussionKey } from './top-comment';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE THREAD AS THIS READER WOULD ACTUALLY SEE IT, AND HOW MANY COMMENTS THAT IS.
 *
 * Extracted 2026-08-20 from `top-comment-drawer.tsx` so the CARD and the DRAWER
 * cannot disagree about the same thread — which is exactly the bug this fixes.
 *
 * ★★★ THE OWNER'S REPORT: "the blocked accounts still show up as if their
 * comments exist. the comments are hidden but under the card it says 2."
 *
 * The card prints `post.children`, which is Hivemind's raw recursive descendant
 * count. Hivemind knows nothing about either of this product's two block
 * mechanisms, and they are genuinely different things:
 *
 *   1. THE POST OWNER'S BLOCK — applied server-side in `/api/discussion`,
 *      global to every reader. That is what makes that route cacheable and
 *      viewer-independent, and it is the one the owner's report is about.
 *   2. THE READER'S OWN BLOCK LIST — applied client-side, per viewer. No
 *      server-computed number can ever be right for this one, because the
 *      answer is different for each person asking.
 *
 * A server-side count fix (shipped separately, in `block-filter.ts`) corrects
 * (1) for the post page. It cannot touch (2). This hook is what covers both, and
 * it can only do so on the client, at the moment it has the thread in hand.
 *
 * ★★ WHY THE COUNT IS ONLY CORRECT AFTER A HOVER, AND WHY THAT IS THE DEAL.
 * Getting it right before the reader engages would mean fetching every post's
 * thread on feed paint — one request per card, 20 per page, on the most visited
 * screen in the product. This app has already paid for that mistake once
 * (`/topics/photography`: 5.5-14.7s -> 0.38-0.68s in August, purely by deleting
 * serial trips). So the card shows Hivemind's number until it knows better, and
 * corrects itself the moment the thread arrives — which is the same moment the
 * reader is looking at the drawer that proves it.
 *
 * The alternative, precomputing corrected counts into a cache keyed by post, is
 * real infrastructure rather than a bug fix. It remains the right long-term
 * answer if the transient wrong number matters more than the request budget.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function useVisibleDiscussion(author: string, permlink: string, enabled: boolean) {
  const rootKey = discussionKey(author, permlink);

  const { data } = useQuery({
    queryKey: ['post-card-top-comment', rootKey],
    queryFn: () => fetchDiscussion(author, permlink),
    enabled,
    // A comment thread that has already been read once does not need re-reading
    // as the reader moves back up the feed.
    staleTime: 5 * 60 * 1000,
    // One retry only. This is decoration on a feed card: a thread that will not
    // load is a card without a drawer, not a reason to hammer the route.
    retry: 1,
    refetchOnWindowFocus: false
  });

  /*
   * ★ EAGER, NOT GATED ON `enabled`. Gating the block list on the hover flag made
   * the drawer wait for TWO round trips before it could show anything — measured
   * at ~1500ms to first comment against ~800ms warm. `feed-tabs.tsx` already
   * loads this list for the feed itself, so by the time any card is hovered this
   * resolves from React Query's cache and dedupes to that one request.
   */
  const blockList = useLumenBlockList(true);

  return useMemo(() => {
    if (!data || !blockList.loaded) return { visible: undefined, count: undefined };
    const visible: Record<string, Entry> = {};
    for (const [key, entry] of Object.entries(data)) {
      if (isBlockedEntry(entry as never, blockList)) continue;
      visible[key] = entry;
    }
    /*
     * The ROOT POST IS NOT A COMMENT. `bridge.get_discussion` always includes it
     * in the map, so counting the keys would report every thread as one comment
     * larger than it is — and would report a post with no replies at all as
     * having one.
     */
    const count = Object.keys(visible).filter((k) => k !== rootKey).length;
    return { visible, count };
  }, [data, blockList, rootKey]);
}
