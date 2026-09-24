import { listRankMarks } from '@/blog/lib/lite/repositories/hive-retention-repository';
import { isKeylessLiteName } from '@/blog/lib/lite/render/lite-identity';
import { getLogger } from '@ui/lib/logging';
import type { RankMarksRecord, RankMarksSeed } from '@/blog/components/observer-provider';

const logger = getLogger('app');

/** Bound the fan-in. A feed page is ~20 authors; this is generous and caps abuse. */
const MAX_ACCOUNTS = 60;
const USERNAME_RE = /^[a-z0-9.-]{3,16}$/;

/** Validated, lowercased, deduped and capped the same way for every caller. */
export function rankMarkAccounts(raw: string[]): string[] {
  return [...new Set(raw.map((a) => a.trim().toLowerCase()).filter((a) => USERNAME_RE.test(a)))].slice(0, MAX_ACCOUNTS);
}

/**
 * SERVER-ONLY. The byline marks for `accounts`, read from the `lumen_hive_rank` snapshot.
 * The one implementation behind both `/api/streak/marks` (see that route for why the mark is
 * a snapshot read and never a computation) and the home page's server seed below, so the two
 * can never apply different rules. Throws on a failed read; each caller decides what empty
 * means for it.
 *
 * ★★★ THE WRITE GUARD DOES NOT REPAIR WHAT WAS ALREADY WRITTEN (2026-09-11).
 *
 * `/api/streak/[user]` now refuses to COMPUTE a rank for a keyless Lumen name, which stops
 * new rows. It does nothing about rows already in `lumen_hive_rank`, and the marks route had
 * no identity check at all: `lumen_hive_rank.account` is a bare `citext` name, so a row
 * computed from a SQUATTER's chain account is returned under the victim's handle for the
 * full 7-day TTL.
 *
 * Measured on production 2026-09-11, before this guard existed:
 *   /api/streak/marks?users=chadmasters,luxattack,meritimusdoublus,arsha
 *   -> chadmasters: tier "spark" rank 1, meritimusdoublus: tier "spark" rank 1,
 *      luxattack: "unranked"  (arsha, uncontested, correctly absent)
 * Three real impersonated users, each carrying a standing derived entirely from the account
 * that took their name, on a public unauthenticated endpoint.
 *
 * Filtering on READ is the half that self-heals: it repairs the existing rows immediately on
 * deploy instead of waiting out the TTL, and it keeps working if a future squatter is
 * detected after a rank was already snapshotted. The stale rows should still be deleted (see
 * the ops note in the fix report), but correctness no longer depends on someone remembering
 * to. The home page's server seed goes through this same function, so a squatter's rank can
 * not reach a byline through the page HTML either.
 *
 * Omitted, never zeroed: an absent account means "not computed", and a consumer must not
 * read a suppressed mark as rung one.
 */
export async function readRankMarks(accounts: string[]): Promise<RankMarksRecord> {
  if (accounts.length === 0) return {};
  const rows = await listRankMarks(accounts);
  const keyless = await Promise.all(rows.map((r) => isKeylessLiteName(r.account)));
  const marks: RankMarksRecord = {};
  rows.forEach((r, i) => {
    if (keyless[i]) return;
    marks[r.account.toLowerCase()] = { tier: r.tier, rankNumber: r.rankNumber, showMark: r.showMark };
  });
  return marks;
}

/**
 * How long the home render waits for the marks before sending the page without them.
 * The read is one indexed SELECT plus one indexed lookup per ranked author. Measured on the
 * production box (2026-09-24, the home page's 17 authors, 8 sequential reads): 14-35 ms
 * once warm, with 160-320 ms spikes. Anonymous home's own data costs 2-7 ms, so this read
 * is the largest stage of that render; the cap keeps a spike from ever reaching the page
 * (it ships without the seed and the client asks, as before). `render-timing: home` logs
 * its real cost per render as `marks=`, with `seeded=yes|no`.
 */
const SEED_TIMEOUT_MS = 60;

/**
 * SERVER-ONLY. ★ THE FEED'S EMBLEMS AND AVATAR GLOW ARRIVE WITH THE PAGE (2026-09-24, owner:
 * "why are we recomputing emblems every time").
 *
 * Measured on production before this (anonymous home, 10 fresh loads): the glow appeared
 * a median 1153 ms after the request, about 850 ms after the HTML, because the marks were
 * asked for only after the page had hydrated (`useRankMarks`, one `/api/streak/marks` call
 * per load). The page already knows its authors on the server, so it reads the same
 * snapshot here and the hooks take it as `initialData` (see `seededRankMarks` in
 * use-rank-marks.ts), which puts the marks in the HTML and removes the call.
 *
 * `accounts` is every account that was ASKED, so the client can tell "asked, no mark" from
 * "not asked". Never throws and never waits past `SEED_TIMEOUT_MS`: any failure or a slow
 * read means no seed, and the client fetches exactly as before.
 */
export async function seedRankMarks(authors: string[]): Promise<RankMarksSeed | null> {
  const accounts = rankMarkAccounts(authors);
  if (accounts.length === 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const marks = await Promise.race([
      readRankMarks(accounts),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), SEED_TIMEOUT_MS);
      })
    ]);
    return marks ? { accounts, marks, at: Date.now() } : null;
  } catch (err) {
    logger.warn(err, 'rank marks seed failed; the client will fetch them');
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
