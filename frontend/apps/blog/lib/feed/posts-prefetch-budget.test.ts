/**
 * `postsPrefetchBudgetMs` invariants - plain assertions, no test runner (this
 * repo has none; same style as lib/feed/__tests__/topic-warm-select.test.ts).
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/feed/posts-prefetch-budget.test.ts
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 *
 * WHY THIS EXISTS: the anonymous budget is the whole cold-profile fix, and the
 * two ways it can silently die are (a) somebody "simplifies" the signed-in
 * branch to the anonymous number, which would put a 3.5s wait in front of every
 * logged-in reader's TTFB, and (b) a malformed env override parsing to NaN,
 * which `setTimeout` treats as 0 - turning EVERY anonymous profile postless,
 * the exact bug this file exists to prevent, with no error anywhere.
 */
import {
  postsPrefetchBudgetMs,
  POSTS_PREFETCH_BUDGET_MS,
  POSTS_PREFETCH_BUDGET_ANON_MS
} from './posts-prefetch-budget';

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

// 1. THE SPLIT ITSELF. Signed-in keeps today's 500ms; anonymous gets the long
//    budget. This is the entire behavioural claim of the fix.
check(
  `signed-in budget is unchanged (${POSTS_PREFETCH_BUDGET_MS}ms)`,
  postsPrefetchBudgetMs(true, EMPTY) === POSTS_PREFETCH_BUDGET_MS
);
check(
  `anonymous budget is the long one (${POSTS_PREFETCH_BUDGET_ANON_MS}ms)`,
  postsPrefetchBudgetMs(false, EMPTY) === POSTS_PREFETCH_BUDGET_ANON_MS
);
check(
  'the two budgets are actually different (the split is not a no-op)',
  POSTS_PREFETCH_BUDGET_ANON_MS > POSTS_PREFETCH_BUDGET_MS
);
check(
  'the anonymous budget clears the measured cold tail (>= 2000ms)',
  POSTS_PREFETCH_BUDGET_ANON_MS >= 2000
);

// 2. A SIGNED-IN READER IS NEVER SLOWED, whatever the env says. The override is
//    scoped to the anonymous branch on purpose: their page is not shared-cached,
//    so there is nobody for them to wait on behalf of.
check(
  'the env override cannot reach the signed-in budget',
  postsPrefetchBudgetMs(true, { LUMEN_POSTS_BUDGET_ANON_MS: '9000' }) === POSTS_PREFETCH_BUDGET_MS
);

// 3. THE OVERRIDE WORKS (this is what makes an on/off measurement possible, and
//    what pulls the anonymous budget back to today's behaviour without a build).
check(
  'a valid override is honoured',
  postsPrefetchBudgetMs(false, { LUMEN_POSTS_BUDGET_ANON_MS: '1200' }) === 1200
);
check(
  'the override can restore the old 500ms behaviour (the off switch)',
  postsPrefetchBudgetMs(false, { LUMEN_POSTS_BUDGET_ANON_MS: '500' }) === 500
);

// 4. EVERY MALFORMED OVERRIDE FALLS BACK, never to NaN/0. `setTimeout(fn, NaN)`
//    fires immediately, which would make the render postless for everyone - a
//    typo in /opt/lumen/.env must degrade to the constant, never to worse than
//    the bug we are fixing.
for (const bad of ['', '   ', 'abc', 'NaN', '0', '-1', '1e', 'Infinity', '3500ms', 'null']) {
  const got = postsPrefetchBudgetMs(false, { LUMEN_POSTS_BUDGET_ANON_MS: bad });
  check(
    `malformed override ${JSON.stringify(bad)} falls back to ${POSTS_PREFETCH_BUDGET_ANON_MS} (got ${got})`,
    got === POSTS_PREFETCH_BUDGET_ANON_MS
  );
}
check(
  'an unset override falls back',
  postsPrefetchBudgetMs(false, { LUMEN_POSTS_BUDGET_ANON_MS: undefined }) === POSTS_PREFETCH_BUDGET_ANON_MS
);

// 5. THE RETURN IS ALWAYS A USABLE TIMEOUT: finite and > 0 for every input above.
const everyInput = [true, false].flatMap((signedIn) =>
  ['', 'abc', '0', '-5', '1200', undefined].map((v) =>
    postsPrefetchBudgetMs(signedIn, { LUMEN_POSTS_BUDGET_ANON_MS: v })
  )
);
check(
  'every result is a finite positive number of ms',
  everyInput.every((ms) => Number.isFinite(ms) && ms > 0)
);

// 6. NEGATIVE CONTROL: prove the malformed cases really would have been NaN/0
//    without the guard, so check 4 is not vacuously passing.
check(
  'negative control: a bare Number() of the malformed values IS unusable',
  ['', 'abc', '0', '-1'].every((bad) => {
    const naive = Number(bad);
    return !Number.isFinite(naive) || naive <= 0;
  })
);

if (failures === 0) {
  console.log('\nposts-prefetch-budget: ALL CHECKS PASSED');
  process.exit(0);
} else {
  console.error(`\nposts-prefetch-budget: ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
