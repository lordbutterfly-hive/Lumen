/**
 * On-chain footer + attribution metadata (spec §D.4). Built at publish time from
 * the immutable `display_name_snapshot`. The wording is hardened past a bare
 * "POSTED BY {name}" so the frontend account's permanent on-chain speech reads as
 * a Lumen-mediated post, not an unqualified authorship claim (§I impersonation).
 */

export function buildFooter(displayName: string): string {
  return `\n\n---\n*Posted via Lumen by ${displayName}*`;
}

/** `json_metadata` so indexers/attribution can resolve the post to its lite user. */
export function buildJsonMetadata(p: {
  tags: string[];
  userId: string;
  postId: string;
  displayName: string;
}): Record<string, unknown> {
  return {
    app: 'lumen/1.0',
    format: 'markdown',
    tags: p.tags,
    lumen_user_id: p.userId,
    lumen_post_id: p.postId,
    lite_display_name: p.displayName
  };
}
