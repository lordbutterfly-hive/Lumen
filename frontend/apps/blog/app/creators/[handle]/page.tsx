import { permanentRedirect, redirect } from 'next/navigation';
import { creatorPagePath, isRoutableCreatorHandle, normalizeCreatorHandle } from '@/blog/lib/meritum/creator-handle';
import { notFound } from 'next/navigation';

/**
 * ★ THE OLD ADDRESS. A creator's Meritum page lives at `/m/<handle>` since
 * 2026-09-15 (owner: "create a new page with its own url for this and check
 * all places that lead to current page and replace it"). Every link in the
 * app now points there; this route exists only so an old link, a bookmark or
 * a cached share still lands on the right page, permanently (308), with any
 * `?a=` deep link carried across so `/creators/x?a=buy` still opens Buy.
 *
 * The handle normalisation (`@`, `%40`, `%2540`, re-encoded colons, case) is
 * the shared one — see `lib/meritum/creator-handle.ts` for the history of
 * every one of those spellings breaking a live market's page.
 */
export default function LegacyCreatorTokenPage({
  params,
  searchParams
}: {
  params: { handle: string };
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const handle = normalizeCreatorHandle(params.handle);
  // Your own token (STUDIO_HANDLE = 'you') isn't a public trading page — it's
  // managed in the Studio. Kept from the old route so the flow does not change.
  if (handle === 'you') redirect('/creators/studio');
  if (!isRoutableCreatorHandle(handle)) notFound();
  const query = new URLSearchParams();
  for (const key of ['a', 'o']) {
    const value = searchParams?.[key];
    if (typeof value === 'string' && value.length > 0 && value.length <= 32) query.set(key, value);
  }
  const qs = query.toString();
  permanentRedirect(`${creatorPagePath(handle)}${qs ? `?${qs}` : ''}`);
}
