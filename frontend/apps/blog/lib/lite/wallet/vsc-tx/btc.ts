/**
 * Bitcoin wallet signing for Magi transactions.
 *
 * ★★ BTC CANNOT BE REHEARSED ON TESTNET. `dids.Parse` (dids.go:43-53) tries
 * `ParseEthDID` then `ParseBtcDID` — MAINNET ONLY — and never
 * `ParseBtcTestnetDID`, which exists but is referenced only by an address
 * classifier. Every verification helper in btc.go is hardcoded to
 * `chaincfg.MainNetParams`. So a testnet BTC identity cannot be parsed as a DID
 * at all, and THE FIRST BITCOIN TRANSACTION IS REAL MAINNET MONEY. Ship it
 * behind a flag, with a small amount, after the EVM rail has run in anger.
 *
 * ★ BTC SIGNS SOMETHING COMPLETELY DIFFERENT FROM EVM. The EVM rail signs
 * EIP-712 typed data built from the shell's CBOR. Bitcoin signs the shell's
 * **CID STRING** as a plain Bitcoin Signed Message (btc.go:135). The user is
 * shown an opaque `bafyrei…` in their wallet. Nothing can make that legible
 * without a node change, so the UI must explain it rather than hide it.
 *
 * ★★ THE SIGNED MESSAGE HAS NO DOMAIN SEPARATION, AND THAT IS A NODE-SIDE GAP
 * THIS CLIENT CANNOT CLOSE. The node hashes the bare CID with the standard
 * `\x18Bitcoin Signed Message:\n` prefix and nothing else — no protocol tag, no
 * chain id. So a signature harvested by ANY other context that asks a user to
 * "sign this message to prove you own this address" is a valid Magi
 * authorisation, because every input the attacker needs is public: the nonce
 * (`getAccountNonce`), the contract, the net id, and the payload is theirs to
 * choose. They compute the CID and only need the victim to sign that string.
 *
 * The EVM rail is immune: EIP-712 binds `vsc.network` and `tx_container_v0`
 * into the hash, so a typed-data signature cannot be obtained from a
 * `personal_sign` prompt. Bitcoin has no equivalent.
 *
 * Nothing here can fix it — the preimage is the node's. Filed as N-0 in
 * LUMEN-DOCS/multichain/NODE-BUGS-TO-FILE-2026-08-20.md. What this client CAN
 * do is tell Bitcoin users plainly not to sign opaque strings elsewhere, which
 * is why `meritum_eligibility.wallet_btc_signing_warning` exists.
 *
 * ★ TWO SIGNATURE FORMATS, CHOSEN BY LENGTH (btc.go:119-129):
 *   - 65 bytes  → BIP-137 compact, valid for p2pkh / p2sh / p2wpkh
 *   - otherwise → BIP-322 simple, accepted ONLY for p2wpkh
 * Taproot (`bc1p`) is refused at DID parse (btc.go:52) and is already blocked
 * at connect time in appkit.ts. Keep that block and SAY WHY in the UI: Xverse,
 * Unisat, OKX and Phantom all present a taproot address prominently, so a user
 * will pick one unless told not to.
 */

import { dagCborCid } from './cid';

/** What a Bitcoin wallet is asked to sign: the signing shell's CID string. */
export async function btcSigningMessage(shellBytes: Uint8Array): Promise<string> {
  return dagCborCid(shellBytes);
}

/**
 * Rewrite a BIP-137 recovery header into the range Go will accept.
 *
 * ★ THE PROBLEM. Go's `ecdsa.RecoverCompact` accepts recovery bytes only in
 * [27, 34] — the legacy P2PKH range. Real SegWit wallets do not emit those:
 * P2SH-P2WPKH emits 35-38 and native P2WPKH emits 39-42. The signature is
 * cryptographically fine; only the header byte is outside what the verifier
 * will parse, so it fails as "failed to recover public key" and looks like a
 * broken wallet.
 *
 * ★★ NEVER APPLY THIS TO THE LOGIN VERIFIER. `lib/lite/auth/btc-verify.ts`
 * verifies an ownership proof, and normalising a header there would accept a
 * signature the wallet did not make in the form it claimed. Normalise for a
 * TRANSACTION, never for a login. The two paths are deliberately separate
 * files for exactly this reason.
 */
export function normalizeBip137Header(sigBase64: string): string {
  // ★ THIS RUNS BEFORE `assertBtcSignature`, so it is the FIRST thing to touch
  // whatever the wallet returned — including a rejection string or null. It
  // used to call `atob` unguarded, so `'not base64 !!!'` surfaced a raw
  // `DOMException: Invalid character` to the user and the friendly message
  // below became unreachable (adversarial review, 2026-08-20). Anything
  // undecodable is handed on untouched for `assertBtcSignature` to refuse with
  // a sentence.
  if (typeof sigBase64 !== 'string' || sigBase64.length === 0) return sigBase64;
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(sigBase64);
  } catch {
    return sigBase64;
  }
  if (bytes.length !== 65) return sigBase64; // BIP-322: pass through untouched.

  const header = bytes[0];
  let normalized = header;
  if (header >= 35 && header <= 38) normalized = header - 4; // P2SH-P2WPKH
  else if (header >= 39 && header <= 42) normalized = header - 8; // native P2WPKH
  if (normalized === header) return sigBase64;

  const out = Uint8Array.from(bytes);
  out[0] = normalized;
  return bytesToBase64(out);
}

