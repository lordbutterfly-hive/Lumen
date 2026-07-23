'use client';

import { ReactNode } from 'react';
import { CircleSpinner } from 'react-spinners-kit';
import { Button } from '@ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@ui/components/dialog';
import { cn } from '@ui/lib/utils';

/**
 * Shared shell for every wallet action dialog: trigger, title/description,
 * form body (children), and a Cancel/Submit footer. Keeps every dialog's
 * chrome consistent without pulling the whole form/validation/mutation logic
 * (which differs per action) into a shared, harder-to-follow component.
 */
export default function WalletDialogShell({
  trigger,
  title,
  description,
  open,
  onOpenChange,
  onSubmit,
  submitLabel,
  cancelLabel,
  isSubmitting,
  submitDisabled,
  children
}: {
  trigger: ReactNode;
  title: string;
  description?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void;
  submitLabel: string;
  cancelLabel: string;
  isSubmitting: boolean;
  submitDisabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="rounded-[18px] font-sans sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="text-left text-xl text-[#161511]">{title}</DialogTitle>
          {description ? (
            <DialogDescription className="text-left text-[#6b7280]">{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
          className="flex flex-col gap-4"
        >
          {children}
          <DialogFooter className="mt-2 flex-row items-center justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {cancelLabel}
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting || submitDisabled}
              className={cn('rounded-[10px] bg-[#2f7d4f] text-white hover:bg-[#256640]')}
            >
              {isSubmitting ? <CircleSpinner loading size={16} color="#fff" /> : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
