import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { GeneratedKeys } from './account-creator';

/**
 * Envelope encryption for the reveal-once outbox (`key_reveal`).
 *
 * This is the one place in the whole lite system that puts private keys at rest, so
 * the rules are stricter than for the email envelope:
 *
 *  - Its own key (`LITE_KEY_REVEAL_ENCRYPTION_KEY`), never shared with the PII key.
 *    Different blast radius, different rotation cadence: leaking the email key must
 *    not also unlock account keys.
 *  - It NEVER degrades. `encryptEmail` returns null without a key in dev; doing that
 *    here would silently write a row with no keys in it and reintroduce exactly the
 *    lockout this table exists to prevent. Missing or malformed key = throw, in every
 *    environment. `isKeyRevealConfigured()` lets the caller check this BEFORE the
 *    irreversible `create_claimed_account`, so the refusal happens while refusing is
 *    still free.
 *  - The plaintext is a JSON GeneratedKeys. Decryption re-validates the shape rather
 *    than trusting it, so a key rotation or a truncated blob surfaces as "cannot read
 *    these" instead of a half-populated key object the user would copy down as real.
 *
 * KMS SEAM: production should swap the raw env key for a KMS data-key call. The
 * interface (encryptKeys / decryptKeys) is what the rest of the system depends on.
 */

const KEY_ENV = 'LITE_KEY_REVEAL_ENCRYPTION_KEY';

function encryptionKey(): Buffer {
  const b64 = process.env[KEY_ENV] || '';
  if (!b64) {
    throw new Error(
      `${KEY_ENV} is not set — refusing to create a Hive account whose keys could not be durably stored`
    );
  }
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) {
    throw new Error(`${KEY_ENV} must be 32 bytes base64-encoded (got ${key.length})`);
  }
  return key;
}

/**
 * Pre-flight check for the upgrade path. Deliberately non-throwing: the caller turns
 * this into a clean "not configured" refusal before anything irreversible happens.
 */
export function isKeyRevealConfigured(): boolean {
  try {
    encryptionKey();
    return true;
  } catch {
    return false;
  }
}

/** Returns iv(12) || authTag(16) || ciphertext. Throws if the key is unusable. */
export function encryptKeys(keys: GeneratedKeys): Buffer {
  const key = encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(keys), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function looksLikeGeneratedKeys(value: unknown): value is GeneratedKeys {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.masterPassword !== 'string' || !v.masterPassword) return false;
  return (['owner', 'active', 'posting', 'memo'] as const).every((role) => {
    const pair = v[role];
    if (typeof pair !== 'object' || pair === null) return false;
    const p = pair as Record<string, unknown>;
    return typeof p.publicKey === 'string' && typeof p.privateWif === 'string' && !!p.privateWif;
  });
}

/**
 * Returns null rather than throwing when the blob cannot be read (rotated key,
 * truncated row, tampered ciphertext). The caller must treat null as "these keys are
 * gone" and say so plainly — never as an empty success.
 */
export function decryptKeys(blob: Buffer): GeneratedKeys | null {
  try {
    const key = encryptionKey();
    const iv = blob.subarray(0, 12);
    const authTag = blob.subarray(12, 28);
    const ciphertext = blob.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const parsed: unknown = JSON.parse(plaintext);
    return looksLikeGeneratedKeys(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
