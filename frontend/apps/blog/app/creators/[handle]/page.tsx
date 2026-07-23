import type { Metadata } from 'next';
import { MOCK_TOKEN_DETAIL } from '@/blog/features/creator-tokens/market/token-detail';
import TokenMarketView from '@/blog/features/creator-tokens/ui/token-page/token-market-view';

export function generateMetadata({ params }: { params: { handle: string } }): Metadata {
  const handle = decodeURIComponent(params.handle).replace(/^@/, '');
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
export default function CreatorTokenPage() {
  return <TokenMarketView market={MOCK_TOKEN_DETAIL} />;
}
