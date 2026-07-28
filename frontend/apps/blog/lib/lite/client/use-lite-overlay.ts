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
  author?: string;
  permlink?: string;
  json_metadata?: unknown;
  _lite?: LiteOverlay;
} | null): LiteOverlay | null {
  const isProxied = isLumenProxiedEntry(entry);
  const postId = isProxied ? litePostIdOf(entry) : undefined;
  // Who actually signed the entry in front of us. Checked against the post's real
  // author below, because the two things that identify a Lumen post — its permlink and
  // its json_metadata — are on-chain fields anyone can write.
  const chainAuthor = (entry?.author ?? '').toLowerCase();

  // Resolved during SSR (render/attach-lite.ts) for every server-rendered feed and
  // comment thread. Handed to react-query as `initialData`, which does two things:
  // this render needs no request at all — so there is no wrong name to correct — and
  // the value lands in the cache under this post id. That second part matters,
  // because when the client later refetches the feed straight from Hivemind those
  // fresh entries carry no `_lite`, and without a warm cache every card would flash
  // right back to the publishing account.
  const embedded = entry?._lite;

  const { data } = useQuery({
    queryKey: ['liteOverlay', postId, chainAuthor],
    // NEVER re-query an entry that already carries `_lite`. `initialData` only seeds
    // the cache; the query still refetches on focus and after `staleTime`, and for
    // these entries `author` has already been replaced with the Lumen name — so the
    // author check below can only fail, the overlay drops to null, and the byline falls
    // back to that Lumen name as if it were a Hive account. Which is exactly the
    // impersonation this gate exists to prevent, since a lite handle is by construction
    // a name that was free on Hive.
    enabled: Boolean(postId) && !embedded,
    initialData: embedded,
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
        const realAuthor = body?.post?.hiveAuthor ?? '';
        if (!author || !realAuthor) return null;
        // ★ Forgery gate. Any Hive account can publish a comment quoting a real Lumen
        // post id; without this, their text would render under that lite user's name
        // and avatar. The stored post says who signed it — if this entry was signed by
        // someone else, it is not that post, so it keeps the identity the chain gave it.
        //
        // ONE acceptable author: the account that really signed the post on chain.
        //
        // This used to also accept "the entry already shows the lite name", to let
        // already-resolved entries through. That was forgeable: a lite handle is a name
        // that was free on Hive at signup, so an attacker can register it and post as
        // that account. Entries we resolved ourselves now carry `_lite` (set by
        // `render/lite-entry.ts` and `render/db-post-to-entry.ts`) and never reach this
        // request at all. An entry with no author at all is refused rather than trusted.
        if (!chainAuthor || realAuthor.toLowerCase() !== chainAuthor) return null;
        return { author, title: body?.entry?.title ?? '', chainAuthor: realAuthor };
      } catch {
        return null;
      }
    }
  });

  return data ?? null;
}
