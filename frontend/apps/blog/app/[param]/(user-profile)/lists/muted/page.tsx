import { extractUsernameFromParam } from '@/blog/utils/validate-links';
import { notFound, redirect } from 'next/navigation';

/**
 * ★ REDIRECT, NOT RENDER (owner ruling, 2026-08-12): "there should be no muted
 * list. its all block list, we merged it and it works all as block." This page
 * used to fetch `bridge.get_follow_list(username, 'muted')` and render it as its
 * own list, independent of Lumen's Block feature. That list is now merged into
 * the one Block list on Settings — `/api/lite/block/list` reads the same chain
 * data (`lib/lite/social/chain-mute.ts`) and `BlockedList` renders it alongside
 * a viewer's Lumen blocks, with the chain-sourced rows visibly marked (see that
 * component's header for why the removal path differs for them). This route
 * gets a redirect rather than a delete because an old link or bookmark to it
 * still exists — see `(posts-tabs)/comments/page.tsx` for the same pattern.
 */
const MutedPage = ({ params }: { params: { param: string } }) => {
  const username = extractUsernameFromParam(params.param);
  if (!username) notFound();

  redirect(`/@${username}/settings#blocked-accounts`);
};
export default MutedPage;
