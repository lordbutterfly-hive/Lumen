/**
 * `resolveRecsysTimeoutMs` invariants - plain assertions, no test runner (this
 * repo has none; same style as lib/feed/posts-prefetch-budget.test.ts).
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/recsys/feed-timeout.test.ts
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 *
 * WHY THIS EXISTS: `RECSYS_FEED_TIMEOUT_MS=4000` in /opt/lumen/.env switched
 * personalised ranking off for every signed-in reader for two days, with no
 * error anywhere - every response still looked like an ordinary trending
 * fallback. The floor is the guard, and the two ways it can silently die are
 * (a) somebody "simplifies" it back to `Number(raw) || default`, restoring the
 * exact production failure, and (b) a malformed value parsing to NaN, which
 * `setTimeout` treats as 0 and which would abort every recsys call instantly.
 */
import {
  resolveRecsysTimeoutMs,
  RECSYS_FEED_TIMEOUT_DEFAULT_MS,
  RECSYS_FEED_TIMEOUT_FLOOR_MS
} from './feed-timeout';

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

// 1. THE DEFAULT. Unset means the measured cold-build budget, not zero and not
//    the 4000ms that broke production.
check(
  `unset falls back to the default (${RECSYS_FEED_TIMEOUT_DEFAULT_MS}ms)`,
  resolveRecsysTimeoutMs(EMPTY).timeoutMs === RECSYS_FEED_TIMEOUT_DEFAULT_MS
);
check(
  'the default is not clamped (nothing to report when nothing was overridden)',
  resolveRecsysTimeoutMs(EMPTY).clampedFrom === undefined
);
check(
  'the default clears the measured cold /feed floor (>= 11600ms, hbd-temp)',
  RECSYS_FEED_TIMEOUT_DEFAULT_MS >= 11_600
);

// 2. THE PRODUCTION FAILURE ITSELF. This is the exact value that sat in
//    /opt/lumen/.env and stored zero feeds in two days. It must not survive.
check(
  'the production 4000ms is refused',
  resolveRecsysTimeoutMs({ RECSYS_FEED_TIMEOUT_MS: '4000' }).timeoutMs ===
    RECSYS_FEED_TIMEOUT_FLOOR_MS
);
check(
  'the refused value is reported back, so the clamp can be logged',
  resolveRecsysTimeoutMs({ RECSYS_FEED_TIMEOUT_MS: '4000' }).clampedFrom === 4000
);
check(
  'the floor is above the measured 4.2s abort that produced no build',
  RECSYS_FEED_TIMEOUT_FLOOR_MS > 4_200
);

// 3. RAISING IS STILL THE OPERATOR'S CALL. The clamp is one-directional on
//    purpose: a slower recsys is a real reason to wait longer, and only
//    LOWERING past the cost of the work is the misconfiguration.
check(
  'a value above the floor is honoured exactly',
  resolveRecsysTimeoutMs({ RECSYS_FEED_TIMEOUT_MS: '30000' }).timeoutMs === 30_000
);
check(
  'a raised value is not reported as clamped',
  resolveRecsysTimeoutMs({ RECSYS_FEED_TIMEOUT_MS: '30000' }).clampedFrom === undefined
);
check(
  'the floor itself is honoured and not reported as clamped',
  resolveRecsysTimeoutMs({ RECSYS_FEED_TIMEOUT_MS: String(RECSYS_FEED_TIMEOUT_FLOOR_MS) })
    .clampedFrom === undefined
);

// 3b. THE BOUNDARY ITSELF, ONE MILLISECOND EITHER SIDE. `raw < FLOOR` is the
//     whole clamp, and every check above holds just as well if that `<` is
//     rewritten as `<=` (or as `raw !== FLOOR`, or flipped): 4000 still clamps
//     and 30000 still does not. These three values are the only ones that tell
//     those apart — FLOOR-1 must be raised AND reported, FLOOR and FLOOR+1 must
//     be honoured untouched. Written as ONE resolve per value so a failure names
//     which side of the boundary moved.
const belowFloor = resolveRecsysTimeoutMs({
  RECSYS_FEED_TIMEOUT_MS: String(RECSYS_FEED_TIMEOUT_FLOOR_MS - 1)
});
check(
  'one millisecond below the floor is raised to the floor',
  belowFloor.timeoutMs === RECSYS_FEED_TIMEOUT_FLOOR_MS
);
check(
  'one millisecond below the floor reports the exact value it was raised from',
  belowFloor.clampedFrom === RECSYS_FEED_TIMEOUT_FLOOR_MS - 1
);

const atFloor = resolveRecsysTimeoutMs({
  RECSYS_FEED_TIMEOUT_MS: String(RECSYS_FEED_TIMEOUT_FLOOR_MS)
});
check(
  'the floor itself resolves to exactly itself',
  atFloor.timeoutMs === RECSYS_FEED_TIMEOUT_FLOOR_MS
);
check('the floor itself carries no clamp report', atFloor.clampedFrom === undefined);

const aboveFloor = resolveRecsysTimeoutMs({
  RECSYS_FEED_TIMEOUT_MS: String(RECSYS_FEED_TIMEOUT_FLOOR_MS + 1)
});
check(
  'one millisecond above the floor is honoured exactly',
  aboveFloor.timeoutMs === RECSYS_FEED_TIMEOUT_FLOOR_MS + 1
);
check('one millisecond above the floor is not reported as clamped', aboveFloor.clampedFrom === undefined);

// 4. NO VALUE CAN EVER PRODUCE A ZERO OR NaN TIMEOUT. `setTimeout(NaN)` fires
//    immediately, which would abort every recsys call before it left the box -
//    strictly worse than having no override at all.
for (const bad of ['', ' ', 'abc', '0', '-1', '-9999', 'NaN', 'Infinity', undefined]) {
  const resolved = resolveRecsysTimeoutMs({ RECSYS_FEED_TIMEOUT_MS: bad });
  check(
    `a malformed value (${JSON.stringify(bad)}) never yields a non-positive or NaN timeout`,
    Number.isFinite(resolved.timeoutMs) && resolved.timeoutMs >= RECSYS_FEED_TIMEOUT_FLOOR_MS
  );
}

// 5. THE FLOOR IS NOT A NO-OP. If somebody lowers the floor below the default
//    these tests still pass individually while the guard stops guarding, so the
//    relationship itself is asserted.
check(
  'the floor is at least the default (a lower floor would re-open the failure)',
  RECSYS_FEED_TIMEOUT_FLOOR_MS >= RECSYS_FEED_TIMEOUT_DEFAULT_MS
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
