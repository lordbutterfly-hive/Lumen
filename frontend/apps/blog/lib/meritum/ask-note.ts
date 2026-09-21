/**
 * The rules for a buyer's message attached to a Meritum request, with NO
 * database or React import — the API route, the repository and the client
 * hook all apply the SAME rule from here, for the reason
 * features/creator-tokens/lib/offering-description.ts gives: a box that
 * accepts text the route then refuses is a bug, and a route that trusts a
 * hash the client computed differently is a worse one.
 *
 * The chain stores only a REFERENCE for the question (`askReference`, in
 * ui/token-page/token-page-helpers.ts): "ask-" plus the base-36 form of a
 * 31-bit string hash of the trimmed text. Migration 0048 carries the argument
 * for keeping the text off chain; this module is the half that makes the
 * off-chain copy verifiable — a note is filed ONLY under the reference its own
 * text hashes to.
 */

/** The write bound, in UTF-16 units — the same unit a textarea's maxLength counts in, so the box and the route agree. */
export const MAX_ASK_NOTE_CHARS = 2000;

/** How many references one GET may look up at once. Beyond this the hook asks in pages. */
export const MAX_ASK_NOTE_LOOKUP = 50;

/**
 * The escrow reference for a question — the SAME function the Ask dialog runs
 * (`askReference`), re-stated here so a server route never imports from a UI
 * folder. `lib/meritum/ask-note.test.ts` pins the two together on a corpus of
 * edge cases; if one is ever changed without the other, that test is what
 * fails.
 *
 * Returns null for blank text: the dialog mints a TIMESTAMP reference for an
 * empty question, which no note can ever match, so "no text" is honestly "no
 * reference" here rather than a value that looks comparable and never is.
 */
export function askReferenceOf(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  let h = 0;
  for (let i = 0; i < trimmed.length; i++) h = (Math.imul(31, h) + trimmed.charCodeAt(i)) | 0;
  return `ask-${(h >>> 0).toString(36)}`;
}

/**
 * Anything C0/C1 except the three a typed message legitimately contains
 * (newline, carriage return, tab). U+2028/2029 are excluded too: they are
 * line separators a JSON.parse accepts and a renderer may not.
 */
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/;

/**
 * Whether this text may be stored, as the buyer-facing sentence explaining why
 * not, or null when it may. Judged on the TRIMMED text, which is also what is
 * hashed and what is stored.
 */
export function noteTextProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'Write the message first.';
  if (trimmed.length > MAX_ASK_NOTE_CHARS) {
    return `A message can be at most ${MAX_ASK_NOTE_CHARS} characters; this one is ${trimmed.length}.`;
  }
  if (FORBIDDEN_CONTROL.test(trimmed)) return 'The message contains characters that cannot be stored.';
  return null;
}

/**
 * The account id as the CONTRACT keys it — a mirror of lib/vsc/reads.ts's
 * toDid, here so the server route can normalise a bare Hive name the same way
 * every chain key does (`hive:<name>`) without importing the chain reader.
 * The unit test pins it to the original.
 */
export function contractKeyOf(account: string): string {
  const a = account.trim().replace(/^@/, '');
  if (a.startsWith('hive:') || a.startsWith('did:')) return a;
  return `hive:${a}`;
}

/**
 * The shape a stored reference can have. Every note is filed under an
 * `askReferenceOf` value, so this is the whole domain; it also bounds what a
 * lookup may ask for without touching the database.
 */
export function isAskReference(value: string): boolean {
  return /^ask-[0-9a-z]{1,7}$/.test(value);
}

/**
 * Parse a comma-separated lookup list into at most MAX_ASK_NOTE_LOOKUP
 * distinct, well-formed references. Unknown shapes are dropped rather than
 * refused: a reference the store can never hold has no row to leak.
 */
export function parseReferenceList(raw: string | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const v = part.trim();
    if (!isAskReference(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= MAX_ASK_NOTE_LOOKUP) break;
  }
  return out;
}
