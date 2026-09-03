import { createHmac } from 'crypto';
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
  // ★ CF-CONNECTING-IP behind Cloudflare (2026-09-03, CDN Phase A). Cloudflare
  // sets this to the true client IP; it is the robust way to recover the client
  // when a CDN hop is added ahead of Caddy (otherwise the whole site collapses
  // into Cloudflare's IP bucket). Opt-in via BEHIND_CLOUDFLARE so behaviour is
  // UNCHANGED until the DNS cutover sets it. Trustworthy only because the origin
  // is firewalled to accept traffic solely from Cloudflare ranges (see the CDN
  // runbook); a direct-to-origin hit could otherwise spoof this header.
  if ((process.env.BEHIND_CLOUDFLARE || '').toLowerCase() === 'yes') {
    const cf = req.headers.get('cf-connecting-ip');
    if (cf && cf.trim()) return ipBucket(cf.trim());
  }
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

/**
 * The rate-limiting KEY for a client address: a keyed hash, never the address.
 *
 * WHY (owner decision, 2026-08-28). Rate limiting needs to tell two callers apart.
 * It does NOT need to know who they are. Until now `rate_counter.subject` stored
 * `ip:<address>` in cleartext, which meant the one thing the product genuinely had
 * to disclose in a privacy policy was also the one thing it did not need to keep.
 * PeakD reached the same conclusion: "IP addresses are hashed (one-way,
 * irreversible) before storage. We cannot identify you from view records."
 *
 * HMAC, not a bare hash. The address space is small enough to enumerate — all of
 * IPv4 is 2^32, which a plain SHA-256 rainbow table reverses in minutes. Keying it
 * with a server-held secret makes that impossible for anyone without the secret,
 * which is the whole point.
 *
 * THE SECRET IS RESOLVED AT MODULE LOAD, ON PURPOSE. Every caller of this sits
 * inside a `catch { proceed }` fail-open (see local-rate-limit.ts for why that
 * fail-open exists), so a throw raised per-request would not fail CLOSED — it would
 * silently disable the limiter, which is worse than the thing being fixed. Failing
 * at import time instead means a production server missing the secret does not boot
 * quietly with rate limiting off; it refuses, loudly, before serving anyone.
 *
 * `DENSER_SERVER_SECRET_COOKIE_PASSWORD` is reused rather than adding a new required
 * variable: it is already mandatory (without it every login 500s), already checked by
 * `scripts/lumen-preflight.sh`, and already at least 32 characters. A new variable is
 * a new way for a deploy to be silently wrong.
 *
 * Changing the secret re-keys every bucket, which resets counters once. That is
 * acceptable and is not a reason to weaken the derivation.
 */
const IP_KEY_INFO = 'lumen-ip-key-v1';

const ipKeySecret: Buffer = (() => {
  const raw = process.env.DENSER_SERVER_SECRET_COOKIE_PASSWORD || '';
  if (raw.length < 32) {
    // `next build` runs with NODE_ENV=production and evaluates this module while
    // collecting page data, on a machine that has no business holding the runtime
    // secret. Throwing there would fail the BUILD, not the boot, and the natural
    // "fix" for that is to put the secret on the build host — which is the opposite
    // of what this is for. The build gets the development salt; nothing it produces
    // depends on the value, because no counter is written during a build.
    const building = process.env.NEXT_PHASE === 'phase-production-build';
    if (process.env.NODE_ENV === 'production' && !building) {
      throw new Error(
        'DENSER_SERVER_SECRET_COOKIE_PASSWORD is missing or under 32 chars — refusing to start. ' +
          'It keys the rate-limiter address hash; without it the choice is storing raw IP ' +
          'addresses or running with no rate limiting, and neither is acceptable in production.'
      );
    }
    // Development only. Deterministic so local counters survive a restart, and
    // deliberately a constant nobody could mistake for a secret.
    return createHmac('sha256', 'lumen-development-only-not-a-secret').update(IP_KEY_INFO).digest();
  }
  return createHmac('sha256', raw).update(IP_KEY_INFO).digest();
})();

/**
 * `ip:<32 hex chars>` — stable for a given address, irreversible without the secret.
 *
 * Takes the already-bucketed value `getClientIp` returns (IPv6 collapsed to /64), so
 * the privacy and the limiter semantics are unchanged: the same client still lands in
 * the same bucket, and an IPv6 allocation still cannot mint fresh buckets per address.
 *
 * 128 bits of the digest is kept. Collisions at that width are not reachable, and a
 * collision would only ever merge two buckets, never split one.
 */
export function ipKey(address: string): string {
  return `ip:${createHmac('sha256', ipKeySecret).update(address).digest('hex').slice(0, 32)}`;
}
