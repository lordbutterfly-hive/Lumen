import type { FC } from 'react';

/**
 * ★★★ THE EMPTY STATES WERE ALL GREY TEXT (2026-08-18).
 *
 * "No comments yet", "No notifications yet", "Nothing more to load", and a 404
 * that was a single sentence. These are the moments a product either has a
 * personality or visibly does not, and they are also the moments a reader is
 * most likely to think something is broken rather than simply empty.
 *
 * ★★★ WHY THESE ARE INLINE AND NOT `<img src>` (2026-08-18, second pass).
 *
 * They shipped as flat SVG files painted in hardcoded cream — `#faf4ec` paper,
 * `#a9a19a` lines. That renders a bright cream card in the middle of a dark
 * page, so all six drawings were broken in dark mode the moment they appeared.
 *
 * The fix has to be inline. Tailwind here is `darkMode: ['class']`
 * (packages/tailwindcss/tailwind.config.js:3), so the theme is a CLASS on the
 * app's own <html>. An SVG loaded through `<img src>` is a SEPARATE document:
 * it cannot see that class, and `currentColor` inside it resolves against
 * nothing. A `prefers-color-scheme` block inside the file would only track the
 * OS, so an app-dark/OS-light reader would still get the bright version.
 * Inlining puts the geometry in the page's own DOM, where the `--lm-illo-*`
 * tokens (packages/tailwindcss/globals.css) resolve per theme like every other
 * colour in the product.
 *
 * The markup below is GENERATED from `apps/blog/public/lumen/illustrations/*.svg`,
 * which stay the design source of truth.
 *
 * ★ `aria-hidden`, ALWAYS. The drawing repeats what the sentence beside it
 * already says; announcing it twice is worse for a screen reader than not
 * announcing it at all.
 */
export type EmptyIllustration =
  | 'empty-comments'
  | 'empty-notifications'
  | 'empty-wallet'
  | 'end-of-feed'
  | 'no-results'
  | 'not-found';


