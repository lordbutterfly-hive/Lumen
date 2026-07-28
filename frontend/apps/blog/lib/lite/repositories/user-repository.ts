import { Exec, query } from '../db/pool';
import { ulid } from '../ids';
import { AccountTier, LumenProfile, LumenUser, UserStatus } from '../types';

interface UserRow {
  user_id: string;
  display_name: string;
  display_name_history: string[];
  avatar_url: string | null;
  profile: LumenProfile | null;
  account_tier: string;
  hive_account_name: string | null;
  trust_score: number;
  status: string;
  suspended_reason: string | null;
  created_at: Date;
  updated_at: Date;
  upgraded_at: Date | null;
  suspended_at: Date | null;
}

function mapUser(r: UserRow): LumenUser {
  return {
    userId: r.user_id,
    displayName: r.display_name,
    displayNameHistory: Array.isArray(r.display_name_history) ? r.display_name_history : [],
    avatarUrl: r.avatar_url,
    profile: r.profile ?? {},
    accountTier: r.account_tier as AccountTier,
    hiveAccountName: r.hive_account_name,
    trustScore: r.trust_score,
    status: r.status as UserStatus,
    suspendedReason: r.suspended_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    upgradedAt: r.upgraded_at,
    suspendedAt: r.suspended_at
  };
}

const SELECT = 'SELECT * FROM lumen_user';

export async function createUser(
  input: {
    displayName: string;
    avatarUrl?: string | null;
  },
  exec: Exec = query
): Promise<LumenUser> {
  const { rows } = await exec<UserRow>(
    `INSERT INTO lumen_user (user_id, display_name, avatar_url)
     VALUES ($1, $2, $3) RETURNING *`,
    [ulid(), input.displayName, input.avatarUrl ?? null]
  );
  return mapUser(rows[0]);
}

export async function findUserById(userId: string): Promise<LumenUser | null> {
  const { rows } = await query<UserRow>(`${SELECT} WHERE user_id = $1`, [userId]);
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function findUserByDisplayName(displayName: string): Promise<LumenUser | null> {
  const { rows } = await query<UserRow>(`${SELECT} WHERE display_name = $1`, [displayName]);
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function findUserByHiveAccountName(hiveAccountName: string): Promise<LumenUser | null> {
  const { rows } = await query<UserRow>(`${SELECT} WHERE hive_account_name = $1`, [hiveAccountName]);
  return rows[0] ? mapUser(rows[0]) : null;
}

/**
 * Flip a lite account to full after the on-chain account is created (spec §F).
 * The `account_tier = 'lite'` guard makes this idempotent — a second call finds
 * no lite row and returns null. `user_id` never changes (history continuity).
 */
export async function markUpgraded(
  userId: string,
  hiveAccountName: string
): Promise<LumenUser | null> {
  const { rows } = await query<UserRow>(
    `UPDATE lumen_user
       SET hive_account_name = $2, account_tier = 'full', status = 'upgraded', upgraded_at = now()
     WHERE user_id = $1 AND account_tier = 'lite'
     RETURNING *`,
    [userId, hiveAccountName]
  );
  return rows[0] ? mapUser(rows[0]) : null;
}

/**
 * Replace the account's public profile.
 *
 * Written whole rather than merged: the settings form always submits every field, and
 * a merge would make clearing one impossible (an absent key and an emptied key look
 * the same). `avatar_url` is kept in step with `profile.profile_image` because the
 * avatar endpoint reads the column directly and having the two disagree would show a
 * different face on a byline than on the profile page.
 */
export async function updateProfile(
  userId: string,
  profile: LumenProfile
): Promise<LumenUser | null> {
  const { rows } = await query<UserRow>(
    `UPDATE lumen_user
        SET profile = $2::jsonb,
            avatar_url = NULLIF($3, ''),
            updated_at = now()
      WHERE user_id = $1
      RETURNING *`,
    [userId, JSON.stringify(profile), profile.profile_image ?? '']
  );
  return rows[0] ? mapUser(rows[0]) : null;
}

/** Batch map on-chain account names -> lite user (upgraded users' direct posts, §E.4). */
export async function findUsersByHiveAccountNames(names: string[]): Promise<LumenUser[]> {
  if (names.length === 0) return [];
  const { rows } = await query<UserRow>(`${SELECT} WHERE hive_account_name = ANY($1::text[])`, [
    names
  ]);
  return rows.map(mapUser);
}

/**
 * Which of these names are already spoken for inside Lumen — as a current handle OR
 * as an upgraded account's Hive name. One query.
 *
 * Used to filter name suggestions: Hive availability alone is not enough, because a
 * name free on chain can still be another Lumen user's handle, and offering it would
 * mean the picker says "yes" and the upgrade then says "taken".
 */
export async function findNamesInUse(names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  const { rows } = await query<{ name: string }>(
    `SELECT display_name AS name FROM lumen_user WHERE display_name = ANY($1::citext[])
     UNION
     SELECT hive_account_name AS name FROM lumen_user WHERE hive_account_name = ANY($1::citext[])`,
    [names]
  );
  return new Set(rows.map((r) => String(r.name).toLowerCase()));
}

/** Batch id lookup — one query for a whole feed page, never one per post. */
export async function findUsersByIds(userIds: string[]): Promise<LumenUser[]> {
  if (userIds.length === 0) return [];
  const { rows } = await query<UserRow>(`${SELECT} WHERE user_id = ANY($1::text[])`, [userIds]);
  return rows.map(mapUser);
}

/**
 * Set an account's status. `suspended`/`banned` were valid values in the schema that
 * NOTHING ever wrote — the moderation model existed on paper only.
 *
 * Suspension is intentionally reversible (back to 'active') and always records a
 * reason: a moderation action nobody can explain later is not a moderation action.
 */
export async function setUserStatus(
  userId: string,
  status: 'active' | 'suspended' | 'banned',
  reason: string | null
): Promise<LumenUser | null> {
  const res = await query<UserRow>(
    `UPDATE lumen_user
        SET status = $2,
            suspended_reason = CASE WHEN $2 = 'active' THEN NULL ELSE $3 END,
            suspended_at = CASE WHEN $2 = 'active' THEN NULL ELSE COALESCE(suspended_at, now()) END,
            updated_at = now()
      WHERE user_id = $1
      RETURNING *`,
    [userId, status, reason]
  );
  return res.rows[0] ? mapUser(res.rows[0]) : null;
}
