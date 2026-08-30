'use client';

/**
 * The token page's fetch of ONE fact about its creator: their `website`
 * link (WORK-LINK spec B3, 2026-08-30 — owner: "Show them the work / People
 * check your profile before they hold anything").
 *
 * `TokenMarketView` fetches ZERO profile data about the creator today — the
 * avatar is a hashed CSS gradient (`avatarFill`) and the name is pure
 * string formatting (`displayHandle`, see this file's own header note and
 * `adapt.ts`). This is the first genuinely-fetched profile fact on that
 * page, and it goes through `/api/creator-profile` (B2) rather than reading
 * the chain/lite store directly, so the SAME render-time sanitisation
 * (`isSafeExternalHref`, via that route) runs on both a Hive account's
 * attacker-controlled `posting_json_metadata.website` and a lite account's
 * already-validated one — one gate, not two call sites trusting two
 * different layers to have done it.
 *
 * ★ Deliberately does NOT pass `cache: 'no-store'` to `fetch`, unlike most
 * of this feature's other API calls (e.g. `use-token-accounts.ts`'s
 * `/api/lite/wallet/dids`). Those routes are per-viewer and answer
 * `private, no-store`; this route answers `public, s-maxage=300,
 * stale-while-revalidate=3600` specifically so it CAN be reused by the
 * browser's own HTTP cache and any CDN in front of it. Forcing `no-store`
 * here would defeat the one thing the route was built to allow.
 */

import { useQuery } from '@tanstack/react-query';
import { StaleTime } from '@/blog/lib/react-query';

interface CreatorProfileResponse {
  website: string | null;
  displayName: string | null;
}

export interface CreatorProfileLink {
  /** Null while loading, absent, or unsafe — all three render as "show nothing". */
  website: string | null;
  isLoading: boolean;
}

export function useCreatorProfileLink(handle: string): CreatorProfileLink {
  const trimmed = handle.trim();

  const query = useQuery({
    queryKey: ['creator-profile', trimmed],
    queryFn: async (): Promise<CreatorProfileResponse> => {
      const res = await fetch(`/api/creator-profile?handle=${encodeURIComponent(trimmed)}`);
      // B2 is contracted to never 500 — a non-OK response here means the
      // request itself couldn't be completed (network), which react-query's
      // own retry/error state already handles. Never invent a website from
      // a failed fetch.
      if (!res.ok) throw new Error(`creator-profile lookup failed: ${res.status}`);
      return (await res.json()) as CreatorProfileResponse;
    },
    enabled: trimmed.length > 0,
    staleTime: StaleTime.LONG
  });

  return {
    website: query.data?.website ?? null,
    isLoading: query.isLoading
  };
}
