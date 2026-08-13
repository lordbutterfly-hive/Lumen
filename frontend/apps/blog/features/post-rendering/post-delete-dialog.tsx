'use client';

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
import { useSessionIdentity } from '@/blog/features/layouts/server-session';
import { useTranslation } from '@/blog/i18n/client';
import { X } from 'lucide-react';
import { ReactNode, useState } from 'react';

export function PostDeleteDialog({
  children,
  permlink,
  action,
  label
}: {
  children: ReactNode;
  permlink: string;
  action: (permlink: string) => void;
  /**
   * ★ O6 build map item 4 (2026-08-13). This was the only confirmation
   * dialog in the app with hardcoded English (`Confirm Delete ${label}`,
   * `Are you sure?`, `Cancel`, `OK`, a bare `X` with no accessible name).
   * `label` stays the historical English literal (`'Post'` | `'Comment'`)
   * rather than becoming a `variant` prop, so the `content.tsx` call site —
   * out of this file's ownership, and contended today — keeps compiling
   * unchanged; it is mapped to a real translation key BELOW instead of being
   * rendered directly. See the build map's own documented fallback for this
   * exact situation.
   */
  label: 'Post' | 'Comment';
}) {
  /**
   * ★ SAME RACE, THE OK BUTTON (2026-08-12, F5 sweep). This was raw
   * `user.isLoggedIn`, which cannot answer during SSR and reports "signed out"
   * until `/api/users/me` returns — a real signed-in owner who opened this
   * dialog quickly could see no confirm button at all. Nothing else in this
   * file needs the raw client user object, so `useSessionIdentity` replaces
   * `useUserClient()` outright.
   */
  const identity = useSessionIdentity();
  const { t } = useTranslation('common_blog');
  const [open, setOpen] = useState(false);
  const titleKey =
    label === 'Comment' ? 'post_content.delete_dialog.title_comment' : 'post_content.delete_dialog.title_post';

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
      <AlertDialogContent className="flex flex-col gap-8 sm:rounded-r-xl ">
        <AlertDialogHeader className="gap-2">
          <div className="flex items-center justify-between">
            <AlertDialogTitle data-testid="flag-dialog-header">{t(titleKey)}</AlertDialogTitle>
            {/* ★ ACCESSIBLE NAME (O6 item 4, point 4) — this was a bare "X" text
                node with no `aria-label`/`sr-only`, so the accessibility tree
                reported an unnamed button. Same `<X/> + sr-only` pattern the
                shared dialog already uses (`packages/ui/components/dialog.tsx`). */}
            <AlertDialogCancel className="border-none hover:text-red-800" data-testid="flag-dialog-close">
              <X className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only">{t('global.close')}</span>
            </AlertDialogCancel>
          </div>
          <AlertDialogDescription data-testid="flag-dialog-description">
            {t('post_content.delete_dialog.confirm')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2 sm:flex-row-reverse">
          <AlertDialogCancel className="hover:text-red-800" data-testid="flag-dialog-cancel">
            {t('global.cancel')}
          </AlertDialogCancel>
          {identity.isLoggedIn ? (
            <AlertDialogAction
              autoFocus
              className="rounded-none bg-gray-800 text-base text-white shadow-lg shadow-red-600 hover:bg-red-600 hover:shadow-gray-800 disabled:bg-gray-400 disabled:shadow-none"
              data-testid="flag-dialog-ok"
              onClick={(e) => {
                e.preventDefault();
                action(permlink);
                setOpen(false);
              }}
            >
              {t('global.ok')}
            </AlertDialogAction>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
