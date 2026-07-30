'use client';

import { FC, ReactNode } from 'react';
import { Dialog, DialogContentBare, DialogDescription, DialogTitle } from '@ui/components/dialog';
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
      overlayClassName="bg-[rgba(20,18,10,0.4)] backdrop-blur-[2px]"
      wrapperClassName="p-5 py-12"
      style={{ width }}
      className={cn(
        'max-w-full rounded-[20px] bg-white shadow-[0_20px_60px_rgba(20,18,10,0.25)] focus:outline-none',
        className
      )}
    >
      <DialogTitle className="sr-only">{title}</DialogTitle>
      <DialogDescription className="sr-only">{title}</DialogDescription>
      {children}
    </DialogContentBare>
  </Dialog>
);

export default ModalShell;
