'use client';

import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

import { cn } from '@ui/lib/utils';

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  /*
   * ★★★ PORTALLED 2026-08-19 — the same defect as `hover-card.tsx`, found by
   * auditing every Radix wrapper in this folder after the owner reported the
   * payout hover sliding behind the next card.
   *
   * `medium-post-card.tsx`, `post-list-item.tsx`, `reblog-trigger.tsx`,
   * `post-card-comment-tooltip.tsx` and `post-card-blacklist-mark.tsx` all put a
   * tooltip INSIDE a `.lm-card`, and that card is a stacking context (see the note
   * in hover-card.tsx). An inline tooltip is therefore trapped in the card that
   * owns it and painted under every later card, no matter what `z-50` says.
   *
   * Portalling is what the other six overlay primitives in this folder already do.
   */
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 overflow-hidden rounded-md border bg-popover px-3 py-1.5 text-sm font-ui text-popover-foreground shadow-[var(--lift-3)] animate-in fade-in-50 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1',
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
