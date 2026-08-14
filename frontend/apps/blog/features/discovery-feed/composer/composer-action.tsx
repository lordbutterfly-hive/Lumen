'use client';

import { ReactNode, forwardRef } from 'react';
import { cn } from '@ui/lib/utils';

/**
 * The icon-button shell for the short-form composer's toolbar (audit §9.2).
 *
 * ★★★ `onMouseDown` preventDefault IS THE LOAD-BEARING LINE, not styling.
 *
 * The composer collapses on blur (`onBlur: () => setFocused(false)`), and a
 * mousedown on any other element blurs the textarea BEFORE its click handler
 * runs. Without this the card would fold up the instant the reader pressed the
 * emoji button — the button would visually disappear mid-click. Preventing the
 * default on mousedown stops focus moving at all, so the caret, the selection
 * and the expanded card all survive the press.
 */
const ComposerAction = forwardRef<
  HTMLButtonElement,
  {
    label: string;
    onClick: () => void;
    children: ReactNode;
    disabled?: boolean;
    active?: boolean;
    testId?: string;
    ariaExpanded?: boolean;
  }
>(({ label, onClick, children, disabled, active, testId, ariaExpanded }, ref) => (
  <button
    ref={ref}
    type="button"
    aria-label={label}
    title={label}
    aria-expanded={ariaExpanded}
    disabled={disabled}
    onMouseDown={(event) => event.preventDefault()}
    onClick={onClick}
    data-testid={testId}
    className={cn(
      'inline-flex h-9 w-9 items-center justify-center rounded-full text-[#6b7280] transition-colors',
      'hover:bg-[#f1f3f5] hover:text-[#333]',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      'disabled:cursor-not-allowed disabled:opacity-40',
      active && 'bg-[#f1f3f5] text-[#333]'
    )}
  >
    {children}
  </button>
));

ComposerAction.displayName = 'ComposerAction';

export default ComposerAction;
