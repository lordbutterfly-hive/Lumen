/**
 * Hive memo encryption (the `#...` format Keychain, PeakVault, beekeeper and the Hive
 * wallets all read), for the one login that holds its key in the page: WIF.
 *
 * Every other Hive signer encrypts and decrypts memos itself (Keychain's
 * requestEncodeWithKeys / requestVerifyKey, and so on). A WIF login has no extension,
 * and the only other implementation Lumen ships is beekeeper, which is a WebAssembly
 * build loaded on the server only. So this is the format, written once:
 *
 *   shared  = sha512( x( ECDH(priv, otherPub) ) )
 *   ek      = sha512( nonce_u64_le || shared );  key = ek[0..32], iv = ek[32..48]
 *   check   = sha256(ek)[0..4]
 *   body    = AES-256-CBC(key, iv, varint(len) || utf8(text))   (PKCS#7)
 *   memo    = "#" + base58( fromPub33 || toPub33 || nonce8 || check4 || varint(len) || body )
 *
 * Tested against beekeeper in both directions (lib/__tests__/hive-memo.test.ts), which is
 * what makes a backup written here readable by Keychain on another device and back.
 *
 * The private key never leaves this module except as the caller's own input, and
 * nothing here runs at import time.
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { ripemd160 } from '@noble/hashes/ripemd160';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error('Not base58');
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of text) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function varint(n: number): Uint8Array {
  const out: number[] = [];
  let v = n >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return new Uint8Array(out);
}

function readVarint(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    if (i >= bytes.length || shift > 28) throw new Error('Bad memo length');
    const b = bytes[i++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value: value >>> 0, next: i };
}

/** A WIF (base58: 0x80 || key32 || checksum4) to its 32-byte private key. Throws on a bad checksum. */
export function privateKeyFromWif(wif: string): Uint8Array {
  const raw = base58Decode(wif.trim());
  if (raw.length !== 37 || raw[0] !== 0x80) throw new Error('Not a WIF private key');
  const body = raw.slice(0, 33);
  if (!equal(sha256(sha256(body)).slice(0, 4), raw.slice(33))) throw new Error('WIF checksum mismatch');
  return raw.slice(1, 33);
}

/** Compressed public key -> "STM..." (base58 of key || ripemd160(key)[0..4]). */
export function publicKeyToString(pub33: Uint8Array, prefix = 'STM'): string {
  return prefix + base58Encode(concat(pub33, ripemd160(pub33).slice(0, 4)));
}

/** "STM..." (or any 3-letter chain prefix) -> compressed public key. Throws on a bad checksum. */
export function publicKeyFromString(text: string): Uint8Array {
  const raw = base58Decode(text.trim().slice(3));
  if (raw.length !== 37) throw new Error('Not a Hive public key');
  const key = raw.slice(0, 33);
  if (!equal(ripemd160(key).slice(0, 4), raw.slice(33))) throw new Error('Public key checksum mismatch');
  return key;
}

export function publicKeyOfWif(wif: string, prefix = 'STM'): string {
  return publicKeyToString(secp256k1.getPublicKey(privateKeyFromWif(wif), true), prefix);
}

async function derive(priv32: Uint8Array, otherPub33: Uint8Array, nonce8: Uint8Array) {
  const shared = sha512(secp256k1.getSharedSecret(priv32, otherPub33, true).slice(1));
  const ek = sha512(concat(nonce8, shared));
  const key = await crypto.subtle.importKey('raw', ek.slice(0, 32), 'AES-CBC', false, ['encrypt', 'decrypt']);
  return { key, iv: ek.slice(32, 48), check: sha256(ek).slice(0, 4) };
}

/** Encrypt `text` from the WIF's key to `toPublicKey`, as a "#..." memo. */
export async function encodeMemo(wif: string, toPublicKey: string, text: string): Promise<string> {
  const priv = privateKeyFromWif(wif);
  const from = secp256k1.getPublicKey(priv, true);
  const to = publicKeyFromString(toPublicKey);
  const nonce = crypto.getRandomValues(new Uint8Array(8));
  const { key, iv, check } = await derive(priv, to, nonce);
  const utf8 = new TextEncoder().encode(text);
  const body = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, concat(varint(utf8.length), utf8))
  );
  return '#' + base58Encode(concat(from, to, nonce, check, varint(body.length), body));
}

/** Decrypt a "#..." memo (the "#" is optional) with the WIF of either end. Throws if it is not for this key. */
export async function decodeMemo(wif: string, memo: string): Promise<string> {
  const priv = privateKeyFromWif(wif);
  const mine = secp256k1.getPublicKey(priv, true);
  const raw = base58Decode(memo.trim().replace(/^#/, ''));
  if (raw.length < 33 + 33 + 8 + 4 + 1) throw new Error('Not a memo');
  const from = raw.slice(0, 33);
  const to = raw.slice(33, 66);
  const nonce = raw.slice(66, 74);
  const check = raw.slice(74, 78);
  const { value: len, next } = readVarint(raw, 78);
  const body = raw.slice(next, next + len);
  if (body.length !== len) throw new Error('Truncated memo');
  let other: Uint8Array;
  if (equal(mine, to)) other = from;
  else if (equal(mine, from)) other = to;
  else throw new Error('This memo is not for this key');
  const { key, iv, check: expected } = await derive(priv, other, nonce);
  if (!equal(check, expected)) throw new Error('Memo check failed');
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, body));
  const { value: textLen, next: start } = readVarint(plain, 0);
  return new TextDecoder().decode(plain.slice(start, start + textLen));
}
