import { createCipheriv, createDecipheriv, createHash, randomBytes, createHmac } from 'crypto';

/**
 * Google email PII handling (spec §A.6). We store the email only as:
 *  - `email_ciphertext`: envelope-encrypted, never rendered.
 *  - `email_hash`: for abuse-blocklist joins only.
 *
 * KMS SEAM: production must supply a KMS-managed key. Here the key is read from
 * `LITE_EMAIL_ENCRYPTION_KEY` (base64, 32 bytes) via AES-256-GCM; swap this
 * module's key source for a KMS envelope call before handling real PII. The
 * hash is a KEYED HMAC-SHA256 (see emailHash — F-L36); it is used only for
 * equality joins, never exposed and never reversed by us.
 */

const KEY_B64 = process.env.LITE_EMAIL_ENCRYPTION_KEY || '';

function encryptionKey(): Buffer | null {
  if (!KEY_B64) return null;
  const key = Buffer.from(KEY_B64, 'base64');
  return key.length === 32 ? key : null;
}

/**
 * F-L36 (H-L) — KEYED hash, not a bare digest.
 *
 * This was `sha256(email)`. Email addresses have almost no entropy: given a
 * leaked table an attacker hashes a candidate list and re-identifies every user
 * outright, so an unsalted digest of an email is barely a pseudonym at all. The
 * ciphertext beside it is properly protected; this column undid that.
 *
 * The hash is only ever used as an opaque equality key (dedup / lookup), never
 * reversed by us, so keying it costs nothing functionally.
 *
 * ★ NO NEW ENV VAR, DELIBERATELY. The key is DERIVED from the existing
 * LITE_EMAIL_ENCRYPTION_KEY with a distinct, versioned info string — standard
 * key separation — so this needs no extra secret to be provisioned, rotated or
 * accidentally left unset at deploy. Anyone who could use the derived key
 * already holds the key that decrypts the addresses themselves, so it grants
 * nothing new.
 *
 * MIGRATION: hashes are not comparable across the change. Existing rows must be
 * recomputed from their stored ciphertext (`email_ciphertext`), which is why
 * that column exists — decrypt, re-hash, write back. At the time of writing no
 * deployment has ever completed a Google sign-in (the client id is still a
 * placeholder), so in practice there are no rows to migrate.
 */
const EMAIL_HASH_INFO = 'lumen-email-hash-v1';

export function emailHash(email: string): string {
  const normalized = email.trim().toLowerCase();
  const key = encryptionKey();
  if (!key) {
    // Same posture as encryptEmail: fail CLOSED in production, and in dev fall
    // back rather than block local work. The dev fallback is domain-separated
    // so a dev-computed hash can never be mistaken for a production one.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('LITE_EMAIL_ENCRYPTION_KEY is missing or not 32 bytes — refusing to write an unkeyed email hash in production');
    }
    return createHash('sha256').update(`dev-unkeyed:${normalized}`).digest('hex');
  }
  const derived = createHmac('sha256', key).update(EMAIL_HASH_INFO).digest();
  return createHmac('sha256', derived).update(normalized).digest('hex');
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
