'use client';

import { useState } from 'react';
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
import { buttonVariants } from '@ui/components/button';
import { Input } from '@ui/components/input';
import { CircleSpinner } from 'react-spinners-kit';
import { useTranslation } from '@/blog/i18n/client';

const CONFIRM_WORD = 'RESET';

/**
 * ★★★ THE NUKE-EVERYTHING BUTTON, GATED (F9, 2026-08-11, buildmap item 14 / O5).
 *
 * `list-area.tsx` used to render this as a bare `<Button>` with NO `variant`
 * prop — the DEFAULT variant, `bg-primary` solid — sitting in the same row as
 * the per-list "Reset [Blacklist/Muted/...]" button, which uses `outlineRed`
 * (an outline). So the action that clears all four moderation lists in one
 * on-chain broadcast (blacklist, muted, followed blacklists, followed muted —
 * see `useResetAllListsMutation`) carried the STRONGEST visual weight on the
 * page, immediately next to the weaker single-list reset, and fired on a
 * single click with no confirmation at all.
 *
 * Two changes, both required by the finding (not just one):
 *   1. De-emphasised: this trigger is a small muted text link, not a button —
 *      strictly less visually prominent than the outline single-list reset
 *      next to it, so the eye lands on the safer control first.
 *   2. Hard to hit by accident: a click opens a confirmation dialog whose
 *      real action button stays disabled until the reader types the literal
 *      word RESET. An "Are you sure?" dialog alone is not enough — those get
 *      dismissed on muscle memory as fast as the click that opened them; a
 *      typed word forces a deliberate, readable pause.
 */
export default function ResetAllListsDialog({
  onConfirm,
  isPending,
  disabled
}: {
  onConfirm: () => void;
  isPending: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation('common_blog');
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const matches = typed.trim().toUpperCase() === CONFIRM_WORD;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setTyped('');
      }}
    >
      <AlertDialogTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          data-testid="reset-all-lists-trigger"
          className="font-sans text-xs font-medium text-primary/50 underline-offset-2 transition-colors hover:text-destructive hover:underline disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('reset_all_lists_dialog.trigger')}
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent className="flex flex-col gap-4 sm:max-w-md" data-testid="reset-all-lists-dialog">
        <AlertDialogHeader className="gap-2">
          <AlertDialogTitle>{t('reset_all_lists_dialog.title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('reset_all_lists_dialog.description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="reset-all-lists-confirm-input" className="text-xs text-primary/60">
            {t('reset_all_lists_dialog.type_to_confirm')}
          </label>
          <Input
            id="reset-all-lists-confirm-input"
            data-testid="reset-all-lists-confirm-input"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={t('reset_all_lists_dialog.confirm_placeholder')}
          />
        </div>
        <AlertDialogFooter className="gap-2 sm:flex-row-reverse">
          <AlertDialogAction
            disabled={!matches || isPending}
            data-testid="reset-all-lists-confirm"
            className={buttonVariants({ variant: 'destructive' })}
            onClick={(e) => {
              e.preventDefault();
              if (!matches) return;
              onConfirm();
              setOpen(false);
            }}
          >
            {isPending ? <CircleSpinner loading size={16} color="#fff" /> : t('reset_all_lists_dialog.action')}
          </AlertDialogAction>
          <AlertDialogCancel data-testid="reset-all-lists-cancel">
            {t('reset_all_lists_dialog.cancel')}
          </AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
