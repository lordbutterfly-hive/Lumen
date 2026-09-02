'use client';

import clsx from 'clsx';
import { Icons } from '@ui/components/icons';

/**
 * ★★★ THE DRAFT SAVE THAT NOBODY COULD SEE (owner, 2026-09-02).
 *
 * The composer and the reply box have BOTH auto-saved to localStorage every
 * 500 ms for weeks (use-post-form-actions.ts, reply-textbox.tsx), and the submit
 * masthead even promises "Saved as you type". But no pixel ever confirmed a save
 * had landed, so the owner read the silence as "the posting area lacks a draft
 * save. If people write, stop writing, they lose the post." The auto-save was
 * real; its ONLY defect was being invisible.
 *
 * This is the small, live cue PeakD shows and Lumen did not: "Saving…" while a
 * write is in flight, "Draft saved" once the on-screen content matches what is
 * in storage. It is deliberately quiet — muted caption text, no colour, no
 * toast — because a save succeeding is the expected case and must not compete
 * with the writing. The red "not being saved" banner (post-form.tsx /
 * reply-textbox.tsx) still owns the FAILURE case; when it is showing, the caller
 * passes `status="idle"` so the two never contradict each other.
 *
 * `role="status"` + `aria-live="polite"` so a screen reader hears the change on
 * its own turn instead of being interrupted mid-word. Status is DERIVED by the
 * caller from live form state vs the reactive storage value, never a timer, so
 * it cannot claim "saved" about a write that did not happen.
 */
export type DraftStatus = 'idle' | 'saving' | 'saved';

export function DraftStatusIndicator({
  status,
  savingLabel,
  savedLabel,
  className
}: {
  status: DraftStatus;
  savingLabel: string;
  savedLabel: string;
  className?: string;
}) {
  if (status === 'idle') return null;

  const saving = status === 'saving';

  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="draft-status"
      data-status={status}
      className={clsx('flex items-center gap-1.5 text-caption text-muted-foreground', className)}
    >
      {saving ? (
        // A quiet pulsing dot, not a spinner: a spinner reads as "working, wait
        // for me", and saving a draft is neither blocking nor something the
        // writer waits on.
        <span
          aria-hidden
          className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-muted-foreground/50"
        />
      ) : (
        <Icons.check aria-hidden className="h-3.5 w-3.5 shrink-0" />
      )}
      <span>{saving ? savingLabel : savedLabel}</span>
    </span>
  );
}
