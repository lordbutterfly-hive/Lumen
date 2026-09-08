import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { normalizeBtcAddress, btcNetworkKind } from './btc-verify';

/**
 * One Bitcoin key = one Lumen account.
 *
 * The problem this fixes: an account was keyed on the ADDRESS. One private key
 * yields three standard addresses (legacy `1…`, P2SH-SegWit `3…`, native SegWit
 * `bc1q…`), so the same person could sign up three times from one key — a free 3x
 * Sybil multiplier that no rate limit sees, because each address is a genuinely
 * distinct string.
 *
 * The fix is to derive an identifier from the KEY rather than its encoding. The
 * public key is recoverable from the signature we already verify, so this costs no
 * extra round-trip and no extra user step:
 *   - BIP-137 compact (65 bytes: header + r + s) — recover from the header's
 *     recovery id against the Bitcoin signed-message hash.
 *   - BIP-322 — the witness stack carries the public key as its last item.
 *
 * The fingerprint is hash160(compressed pubkey) — the same digest Bitcoin itself
 * uses inside an address, so it is stable across every encoding of that key. Stored
 * ALONGSIDE the address (which stays the display/lookup value), so existing rows
 * keep working.
 */

const MAGIC = 'Bitcoin Signed Message:\n';

function sha256d(bytes: Uint8Array): Uint8Array {
  return sha256(sha256(bytes));
}

/** Bitcoin's signed-message digest: sha256d(magic || varint(len) || message). */
function messageHash(message: string): Uint8Array {
  const msg = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(MAGIC);
  const len = varint(msg.length);
  const buf = new Uint8Array(prefix.length + len.length + msg.length);
  buf.set(prefix, 0);
  buf.set(len, prefix.length);
  buf.set(msg, prefix.length + len.length);
  return sha256d(buf);
}

