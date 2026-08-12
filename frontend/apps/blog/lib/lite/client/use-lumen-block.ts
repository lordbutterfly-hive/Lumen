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
  /**
   * The state read failed permanently (retries exhausted), so `available: false`
   * MEANS "we don't know", not "this control does not apply here" — the same
   * distinction `LumenBlockList.unknown` draws below, carried across to this
   * hook's sibling.
   *
   * `available` alone cannot tell a caller the difference: it is also `false`
   * while the query is still loading and whenever `enabled` is false (signed
   * out, or viewing yourself) — both of which a caller is right to render as
   * "no control here". Gating the SAME WAY on a permanent failure hid the
   * control during a backend outage with nothing telling the reader why, which
   * reads as "this person can't be blocked" — never true, just unknown right
   * now. A caller that checks `unknown` can show a disabled control with an
   * honest explanation instead of letting Block silently vanish.
   */
  unknown: boolean;
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

  const { data, isLoading, isError } = useQuery({
    queryKey,
    enabled: enabled && Boolean(target),
    staleTime: 60 * 1000,
    queryFn: async () => {
      // Same rule as the list read below: a failed lookup resolved as
      // `blocking: false`, which React Query treated as a success — no retry, and a
      // Block button that offers to block somebody the reader has ALREADY blocked.
      // Throwing engages retry, so a transient failure recovers on its own.
      //
      // `res.ok` is the HTTP status; the route answers 200 with `ok: false` when it
      // degrades (including its 429), so both are checked. `available: false` from a
      // healthy server is a real answer and is left alone — it means this pair cannot
      // be blocked, not that the read broke.
      const params = new URLSearchParams({ target, kind: targetKind });
      const res = await fetch(`/api/lite/block/state?${params.toString()}`);
      if (!res.ok) throw new Error(`block state read failed: HTTP ${res.status}`);
      const body = (await res.json()) as { ok?: boolean; available: boolean; blocking: boolean };
      if (body.ok === false) throw new Error('block state read failed server-side');
      return { available: body.available, blocking: body.blocking };
    }
  });

  const isBlocking = Boolean(data?.blocking);

  return {
    available: Boolean(data?.available),
    pending: enabled && Boolean(target) && isLoading,
    isBlocking,
    busy,
    // Scoped by construction, same as `pending` above: `enabled: enabled &&
    // Boolean(target)` on the query means it never runs — so never errors —
    // when this control does not apply, so `isError` is already exactly "the
    // read that WOULD have answered this failed", nothing more to gate here.
    unknown: isError,
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
  /**
   * The read terminally failed, so this list is not "empty" — it is UNKNOWN.
   *
   * Consumers currently keep rendering when this is true, which is a deliberate
   * choice rather than an oversight: this list serves effect (A), the viewer's own
   * "I never see them" preference, and failing closed on it would blank a reader's
   * entire feed over a database hiccup. Showing a blocked account for a moment is
   * the smaller harm than showing nothing at all.
   *
   * What is NOT acceptable is a consumer that cannot tell the difference, which is
   * why this flag exists and why the query above now throws instead of resolving
   * empty. Effect (B) — the half a reader cannot opt out of, and the anti-spam one —
   * never reads this hook; it runs server-side and fails closed.
   */
  unknown: boolean;
}

const EMPTY_LIST: LumenBlockList = { userIds: new Set(), names: new Set(), loaded: false, unknown: false };
const UNKNOWN_LIST: LumenBlockList = { userIds: new Set(), names: new Set(), loaded: false, unknown: true };

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
  const { data, isError } = useQuery({
    queryKey: ['lumenBlockList'],
    enabled,
    staleTime: 60 * 1000,
    queryFn: async (): Promise<{ userIds: string[]; names: string[] }> => {
      // ★ A FAILED READ MUST NOT RESOLVE AS "THIS READER BLOCKS NOBODY" (2026-08-12).
      //
      // This returned an empty list on any failure. React Query saw a SUCCESSFUL
      // result, so it never retried and never set `isError` — the same defect the
      // mute list had, where a timed-out `get_following` was reported as "you mute
      // nobody" and cost 3 of 4 page loads their moderation silently.
      //
      // Throwing is most of the fix on its own: retry with backoff now engages, so a
      // transient failure recovers instead of quietly unblocking everyone for the
      // rest of the session.
      //
      // `res.ok` is the HTTP status. The route answers 200 even when it degrades and
      // reports the real outcome in the body's `ok`, so both are checked.
      const res = await fetch('/api/lite/block/list');
      if (!res.ok) throw new Error(`block list read failed: HTTP ${res.status}`);
      const body = (await res.json()) as { ok?: boolean; userIds?: string[]; names?: string[] };
      if (body.ok === false) throw new Error('block list read failed server-side');
      return { userIds: body.userIds ?? [], names: body.names ?? [] };
    }
  });
  // ★ MEMOISED, and that is not a micro-optimisation. Building fresh Sets on every
  // render would hand every consumer a NEW object each time, and consumers put this
  // in `useMemo` dependency arrays (the comment thread does) — so the thread would
  // re-sort and re-paginate on every single render of the post page.
  return useMemo(() => {
    if (isError) return UNKNOWN_LIST;
    if (!data) return EMPTY_LIST;
    return {
      userIds: new Set(data.userIds),
      names: new Set(data.names.map((n) => n.toLowerCase())),
      loaded: true,
      unknown: false
    };
  }, [data, isError]);
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
