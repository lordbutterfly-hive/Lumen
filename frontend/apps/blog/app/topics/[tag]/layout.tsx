import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isValidTagFormat, isCommunityFormat } from '@transaction/lib/validation';

/**
 * ★ WHERE AN INVALID TOPIC BECOMES A 404 (snappiness phase 4, 2026-09-03).
 *
 * `[tag]/loading.tsx` makes a click commit at once, but a Suspense boundary
 * also flushes the 200 before the async page's `notFound()` can resolve, so an
 * invalid tag rendered the not-found copy under a 200 (found in review). The
 * cure is the pattern the profile section already uses: validate in the LAYOUT,
 * which runs before the page's loading boundary, so `notFound()` here yields a
 * real 404 (proven live: `/@nonexistent` 404s the same way, layout + loading
 * side by side). A middleware rewrite was tried instead and 500'd through the
 * HTTP/2 edge on the rewritten response; this needs no rewrite at all.
 */
const Layout = ({ children, params }: { children: ReactNode; params: { tag: string } }) => {
  let tag: string;
  try {
    tag = decodeURIComponent(params.tag).toLowerCase();
  } catch {
    notFound();
  }
  if (!isValidTagFormat(tag) && !isCommunityFormat(tag)) notFound();
  return <>{children}</>;
};

export default Layout;
