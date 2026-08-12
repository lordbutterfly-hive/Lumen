import { BlacklistReason } from './moderation/blacklist-reason';

/**
 * Hivemind muted_reasons enum values.
 * See: hivemind/hive/db/sql_scripts/postgrest/utilities/muted_reasons_operations.sql
 */
export enum MutedReason {
  COMMUNITY_MODERATION = 0,
  COMMUNITY_TYPE = 1,
  PARENT_MUTED = 2,
  LOW_REPUTATION = 3,
  COMMUNITY_ROLE = 4
}

const COMMENT_REASON_KEYS: Record<number, string> = {
  [MutedReason.COMMUNITY_MODERATION]: 'cards.comment_card.reason_community_moderation',
  [MutedReason.COMMUNITY_TYPE]: 'cards.comment_card.reason_community_type',
  [MutedReason.PARENT_MUTED]: 'cards.comment_card.reason_parent_muted',
  [MutedReason.LOW_REPUTATION]: 'cards.comment_card.reason_low_reputation',
  [MutedReason.COMMUNITY_ROLE]: 'cards.comment_card.reason_community_role'
};

const POST_HIDDEN_KEYS: Record<number, string> = {
  [MutedReason.COMMUNITY_MODERATION]: 'post_content.body.content_hidden_community_moderation',
  [MutedReason.COMMUNITY_TYPE]: 'post_content.body.content_hidden_community_type',
  [MutedReason.PARENT_MUTED]: 'post_content.body.content_hidden_parent_muted',
  [MutedReason.LOW_REPUTATION]: 'post_content.body.content_hidden_low_reputation',
  [MutedReason.COMMUNITY_ROLE]: 'post_content.body.content_hidden_community_role'
};

/**
 * Returns the translation key for the comment mute reason tag.
 * Priority: muted by viewer > REAL blacklist match (own, then followed) >
 * muted_reasons from API (which is how a reputation-only flag surfaces as "low
 * reputation" instead of the false "blacklisted" — see `classifyBlacklist`) >
 * fallback "downvoted".
 */
export function getCommentMuteReasonKey(
  mutedReasons: number[] | undefined,
  isMutedByViewer: boolean,
  blacklistReason: BlacklistReason
): string {
  if (isMutedByViewer) return 'cards.comment_card.reason_muted';
  // ★ 'reputation' is deliberately NOT handled here — it is not a real blacklist
  // match (see blacklist-reason.ts). It falls through to `mutedReasons` below,
  // which already carries LOW_REPUTATION (3) whenever Hivemind grays a comment for
  // low reputation, and resolves to the correct, existing "low reputation" key.
  if (blacklistReason === 'own') return 'cards.comment_card.reason_blacklisted_by_you';
  if (blacklistReason === 'followed') return 'cards.comment_card.reason_on_followed_list';

  if (mutedReasons && mutedReasons.length > 0) {
    const key = COMMENT_REASON_KEYS[mutedReasons[0]];
    if (key) return key;
  }

  return 'cards.comment_card.reason_downvoted';
}

/**
 * Returns the translation key for the post hidden message.
 * Uses muted_reasons from API when available, falls back to generic message.
 */
export function getPostHiddenMessageKey(mutedReasons: number[] | undefined): string {
  if (mutedReasons && mutedReasons.length > 0) {
    const key = POST_HIDDEN_KEYS[mutedReasons[0]];
    if (key) return key;
  }

  return 'post_content.body.content_were_hidden';
}

/**
 * ═══ WHICH OF THE 9 HIDDEN-REASON STATES ARE THE VIEWER'S OWN CHOICE ═══
 * (owner ruling, 2026-08-12: "on Lumen mute and personal blacklist should be the
 * same damn thing... we should have no collapses like Hiveblog or ecency or
 * peakd... if you mute or blacklist someone it works the same way" as Block. A
 * SEPARATE ruling, unchanged by this one: low-reputation/downvote collapse stays
 * exactly as it is — that is a chain-wide signal, not the user's decision.)
 *
 * Between `MutedReason` (5 values) and `classifyBlacklist`'s `BlacklistReason`
 * (4 values, one of which — 'none' — never reaches a caller that already knows a
 * comment is hidden), `getCommentMuteReasonKey` can return 9 distinct strings.
 * Exactly TWO of them are a decision the viewer made about THIS one account:
 *
 *   - `isMutedByViewer` (the viewer's own chain `ignore`)
 *   - `blacklistReason === 'own'` (a REAL match on the viewer's own blacklist —
 *     never the synthetic `reputation-N` token `classifyBlacklist` strips out)
 *
 * Both must now render exactly like a Lumen Block: gone, with no collapse box
 * and no Reveal affordance anywhere, recoverable only from Settings.
 *
 * The other seven are NOT the viewer's own decision about this one account:
 *
 *   - `blacklistReason === 'followed'` is someone else's curated blacklist the
 *     viewer opted INTO — a subscription to a third party's judgement, not a
 *     personal one about this account (compare "I blocked @x" to "I follow
 *     @hive-watchers' blacklist, which happens to include @x").
 *   - The five `MutedReason` codes (community moderation/type/role, a muted
 *     parent, low reputation) and the downvote fallback are all chain-wide
 *     signals Hivemind computed, not a choice this viewer made.
 *
 * Those seven keep the existing collapse-with-Reveal treatment, unchanged.
 */
export function isOwnModerationHide(
  isMutedByViewer: boolean,
  blacklistReason: BlacklistReason
): boolean {
  return isMutedByViewer || blacklistReason === 'own';
}
