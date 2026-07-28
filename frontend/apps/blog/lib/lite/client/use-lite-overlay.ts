'use client';

import { useQuery } from '@tanstack/react-query';
import { isLumenProxiedEntry, litePostIdOf } from '../render/lite-post-id';

/**
 * Identity overlay for a chain-sourced entry that turns out to be a Lumen proxy post.
 *
 * The post PAGE resolves this server-side, but feed cards and comment lists get their
 * entries straight from Hivemind, where the author is the shared publishing account —
 * so a lite post appearing in any chain-sourced list showed the wrong person's name.
 *
 * Only fires for entries whose permlink matches the Lumen pattern, so ordinary Hive
 * posts cost nothing. Results are cached by post id, so the same post appearing in
 * several lists resolves once.
 */
export interface LiteOverlay {
  /** The person to show: the Lumen identity behind the post. */
  author: string;
  title: string;
  /**
   * The account that actually signed this on chain — the shared publishing account.
   * Anything that ACTS (follow, mute, a profile lookup) must use this, never
   * `author`, which is not a Hive account at all.
   */
  chainAuthor: string;
}

export function useLiteOverlay(entry?: {
  permlink?: string;
  json_metadata?: unknown;
} | null): LiteOverlay | null {
  const isProxied = isLumenProxiedEntry(entry);
  const postId = isProxied ? litePostIdOf(entry) : undefined;

  const { data } = useQuery({
    queryKey: ['liteOverlay', postId],
    enabled: Boolean(postId),
    // Identity DOES change once, at exactly one moment: when a lite account upgrades
    // to a real Hive account, its whole back catalogue starts rendering under the new
    // name (see render/current-name.ts). So this is cached hard but not forever — for
    // up to five minutes after an upgrade a warm tab may still show the old handle,
    // then heals on its own. Worth it: the alternative is re-fetching every card.
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<LiteOverlay | null> => {
      if (!postId) return null;
      try {
        const res = await fetch(`/api/lite/posts/${encodeURIComponent(postId)}`);
        if (!res.ok) return null;
        const body = (await res.json()) as {
          entry?: { author?: string; title?: string };
          post?: { hiveAuthor?: string | null };
        } | null;
        const author = body?.entry?.author;
        if (!author) return null;
        return { author, title: body?.entry?.title ?? '', chainAuthor: body?.post?.hiveAuthor ?? '' };
      } catch {
        return null;
      }
    }
  });

  return data ?? null;
}
