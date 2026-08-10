import React from 'react';
import { Icons } from '@ui/components/icons';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@ui/components/tooltip';

/**
 * ★★★ IT FORWARDED THE REF AND THREW AWAY EVERYTHING ELSE (2026-08-10, P0-4).
 *
 * The audit read this as a missing `forwardRef`. It is not: the ref was already
 * forwarded. The defect is one line further on, and it is worse, because it fails
 * silently instead of warning.
 *
 * This component is handed to `<DialogTrigger asChild>` in two places (the post
 * header and every comment). Radix's `asChild` does not just pass a ref, it CLONES
 * the child with the trigger's own props: `onClick` to open the dialog, plus
 * `aria-haspopup`, `aria-expanded`, `data-state` and the keyboard handlers. Those
 * arrived here as props this component never declared and never spread, so they
 * were dropped on the floor. A signed-out reader clicking the flag got nothing at
 * all: no dialog, no error, no clue.
 *
 * The props type now accepts and forwards the rest, so the trigger's behaviour
 * reaches the real button. `onClick` stays explicit because the two callers pass
 * their own, and both must fire.
 *
 * ★ IT ALSO HAD NO ACCESSIBLE NAME (X-7). A bare icon in a button announces itself
 * as "button" and nothing more. The tooltip text is visual only; a screen reader
 * needs it on the control.
 */
type FlagTooltipProps = React.ComponentPropsWithoutRef<'button'> & { onClick?: () => void };

const FlagTooltip = React.forwardRef<HTMLButtonElement, FlagTooltipProps>(({ onClick, ...rest }, ref) => {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger ref={ref} aria-label="Flag post" onClick={onClick} {...rest}>
          <Icons.flag className="h-4" aria-hidden />
        </TooltipTrigger>
        <TooltipContent>Flag post</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});

FlagTooltip.displayName = 'FlagTooltip';

export default FlagTooltip;
