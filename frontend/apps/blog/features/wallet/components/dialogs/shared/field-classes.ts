/**
 * The wallet's one set of field and action classes (design standard, 2026-09-09,
 * owner-approved: /mnt/o/LUMEN-DOCS/WALLET-DESIGN-STANDARD-2026-09-09.md §2).
 *
 * Three action tiers and only three. The success green
 * (`bg-surface-ok-7`) that every dialog submit used to carry goes back to
 * meaning "this succeeded" (toasts, chips) and never "click here".
 */

/** Primary: the thing that moves money. Send pills, Deposit, every dialog submit. */
export const PRIMARY_BUTTON_CLASS =
  'rounded-card bg-surface-brand-12 px-[18px] py-2.5 text-[14px] leading-[22px] font-medium text-ink-27 transition-colors hover:bg-surface-brand-17 disabled:cursor-not-allowed disabled:opacity-50';

/** Secondary: Withdraw, stake, unstake, savings deposit/withdraw, stop. */
export const SECONDARY_BUTTON_CLASS =
  'lm-press rounded-card border border-line-11 bg-surface-1 px-4 py-2.5 text-[14px] leading-[22px] font-medium text-ink-7 transition-colors hover:bg-surface-16 disabled:cursor-not-allowed disabled:opacity-50';

/** Secondary, compact: inline beside a figure (the staked block's controls). */
export const SECONDARY_BUTTON_SMALL_CLASS =
  'lm-press shrink-0 rounded-card border border-line-11 bg-surface-1 px-3 py-1.5 text-caption font-medium text-ink-7 transition-colors hover:bg-surface-16 disabled:cursor-not-allowed disabled:opacity-50';

/**
 * One input. Passed as `className` to `@ui/components/input`, whose base
 * classes it overrides through tailwind-merge (radius, border, ring). Amount
 * fields add `font-num`, address fields add `font-mono`.
 */
export const INPUT_CLASS =
  'h-10 w-full rounded-control border border-line-11 bg-surface-1 px-3 text-[14px] font-ui text-ink-2 placeholder:text-ink-14 focus-visible:border-line-brand-10 focus-visible:ring-0 focus-visible:ring-offset-0';

export const LABEL_CLASS = 'text-caption font-medium font-ui text-ink-7';
