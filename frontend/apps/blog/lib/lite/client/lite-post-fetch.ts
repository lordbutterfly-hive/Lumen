'use client';

import { litePostIdOf } from '../render/lite-post-id';

/**
 * Client-side companion to the server's lite fallback.
 *
 * On a soft navigation there is no server-rendered initialData, so the client query
 * runs on its own — and Hivemind returns nothing for a lite display name (it is not
 * a Hive account). The permlink identifies the post by itself, so derive our post id
 * from it and ask our own API, which resolves the real on-chain object and applies
 * the identity overlay.
 *
 * Returns null when this is not a Lumen permlink, so the caller keeps whatever the
 * normal Hive fetch produced.
 */
export async function fetchLiteEntryByPermlink(permlink: string): Promise<unknown | null> {
  const postId = litePostIdOf({ permlink });
  if (!postId) return null;
  try {
    const res = await fetch(`/api/lite/posts/${encodeURIComponent(postId)}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { entry?: unknown } | null;
    return body?.entry ?? null;
  } catch {
    return null;
  }
}
