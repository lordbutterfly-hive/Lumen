import { notFound, permanentRedirect } from 'next/navigation';
import { extractUsernameFromParam } from '@/blog/utils/validate-links';

/**
 * ★★★ THE OLD URL, KEPT ALIVE (2026-08-13, redesign spec "Copy and routing
 * changes": `/@[user]/followed` -> `/@[user]/following`, 301 the old path).
 *
 * `followed` was the only place in the product that used that word: the page
 * heading, the profile stat tile, the left rail and every label already said
 * "Following". The route is renamed rather than aliased so there is one URL for
 * one page — but this path has been live and linkable for the life of the app,
 * so it must not become a 404.
 *
 * `permanentRedirect` answers **308**, not 301. That is deliberate and is the
 * correct modern equivalent: 308 is the permanent redirect that preserves the
 * request method, where 301 historically let intermediaries rewrite POST to GET.
 * Both are permanent and both are cached by browsers and search engines; the
 * spec's "301" names the intent (permanent), not the numeral.
 *
 * There is no `layout.tsx`/`loading.tsx` here any more: this segment renders
 * nothing, it only redirects.
 */
export default function FollowedRedirectPage({ params }: { params: { param: string } }) {
  const username = extractUsernameFromParam(params.param);
  if (!username) notFound();
  permanentRedirect(`/@${username}/following`);
}
