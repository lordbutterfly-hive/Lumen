'use client';

import { CircleSpinner } from 'react-spinners-kit';
import { cn } from '@ui/lib/utils';
import { Icons } from '@ui/components/icons';
import { handleError } from '@ui/lib/handle-error';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@ui/components/tooltip';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useRebloggedByQuery } from './hooks/use-reblogged-by-query';
import { useReblogMutation } from './hooks/use-reblog-mutation';
import { ReblogDialog } from './reblog-dialog';
import { useTranslation } from '@/blog/i18n/client';

/**
 * Interactive reblog trigger for individual post pages.
 *
 * This component pre-fetches the reblog status and shows the icon
 * state immediately. For list pages, ReblogDialog is used directly
 * with a lazy query instead.
 *
 * This component:
 * - Makes API call to check if user has reblogged
 * - Shows interactive icon that changes color based on reblog status
 * - Opens confirmation dialog when clicked
 * - Handles reblog mutation
 */
const ReblogTrigger = ({
  author,
  permlink,
  dataTestidTooltipContent,
  dataTestidTooltipIcon,
  isReblogged: isRebloggedProp,
  showLabel = false,
  className,
  iconClassName
}: {
  author: string;
  permlink: string;
  dataTestidTooltipContent: string;
  dataTestidTooltipIcon: string;
  /** Optional: pass from parent to avoid duplicate queries when multiple triggers exist */
  isReblogged?: boolean;
  /** Show label with styled button wrapper */
  showLabel?: boolean;
  /** Icon-only variant: extra classes for the button (the post bar makes it a chip). */
  className?: string;
  /** Icon-only variant: extra classes for the glyph (size, stroke). */
  iconClassName?: string;
}) => {
  const { t } = useTranslation('common_blog');
  const { user } = useUserClient();
  // Skip query if isReblogged is provided from parent
  const { data: isRebloggedQuery } = useRebloggedByQuery(
    isRebloggedProp !== undefined ? '' : author,
    isRebloggedProp !== undefined ? '' : permlink,
    isRebloggedProp !== undefined ? '' : user.username
  );
  const isReblogged = isRebloggedProp ?? isRebloggedQuery;

  const reblogMutation = useReblogMutation();

  const reblog = async () => {
    try {
      await reblogMutation.mutateAsync({ author, permlink, username: user.username });
    } catch (error) {
      handleError(error, { method: 'reblog', params: { author, permlink, username: user.username } });
    }
  };

  // Receive output from dialog and do action according to user's
  // response.
  const dialogAction = (dialogResponse: boolean): void => {
    if (dialogResponse) {
      reblog();
    }
  };

  if (showLabel) {
    return (
      <ReblogDialog author={author} permlink={permlink} action={dialogAction} isReblogged={isReblogged}>
        <button
          disabled={isReblogged || reblogMutation.isLoading}
          className={cn(
            'flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-background-secondary hover:text-foreground',
            {
              'cursor-default text-destructive': isReblogged,
              'cursor-not-allowed opacity-50': reblogMutation.isLoading
            }
          )}
        >
          {reblogMutation.isLoading ? (
            <CircleSpinner loading={reblogMutation.isLoading} size={16} color="#dc2626" />
          ) : (
            // ★ The reblog loop, as on the post bar and every feed card (owner, 2026-09-23:
            // "switch the top Reblog button to the loop icon too"). It was the share tray
            // (`Icons.forward`), so one page drew the same action with two marks.
            <Icons.reblog
              className={cn('h-4 w-4 stroke-2', {
                'text-destructive': isReblogged
              })}
              aria-hidden="true"
              data-testid={dataTestidTooltipIcon}
            />
          )}
          <span className="font-medium">
            {isReblogged ? t('cards.post_card.you_reblogged') : t('cards.post_card.reblog')}
          </span>
        </button>
      </ReblogDialog>
    );
  }

  // Same string the tooltip below already shows on hover — used here as the
  // accessible name because the trigger's only visible content is an icon (or a
  // spinner while loading), so without it the control was an unnamed button.
  const triggerLabel = isReblogged ? t('cards.post_card.you_reblogged') : t('cards.post_card.reblog');

  return (
    <TooltipProvider>
      <Tooltip>
        {/* ★ min-h/min-w-[24px] FOR THE HIT TARGET (2026-08-19, WCAG 2.2 AA
            2.5.8). No className at all before this — the rendered button was
            exactly the h-4 w-4 icon, 16x16. Measured on the post footer (the
            only place this icon-only variant renders): the action row
            (`comment-respons-header`, already 36px tall from the "Reply"
            chip's own h-9) was unchanged, 0px cost. */}
        {/* ★★ THE BUTTON IS THE DIALOG TRIGGER, NOT THE GLYPH INSIDE IT (2026-09-23, post
            bar uniformity pass). This used to be a Radix button wrapping the dialog trigger,
            and the trigger was the <svg>. So only the glyph's own pixels opened the dialog:
            a click on the button's padding, or Enter on the focused button, targets the
            button, and a click event bubbles up to ancestors, never down into the svg. That
            dead ring was 4px around a 16px glyph; as the post bar's 36px chip around a 22px
            glyph it would have been most of the control. Same nesting as the feed card's
            reblog chip (medium-post-card.tsx): tooltip trigger, then the dialog trigger, then
            one real <button>. Checked on the new nesting: Enter on the focused chip opens the
            reblog dialog, and Cancel returns focus to the chip.
            ★ THE GLYPH IS THE FEED'S REBLOG MARK (`Icons.reblog`, line work), not the
            share-tray `Icons.forward`. The tray is a filled "press" icon whose walls are
            3.4 of 24 units, 3.1px at the 22px the bar draws every icon at, against the vote
            blade's 1.83px stroke; no size gives it both the bar's icon size and its line
            weight. `Icons.reblog` at `stroke-2` is exactly the blade's weight, and it is the
            mark readers already see for this action on every feed card. This icon-only
            variant renders only in the post bar (content.tsx); the labelled header variant
            above draws the same loop. */}
        <TooltipTrigger asChild>
          <ReblogDialog author={author} permlink={permlink} action={dialogAction} isReblogged={isReblogged}>
            <button
              type="button"
              disabled={isReblogged || reblogMutation.isLoading}
              aria-label={triggerLabel}
              className={cn('flex min-h-[24px] min-w-[24px] items-center justify-center', className, {
                'cursor-default': isReblogged
              })}
            >
              {reblogMutation.isLoading ? (
                <CircleSpinner loading={reblogMutation.isLoading} size={18} color="#dc2626" />
              ) : (
                <Icons.reblog
                  className={cn('h-4 w-4', iconClassName, {
                    'text-destructive': isReblogged
                  })}
                  aria-hidden="true"
                  data-testid={dataTestidTooltipIcon}
                />
              )}
            </button>
          </ReblogDialog>
        </TooltipTrigger>
        <TooltipContent data-testid={dataTestidTooltipContent}>
          <p>{isReblogged ? t('cards.post_card.you_reblogged') : t('cards.post_card.reblog')}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

export default ReblogTrigger;
