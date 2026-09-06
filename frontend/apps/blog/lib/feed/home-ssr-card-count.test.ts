/**
 * `getHomeSsrCardCount` invariants — plain assertions, no test runner (this
 * repo has none; same style as `posts-prefetch-budget.test.ts` beside it).
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/feed/home-ssr-card-count.test.ts
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 *
 * WHY THIS EXISTS: signed-in-home-build-map-2026-09-06.md item 2 slices the
 * signed-in home's card list to `getHomeSsrCardCount(...)` on the server, then
 * reveals the rest after hydration. The ways that silently breaks are
 * (a) the signed-out branch stops returning "everything", which would make the
 * edge-cached anonymous page byte-different for crawlers and no-JS readers,
 * (b) a malformed `LUMEN_HOME_SSR_CARDS` parses to NaN/0, which would render
 * zero cards (or all of them via a falsy slice bound) for every signed-in
 * reader off one typo in the environment, and (c) the OFF SWITCH — `'all'`,
 * `'0'`, `'Infinity'` — stops meaning "render everything" (coordinator review
 * 2026-09-06: this is the escape hatch for a bad deploy, so it has to work).
 */
import { getHomeSsrCardCount, DEFAULT_HOME_SSR_CARDS } from './home-ssr-card-count';

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    failures += 1;
  }
}

const EMPTY: Record<string, string | undefined> = {};

// 1. THE SPLIT ITSELF.
check(
  'signed-out gets every seeded entry (Infinity — slice(0, Infinity) is the whole array)',
  getHomeSsrCardCount(false, EMPTY) === Number.POSITIVE_INFINITY
);
check(
  `signed-in gets the default (${DEFAULT_HOME_SSR_CARDS})`,
  getHomeSsrCardCount(true, EMPTY) === DEFAULT_HOME_SSR_CARDS
);
check('the default really is 12, not something the fix silently changed', DEFAULT_HOME_SSR_CARDS === 12);

// 2. THE ENV OVERRIDE, SIGNED-IN ONLY.
check(
  'a valid override is honoured for a signed-in viewer',
  getHomeSsrCardCount(true, { LUMEN_HOME_SSR_CARDS: '8' }) === 8
);
check(
  'the override can restore the default explicitly (the off switch)',
  getHomeSsrCardCount(true, { LUMEN_HOME_SSR_CARDS: String(DEFAULT_HOME_SSR_CARDS) }) === DEFAULT_HOME_SSR_CARDS
);
check(
  'a large override is honoured (effectively "render them all" without touching the signed-out branch)',
  getHomeSsrCardCount(true, { LUMEN_HOME_SSR_CARDS: '45' }) === 45
);

// 2b. THE OFF SWITCH (coordinator review 2026-09-06). Three spellings, all
//     case-insensitive and whitespace-tolerant, all meaning "render every
//     seeded entry" for a SIGNED-IN viewer — the escape hatch if 12 turns out
//     to be wrong in production and a fast, no-rebuild revert is needed.
for (const on of ['all', 'ALL', ' All ', '0', 'Infinity', 'INFINITY', ' infinity ']) {
  const got = getHomeSsrCardCount(true, { LUMEN_HOME_SSR_CARDS: on });
  check(
    `off switch ${JSON.stringify(on)} means "render everything" for signed-in (got ${got})`,
    got === Number.POSITIVE_INFINITY
  );
}
check(
  'when the off switch is set, revealed must be able to start true (Infinity is the exact signal ForYouFeed checks)',
  getHomeSsrCardCount(true, { LUMEN_HOME_SSR_CARDS: 'all' }) === Number.POSITIVE_INFINITY
);

// 3. THE OVERRIDE NEVER REACHES THE SIGNED-OUT BRANCH — the anonymous page
//    must stay byte-identical regardless of what ops sets for the signed-in
//    knob. This is the requirement a hydration/CLS regression would come from
//    if it silently broke.
check(
  'signed-out ignores the override entirely, even a small one',
  getHomeSsrCardCount(false, { LUMEN_HOME_SSR_CARDS: '3' }) === Number.POSITIVE_INFINITY
);
check(
  'signed-out ignores the override entirely, even a huge one',
  getHomeSsrCardCount(false, { LUMEN_HOME_SSR_CARDS: '999999' }) === Number.POSITIVE_INFINITY
);
check(
  'signed-out ignores the off switch too (it is already Infinity, but the override must never be read at all)',
  getHomeSsrCardCount(false, { LUMEN_HOME_SSR_CARDS: 'all' }) === Number.POSITIVE_INFINITY
);

// 4. EVERY MALFORMED OVERRIDE FALLS BACK TO THE DEFAULT, never to NaN/0/a
//    non-integer, and never SILENTLY treated as the off switch either.
//    `Array.prototype.slice(0, NaN)` renders ZERO cards — a typo in the
//    environment must never blank the signed-in home.
for (const bad of ['', '   ', 'abc', 'NaN', '-1', '-12', '1e', '-Infinity', '12.5', '12px', 'null', 'alll', '00']) {
  const got = getHomeSsrCardCount(true, { LUMEN_HOME_SSR_CARDS: bad });
  check(`malformed ${JSON.stringify(bad)} falls back to ${DEFAULT_HOME_SSR_CARDS} (got ${got})`, got === DEFAULT_HOME_SSR_CARDS);
}
check(
  'an unset override falls back',
  getHomeSsrCardCount(true, { LUMEN_HOME_SSR_CARDS: undefined }) === DEFAULT_HOME_SSR_CARDS
);

// 5. THE RETURN IS ALWAYS USABLE AS A `slice(0, n)` BOUND: a positive number
//    (finite for signed-in, Infinity for signed-out) for every input above —
//    never 0, negative or NaN, all of which would render an empty list.
const everyInput = [true, false].flatMap((isSignedIn) =>
  ['', 'abc', '0', '-5', '8', undefined].map((v) => getHomeSsrCardCount(isSignedIn, { LUMEN_HOME_SSR_CARDS: v }))
);
check(
  'every result is a positive number, never NaN, 0 or negative',
  everyInput.every((n) => !Number.isNaN(n) && n > 0)
);

// 6. NEGATIVE CONTROL: prove the malformed cases really would have broken
//    something without the guard, so check 4 is not vacuously passing.
check(
  'negative control: a bare Number() of the malformed values IS unusable as a slice bound',
  ['', 'abc', '-1', '12.5'].every((bad) => {
    const naive = Number(bad);
    return Number.isNaN(naive) || naive <= 0 || !Number.isInteger(naive);
  })
);
check(
  "negative control: 'all'/'Infinity' really would fail a bare numeric parse (proving the off switch needed its own branch, not just looser number parsing)",
  ['all', 'Infinity'].every((tok) => {
    const naive = Number(tok);
    return tok === 'all' ? Number.isNaN(naive) : !Number.isInteger(naive);
  })
);

if (failures === 0) {
  console.log('\nhome-ssr-card-count: ALL CHECKS PASSED');
  process.exit(0);
} else {
  console.error(`\nhome-ssr-card-count: ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
