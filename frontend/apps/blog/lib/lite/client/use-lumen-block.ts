'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { liteBlock } from './lite-write';

/**
 * The Block button's state and action.
 *
 * Modelled on `use-lumen-follow`, with one deliberate difference: there is no
 * `applies` / "does this belong on chain" question to answer. A block ALWAYS lives on
 * Lumen, for every combination of the two account tiers, because the chain has no way
 * to express the half of it that binds other readers (see
 * `lib/lite/social/block-service.ts`). So the control is offered to anyone who is
 * signed in, and it means the same thing whoever presses it.
 *
 * `targetKind` is required rather than inferred: a Lumen handle and a Hive account can
 * share a spelling and be different people, and a block removes somebody's comments
 * from other readers' screens. The caller always knows which it is holding — a lite
 * byline versus a chain-signed one — so it says.
 */

export interface LumenBlock {
  /** Whether a Block control should be shown at all (signed in, not yourself). */
  available: boolean;
  /** The state query has not answered yet. */
  pending: boolean;
  isBlocking: boolean;
  busy: boolean;
  /** Resolves to an error message when the change was refused, else null. */
  toggle: () => Promise<string | null>;
}

export function useLumenBlock(
  target: string,
  targetKind: 'hive' | 'lumen',
  enabled: boolean
): LumenBlock {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const queryKey = ['lumenBlockState', target, targetKind];

  const { data, isLoading } = useQuery({
    queryKey,
    enabled: enabled && Boolean(target),
    staleTime: 60 * 1000,
    queryFn: async () => {
      const params = new URLSearchParams({ target, kind: targetKind });
      const res = await fetch(`/api/lite/block/state?${params.toString()}`);
      if (!res.ok) return { available: false, blocking: false };
      return (await res.json()) as { available: boolean; blocking: boolean };
    }
  });

  const isBlocking = Boolean(data?.blocking);

  return {
    available: Boolean(data?.available),
    pending: enabled && Boolean(target) && isLoading,
    isBlocking,
    busy,
    toggle: async () => {
      setBusy(true);
      const result = await liteBlock(target, targetKind, isBlocking);
      setBusy(false);
      // The error is RETURNED, not stashed on the hook: a field read from the render
      // closure is the value it had when the button was drawn, so every rate-limit
      // and suspension refusal would be invisible. Same trap `use-lumen-follow`
      // documents, and the same fix.
      if (result.status === 'error') return result.message;
      // Re-read rather than flipping locally: only the server knows whether the edge
      // actually changed. Feeds and threads are invalidated too — a block that leaves
      // the blocked person sitting on the page until a reload looks like it failed.
      await queryClient.invalidateQueries({ queryKey });
      await queryClient.invalidateQueries({ queryKey: ['forYouRanked'] });
      await queryClient.invalidateQueries({ queryKey: ['lumenBlockList'] });
      await queryClient.invalidateQueries({ queryKey: ['discussionData'] });
      return null;
    }
  };
}

export interface LumenBlockList {
  userIds: Set<string>;
  names: Set<string>;
  loaded: boolean;
}

const EMPTY_LIST: LumenBlockList = { userIds: new Set(), names: new Set(), loaded: false };

/**
 * The viewer's own block list, for the surfaces the BROWSER fetches straight from a
 * Hive node (a profile's post list, the chain Following feed, search). Those calls
 * never reach a Lumen server, so this is the only place the reader's own preference
 * can be applied.
 *
 * ★ EFFECT (A) ONLY. This is the "I never see them" half, and a client-side filter is
 * honest for it: the only person who could defeat it is the viewer, and all they win
 * is seeing something they asked not to see. The other half — "their comments on my
 * post are hidden from EVERYONE" — is never enforced here and never shipped to a
 * browser, because there the person who would have to run the filter is exactly the
 * person it exists to keep out. That one is applied server-side before the thread
 * leaves (`/api/discussion`, `/api/lite/posts/replies`, and the post page's SSR).
 */
export function useLumenBlockList(enabled: boolean): LumenBlockList {
  const { data } = useQuery({
    queryKey: ['lumenBlockList'],
    enabled,
    staleTime: 60 * 1000,
    queryFn: async (): Promise<{ userIds: string[]; names: string[] }> => {
      const res = await fetch('/api/lite/block/list');
      if (!res.ok) return { userIds: [], names: [] };
      const body = (await res.json()) as { userIds?: string[]; names?: string[] };
      return { userIds: body.userIds ?? [], names: body.names ?? [] };
    }
  });
  // ★ MEMOISED, and that is not a micro-optimisation. Building fresh Sets on every
  // render would hand every consumer a NEW object each time, and consumers put this
  // in `useMemo` dependency arrays (the comment thread does) — so the thread would
  // re-sort and re-paginate on every single render of the post page.
  return useMemo(() => {
    if (!data) return EMPTY_LIST;
    return {
      userIds: new Set(data.userIds),
      names: new Set(data.names.map((n) => n.toLowerCase())),
      loaded: true
    };
  }, [data]);
}

interface BlockableEntry {
  author?: string;
  _lite?: { author?: string; userId?: string };
}

/**
 * Is this entry written by somebody the viewer has blocked?
 *
 * Checks the account id first (exact, survives renames and upgrades) and then BOTH
 * names an entry can carry: `author`, which a feed may already have rewritten to a
 * Lumen handle, and `_lite.author`, the handle itself. Matching only the visible
 * string would miss the writer on any surface that relabels its entries — the same
 * trap `filterBannedEntries` documents.
 */
export function isBlockedEntry(entry: BlockableEntry | null | undefined, list: LumenBlockList): boolean {
  if (!entry || (list.userIds.size === 0 && list.names.size === 0)) return false;
  if (entry._lite?.userId && list.userIds.has(entry._lite.userId)) return true;
  const author = (entry.author ?? '').toLowerCase();
  if (author && list.names.has(author)) return true;
  const liteAuthor = (entry._lite?.author ?? '').toLowerCase();
  return Boolean(liteAuthor && list.names.has(liteAuthor));
}
