/**
 * Deterministic permlink (spec §D.5). Every lite post shares one on-chain author,
 * so `createPermlink`'s per-author collision probe would fire constantly and
 * isn't retry-stable. We derive the permlink purely from the globally-unique ULID
 * post_id, so it is:
 *   - identical across broadcast retries, and
 *   - identical across edits of the same post (an edit re-broadcasts the SAME
 *     permlink so it targets the same on-chain post — a title-based slug would
 *     change when the title changes and break edit targeting).
 * The human-readable title still lives in the on-chain `title` field.
 */

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'post';
}

export function buildPermlink(postId: string): string {
  // ULID lowercased is valid permlink charset (lowercase alnum), stable forever.
  return `lumen-${postId.toLowerCase()}`;
}
