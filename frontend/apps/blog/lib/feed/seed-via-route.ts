import 'server-only';
import { cookies } from 'next/headers';
import type { Entry } from '@hive/common-hiveio-packages/wax';
import { getLogger } from '@ui/lib/logging';

const logger = getLogger('app');

/**
 * ★★★ SEED AN ACCOUNT-POSTS LIST FROM OUR OWN /api ROUTE, SERVER-SIDE (2026-09-03).
 *
 * WHY THIS EXISTS. A profile/feed/comments server component seeds page 1 by
 * calling `getAccountPosts` (wax `getChain().api.bridge.get_account_posts`)
 * DURING the React Server Component render. Measured on production: that call
 * deterministically fails in the render context (get_account_posts returns
 * null / times out under the profile render's parallel chain fan-out), so the
 * seed is empty, the posts are absent from the SSR HTML, and the browser
 * refetches `/api/account-posts` ~1.4s later. The profile is the slowest page
 * we serve for exactly this reason.
 *
 * The SAME read via the `/api/account-posts` ROUTE succeeds reliably (~0.45s
 * warm) - it runs in an isolated route-handler context, not inside the heavy
 * profile render. So the fix is not "call the chain harder from the render"
 * (that is the thing that fails); it is to seed from the path that already
 * works: a loopback self-fetch to our own route.
 *
 * This is a FALLBACK, not a replacement. The caller still tries the direct
 * `getAccountPosts` first (when it works, it is the fastest path and costs no
 * extra hop); this only fires when that came back empty - which today is every
 * time on the profile. Strictly >= the current behaviour.
 *
 * The route returns entries that are ALREADY resolved (lite identities),
 * owner-block filtered, viewer-block filtered, engagement-merged and trimmed
 * for a card - the exact same processing the direct seed path does by hand - so
 * the result is a drop-in for `initialPosts`; the caller must NOT re-process it.
 *
 * BUDGET. The loopback is awaited (an SSR seed must be in the HTML), so it is
 * raced against `PROFILE_SEED_LOOPBACK_BUDGET_MS`: a warm route lands well
 * inside it and the cards render server-side; a cold/slow one is abandoned and
 * the page falls through to the client fetch exactly as it does today, so TTFB
 * is bounded by the budget in the worst case.
 *
 * OPT-IN. `PROFILE_SEED_LOOPBACK=yes` gates it (default off = today's
 * behaviour) so it can be enabled and verified on prod, and reverted instantly
 * by unsetting the flag, without a rebuild - the same rollout posture as
 * FEED_STREAK_WARM and BEHIND_CLOUDFLARE.
 *
 * 127.0.0.1 is exempt from the middleware request budget (request-budget.ts),
 * the same loopback the streak warmer uses (lib/feed/viewer-warmer.ts), so this
 * self-fetch is not itself rate-limited. The viewer's own cookies are forwarded
 * so the route applies the correct per-viewer block filter (effect A); without
 * them a signed-in reader could momentarily see an author they had blocked.
 */

const isEnabled = (): boolean => (process.env.PROFILE_SEED_LOOPBACK || '').toLowerCase() === 'yes';

const budgetMs = (): number => {
  const raw = Number(process.env.PROFILE_SEED_LOOPBACK_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 1200;
};

const selfBaseUrl = (): string =>
  process.env.PROFILE_SEED_LOOPBACK_BASE || `http://127.0.0.1:${process.env.PORT || 3000}`;

/**
 * Seed page 1 of an account's posts/comments/feed from `/api/account-posts`.
 *
 * `sort` is the bridge sort the route accepts ('posts' | 'comments' | 'feed' |
 * 'blog' | 'replies' | 'payout') - pass the same value the client hook uses.
 * Returns fully-processed entries ready to hand straight to the client seed, or
 * `null` when disabled, empty, degraded, or over budget (caller keeps its own
 * fallback).
 */
export async function seedAccountEntriesViaRoute(
  sort: string,
  account: string,
  observer: string
): Promise<Entry[] | null> {
  if (!isEnabled()) return null;
  if (!account) return null;

  const params = new URLSearchParams({ sort, account });
  if (observer) params.set('observer', observer);
  const url = `${selfBaseUrl()}/api/account-posts?${params.toString()}`;

  // Forward the viewer's session so the route filters for the right reader.
  let cookieHeader = '';
  try {
    cookieHeader = cookies().toString();
  } catch {
    // cookies() can only be read in a request scope; if it is unavailable the
    // route degrades open (anonymous view) rather than failing the seed.
    cookieHeader = '';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs());
  try {
    const res = await fetch(url, {
      headers: cookieHeader ? { cookie: cookieHeader } : {},
      cache: 'no-store',
      signal: controller.signal
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { entries?: Entry[] | null; degraded?: unknown };
    // The route flags a failed/withheld read with `degraded`; treat that as no
    // seed (the caller's client fetch will surface the honest error), never as
    // "this account has nothing".
    if (body.degraded) return null;
    const entries = body.entries ?? null;
    return entries && entries.length > 0 ? entries : null;
  } catch (error) {
    // Abort (over budget) or transport error: no seed, fall through to the
    // client fetch. Not an error condition - it is the designed fallback.
    logger.warn(
      'seedAccountEntriesViaRoute(%s,%s): loopback did not seed (%s)',
      sort,
      account,
      (error as Error)?.name === 'AbortError' ? `over ${budgetMs()}ms budget` : (error as Error)?.message
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
