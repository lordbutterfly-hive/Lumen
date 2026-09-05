/**
 * ★★★ HOW LONG THE PROFILE RENDER MAY WAIT FOR PAGE 1 OF A PROFILE'S POSTS,
 * DECIDED BY AUDIENCE (2026-09-05, cold-profile fix). Pure, no I/O, unit-tested
 * next door -- the only thing this module knows is "signed in or not".
 *
 * WHY THE NUMBER CANNOT BE ONE NUMBER. `posts-page.tsx` races
 * `getAccountPostsCached` against a deadline and renders whatever it has when
 * the deadline wins (see that file's own comment for the race itself). A cold
 * `get_account_posts` measures 0.5-2s, so a 500ms deadline loses on every
 * never-visited profile: measured on prod 2026-09-05, 5 of 8 cold profiles were
 * served with ZERO <article> elements in the HTML.
 *
 * For a SIGNED-IN reader that is an acceptable trade and stays at 500ms. Their
 * page is never held by a shared cache (`anonymous-cache-policy.ts` refuses any
 * request carrying a session cookie), the empty shell is theirs alone, and the
 * client refetch fills the posts in a beat -- exactly what the fast-shell design
 * intends.
 *
 * For an ANONYMOUS reader it is the wrong trade, because the answer is not
 * theirs alone. `/@name` answers `public, max-age=0, s-maxage=300,
 * stale-while-revalidate=3600` with Cloudflare and Caddy/Souin in front, so the
 * ONE render a cold profile costs is shared by every anonymous visitor for the
 * next 5 minutes (up to 60 with stale-while-revalidate). Two consequences, and
 * they point the same way:
 *   - a POSTLESS page is far more expensive than a slow one, because the edge
 *     stores it and hands the same empty profile to everybody for minutes;
 *   - one waiter pays the upstream cost for all of them, so waiting is cheap
 *     per reader in a way it never is for a signed-in reader.
 * Hence 3500ms: comfortably past the measured cold tail (0.5-2s) while still
 * bounded, so a genuinely dead upstream still cannot hold a render open.
 *
 * The losing promise is still never abandoned (see `posts-page.tsx`), so even a
 * lost anonymous race keeps filling the 25s cache for the next reader.
 */
export const POSTS_PREFETCH_BUDGET_MS = 500;
export const POSTS_PREFETCH_BUDGET_ANON_MS = 3500;

/**
 * The race budget in ms for this render. `env` is injectable for the test only;
 * production always passes `process.env`.
 *
 * `LUMEN_POSTS_BUDGET_ANON_MS` exists so the anonymous budget can be retuned (or
 * pulled back to today's behaviour with `500`) from `/opt/lumen/.env` without a
 * rebuild, which is what makes an on/off measurement possible at all. Anything
 * that is not a positive finite number -- unset, empty, `''`, `abc`, `0`,
 * negative -- falls back to the constant rather than producing a budget of NaN,
 * which `setTimeout` would silently treat as 0 and turn every anonymous render
 * postless. A misconfigured env var must never be worse than no env var.
 */
export function postsPrefetchBudgetMs(
  isSignedIn: boolean,
  env: Record<string, string | undefined> = process.env
): number {
  if (isSignedIn) return POSTS_PREFETCH_BUDGET_MS;
  const override = Number(env.LUMEN_POSTS_BUDGET_ANON_MS);
  if (!Number.isFinite(override) || override <= 0) return POSTS_PREFETCH_BUDGET_ANON_MS;
  return override;
}
