'use client';

import { FC, KeyboardEvent, PointerEvent, ReactNode } from 'react';

/**
 * The four controls the launch panels share.
 *
 * One button system, not a second one bolted beside the app's. Every colour is
 * a `meritum-*` utility picked by CSS property — brand as a FILL on the primary
 * action, brand as INK on an alert, brand as a LINE on its border. Those are
 * three different values of the same red on purpose.
 */

const PRIMARY =
  'inline-flex h-[50px] items-center gap-[11px] rounded-xl bg-meritum-surface-brand px-7 text-15 font-bold ' +
  'text-meritum-ink-on-brand transition-colors hover:bg-meritum-surface-brand-hover ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

const SECONDARY =
  'inline-flex h-[50px] items-center rounded-xl border border-meritum-line-input bg-meritum-card px-[26px] ' +
  'text-15 font-bold text-meritum-ink-3 transition-colors hover:text-meritum-ink';

/** The forward arrow on the two Continue actions. Inline, so no image request. */
const Arrow: FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
    <path
      d="M4 12h15M13 6l6 6-6 6"
      stroke="currentColor"
      strokeWidth="2.1"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const PrimaryAction: FC<{
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  withArrow?: boolean;
}> = ({ label, onClick, disabled = false, title, withArrow = true }) => (
  <button type="button" onClick={onClick} disabled={disabled} title={title} className={PRIMARY}>
    {label}
    {withArrow ? <Arrow /> : null}
  </button>
);

export const BackAction: FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="border-0 bg-transparent text-13 font-semibold text-meritum-ink-muted transition-colors hover:text-meritum-ink"
  >
    {label}
  </button>
);

export const SecondaryLink: FC<{ href: string; label: string }> = ({ href, label }) => (
  <a href={href} className={SECONDARY}>
    {label}
  </a>
);

export const PrimaryLink: FC<{ href: string; label: string }> = ({ href, label }) => (
  <a href={href} className={PRIMARY}>
    {label}
  </a>
);

/**
 * A SECOND PRESS TARGET FOR THE SAME STRIKE.
 *
 * ★ It does not own a hold. It drives the coin's machine through the handle
 * the coin exposes (`begin` / `abort`), so there is exactly one charge timer,
 * one height lock and one ring on the page however the reader chooses to press.
 * Two independent hold state machines racing each other is the bug this avoids.
 */
export const HoldAction: FC<{
  label: string;
  disabled: boolean;
  title?: string;
  onBegin: () => void;
  onRelease: () => void;
}> = ({ label, disabled, title, onBegin, onRelease }) => {
  const press = (e: PointerEvent<HTMLButtonElement>): void => {
    if (e.button === 0) onBegin();
  };
  const keyPress = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      // Space would scroll the page out from under the coin mid-hold.
      e.preventDefault();
      onBegin();
    }
  };
  const keyRelease = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') onRelease();
  };
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      className={`${PRIMARY} touch-none select-none`}
      onPointerDown={press}
      onPointerUp={onRelease}
      onPointerLeave={onRelease}
      onPointerCancel={onRelease}
      onKeyDown={keyPress}
      onKeyUp={keyRelease}
      onBlur={onRelease}
    >
      {label}
    </button>
  );
};

/**
 * The one message block on these screens. `alert` is the only variant that
 * borrows the accent, and only ever for something that went wrong or that
 * stops the reader launching.
 */
export const Notice: FC<{ tone?: 'info' | 'alert'; children: ReactNode }> = ({ tone = 'info', children }) => (
  <div
    className={`mt-5 rounded-xl border px-4 py-3.5 text-14 ${
      tone === 'alert'
        ? 'border-meritum-line-brand bg-meritum-rail font-semibold text-meritum-ink-brand'
        : 'border-meritum-line-card bg-meritum-rail text-meritum-ink-3'
    }`}
  >
    {children}
  </div>
);
