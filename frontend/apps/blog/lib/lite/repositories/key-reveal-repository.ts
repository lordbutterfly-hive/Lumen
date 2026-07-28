import { query } from '../db/pool';
import { ulid } from '../ids';

/**
 * The reveal-once outbox (migration 0015). Holds the encrypted keys of a freshly
 * created Hive account for the short window between "the account exists on chain" and
 * "the user says they have written the keys down".
 *
 * Every read here is scoped by user_id AND unexpired AND ciphertext-present. There is
 * deliberately no "find by reveal_id" that skips the owner check: a reveal id is not a
 * capability, it is a label.
 */

export type KeyRevealStatus = 'pending_create' | 'available' | 'uncertain' | 'acknowledged' | 'expired';

export interface OutstandingReveal {
  revealId: string;
  userId: string;
  hiveAccountName: string;
  status: KeyRevealStatus;
  ciphertext: Buffer;
  fetchCount: number;
  expiresAt: Date;
  createdAt: Date;
}

interface RevealRow {
  reveal_id: string;
  user_id: string;
  hive_account_name: string;
  status: string;
  ciphertext: Buffer;
  fetch_count: number;
  expires_at: Date;
  created_at: Date;
}

function mapReveal(r: RevealRow): OutstandingReveal {
  return {
    revealId: r.reveal_id,
    userId: r.user_id,
    hiveAccountName: r.hive_account_name,
    status: r.status as KeyRevealStatus,
    ciphertext: r.ciphertext,
    fetchCount: r.fetch_count,
    expiresAt: r.expires_at,
    createdAt: r.created_at
  };
}

/**
 * Written BEFORE `create_claimed_account`. If this insert fails the upgrade aborts
 * while aborting is still free — that is the point.
 */
export async function create(params: {
  userId: string;
  upgradeEventId: string;
  hiveAccountName: string;
  ciphertext: Buffer;
  ttlHours: number;
}): Promise<{ revealId: string }> {
  const revealId = ulid();
  await query(
    `INSERT INTO key_reveal
       (reveal_id, user_id, upgrade_event_id, hive_account_name, status, ciphertext, expires_at)
     VALUES ($1, $2, $3, $4, 'pending_create', $5, now() + make_interval(hours => $6))`,
    [revealId, params.userId, params.upgradeEventId, params.hiveAccountName, params.ciphertext, params.ttlHours]
  );
  return { revealId };
}

/** The account is confirmed on chain — these keys are now definitely the real ones. */
export async function markAvailable(revealId: string, createTrxId: string): Promise<void> {
  await query(
    `UPDATE key_reveal SET status = 'available', create_trx_id = $2, updated_at = now()
     WHERE reveal_id = $1`,
    [revealId, createTrxId]
  );
}

/**
 * Creation failed in a way we cannot interpret (a broadcast timeout may still have
 * landed). The row KEEPS its ciphertext on purpose: if the account did make it on
 * chain, this is the only copy of its keys.
 */
export async function markUncertain(revealId: string): Promise<void> {
  await query(
    `UPDATE key_reveal SET status = 'uncertain', updated_at = now() WHERE reveal_id = $1`,
    [revealId]
  );
}

/**
 * Creation definitively did NOT happen (we checked and the account does not exist), so
 * the keys are meaningless and should not sit at rest. Drops the ciphertext, keeps the
 * audit row.
 */
export async function discard(revealId: string): Promise<void> {
  await query(
    `UPDATE key_reveal SET status = 'expired', ciphertext = NULL, updated_at = now()
     WHERE reveal_id = $1`,
    [revealId]
  );
}

/** The newest set of keys this user is still owed, or null. */
export async function findOutstandingByUser(userId: string): Promise<OutstandingReveal | null> {
  const { rows } = await query<RevealRow>(
    `SELECT reveal_id, user_id, hive_account_name, status, ciphertext, fetch_count, expires_at, created_at
       FROM key_reveal
      WHERE user_id = $1 AND ciphertext IS NOT NULL AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId]
  );
  return rows[0] ? mapReveal(rows[0]) : null;
}

/** Audit counter — how many times these keys were handed back, and when last. */
export async function recordFetch(revealId: string): Promise<void> {
  await query(
    `UPDATE key_reveal SET fetch_count = fetch_count + 1, last_fetched_at = now(), updated_at = now()
     WHERE reveal_id = $1`,
    [revealId]
  );
}

/**
 * The user confirmed they have the keys. Scoped by user_id so a reveal id alone can
 * never destroy someone else's only copy. Returns false if it was not theirs to ack.
 */
export async function acknowledge(revealId: string, userId: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE key_reveal
        SET status = 'acknowledged', ciphertext = NULL, acknowledged_at = now(), updated_at = now()
      WHERE reveal_id = $1 AND user_id = $2 AND ciphertext IS NOT NULL`,
    [revealId, userId]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Hygiene sweep: drop key material past its window. Reads already filter on
 * `expires_at`, so this changes no behaviour — it just stops keys living at rest
 * forever because one user never came back.
 */
export async function purgeExpired(): Promise<number> {
  const { rowCount } = await query(
    `UPDATE key_reveal SET status = 'expired', ciphertext = NULL, updated_at = now()
      WHERE ciphertext IS NOT NULL AND expires_at <= now()`
  );
  return rowCount ?? 0;
}
