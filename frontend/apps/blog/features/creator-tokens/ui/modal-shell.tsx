'use client';

import { FC, ReactNode } from 'react';
import { Dialog, DialogContentBare, DialogTitle } from '@ui/components/dialog';
import { cn } from '@ui/lib/utils';

/**
 * Shared shell for every creator-tokens money modal (Buy/Sell/Redeem/Ask/Send/
 * interstitial/Answer/Retire). Same visual design as before (dimmed+blurred
 * backdrop, centered white rounded-20 box) but now backed by the real Radix
 * `Dialog` primitives — the same ones `WalletDialogShell`
 * (features/wallet/components/dialogs/shared/wallet-dialog-shell.tsx) already
 * gets `role="dialog"`, `aria-modal`, a focus trap, Escape-to-close, outside-
 * click-to-close, and focus return from — instead of a hand-rolled `<div>`
 * with a manual backdrop `onClick`.
 *
 * Deliberately does NOT render its own close (×) control: the four callers
 * that had one (via `ModalHead`) keep rendering it themselves, unchanged —
 * its existing `onClick={onClose}` already closes the dialog exactly as
 * before, no rewiring needed. The three callers that never had one
 * (AnswerModal/RetireModal use Cancel/Decline buttons; InterstitialModal has
 * neither) stay exactly as they were too. Adding a shell-level × would put a
 * second close control on four of the seven and a brand-new one on the other
 * three — a real visual change, not the accessibility fix this exists for.
 *
 * `DialogContentBare` (packages/ui/components/dialog.tsx) is the same
 * `DialogContent` machinery without its opinionated default chrome, so this
 * shell can keep pixel-identical visuals while gaining real dialog behavior.
 * `title` is the accessible name only — visually hidden (`sr-only`), because
 * every caller already renders its own visible heading as part of `children`
 * exactly as before; this never duplicates or restyles that heading.
 */
export interface ModalShellProps {
  width: number;
  onClose: () => void;
  title: string;
  className?: string;
  children: ReactNode;
}

const ModalShell: FC<ModalShellProps> = ({ width, onClose, title, className, children }) => (
  <Dialog
    open
    onOpenChange={(next) => {
      if (!next) onClose();
    }}
  >
    <DialogContentBare
      aria-describedby={undefined}
      /* ★★ THE SCRIM HAS TO WORK ON A DARK PAGE TOO (owner, 2026-09-18: the
         interstitial "slips and looks weird, has no outline. moves on top of
         page"). 40% of a warm near-black over cream reads as "the page has
         stepped back"; the same 40% over #0e0f11 changes almost nothing, so the
         dialog appeared to float with the page still fully present behind it.
         Deeper in dark only — light keeps the value it has always had. */
      overlayClassName="bg-[rgba(20,18,10,0.4)] backdrop-blur-[2px] dark:bg-[rgba(4,5,7,0.72)]"
      wrapperClassName="p-5 py-12"
      style={{ width }}
      className={cn(
        // ★★★ THE DIALOG ITSELF SCROLLS (owner, 2026-09-15, screenshot 2407:
        // "clips the bottom of the page cant scroll to buy. HUUUUUGE PROBLEM").
        // The wrapper around this content is `overflow-y-auto`, but Radix's
        // Dialog wraps the CONTENT in react-remove-scroll, which swallows wheel
        // and touch scrolling on anything outside the content node — the
        // wrapper included. So a Buy dialog taller than the viewport (the
        // "Add HBD to Magi" notice plus the fee note plus the submit button)
        // could never be scrolled to its button. Bounding the content to the
        // viewport (minus the wrapper's 3rem top and bottom padding) and letting
        // it scroll internally keeps every button reachable on every screen.
        /* ★★ AN EDGE, BECAUSE THE SHADOW STOPPED BEING ONE. The separation here is
           carried entirely by `shadow-[0_20px_60px_rgba(20,18,10,0.25)]`: a warm
           black at 25%, which against cream is a soft lift and against #0e0f11 is
           nothing at all. With `bg-surface-1` also being every card's colour, the
           dialog had no edge of any kind in dark. A `ring` rather than a `border`
           on purpose: it paints outside the box, so the panel's size, padding and
           the `max-h` scroll behaviour are byte-identical. */
        'max-h-[calc(100dvh-6rem)] max-w-full overflow-y-auto overscroll-contain rounded-panel bg-surface-1 shadow-[0_20px_60px_rgba(20,18,10,0.25)] focus:outline-none',
        'dark:shadow-[0_24px_70px_rgba(0,0,0,0.75)] dark:ring-1 dark:ring-[var(--line-strong)]',
        className
      )}
    >
      {/* Minor: only DialogTitle. The DialogDescription duplicated the title
          verbatim, so a screen reader announced the same string as both the dialog's
          name and its description (plus the visible ModalHead). aria-describedby is
          set undefined so Radix does not warn about the missing description. */}
      <DialogTitle className="sr-only">{title}</DialogTitle>
      {children}
    </DialogContentBare>
  </Dialog>
);

export default ModalShell;
