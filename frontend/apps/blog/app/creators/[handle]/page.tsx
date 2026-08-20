import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import TokenMarketView from '@/blog/features/creator-tokens/ui/token-page/token-market-view';
import { displayHandle } from '@/blog/features/creator-tokens/live/adapt';

/**
 * Strip a leading @ from the URL segment — in BOTH spellings.
 *
 * ★ `%40` is not optional (found in live QA, 2026-08-07). Next hands this route
 * `%40magi.contracts` for `/creators/@magi.contracts` — the literal `@` arrives
 * percent-encoded — so a `/^@/` strip never matched and a creator with a REAL,
 * live on-chain market was told "@%40magi.contracts hasn't launched a token".
 * That is the worst kind of wrong: a confident false statement about someone
 * else's market, at the URL a reader is most likely to guess, since every other
 * profile in this app lives at `/@username`.
 *
 * Deliberately a targeted regex and NOT decodeURIComponent(): the segment is
 * already decoded once by Next, and decoding a second time throws URIError on a
 * bare `%` (e.g. /creators/abc%) and 500s the page.
 */
function normalizeHandle(raw: string): string {
  // ★ REPEATED, not once (2026-08-07, second pass). The first version stripped a
  // single prefix, so `/creators/@@magi.contracts`, `%40%40…` and `%2540…` still
  // reached the lookup with a leading `%40` and reproduced the very false
  // "hasn't launched a token" this function exists to prevent — while also
  // leaking raw percent-encoding into the page as `@%40magi.contracts`.
  // Bounded loop: each pass must shorten the string, so it always terminates.
  let out = raw;
  for (;;) {
    const next = out.replace(/^(?:@|%40|%2540)/i, '');
    if (next === out) break;
    out = next;
  }
  return decodePercentEscapes(out);
}

/**
 * Decode what Next did NOT decode.
 *
 * ★ THE COMMENTS ABOVE ARE HALF RIGHT, AND THE MISSING HALF BROKE WALLET
 * CREATORS (2026-08-20). Next decodes a dynamic segment, but it RE-ENCODES the
 * reserved characters, so a colon arrives as `%3A`. That never mattered while
 * every creator was a Hive name — `lumen.aria` has nothing to encode. A wallet
 * creator's id is `did:pkh:eip155:1:0x…`, four colons, and the page confidently
 * announced that a market with 25 HBD face and an ACTIVE state on chain
 * "hasn't launched a token" — the exact false statement `normalizeHandle` was
 * written to prevent, reappearing through a different door.
 *
 * ★ AND THE WARNING IS STILL VALID: `decodeURIComponent` THROWS on a bare `%`
 * (`/creators/abc%`), which would 500 the page. So it is attempted, and the
 * raw value is kept when it throws. Decoding cannot be skipped and cannot be
 * trusted; it has to be guarded.
 */
function decodePercentEscapes(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    // Malformed escape: a lookup on the raw text simply misses, which renders
    // the honest "no such market" instead of a 500.
    return value;
  }
}

export function generateMetadata({ params }: { params: { handle: string } }): Metadata {
  // Next.js already URL-decodes the dynamic segment, so DON'T decode again —
  // decodeURIComponent on an already-decoded value containing a bare '%'
  // (e.g. /creators/abc%25 → "abc%") throws URIError and 500s the page.
  const handle = normalizeHandle(params.handle);
  // The browser tab and every share preview get the readable form. A 68-char
  // DID in a <title> is unusable everywhere it lands.
  const shown = displayHandle(handle);
  return {
    title: `@${shown} token`,
    description: `The live Meritum market for @${shown} on Lumen — price, market cap, floor, delivery record, and the services you spend the token on.`
  };
}

/**
 * The creator-token market page. Design route is `/@creator` (the profile
 * page), but that integration touches the existing profile feature — this
 * `/creators/[handle]` route is the interim, self-contained home so the flow
 * (Creators → token page) works end-to-end now.
 *
 * TODO(live): fetch the market for `params.handle` from the indexer; renders the
 * mock @ada detail until the contract is deployed.
 */
export default function CreatorTokenPage({ params }: { params: { handle: string } }) {
  // Next.js already URL-decodes the dynamic segment, so DON'T decode again —
  // decodeURIComponent on an already-decoded value containing a bare '%'
  // (e.g. /creators/abc%25 → "abc%") throws URIError and 500s the page.
  const handle = normalizeHandle(params.handle);
  // Your own token (STUDIO_HANDLE = 'you') isn't a public trading page — it's
  // managed in the Studio. Redirecting also closes the self-dealing loop (#2).
  if (handle === 'you') redirect('/creators/studio');
  return <TokenMarketView handle={handle} />;
}
