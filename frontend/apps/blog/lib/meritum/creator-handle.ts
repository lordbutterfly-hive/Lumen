/**
 * The creator's address on Lumen: `/m/<handle>` (owner, 2026-09-15, from the
 * Meritum creator landing handoff §0: "Every creator gets
 * lumensocial.net/m/<username>"). ONE builder for every link that points at a
 * creator's Meritum page, so a route change is one edit, and ONE normaliser
 * for what arrives in the URL, shared by the page, the redirect from the old
 * `/creators/<handle>` address, the profile API and the card route.
 *
 * Pure: no chain, no React, no Next — the unit test imports this directly.
 */

/** A Hive username, lowercased. Same guard as `/api/account/route.ts`. */
export const HIVE_USERNAME = /^[a-z][a-z0-9.-]{1,15}$/;

/**
 * A wallet creator's id, as `lib/vsc/reads.ts`'s `isWellFormedDid` bounds it
 * (mirroring core/util.go's MaxAccountLen of 160): `did:pkh:` plus a short
 * chain path. Case-significant (an EVM checksum lives in it).
 */
// ★ NOT TIGHTER THAN THE CONTRACT (review, 2026-09-15). `reads.ts`'s
// `isWellFormedDid` accepts printable ASCII up to 160 bytes and its own note
// warns that a too-tight client guard is a defect: a wallet whose chain path
// carries a `-`, `_` or `.` would get a hard 404 on their own page. What is
// excluded here is only what a URL or an HTML attribute could misread.
const WALLET_DID = /^did:pkh:[A-Za-z0-9._:%+-]{1,150}$/;
const MAX_DID_LENGTH = 160;

/**
 * Strip a leading `@` — in every spelling the URL can carry it — then decode
 * whatever percent-escaping is left, then lowercase a Hive name.
 *
 * ★ `%40` is not optional (found in live QA, 2026-08-07): Next hands a dynamic
 * segment `%40magi.contracts` for `/creators/@magi.contracts`, so a `/^@/`
 * strip never matched. ★ REPEATED, not once: `@@x`, `%40%40x` and `%2540x`
 * all reached the lookup otherwise. Bounded: each pass shortens the string.
 * ★ `decodeURIComponent` THROWS on a bare `%` (`/m/abc%`); it is attempted and
 * the raw value kept when it throws, so a malformed escape misses honestly
 * instead of 500ing. ★ A DID carries a ':' and is case-significant, so only a
 * name without one is lowercased.
 */
export function normalizeCreatorHandle(raw: string): string {
  let out = raw.trim();
  for (;;) {
    const next = out.replace(/^(?:@|%40|%2540)/i, '');
    if (next === out) break;
    out = next;
  }
  if (out.includes('%')) {
    try {
      out = decodeURIComponent(out);
    } catch {
      // keep the raw text: the lookup simply misses
    }
  }
  return out.includes(':') ? out : out.toLowerCase();
}

/** Is this something a creator page can exist for at all? Anything else is a 404 before any read. */
export function isRoutableCreatorHandle(handle: string): boolean {
  if (HIVE_USERNAME.test(handle)) return true;
  return handle.length <= MAX_DID_LENGTH && WALLET_DID.test(handle);
}

/** The `hive:` prefix a chain identity carries is never in a URL. A DID is left untouched. */
export function routeHandleOf(account: string | null | undefined): string {
  if (!account) return '';
  return account.startsWith('hive:') ? account.slice('hive:'.length) : account;
}

export type CreatorPageAction = 'buy' | 'sell' | 'redeem' | 'send' | 'spend' | 'dm' | 'share';

/**
 * `/m/<handle>`, plus the deep-link the page honours after a login round trip:
 * `?a=buy` opens the buy flow, `?a=spend&o=<offeringId>` opens that ask.
 * The handle is URL-encoded once; a DID's colons survive as `%3A` and the
 * page's normaliser decodes them (see `normalizeCreatorHandle`).
 */
export function creatorPagePath(account: string, action?: CreatorPageAction, offeringId?: number): string {
  const handle = routeHandleOf(account);
  const base = `/m/${encodeURIComponent(handle)}`;
  if (!action) return base;
  const params = new URLSearchParams({ a: action });
  if (action === 'spend' && typeof offeringId === 'number' && Number.isInteger(offeringId) && offeringId >= 0) {
    params.set('o', String(offeringId));
  }
  return `${base}?${params.toString()}`;
}

/** The absolute, shareable form. `origin` is the configured site domain, never the request's Host header. */
export function creatorPageUrl(origin: string, account: string): string {
  return `${origin.replace(/\/+$/, '')}${creatorPagePath(account)}`;
}

/** The old address. Kept only so the redirect and its test agree on the shape. */
export function legacyCreatorPagePath(account: string): string {
  return `/creators/${encodeURIComponent(routeHandleOf(account))}`;
}

/**
 * Where a signed-out reader goes when they press Buy, Sell or Request, and
 * where they come BACK to (handoff §3: "prompt to log in, then return to the
 * buy flow, not to the top of the page"). `/login` honours `next` only for an
 * internal path (`isInternalPath` in lumen-login.tsx), so the round trip can
 * never leave the site; the page then reads `?a=`/`?o=` and opens the flow.
 */
export function loginThenReturnTo(path: string): string {
  return `/login?next=${encodeURIComponent(path)}`;
}
