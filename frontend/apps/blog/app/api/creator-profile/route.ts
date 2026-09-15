import { NextRequest, NextResponse } from 'next/server';
import { NULL_PROFILE, readCreatorProfile } from '@/blog/lib/meritum/server-profile';

/**
 * `GET /api/creator-profile?handle=<...>` — the public profile facts about a
 * creator: `website` and `displayName` (WORK-LINK spec B2, 2026-08-30), and
 * since 2026-09-15 `about` and `profileImage` for the Meritum creator page.
 * The resolution, the squatter-safe ordering and every sanitiser live in
 * `lib/meritum/server-profile.ts`, which the creator page's metadata and its
 * share card call directly; this route is that function plus cache headers.
 *
 * WHY A ROUTE OF ITS OWN rather than `/api/account`: that route is Hive-only
 * and returns the FULL account (balances, manabar) as `private, no-store`.
 * This one returns four public, rarely-changing strings, identical for every
 * viewer, for Hive and lite/wallet creators alike, and wants to be cached.
 *
 * SHAPE: `{ website, displayName, about, profileImage }`, each a string or
 * null. Nothing else, ever — no balances, no email, no session-derived data.
 *
 * ★ Never 500s a page over a profile annotation: `readCreatorProfile` answers
 * the null shape on every failure, and so does this route on a bad handle.
 */
const CACHE_HEADERS = { 'cache-control': 'public, s-maxage=300, stale-while-revalidate=3600' } as const;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const rawHandle = (req.nextUrl.searchParams.get('handle') ?? '').trim();
  // ★ Public and cacheable even on the "nothing found" answer — a repeated
  // lookup for a creator with no profile is the common case, and identical
  // bytes with no cookie are exactly as safe to share across viewers.
  if (!rawHandle || rawHandle.length > 170) return NextResponse.json(NULL_PROFILE, { headers: CACHE_HEADERS });
  const profile = await readCreatorProfile(rawHandle);
  return NextResponse.json(profile, { headers: CACHE_HEADERS });
}
