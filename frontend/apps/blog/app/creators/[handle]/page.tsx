import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import TokenMarketView from '@/blog/features/creator-tokens/ui/token-page/token-market-view';

export function generateMetadata({ params }: { params: { handle: string } }): Metadata {
  // Next.js already URL-decodes the dynamic segment, so DON'T decode again —
  // decodeURIComponent on an already-decoded value containing a bare '%'
  // (e.g. /creators/abc%25 → "abc%") throws URIError and 500s the page.
  const handle = params.handle.replace(/^@/, '');
  return {
    title: `@${handle} token`,
    description: `The live creator-token market for @${handle} on Lumen — price, market cap, floor, delivery record, and the services you spend the token on.`
  };
}

/**
 * The creator-token market page. Design route is `/@creator` (the profile
 * page), but that integration touches the existing profile feature — this
 * `/creators/[handle]` route is the interim, self-contained home so the flow
 * (Creators → token page) works end-to-end now.
 *
 * TODO(live): fetch the market for `params.handle` from the indexer; renders the
 * mock @ada detail until the contract is deployed.
 */
export default function CreatorTokenPage({ params }: { params: { handle: string } }) {
  // Next.js already URL-decodes the dynamic segment, so DON'T decode again —
  // decodeURIComponent on an already-decoded value containing a bare '%'
  // (e.g. /creators/abc%25 → "abc%") throws URIError and 500s the page.
  const handle = params.handle.replace(/^@/, '');
  // Your own token (STUDIO_HANDLE = 'you') isn't a public trading page — it's
  // managed in the Studio. Redirecting also closes the self-dealing loop (#2).
  if (handle === 'you') redirect('/creators/studio');
  return <TokenMarketView handle={handle} />;
}
