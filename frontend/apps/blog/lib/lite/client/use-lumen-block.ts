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

/**
 * ★★★ THE N+1 FIX — WHY THIS IS A REQUEST-COALESCING LAYER, NOT A SWITCH TO THE
 * LIST ENDPOINT (2026-08-12).
 *
 * Measured: `/api/lite/block/state` fired once per distinct author on a feed page
 * (20-30 parallel requests on one home load) and once per comment author on a post
 * thread (~100 on a 50-comment page) — every mounted card runs its own
 * `useLumenBlock`, and React Query has no way to know two different QUERY KEYS
 * (one per `target`) are answerable from the same trip.
 *
 * `/api/lite/block/list` (below, `useLumenBlockList`) already solves a DIFFERENT
 * problem the same way a fix here might look tempting to lean on — but it cannot
 * stand in for this hook, for two reasons that matter:
 *
 *   1. It answers "who has the viewer blocked", which gives `isBlocking` for free,
 *      but NOT `available` — whether a Block control belongs here at all. That
 *      needs the SAME self-check and name-resolution `blockState` already does
 *      (not yourself, and the name actually resolves to a real actor), which the
 *      list was never asked and does not carry.
 *   2. It is fetched with `staleTime: 60s` and shared across the WHOLE page by
 *      query-key dedup already — reusing it here would still leave `available`
 *      unanswered, so this hook would need to run ITS OWN per-target request for
 *      that half anyway, buying nothing.
 *
 * So the fix is a request-coalescing layer: every mounted `useLumenBlock` still
 * asks its own question through its own React Query cache entry (queryKey
 * unchanged below — `toggle()`'s `invalidateQueries` below still targets exactly
 * the pair that changed), but the ACTUAL FETCH is deferred a few milliseconds and
 * merged with every other pending request into ONE call to
 * `/api/lite/block/state-bulk`. The batched server-side work
 * (`blockStatesBulk`/`resolveBlockTargetsBulk`, `lib/lite/social/block-service.ts`
 * and `block-actor.ts`) answers the SAME question this hook always asked —
 * `available` AND `isBlocking`, per exact target — just for N targets in one trip
 * instead of N trips, so nothing about what a caller receives changes.
 *
 * A short `setTimeout` window, not a bare microtask: every card on an SSR-hydrated
 * page mounts in the same commit, but React can flush passive effects across more
 * than one pass (concurrent features, a Suspense boundary settling separately), and
 * a microtask queued by the FIRST request would fire before a later pass's requests
 * exist to join it. A few milliseconds of macrotask delay costs nothing perceptible
 * next to the network round trip it is replacing 20-30 of, and still catches every
 * request from the same render burst.
 */
const BATCH_WINDOW_MS = 10;

interface PendingBlockRequest {
  resolve: (value: { available: boolean; blocking: boolean }) => void;
  reject: (error: Error) => void;
}

/** One entry per distinct `(kind, target)` pair currently waiting on a flush. */
interface PendingBlockGroup {
  target: string;
  targetKind: 'hive' | 'lumen';
  requests: PendingBlockRequest[];
}

function pendingKey(target: string, targetKind: 'hive' | 'lumen'): string {
  return `${targetKind}:${target}`;
}

// Module-scope by design: this is what lets every `useLumenBlock` instance on the
// page — one per card, mounted independently — join the SAME outbound request
// rather than each keeping its own queue.
let pendingBlockBatch: Map<string, PendingBlockGroup> | null = null;
let blockBatchTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleBlockBatchFlush(): void {
  if (blockBatchTimer) return;
  blockBatchTimer = setTimeout(() => {
    const batch = pendingBlockBatch;
    pendingBlockBatch = null;
    blockBatchTimer = null;
    if (batch) void flushBlockBatch(batch);
  }, BATCH_WINDOW_MS);
}

