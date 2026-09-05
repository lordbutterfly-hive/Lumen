'use client';

/**
 * Client-side crypto for Lumen creator DMs. THE WHOLE POINT of this file is that
 * plaintext never leaves the browser and the server never holds a key that could
 * read a message. It mirrors the property `features/lite-auth/upgrade/browser-keys.ts`
 * states plainly for account keys: the private key is made here, kept here, and the
 * only thing that ever crosses the network is the PUBLIC key.
 *
 * Scheme (v1):
 *   - An X25519 keypair (`@noble/curves`, already a dependency), one PER IDENTITY.
 *     The private key lives in IndexedDB, namespaced by the caller's actor key, and is
 *     NEVER transmitted; only the public key is registered server-side.
 *   - The private key is EITHER a fresh random key (the per-device fallback) OR derived
 *     deterministically from a 32-byte seed (see `deriveSeedFromSignature` + the Hive-
 *     tier derivation in `use-direct-messages`), so an account that can produce a stable
 *     signature gets the SAME key on every device and its history stays readable.
 *   - Per message: ECDH(own private, counterparty public) -> a shared secret ->
 *     HKDF-SHA256 (Web Crypto) -> a 256-bit AES-GCM key. A fresh random 12-byte IV is
 *     the `nonce`; AES-256-GCM produces the ciphertext with its auth tag appended.
 *   - ECDH is symmetric, so ONE ciphertext serves both parties: either side re-derives
 *     the same key from its own private key and the other's public key.
 *
 * ★ IDENTITY NAMESPACING (2026-09-05). v1 stored ONE keypair per browser under a fixed
 * id, so every identity in one browser shared it: logging in as a second account reused
 * or overwrote the first's key, the server row (unique per actor) was clobbered, and
 * anything sealed to the prior key became undecryptable ("couldn't be decrypted on this
 * device"). Every keypair operation now takes the caller's actor key, so each identity
 * has its own durable slot and switching accounts never touches another identity's key.
 *
 * No new npm dependency: X25519 comes from `@noble/curves` (already used by the
 * lite-auth stack) and the symmetric cipher + KDF are the browser's built-in
 * `crypto.subtle`.
 *
 * Nothing here runs at import time: key generation, IndexedDB and `crypto.subtle`
 * are all reached only inside the exported async functions, so this module is safe
 * to have in a bundle that is evaluated during SSR (it simply is never CALLED there).
 */

import { x25519 } from '@noble/curves/ed25519';

const DB_NAME = 'lumen-dm';
const DB_VERSION = 1;
const STORE = 'keys';
// Per-identity record id. v1 used a single global 'self-x25519-v1' slot (see the
// namespacing note above); the actor key is now appended so each identity is isolated.
const SELF_KEY_PREFIX = 'self-x25519-v1';
const selfKeyId = (actorKey: string) => `${SELF_KEY_PREFIX}:${actorKey}`;

// Domain separation for the message KDF. Both sides run this exact code, so these
// constants are shared by construction; changing either would make old ciphertext
// undecryptable, which is why they are pinned here with the version in the name.
const HKDF_SALT = new TextEncoder().encode('lumen-dm-hkdf-salt-v1');
const HKDF_INFO = new TextEncoder().encode('lumen-dm-aes-256-gcm-v1');

// Separate domain separation for turning an account SIGNATURE into a keypair SEED, so
// the seed can never coincide with a message key even if the same bytes were reused.
const SEED_HKDF_SALT = new TextEncoder().encode('lumen-dm-keyseed-salt-v1');
const SEED_HKDF_INFO = new TextEncoder().encode('lumen-dm-x25519-seed-v1');

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
  /** 'random' = per-device fallback; 'derived' = deterministic from an account signature. */
  origin?: 'random' | 'derived';
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

// Per-identity in-memory cache. Keyed by actor key so an SPA account switch (no reload)
// never returns the previous identity's keypair. Only ever mirrors what is persisted.
const cached = new Map<string, DmKeypair>();

// Single-flight per identity: two callers, or two tabs racing the very first use, must
// not each generate a different keypair and then fight over which one persists (the
// losing tab's private key would be lost, orphaning any ciphertext sealed to it). A
// promise per actor key collapses concurrent first-use into one generation.
const inflight = new Map<string, Promise<DmKeypair>>();

export interface KeypairOptions {
  /**
   * A >=32-byte seed to derive the keypair from DETERMINISTICALLY (see
   * `deriveSeedFromSignature`), so the same account produces the same key on every
   * device and its history stays readable. When absent, a random key is generated (the
   * per-device fallback for tiers that cannot sign a fixed message deterministically).
   * IGNORED once a key already exists for this identity - the stored key always wins,
   * so a seed change can never silently orphan existing ciphertext.
   */
  deriveSeed?: Uint8Array;
}