const ILLUSTRATIONS: Record<EmptyIllustration, { viewBox: string; markup: string }> = {
  'empty-comments': {
    viewBox: '0 0 160 120',
    markup:
      "<rect x=\"14\" y=\"18\" width=\"104\" height=\"66\" rx=\"6\" fill=\"var(--lm-illo-paper)\" stroke=\"var(--lm-illo-line)\" stroke-width=\"2\"></rect> <path d=\"M40 84 30 100l22-16\" fill=\"var(--lm-illo-paper)\" stroke=\"var(--lm-illo-line)\" stroke-width=\"2\" stroke-linejoin=\"round\"></path> <path d=\"M34 40h64M34 54h44\" stroke=\"var(--lm-illo-accent)\" stroke-width=\"2\" stroke-linecap=\"round\"></path> <rect x=\"98\" y=\"46\" width=\"48\" height=\"34\" rx=\"5\" fill=\"var(--lm-illo-paper)\" stroke=\"var(--lm-illo-line-soft)\" stroke-width=\"2\"></rect>"
  },
  'empty-notifications': {
    viewBox: '0 0 160 120',
    markup:
      "<path d=\"M108 56a28 28 0 0 0-56 0c0 26-12 32-12 32h80s-12-6-12-32Z\" fill=\"var(--lm-illo-paper)\" stroke=\"var(--lm-illo-line)\" stroke-width=\"2\" stroke-linejoin=\"round\"></path> <path d=\"M70 96a10 10 0 0 0 20 0\" fill=\"none\" stroke=\"var(--lm-illo-line)\" stroke-width=\"2\" stroke-linecap=\"round\"></path> <path d=\"M80 28v-8\" stroke=\"var(--lm-illo-accent)\" stroke-width=\"2\" stroke-linecap=\"round\"></path> <path d=\"M26 44l-8-6M134 44l8-6\" stroke=\"var(--lm-illo-accent)\" stroke-width=\"2\" stroke-linecap=\"round\"></path>"
  },
  'empty-wallet': {
    viewBox: '0 0 160 120',
    markup:
      "<rect x=\"18\" y=\"30\" width=\"124\" height=\"62\" rx=\"8\" fill=\"var(--lm-illo-paper)\" stroke=\"var(--lm-illo-line)\" stroke-width=\"2\"></rect> <path d=\"M18 48h124\" stroke=\"var(--lm-illo-line)\" stroke-width=\"2\"></path> <circle cx=\"116\" cy=\"70\" r=\"8\" fill=\"none\" stroke=\"var(--lm-illo-line-soft)\" stroke-width=\"2\"></circle> <path d=\"M40 66h34\" stroke=\"var(--lm-illo-accent)\" stroke-width=\"2\" stroke-linecap=\"round\"></path> <path d=\"M56 30V16h48v14\" fill=\"none\" stroke=\"var(--lm-illo-accent)\" stroke-width=\"2\" stroke-linejoin=\"round\"></path>"
  },
  'end-of-feed': {
    viewBox: '0 0 160 120',
    markup:
      "<rect x=\"22\" y=\"16\" width=\"116\" height=\"22\" rx=\"4\" fill=\"var(--lm-illo-paper)\" stroke=\"var(--lm-illo-line)\" stroke-width=\"2\"></rect> <rect x=\"22\" y=\"46\" width=\"116\" height=\"22\" rx=\"4\" fill=\"var(--lm-illo-paper)\" stroke=\"var(--lm-illo-line-soft)\" stroke-width=\"2\"></rect> <rect x=\"34\" y=\"76\" width=\"92\" height=\"16\" rx=\"4\" fill=\"none\" stroke=\"var(--lm-illo-accent)\" stroke-width=\"2\" stroke-dasharray=\"6 5\"></rect> <path d=\"M62 104h36\" stroke=\"var(--lm-illo-line)\" stroke-width=\"2\" stroke-linecap=\"round\"></path>"
  },
  'no-results': {
    viewBox: '0 0 160 120',
    markup:
      "<circle cx=\"70\" cy=\"54\" r=\"32\" fill=\"var(--lm-illo-paper)\" stroke=\"var(--lm-illo-line)\" stroke-width=\"2\"></circle> <path d=\"M93 77l24 24\" stroke=\"var(--lm-illo-line)\" stroke-width=\"2\" stroke-linecap=\"round\"></path> <path d=\"M56 54h28\" stroke=\"var(--lm-illo-accent)\" stroke-width=\"2\" stroke-linecap=\"round\"></path>"
  },
  'not-found': {
    viewBox: '0 0 160 120',
    markup:
      "<rect x=\"20\" y=\"16\" width=\"120\" height=\"82\" rx=\"6\" fill=\"var(--lm-illo-paper)\" stroke=\"var(--lm-illo-line)\" stroke-width=\"2\"></rect> <path d=\"M20 36h120\" stroke=\"var(--lm-illo-line)\" stroke-width=\"2\"></path> <circle cx=\"32\" cy=\"26\" r=\"3\" fill=\"var(--lm-illo-accent)\"></circle><circle cx=\"44\" cy=\"26\" r=\"3\" fill=\"var(--lm-illo-accent)\"></circle> <path d=\"M58 58l20 20M78 58l-20 20\" stroke=\"var(--lm-illo-line-soft)\" stroke-width=\"2\" stroke-linecap=\"round\"></path> <path d=\"M92 58h26M92 70h18M92 82h26\" stroke=\"var(--lm-illo-accent)\" stroke-width=\"2\" stroke-linecap=\"round\"></path>"
  },
};

export const EmptyStateIllustration: FC<{ name: EmptyIllustration; size?: number; className?: string }> = ({
  name,
  size = 120,
  className
}) => {
  const art = ILLUSTRATIONS[name];
  if (!art) return null;
  return (
    <svg
      viewBox={art.viewBox}
      width={size}
      height="auto"
      role="presentation"
      aria-hidden="true"
      focusable="false"
      className={className}
      // Intrinsic viewBox above keeps the aspect ratio, so the drawing never
      // shifts the layout as the page settles.
      style={{ width: size, height: 'auto' }}
      // eslint-disable-next-line react/no-danger -- generated house artwork from a trusted constant, never user input
      dangerouslySetInnerHTML={{ __html: art.markup }}
    />
  );
};

export default EmptyStateIllustration;
