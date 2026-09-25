import { query } from '../db/pool';
import { FollowActor, actorKey } from '../social/follow-actor';

/**
 * The DM public-key registry (migration 0040, made append-only by 0046).
 *
 * ★★★ PUBLIC KEYS ONLY. The private half is generated in the browser and never leaves
 * it (same doctrine as migration 0018's account keys). This table stores the X25519
 * messaging public keys a counterparty encrypts to, plus the `key_version` that lets a
 * rotation stay unambiguous.
 *
 * An identity is a `FollowActor` — a lite user by id or a Hive account by name — and is
 * keyed by the generated `actor_key`, exactly as `block-repository.ts` keys the block
 * graph, so a key registered as a lite account still resolves after the account
 * upgrades to a real Hive one.
 *
 * ★★★ IT IS A HISTORY, NOT A SLOT (2026-09-13). Rotation used to UPDATE the row in
 * place, destroying the previous PUBLIC key — while every message in
 * `lumen_dm_message` recorded the `recipient_key_version` it was sealed to. The
 * schema assumed a history nothing kept, and on production half the messages (9 of
 * 18) already pointed at overwritten keys.
 *
 * The loss was asymmetric and only half of it was inherent. Whoever rotates loses
 * their own history because their PRIVATE key is gone from that browser. Their
 * counterparty lost it as well purely because the server discarded a public key —
 * not a secret, and the one thing they needed to keep reading their own messages.
 * Rotation now appends, so that second half no longer happens.
 */

export interface DmPublicKey {
  publicKey: string;
  keyVersion: number;
}

/** The CURRENT public key for one identity, or null if they have never set one. */
export async function getPublicKey(actor: FollowActor): Promise<DmPublicKey | null> {
  const { rows } = await query<{ public_key: string; key_version: number }>(
    `SELECT public_key, key_version FROM lumen_dm_key
      WHERE actor_key = $1
      ORDER BY key_version DESC
      LIMIT 1`,
    [actorKey(actor)]
  );
  const row = rows[0];
  return row ? { publicKey: row.public_key, keyVersion: row.key_version } : null;
}

/**
 * The public key a specific message was sealed to.
 *
 * This is the read that makes the history worth keeping: a client decrypting an old
 * message asks for the version stamped on that message, not for whatever is current,
 * so the counterparty rotating cannot retroactively break it.
 *
 * Returns null for a version that predates the history (anything overwritten before
 * migration 0046) rather than falling back to the current key — a wrong key produces
 * a silent garbage decrypt, and "we cannot read this" is the honest answer.
 */
export async function getPublicKeyAtVersion(
  actor: FollowActor,
  keyVersion: number
): Promise<DmPublicKey | null> {
  if (!Number.isInteger(keyVersion) || keyVersion < 1) return null;
  const { rows } = await query<{ public_key: string; key_version: number }>(
    `SELECT public_key, key_version FROM lumen_dm_key WHERE actor_key = $1 AND key_version = $2`,
    [actorKey(actor), keyVersion]
  );
  const row = rows[0];
  return row ? { publicKey: row.public_key, keyVersion: row.key_version } : null;
}

/**
 * Register the caller's OWN public key, or append a rotation.
 *
 * Re-registering the SAME key is idempotent: it returns the existing row untouched,
 * so a browser that re-registers on every visit never churns the version a
 * counterparty has cached. A genuinely different key appends the next version and
 * leaves every earlier one readable.
 *
 * ★ THE INSERT IS CONDITIONAL ON THE CURRENT VERSION (`WHERE NOT EXISTS`), which is
 * what makes two tabs racing safe: the unique index on (actor_key, key_version) means
 * the loser of the race fails its insert rather than silently writing a second row at
 * the same version, and the read-back below then returns whichever key actually won.
 */
export class KeyReplaceRefusedError extends Error {
  constructor() {
    super('key_exists');
  }
}

export async function registerPublicKey(
  actor: FollowActor,
  publicKey: string,
  backup: string | null = null,
  startOver = false
): Promise<DmPublicKey> {
  const current = await getPublicKey(actor);
  if (current && current.publicKey === publicKey) {
    // Same key again: only its first backup is stored. A later one could only be
    // another copy of the same private key, and replacing a working backup with an
    // unreadable one would end the account's other devices.
    if (backup) await setBackupIfMissing(actor, current.keyVersion, backup);
    return current;
  }
  /*
   * ★★★ A DIFFERENT KEY NEVER REPLACES THE CURRENT ONE UNLESS THE OWNER ASKED (2026-09-25).
   * A new version makes the account's whole history unreadable to its owner: the private
   * key those messages were sealed with is not on the device that made the new one. (The
   * people they wrote to keep reading, through the versions kept here.) Before this, any
   * signed-in POST of a different key appended one silently: how `daveks` lost theirs
   * (2026-09-13), and what an old browser tab still running the previous client would do
   * after a deploy. Now only an explicit "start over" from the inbox, which says what it
   * costs before the press, may do it.
   */
  if (current && !startOver) throw new KeyReplaceRefusedError();

  const nextVersion = (current?.keyVersion ?? 0) + 1;
  const { rows } = await query<{ public_key: string; key_version: number }>(
    `INSERT INTO lumen_dm_key (user_id, hive, public_key, key_version, backup)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING public_key, key_version`,
    [actor.userId ?? null, actor.hive ?? null, publicKey, nextVersion, backup]
  );
  if (rows[0]) return { publicKey: rows[0].public_key, keyVersion: rows[0].key_version };
  // Lost a race with another tab: the row at `nextVersion` already exists. Read back
  // what is actually stored rather than asserting what we tried to write.
  const settled = await getPublicKey(actor);
  return settled ?? { publicKey, keyVersion: nextVersion };
}

/**
 * Does this identity already have a key registered somewhere else?
 *
 * The client calls this BEFORE minting a fresh keypair, because minting one when a
 * key already exists is what silently orphans a history: the browser has no local
 * private half (new device, cleared storage, private window), so it would generate a
 * new pair, append a version, and leave every earlier message unreadable to its owner
 * with no warning and no undo. Measured on production: `daveks` did exactly that on
 * 2026-09-13 at 06:12.
 */
export async function hasRegisteredKey(actor: FollowActor): Promise<boolean> {
  return (await getPublicKey(actor)) !== null;
}

async function setBackupIfMissing(actor: FollowActor, keyVersion: number, backup: string): Promise<void> {
  await query(
    `UPDATE lumen_dm_key SET backup = $3, updated_at = now()
      WHERE actor_key = $1 AND key_version = $2 AND backup IS NULL`,
    [actorKey(actor), keyVersion, backup]
  );
}

export interface DmOwnKey extends DmPublicKey {
  /** The encrypted backup of this version's private key, or null when there is none. */
  backup: string | null;
}

/** The identity's CURRENT key with its backup. For the owner only (see dm-service). */
export async function getOwnKeyWithBackup(actor: FollowActor): Promise<DmOwnKey | null> {
  const { rows } = await query<{ public_key: string; key_version: number; backup: string | null }>(
    `SELECT public_key, key_version, backup FROM lumen_dm_key
      WHERE actor_key = $1
      ORDER BY key_version DESC
      LIMIT 1`,
    [actorKey(actor)]
  );
  const row = rows[0];
  return row ? { publicKey: row.public_key, keyVersion: row.key_version, backup: row.backup } : null;
}
