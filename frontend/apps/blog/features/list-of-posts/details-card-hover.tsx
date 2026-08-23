'use client';

import { HoverCard, HoverCardContent, HoverCardTrigger } from '@hive/ui/components/hover-card';
import { cn } from '@ui/lib/utils';
import { ReactNode, useRef, useState } from 'react';
import { Entry } from '@hive/common-hiveio-packages/wax';
import PayoutHoverContent from './payout-hover-content';

type DetailsCardHoverProps = {
  post: Entry;
  children: ReactNode;
  /**
   * ★ THE CALLER'S LAYOUT, CARRIED THROUGH THE EARLY RETURNS (2026-08-23).
   *
   * The two branches below (`decline`, and `payout <= 0`) render their OWN div and
   * discard `children` — so any positioning the caller put on its child element was
   * silently thrown away in exactly the two most common cases: every Lumen lite post
   * declines by design, and most comments sit at $0.00. That is how the comment
   * payout kept rendering inline after being given `order-last ml-auto`: the classes
   * were on a node that never reached the DOM.
   *
   * Passing layout in explicitly is what makes the three payout surfaces agree. This
   * file already carries a note about an early return discarding the caller's styling
   * for COLOUR; this is the same defect for POSITION.
   */
  className?: string;
  decline?: boolean;
  post_page?: boolean;
};

export default function DetailsCardHover({ post, children, decline, post_page, className }: DetailsCardHoverProps) {
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
        className={cn(`flex items-center line-through opacity-50`, { 'text-ink-10': post_page }, className)}
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
        <div className={cn('flex items-center text-[color:rgb(var(--ink-payout))]', className)} data-testid="post-payout">
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
        /* ★★ REACHABLE BY KEYBOARD (2026-08-21, found by a keyboard-only pass).

           The trigger only wired `onMouseEnter` / `onMouseLeave` / `onClick`, and
           `children` is a plain <span>, so the payout figure had NO tab stop at all: a
           mouse user could see the author/curator split, and a keyboard user had no
           path to it whatever. Measured: `tabIndex -1`, no `tabindex` attribute.

           `tabIndex={0}` puts it in the tab order and `onFocus`/`onBlur` mirror the
           pointer handlers, so focusing the figure opens the same card that hovering
           it does. Escape closes it — `HoverCard` already handles that.

           ★ NO role="button". This opens a disclosure, it does not act, and the
           figure's own text ("$14.30") is the accessible name a reader needs.
           `aria-expanded` carries the state instead. */
        tabIndex={0}
        aria-expanded={open}
        onFocus={handleMouseEnter}
        onBlur={handleMouseLeave}
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
