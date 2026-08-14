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
 * ★★★ THIS USED TO SAY `lg:min-w-0` — WRONG, and it produced a ZERO-WIDTH witness
 * column at 1280x720 and 1366x768 (2026-08-11, found by un-skipping the witnesses
 * Playwright spec; see `witnessesPage.spec.ts`). The false assumption, in the
 * word this comment used to say out loud: "nothing about the desktop table
 * changes" at >=1024px. Something does — `witnesses-shell.tsx`'s page grid adds a
 * 312px right rail at `xl` (1280px), and that rail is what actually determines
 * how much width this table's own `minmax(0,1fr)` witness track gets, not this
 * file in isolation. Doing the shell's arithmetic (max-w-1720, 44px gutters, two
 * 44px gaps once the rail is present, 200px left rail, 312px right rail): the
 * main column is `vw - 332` from `lg` up to just under `xl`, then CLIFFS to
 * `vw - 688` the instant the rail appears at `xl` — at vw=1280 that is 592px,
 * 40px short of this table's hard 632px floor before you even get to the 820px
 * target, so `minmax(0,1fr)` legally resolved to 0. `lg` released this floor
 * 256px of viewport before the rail even showed up. Measured (real browser, this
 * file's pre-fix code): 1024->60px, 1279->315px, 1280->0px, 1300->0px,
 * 1320->0px, 1366->46px, 1440->120px, all still short of 820.
 *
 * The floor now releases at `2xl` (1536px) — the first standard Tailwind stop at
 * or above the ~1508px where `vw - 688 >= 820` actually holds (1536 - 688 = 848,
 * a 28px margin). Below `2xl`, including the 1024-1279 band that never had a real
 * 820px guarantee either (there `vw - 332` ranges 692-947px, i.e. it was already
 * brushing the target with no scroller to fall back on), the table stays inside
 * its own horizontal scroller instead of trusting the grid to have room. The
 * scroller's own release (`witnesses-table.tsx`) and the three STICKY_* classes
 * below MUST move with this constant — they all describe the same one boundary,
 * "the shell has proven it has room", and drifting them apart reintroduces this
 * exact bug.
 *
 * Written as whole literal class strings because Tailwind's scanner only sees
 * literals, never a string it would have to concatenate.
 */
export const GENERAL_MIN_WIDTH_CLASS = 'min-w-[820px] 2xl:min-w-0';

/**
 * The two identifying cells (# and Witness) pin to the left edge while the
 * numeric columns scroll under them, so a Price or an APR can always be read
 * back to a name. `-mr-3` on the rank cell paints across the 12px grid gap so
 * the scrolling content does not show through the seam between the two. The
 * background matches the page (#f7f7f7, measured) and follows the row's hover
 * tint via the row's `group`. Both revert to normal flow at `2xl`, matching
 * `GENERAL_MIN_WIDTH_CLASS` and the scroller release in `witnesses-table.tsx` —
 * that is the one breakpoint where the shell has proven it has room and there is
 * no scroller left to stick inside. Releasing this at a narrower breakpoint than
 * the floor/scroller (it used to be `lg`, 1024px) would un-pin these cells while
 * the table is still horizontally scrolling, so a scrolled-right reader loses the
 * name they were trying to read back to — same bug family as the 2026-08-11
 * zero-width defect, just a readability regression instead of a collapse.
 */
export const STICKY_RANK_CLASS =
  'sticky left-0 z-10 -mr-3 flex items-center self-stretch bg-surface-15 group-hover:bg-surface-12 2xl:static 2xl:mr-0 2xl:bg-transparent';
/** For the data rows, where `WitnessIdentityCell` supplies its own flex box. */
export const STICKY_IDENTITY_CLASS =
  'sticky left-[44px] z-10 self-stretch bg-surface-15 group-hover:bg-surface-12 2xl:static 2xl:bg-transparent';
/** Same pin for the header row, which has a bare label rather than the cell. */
export const STICKY_IDENTITY_HEADER_CLASS =
  'sticky left-[44px] z-10 flex min-w-0 items-center self-stretch bg-surface-15 2xl:static 2xl:bg-transparent';