function varint(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.from([n]);
  if (n <= 0xffff) return Uint8Array.from([0xfd, n & 0xff, (n >> 8) & 0xff]);
  return Uint8Array.from([0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
}

function hash160Hex(pubkey: Uint8Array): string {
  return Buffer.from(ripemd160(sha256(pubkey))).toString('hex');
}

/**
 * Public key out of a BIP-322 witness stack: `[count][len][item]…`, and for a
 * P2WPKH-style proof the last item is the 33-byte compressed key.
 */
function pubkeyFromWitness(sig: Uint8Array): Uint8Array | null {
  let offset = 0;
  const count = sig[offset++];
  if (!count || count > 8) return null;
  let last: Uint8Array | null = null;
  for (let i = 0; i < count; i++) {
    if (offset >= sig.length) return null;
    const len = sig[offset++];
    if (len === 0 || offset + len > sig.length) return null;
    last = sig.subarray(offset, offset + len);
    offset += len;
  }
  return last && (last.length === 33 || last.length === 65) ? last : null;
}

/**
 * Recover the secp256k1 public-key POINT that produced this signature, or null when
 * it cannot be recovered. Returning the POINT (not a hash) lets callers derive BOTH
 * the compressed and the uncompressed encodings of the key — which SMS-03 needs, see
 * `verifiedBtcKeyFingerprint`.
 */
function recoverPubkeyPoint(
  message: string,
  signatureBase64: string
): InstanceType<typeof secp256k1.ProjectivePoint> | null {
  let sig: Uint8Array;
  try {
    sig = Uint8Array.from(Buffer.from(signatureBase64.trim(), 'base64'));
  } catch {
    return null;
  }

  // BIP-137 compact: 65 bytes, first byte is the header (27..42).
  if (sig.length === 65 && sig[0] >= 27 && sig[0] <= 42) {
    try {
      // Recovery id is the header modulo 4 — the rest of the header only states the
      // address flavour, which is exactly what we are trying to ignore here.
      const recovery = (sig[0] - 27) % 4;
      const signature = secp256k1.Signature.fromCompact(sig.subarray(1)).addRecoveryBit(recovery);
      return signature.recoverPublicKey(messageHash(message));
    } catch {
      return null;
    }
  }

  const witnessKey = pubkeyFromWitness(sig);
  if (witnessKey) {
    try {
      return secp256k1.ProjectivePoint.fromHex(Buffer.from(witnessKey).toString('hex'));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Fingerprint the key that produced this signature, or null when it cannot be
 * recovered. Callers must treat null as "no fingerprint available" and fall back to
 * the address — never as an authentication failure; the signature itself is verified
 * separately by `verifyBtcSignature`.
 *
 * The fingerprint is hash160(COMPRESSED pubkey) — canonical, so one key yields one
 * fingerprint regardless of which encoding was presented.
 */
export function btcKeyFingerprint(message: string, signatureBase64: string): string | null {
  const point = recoverPubkeyPoint(message, signatureBase64);
  if (!point) return null;
  try {
    // Normalise to compressed so every encoding of the same key fingerprints identically.
    return hash160Hex(point.toRawBytes(true));
  } catch {
    return null;
  }
}

/**
 * Every standard address the same key can present, derived from its hash160.
 *
 * Needed to close the installed-base gap: credentials created before fingerprints
 * existed have `key_fingerprint = NULL`, and `WHERE key_fingerprint = $1` can never
 * match a NULL row — so one legacy key could still claim exactly one bonus account
 * by presenting a different encoding (proven 2026-07-28). Looking the SIBLING
 * ADDRESSES up by `external_ref` finds those old rows, which is the only handle we
 * have on them: an address cannot be turned back into a public key, so the column
 * cannot simply be backfilled.
 *
 * P2PKH = base58check(0x00 ‖ hash160), P2SH-P2WPKH = base58check(0x05 ‖
 * hash160(0x0014 ‖ hash160)), P2WPKH = bech32(v0, hash160).
 */
export function siblingBtcAddresses(
  fingerprintHex: string,
  network: 'bitcoin' | 'testnet' | 'regtest' = 'bitcoin'
): string[] {
  try {
    const hash160 = Buffer.from(fingerprintHex, 'hex');
    if (hash160.length !== 20) return [];
    const { payments, networks } = require('bitcoinjs-lib') as typeof import('bitcoinjs-lib');
    // F-L29: derive siblings on the CALLER's network, not a hardcoded mainnet. A
    // hardcoded `networks.bitcoin` produced bc1/1/3 encodings that can never
    // string-match a legitimate testnet (tb1…) address, so the primary Sybil-dedup
    // gate returned null for every non-mainnet BTC login and silently disabled itself.
    const net = networks[network];
    const p2wpkh = payments.p2wpkh({ hash: hash160, network: net });
    const out = [
      payments.p2pkh({ hash: hash160, network: net }).address,
      payments.p2sh({ redeem: p2wpkh, network: net }).address,
      p2wpkh.address
    ];
    return out.filter((a): a is string => typeof a === 'string' && a.length > 0);
  } catch {
    return [];
  }
}

/**
 * Verify a claimed fingerprint actually BELONGS to the address that just proved
 * ownership (F-L29). `btcKeyFingerprint` recovers a key from the signature's witness,
 * but nothing bound it to the address `verifyBtcSignature` validated — a spliced
 * witness could carry a victim's pubkey and hijack their credential-lookup key. Here
 * the recovered fingerprint is accepted ONLY if one of its network-correct sibling
 * addresses equals the proven address; otherwise it is discarded (returns null, i.e.
 * "no fingerprint" — the caller falls back to the address, never an auth failure).
 */
export function verifiedBtcKeyFingerprint(
  message: string,
  signatureBase64: string,
  address: string
): string | null {
  const point = recoverPubkeyPoint(message, signatureBase64);
  if (!point) return null;

  let fpCompressed: string;
  let fpUncompressed: string;
  try {
    fpCompressed = hash160Hex(point.toRawBytes(true));
    fpUncompressed = hash160Hex(point.toRawBytes(false));
  } catch {
    return null;
  }

  const norm = normalizeBtcAddress(address);
  const net = btcNetworkKind(address);
  // ★★★ SMS-03 FIX (2026-09-08): DERIVE THE CANDIDATE SET FROM BOTH KEY ENCODINGS.
  //
  // A legacy P2PKH address (`1…`/`m…`/`n…`) can be the hash160 of the UNCOMPRESSED
  // public key, and hash160(uncompressed) != hash160(compressed). The old code
  // derived siblings from the compressed encoding ONLY, so an uncompressed-key legacy
  // login matched none of them: `verifiedBtcKeyFingerprint` returned null, the verify
  // route wrote `key_fingerprint = undefined`, and Sybil dedup silently fell back to
  // address-only — one Bitcoin key => two unlinkable Lumen accounts (proven: a NULL
  // key_fingerprint row can never be matched by findByFingerprint).
  //
  // Deriving the candidate set from BOTH encodings makes the uncompressed-key legacy
  // address a recognised sibling. The RETURNED fingerprint stays CANONICAL —
  // hash160(compressed) — so whichever encoding proves ownership, the same one key
  // maps to the same one fingerprint. (The extra uncompressed P2SH/bech32 candidates
  // are inert: no wallet derives them, and a false match would need a 160-bit hash
  // collision with a real address.)
  const candidates = [
    ...siblingBtcAddresses(fpCompressed, net),
    ...siblingBtcAddresses(fpUncompressed, net)
  ];
  return candidates.some((a) => normalizeBtcAddress(a) === norm) ? fpCompressed : null;
}
