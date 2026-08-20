/**
 * Shared Tailwind CSS classes for post content layout.
 * Used in content.tsx and comments-section.tsx for consistent responsive widths.
 */

/** Base responsive width classes for post content containers */
export const postContentWidthClasses = 'w-full max-w-4xl';

/**
 * Post content container with background and padding.
 *
 * ★★ THE ARTICLE IS A CARD SURFACE, AND IT WAS THE ONE THE BACKLIGHT MISSED
 * (2026-08-20, illumination SPEC.md §3/§5). §5 calls this out by name — "the
 * single post page ... is the surface most likely to be missed because it has
 * one card instead of a feed" — and it was: the ambient ground reached this page
 * for free (it is painted on `body`), but the article kept Tailwind's default
 * `shadow-md`, which is a GREY drop (rgba(0,0,0,.1)) while every feed card had
 * moved to the warm one. Measured before this change: feed card
 * `rgba(70,46,30,.13)`, article `rgba(0,0,0,.1)` — two different lights on two
 * views of the same content.
 *
 * The values are §3's card shadow verbatim. `26 22 18` for the tight layer is
 * the warm near-black the elevation ladder already hand-writes in `--lift-1..3`;
 * `70 46 30` is §3's warm drop, "a shadow colour, not a surface colour, and it
 * appears nowhere else". Written as arbitrary values rather than a token because
 * this is a Tailwind class string, and `.lm-card` — which carries the same pair
 * — is not applied to this element.
 */
export const postContainerClasses = `relative mx-auto my-0 rounded-xl border border-border bg-background px-5 py-6 shadow-[0_1px_2px_rgb(26_22_18/0.035),0_3px_12px_-6px_rgb(70_46_30/0.13)] sm:px-7 ${postContentWidthClasses}`;

/** Comments section container */
export const commentsSectionClasses = `mx-auto w-full max-w-4xl overflow-hidden`;
