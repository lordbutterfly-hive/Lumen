import { query } from '../db/pool';
import { ulid } from '../ids';

/**
 * Append-only moderation log (migration 0014). Nothing here updates or deletes: an
 * action that turns out to be wrong is answered with a further action, never by
 * rewriting history.
 */

export type ModerationTargetType = 'user' | 'post';

export type ModerationActionName =
  | 'suspend'
  | 'ban'
  | 'reinstate'
  | 'hide'
  | 'author_only'
  | 'unhide'
  | 'takedown';

export interface ModerationAction {
  actionId: string;
  actor: string;
  targetType: ModerationTargetType;
  targetId: string;
  action: ModerationActionName;
  reason: string | null;
  detail: Record<string, unknown>;
  createdAt: Date;
}

interface ActionRow {
  action_id: string;
  actor: string;
  target_type: string;
  target_id: string;
  action: string;
  reason: string | null;
  detail: Record<string, unknown> | null;
  created_at: Date;
}

function mapAction(r: ActionRow): ModerationAction {
  return {
    actionId: r.action_id,
    actor: r.actor,
    targetType: r.target_type as ModerationTargetType,
    targetId: r.target_id,
    action: r.action as ModerationActionName,
    reason: r.reason,
    detail: r.detail ?? {},
    createdAt: r.created_at
  };
}

export async function recordAction(input: {
  actor: string;
  targetType: ModerationTargetType;
  targetId: string;
  action: ModerationActionName;
  reason?: string | null;
  detail?: Record<string, unknown>;
}): Promise<ModerationAction> {
  const { rows } = await query<ActionRow>(
    `INSERT INTO lumen_moderation_action
       (action_id, actor, target_type, target_id, action, reason, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING *`,
    [
      ulid(),
      input.actor,
      input.targetType,
      input.targetId,
      input.action,
      input.reason ?? null,
      // pg maps a JS object onto a Postgres composite/array, not jsonb — the value
      // has to arrive as a JSON string (same trap as the publish_job payload).
      JSON.stringify(input.detail ?? {})
    ]
  );
  return mapAction(rows[0]);
}

/**
 * Recent actions, newest first. Keyset paging on the ULID primary key, matching the
 * rest of the codebase — offsets drift when rows are inserted mid-page.
 */
export async function listActions(opts: {
  limit?: number;
  before?: string;
  targetType?: ModerationTargetType;
  targetId?: string;
}): Promise<ModerationAction[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.before) {
    params.push(opts.before);
    conditions.push(`action_id < $${params.length}`);
  }
  if (opts.targetType) {
    params.push(opts.targetType);
    conditions.push(`target_type = $${params.length}`);
  }
  if (opts.targetId) {
    params.push(opts.targetId);
    conditions.push(`target_id = $${params.length}`);
  }
  params.push(limit);
  const { rows } = await query<ActionRow>(
    `SELECT * FROM lumen_moderation_action
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY action_id DESC
      LIMIT $${params.length}`,
    params
  );
  return rows.map(mapAction);
}
