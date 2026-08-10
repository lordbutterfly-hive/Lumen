import { query } from '@/blog/lib/lite/db/pool';

/**
 * Preferences for a reader who signed in with an EXISTING HIVE ACCOUNT.
 *
 * ★ WHY THIS IS SEPARATE FROM `lumen_user` (2026-08-08). `lumen_user` is the
 * lite IDENTITY registry — a globally-unique Lumen handle, a display-name
 * history, a trust score, a publish cursor. A Hive reader has none of that and
 * wants none of it; they already have an identity. Minting them a `lumen_user`
 * row would have to invent a Lumen handle (the table's CHECK constraint forbids
 * reusing their Hive name) and would burn it in the unique namespace forever.
 *
 * So: identity stays where it belongs, and this holds the one thing a Hive
 * reader does have — what they told us they are interested in.
 *
 * Same two-field "asked vs chose" shape as the lite side, for the same reason:
 * `interestsSetAt === null` means never asked; set with an empty array means
 * asked and skipped. Collapsing them re-prompts a skipper on every login.
 */
export interface HiveReaderPrefs {
  hiveAccount: string;
  interests: string[];
  interestsSetAt: Date | null;
}

interface Row {
  hive_account: string;
  interests: unknown;
  interests_set_at: Date | null;
}

function mapRow(r: Row): HiveReaderPrefs {
  return {
    hiveAccount: r.hive_account,
    interests: Array.isArray(r.interests) ? (r.interests as string[]) : [],
    interestsSetAt: r.interests_set_at
  };
}

export async function findHiveReaderPrefs(hiveAccount: string): Promise<HiveReaderPrefs | null> {
  const { rows } = await query<Row>(
    `SELECT hive_account, interests, interests_set_at
       FROM lumen_hive_reader_prefs
      WHERE hive_account = $1`,
    [hiveAccount]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Stamps `interests_set_at` even for an EMPTY selection — "asked and declined"
 * has to be recorded, or the picker asks again forever.
 */
export async function setHiveReaderInterests(
  hiveAccount: string,
  interests: string[]
): Promise<HiveReaderPrefs> {
  const { rows } = await query<Row>(
    `INSERT INTO lumen_hive_reader_prefs (hive_account, interests, interests_set_at)
          VALUES ($1, $2::jsonb, now())
     ON CONFLICT (hive_account) DO UPDATE
          SET interests = EXCLUDED.interests,
              interests_set_at = now(),
              updated_at = now()
       RETURNING hive_account, interests, interests_set_at`,
    [hiveAccount, JSON.stringify(interests)]
  );
  return mapRow(rows[0]);
}
