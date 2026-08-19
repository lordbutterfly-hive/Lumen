'use client';

import * as React from 'react';
import * as HoverCardPrimitive from '@radix-ui/react-hover-card';

import { cn } from '@ui/lib/utils';

const HoverCard = HoverCardPrimitive.Root;

const HoverCardTrigger = HoverCardPrimitive.Trigger;

const HoverCardContent = React.forwardRef<
  React.ElementRef<typeof HoverCardPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof HoverCardPrimitive.Content>
>(({ className, align = 'center', sideOffset = 4, ...props }, ref) => (
  /*
   * ★★★ PORTALLED 2026-08-19, AND THE BUG IT FIXES WAS OWNER-REPORTED:
   * "the hover over payout renders behind cards".
   *
   * This content was rendered INLINE, i.e. as a child of whatever triggered it.
   * `z-50` then means nothing outside its own stacking context, and the feed card
   * is a stacking context THREE times over (`packages/tailwindcss/globals.css`):
   *
   *   .lm-card      { will-change: transform }   <- creates one on every card, always
   *   .lm-card:hover{ transform: translateY(-2px) } <- and again exactly while hovering
   *   .lm-enter     { animation: ... both }      <- `both` retains translateY(0) after
   *
   * So the payout hover card was painted inside card N, and every card AFTER it in
   * the feed painted on top — the popover slid under the next card. z-index cannot
   * fix this: a descendant can never escape its ancestor's stacking context, no
   * matter how high its own value.
   *
   * A Portal moves the content to `document.body`, out of every card, which is what
   * Radix provides it for and what `dialog`, `alert-dialog`, `dropdown-menu`,
   * `popover`, `select` and `sheet` in this same folder already do. Hover-card and
   * tooltip were the only two overlay primitives here that did not, and they are
   * exactly the two that appear inside feed cards.
   *
   * Locators are unaffected: every test reaches these through document-scoped
   * `page.locator('[data-testid=...]')` / `getByTestId`, never by descending from a
   * card, and the one chained locator in the suite starts FROM the content testid.
   */
  <HoverCardPrimitive.Portal>
    <HoverCardPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        'z-50 w-64 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none animate-in zoom-in-90',
        className
      )}
      {...props}
    />
  </HoverCardPrimitive.Portal>
));
HoverCardContent.displayName = HoverCardPrimitive.Content.displayName;

export { HoverCard, HoverCardTrigger, HoverCardContent };
