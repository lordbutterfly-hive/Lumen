/**
 * ★ ONE PLACE FOR THE FOLLOW-LIST SURFACE TOKENS (2026-08-13, followers/following
 * redesign).
 *
 * Scoped DELIBERATELY to the two routes `/@user/followers` and
 * `/@user/following`. These are hex literals rather than Tailwind theme colours
 * for the same reason `right-rail.tsx` and `account-settings/lib/card.ts` use
 * hex literals: the warm Lumen surface palette (`#ffffff` / `#fbf7f2`,
 * hairlines `#ebebeb` / `#eee2dc`) is not the same palette as the legacy
 * `bg-background-*` theme tokens, and it was exactly those legacy tokens that
 * put a cool slate zebra (`bg-background-tertiary` -> rgb(225,231,239)) and a
 * slate pagination button (`outlineRed` -> `text-slate-600`, rgb(71,85,105)) on
 * these two pages while every other surface in the app was warm.
 *
 * Every radius here is 10, 12 or 18px. The 6px `rounded-md` that the shared
 * `<Button>`/`<Input>` primitives carry is the reason those primitives are NOT
 * used on this surface.
 *
 * ★ THE ACCENT RED IS THE ONE EXCEPTION (2026-08-14 token-migration pass).
 * `page-masthead.tsx` is no longer a hex-literal precedent — it already draws
 * its own accent rule from `border-l-line-brand-10`. The old `#c0392b` here was
 * that same value hardcoded, so the accent below now reads `surface-brand-12` /
 * `ink-brand-6` / `line-brand-10` (fill / ink / line, per `tailwind.config.js`'s
 * own role split), which is byte-identical in light mode and gains the
 * dark-mode lift the literal never had. Everything else on this file stays a
 * literal per the paragraph above — only the red was ever wrong.
 */

/** The list card: one surface, hairline border, corners clip the first/last row. */
export const LIST_CARD = 'w-full overflow-hidden rounded-[18px] border border-[#ebebeb] bg-white';

/** A 60px identity row with a 1px divider; the last row drops its divider. */
export const LIST_ROW =
  'flex h-[60px] items-center gap-3 border-b border-[#ebebeb] bg-white px-4 py-[10px] transition-colors last:border-b-0';

/** Row hover — separate so the skeleton can reuse LIST_ROW without a hover state. */
export const LIST_ROW_HOVER = 'hover:bg-[#faf9f8]';

/** Follow (not yet following): the one accent-red control in the row. */
export const FOLLOW_BUTTON_PRIMARY =
  'inline-flex h-9 shrink-0 items-center justify-center rounded-[12px] bg-surface-brand-12 px-4 font-sans text-[13px] leading-[20px] font-semibold text-white transition-colors hover:bg-[#a93226] disabled:pointer-events-none disabled:opacity-60';

/** Following (already following): quiet outline that turns red on hover. */
export const FOLLOW_BUTTON_OUTLINE =
  'group inline-flex h-9 shrink-0 items-center justify-center rounded-[12px] border border-[#e4e6e9] bg-transparent px-4 font-sans text-[13px] leading-[20px] font-semibold text-[#3f4650] transition-colors hover:border-line-brand-10 hover:text-ink-brand-6 disabled:pointer-events-none disabled:opacity-60';

/** The `...` trigger. 32x32, radius 10 — never a bare destructive sibling. */
export const OVERFLOW_BUTTON =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-[#9ca3af] transition-colors hover:bg-[#f4f5f7] hover:text-[#3f4650] disabled:pointer-events-none disabled:opacity-60';

/** Pagination buttons, rendered ONCE below the list. */
export const PAGER_BUTTON =
  'inline-flex h-9 items-center justify-center rounded-[12px] border border-[#e4e6e9] bg-white px-4 font-sans text-[13px] leading-[20px] font-semibold text-[#3f4650] transition-colors hover:border-line-brand-10 hover:text-ink-brand-6 disabled:pointer-events-none disabled:border-[#f0f0f0] disabled:text-[#c7cbd1]';

/** The toolbar search field. */
export const SEARCH_INPUT =
  'h-9 w-full rounded-[12px] border border-[#ebebeb] bg-white pl-9 pr-3 font-sans text-[13px] leading-[20px] text-[#161511] outline-none transition-colors placeholder:text-[#9ca3af] focus:border-line-brand-10';

/** Muted meta text: the toolbar count, the pager label, empty-state body copy. */
export const META_TEXT = 'font-sans text-[13px] leading-[20px] font-medium text-[#6b7280]';

/** Empty / no-results headline. */
export const EMPTY_TITLE = 'font-sans text-[15px] leading-[24px] font-semibold text-[#161511]';

/** Skeleton block fill — the same neutral `UserAvatarImg` uses for its monogram box. */
export const SKELETON_FILL = 'animate-pulse bg-[#f1f3f5]';

/** How many rows one page of the chain list holds. */
export const FOLLOW_LIST_PAGE_SIZE = 50;
