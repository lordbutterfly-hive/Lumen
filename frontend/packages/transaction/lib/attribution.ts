/**
 * On-chain attribution for posts and comments broadcast by a FULL Hive account
 * (Keychain, HiveAuth, and any other in-browser signer) through Lumen.
 *
 * Lite accounts have their own, separate mechanism — a shared frontend
 * account broadcasts on their behalf, so their footer has to name WHO wrote
 * it (`*Posted via Lumen by {name}*`, `apps/blog/lib/lite/publisher/footer.ts`).
 * This file is the full-account twin: the author field on chain already IS
 * the writer's own identity, so the footer only needs to say Lumen was the
 * tool, not who used it. Never import this from the lite path or vice versa.
 *
 * Owner instruction (2026-08-28): "Posted via Lumen" attribution is mandatory
 * on every post and comment a full Hive account publishes through Lumen.
 */

/**
 * `json_metadata.app` value every Lumen-broadcast post and comment carries.
 * Standard, machine-readable attribution other Hive frontends (peakd,
 * ecency, hive.blog) already read this field to show "posted via X".
 */
export const LUMEN_APP_METADATA = 'lumen/1.0';

const ATTRIBUTION_TEXT = 'Posted via Lumen';

/**
 * Matches our own footer, anchored to the END of the body only — so it can
 * never be mistaken for identical text a writer put in the middle of their
 * own post. `by {name}` is accepted too, defensively: it is the LITE
 * variant's shape, and while a full account's body should never carry it,
 * matching it here means an account that upgrades from lite mid-edit still
 * gets a single, correct footer rather than two stacked ones.
 */
const ATTRIBUTION_FOOTER_RE = /\n{2,}---\n\*Posted via Lumen(?: by [^\n*]{1,120})?\*\s*$/;

/**
 * Is the attribution already IN this body?
 *
 * ★ WHY A RENDERER NEEDS THIS. Attribution exists twice by design, and the two
 * copies serve different readers. The footer lives in the on-chain body, so it
 * travels — peakd, ecency and hive.blog render it because it is just text in
 * the post. `PostedViaLumen` (apps/blog/features/post-rendering) is Lumen's own
 * styled byline and reaches nobody else, because nobody else runs our React.
 *
 * On every OTHER frontend that means exactly one attribution. On Lumen it meant
 * TWO — the footer inside the body plus our byline underneath it. Owner,
 * 2026-08-28: "only make it show up once ... dont make it show twice."
 *
 * So the byline asks this first and renders nothing when the body already
 * carries the footer. Matching `stripAttributionFooter`'s own regex (rather
 * than a second, hand-rolled test) is the point: if the footer's shape ever
 * changes, the writer and the renderer cannot disagree about what it looks
 * like, which is the failure that would silently show it twice again.
 */
export function hasAttributionFooter(body?: string | null): boolean {
  return typeof body === 'string' && ATTRIBUTION_FOOTER_RE.test(body);
}

/**
 * Remove any trailing attribution footer. Loops rather than a single
 * `replace` so a body carrying several STACKED footers — the shape a
 * non-idempotent build could have produced before this existed — collapses
 * to none, not one; the next `appendAttributionFooter` call then adds back
 * exactly one.
 */
export function stripAttributionFooter(body: string): string {
  let out = body;
  while (ATTRIBUTION_FOOTER_RE.test(out)) {
    out = out.replace(ATTRIBUTION_FOOTER_RE, '');
  }
  return out;
}

/**
 * Strip any existing footer, then append exactly one fresh copy.
 *
 * Safe to call on every publish AND every edit — this is what makes the
 * operation idempotent. Whatever text arrives (clean, already carrying our
 * footer because the editor round-tripped the on-chain body, or carrying
 * several stacked copies from before this guard existed), the result always
 * carries exactly one, at the bottom, in the same shape.
 */
export function appendAttributionFooter(body: string): string {
  const clean = stripAttributionFooter(body).replace(/[ \t\r\n]+$/, '');
  return `${clean}\n\n---\n*${ATTRIBUTION_TEXT}*`;
}