/**
 * ★ DELIVERED IN CHUNKS, NOT ONE TIGHT LOOP — MEASURED, NOT THEORISED (2026-08-12).
 *
 * A first version of this file settled every pending promise in a single
 * synchronous `for` loop. On a real 30-card home feed that reproducibly crashed
 * the page: React's console reported "Maximum update depth exceeded" inside
 * Radix's `Popper`/`Menu`/`DropdownMenu` stack, caught by the app's nearest error
 * boundary (`NotFoundErrorBoundary`) — every `MediumPostCard`'s overflow menu
 * mounting/updating in the same React commit apparently trips something in that
 * third-party stack. Confirmed by direct A/B on the same running dev server: the
 * pre-fix code (30 staggered network responses, naturally spread over real time by
 * the browser's own per-host connection limit) never crashed it; resolving the
 * SAME 30 answers from one bulk response, all in one JS turn, did — every time.
 * An 8-target comment thread (`CommentListItem` uses the identical DropdownMenu)
 * did not crash either, so this is a volume effect, not a shape-of-code one.
 *
 * `MediumPostCard`/the Radix stack are not this file's to fix — see the ownership
 * note at the top of this file. The fix that belongs here is to stop HANDING every
 * consumer its answer in the same commit: settle a few requests, yield a real
 * macrotask (`setTimeout(0)`, not a microtask — a microtask would not give React a
 * chance to actually commit and paint in between), then settle the next few. This
 * keeps the network win (still exactly one HTTP request) while spreading its 30
 * answers back out over several small React commits, the way independent network
 * completions used to.
 */
const DELIVERY_CHUNK_SIZE = 6;

async function deliverInChunks(groups: PendingBlockGroup[], settle: (group: PendingBlockGroup) => void): Promise<void> {
  for (let i = 0; i < groups.length; i += DELIVERY_CHUNK_SIZE) {
    for (const group of groups.slice(i, i + DELIVERY_CHUNK_SIZE)) settle(group);
    if (i + DELIVERY_CHUNK_SIZE < groups.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
}

async function flushBlockBatch(batch: Map<string, PendingBlockGroup>): Promise<void> {
  const groups = [...batch.values()];
  let settle: (group: PendingBlockGroup) => void;
  try {
    const targets = groups.map((g) => [g.target, g.targetKind]);
    const params = new URLSearchParams({ targets: JSON.stringify(targets) });
    const res = await fetch(`/api/lite/block/state-bulk?${params.toString()}`);
    // Same rule the single-item read documented below: a failed lookup must never
    // resolve as a clean answer. Throwing here rejects every promise in this
    // flush, so every one of THIS BATCH's queries throws and engages its own
    // retry — none of them silently resolve "not blocked".
    if (!res.ok) throw new Error(`block bulk state read failed: HTTP ${res.status}`);
    const body = (await res.json()) as {
      ok?: boolean;
      states?: Array<{ target: string; kind: string; available: boolean; blocking: boolean }>;
    };
    if (body.ok === false || !body.states) throw new Error('block bulk state read failed server-side');
    const byKey = new Map(body.states.map((s) => [pendingKey(s.target, s.kind as 'hive' | 'lumen'), s]));
    settle = (group) => {
      const state = byKey.get(pendingKey(group.target, group.targetKind));
      for (const req of group.requests) {
        if (state) req.resolve({ available: state.available, blocking: state.blocking });
        // A target this hook asked for but the response omitted is the same
        // "could not find out" outcome as an HTTP failure, not "not blocked" —
        // never silently substitute a clean answer for a missing one.
        else req.reject(new Error('block state missing from bulk response'));
      }
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error('block bulk state read failed');
    settle = (group) => {
      for (const req of group.requests) req.reject(err);
    };
  }
  await deliverInChunks(groups, settle);
}

/** Joins (or starts) the current coalescing window for one `(target, kind)` pair. */
function requestBlockState(
  target: string,
  targetKind: 'hive' | 'lumen'
): Promise<{ available: boolean; blocking: boolean }> {
  return new Promise((resolve, reject) => {
    if (!pendingBlockBatch) pendingBlockBatch = new Map();
    const key = pendingKey(target, targetKind);
    const existing = pendingBlockBatch.get(key);
    if (existing) existing.requests.push({ resolve, reject });
    else pendingBlockBatch.set(key, { target, targetKind, requests: [{ resolve, reject }] });
    scheduleBlockBatchFlush();
  });
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
    // Same rule as the list read below: a failed lookup resolved as
    // `blocking: false`, which React Query treated as a success — no retry, and a
    // Block button that offers to block somebody the reader has ALREADY blocked.
    // Throwing engages retry, so a transient failure recovers on its own — see
    // `requestBlockState`/`flushBlockBatch` above for where that throw now
    // originates (a shared, coalesced fetch instead of one fetch per card).
    queryFn: () => requestBlockState(target, targetKind)
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
