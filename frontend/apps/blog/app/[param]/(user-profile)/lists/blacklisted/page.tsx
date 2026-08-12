import { extractUsernameFromParam } from '@/blog/utils/validate-links';
import { notFound, redirect } from 'next/navigation';

/**
 * ★ REDIRECT, NOT RENDER (owner ruling, 2026-08-12): "there should be no muted
 * list. its all block list... mutes and blocks are treated the same." This page
 * rendered a viewer's chain BLACKLIST as its own list. Lumen now has exactly one
 * moderation surface — the Settings Block list — and this route sends a reader
 * there instead of 404ing a bookmark. Unlike the chain MUTE list, blacklist
 * entries are not merged into that list's DATA (see `chain-mute.ts`'s "SCOPE"
 * note for why: Hivemind's own blacklist collapse is per-viewer and unrelated to
 * effect (B), so folding it in here would either enforce a mechanism nobody
 * asked to extend or show a row this filter does not actually act on). This
 * redirect is about the URL, not a claim that the destination lists the same
 * entries — see `(posts-tabs)/comments/page.tsx` for the same redirect pattern.
 */
const BlacklistedUsersPage = ({ params }: { params: { param: string } }) => {
  const username = extractUsernameFromParam(params.param);
  if (!username) notFound();

  redirect(`/@${username}/settings#blocked-accounts`);
};
export default BlacklistedUsersPage;
