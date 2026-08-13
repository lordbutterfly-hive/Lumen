'use client';

import { memo, ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@ui/components/tooltip';

const TooltipContainer = memo(function TooltipContainer({
  children,
  title,
  side = 'bottom',
  contentTestId
}: {
  children: ReactNode;
  // ★ Widened from `string` to `ReactNode` (2026-08-13, votes a11y fix) so a
  // caller can pass a multi-line tooltip body (e.g. a bold label plus an
  // after-payout note) instead of being limited to one plain string.
  title: ReactNode;
  // ★ Added (2026-08-13). Defaults to today's behaviour ('bottom') so every
  // existing call site is unaffected; votes needs 'top' so the tooltip does
  // not move on every card.
  side?: 'top' | 'right' | 'bottom' | 'left';
  // ★ Added (2026-08-13). Optional passthrough `data-testid` for the popup
  // content itself (distinct from any testid the caller puts on the trigger
  // button). Undefined by default, so every existing call site renders no
  // attribute at all — unchanged. Votes needs this to keep the
  // `upvote-button-tooltip` / `downvote-button-tooltip` testids that several
  // playwright page objects and specs outside this fix's scope already
  // assert `.textContent()` against.
  contentTestId?: string;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} data-testid={contentTestId}>
          {title}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

export default TooltipContainer;
