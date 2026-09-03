/**
 * `selectWarmTopics` invariants - plain assertions, no test runner (this repo
 * has none; same style as lib/__tests__/server-ttl-cache.test.ts).
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/feed/__tests__/topic-warm-select.test.ts
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 *
 * WHY THIS EXISTS: the warmer once warmed "the top `max` of everything". Because
 * community ids sit near the top of the trending stream, they filled the cap and
 * SILENTLY evicted lower-ranked browsable tags (photography at rank ~68) - those
 * tag pages stopped server-rendering with no error at all. A test is the only
 * thing that catches the next person who grows the warm set past the cap.
 */
import {
  selectWarmTopics,
  isBrowsableTag,
  COMMUNITY_WARM_MAX,
  COMMUNITY_ID
} from '../topic-warm-select';

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    failures += 1;
  }
}

const MAX = 60;

// A realistic-shaped list: communities dominate the head (as in real trending),
// with browsable tags scattered THROUGHOUT, including one well past `max`.
const communities = Array.from({ length: 70 }, (_, i) => `hive-${1000 + i}`);
const browsableTags = ['photography', 'life', 'art', 'travel', 'food', 'gaming'];
const tribes = ['pob', 'hive', 'ecency', 'blog'];
const junk = ['', 'nsfw', 'test', 'Has Space', 'WAY-too-'.repeat(20)];
// Interleave so a browsable tag ('photography') lands at rank ~70 (past MAX=60).
const names = [
  ...communities.slice(0, 65),
  'photography', // rank ~65, would be evicted by a naive top-MAX
  ...tribes,
  ...junk,
  ...browsableTags.filter((t) => t !== 'photography'),
  ...communities.slice(65)
];

const out = selectWarmTopics(names, MAX);
const outSet = new Set(out);

// 1. THE REGRESSION GUARD: every browsable tag in the input is in the output,
//    even the one ranked past MAX.
// Valid-format browsable tags only: isBrowsableTag does not check the route's
// [a-z0-9-] shape, and a malformed tag can never be read back, so selectWarmTopics
// correctly drops it - it is not a browsable tag that "should" warm.
const inputBrowsable = names.filter(
  (n) => /^[a-z0-9-]{1,64}$/.test(n.toLowerCase()) && isBrowsableTag(n)
);
check(
  'every browsable input tag is warmed (none capped away)',
  inputBrowsable.every((t) => outSet.has(t))
);
check('the past-MAX browsable tag (photography) is warmed', outSet.has('photography'));

// 2. Total never exceeds MAX.
check(`total warmed (${out.length}) <= max (${MAX})`, out.length <= MAX);

// 3. Communities ARE warmed now (the whole point), but bounded.
const warmedCommunities = out.filter((t) => COMMUNITY_ID.test(t));
check('communities are warmed', warmedCommunities.length > 0);
check(
  `communities are bounded to COMMUNITY_WARM_MAX (${COMMUNITY_WARM_MAX}); got ${warmedCommunities.length}`,
  warmedCommunities.length <= COMMUNITY_WARM_MAX
);

// 4. Tribe tags, reserved tags and malformed tags are never warmed.
check('reward-tribe tags dropped', !tribes.some((t) => outSet.has(t)));
check('reserved/malformed tags dropped', !junk.some((t) => outSet.has(t)));

// 5. Load bound: with ~6 browsable + capped communities, the cycle is far under
//    the old 60-read balloon.
check(`read count is bounded (${out.length} <= ${inputBrowsable.length + COMMUNITY_WARM_MAX})`,
  out.length <= inputBrowsable.length + COMMUNITY_WARM_MAX);

// 6. NEGATIVE CONTROL: a naive "top MAX of everything (minus tribes)" WOULD drop
//    photography here - prove our input actually triggers that, so test 1 is not
//    vacuously passing on an input where nothing was ever at risk.
const naiveTopMax = names
  .map((n) => n.toLowerCase())
  .filter((n) => /^[a-z0-9-]{1,64}$/.test(n) && n !== '' && n !== 'nsfw' && n !== 'test')
  .filter((n) => !['pob', 'hive', 'ecency', 'blog'].includes(n))
  .slice(0, MAX);
check(
  'negative control: the naive top-MAX WOULD have dropped photography (input is a real regression case)',
  !naiveTopMax.includes('photography')
);

if (failures === 0) {
  console.log('\nselect-warm-topics: ALL CHECKS PASSED');
  process.exit(0);
} else {
  console.error(`\nselect-warm-topics: ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