/**
 * Refuse a signature the node will certainly reject, before it costs a nonce.
 *
 * The high-S check mirrors the node's own (btc.go:141-146): a 65-byte compact
 * signature is [header|R|S] and the verifier rejects the high-S form outright,
 * so catching it here turns a mystery refusal into a sentence.
 */
export function assertBtcSignature(sigBase64: string, addressType: 'p2pkh' | 'p2sh' | 'p2wpkh'): void {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(sigBase64);
  } catch {
    throw new Error('btc: the wallet returned a signature that is not valid base64');
  }

  if (bytes.length !== 65) {
    if (addressType !== 'p2wpkh') {
      throw new Error(
        `btc: a ${addressType} address can only use a 65-byte BIP-137 signature; BIP-322 is accepted ` +
          'only for native segwit (bc1q) addresses.'
      );
    }
    // ★ THIS BRANCH USED TO ACCEPT ANYTHING, and it is the DEFAULT PATH FOR
    // LEATHER, which returns BIP-322 for every bc1q address. An empty string, a
    // 3-byte blob, or the literal text "user rejected" all sailed through and
    // were submitted, burning a wallet prompt to reach a node-side
    // "BIP-322: empty witness data" (adversarial review, 2026-08-20).
    //
    // A BIP-322 "simple" signature is a serialised witness stack: a count, then
    // length-prefixed items. For P2WPKH it is exactly two — a DER signature and
    // a 33-byte compressed public key. Checking the shape here is not a
    // substitute for the node's verification; it is the difference between
    // "that didn't work" and "your wallet returned something that is not a
    // signature".
    assertBip322WitnessShape(bytes);
    return;
  }

  const header = bytes[0];
  if (header < 27 || header > 42) {
    throw new Error(`btc: unrecognised BIP-137 recovery header ${header}`);
  }

  // ★ THE HIGH-S CHECK, WHICH THIS FUNCTION USED TO ONLY CLAIM TO DO. The
  // comment above described mirroring the node's canonical-S rule while the
  // body did not implement it (adversarial review, 2026-08-20), so a high-S
  // wallet signature passed our gate, cost the user a wallet prompt and a
  // submit, and was refused by the node with "non-canonical signature". A
  // compact signature is [header|R|S]; the node requires 0 < S <= N/2
  // (btc.go:139-146) so that one (key, message) has exactly one valid encoding.
  const s = bytesToBigInt(bytes.subarray(33, 65));
  if (s <= 0n || s > SECP256K1_HALF_ORDER) {
    throw new Error(
      'btc: this wallet produced a non-canonical (high-S) signature, which the node refuses. Signing again usually yields a canonical one.'
    );
  }
  if (header > 34) {
    throw new Error(
      `btc: recovery header ${header} must be normalised before submission — call normalizeBip137Header.`
    );
  }
}

/** secp256k1 group order N, halved — the canonical-S ceiling (btc.go). */
const SECP256K1_HALF_ORDER =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

function bytesToBigInt(bytes: Uint8Array): bigint {
  let out = 0n;
  for (const b of bytes) out = (out << 8n) | BigInt(b);
  return out;
}

/**
 * Refuse a BIP-322 blob that is not a witness stack of the shape P2WPKH needs.
 *
 * Deliberately structural and minimal: count == 2, a non-empty first item, and
 * a 33-byte compressed pubkey second. It does not attempt to validate the DER
 * signature — that is the node's job and duplicating it here would be a second
 * implementation to keep in step.
 */
function assertBip322WitnessShape(bytes: Uint8Array): void {
  let i = 0;
  const need = (n: number): void => {
    if (i + n > bytes.length) {
      throw new Error(
        'btc: the wallet returned a truncated BIP-322 signature (the witness data runs past the end).'
      );
    }
  };

  need(1);
  const items = bytes[i++];
  if (items !== 2) {
    throw new Error(
      `btc: expected a 2-item BIP-322 witness for a native segwit address, got ${items}. ` +
        'This usually means the wallet returned an error string rather than a signature.'
    );
  }

  need(1);
  const sigLen = bytes[i++];
  if (sigLen === 0) throw new Error('btc: the BIP-322 witness carries an empty signature.');
  need(sigLen);
  i += sigLen;

  need(1);
  const keyLen = bytes[i++];
  if (keyLen !== 33) {
    throw new Error(
      `btc: the BIP-322 witness carries a ${keyLen}-byte public key; native segwit requires a 33-byte compressed key.`
    );
  }
  need(keyLen);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
}
