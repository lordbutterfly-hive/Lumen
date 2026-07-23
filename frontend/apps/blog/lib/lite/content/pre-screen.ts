import { FeedVisibility } from '../types';

/**
 * Fast synchronous content pre-screen at intake (spec §I, gate 1). Because the
 * feed renders DB-first, "hold before publish" does NOT hide a post on Lumen —
 * so this screen sets the initial `feed_visibility` that gates Lumen's own
 * immediate visibility. A slower async gate runs before on-chain broadcast (§D.3,
 * Phase 4).
 *
 * SEAM: `externalAbuseScreen` is where a CSAM hash-match + abuse classifier plugs
 * in. Until wired, only structural checks apply.
 */

const MAX_TITLE = 255;
const MAX_BODY = 100_000;

export type ScreenDecision =
  | { action: 'allow'; feedVisibility: FeedVisibility }
  | { action: 'hold'; feedVisibility: FeedVisibility; reason: string }
  | { action: 'reject'; reason: string };

export function preScreen(input: { title: string; body: string }): ScreenDecision {
  if (input.body.trim().length === 0) {
    return { action: 'reject', reason: 'empty_body' };
  }
  if (input.body.length > MAX_BODY) {
    return { action: 'reject', reason: 'body_too_long' };
  }
  if (input.title.length > MAX_TITLE) {
    return { action: 'reject', reason: 'title_too_long' };
  }
  // SEAM: const abuse = await externalAbuseScreen(input); if (abuse.block) return reject/hold
  return { action: 'allow', feedVisibility: 'visible' };
}
