import { NextRequest } from 'next/server';
import { liteConfig } from '../config';

/**
 * Client IP for rate limiting, read from the TRUSTED-PROXY BOUNDARY — not the
 * attacker-controllable leftmost X-Forwarded-For token (ECON-1, PRUNED
 * 2026-07-22). XFF is `client, proxy1, ..., proxyN`; every proxy APPENDS the
 * address it actually saw, so the RIGHTMOST entries are the ones OUR own
 * infrastructure added and a client cannot forge past them. With
 * `trustedProxyCount` proxies in front (default 1 = a single Caddy), the real
 * client is the entry that many hops from the right; a forged leftmost value is
 * ignored. The deploy MUST run exactly this many trusted proxies and should also
 * have the edge overwrite X-Forwarded-For — see stack/Caddyfile.
 */
export function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    const parts = forwarded
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      // The entry appended by the OUTERMOST trusted proxy — never the leftmost
      // (client-supplied) token. Clamp so a shorter-than-expected chain still
      // yields our own proxy's view rather than an attacker value.
      const idx = Math.max(0, parts.length - liteConfig.trustedProxyCount);
      return parts[idx] ?? parts[parts.length - 1];
    }
  }
  return req.headers.get('x-real-ip') ?? 'unknown';
}
