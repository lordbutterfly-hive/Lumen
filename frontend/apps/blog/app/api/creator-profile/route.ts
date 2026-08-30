import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { getAccountFull } from '@transaction/lib/hive-api';
import type { FullAccount } from '@hive/common-hiveio-packages/wax';
import { cachedRead } from '@/blog/lib/server-read-cache';
import { liteAccountAsProfile } from '@/blog/lib/lite/render/lite-account';
import { isSafeExternalHref } from '@/blog/components/safe-external-link';

const logger = getLogger('app');

/**
 * `GET /api/creator-profile?handle=<...>` — the ONE public fact this route
 * exposes about a creator: their `website` link, plus a display name.
 * (WORK-LINK spec B2, 2026-08-30 — owner: "Show them the work... People
 * check your profile before they hold anything.")
 *
 * WHY A NEW ROUTE rather than reusing `/api/account`: that route is
 * Hive-only (a hard `/^[a-z][a-z0-9.-]{1,15}$/` shape check with no lite
 * fallback — `app/api/account/route.ts:29-32`) and returns the FULL account
 * object (balances, manabar, everything) with `cache-control:
 * private, no-store`, because balances are per-viewer-sensitive and change
 * every block. The token page (B3) needs neither of those properties: it
 * needs one public, rarely-changing string, identical for every viewer, for
 * BOTH Hive and lite/wallet creators, and it wants that answer cacheable.
 * Piggybacking on `/api/account` would mean either loosening its shape
 * guard for wallet DIDs or leaking balances into a response served from a
 * shared cache — both worse than a second, narrower route.
 *
 * SHAPE: `{ website: string | null, displayName: string | null }`. Nothing
 * else, ever — no balances, no manabar, no email, no session-derived data.
 *
 * ★★ SECURITY: `website` IS SANITISED HERE, SERVER-SIDE, with the exact
 * same gate `SafeExternalLink` (B1) applies at render time
 * (`isSafeExternalHref`, imported — not re-implemented, so the two can
 * never drift). A chain account's `website` is attacker-controlled with NO
 * server-side re-validation on the broadcast path (see B1's own header for
 * the full citation), so it would be a mistake to trust it just because it
 * survived one hop through this route; a caller of this API that skipped
 * SafeExternalLink for some reason must still never receive a
 * `javascript:`/`data:`/credential-embedded string. Defense in depth, not
 * "the client already checks it."
 *
 * ★ Never 500s a page over a profile annotation. Every failure path below —
 * a malformed handle, a chain read that throws, a lite lookup that throws —
 * is caught, logged, and answered as `{ website: null, displayName: null }`
 * with a normal 200. This is metadata ABOUT a page; it must never be able
 * to take the page down.
 */

/**
 * Mirrors `app/creators/[handle]/page.tsx`'s (unexported) `normalizeHandle`/
 * `decodePercentEscapes` — same two passes: strip a leading `@`/`%40`/`%2540`
 * (repeated; each pass strictly shortens the string, so this always
 * terminates), then decode whatever percent-escaping is left, swallowing a
 * throw on a bare `%` rather than 500ing. Duplicated rather than imported:
 * that file doesn't export these helpers, and editing it is out of scope
 * for this route (owned by another change in this same build). A query
 * PARAM (unlike a dynamic ROUTE SEGMENT) is already decoded once by
 * `URLSearchParams` with no re-encoding-of-reserved-characters quirk to
 * work around, so in practice this mostly matters for a handle passed in
 * pre-encoded by a caller other than B3's own fetch — kept anyway so this
 * route accepts exactly the same handle shapes the token page does.
 */
function normalizeHandle(raw: string): string {
  let out = raw;
  for (;;) {
    const next = out.replace(/^(?:@|%40|%2540)/i, '');
    if (next === out) break;
    out = next;
  }
  if (!out.includes('%')) return out;
  try {
    return decodeURIComponent(out);
  } catch {
    return out;
  }
}

/** Same shape guard as `/api/account/route.ts:31` — a Hive username, lowercased. */
const HIVE_USERNAME = /^[a-z][a-z0-9.-]{1,15}$/;

const NULL_BODY = { website: null, displayName: null } as const;
const CACHE_HEADERS = { 'cache-control': 'public, s-maxage=300, stale-while-revalidate=3600' } as const;

