'use client';

import { ComponentPropsWithoutRef, forwardRef, ReactNode, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@ui/components/alert-dialog';
import { useTranslation } from '@/blog/i18n/client';

interface VoteRemovalDialogProps {
  children: ReactNode;
  voteType: 'upvote' | 'downvote';
  onConfirm: () => void;
}

/**
 * ★ FORWARDS REF + EXTRA PROPS (2026-08-13, votes keyboard-a11y fix,
 * `votes-component.tsx`). The undo-vote control now nests a `TooltipContainer`
 * OUTSIDE this component so both share one real `<button>`
 * (`Tooltip -> AlertDialogTrigger -> button`, the documented Radix
 * double-`asChild` composition). `TooltipTrigger asChild` clones its
 * immediate child — this component — merging a `ref` and the hover/focus
 * handlers that open the tooltip onto it. A plain, non-forwardRef function
 * component can't accept a ref (the exact bug already found and fixed in
 * `apps/blog/components/dialog-login.tsx`: "Function components cannot be
 * given refs"), and without a `...rest` spread the merged handlers have
 * nowhere to go either — so the tooltip would silently never open. This
 * component's OWN job (opening the removal confirmation on click/Enter/Space)
 * does not depend on this fix — `children` is threaded through directly to
 * `AlertDialogTrigger` regardless — this fix is what makes the OUTER
 * Tooltip's hover/focus behaviour work when this is nested inside it.
 */
export const VoteRemovalDialog = forwardRef<
  HTMLButtonElement,
  VoteRemovalDialogProps & Omit<ComponentPropsWithoutRef<'button'>, keyof VoteRemovalDialogProps>
>(function VoteRemovalDialog({ children, voteType, onConfirm, ...triggerProps }, ref) {
  const { t } = useTranslation('common_blog');
  const [open, setOpen] = useState(false);

  const title =
    voteType === 'upvote'
      ? t('vote_removal_dialog.remove_upvote_title')
      : t('vote_removal_dialog.remove_downvote_title');

  const description =
    voteType === 'upvote'
      ? t('vote_removal_dialog.remove_upvote_description')
      : t('vote_removal_dialog.remove_downvote_description');

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild ref={ref} {...triggerProps}>
        {children}
      </AlertDialogTrigger>
      <AlertDialogContent className="flex flex-col gap-8 sm:rounded-r-xl">
        <AlertDialogHeader className="gap-2">
          <div className="flex items-center justify-between">
            <AlertDialogTitle data-testid="vote-removal-dialog-header">{title}</AlertDialogTitle>
            <AlertDialogCancel
              className="border-none hover:text-ink-brand-3"
              data-testid="vote-removal-dialog-close"
            >
              X
            </AlertDialogCancel>
          </div>
          <AlertDialogDescription data-testid="vote-removal-dialog-description">
            {description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2 sm:flex-row-reverse">
          <AlertDialogCancel className="hover:text-ink-brand-3" data-testid="vote-removal-dialog-cancel">
            {t('vote_removal_dialog.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            autoFocus
            className="rounded-none bg-surface-39 text-base text-ink-27 shadow-lg shadow-destructive hover:bg-destructive hover:shadow-line-26 disabled:bg-surface-34 disabled:shadow-none"
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
              setOpen(false);
            }}
            data-testid="vote-removal-dialog-ok"
          >
            {t('vote_removal_dialog.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
});
