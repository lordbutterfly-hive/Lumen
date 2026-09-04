'use client';

import { ComponentType, MouseEvent, ReactElement, ReactNode, cloneElement, isValidElement, useState } from 'react';
import dynamic from 'next/dynamic';
import { CircleSpinner } from 'react-spinners-kit';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { Dialog, DialogContent, DialogTitle } from '@ui/components/dialog';

/**
 * ★★★ DEFERS ONE WALLET DIALOG'S WHOLE MODULE UNTIL ITS TRIGGER IS CLICKED
 * (T3g, 2026-09-04, wallet deep-dive item 7: 135.5KB wallet-unique JS —
 * react-hook-form + zod + a mutation hook per dialog — statically bundled
 * into every `/wallet` visit for actions most visits never take).
 *
 * The same technique `components/dialog-login.tsx` shipped the same day for
 * the sign-in stack, adapted to this codebase's wallet-dialog shape. There
 * the trigger and the heavy content are already two components (Radix mounts
 * `DialogContent` only once open, so the content nested inside it naturally
 * loads on open). Every wallet dialog is ONE component that owns its own
 * trigger AND its `useForm()` call, so deferring the module means deferring
 * the component's first MOUNT, not just what is nested inside it — which
 * means the click that asks for the module must ALSO be the click that
 * opens the dialog once it lands, or the reader would have to click twice.
 * That is what `defaultOpen` (`use-wallet-dialog.ts`,
 * `claim-account-dialog.tsx`, `stop-power-down-alert.tsx`) is for.
 *
 * Renders ONLY the trigger, completely unchanged (same element, classes,
 * `data-testid`), until clicked. On click: keeps the SAME trigger on screen
 * while the chunk loads — a lazy-loading spinner is standard, and a modal
 * cannot open the instant a `<button>` is clicked. Once the module lands,
 * the real dialog mounts already `open`.
 */
export function lazyWalletDialog<P extends { trigger: ReactNode; defaultOpen?: boolean }>(
  loader: () => Promise<{ default: ComponentType<P> }>
) {
  const LazyDialog = dynamic(loader, {
    ssr: false,
    loading: () => (
      <Dialog open>
        <DialogContent className="rounded-panel font-ui sm:max-w-[440px]">
          <VisuallyHidden>
            <DialogTitle>Loading</DialogTitle>
          </VisuallyHidden>
          <div className="flex min-h-[220px] items-center justify-center" role="status">
            <CircleSpinner loading size={24} />
          </div>
        </DialogContent>
      </Dialog>
    )
    // Typed to the exact props this wrapper passes (the trigger-owner props plus
    // an optional defaultOpen) rather than the bare P: it is structurally the same
    // as P for the constrained shape, but lets `<LazyDialog {...props} defaultOpen/>`
    // below type-check, since TS cannot prove `Omit<P,'defaultOpen'> & {defaultOpen}`
    // reconstructs P for an arbitrary P.
  }) as ComponentType<Omit<P, 'defaultOpen'> & { defaultOpen?: boolean }>;

  return function LazyWalletDialogTrigger(props: Omit<P, 'defaultOpen'>) {
    const [requested, setRequested] = useState(false);

    if (!requested) {
      const { trigger } = props;
      if (!isValidElement(trigger)) return <>{trigger ?? null}</>;
      const el = trigger as ReactElement<{ onClick?: (e: MouseEvent<HTMLElement>) => void }>;
      return cloneElement(el, {
        onClick: (e: MouseEvent<HTMLElement>) => {
          el.props.onClick?.(e);
          setRequested(true);
        }
      });
    }

    return <LazyDialog {...props} defaultOpen />;
  };
}
