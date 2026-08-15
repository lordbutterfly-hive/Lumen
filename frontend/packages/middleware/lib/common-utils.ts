import type { NextRequest } from 'next/server';
import type { NextApiRequest } from 'next';

/**
 * ★★ THE LEFTMOST `x-forwarded-for` ENTRY IS WHATEVER THE CLIENT SENT (2026-08-15).
 *
 * This used to `return forwarded.split(',')[0].trim()` on both branches. XFF is
 * append-only: each proxy adds the address it saw to the RIGHT, so the leftmost
 * entry is the one the original caller supplied and nothing verifies it. Anyone
 * could send `X-Forwarded-For: <anything>` and have it recorded as their address.
 *
 * The app already knows this and already solved it — `apps/blog/lib/lite/http/ip.ts`
 * counts back from the right by the number of proxies we actually run, and its
 * own header says it was written after a 2026-07-28 incident where spoofed XFF
 * was used to fan out past per-IP limits. That module cannot be imported here
 * (this package must not depend on the app), so the same rule is reimplemented
 * below against the same `LITE_TRUSTED_PROXY_COUNT` setting, rather than leaving
 * a second, weaker copy of a function whose hardened twin exists ten files away.
 *
 * ★ AND THE VALUE IS VALIDATED BEFORE IT LEAVES THIS FUNCTION, which matters
 * more than the trust question for the one live caller. `page-visit-logger.ts`
 * interpolates the result into a SPACE-SEPARATED log line:
 *
 *     ip=${ip} account=${account} login_type=${loginType} uuid=${uid} ${pathname}
 *
 * An unvalidated header value therefore forges the rest of the record — send
 * `X-Forwarded-For: 1.2.3.4 account=someone login_type=keychain` and the log
 * says a different person visited. Returning only well-formed addresses closes
 * that regardless of which entry is trusted, so both halves are fixed here.
 */

/** Strict dotted-quad, octet range included: '1.2.3.999' is not an address. */
function isIpv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Deliberately permissive on shape, strict on ALPHABET — hex groups and colons only. */
function isIpv6(value: string): boolean {
  return value.includes(':') && /^[0-9a-fA-F:.]+$/.test(value) && value.length <= 45;
}

/**
 * The only exit for a header-derived value. Anything that is not recognisably an
 * address becomes `unknown`, so no caller can be handed attacker-authored text.
 */
function asAddress(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/^\[|\]$/g, '');
  if (!trimmed) return null;
  // IPv4-mapped IPv6 ('::ffff:1.2.3.4') is normal from a Node socket.
  const bare = trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
  if (isIpv4(bare)) return bare;
  if (isIpv6(trimmed)) return trimmed;
  return null;
}

/** How many proxies we run. Same setting the app's hardened helper reads. */
function trustedProxyCount(): number {
  return Math.max(1, Number(process.env.LITE_TRUSTED_PROXY_COUNT || 1));
}

/**
 * Pick the entry our own edge wrote, counting back from the right. A chain
 * SHORTER than our proxy count never traversed those proxies, so every entry in
 * it is client-supplied and none of it is trusted.
 */
function fromForwardedFor(forwarded: string | undefined | null): string | null {
  if (!forwarded) return null;
  const parts = forwarded
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const hops = trustedProxyCount();
  if (parts.length < hops) return null;
  return asAddress(parts[parts.length - hops]);
}

/**
 * Extract the client IP consistently across middleware.
 * Handles both NextRequest (Edge Runtime) and NextApiRequest (Node.js).
 *
 * Returns a validated address, or 'unknown' — never raw header text.
 */
export function getClientIp(req: NextRequest | NextApiRequest): string {
  // NextRequest.ip is set by the platform, not by the caller, so it is trusted.
  if ('ip' in req && req.ip) {
    return asAddress(req.ip) ?? 'unknown';
  }

  // NextApiRequest (Node.js)
  if ('socket' in req) {
    const forwarded = req.headers['x-forwarded-for'];
    const header = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
    // The socket address is observed by us, so it beats anything header-derived.
    return fromForwardedFor(header) ?? asAddress(req.socket?.remoteAddress) ?? 'unknown';
  }

  if ('headers' in req) {
    return (
      fromForwardedFor(req.headers.get('x-forwarded-for')) ??
      // x-real-ip is written by our own edge; still validated before use.
      asAddress(req.headers.get('x-real-ip')) ??
      'unknown'
    );
  }

  return 'unknown';
}
