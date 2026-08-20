/**
 * The CIDv1 of a signing shell — what a BITCOIN wallet actually signs.
 *
 * ★ BTC AND EVM SIGN COMPLETELY DIFFERENT THINGS, and this is the detail most
 * likely to be missed by anyone assuming one signing rail with two wallet
 * buttons:
 *   - EVM signs EIP-712 TYPED DATA derived from the shell's CBOR bytes.
 *   - BTC signs the shell's **CID STRING** as a plain Bitcoin message
 *     (`BitcoinMessageHash(data.Cid().String())`, btc.go:135).
 * So the Bitcoin user is shown an opaque `bafyrei…` string in their wallet and
 * asked to sign it. That is what the node verifies against, and there is no
 * way to make it human-readable without changing the node.
 *
 * The CID is v1, codec DAG-CBOR (0x71), multihash sha2-256 (0x12), rendered in
 * lowercase base32 with the multibase prefix `b` — exactly what Go's
 * `cid.Prefix{Version:1, Codec:DagCbor, MhType:SHA2_256}.Sum(bytes)` produces.
 * The selftest pins a vector taken from that Go code so the two cannot drift.
 */

const CID_VERSION = 0x01;
const CODEC_DAG_CBOR = 0x71;
const MULTIHASH_SHA2_256 = 0x12;
const SHA256_LENGTH = 0x20;

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32, lowercase, NO padding — the `b` multibase form. */
function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/**
 * SHA-256, with a fallback for the case that actually breaks.
 *
 * ★ `crypto.subtle` IS UNDEFINED ON A NON-SECURE ORIGIN. It is gated on a
 * secure context, so plain `http://` on anything but localhost has no
 * `crypto.subtle` at all — and this was the ONLY crypto primitive in the app,
 * used solely here. Without a fallback the entire Bitcoin rail died with
 * `TypeError: Cannot read properties of undefined (reading 'digest')` BEFORE
 * the wallet prompt, while the EVM rail carried on working (adversarial review,
 * 2026-08-20). QA in this project has historically run over plain http, so this
 * was not hypothetical.
 *
 * The fallback is a plain implementation of FIPS 180-4. It is slower and it is
 * not the preferred path, but a hash of a few hundred bytes is not a
 * performance question, and "the feature silently does not exist on this
 * origin" is not an acceptable alternative.
 */
async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
    return new Uint8Array(digest);
  }
  return sha256Fallback(bytes);
}

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function sha256Fallback(input: Uint8Array): Uint8Array {
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

  // Pad: 0x80, zeros, then the length in BITS as a 64-bit big-endian value.
  const bitLen = input.length * 8;
  const padded = new Uint8Array((((input.length + 9) >> 6) + 1) << 6);
  padded.set(input);
  padded[input.length] = 0x80;
  // Lengths here are far below 2^32 bytes, so the high word is always zero.
  new DataView(padded.buffer).setUint32(padded.length - 4, bitLen >>> 0, false);

  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

  for (let off = 0; off < padded.length; off += 64) {
    const view = new DataView(padded.buffer, off, 64);
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const dv = new DataView(out.buffer);
  h.forEach((word, i) => dv.setUint32(i * 4, word, false));
  return out;
}

/**
 * The CID string for DAG-CBOR bytes: `b` + base32(0x01 0x71 0x12 0x20 <digest>).
 */
export async function dagCborCid(bytes: Uint8Array): Promise<string> {
  const digest = await sha256(bytes);
  const cid = new Uint8Array(4 + digest.length);
  cid[0] = CID_VERSION;
  cid[1] = CODEC_DAG_CBOR;
  cid[2] = MULTIHASH_SHA2_256;
  cid[3] = SHA256_LENGTH;
  cid.set(digest, 4);
  return `b${base32Encode(cid)}`;
}
