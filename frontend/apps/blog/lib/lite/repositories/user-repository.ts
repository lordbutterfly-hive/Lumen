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
  session_epoch: number;
  interests: string[] | null;
  interests_set_at: Date | null;
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
    sessionEpoch: r.session_epoch ?? 0,
    interests: Array.isArray(r.interests) ? r.interests : [],
    // NULL means "never asked" -> show the picker. An empty array with a
    // timestamp means "asked, chose to skip" -> never nag again. Collapsing
    // those two would re-prompt forever anyone who declined.
    interestsSetAt: r.interests_set_at,
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
    // session_epoch + 1 is UNCONDITIONAL (F-L3): every upgrade must kill the
    // pre-upgrade lite cookie so a freshly upgraded user can no longer proxy-post
    // through the shared account with their old session (checkLiteActorById refuses
    // the stale epoch). This is a single WHERE account_tier='lite' UPDATE, so it
    // only ever fires on the one row being upgraded.
    `UPDATE lumen_user
       SET hive_account_name = $2, account_tier = 'full', status = 'upgraded',
           upgraded_at = now(), session_epoch = session_epoch + 1
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
 * Batch map CURRENT LUMEN HANDLES -> lite user.
 *
 * Deliberately a separate function from {@link findUsersByHiveAccountNames} rather
 * than one "find by any name" query, because the two namespaces are not
 * interchangeable and collapsing them misidentifies people. A lite handle is by
 * construction a name that was FREE on Hive at signup, so `@alice` the Lumen handle
 * and `@alice` the Hive account can be two different human beings. A caller that
 * knows which namespace it is holding — a chain-signed entry's author is a Hive
 * account; a Lumen-rendered entry's author is a handle — must be able to say so.
 * Used by the block filters, where guessing wrong hides the wrong person's words.
 */
export async function findUsersByDisplayNames(names: string[]): Promise<LumenUser[]> {
  if (names.length === 0) return [];
  const { rows } = await query<UserRow>(`${SELECT} WHERE display_name = ANY($1::citext[])`, [names]);
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

/**
 * Lite accounts whose handle STARTS WITH `prefix`, shortest first, for the
 * search typeahead and the People tab (2026-09-05).
 *
 * ★ Only accounts a `/@name` link can open: `status = 'active'` (a suspended or
 * banned handle must not be offered), `account_tier = 'lite'` with no Hive name
 * (an upgraded user is found through their Hive account instead, and
 * `liteAccountAsProfile` deliberately answers null for them, so `/@handle`
 * would 404).
 *
 * The caller validates `prefix` against the Hive name charset before this runs
 * (`accountPrefixOf`), which is what keeps `%` and `_` out of the LIKE pattern;
 * the value is still bound as `$1`, never interpolated.
 *
 * ★ `lower(display_name::text) LIKE ...`, NOT `display_name LIKE ...` (review
 * 2026-09-05). A prefix LIKE on the CITEXT column has no usable index (the unique
 * index is citext-ordered, and the repo's own rule in migration 0028 says a
 * prefix LIKE needs `text_pattern_ops`). Migration 0042 builds exactly this
 * expression with that opclass, so the planner can use it; the expression here
 * must stay byte-for-byte what 0042 indexes or the scan comes back silently.
 */
export async function searchLiteUsersByPrefix(prefix: string, limit: number): Promise<LumenUser[]> {
  const clean = prefix.trim().toLowerCase();
  if (!/^[a-z][a-z0-9.-]{0,15}$/.test(clean)) return [];
  const { rows } = await query<UserRow>(
    `${SELECT}
      WHERE status = 'active'
        AND account_tier = 'lite'
        AND hive_account_name IS NULL
        AND lower(display_name::text) LIKE ($1 || '%')
      ORDER BY length(display_name::text), display_name
      LIMIT $2`,
    [clean, Math.max(1, Math.min(limit, 50))]
  );
  return rows.map(mapUser);
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
            -- F-L3: force-logout on suspend/ban, but NOT on reinstate (→ 'active'),
            -- so restoring an account does not also boot its owner's live sessions.
            session_epoch = CASE WHEN $2 IN ('suspended','banned') THEN session_epoch + 1 ELSE session_epoch END,
            updated_at = now()
      WHERE user_id = $1
      RETURNING *`,
    [userId, status, reason]
  );
  return res.rows[0] ? mapUser(res.rows[0]) : null;
}

/**
 * ★ 0023 — persist the signup interest picks.
 *
 * `interests_set_at` is stamped even for an EMPTY selection, because "asked and
 * declined" must be distinguishable from "not asked yet" — otherwise the picker
 * reappears on every login for anyone who skipped it.
 */
export async function setInterests(userId: string, interests: string[]): Promise<LumenUser | null> {
  const { rows } = await query<UserRow>(
    `UPDATE lumen_user
        SET interests = $2::jsonb, interests_set_at = now(), updated_at = now()
      WHERE user_id = $1
      RETURNING *`,
    [userId, JSON.stringify(interests)]
  );
  return rows[0] ? mapUser(rows[0]) : null;
}

/**
 * Revoke every outstanding cookie for a user by advancing their session epoch (F-L3).
 * Backs POST /api/lite/auth/logout-all and any future "sign out everywhere" control.
 * Unconditional single-row bump; the caller's own next request re-issues a fresh epoch.
 */
export async function bumpSessionEpoch(userId: string): Promise<LumenUser | null> {
  const { rows } = await query<UserRow>(
    `UPDATE lumen_user SET session_epoch = session_epoch + 1, updated_at = now()
       WHERE user_id = $1
       RETURNING *`,
    [userId]
  );
  return rows[0] ? mapUser(rows[0]) : null;
}
