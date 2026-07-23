import { query } from '../db/pool';
import { nonce as makeNonce } from '../ids';
import { ChallengePurpose, LumenChallenge } from '../types';

interface ChallengeRow {
  nonce: string;
  user_id: string | null;
  purpose: string;
  payload_hash: string | null;
  issued_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}

function mapChallenge(r: ChallengeRow): LumenChallenge {
  return {
    nonce: r.nonce,
    userId: r.user_id,
    purpose: r.purpose as ChallengePurpose,
    payloadHash: r.payload_hash,
    issuedAt: r.issued_at,
    expiresAt: r.expires_at,
    consumedAt: r.consumed_at
  };
}

export async function createChallenge(input: {
  purpose: ChallengePurpose;
  ttlSeconds: number;
  userId?: string | null;
  payloadHash?: string | null;
}): Promise<LumenChallenge> {
  const { rows } = await query<ChallengeRow>(
    `INSERT INTO lumen_challenge (nonce, user_id, purpose, payload_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5)) RETURNING *`,
    [makeNonce(), input.userId ?? null, input.purpose, input.payloadHash ?? null, input.ttlSeconds]
  );
  return mapChallenge(rows[0]);
}

/**
 * Atomically consume a challenge: marks it consumed and returns it only if it
 * exists, matches the purpose, is unexpired, and was not already consumed.
 * The single UPDATE...RETURNING makes this replay-safe under concurrency.
 */
export async function consumeChallenge(
  nonce: string,
  purpose: ChallengePurpose
): Promise<LumenChallenge | null> {
  const { rows } = await query<ChallengeRow>(
    `UPDATE lumen_challenge
       SET consumed_at = now()
     WHERE nonce = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()
     RETURNING *`,
    [nonce, purpose]
  );
  return rows[0] ? mapChallenge(rows[0]) : null;
}

/** Housekeeping — drop consumed/expired challenge rows. Returns rows removed. */
export async function deleteExpired(): Promise<number> {
  const { rowCount } = await query(
    `DELETE FROM lumen_challenge WHERE expires_at < now() OR consumed_at IS NOT NULL`
  );
  return rowCount ?? 0;
}
