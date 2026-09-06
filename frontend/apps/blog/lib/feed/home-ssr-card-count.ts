/**
 * ★★★ HOW MANY OF THE SIGNED-IN HOME'S CARDS THE SERVER RENDERS (2026-09-06,
 * SIGNED-IN-HOME-BUILD-MAP-2026-09-06.md item 2). Pure, no I/O, unit-tested
 * next door — same shape as `postsPrefetchBudgetMs` beside it.
 *
 * MEASURED: React DOM server rendering of the post-card module costs about
 * 4ms per card (section 3.4 of the build map), so all 45 seeded cards on the
 * signed-in home cost about 180ms of the "uncovered" render floor (section
 * 3.2's RSC-versus-HTML delta). The seed keeps every entry regardless — the
 * client needs all 45 for infinite scroll, the "new posts" poll and the
 * ready-to-swap offer, and the flight payload is cheap (a few tens of ms,
 * section 4.3) — only the HTML `ForYouFeed` actually paints on first render
 * shrinks, from `home-shell.tsx` down.
 *
 * SIGNED-OUT IS UNTOUCHED: the anonymous home is edge-cached and must stay
 * byte-identical for crawlers and no-JS readers, so `isSignedIn: false`
 * always returns every seeded entry — the same "render everything" behaviour
 * this file existed to change nothing about.
 *
 * `env` is injectable for the test only; production always passes
 * `process.env`, and the ONLY real caller is `home-shell.tsx` (a Server
 * Component, never bundled to the client) — `ForYouFeed` itself receives the
 * already-decided count as a plain prop, so nothing client-executed ever
 * reads `LUMEN_HOME_SSR_CARDS`.
 */
export const DEFAULT_HOME_SSR_CARDS = 12;

/**
 * ★ THE OFF SWITCH (2026-09-06, coordinator review). `'all'`, `'0'` and
 * `'Infinity'` (case-insensitive, whitespace trimmed) all mean "render every
 * seeded entry, same as signed-out" — three spellings because ops reaching
 * for this in a hurry will try whichever reads naturally, and none of them
 * should be a guessing game. Checked BEFORE numeric parsing so `'0'` means
 * "off" here, not "malformed" the way it would for a budget-in-ms knob.
 *
 * Anything else that is not a positive finite integer — unset, empty,
 * `'   '`, `abc`, negative, a decimal — falls back to the constant rather
 * than producing a count of NaN or 0, either of which would render an empty
 * (or garbled) home for every signed-in reader off a single typo. Same rule
 * as `budgetOverride` in `posts-prefetch-budget.ts`.
 */
const HOME_SSR_CARDS_ALL_TOKENS = new Set(['all', '0', 'infinity']);

function cardCountOverride(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (HOME_SSR_CARDS_ALL_TOKENS.has(raw.trim().toLowerCase())) return Number.POSITIVE_INFINITY;
  const override = Number(raw);
  if (!Number.isFinite(override) || !Number.isInteger(override) || override <= 0) return fallback;
  return override;
}

/**
 * How many cards to render on the server for this viewer.
 *   · signed out -> every seeded entry (`Number.POSITIVE_INFINITY`; a slice up
 *     to it is the whole array, and it can never be less than a real count).
 *   · signed in  -> `LUMEN_HOME_SSR_CARDS` if it parses to a positive integer,
 *     `Number.POSITIVE_INFINITY` if it is the off switch (`'all'`/`'0'`/
 *     `'Infinity'`), else `DEFAULT_HOME_SSR_CARDS` (12).
 * Either way, a caller that gets `Number.POSITIVE_INFINITY` back must treat it
 * as "nothing is truncated" — see `ForYouFeed`'s `revealed` initial state,
 * which starts `true` exactly when this returns `Infinity`, so the
 * `hasNextPage`/`endLabel` gates built for the truncated case are inert.
 */
export function getHomeSsrCardCount(
  isSignedIn: boolean,
  env: Record<string, string | undefined> = process.env
): number {
  if (!isSignedIn) return Number.POSITIVE_INFINITY;
  return cardCountOverride(env.LUMEN_HOME_SSR_CARDS, DEFAULT_HOME_SSR_CARDS);
}
