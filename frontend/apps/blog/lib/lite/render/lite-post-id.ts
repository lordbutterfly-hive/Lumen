/**
 * Recover the Lumen post id from a rendered entry.
 *
 * A lite post's on-chain permlink is derived from its row id, so the id can be read
 * straight back out of it — no lookup, no round-trip:
 *   published   -> `lumen-<lowercased ULID>`  (publisher/permlink.ts)
 *   unpublished -> `lite-<ULID>`              (render/db-post-to-entry.ts)
 * `json_metadata.lumen_post_id` (written by publisher/footer.ts) is the fallback for
 * anything that arrived by another route.
 *
 * Needed because the EDIT path must name the DB row, not the permlink: the composer
 * used to ignore edit mode entirely for lite users and silently create a duplicate
 * post instead of editing.
 */

const ULID = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/i;
const PUBLISHED = /^lumen-([0-9abcdefghjkmnpqrstvwxyz]{26})$/i;
const UNPUBLISHED = /^lite-([0-9ABCDEFGHJKMNPQRSTVWXYZ]{26})$/i;

interface EntryLike {
  permlink?: string;
  json_metadata?: unknown;
}

export function litePostIdOf(entry?: EntryLike | null): string | undefined {
  if (!entry) return undefined;

  const permlink = entry.permlink ?? '';
  const published = PUBLISHED.exec(permlink);
  if (published) return published[1].toUpperCase();
  const unpublished = UNPUBLISHED.exec(permlink);
  if (unpublished) return unpublished[1].toUpperCase();

  // json_metadata arrives as an object from the bridge API and as a string from
  // some cached paths; accept either rather than assuming.
  const meta = entry.json_metadata;
  const parsed =
    typeof meta === 'string'
      ? (() => {
          try {
            return JSON.parse(meta) as Record<string, unknown>;
          } catch {
            return null;
          }
        })()
      : (meta as Record<string, unknown> | null | undefined);

  const id = parsed?.lumen_post_id;
  // Shape-checked like the permlink branch above. This value comes off an on-chain
  // field ANY Hive account can write, so it is untrusted input: accepting arbitrary
  // strings turned it into a free-text lookup key against our post table.
  return typeof id === 'string' && ULID.test(id) ? id : undefined;
}

/**
 * Does this permlink belong to Lumen's own namespace?
 *
 * Used to decide that OUR record — not a chain lookup keyed on the URL's author segment
 * — is authoritative for such a permlink. A lite handle is a name that was free on Hive
 * at signup, so the author segment of a Lumen URL is not a trustworthy key.
 */
export function isLumenPermlink(permlink: string): boolean {
  return PUBLISHED.test(permlink) || UNPUBLISHED.test(permlink);
}

/** True when this entry was proxied to Hive by Lumen (drives the lite badge). */
export function isLumenProxiedEntry(entry?: EntryLike | null): boolean {
  if (!entry) return false;
  if (PUBLISHED.test(entry.permlink ?? '') || UNPUBLISHED.test(entry.permlink ?? '')) return true;
  const meta = entry.json_metadata;
  const parsed = typeof meta === 'string' ? meta : JSON.stringify(meta ?? '');
  return parsed.includes('"lumen/1.0"') || parsed.includes('lumen_post_id');
}