/**
 * The identity's DM keypair, created on first use and persisted under a slot namespaced
 * by `actorKey`. The private key never leaves this module.
 */
export async function getOrCreateKeypair(actorKey: string, opts?: KeypairOptions): Promise<DmKeypair> {
  if (!actorKey) throw new Error('A signed-in identity is required for messaging keys');

  const hit = cached.get(actorKey);
  if (hit) return hit;

  const pending = inflight.get(actorKey);
  if (pending) return pending;

  const work = (async (): Promise<DmKeypair> => {
    const stored = await idbGet(selfKeyId(actorKey));
    if (stored) {
      const kp: DmKeypair = {
        privateKey: base64ToBytes(stored.privateKeyB64),
        publicKey: base64ToBytes(stored.publicKeyB64),
        keyVersion: stored.keyVersion
      };
      cached.set(actorKey, kp);
      return kp;
    }

    const derived = Boolean(opts?.deriveSeed);
    const privateKey = derived ? derivePrivateKeyFromSeed(opts!.deriveSeed as Uint8Array) : x25519.utils.randomPrivateKey();
    const publicKey = x25519.getPublicKey(privateKey);
    const record: StoredKeypair = {
      privateKeyB64: bytesToBase64(privateKey),
      publicKeyB64: bytesToBase64(publicKey),
      keyVersion: 1,
      createdAt: Date.now(),
      origin: derived ? 'derived' : 'random'
    };
    await idbPut(selfKeyId(actorKey), record);
    const kp: DmKeypair = { privateKey, publicKey, keyVersion: 1 };
    cached.set(actorKey, kp);
    return kp;
  })();

  inflight.set(actorKey, work);
  try {
    return await work;
  } finally {
    inflight.delete(actorKey);
  }
}

/**
 * Turn a >=32-byte seed into an X25519 private key. x25519 clamps the scalar internally,
 * so any 32 uniformly-random bytes are a valid private key; the seed is already the
 * HKDF output over a signature, so it is taken straight (first 32 bytes). Kept tiny and
 * pure so the derivation is auditable in one place.
 */
function derivePrivateKeyFromSeed(seed: Uint8Array): Uint8Array {
  if (seed.length < 32) throw new Error('DM key seed must be at least 32 bytes');
  return seed.slice(0, 32);
}

/**
 * Turn an account SIGNATURE (a stable, deterministic signature over a fixed message,
 * produced only by signers that truly sign - see the tier gate in use-direct-messages)
 * into a 32-byte X25519 seed via HKDF-SHA256. Deterministic: the same signature always
 * yields the same seed, so the same account derives the same keypair on every device.
 */
export async function deriveSeedFromSignature(signature: string): Promise<Uint8Array> {
  const ikm = new TextEncoder().encode(signature);
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: SEED_HKDF_SALT, info: SEED_HKDF_INFO },
    key,
    256
  );
  return new Uint8Array(bits);
}

/** The only value that may cross the network. Base64 of the 32-byte X25519 public key. */
export async function getPublicKeyBase64(actorKey: string, opts?: KeypairOptions): Promise<string> {
  const { publicKey } = await getOrCreateKeypair(actorKey, opts);
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
 * Encrypt `plaintext` to `recipientPublicKeyBase64` as `actorKey`. Returns the wire form
 * the send route stores verbatim: a base64 `nonce` (the 12-byte IV) and a base64
 * `ciphertext` (AES-GCM output with the auth tag appended). The server sees only these.
 */
export async function encrypt(
  actorKey: string,
  recipientPublicKeyBase64: string,
  plaintext: string
): Promise<{ nonce: string; ciphertext: string }> {
  const { privateKey } = await getOrCreateKeypair(actorKey);
  const recipientPub = base64ToBytes(recipientPublicKeyBase64);
  const shared = x25519.getSharedSecret(privateKey, recipientPub);
  const key = await deriveMessageKey(shared);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return { nonce: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ct)) };
}

/**
 * Decrypt one message from `counterpartyPublicKeyBase64` as `actorKey`. Because ECDH is
 * symmetric, this same call works whether the counterparty SENT the message or RECEIVED
 * it: the shared secret is ECDH(my private, their public) either way. Throws if the tag
 * does not verify (wrong key, tampering, or a key rotation the caller has not accounted
 * for) so the UI can render an honest "couldn't decrypt" rather than garbage.
 */
export async function decrypt(
  actorKey: string,
  counterpartyPublicKeyBase64: string,
  nonce: string,
  ciphertext: string
): Promise<string> {
  const { privateKey } = await getOrCreateKeypair(actorKey);
  const counterpartyPub = base64ToBytes(counterpartyPublicKeyBase64);
  const shared = x25519.getSharedSecret(privateKey, counterpartyPub);
  const key = await deriveMessageKey(shared);
  const iv = base64ToBytes(nonce);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, base64ToBytes(ciphertext));
  return new TextDecoder().decode(pt);
}
