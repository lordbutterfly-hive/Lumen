import { query } from '../db/pool';
import { ulid } from '../ids';
import { AuthMethod, LumenAuthCredential } from '../types';

interface CredentialRow {
  credential_id: string;
  user_id: string;
  method: string;
  external_ref: string;
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
}

export async function createCredential(input: CreateCredentialInput): Promise<LumenAuthCredential> {
  const { rows } = await query<CredentialRow>(
    `INSERT INTO lumen_auth_credential (
       credential_id, user_id, method, external_ref, network,
       webauthn_credential_id, webauthn_public_key_cose, webauthn_sign_count,
       email_ciphertext, email_hash, device_label, is_primary
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
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
      input.isPrimary ?? false
    ]
  );
  return mapCredential(rows[0]);
}

/** Resolve a binder to its account. This is the login lookup (spec §A.1). */
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
