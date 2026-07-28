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
  /** Resolves to an error message when the follow was refused, else null. */
  toggle: () => Promise<string | null>;
}

export function useLumenFollow(target: string, enabled: boolean): LumenFollow {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const queryKey = ['lumenFollowState', target];

  const { data, isLoading } = useQuery({
    queryKey,
    enabled: enabled && Boolean(target),
    staleTime: 60 * 1000,
    queryFn: async () => {
      const res = await fetch(`/api/lite/follow/state?target=${encodeURIComponent(target)}`);
      if (!res.ok) return { lumenEdge: false, following: false };
      return (await res.json()) as { lumenEdge: boolean; following: boolean };
    }
  });

  const isFollowing = Boolean(data?.following);

  return {
    applies: Boolean(data?.lumenEdge),
    pending: enabled && Boolean(target) && isLoading,
    isFollowing,
    busy,
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
