import { NextRequest, NextResponse } from 'next/server';
import { getLogger } from '@ui/lib/logging';
import { rankMarkAccounts, readRankMarks } from '@/blog/lib/rank-marks-read';

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

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('users') ?? '';
  // Validated, deduped and capped at 60 (`rankMarkAccounts`), the same way the single-account
  // route validates, so this cannot be used to fan arbitrary strings at the database.
  const accounts = rankMarkAccounts(raw.split(','));

  if (accounts.length === 0) return NextResponse.json({ marks: {} });

  try {
    // The keyless-name (squatter) filter lives in `readRankMarks`, shared with the home
    // page's server seed; its note there says why it filters on read (2026-09-11).
    const marks = await readRankMarks(accounts);
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
