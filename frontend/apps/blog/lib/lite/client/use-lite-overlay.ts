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
  author: string;
  title: string;
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
    // The identity of a published post does not change, so this can be cached hard.
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<LiteOverlay | null> => {
      if (!postId) return null;
      try {
        const res = await fetch(`/api/lite/posts/${encodeURIComponent(postId)}`);
        if (!res.ok) return null;
        const body = (await res.json()) as { entry?: { author?: string; title?: string } } | null;
        const author = body?.entry?.author;
        if (!author) return null;
        return { author, title: body?.entry?.title ?? '' };
      } catch {
        return null;
      }
    }
  });

  return data ?? null;
}
