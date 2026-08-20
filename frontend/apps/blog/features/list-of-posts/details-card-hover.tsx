'use client';

import { HoverCard, HoverCardContent, HoverCardTrigger } from '@hive/ui/components/hover-card';
import { cn } from '@ui/lib/utils';
import { ReactNode, useRef, useState } from 'react';
import { Entry } from '@hive/common-hiveio-packages/wax';
import PayoutHoverContent from './payout-hover-content';

type DetailsCardHoverProps = {
  post: Entry;
  children: ReactNode;
  decline?: boolean;
  post_page?: boolean;
};

export default function DetailsCardHover({ post, children, decline, post_page }: DetailsCardHoverProps) {
  const [open, setOpen] = useState(false);
  const isHovering = useRef(false);

  const handleMouseEnter = () => {
    isHovering.current = true;
    setOpen(true);
  };

  const handleMouseLeave = () => {
    isHovering.current = false;
    setTimeout(() => {
      if (!isHovering.current) setOpen(false);
    }, 100);
  };
  /*
   * ★ A DECLINED PAYOUT IS NOT AN ERROR (2026-08-16, QA report H2/B2).
   *
   * The owner reported "$0.00 looks broken". Measured on the post page: this
   * figure rendered `rgb(239,68,68)` — the same red the app uses for error
   * states — while the identical figure on a feed card renders green
   * `rgb(47,125,79)`, or muted grey with a strike when declined
   * (medium-post-card.tsx: `payoutDeclined && 'text-muted-foreground
   * line-through'`). Same data, two colours, and the loud one said "error".
   *
   * EVERY Lumen lite post declines rewards by design, so this branch is the
   * NORMAL state for the product's own posts, not an exception. It now uses
   * the same muted treatment the feed card already uses, so a reader sees one
   * consistent "declined" language across both surfaces. The strike-through
   * and the 50% opacity already said it; the red was arguing with them.
   */
  if (decline) {
    return (
      <div
        className={cn(`flex items-center line-through opacity-50`, { 'text-ink-10': post_page })}
        data-testid="post-payout-decline"
        title="Payout Declined"
      >
        {'$'}
        {post.payout.toFixed(2)}
      </div>
    );
  }

  if (post.payout <= 0) {
    return (
      /* ★ A TRUE ZERO IS STILL MONEY (2026-08-20, found by qa-surface-consistency.mjs
         while checking the owner's "payout is red instead of green" report).
      
         This branch returns its OWN div instead of `children`, which throws away
         whatever the call site styled — so the feed card's green span never rendered
         here and $0.00 came out inherited black. The result was a payout whose colour
         depended on a rounding boundary: a post paying $0.004 took the normal path and
         printed a GREEN "$0.00", while a post paying exactly 0 took this one and
         printed a BLACK "$0.00". Same figure on screen, two colours, decided by a
         value the reader cannot see.
      
         (The alternative reading is that a true zero should be MUTED, which is what
         `post-card.module.css` intends with `--pc-payout-zero` — "deliberately not
         text you read". That treatment is not reachable from here, and green at least
         makes money one colour. If the owner wants zero muted, this is the line.) */
      <div className="flex items-center text-[color:rgb(var(--ink-payout))]" data-testid="post-payout">
        {'$'}
        {post.payout.toFixed(2)}
      </div>
    );
  }

  return (
    <HoverCard open={open}>
      <HoverCardTrigger
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onClick={() => setOpen(!open)}
        asChild
      >
        {children}
      </HoverCardTrigger>
      <HoverCardContent
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className="flex w-auto flex-col"
        data-testid="payout-post-card-tooltip"
      >
        <PayoutHoverContent post={post} />
      </HoverCardContent>
    </HoverCard>
  );
}
