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
 *
 * TWO HARDENINGS ADDED 2026-07-28 after the attacker fan-out:
 *
 * 1. **A chain that is too short is not trusted.** If the app port is reachable
 *    directly (bypassing the proxy), an attacker can send any XFF they like — and a
 *    single forged entry used to be read as the client, giving a fresh rate-limit
 *    bucket per request. Now a chain shorter than the configured proxy count is
 *    rejected outright and we fall back to a header only our own edge sets. Bucket
 *    everything unattributable together, so bypass traffic shares one bucket rather
 *    than getting unlimited ones. (Binding the app to localhost is still the real
 *    fix; this makes the failure mode safe instead of unlimited.)
 *
 * 2. **IPv6 is bucketed per /64, not per address.** A single IPv6 allocation is
 *    routinely a /64 (or larger), so per-address limiting hands an attacker
 *    effectively unlimited fresh identities while doing nothing to a normal user.
 */

/** Everything we cannot attribute to a real client shares this one bucket. */
const UNATTRIBUTED = 'unattributed';

/**
 * Collapse an address to its rate-limiting key: IPv6 down to its /64 prefix, IPv4
 * unchanged.
 */
export function ipBucket(address: string): string {
  const ip = address.trim().toLowerCase();
  if (!ip) return UNATTRIBUTED;

  // IPv4 (or IPv4-mapped IPv6 like ::ffff:1.2.3.4) — but ONLY if it really is one.
  //
  // This branch used to return any colon-free string verbatim, which meant a forged
  // `X-Forwarded-For: any-garbage-N` minted a brand-new rate-limit bucket per
  // request and defeated every per-IP limiter at once (signup, wallet challenge,
  // name lookup). Proven exploitable 2026-07-28. Anything that is not a well-formed
  // address now falls into the single shared bucket instead.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) return isIpv4(mapped[1]) ? mapped[1] : UNATTRIBUTED;
  if (!ip.includes(':')) return isIpv4(ip) ? ip : UNATTRIBUTED;

  // IPv6: keep the first four groups (/64). Handles '::' compression by expanding
  // only as far as needed to know those groups.
  const [head] = ip.split('%'); // drop any zone id
  const groups = expandIpv6Prefix(head);
  return groups ? `${groups}::/64` : UNATTRIBUTED;
}

/** Strict dotted-quad check, including octet range — '1.2.3.999' is not an IP. */
function isIpv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function expandIpv6Prefix(ip: string): string | null {
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  const full =
    halves.length === 2 ? [...left, ...Array(Math.max(0, missing)).fill('0'), ...right] : left;
  if (full.length < 4) return null;
  return full
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':');
}

export function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    const parts = forwarded
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    // A chain shorter than our proxy count did NOT come through our proxies, so
    // every entry in it is client-supplied. Do not trust any of it.
    if (parts.length >= liteConfig.trustedProxyCount) {
      const idx = parts.length - liteConfig.trustedProxyCount;
      const candidate = parts[idx];
      if (candidate) return ipBucket(candidate);
    }
  }
  // x-real-ip is set by our own edge; anything else is unattributable and shares
  // a single bucket rather than minting a new one per request.
  const realIp = req.headers.get('x-real-ip');
  return realIp ? ipBucket(realIp) : UNATTRIBUTED;
}
