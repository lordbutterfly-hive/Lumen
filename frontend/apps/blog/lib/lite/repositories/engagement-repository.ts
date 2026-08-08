import { query } from '../db/pool';

/**
 * Lumen-local votes & reblogs for lite users (migration 0009). These are NOT
 * proxied to Hive — a vote/reblog is attributed to the signing account, so N
 * lite users cannot share one frontend account's single vote. They are recorded
 * here for the Lumen feed/recsys and materialise on-chain only after upgrade.
 * Soft-delete + seq bump so the recsys delta feed re-observes retractions.
 */

const VOTE_SEQ = `nextval(pg_get_serial_sequence('lumen_vote', 'seq'))`;
const REBLOG_SEQ = `nextval(pg_get_serial_sequence('lumen_reblog', 'seq'))`;

/** Cast or change a vote. weight 0 (or removeVote) retracts it. */
export async function castVote(
  voterUserId: string,
  author: string,
  permlink: string,
  weight: number
): Promise<void> {
  if (weight === 0) return removeVote(voterUserId, author, permlink);
  await query(
    `INSERT INTO lumen_vote (voter_user_id, target_author, target_permlink, weight)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (voter_user_id, target_author, target_permlink)
       DO UPDATE SET weight = $4, active = true, seq = ${VOTE_SEQ}, updated_at = now()`,
    [voterUserId, author, permlink, weight]
  );
}

export async function removeVote(voterUserId: string, author: string, permlink: string): Promise<void> {
  await query(
    `UPDATE lumen_vote SET active = false, weight = 0, seq = ${VOTE_SEQ}, updated_at = now()
       WHERE voter_user_id = $1 AND target_author = $2 AND target_permlink = $3 AND active = true`,
    [voterUserId, author, permlink]
  );
}

export async function reblog(rebloggerUserId: string, author: string, permlink: string): Promise<boolean> {
  const { rowCount } = await query(
    `INSERT INTO lumen_reblog (reblogger_user_id, target_author, target_permlink)
     VALUES ($1, $2, $3)
     ON CONFLICT (reblogger_user_id, target_author, target_permlink)
       DO UPDATE SET active = true, seq = ${REBLOG_SEQ}, created_at = now()
       WHERE lumen_reblog.active = false`,
    [rebloggerUserId, author, permlink]
  );
  return (rowCount ?? 0) > 0;
}

export async function unreblog(rebloggerUserId: string, author: string, permlink: string): Promise<void> {
  await query(
    `UPDATE lumen_reblog SET active = false, seq = ${REBLOG_SEQ}
       WHERE reblogger_user_id = $1 AND target_author = $2 AND target_permlink = $3 AND active = true`,
    [rebloggerUserId, author, permlink]
  );
}

/**
 * What this user did to this post, plus the Lumen-side totals.
 *
 * These tables were write-only until now, which is why a lite vote survived exactly
 * as long as the react-query cache: the button read `active_votes` and
 * `getRebloggedBy` from Hivemind, where a Lumen-local vote does not and cannot exist,
 * so a reload showed the post as never voted. One statement rather than four, because
 * the vote button asks per post and a feed asks per card.
 */
export interface LiteEngagement {
  /** The user's own active vote weight (-10000..10000), or null if they have none. */
  weight: number | null;
  reblogged: boolean;
  /** Lumen-local totals — deliberately separate from the post's on-chain counts. */
  voteCount: number;
  reblogCount: number;
}

export async function getEngagement(
  userId: string | null,
  author: string,
  permlink: string
): Promise<LiteEngagement> {
  const { rows } = await query<{
    weight: number | null;
    reblogged: boolean;
    vote_count: string;
    reblog_count: string;
  }>(
    `SELECT
       (SELECT weight FROM lumen_vote
         WHERE voter_user_id = $1 AND target_author = $2 AND target_permlink = $3 AND active)      AS weight,
       EXISTS (SELECT 1 FROM lumen_reblog
         WHERE reblogger_user_id = $1 AND target_author = $2 AND target_permlink = $3 AND active)  AS reblogged,
       (SELECT count(*) FROM lumen_vote
         WHERE target_author = $2 AND target_permlink = $3 AND active)                             AS vote_count,
       (SELECT count(*) FROM lumen_reblog
         WHERE target_author = $2 AND target_permlink = $3 AND active)                             AS reblog_count`,
    [userId, author, permlink]
  );
  const row = rows[0];
  return {
    weight: row?.weight ?? null,
    reblogged: Boolean(row?.reblogged),
    voteCount: Number(row?.vote_count ?? 0),
    reblogCount: Number(row?.reblog_count ?? 0)
  };
}

/**
 * Lumen-local vote and reblog totals for many posts at once.
 *
 * ★ WHY (owner report, 2026-08-07): a lite vote is Lumen-local by design — it
 * never reaches the chain, because N lite readers all post through one shared
 * Hive account and would collapse into a single voter. But every COUNT on screen
 * came straight from the chain, so the moment a reader reloaded, their vote
 * vanished from the tally (923 -> 922) and a reblog they had just made never
 * appeared anywhere. The write landed; nothing ever read it back.
 *
 * `getEngagement` answers this for ONE post, which is right for a vote button and
 * hopeless for a feed — thirty cards would mean thirty round trips. This answers
 * for a whole page in one statement.
 *
 * Returns only posts that actually have Lumen engagement; callers treat a missing
 * key as zero.
 */
export async function getEngagementTotals(
  targets: { author: string; permlink: string }[]
): Promise<Map<string, { votes: number; reblogs: number }>> {
  const out = new Map<string, { votes: number; reblogs: number }>();
  if (targets.length === 0) return out;

  // Deduplicate — a feed can legitimately contain the same post twice (a reblog
  // alongside the original).
  const seen = new Set<string>();
  const authors: string[] = [];
  const permlinks: string[] = [];
  for (const t of targets) {
    const key = `${t.author}/${t.permlink}`;
    if (seen.has(key)) continue;
    seen.add(key);
    authors.push(t.author);
    permlinks.push(t.permlink);
  }

  const { rows } = await query<{
    target_author: string;
    target_permlink: string;
    vote_count: string;
    reblog_count: string;
  }>(
    `WITH wanted AS (
       SELECT * FROM unnest($1::text[], $2::text[]) AS t(target_author, target_permlink)
     )
     SELECT w.target_author,
            w.target_permlink,
            (SELECT count(*) FROM lumen_vote v
              WHERE v.target_author = w.target_author
                AND v.target_permlink = w.target_permlink
                AND v.active)   AS vote_count,
            (SELECT count(*) FROM lumen_reblog r
              WHERE r.target_author = w.target_author
                AND r.target_permlink = w.target_permlink
                AND r.active)   AS reblog_count
       FROM wanted w`,
    [authors, permlinks]
  );

  for (const row of rows) {
    const votes = Number(row.vote_count) || 0;
    const reblogs = Number(row.reblog_count) || 0;
    if (votes === 0 && reblogs === 0) continue;
    out.set(`${row.target_author}/${row.target_permlink}`, { votes, reblogs });
  }
  return out;
}
