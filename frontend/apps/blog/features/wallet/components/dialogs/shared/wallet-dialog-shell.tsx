'use client';

import { ReactNode, useRef, useState } from 'react';
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
import { handleError } from '@ui/lib/handle-error';

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
  onSubmit: () => void | Promise<unknown>;
  submitLabel: string;
  cancelLabel: string;
  isSubmitting: boolean;
  submitDisabled?: boolean;
  children: ReactNode;
}) {
  /**
   * ★★★ ONE SUBMIT AT A TIME — TWO CLICKS USED TO BE TWO TRANSFERS
   * (2026-08-13, A1 review W-1). This is the only guard on this form that can
   * move real funds twice, so it is deliberately NOT a rendering guard.
   *
   * Every dialog's `onSubmit` is `form.handleSubmit(...)`, and react-hook-form
   * 7.54.2 has no re-entrancy check of its own: `handleSubmit` sets
   * `isSubmitting: true` and then `await`s the resolver
   * (`index.esm.mjs:2272-2306`), so each call runs the whole pipeline
   * independently. For Send/Delegate/Recurring that resolver is a NETWORK
   * ROUND TRIP (`recipient-schema.ts`), so the gap between click and broadcast
   * is hundreds of milliseconds, not microseconds.
   *
   * `disabled={isSubmitting}` on the button below does NOT close that gap on
   * its own. Measured against this exact file under real React 18 scheduling
   * (jsdom harness, real RHF + real async zod resolver):
   *
   *   as shipped                       2 clicks -> 2 BROADCASTS (every case)
   *   disabled={formState.isSubmitting} 2 clicks in one task  -> 2 BROADCASTS
   *                                     3 clicks in one task  -> 3 BROADCASTS
   *                                     submit not from the button -> 2 BROADCASTS
   *                                     (only a slow, two-macrotask double
   *                                     click was actually stopped)
   *
   * React 18 flushes even a discrete-event re-render on a MICROTASK, so any
   * two submits that reach this handler inside a single task see a button that
   * has not yet been repainted as disabled — and a `submit` event that does
   * not come from the button (`requestSubmit()`, implicit submission) never
   * consults the button's `disabled` at all.
   *
   * So the guard is a ref, checked and set SYNCHRONOUSLY before anything is
   * awaited: a second submit cannot get past it no matter what React has or
   * has not rendered. The button's `disabled` state stays as well, but as
   * feedback (spinner) rather than as the safety mechanism.
   *
   * ★ Why the shell owns `inFlight` instead of the dialogs passing
   * `form.formState.isSubmitting`. That was the obvious one-line version and
   * it is a TRAP on this exact form: react-hook-form only pushes
   * `isSubmitting: false` AFTER `await _executeSchema()` returns
   * (`index.esm.mjs:2314-2320`), so when the RESOLVER ITSELF throws — the
   * Hive-node outage / CORS case `recipient-schema.ts` is written around —
   * that push is never reached and `formState.isSubmitting` stays true for
   * the life of the form. Measured: the Submit button never re-enabled, so a
   * transient node failure locked the user out of retrying until they closed
   * and reopened the dialog. State owned by the same `try/finally` that owns
   * the ref cannot desynchronise from it, on any path.
   */
  const submitInFlightRef = useRef(false);
  const [inFlight, setInFlight] = useState(false);

  const runSubmit = async () => {
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setInFlight(true);
    try {
      /* ★ NET FOR ANY RESOLVER CRASH (map item 2, layer c). `handleSubmit`
         calls `_executeSchema()` with NO try/catch around it
         (react-hook-form 7.54.2, index.esm.mjs:2287-2291) — only the
         `onValid` callback is wrapped. If the resolver itself throws (e.g. a
         non-ZodError rejection from an async refine that has no try/catch of
         its own), that throw used to escape as an unhandled promise rejection
         and the dialog did nothing at all: no toast, no inline error, no
         spinner. This catch is additive — it only fires on a crash that would
         otherwise be silent — so it cannot change any currently working,
         currently passing submit path. */
      await onSubmit();
    } catch (error) {
      handleError(error, { method: 'walletDialogSubmit', params: {} });
    } finally {
      // `finally`, not the end of `try`: a rejected OR a synchronously
      // throwing `onSubmit` must still release the form, or a single failed
      // attempt would brick the dialog until the page is reloaded.
      submitInFlightRef.current = false;
      setInFlight(false);
    }
  };

  const busy = inFlight || isSubmitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="rounded-panel font-sans sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="text-left text-xl text-ink-2">{title}</DialogTitle>
          {description ? (
            <DialogDescription className="text-left text-ink-10">{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void runSubmit();
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
              disabled={busy || submitDisabled}
              className={cn('rounded-control bg-surface-ok-7 text-ink-27 hover:bg-surface-ok-9')}
            >
              {busy ? <CircleSpinner loading size={16} color="#fff" /> : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