function nullResponse(): NextResponse {
  // ★ Public and cacheable even on the "nothing found" answer — a repeated
  // lookup for a creator with no website (or no account at all) is the
  // common case, not the exception, and it is exactly as safe to share
  // across viewers as a real answer: identical bytes, no cookie, no session.
  return NextResponse.json(NULL_BODY, { headers: CACHE_HEADERS });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const rawHandle = (req.nextUrl.searchParams.get('handle') ?? '').trim();
  if (!rawHandle) return nullResponse();

  let handle: string;
  try {
    handle = normalizeHandle(rawHandle);
  } catch (error) {
    logger.warn(error, 'creator-profile: handle normalisation failed for %s', rawHandle);
    return nullResponse();
  }
  if (!handle) return nullResponse();

  try {
    // ★★ CRITICAL, LOAD-BEARING: a did:pkh: identity must NEVER reach the
    // Hive chain lookup. It is not a Hive username — routeHandle() (the
    // token page's own URL builder, `live/adapt.ts:72`) leaves a DID
    // untouched precisely because it has nowhere to strip a `hive:` prefix
    // from — and handing it to `getAccountFull` would either be refused by
    // the shape guard below (harmless) or, if that guard were ever loosened,
    // sent to a public Hive RPC as attacker-shaped input. Wallet creators go
    // straight to the lite path, unconditionally.
    const isWalletDid = /^did:pkh:/i.test(handle);

    let account: FullAccount | null = null;

    if (isWalletDid) {
      // ★ KNOWN GAP (tracked separately: "wallet creator visibility" —
      // there is today no did:pkh:->lumen_user index anywhere in this
      // codebase; grepped the repository, confirmed absent). A wallet
      // creator's TOKEN-PAGE handle is their raw DID (see routeHandle()
      // above), but `liteAccountAsProfile()` resolves by the user's CHOSEN
      // Lumen display name — a different string. So this call will miss for
      // essentially every wallet creator today and `account` stays null,
      // which degrades to the documented "absent renders nothing" case —
      // never a fabrication, never a 500 — and starts working the day that
      // index exists, with no change needed here.
      account = await liteAccountAsProfile(handle).catch((error) => {
        logger.warn(error, 'creator-profile: lite lookup failed for wallet handle %s', handle);
        return null;
      });
    } else {
      const bare = handle.startsWith('hive:') ? handle.slice('hive:'.length) : handle;
      const lower = bare.toLowerCase();

      if (HIVE_USERNAME.test(lower)) {
        try {
          // Same cachedRead memo pattern as `/api/account/route.ts`, but its
          // OWN namespaced key and TTL: reusing `account:${lower}` (that
          // route's key) would couple two independently-owned routes' cache
          // lifetimes together in a shared, module-level Map — whichever
          // route populated the entry first would silently dictate the
          // other's freshness. `website` changes on the order of "a creator
          // edits their settings", so a minute of staleness costs nothing
          // and this only exists to collapse a burst of identical requests.
          account = await cachedRead(`creator-profile:hive:${lower}`, 60_000, () => getAccountFull(lower));
        } catch (error) {
          logger.warn(error, 'creator-profile: chain lookup failed for %s', lower);
          account = null;
        }
      }

      if (!account?.name) {
        // Lumen lite account fallback — same resolver, same reasoning as
        // `app/[param]/(user-profile)/layout.tsx:184`: a lite user has no
        // Hive account, so the chain lookup above either never ran (bad
        // shape) or came back empty, and this is the ONLY other place a
        // `website` can live for them.
        account = await liteAccountAsProfile(lower).catch((error) => {
          logger.warn(error, 'creator-profile: lite lookup failed for %s', lower);
          return null;
        });
      }
    }

    const rawWebsite = account?.profile?.website;
    const website = typeof rawWebsite === 'string' && rawWebsite && isSafeExternalHref(rawWebsite) ? rawWebsite : null;

    const rawName = account?.profile?.name || account?.name;
    const displayName = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : null;

    return NextResponse.json({ website, displayName }, { headers: CACHE_HEADERS });
  } catch (error) {
    logger.error(error, 'creator-profile: unexpected failure for %s', handle);
    return nullResponse();
  }
}
