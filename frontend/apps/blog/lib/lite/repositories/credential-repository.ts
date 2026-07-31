import { Exec, query } from '../db/pool';
import { ulid } from '../ids';
import { AuthMethod, LumenAuthCredential } from '../types';

interface CredentialRow {
  credential_id: string;
  user_id: string;
  method: string;
  external_ref: string;
  key_fingerprint: string | null;
  network: string | null;
  webauthn_credential_id: string | null;
  webauthn_public_key_cose: Buffer | null;
  webauthn_sign_count: string; // BIGINT arrives as string from pg
  email_ciphertext: Buffer | null;
  email_hash: string | null;
  device_label: string | null;
  is_primary: boolean;
  created_at: Date;
  last_used_at: Date | null;
}

function mapCredential(r: CredentialRow): LumenAuthCredential {
  return {
    credentialId: r.credential_id,
    userId: r.user_id,
    method: r.method as AuthMethod,
    externalRef: r.external_ref,
    keyFingerprint: r.key_fingerprint,
    network: r.network,
    webauthnCredentialId: r.webauthn_credential_id,
    webauthnPublicKeyCose: r.webauthn_public_key_cose,
    webauthnSignCount: Number(r.webauthn_sign_count),
    emailCiphertext: r.email_ciphertext,
    emailHash: r.email_hash,
    deviceLabel: r.device_label,
    isPrimary: r.is_primary,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at
  };
}

export interface CreateCredentialInput {
  userId: string;
  method: AuthMethod;
  externalRef: string;
  network?: string | null;
  webauthnCredentialId?: string | null;
  webauthnPublicKeyCose?: Buffer | null;
  webauthnSignCount?: number;
  emailCiphertext?: Buffer | null;
  emailHash?: string | null;
  deviceLabel?: string | null;
  isPrimary?: boolean;
  /** hash160(compressed pubkey) — one key, one credential (BTC). */
  keyFingerprint?: string | null;
}

export async function createCredential(
  input: CreateCredentialInput,
  exec: Exec = query
): Promise<LumenAuthCredential> {
  const { rows } = await exec<CredentialRow>(
    `INSERT INTO lumen_auth_credential (
       credential_id, user_id, method, external_ref, network,
       webauthn_credential_id, webauthn_public_key_cose, webauthn_sign_count,
       email_ciphertext, email_hash, device_label, is_primary, key_fingerprint
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [
      ulid(),
      input.userId,
      input.method,
      input.externalRef,
      input.network ?? null,
      input.webauthnCredentialId ?? null,
      input.webauthnPublicKeyCose ?? null,
      input.webauthnSignCount ?? 0,
      input.emailCiphertext ?? null,
      input.emailHash ?? null,
      input.deviceLabel ?? null,
      input.isPrimary ?? false,
      input.keyFingerprint ?? null
    ]
  );
  return mapCredential(rows[0]);
}

/** Resolve a binder to its account. This is the login lookup (spec §A.1). */
/**
 * Find a credential by the KEY that signed, not by the address it was encoded as.
 * One Bitcoin key yields three address formats; matching on the fingerprint is what
 * stops the same key registering three accounts.
 */
export async function findByFingerprint(
  method: AuthMethod,
  keyFingerprint: string
): Promise<LumenAuthCredential | null> {
  const res = await query<CredentialRow>(
    `SELECT * FROM lumen_auth_credential WHERE method = $1 AND key_fingerprint = $2`,
    [method, keyFingerprint]
  );
  return res.rows[0] ? mapCredential(res.rows[0]) : null;
}

export async function findByMethodAndRef(
  method: AuthMethod,
  externalRef: string
): Promise<LumenAuthCredential | null> {
  const { rows } = await query<CredentialRow>(
    `SELECT * FROM lumen_auth_credential WHERE method = $1 AND external_ref = $2`,
    [method, externalRef]
  );
  return rows[0] ? mapCredential(rows[0]) : null;
}

export async function findByWebauthnCredentialId(
  webauthnCredentialId: string
): Promise<LumenAuthCredential | null> {
  const { rows } = await query<CredentialRow>(
    `SELECT * FROM lumen_auth_credential WHERE webauthn_credential_id = $1`,
    [webauthnCredentialId]
  );
  return rows[0] ? mapCredential(rows[0]) : null;
}

export async function listByUser(userId: string): Promise<LumenAuthCredential[]> {
  const { rows } = await query<CredentialRow>(
    `SELECT * FROM lumen_auth_credential WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId]
  );
  return rows.map(mapCredential);
}

export async function touchLastUsed(credentialId: string): Promise<void> {
  await query(`UPDATE lumen_auth_credential SET last_used_at = now() WHERE credential_id = $1`, [
    credentialId
  ]);
}

/**
 * Persist a strictly-increasing WebAuthn sign count. Rejects a non-increasing
 * value (clone/replay signal) by refusing the update and returning false.
 */
export async function updateSignCount(
  credentialId: string,
  newSignCount: number
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE lumen_auth_credential
       SET webauthn_sign_count = $2, last_used_at = now()
     WHERE credential_id = $1 AND $2 > webauthn_sign_count`,
    [credentialId, newSignCount]
  );
  return (rowCount ?? 0) > 0;
}

/** Backfill the key fingerprint onto a credential that predates the column. */
export async function setKeyFingerprint(credentialId: string, keyFingerprint: string): Promise<void> {
  await query(
    `UPDATE lumen_auth_credential SET key_fingerprint = $2
      WHERE credential_id = $1 AND key_fingerprint IS NULL`,
    [credentialId, keyFingerprint]
  );
}

/** Append-only audit of a bind/unbind (F-L2, migration 0022). Never throws the caller
 *  off the happy path for an audit-write failure is a policy decision left to callers. */
export async function writeCredentialAudit(
  userId: string,
  credentialId: string | null,
  action: 'bind' | 'unbind',
  method: string | null
): Promise<void> {
  await query(
    `INSERT INTO lumen_credential_audit (audit_id, user_id, credential_id, action, method)
     VALUES ($1, $2, $3, $4, $5)`,
    [ulid(), userId, credentialId, action, method]
  );
}

export type UnbindResult = 'ok' | 'last_credential' | 'not_found';

/**
 * Remove a linked sign-in method (F-L2). REFUSES to remove the account's last
 * credential — a lite account with zero credentials is unrecoverable (no password, no
 * email), so this is the one deletion that must never succeed. Ownership is enforced by
 * scoping every read/write to `user_id`, so one user can never unbind another's method.
 * Writes an `unbind` audit row on success.
 */
export async function unbindMethod(userId: string, credentialId: string): Promise<UnbindResult> {
  const { rows } = await query<CredentialRow>(
    `SELECT * FROM lumen_auth_credential WHERE user_id = $1`,
    [userId]
  );
  if (rows.length < 2) return 'last_credential'; // cannot remove the only way in
  const target = rows.find((r) => r.credential_id === credentialId);
  if (!target) return 'not_found';
  await query(`DELETE FROM lumen_auth_credential WHERE credential_id = $1 AND user_id = $2`, [
    credentialId,
    userId
  ]);
  await writeCredentialAudit(userId, credentialId, 'unbind', target.method);
  return 'ok';
}
