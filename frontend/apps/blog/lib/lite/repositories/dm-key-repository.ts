import { query } from '../db/pool';
import { FollowActor, actorKey } from '../social/follow-actor';

/**
 * The DM public-key registry (migration 0040).
 *
 * ★★★ PUBLIC KEYS ONLY. The private half is generated in the browser and never leaves
 * it (same doctrine as migration 0018's account keys). This table stores the one
 * X25519 messaging public key per Lumen identity that counterparties encrypt to, plus
 * the `key_version` that lets a rotation stay unambiguous.
 *
 * An identity is a `FollowActor` — a lite user by id or a Hive account by name — and is
 * keyed by the generated `actor_key`, exactly as `block-repository.ts` keys the block
 * graph, so a key registered as a lite account still resolves after the account
 * upgrades to a real Hive one.
 */

export interface DmPublicKey {
  publicKey: string;
  keyVersion: number;
}

/** The registered public key for one identity, or null if they have never set one. */
export async function getPublicKey(actor: FollowActor): Promise<DmPublicKey | null> {
  const { rows } = await query<{ public_key: string; key_version: number }>(
    `SELECT public_key, key_version FROM lumen_dm_key WHERE actor_key = $1`,
    [actorKey(actor)]
  );
  const row = rows[0];
  return row ? { publicKey: row.public_key, keyVersion: row.key_version } : null;
}

/**
 * Register (or rotate) the caller's OWN public key.
 *
 * `key_version` is bumped ONLY when the stored key actually changes, so re-registering
 * the same browser key on every visit is idempotent and does not churn the version a
 * counterparty has cached. A genuine rotation (a new key) increments it. When the
 * ON CONFLICT WHERE filters the update out (same key), the current row is read back so
 * the caller always receives the stored key and version.
 */
export async function registerPublicKey(actor: FollowActor, publicKey: string): Promise<DmPublicKey> {
  const { rows } = await query<{ public_key: string; key_version: number }>(
    `INSERT INTO lumen_dm_key (user_id, hive, public_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (actor_key) DO UPDATE
       SET public_key = EXCLUDED.public_key,
           key_version = lumen_dm_key.key_version + 1,
           updated_at = now()
       WHERE lumen_dm_key.public_key <> EXCLUDED.public_key
     RETURNING public_key, key_version`,
    [actor.userId ?? null, actor.hive ?? null, publicKey]
  );
  if (rows[0]) return { publicKey: rows[0].public_key, keyVersion: rows[0].key_version };
  // The conflict fired but the key was unchanged, so nothing was returned — the row
  // exists, read it back. The `?? ` is only to keep the types honest; it cannot be hit.
  const current = await getPublicKey(actor);
  return current ?? { publicKey, keyVersion: 1 };
}
