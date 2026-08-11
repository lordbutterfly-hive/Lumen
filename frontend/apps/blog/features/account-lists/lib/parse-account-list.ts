/**
 * Parses the "add to list" input on the moderation lists pages (blacklist,
 * muted, followed-blacklists, followed-muted-lists).
 *
 * ★ FIXES B1 (BUILDMAP-FUCKERY-V2-2026-08-11.md, G2). The helper text under
 * the field says "(single account or comma separated list)" but nothing ever
 * split the string: `list-area.tsx` passed the raw `<Input>` value straight
 * through as ONE account name. Typing "null, steemit, ned" got submitted as
 * the single literal blog name "null,steemit,ned" — see `list-area.tsx`'s old
 * `onChange={(e) => setAddValue(e.target.value.trim())}`: because the input
 * was CONTROLLED and re-rendered from the trimmed value on every keystroke,
 * any space typed became a trailing character for one render and was stripped
 * by `.trim()` before the next key landed, which is why the auditor observed
 * "spaces stripped, good" — it was an accident of a controlled input calling
 * `.trim()` on every change, not intentional normalisation.
 *
 * `transactionService.blacklistBlog` / `.followBlacklistBlog` /
 * `.followMutedBlog` / `.mute` (packages/transaction/index.ts) already accept
 * MULTIPLE names in one call — `.blacklistBlog(username, blog,
 * ...otherBlogs.split(', '))` spreads into wax's `FollowOperation`, which
 * builds ONE custom_json with an array. The transaction layer was already
 * capable of a batched add; the form in front of it never fed it one.
 */

/** Split on any run of commas and/or whitespace: "a, b", "a,b", "a  b,, c" all split the same way. */
export function splitAccountNamesRaw(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/** Normalise one token the way the chain/follow-list will store it: lowercase, no leading '@'. */
export function normalizeAccountName(token: string): string {
  return token.trim().toLowerCase().replace(/^@+/, '');
}

export interface ParsedAccountListInput {
  /** Deduped, normalised names not already on the list — the ones eligible to submit. */
  candidates: string[];
  /** Normalised names that already appear on the list being edited (B3: must block, not silently drop). */
  alreadyOnList: string[];
}

/**
 * Full B1/B3 parse pipeline: split, trim, lowercase, strip a leading '@',
 * drop empties, dedupe (both within the input and against the existing
 * list). Deduping *within* the typed input is silent normalisation (typing
 * the same name twice is not a mistake worth blocking on); a name that
 * matches the EXISTING list is returned separately so the caller can reject
 * the whole submission with an inline error instead of silently dropping it.
 */
export function parseAccountListInput(raw: string, existingNames: string[]): ParsedAccountListInput {
  const existingSet = new Set(existingNames.map(normalizeAccountName));
  const seen = new Set<string>();
  const candidates: string[] = [];
  const alreadyOnList: string[] = [];

  for (const token of splitAccountNamesRaw(raw)) {
    const name = normalizeAccountName(token);
    if (!name) continue;
    if (existingSet.has(name)) {
      if (!alreadyOnList.includes(name)) alreadyOnList.push(name);
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    candidates.push(name);
  }

  return { candidates, alreadyOnList };
}

/** Join validated names back into the single string `transactionService` splits on — ONE custom_json. */
export function joinAccountNames(names: string[]): string {
  return names.join(', ');
}
