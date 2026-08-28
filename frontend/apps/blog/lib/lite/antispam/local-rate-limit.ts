/**
 * In-process fixed-window rate counters — the FALLBACK that runs when the
 * durable (Postgres) limiter cannot answer.
 *
 * WHY THIS EXISTS (audit anomaly AN-34, 2026-08-19). Every public proxy route
 * in this app wraps its limiter call in `catch { /* limiter unavailable —
 * proceed *\/ }`. The reasoning was sound as far as it went: these routes must
 * keep working whether or not the lite-accounts Postgres backend is
 * provisioned, so a store outage must not take chain reads offline. But the
 * consequence was never stated: with the store down — or simply never
 * provisioned — the per-IP cap is not merely degraded, it is ABSENT, and the
 * route is completely unbounded. "Best effort" quietly meant "no effort at
 * all" in exactly the conditions a limiter exists for.
 *
 * This closes that without reintroducing the outage the fail-open was
 * protecting against: the durable limiter stays authoritative, and this takes
 * over only when it throws. It lives in the process, so it is per-instance and
 * resets on deploy — genuinely weaker than the Postgres counter, and not a
 * replacement for it. It is a floor, not a ceiling.
 *
 * ★ THE GLOBAL BUCKET IS THE ONE THAT MATTERS. A per-IP cap of any kind is
 * defeated by using more IPs, which is free at scale. What actually bounds our
 * amplification of an upstream node is a limit on TOTAL forwarded calls, and
 * these routes had no such limit at any layer. `consumeGlobal` is that bound,
 * and unlike the per-IP fallback it applies on every request, not only when
 * the durable limiter is unwell.
 *
 * Memory is bounded by construction: entries are dropped as soon as their
 * window rolls, and a hard cap on distinct tracked keys evicts the oldest
 * rather than growing without limit under a spray of forged IPs — an
 * unbounded map keyed on attacker-controlled input is its own vulnerability.
 */

import { ipKey } from '../http/ip';

interface Window {
  count: number;
  resetAt: number;
}

/** Distinct keys tracked at once. Beyond this the oldest window is evicted. */
const MAX_TRACKED_KEYS = 20_000;

const windows = new Map<string, Window>();

function consume(key: string, limit: number, windowMs: number, now: number): boolean {
  if (limit <= 0) return false;

  const existing = windows.get(key);
  if (existing && existing.resetAt > now) {
    if (existing.count >= limit) return false;
    existing.count += 1;
    return true;
  }

  if (windows.size >= MAX_TRACKED_KEYS) {
    // Drop whatever has already expired first; only if nothing has, evict the
    // single oldest window. Map preserves insertion order, so the first key is
    // the oldest — good enough for a fallback, and O(1) either way.
    for (const [k, w] of windows) {
      if (w.resetAt <= now) windows.delete(k);
      if (windows.size < MAX_TRACKED_KEYS) break;
    }
    if (windows.size >= MAX_TRACKED_KEYS) {
      const oldest = windows.keys().next().value;
      if (oldest !== undefined) windows.delete(oldest);
    }
  }

  windows.set(key, { count: 1, resetAt: now + windowMs });
  return true;
}

/**
 * Per-IP fallback. Deliberately generous — it is standing in for a daily
 * counter it cannot see, so it should refuse only traffic that is obviously
 * abusive rather than second-guess the real limit.
 */
export function consumeLocalPerIp(
  ip: string,
  scope: string,
  limit = 600,
  windowMs = 60_000
): boolean {
  return consume(`${ipKey(ip)}:${scope}`, limit, windowMs, Date.now());
}

/**
 * Global ceiling across ALL callers of one scope. This is the bound that
 * survives a distributed caller, and the one no layer had before.
 *
 * Sized as a ceiling, not a target: normal traffic is 15-45s polling per
 * client, so even a large logged-in population sits far below this. It exists
 * to stop this server becoming an amplifier, not to shape ordinary load.
 */
export function consumeLocalGlobal(scope: string, limit = 6_000, windowMs = 60_000): boolean {
  return consume(`global:${scope}`, limit, windowMs, Date.now());
}
