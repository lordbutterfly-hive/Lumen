/**
 * ★ THE .tsx EXTENSION ON A FILE WITH NO JSX IS LOAD-BEARING.
 *
 * Tailwind's content glob for this workspace is `**\/*.{jsx,tsx}` (see
 * packages/tailwindcss/tailwind.config.js) — `.ts` files are NOT scanned. Class
 * names that live only in a `.ts` module therefore never reach the generated
 * stylesheet, and the markup silently renders unstyled: this file was briefly a
 * `.ts`, and the sticky columns and min-widths below produced no CSS at all
 * while the JSX referencing them looked perfectly correct. Keep it `.tsx`.
 *
 * Shared grid-template-columns strings so the header row and every data
 * row line up exactly. `general` mirrors the design handoff's 8-column
 * layout (# / Witness / Votes / Last block / Miss / Price / APR / Vote).
 * `params` swaps the vote-weight columns for the witness's proposed chain
 * parameters (real per-witness data from `list_witnesses().props`).
 */
export const GENERAL_GRID_TEMPLATE = '32px minmax(0,1fr) 92px 100px 68px 92px 60px 76px';

/**
 * The width each layout needs before its columns start colliding, enforced
 * inside the table's own horizontal scroller.
 *
 * general: 32+92+100+68+92+60+76 = 520 fixed + 7 gaps x 12 = 84 + 28 row padding
 *          = 632, plus ~188 so the witness column can still show an avatar, a
 *          name and a version chip -> 820.
 * params:  32+128+116+136+92+76   = 580 + 6 gaps x 12 = 72 + 28 = 680, + 180 -> 860.
 *
 * `lg:min-w-0` hands the layout straight back to the grid at >=1024px, where the
 * page has never scrolled sideways and nothing about the desktop table changes.
 * Written as whole literal class strings because Tailwind's scanner only sees
 * literals, never a string it would have to concatenate.
 */
export const GENERAL_MIN_WIDTH_CLASS = 'min-w-[820px] lg:min-w-0';

/**
 * The two identifying cells (# and Witness) pin to the left edge while the
 * numeric columns scroll under them, so a Price or an APR can always be read
 * back to a name. `-mr-3` on the rank cell paints across the 12px grid gap so
 * the scrolling content does not show through the seam between the two. The
 * background matches the page (#f7f7f7, measured) and follows the row's hover
 * tint via the row's `group`. Both revert to normal flow at lg, where there is
 * no scroller to stick inside and the desktop table is left exactly as it was.
 */
export const STICKY_RANK_CLASS =
  'sticky left-0 z-10 -mr-3 flex items-center self-stretch bg-[#f7f7f7] group-hover:bg-[#faf9f6] lg:static lg:mr-0 lg:bg-transparent';
/** For the data rows, where `WitnessIdentityCell` supplies its own flex box. */
export const STICKY_IDENTITY_CLASS =
  'sticky left-[44px] z-10 self-stretch bg-[#f7f7f7] group-hover:bg-[#faf9f6] lg:static lg:bg-transparent';
/** Same pin for the header row, which has a bare label rather than the cell. */
export const STICKY_IDENTITY_HEADER_CLASS =
  'sticky left-[44px] z-10 flex min-w-0 items-center self-stretch bg-[#f7f7f7] lg:static lg:bg-transparent';
