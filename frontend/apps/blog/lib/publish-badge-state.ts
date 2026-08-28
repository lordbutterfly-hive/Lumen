/**
 * ★★★ ONE PUBLISH LADDER, SHARED BY EVERY RENDERER (2026-08-28, false-text audit F10).
 *
 * This state machine and its copy map used to live inside
 * `features/post-rendering/comment-list-item.tsx`, where they were written for
 * comments and got the reasoning right. The post page's
 * `components/optimistic-status-banner.tsx` had its own copy of the same idea and
 * got the lite branch wrong: any Lumen post older than ten seconds rendered
 * "Saved and visible on Lumen. It will appear on Hive shortly." and kept
 * rendering it forever, with no terminal state and no failure input, on a
 * publisher that has in fact stalled on resource credits with jobs hours old.
 *
 * That is the SAME defect the banner's own header describes and fixed for the
 * chain branch ("THE THIRD MESSAGE STOPS BEING TRUE, AND IT NEVER STOPS BEING
 * SHOWN... A UX tester found it on a FOUR-HOUR-OLD post"). Two renderers, one
 * rule, and the rule was applied to one of them. Extracting it here is what stops
 * a third renderer drifting the same way.
 *
 * The reasoning below is carried over verbatim from `comment-list-item.tsx`,
 * because it is the record of why each threshold and each precedence exists.
 *
 * ---
 *
 * ★★★ FOUR HONEST PUBLISH STATES, ONLY THE FIRST WITH A SPINNER (O7 F2a,
 * 2026-08-13). A real comment (`01KZW0GB585D9GQMWVHM7NNC3Q`) spun on
 * "Publishing..." for ~24 hours with no timeout, no error branch and no
 * terminal state — because `comment._optimistic` used to mean two different
 * things (see `db-post-to-entry.ts`'s own doc): "just broadcast, resolving in
 * seconds" on the CHAIN path (`use-comment-mutations.ts`), and "has never
 * been broadcast at all, possibly ever" on the LITE path. One flag, one
 * spinner, two truths — a spinner is what reads as a hang, so every state
 * below the first loses it.
 *
 * Thresholds (15 min / 6 h) are judgement, not measurement — O7's own build
 * map names them as such and recommends re-deriving them from real drain
 * timings once the publisher has actually run for a week.
 */
export const PUBLISH_QUEUED_WINDOW_MS = 15 * 60 * 1000;
export const PUBLISH_WAITING_WINDOW_MS = 6 * 60 * 60 * 1000;

export type PublishBadgeState = 'publishing' | 'queued' | 'waiting' | 'delayed' | 'failed' | null;

export function getPublishBadgeState(
  isOptimistic: boolean,
  isLitePipeline: boolean,
  createdIso: string,
  publishFailed = false
): PublishBadgeState {
  if (!isOptimistic) return null;
  // ★ FAILED OUTRANKS EVERY AGE-BASED STATE. The ladder below is a function of
  // how OLD the post is, so a publish that permanently failed simply aged into
  // "delayed" and sat there — a word that promises it will still land. It will
  // not: its publish generations are exhausted and it needs a human. Saying so
  // is the difference between a wait and a lie.
  if (publishFailed) return 'failed';
  // Chain path: a fresh client-side optimistic comment, not from the lite
  // pipeline at all. Unchanged from before this fix — still spinning, still
  // "Publishing...", still expected to resolve in seconds via
  // `scheduleValidatedRefetch`.
  if (!isLitePipeline) return 'publishing';

  const ageMs = Date.now() - new Date(createdIso).getTime();
  if (!Number.isFinite(ageMs) || ageMs < PUBLISH_QUEUED_WINDOW_MS) return 'queued';
  if (ageMs < PUBLISH_WAITING_WINDOW_MS) return 'waiting';
  return 'delayed';
}

export const PUBLISH_BADGE_COPY_KEY: Record<Exclude<PublishBadgeState, null>, string> = {
  publishing: 'global.publishing',
  queued: 'cards.comment_card.publish_queued',
  waiting: 'cards.comment_card.publish_waiting',
  delayed: 'cards.comment_card.publish_delayed',
  failed: 'cards.comment_card.publish_failed'
};

/**
 * Whether a spinner belongs beside this state.
 *
 * Only the first one. A spinner is what reads as a hang, and everything past
 * "just broadcast, resolving in seconds" is a calm, static sentence. `queued`
 * lasts up to fifteen minutes, `waiting` up to six hours: an animation running
 * that long is the defect, not the fix.
 */
export function publishBadgeShowsSpinner(state: PublishBadgeState): boolean {
  return state === 'publishing';
}
