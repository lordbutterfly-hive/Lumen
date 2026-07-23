import { query } from '../db/pool';
import { ulid } from '../ids';
import { AccountTier, LumenUser, UserStatus } from '../types';

interface UserRow {
  user_id: string;
  display_name: string;
  display_name_history: string[];
  avatar_url: string | null;
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

export async function createUser(input: {
  displayName: string;
  avatarUrl?: string | null;
}): Promise<LumenUser> {
  const { rows } = await query<UserRow>(
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
       SET hive_account_name = $2, account_tier = 'full', upgraded_at = now()
     WHERE user_id = $1 AND account_tier = 'lite'
     RETURNING *`,
    [userId, hiveAccountName]
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
