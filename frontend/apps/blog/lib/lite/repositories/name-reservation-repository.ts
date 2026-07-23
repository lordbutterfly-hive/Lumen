import { query } from '../db/pool';
import { NameReservation, NameReservationStatus } from '../types';

interface ReservationRow {
  display_name_norm: string;
  status: string;
  user_id: string | null;
  created_at: Date;
  expires_at: Date | null;
}

function mapReservation(r: ReservationRow): NameReservation {
  return {
    displayNameNorm: r.display_name_norm,
    status: r.status as NameReservationStatus,
    userId: r.user_id,
    createdAt: r.created_at,
    expiresAt: r.expires_at
  };
}

/** Normalize a display name to its reservation key. */
export function normalizeName(displayName: string): string {
  return displayName.trim().toLowerCase();
}

/**
 * Phase 1 of the two-phase claim (spec §B.2): take a short-lived PENDING hold.
 * Returns true iff this caller now holds the reservation. The unique PK arbitrates
 * concurrent signups; an existing PENDING hold that has expired is reclaimable,
 * an ACTIVE reservation is never overwritten.
 */
export async function reservePending(nameNorm: string, ttlSeconds: number): Promise<boolean> {
  const { rows } = await query<{ display_name_norm: string }>(
    `INSERT INTO name_reservation (display_name_norm, status, expires_at)
     VALUES ($1, 'pending', now() + make_interval(secs => $2))
     ON CONFLICT (display_name_norm) DO UPDATE
       SET expires_at = EXCLUDED.expires_at, created_at = now()
       WHERE name_reservation.status = 'pending' AND name_reservation.expires_at < now()
     RETURNING display_name_norm`,
    [nameNorm, ttlSeconds]
  );
  return rows.length > 0;
}

/** Phase 2 of the two-phase claim: promote a held PENDING reservation to ACTIVE. */
export async function promoteToActive(nameNorm: string, userId: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE name_reservation
       SET status = 'active', user_id = $2, expires_at = NULL
     WHERE display_name_norm = $1 AND status = 'pending'`,
    [nameNorm, userId]
  );
  return (rowCount ?? 0) > 0;
}

/** Release a PENDING hold (e.g. the live Hive check failed). ACTIVE is never released here. */
export async function releasePending(nameNorm: string): Promise<void> {
  await query(`DELETE FROM name_reservation WHERE display_name_norm = $1 AND status = 'pending'`, [
    nameNorm
  ]);
}

export async function findReservation(nameNorm: string): Promise<NameReservation | null> {
  const { rows } = await query<ReservationRow>(
    `SELECT * FROM name_reservation WHERE display_name_norm = $1`,
    [nameNorm]
  );
  return rows[0] ? mapReservation(rows[0]) : null;
}
