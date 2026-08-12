'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { liteFollow } from './lite-write';

/**
 * The Follow button, for every pair Hive cannot represent.
 *
 * Three of the four possible follows have to live on Lumen: a lite user following
 * anyone (no key to sign with) and anyone following a lite user (no account on chain
 * to follow). Only Hive→Hive stays on chain, and this hook stays out of its way.
 *
 * It also supplies the state the button never had. The chain path reads the viewer's
 * Hive following list, which can never contain a Lumen edge, so a Lumen follow always
 * rendered as "Follow" no matter how many times it succeeded.
 *
 * `enabled` is the caller's cheap pre-filter — the surfaces that render this already
 * know whether either side is a lite account, so an ordinary Hive-to-Hive button
 * makes no request at all.
 */

export interface LumenFollow {
  /** True when this pair's follow belongs to Lumen rather than the chain. */
  applies: boolean;
  /** The state query has not answered yet — which path this button takes is unknown. */
  pending: boolean;
  isFollowing: boolean;
  busy: boolean;
  /**
   * The state read failed permanently (retries exhausted), so `applies: false` MEANS
   * "we don't know which path this button takes" — not "this pair is a chain follow".
   *
   * `applies` alone cannot carry that distinction: it is also `false` while the query
   * is still loading and whenever `enabled` is false, both of which are correctly "no
   * Lumen edge here, let the chain answer". Collapsing a permanent failure into the
   * same `false` used to route the click down the CHAIN path — a signer that does not
   * exist for a keyless viewer, or a `custom_json` follow broadcast against a name
   * that is not a Hive account at all (see the routing in buttons-container.tsx). Same
   * shape as `LumenBlock.unknown` on this hook's sibling, and the same fix: a caller
   * checks `unknown` and refuses to guess instead of defaulting to a path that can
   * misfire in exactly the cases this hook exists to cover.
   */
  unknown: boolean;
  /** Resolves to an error message when the follow was refused, else null. */
  toggle: () => Promise<string | null>;
}

export function useLumenFollow(target: string, enabled: boolean): LumenFollow {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const queryKey = ['lumenFollowState', target];

  const { data, isLoading, isError } = useQuery({
    queryKey,
    enabled: enabled && Boolean(target),
    staleTime: 60 * 1000,
    queryFn: async () => {
      // ★ A FAILED READ MUST NOT RESOLVE AS "NOT OURS, NOT FOLLOWING" (2026-08-12).
      //
      // This returned that pair on ANY failure — network error, a 5xx, a degraded
      // 200 — and React Query saw a SUCCESSFUL result: no retry, no `isError`. The
      // caller then read `applies: false` and took the CHAIN path, exactly like an
      // ordinary Hive-to-Hive follow. Same defect `use-lumen-block.ts` had on its
      // state read, and the same fix: throw so retry engages and a transient failure
      // recovers, instead of silently misrouting a follow that belongs on Lumen.
      //
      // `res.ok` is the HTTP status. The route answers 200 even when it degrades and
      // reports the real outcome in the body's `ok` (see follow/state/route.ts), so
      // both are checked.
      const res = await fetch(`/api/lite/follow/state?target=${encodeURIComponent(target)}`);
      if (!res.ok) throw new Error(`follow state read failed: HTTP ${res.status}`);
      const body = (await res.json()) as { ok?: boolean; lumenEdge: boolean; following: boolean };
      if (body.ok === false) throw new Error('follow state read failed server-side');
      return { lumenEdge: body.lumenEdge, following: body.following };
    }
  });

  const isFollowing = Boolean(data?.following);

  return {
    applies: Boolean(data?.lumenEdge),
    pending: enabled && Boolean(target) && isLoading,
    isFollowing,
    busy,
    // Scoped by construction, same as `pending` above: `enabled: enabled &&
    // Boolean(target)` on the query means it never runs — so never errors — when
    // this control does not apply, so `isError` is already exactly "the read that
    // WOULD have answered this failed", nothing more to gate here.
    unknown: isError,
    toggle: async () => {
      setBusy(true);
      const result = await liteFollow(target, isFollowing);
      setBusy(false);
      if (result.status === 'error') return result.message;
      // Re-read rather than flip locally: the server is the only thing that knows
      // whether the edge actually changed (a rate limit, a suspension, a name that
      // resolved to someone else).
      await queryClient.invalidateQueries({ queryKey });
      return null;
    }
  };
}
