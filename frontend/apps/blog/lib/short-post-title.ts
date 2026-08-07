/**
 * The title a SHORT post gets, derived from its first line.
 *
 * ★ ONE RULE, ONE FILE, BOTH TIERS.
 *
 * A short post has no title field, but Hive requires one and every feed card
 * renders it. Both writers need the same rule: the lite backend
 * (lib/lite/content/post-service.ts, which titles a post before the publisher
 * broadcasts it) and the browser composer (features/discovery-feed/
 * short-form-composer.tsx, which titles a Hive-keyed account's post before
 * signing it). They were separate copies "kept in sync by comment", which is
 * not a mechanism.
 *
 * ★ WHY THE MARKDOWN STRIPPING IS NOT `replace(/[#*_>`~-]/g, '')`.
 *
 * That was the rule, and it deleted every HYPHEN IN EVERY WORD. Measured on a
 * real mainnet post 2026-08-06: "Short-form composer check from a Hive-keyed
 * account" was published with the title "Shortform composer check from a
 * Hivekeyed account". A hyphen is markdown only as a LIST BULLET at the start
 * of a line or in a `---` rule; inside a word it is just how the word is
 * spelled, and English is full of them — well-being, e-mail, up-to-date,
 * short-form. So: strip block markers where they mean something (line start),
 * strip inline emphasis characters, and leave intra-word hyphens alone.
 */

/** Longest title we will produce, including the ellipsis. */
const MAX_TITLE = 60;

export function shortPostTitle(body: string): string {
  const firstLine = (body ?? '').trim().split('\n')[0];

  const cleaned = firstLine
    // Block markers only where they are markers: at the start of the line.
    // `- `, `* `, `> `, `#`, and any run of them ("### ", "> > ").
    .replace(/^\s*(?:[-*>+]\s+|#{1,6}\s*)+/, '')
    // A horizontal rule is not a title.
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/, '')
    // Inline emphasis / code / strikethrough markers.
    .replace(/[*_`~]/g, '')
    // A hyphen only "means markdown" when it is not joining two characters,
    // e.g. a stray trailing dash. Intra-word hyphens survive.
    .replace(/(^|\s)-+(\s|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned.length <= MAX_TITLE ? cleaned : `${cleaned.slice(0, MAX_TITLE - 3)}...`;
}
