import { query } from '../db/pool';
import { ulid } from '../ids';

/** Audit trail for lite -> full upgrades (idempotency + reconciliation, §F.2). */

export interface UpgradeEvent {
  id: string;
  userId: string;
  hiveAccountName: string;
  status: string;
  /** The owner key the user's BROWSER generated. Public — this is what makes reconciliation possible. */
  ownerPublicKey: string | null;
  createdAt: Date;
  /** Seconds since the attempt was recorded — how long the chain has had to settle it. */
  ageSeconds: number;
}

interface EventRow {
  id: string;
  user_id: string;
  hive_account_name: string;
  status: string;
  owner_public_key: string | null;
  created_at: Date;
  age_seconds: string;
}

const map = (r: EventRow): UpgradeEvent => ({
  id: r.id,
  userId: r.user_id,
  hiveAccountName: r.hive_account_name,
  status: r.status,
  ownerPublicKey: r.owner_public_key,
  createdAt: r.created_at,
  ageSeconds: Number(r.age_seconds ?? 0)
});

/**
 * Record the attempt BEFORE anything is broadcast, including the owner public key the
 * browser derived. That key is what lets a later attempt tell "the account we created"
 * from "a name somebody else took while our broadcast timed out" — the difference
 * between finishing the upgrade and handing someone an account they cannot open.
 */
export async function create(
  userId: string,
  hiveAccountName: string,
  ownerPublicKey: string
): Promise<{ id: string }> {
  const id = ulid();
  const { rows } = await query<{ id: string }>(
    `INSERT INTO upgrade_event (id, user_id, hive_account_name, status, owner_public_key)
     VALUES ($1, $2, $3, 'creating', $4) RETURNING id`,
    [id, userId, hiveAccountName, ownerPublicKey]
  );
  // Exactly one attempt may be in flight per user. Reconciliation reads the newest and
  // would otherwise be blind to an older one — which, if it had actually landed on
  // chain, is an account nobody would ever link back to its owner.
  await query(
    `UPDATE upgrade_event
        SET status = 'failed', last_error = 'superseded', updated_at = now()
      WHERE user_id = $1 AND status = 'creating' AND id <> $2`,
    [userId, id]
  );
  return { id: rows[0].id };
}

/**
 * The most recent attempt still in flight for this user — an account that may or may
 * not exist on chain, with no Lumen record that it does.
 */
export async function findInFlightByUser(userId: string): Promise<UpgradeEvent | null> {
  const { rows } = await query<EventRow>(
    `SELECT id, user_id, hive_account_name, status, owner_public_key, created_at,
            EXTRACT(EPOCH FROM (now() - created_at))::text AS age_seconds
       FROM upgrade_event
      WHERE user_id = $1 AND status = 'creating'
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId]
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function markCreated(id: string, createTrxId: string): Promise<void> {
  await query(
    `UPDATE upgrade_event SET status = 'created', create_trx_id = $2, updated_at = now() WHERE id = $1`,
    [id, createTrxId]
  );
}

export async function markSettled(id: string, settlementBatchId: string | null): Promise<void> {
  await query(
    `UPDATE upgrade_event SET status = 'settled', settlement_batch_id = $2, updated_at = now() WHERE id = $1`,
    [id, settlementBatchId]
  );
}

export async function fail(id: string, error: string): Promise<void> {
  await query(
    `UPDATE upgrade_event SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`,
    [id, error.slice(0, 2000)]
  );
}
