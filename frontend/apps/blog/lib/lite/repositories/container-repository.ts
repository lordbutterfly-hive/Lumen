import { query } from '../db/pool';
import { ulid } from '../ids';
import { LumenContainer } from '../types';

interface ContainerRow {
  container_id: string;
  hive_author: string;
  hive_permlink: string;
  status: string;
  child_count: number;
  max_children: number;
  opened_at: Date;
  published_at: Date | null;
  closed_at: Date | null;
  last_error: string | null;
}

function map(r: ContainerRow): LumenContainer {
  return {
    containerId: r.container_id,
    hiveAuthor: r.hive_author,
    hivePermlink: r.hive_permlink,
    status: r.status as LumenContainer['status'],
    childCount: Number(r.child_count),
    maxChildren: Number(r.max_children),
    openedAt: r.opened_at,
    publishedAt: r.published_at,
    closedAt: r.closed_at,
    lastError: r.last_error
  };
}

/** Permlink derived from the id, so a child payload can name its parent early. */
export function containerPermlink(containerId: string): string {
  return `lumen-c-${containerId.toLowerCase()}`;
}

/**
 * Reserve one child slot in the live container, creating a fresh container when
 * there is none or the current one is full.
 *
 * NO `FOR UPDATE SKIP LOCKED` HERE — that was a real bug (a 30-post concurrent
 * burst orphaned 1 post, 2026-07-28). SKIP LOCKED is for claiming one row out of
 * MANY ready rows; against the SINGLE live-container row it makes every caller but
 * the lock holder see *zero* rows, so they all stampede into "close full + create
 * new", collide on `ux_container_live_per_account`, retry, and one eventually
 * exhausts its retries and throws.
 *
 * Instead: a plain UPDATE whose target comes from an unlocked sub-select. Concurrent
 * UPDATEs to the same row serialise on Postgres' row write lock, and READ COMMITTED
 * re-evaluates the WHERE clause against the *updated* row after the lock is granted
 * — so the repeated `child_count < max_children` guard still makes overshooting the
 * cap impossible, without anyone being told "no rows".
 */
export async function reserveChildSlot(
  hiveAuthor: string,
  maxChildren: number
): Promise<LumenContainer> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const taken = await query<ContainerRow>(
      `UPDATE lumen_container
          SET child_count = child_count + 1
        WHERE container_id = (
                SELECT container_id
                  FROM lumen_container
                 WHERE hive_author = $1
                   AND status IN ('opening', 'open')
                   AND child_count < max_children
                 ORDER BY opened_at
                 LIMIT 1
              )
          AND child_count < max_children
       RETURNING *`,
      [hiveAuthor]
    );
    if (taken.rows[0]) return map(taken.rows[0]);

    // Nothing live with room: close what is full, then open a new one.
    await query(
      `UPDATE lumen_container
          SET status = 'closed', closed_at = now()
        WHERE hive_author = $1
          AND status IN ('opening', 'open')
          AND child_count >= max_children`,
      [hiveAuthor]
    );

    const containerId = ulid();
    try {
      const created = await query<ContainerRow>(
        `INSERT INTO lumen_container
           (container_id, hive_author, hive_permlink, status, child_count, max_children)
         VALUES ($1, $2, $3, 'opening', 1, $4)
         RETURNING *`,
        [containerId, hiveAuthor, containerPermlink(containerId), maxChildren]
      );
      return map(created.rows[0]);
    } catch (error) {
      // Lost the create race (unique violation on the live-container index) — loop
      // and reserve a slot in whichever container the winner created.
      const code = (error as { code?: string }).code;
      if (code !== '23505') throw error;
    }
  }
  throw new Error('Could not reserve a container slot after repeated contention');
}

export async function findByPermlink(
  hiveAuthor: string,
  hivePermlink: string
): Promise<LumenContainer | null> {
  const res = await query<ContainerRow>(
    `SELECT * FROM lumen_container WHERE hive_author = $1 AND hive_permlink = $2`,
    [hiveAuthor, hivePermlink]
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

/** Root post is on chain: the container may now receive children. Idempotent. */
export async function markPublished(containerId: string): Promise<void> {
  await query(
    `UPDATE lumen_container
        SET published_at = COALESCE(published_at, now()),
            status = CASE WHEN status = 'opening' THEN 'open' ELSE status END,
            last_error = NULL
      WHERE container_id = $1`,
    [containerId]
  );
}

export async function recordError(containerId: string, message: string): Promise<void> {
  await query(`UPDATE lumen_container SET last_error = $2 WHERE container_id = $1`, [
    containerId,
    message.slice(0, 2000)
  ]);
}

/** Live container for an account, if any (diagnostics / admin views). */
export async function findLive(hiveAuthor: string): Promise<LumenContainer | null> {
  const res = await query<ContainerRow>(
    `SELECT * FROM lumen_container
      WHERE hive_author = $1 AND status IN ('opening', 'open')
      ORDER BY opened_at
      LIMIT 1`,
    [hiveAuthor]
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}
