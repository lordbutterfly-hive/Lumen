/**
 * The description rules, with NO database import.
 *
 * ★ WHY ITS OWN FILE. The Studio form and the API route must apply the SAME rule,
 * or the box accepts text the route then refuses. The obvious home was the
 * repository beside the query that stores it — but that module imports the pg
 * pool, and a client component importing it would pull the database driver into
 * the browser bundle. So the pure rule lives here and BOTH sides import it: the
 * repository re-exports it so a server caller never needs to know.
 */
/** The product bound, in words, quoted to the creator and enforced on the write. */
export const MAX_DESCRIPTION_WORDS = 100;
/**
 * A hard byte ceiling alongside the word count, because "words" is not a bound on
 * storage: 100 words of pasted CJK, or 100 "words" each 400 characters long, are
 * both within the word rule and neither is a description. Every array- and
 * string-taking surface in this codebase carries its own size bound for exactly
 * this reason.
 */
export const MAX_DESCRIPTION_BYTES = 2_000;

export interface OfferingDescriptionProblem {
  message: string;
}

/**
 * Whether this text may be stored, as the creator-facing sentence explaining why
 * not. Shared by the API route and the Studio form so the box cannot accept text
 * the route then refuses — the same rule `offerTitleProblem` follows for titles.
 */
export function descriptionProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null; // empty is how a description is REMOVED
  const words = trimmed.split(/\s+/).length;
  if (words > MAX_DESCRIPTION_WORDS) {
    return `A description can be at most ${MAX_DESCRIPTION_WORDS} words; this one is ${words}.`;
  }
  if (new TextEncoder().encode(trimmed).length > MAX_DESCRIPTION_BYTES) {
    return `That description is too long to store (limit ${MAX_DESCRIPTION_BYTES} bytes).`;
  }
  return null;
}

