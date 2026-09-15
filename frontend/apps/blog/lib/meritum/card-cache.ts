/**
 * ★ A CARD IS GENERATED ONCE AND KEPT (owner, 2026-09-15: "make sure the card
 * persists... so its always the same card you generated once. see if we can
 * generate once and persist without this taking too much of storage").
 *
 * The pure half: what names a creator's card on disk, and when a kept card
 * is still the right one. The route (`app/api/og/meritum`) does the I/O.
 *
 * ONE FILE PER CREATOR, overwritten only when an INPUT changes: the drawing
 * revision, the price (in cents — the number on the card), the about, the
 * display name, or which store answered for the face. A price tick that
 * does not move a cent redraws nothing. Storage is therefore bounded by the
 * number of creators, not by traffic or time: ~90 KB each, so a thousand
 * creators is under 100 MB. The face is the one input not in the key (it is
 * fetched, not known), so a kept card is also refreshed after `MAX_AGE_MS`,
 * which is how a new profile picture reaches the card within a week.
 */
export const CARD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface CardInputs {
  revision: number;
  cents: number;
  about: string | null;
  name: string | null;
  source: string;
}

export interface CardMeta extends CardInputs {
  generatedAt: number;
}

/** A filesystem-safe name for the creator: a Hive name as is, anything else percent-encoded then narrowed to [A-Za-z0-9._-]. Never a path segment. */
export function cardFileKey(handle: string): string {
  const safe = encodeURIComponent(handle).replace(/[^A-Za-z0-9._-]/g, '_');
  // A DID can be long; keep names short and unique enough with a tail hash.
  if (safe.length <= 64) return safe;
  let h = 0;
  for (let i = 0; i < handle.length; i++) h = (Math.imul(31, h) + handle.charCodeAt(i)) | 0;
  return `${safe.slice(0, 48)}_${(h >>> 0).toString(36)}`;
}

/** Still the right card? Same inputs, and younger than the age at which the face is refreshed. */
export function cardStillValid(meta: CardMeta | null | undefined, inputs: CardInputs, now: number, maxAgeMs: number = CARD_MAX_AGE_MS): boolean {
  if (!meta) return false;
  if (typeof meta.generatedAt !== 'number' || !Number.isFinite(meta.generatedAt)) return false;
  if (now - meta.generatedAt > maxAgeMs || now < meta.generatedAt) return false;
  return (
    meta.revision === inputs.revision &&
    meta.cents === inputs.cents &&
    (meta.about ?? null) === (inputs.about ?? null) &&
    (meta.name ?? null) === (inputs.name ?? null) &&
    meta.source === inputs.source
  );
}

/** Parse what the route wrote, refusing anything that is not the shape it writes. */
export function parseCardMeta(raw: string | null | undefined): CardMeta | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null;
    const m = v as Record<string, unknown>;
    if (typeof m.revision !== 'number' || typeof m.cents !== 'number' || typeof m.generatedAt !== 'number' || typeof m.source !== 'string') return null;
    return {
      revision: m.revision,
      cents: m.cents,
      about: typeof m.about === 'string' ? m.about : null,
      name: typeof m.name === 'string' ? m.name : null,
      source: m.source,
      generatedAt: m.generatedAt
    };
  } catch {
    return null;
  }
}
