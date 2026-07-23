import { query } from '../db/pool';

/**
 * Atomic fixed-window rate counters (spec §H). `checkAndConsume` increments and
 * checks in a single statement so concurrent requests can't race past the cap.
 */

/** True if the action is allowed (and consumed); false if the window cap is hit. */
export async function checkAndConsume(
  subject: string,
  action: string,
  limit: number,
  windowKey: string
): Promise<boolean> {
  if (limit <= 0) return false;
  const { rows } = await query<{ count: number }>(
    `INSERT INTO rate_counter (subject, action, window_key, count)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (subject, action, window_key)
       DO UPDATE SET count = rate_counter.count + 1, updated_at = now()
       WHERE rate_counter.count < $4
     RETURNING count`,
    [subject, action, windowKey, limit]
  );
  return rows.length > 0;
}

export async function currentCount(
  subject: string,
  action: string,
  windowKey: string
): Promise<number> {
  const { rows } = await query<{ count: number }>(
    `SELECT count FROM rate_counter WHERE subject = $1 AND action = $2 AND window_key = $3`,
    [subject, action, windowKey]
  );
  return rows[0]?.count ?? 0;
}

/** Housekeeping — drop counters for elapsed windows. Returns rows removed. */
export async function cleanupOldCounters(): Promise<number> {
  const { rowCount } = await query(
    `DELETE FROM rate_counter WHERE updated_at < now() - interval '2 days'`
  );
  return rowCount ?? 0;
}
