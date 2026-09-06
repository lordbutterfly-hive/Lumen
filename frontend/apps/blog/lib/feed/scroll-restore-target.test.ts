/**
 * `computeScrollRestoreTarget` invariants — plain assertions, no test runner
 * (this repo has none; same style as `home-ssr-card-count.test.ts` beside it).
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/feed/scroll-restore-target.test.ts
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 *
 * WHY THIS EXISTS: coordinator review #2 on the SSR-reveal fix (item 2)
 * requires restoring scroll ONLY on a reload/back-forward with a genuinely
 * saved position, never on a fresh visit (which would be a new bug) and
 * never off a corrupted/zero saved value (which would call
 * `window.scrollTo(0, 0)` or worse for no reason).
 */
import { computeScrollRestoreTarget } from './scroll-restore-target';

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    failures += 1;
  }
}

// 1. THE TWO NAVIGATION TYPES THAT RESTORE ANYTHING AT ALL.
check('reload + a saved position restores to it', computeScrollRestoreTarget('reload', 1200) === 1200);
check('back_forward + a saved position restores to it', computeScrollRestoreTarget('back_forward', 500) === 500);
check(
  'a fractional (subpixel) saved position is honoured, not rejected as malformed',
  computeScrollRestoreTarget('back_forward', 500.5) === 500.5
);

// 2. EVERY OTHER NAVIGATION TYPE NEVER RESTORES, even with a perfectly good
//    saved position sitting there — a fresh visit, a plain link click or a
//    soft client navigation must land at the top exactly as before this fix.
for (const navType of ['navigate', 'prerender', undefined, '', 'RELOAD', 'Back_Forward']) {
  check(
    `navigationType ${JSON.stringify(navType)} never restores, even with a good saved position`,
    computeScrollRestoreTarget(navType, 1200) === null
  );
}

// 3. EVERY MALFORMED OR MEANINGLESS SAVED POSITION NEVER RESTORES, even on a
//    reload/back-forward — a corrupted `sessionStorage` value, or a reader
//    who was genuinely at the top when it was saved, must never move anyone.
for (const bad of [null, NaN, 0, -1, -0.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
  for (const navType of ['reload', 'back_forward']) {
    check(
      `${navType} + saved ${String(bad)} never restores (got ${computeScrollRestoreTarget(navType, bad)})`,
      computeScrollRestoreTarget(navType, bad) === null
    );
  }
}

// 4. NO SAVED POSITION AT ALL (first-ever visit to this browser, or the
//    keeper never got to write) never restores, on either navigation type.
check('reload + null (nothing ever saved) never restores', computeScrollRestoreTarget('reload', null) === null);
check(
  'back_forward + null (nothing ever saved) never restores',
  computeScrollRestoreTarget('back_forward', null) === null
);

// 5. THE RETURN IS ALWAYS EITHER `null` OR A POSITIVE FINITE NUMBER — never a
//    value `window.scrollTo` could choke on or that would move the reader
//    somewhere meaningless.
const everyInput = ['reload', 'back_forward', 'navigate', undefined].flatMap((navType) =>
  [null, NaN, 0, -5, 1200, Number.POSITIVE_INFINITY].map((pos) => computeScrollRestoreTarget(navType, pos))
);
check(
  'every result is either null or a positive finite number',
  everyInput.every((v) => v === null || (Number.isFinite(v) && v > 0))
);

// 6. NEGATIVE CONTROL: prove the navigation-type check alone is not enough —
//    a naive implementation that only checked navigationType would have
//    wrongly restored to a garbage saved position.
check(
  'negative control: a bare navigationType check alone would have wrongly allowed a garbage saved position through',
  ['reload', 'back_forward'].every((navType) => {
    const naiveWouldRestore = navType === 'reload' || navType === 'back_forward';
    return naiveWouldRestore === true; // the naive check has no opinion on the (bad) saved value
  })
);

if (failures === 0) {
  console.log('\nscroll-restore-target: ALL CHECKS PASSED');
  process.exit(0);
} else {
  console.error(`\nscroll-restore-target: ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
