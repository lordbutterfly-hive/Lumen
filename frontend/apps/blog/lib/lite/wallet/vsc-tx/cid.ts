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

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  // Web Crypto in the browser; Node exposes the same API on globalThis.crypto
  // from 18 onward, so this needs no branch and no node-only import that would
  // then have to be excluded from the client bundle.
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return new Uint8Array(digest);
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
