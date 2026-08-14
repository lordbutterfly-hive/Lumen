'use client';

import { ComponentPropsWithoutRef, forwardRef, ReactNode, useState } from 'react';
import { CircleSpinner } from 'react-spinners-kit';
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
import { Button } from '@ui/components/button';
import { useUserClient } from '@smart-signer/lib/auth/use-user-client';
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import DialogLogin from '@/blog/components/dialog-login';
import { useTranslation } from '@/blog/i18n/client';
import { useRebloggedByQuery } from './hooks/use-reblogged-by-query';

interface ReblogDialogProps extends Omit<ComponentPropsWithoutRef<typeof AlertDialogTrigger>, 'asChild' | 'children'> {
  children: ReactNode;
  author: string;
  permlink: string;
  action: (dialogResponse: boolean) => void;
  /** Optional: skip the query if reblog status is already known */
  isReblogged?: boolean;
}

/**
 * ★ Wrapped in forwardRef for the same reason as `DialogLogin`
 * (see `components/dialog-login.tsx:20-37`): `medium-post-card.tsx` renders
 * this directly inside a `TooltipTrigger asChild` slot, and Radix's
 * `SlotClone` hands the child a ref. A plain function component can't accept
 * one — "Function components cannot be given refs" — so the ref must be
 * forwarded onto the real trigger (`AlertDialogTrigger`), not onto the child.
 *
 * `post-list-item.tsx` looks like the same pattern but isn't: it puts a plain
 * `<div className="flex items-center">` between `TooltipTrigger asChild` and
 * `<ReblogDialog>`, so there the ref lands on that div — a no-op as far as
 * this component is concerned.
 *
 * The same `SlotClone` that hands `medium-post-card.tsx`'s trigger a ref also
 * merges its own props onto the child (`onPointerEnter`/`onPointerLeave`/
 * `onFocus`/`onBlur`/`data-state`/`aria-describedby`, the hooks the Tooltip
 * needs to know when to open and what to label). Those are forwarded here too
 * (`...triggerProps`) — without it the medium-card reblog tooltip silently
 * never opens and the trigger never gets `aria-describedby`, even though the
 * ref fix alone looks complete.
 */
export const ReblogDialog = forwardRef<HTMLButtonElement, ReblogDialogProps>(function ReblogDialog(
  {
    children,
    author,
    permlink,
    action,
    isReblogged: isRebloggedProp,
    ...triggerProps
  },
  ref
) {
  const { user } = useUserClient();
  /**
   * ★ SAME RACE, THE OK/LOGIN FOOTER (2026-08-12, F5 sweep). This was raw
   * `user.isLoggedIn` deciding between the real "Reblog" action and a
   * DialogLogin-wrapped button — cannot answer during SSR, reports "signed out"
   * until `/api/users/me` returns, so a real signed-in reader who opened this
   * dialog quickly could hit a login prompt instead of reblogging.
   * `user.username`/`user.account_tier` stay on the raw hook: they feed the
   * reblog-status query and the lite/full copy, neither of which is on `identity`.
   */
  const identity = useSessionIdentity();
  const { t } = useTranslation('common_blog');
  const [open, setOpen] = useState(false);

  // Check reblog status only when the dialog is open (lazy query).
  // Skip if the parent already provides the status via isRebloggedProp.
  const needsQuery = open && isRebloggedProp === undefined;
  const { data: isRebloggedQuery, isLoading: isCheckingReblog } = useRebloggedByQuery(
    needsQuery ? author : '',
    needsQuery ? permlink : '',
    needsQuery ? user.username : ''
  );
  const isReblogged = isRebloggedProp ?? isRebloggedQuery;
  // Disable the OK button while checking reblog status (only when dialog does its own query)
  const shouldDisableAction = isReblogged || (needsQuery && isCheckingReblog);

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild ref={ref} {...triggerProps}>
        {children}
      </AlertDialogTrigger>
      <AlertDialogContent className="flex flex-col gap-8 sm:rounded-r-xl ">
        <AlertDialogHeader className="gap-2">
          <div className="flex items-center justify-between">
            <AlertDialogTitle data-testid="reblog-dialog-header">
              {t('alert_dialog_reblog.title')}
            </AlertDialogTitle>
            <AlertDialogCancel className="border-none hover:text-ink-brand-3" data-testid="reblog-dialog-close">
              X
            </AlertDialogCancel>
          </div>
          <AlertDialogDescription data-testid="reblog-dialog-description">
            {isReblogged
              ? t('alert_dialog_reblog.already_reblogged')
              : /* A lite reblog never reaches Hive, so "shared with your
                   followers" would overstate its reach (2026-08-09). */
                user.account_tier === 'lite'
                ? t('alert_dialog_reblog.description_lite')
                : t('alert_dialog_reblog.description')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2 sm:flex-row-reverse">
          <AlertDialogCancel className="hover:text-ink-brand-3" data-testid="reblog-dialog-cancel">
            {t('alert_dialog_reblog.cancel')}
          </AlertDialogCancel>
          {identity.isLoggedIn ? (
            <AlertDialogAction
              autoFocus
              disabled={shouldDisableAction}
              className="rounded-none bg-surface-39 text-base text-ink-27 shadow-lg shadow-destructive hover:bg-destructive hover:shadow-line-26 disabled:bg-surface-34 disabled:shadow-none"
              onClick={(e) => {
                e.preventDefault();
                action(true);
                setOpen(false);
              }}
              data-testid="reblog-dialog-ok"
            >
              {needsQuery && isCheckingReblog ? (
                <span className="flex items-center gap-2">
                  <CircleSpinner loading size={14} color="#ffffff" />
                  {t('global.loading')}
                </span>
              ) : (
                t('alert_dialog_reblog.action')
              )}
            </AlertDialogAction>
          ) : (
            <DialogLogin>
              <Button data-testid="reblog-dialog-ok">{t('alert_dialog_reblog.action')}</Button>
            </DialogLogin>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
});
