/**
 * The quill mark: this byline belongs to a LITE account.
 *
 * Meaning, from the owner's spec sheet (`quill-mark/README.md`): posts through
 * Lumen, holds no Hive keys. Not a rank, not a score, the same mark on every
 * lite account.
 *
 * ★★★ WHY IT EXISTS AT ALL (2026-08-16). It replaces the Hive reputation number
 * on lite bylines, which was not merely irrelevant there: a lite post is signed
 * by the shared gateway account, so the entry's `author_reputation` is the
 * GATEWAY's. Measured, `hbd-temp` has raw reputation 0, which formats to exactly
 * 25 -- so every Google, Bitcoin and Ethereum account displayed an identical
 * "(25)" that none of them earned, and 25 is Hive's brand-new-nobody value.
 *
 * Rules taken verbatim from the spec, each load-bearing:
 *   - viewBox 0 0 24 24, FILLS ONLY, no strokes.
 *   - The rachis (the quill's spine) is NEGATIVE SPACE between the two vanes.
 *     Never fill the gap: that is what makes it read as a feather rather than a
 *     leaf at small sizes.
 *   - 18px in bylines, 16px in nav, NEVER below 16.
 *   - Always paired with the handle text, so the glyph itself is aria-hidden and
 *     unfocusable; the accessible name comes from the wrapper's tooltip.
 *   - No motion, ever.
 *
 * `currentColor` so it follows hover and theme exactly like the handle beside it.
 */
import { FC } from 'react';

export const QuillMark: FC<{ size?: number; className?: string }> = ({ size = 18, className }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width={size}
    height={size}
    aria-hidden="true"
    focusable="false"
    className={className}
  >
    <path
      d="M12.1 15.6C11.7 12 12.5 7.4 16.9 3.2c1.2.8 1.8 1.8 1.9 2.6C18.8 7.4 17.6 9 15.8 10.2l1.4.1c-.8 1.3-2 2.3-3.6 3.1l1.2.2c-.4 1-1 1.8-1.7 2.2Z"
      fill="currentColor"
    />
    <path
      d="M11.1 15.6C10.6 12.2 11.1 7.6 15.2 3.8c-1.8.8-3.8 2.4-5 4l-.2-1.3C8.8 9.2 7.9 10.6 7.5 12l-.4-1.2c-.4 1.4-.2 2.6.8 3.4 1 .6 2.3.6 3.2.2Z"
      fill="currentColor"
    />
    <path d="M11.3 15.4h1l-.15 2h-.7Z" fill="currentColor" />
    <rect x="9.5" y="17.4" width="4.6" height="1.2" fill="currentColor" />
    <path
      fillRule="evenodd"
      d="M9.7 19h4.2c-.3 1.4-.9 2.6-2.1 4.2-1.2-1.6-1.8-2.8-2.1-4.2ZM12.65 20.75a.85.85 0 1 1-1.7 0 .85.85 0 1 1 1.7 0Z"
      fill="currentColor"
    />
  </svg>
);

export default QuillMark;
