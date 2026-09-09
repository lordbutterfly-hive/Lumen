'use client';

/**
 * Read-only copy of the HoldingRow inside
 * features/creator-tokens/ui/your-tokens/your-tokens-view.tsx, one row per
 * Meritum holding on the public wallet page.
 *
 * WHAT WAS REMOVED AND WHY. The original row carries three links: Buy, Sell
 * (or Redeem) and Send, each acting on the SIGNED-IN reader's own position.
 * On someone else's wallet page Sell/Send are meaningless (nobody but the
 * holder can act on their tokens), and Buy is not an action on THIS holding
 * at all; it belongs on the market page (D8). This row links only to the
 * creator's token page, exactly where every one of those actions already
 * lives, and keeps the health-word chip verbatim (the same predicate the
 * private row uses) so a reader can tell a frozen or paused market apart
 * from an open one before clicking through.
 */

import { Link } from '@hive/ui';
import { UserAvatarImg } from '@ui/components';
import { displayHandle, routeHandle } from '@/blog/features/creator-tokens/live/adapt';
import { healthWordFor } from '@/blog/features/creator-tokens/market/market-health';
import type { HolderPosition, MarketPrice } from '@/blog/features/creator-tokens/types';

export default function PublicHoldingRow({ holding, price }: { holding: HolderPosition; price?: MarketPrice }) {
  return (
    <div
      className="flex flex-wrap items-center gap-4 rounded-card border border-line-9 bg-surface-1 px-5 py-4"
      data-testid="public-holding-row"
    >
      <UserAvatarImg username={routeHandle(holding.creator)} apiSize="medium" pixelSize={44} radiusClassName="rounded-control" />
      <div className="min-w-0 flex-1">
        <Link
          href={`/creators/${routeHandle(holding.creator)}`}
          className="text-[15px] leading-[24px] font-medium text-ink-2 font-ui hover:text-ink-brand-6"
        >
          @{displayHandle(holding.creator)}
        </Link>
      </div>
      <div className="text-right tabular-nums">
        <div className="text-[15px] leading-[24px] tabular-nums text-ink-2 font-num">{holding.tokensHeld.toFixed(2)} tokens</div>
      </div>
      {price && price.status === 'ready' && price.health !== null && price.health !== 'open' && price.health !== 'lapsed' ? (
        // The state word, same words as every other surface (market/market-health.ts).
        // Not a link: there is nothing to buy on this row.
        <span
          className="rounded-control border border-line-warn-4 bg-surface-warn-2 px-3 py-2 text-caption font-medium text-ink-warn-3 font-ui"
          data-testid="public-holding-health"
        >
          {healthWordFor(price.health)}
        </span>
      ) : null}
    </div>
  );
}
