'use client';

/**
 * Client-side crypto for Lumen creator DMs. THE WHOLE POINT of this file is that
 * plaintext never leaves the browser and the server never holds a key that could
 * read a message. It mirrors the property `features/lite-auth/upgrade/browser-keys.ts`
 * states plainly for account keys: the private key is made here, kept here, and the
 * only thing that ever crosses the network is the PUBLIC key.
 *
 * Scheme (locked, v1):
 *   - A per-browser X25519 keypair (`@noble/curves`, already a dependency). The
 *     private key lives in IndexedDB and is NEVER transmitted; only the public key
 *     is registered server-side.
 *   - Per message: ECDH(own private, counterparty public) -> a shared secret ->
 *     HKDF-SHA256 (Web Crypto) -> a 256-bit AES-GCM key. A fresh random 12-byte IV
 *     is the `nonce`; AES-256-GCM produces the ciphertext with its auth tag appended.
 *   - ECDH is symmetric, so ONE ciphertext serves both parties: either side re-derives
 *     the same key from its own private key and the other's public key.
 *
 * No new npm dependency: X25519 comes from `@noble/curves` (already used by the
 * lite-auth stack) and the symmetric cipher + KDF are the browser's built-in
 * `crypto.subtle`. The 24-byte-nonce XChaCha design from the build map is replaced
 * one-for-one by AES-256-GCM here; the wire shape (a `nonce` and a `ciphertext`,
 * both base64) is identical, so the server's BYTEA columns are unaffected.
 *
 * Nothing here runs at import time: key generation, IndexedDB and `crypto.subtle`
 * are all reached only inside the exported async functions, so this module is safe
 * to have in a bundle that is evaluated during SSR (it simply is never CALLED there).
 */

import { x25519 } from '@noble/curves/ed25519';

const DB_NAME = 'lumen-dm';
const DB_VERSION = 1;
const STORE = 'keys';
// One record per browser under this id. v1 is single-key; a future rotation would
// write a new id and bump the stored keyVersion rather than overwrite this one.
const SELF_KEY_ID = 'self-x25519-v1';

// Domain separation for the KDF. Both sides run this exact code, so these constants
// are shared by construction; changing either would make old ciphertext undecryptable,
// which is why they are pinned here with the version in the name.
const HKDF_SALT = new TextEncoder().encode('lumen-dm-hkdf-salt-v1');
const HKDF_INFO = new TextEncoder().encode('lumen-dm-aes-256-gcm-v1');

export interface DmKeypair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  /** v1 is always 1. Carried so the send path can report senderKeyVersion honestly. */
  keyVersion: number;
}

interface StoredKeypair {
  privateKeyB64: string;
  publicKeyB64: string;
  keyVersion: number;
  createdAt: number;
}

/* ---------- base64 (binary-safe, no Node Buffer) ---------- */

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/* ---------- IndexedDB (minimal promise wrapper, no new dependency) ---------- */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      // Private-mode or a non-browser context. Surfaced as a clear failure rather
      // than silently losing the key: messaging cannot work without persistent
      // local storage for the private key, and the UI says so honestly.
      reject(new Error('This browser has no IndexedDB, so private messaging is unavailable here.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

function idbGet(id: string): Promise<StoredKeypair | undefined> {
  return openDb().then(
    (db) =>
      new Promise<StoredKeypair | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(id);
        req.onsuccess = () => resolve(req.result as StoredKeypair | undefined);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'));
      })
  );
}

function idbPut(id: string, value: StoredKeypair): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
      })
  );
}

/* ---------- keypair ---------- */

// In-memory cache so repeated encrypt/decrypt calls in one session do not re-hit
// IndexedDB. It is only ever the value already persisted; it is never the sole copy.
let cached: DmKeypair | null = null;

/**
 * The browser's DM keypair, created on first use and persisted. The private key is
 * generated by noble's CSPRNG and, exactly as in `browser-keys.ts`, never leaves
 * this module.
 */
export async function getOrCreateKeypair(): Promise<DmKeypair> {
  if (cached) return cached;

  const existing = await idbGet(SELF_KEY_ID);
  if (existing) {
    cached = {
      privateKey: base64ToBytes(existing.privateKeyB64),
      publicKey: base64ToBytes(existing.publicKeyB64),
      keyVersion: existing.keyVersion
    };
    return cached;
  }

  const privateKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(privateKey);
  const record: StoredKeypair = {
    privateKeyB64: bytesToBase64(privateKey),
    publicKeyB64: bytesToBase64(publicKey),
    keyVersion: 1,
    createdAt: Date.now()
  };
  await idbPut(SELF_KEY_ID, record);
  cached = { privateKey, publicKey, keyVersion: 1 };
  return cached;
}

/** The only value that may cross the network. Base64 of the 32-byte X25519 public key. */
export async function getPublicKeyBase64(): Promise<string> {
  const { publicKey } = await getOrCreateKeypair();
  return bytesToBase64(publicKey);
}

/* ---------- AEAD ---------- */

async function deriveMessageKey(sharedSecret: Uint8Array): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: HKDF_INFO },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt `plaintext` to `recipientPublicKeyBase64`. Returns the wire form the send
 * route stores verbatim: a base64 `nonce` (the 12-byte IV) and a base64 `ciphertext`
 * (AES-GCM output with the auth tag appended). The server sees only these two blobs.
 */
export async function encrypt(
  recipientPublicKeyBase64: string,
  plaintext: string
): Promise<{ nonce: string; ciphertext: string }> {
  const { privateKey } = await getOrCreateKeypair();
  const recipientPub = base64ToBytes(recipientPublicKeyBase64);
  const shared = x25519.getSharedSecret(privateKey, recipientPub);
  const key = await deriveMessageKey(shared);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return { nonce: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ct)) };
}

/**
 * Decrypt one message from `counterpartyPublicKeyBase64`. Because ECDH is symmetric,
 * this same call works whether the counterparty SENT the message or RECEIVED it: the
 * shared secret is ECDH(my private, their public) either way. Throws if the tag does
 * not verify (wrong key, tampering, or a key rotation the caller has not accounted
 * for) so the UI can render an honest "couldn't decrypt" rather than garbage.
 */
export async function decrypt(
  counterpartyPublicKeyBase64: string,
  nonce: string,
  ciphertext: string
): Promise<string> {
  const { privateKey } = await getOrCreateKeypair();
  const counterpartyPub = base64ToBytes(counterpartyPublicKeyBase64);
  const shared = x25519.getSharedSecret(privateKey, counterpartyPub);
  const key = await deriveMessageKey(shared);
  const iv = base64ToBytes(nonce);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, base64ToBytes(ciphertext));
  return new TextDecoder().decode(pt);
}
