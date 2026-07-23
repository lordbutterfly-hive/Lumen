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
