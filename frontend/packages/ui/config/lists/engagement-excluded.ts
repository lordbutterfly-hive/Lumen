import env from '@beam-australia/react-env';

/**
 * ENGAGEMENT EXCLUSION LIST — accounts whose ENGAGEMENT counts for nothing, while
 * their own posts rank and render normally.
 *
 * ★★ THIS IS NOT THE BAN LIST, and the difference is the whole point (owner, recsys
 * 2026-08-09: "dont ban them like trolls, only ban them from the ranker and algo").
 * A ban does two things — hides the account's posts AND stops their engagement
 * counting. That is right for a troll and wrong for a curation bot: @curangel's
 * curation compilation was the #1 post in the popularity lane on 2026-08-09, a real
 * post real people read. What must not count is the other direction. `worldmappin`
 * commented on 44 distinct authors in 36 hours; `pizzabot` on 104. Counting those as
 * "people who engaged with you" measures which posts a bot found, not which posts
 * humans talked about — and curation is a service an author can solicit, so it is
 * farmable by design.
 *
 * ★ IT IS A MIRROR, AND THE TWIN IS AUTHORITATIVE FOR THE RANKER.
 * `recsys/recsys/data/curator_accounts.txt` + `recsys/core/curators.py` hold the same
 * list for the Python recommender, which is a separate service and cannot import from
 * this repo. Two copies is a drift risk and it is accepted deliberately rather than
 * hidden: the ranker's copy decides what gets SHOWN, this copy decides what the
 * retention ladder COUNTS, and a name missing from one is a wrong number, not an
 * outage. Keep them in step, and prefer the env var below for anything urgent —
 * `RECSYS_CURATOR_ACCOUNTS` and `LUMEN_ENGAGEMENT_EXCLUDED` can be set from one value
 * so ops extends both at once without editing either file.
 *
 * WHERE THE NAMES COME FROM — the committed list plus two optional env vars, unioned:
 *
 *   REACT_APP_ENGAGEMENT_EXCLUDED  read through react-env, so it is legible on the
 *                                  server AND in the browser. Use this one. The
 *                                  browser needs it because several retention
 *                                  surfaces read notifications and voter lists
 *                                  DIRECTLY from a public Hive node, with our server
 *                                  nowhere in the request path.
 *   LUMEN_ENGAGEMENT_EXCLUDED      plain server-side env, never reaches the browser.
 *
 * Same shape as the ban list: names separated by commas, whitespace or semicolons,
 * with or without a leading `@`, in any case.
 */

/**
 * Seeded from the owner's list plus accounts measured commenting across 40+ distinct
 * authors in a 36-hour window. Kept in the same three groups as the recsys file so a
 * diff between the two is readable.
 */
const engagementExcludedSeed = `
# curation trails / communities (owner-named)
worldmappin
curie
visualshots
la-colmena
qurator
discovery-it
discovery-ot

# measured high-fanout automated commenters
hivebuzz
pizzabot
actifit
splinterboost
bpcvoter1
curamax
ladytoken
hscr-isrc

# well-known service bots
poshtoken
hiveposh
dustsweeper
ecency
bilpcoinbpc
indiaunited
`;

/** Hive account names are lower-case; normalise so `@Bot` and `bot` are one name. */
function normalise(name: string): string {
  return name.trim().toLowerCase().replace(/^@+/, '');
}

/** Strips `#` comments so the seed block above can stay annotated. */
function parseList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,;]+/)
    .map((part) => part.split('#', 1)[0])
    .map(normalise)
    .filter(Boolean);
}

/**
 * Resolved LAZILY and then memoised — the same race the ban list documents. On the
 * client `env()` reads `window.__ENV`, installed by a `/__ENV.js` script tag, so
 * reading at module-evaluation time can memoise an EMPTY set for the life of the page
 * and silently stop excluding anybody.
 */
let cached: Set<string> | null = null;

function excludedSet(): Set<string> {
  if (cached) return cached;
  const seed = parseList(engagementExcludedSeed.replace(/^#.*$/gm, ''));
  const fromPublic = parseList(env('ENGAGEMENT_EXCLUDED'));
  // Guarded so bundlers that inline `process.env` in browser builds cannot throw.
  const fromServer =
    typeof process !== 'undefined' && process.env ? parseList(process.env.LUMEN_ENGAGEMENT_EXCLUDED) : [];
  cached = new Set([...seed, ...fromPublic, ...fromServer]);
  return cached;
}

/** Test seam only — the lazy memo above is otherwise permanent for the process. */
export function resetEngagementExcludedCache(): void {
  cached = null;
}

/** Every excluded name, sorted. For diagnostics and tests, never for a hot path. */
export function engagementExcludedList(): string[] {
  return [...excludedSet()].sort();
}

/**
 * True when this account's engagement must not count toward anybody's numbers.
 *
 * Deliberately tolerant of `undefined` and of a leading `@`: callers pass raw voter
 * names, comment authors and notification-parsed handles straight in.
 */
export function isEngagementExcluded(name: string | undefined | null): boolean {
  if (!name) return false;
  return excludedSet().has(normalise(name));
}
