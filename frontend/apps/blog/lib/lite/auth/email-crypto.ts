import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * Google email PII handling (spec §A.6). We store the email only as:
 *  - `email_ciphertext`: envelope-encrypted, never rendered.
 *  - `email_hash`: for abuse-blocklist joins only.
 *
 * KMS SEAM: production must supply a KMS-managed key. Here the key is read from
 * `LITE_EMAIL_ENCRYPTION_KEY` (base64, 32 bytes) via AES-256-GCM; swap this
 * module's key source for a KMS envelope call before handling real PII. The
 * hash algorithm (sha256) is an internal choice (the spec suggested keccak);
 * it is used only for equality joins, never exposed.
 */

const KEY_B64 = process.env.LITE_EMAIL_ENCRYPTION_KEY || '';

function encryptionKey(): Buffer | null {
  if (!KEY_B64) return null;
  const key = Buffer.from(KEY_B64, 'base64');
  return key.length === 32 ? key : null;
}

export function emailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

/** Returns iv(12) || authTag(16) || ciphertext, or null if no key is configured. */
export function encryptEmail(email: string): Buffer | null {
  const key = encryptionKey();
  if (!key) {
    // LS-3 (PRUNED 2026-07-22): fail CLOSED in production. A missing/invalid key
    // silently returning null drops the PII ciphertext (degrading abuse/support
    // tooling) — refuse loudly instead. In dev the null pass-through is fine.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('LITE_EMAIL_ENCRYPTION_KEY is missing or not 32 bytes — refusing to silently drop PII in production');
    }
    return null;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(email, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptEmail(blob: Buffer): string | null {
  const key = encryptionKey();
  if (!key) return null;
  try {
    const iv = blob.subarray(0, 12);
    const authTag = blob.subarray(12, 28);
    const ciphertext = blob.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
