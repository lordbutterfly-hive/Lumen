/**
 * Two helpers the token page and the Meritum creator page (`../meritum-page/`)
 * share, moved out of token-market-view.tsx on 2026-09-15 so the two pages
 * cannot compute a different ask reference or a different interstitial key
 * for the same market.
 */
/**
 * The escrow's content reference. The chain stores a short opaque string and
 * NOTHING ELSE about the job — no question, no brief, no deliverable. That is
 * deliberate: this contract facilitates payment and reputation, not messaging.
 *
 * A short, stable, non-secret reference derived from what the buyer typed, so
 * both parties can name the same job ("re: ask 4f2a") when they talk. It must
 * never be treated as delivery: the creator gets paid for work arranged
 * elsewhere, and the buyer's protection is the rating they leave afterwards.
 */
export function askReference(question: string): string {
  const trimmed = question.trim();
  if (trimmed.length === 0) return `ask-${Date.now().toString(36)}`;
  // A cheap stable digest — not cryptographic, and not meant to be: it only has
  // to be short, deterministic and free of the '|' the contract's key format
  // reserves.
  let h = 0;
  for (let i = 0; i < trimmed.length; i++) h = (Math.imul(31, h) + trimmed.charCodeAt(i)) | 0;
  return `ask-${(h >>> 0).toString(36)}`;
}

/**
 * Who has been shown the "before you trade" warning, for which market.
 *
 * ★ Keyed by VIEWER as well as handle (2026-08-07). It used to be handle-only,
 * so after one account dismissed the warning, a genuinely different account
 * signing in on the same tab never saw it at all — a risk disclosure silently
 * inherited by someone who never read it.
 */
export function interstitialKey(handle: string, viewer: string | null): string {
  return `lumen-token-inter-${viewer ?? 'anon'}-${handle}`;
}
