/**
 * Witness announcement URLs come straight from chain state (`witness_update`)
 * — fully attacker/witness-controlled. Only render an https URL with no
 * embedded credentials; anything else (bad scheme, unparsable, `http://`)
 * is treated as absent rather than rendered.
 */
export function toSafeExternalUrl(url: string | undefined): string | null {
  if (!url || typeof url !== 'string' || !URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  return parsed.toString();
}
