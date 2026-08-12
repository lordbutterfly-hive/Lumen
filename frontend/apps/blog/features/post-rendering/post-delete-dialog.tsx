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
  label: string;
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
  const [open, setOpen] = useState(false);

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
      <AlertDialogContent className="flex flex-col gap-8 sm:rounded-r-xl ">
        <AlertDialogHeader className="gap-2">
          <div className="flex items-center justify-between">
            <AlertDialogTitle data-testid="flag-dialog-header">{`Confirm Delete ${label}`}</AlertDialogTitle>
            <AlertDialogCancel className="border-none hover:text-red-800" data-testid="flag-dialog-close">
              X
            </AlertDialogCancel>
          </div>
          <AlertDialogDescription data-testid="flag-dialog-description">Are you sure?</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2 sm:flex-row-reverse">
          <AlertDialogCancel className="hover:text-red-800" data-testid="flag-dialog-cancel">
            Cancel
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
              OK
            </AlertDialogAction>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
