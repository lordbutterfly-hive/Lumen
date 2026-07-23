import { query } from '../db/pool';
import { ulid } from '../ids';

/** Audit trail for lite -> full upgrades (idempotency + reconciliation, §F.2). */

export async function create(userId: string, hiveAccountName: string): Promise<{ id: string }> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO upgrade_event (id, user_id, hive_account_name, status)
     VALUES ($1, $2, $3, 'creating') RETURNING id`,
    [ulid(), userId, hiveAccountName]
  );
  return { id: rows[0].id };
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
