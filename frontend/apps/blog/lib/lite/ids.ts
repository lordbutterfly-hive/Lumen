import { randomBytes } from 'crypto';

/**
 * Crypto-random ULID generator (26 chars, Crockford base32).
 *
 * Layout: 48-bit millisecond timestamp (10 chars, lexicographically sortable)
 * followed by 80 bits of CSPRNG randomness (16 chars). We roll our own instead
 * of pulling the `ulid` npm package because that package seeds randomness from
 * `Math.random()`; our identifiers (user_id, credential_id) are security-adjacent
 * so we draw entropy from `crypto.randomBytes` instead.
 *
 * Server-side only (depends on node `crypto`).
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_BYTES = 10; // 80 bits -> exactly 16 base32 chars

function encodeTime(ms: number): string {
  let time = ms;
  let out = '';
  for (let i = 0; i < TIME_CHARS; i++) {
    out = CROCKFORD[time % 32] + out;
    time = Math.floor(time / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = randomBytes(RANDOM_BYTES);
  let acc = 0;
  let bits = 0;
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    acc = (acc << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(acc >> bits) & 31];
    }
    // Keep only the still-unemitted low bits so the next shift can't carry
    // already-emitted high bits (JS bitwise ops are 32-bit).
    acc &= (1 << bits) - 1;
  }
  return out;
}

export function ulid(): string {
  return encodeTime(Date.now()) + encodeRandom();
}

/** URL-safe, single-use challenge nonce (256 bits of CSPRNG entropy). */
export function nonce(): string {
  return randomBytes(32).toString('base64url');
}
