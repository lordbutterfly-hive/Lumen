import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { listRankMarks } from '@/blog/lib/lite/repositories/hive-retention-repository';
import { isKeylessLiteName } from '@/blog/lib/lite/render/lite-identity';

const logger = getLogger('app');

/**
 * ════ THE BATCH RANK READ THAT LETS THE BYLINE MARK EXIST ════
 *
 * `features/retention/components/league-byline.tsx` has been mounted nowhere since
 * 2026-08-08, and its own comment names the only acceptable fix: *"the rung must come
 * from the same source the profile uses (/api/streak/[user] via useRetention), never from
 * a per-post reputation proxy. A feed of N authors means N of those lookups, so the
 * honest fix is a batch endpoint — not a second, cheaper, disagreeing rank function."*
 *
 * This is that endpoint.
 *
 * ★★ IT NEVER COMPUTES ANYTHING, AND THAT IS THE WHOLE DESIGN. A naive batch over the
 * real route would fan ~50 Hive calls PER AUTHOR — a 20-author page would issue a
 * thousand upstream requests, which is why this was never built. So this reads ONLY the
 * `lumen_hive_rank` snapshot (migration 0029), written as a side effect whenever
 * `/api/streak/[user]` computes a rank for real. One indexed SELECT, zero Hive calls,
 * regardless of page size.
 *
 * ★ THE HONEST CONSEQUENCE: an author nobody has looked up yet has no snapshot, so no
 * mark renders for them. Marks appear progressively across the network rather than all at
 * once. That is a real limitation and it is strictly better than the two alternatives —
 * fanning out (unaffordable) or deriving a second cheaper rank (the exact bug that
 * unmounted the component). A stale snapshot is dropped by the TTL in the repository for
 * the same reason: a wrong mark is worse than no mark.
 *
 * ★ ABSENT IS NOT RUNG 1. The response omits unknown accounts entirely rather than
 * returning a floor value, so a consumer cannot mistake "not computed" for "lowest rank".
 */

/** Bound the fan-in. A feed page is ~20 authors; this is generous and caps abuse. */
const MAX_ACCOUNTS = 60;
const USERNAME_RE = /^[a-z0-9.-]{3,16}$/;

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('users') ?? '';
  // Validated the same way the single-account route validates, so this cannot be used to
  // fan arbitrary strings at the database.
  const accounts = raw
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter((a) => USERNAME_RE.test(a))
    .slice(0, MAX_ACCOUNTS);

  if (accounts.length === 0) return NextResponse.json({ marks: {} });

  try {
    const rows = await listRankMarks(accounts);
    /**
     * ★★★ THE WRITE GUARD DOES NOT REPAIR WHAT WAS ALREADY WRITTEN (2026-09-11).
     *
     * `/api/streak/[user]` now refuses to COMPUTE a rank for a keyless Lumen name, which
     * stops new rows. It does nothing about rows already in `lumen_hive_rank`, and this
     * route had no identity check at all: `lumen_hive_rank.account` is a bare `citext`
     * name, so a row computed from a SQUATTER's chain account is returned under the
     * victim's handle for the full 7-day TTL.
     *
     * Measured on production 2026-09-11, before this guard existed:
     *   /api/streak/marks?users=chadmasters,luxattack,meritimusdoublus,arsha
     *   -> chadmasters: tier "spark" rank 1, meritimusdoublus: tier "spark" rank 1,
     *      luxattack: "unranked"  (arsha, uncontested, correctly absent)
     * Three real impersonated users, each carrying a standing derived entirely from the
     * account that took their name, on a public unauthenticated endpoint.
     *
     * Filtering on READ is the half that self-heals: it repairs the existing rows
     * immediately on deploy instead of waiting out the TTL, and it keeps working if a
     * future squatter is detected after a rank was already snapshotted. The stale rows
     * should still be deleted (see the ops note in the fix report), but correctness no
     * longer depends on someone remembering to.
     *
     * Omitted, never zeroed: this route's own contract is that an absent account means
     * "not computed", and a consumer must not read a suppressed mark as rung one.
     */
    const keyless = await Promise.all(rows.map((r) => isKeylessLiteName(r.account)));
    const marks: Record<string, { tier: string; rankNumber: number; showMark: boolean }> = {};
    rows.forEach((r, i) => {
      if (keyless[i]) return;
      marks[r.account.toLowerCase()] = {
        tier: r.tier,
        rankNumber: r.rankNumber,
        showMark: r.showMark
      };
    });
    return NextResponse.json(
      { marks },
      // Short public cache: a rank changes slowly, a feed page is requested often, and
      // this response contains nothing viewer-specific.
      { headers: { 'cache-control': 'public, max-age=60' } }
    );
  } catch (err) {
    // ★ A FAILED READ RETURNS AN EMPTY SET, NOT AN ERROR. The mark is decoration; the
    // feed must render regardless. Degrading to "no marks" is invisible and correct,
    // where a 500 would take the feed down for a cosmetic.
    logger.warn(err, 'streak/marks: rank snapshot read failed');
    return NextResponse.json({ marks: {} });
  }
}
