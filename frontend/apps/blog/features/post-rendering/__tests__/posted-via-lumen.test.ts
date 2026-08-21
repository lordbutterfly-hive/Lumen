/**
 * THE "posted via lumen" GATE.
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node -T -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     features/post-rendering/__tests__/posted-via-lumen.test.ts
 *
 * ★★★ WHY THIS EXISTS AS A TEST AND NOT AS A BROWSER CHECK. The attribution
 * line renders only for entries Lumen published, and this instance is a local
 * dev database with NO Lumen-authored posts in the feed — so a browser probe can
 * only ever observe the line being ABSENT. Absence proves nothing on its own: a
 * component that renders `null` unconditionally would pass that check forever.
 * The gate is a pure function, so it can be tested directly, and that is the
 * half that actually matters.
 *
 * ★★ THE RISK IS A FALSE POSITIVE, NOT A FALSE NEGATIVE. These posts sit on
 * Hive and are read by peakd, ecency and hive.blog. A missing line costs us a
 * little promotion. A line printed under somebody else's writing claims their
 * words were written here — so the cases that matter most below are the ones
 * that must NOT match.
 */
import { isLumenProxiedEntry } from '../../../lib/lite/render/lite-post-id';

let failures = 0;
function check(label: string, actual: boolean, expected: boolean) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label} — got ${actual}, expected ${expected}`);
}

const entry = (over: Record<string, unknown>) =>
  ({ author: 'someone', permlink: 'a-post', json_metadata: '{}', ...over }) as never;

console.log('posted via lumen — the gate');

// ── SHOULD render ───────────────────────────────────────────────────────────
/* ★ REAL ULID SHAPES, 26 CROCKFORD-BASE32 CHARS. My first version of this test
   used `lumen-01hxyz` and failed — the permlink patterns are
   `^lumen-([0-9abcdefghjkmnpqrstvwxyz]{26})$` and the `lite-` equivalent, so a
   short stub does not match. The test was wrong, not the code; recording it
   because a future reader writing a fixture will reach for the short form too. */
const ULID = '01hxyzabcdefghjkmnpqrstvwx';
check('a Lumen published permlink', isLumenProxiedEntry(entry({ permlink: `lumen-${ULID}` })), true);
check('a Lumen unpublished permlink', isLumenProxiedEntry(entry({ permlink: `lite-${ULID}` })), true);
check(
  'a permlink that merely STARTS with lumen- but is not a ULID',
  isLumenProxiedEntry(entry({ permlink: 'lumen-my-holiday-photos' })),
  false
);
check(
  'metadata stamped app: lumen/1.0',
  isLumenProxiedEntry(entry({ json_metadata: '{"app":"lumen/1.0","tags":["hive"]}' })),
  true
);
check(
  'metadata carrying a lumen_post_id',
  isLumenProxiedEntry(entry({ json_metadata: '{"lumen_post_id":"01hxyz"}' })),
  true
);
check(
  'metadata as a parsed OBJECT, not a string',
  isLumenProxiedEntry(entry({ json_metadata: { app: 'lumen/1.0' } as never })),
  true
);

// ── MUST NOT render — the expensive direction ───────────────────────────────
check('an ordinary Hive post', isLumenProxiedEntry(entry({})), false);
check(
  'a post from another front end',
  isLumenProxiedEntry(entry({ json_metadata: '{"app":"peakd/2024.1"}' })),
  false
);
check(
  'a post that merely MENTIONS lumen in its tags',
  isLumenProxiedEntry(entry({ json_metadata: '{"app":"ecency/3.0","tags":["lumen","hive"]}' })),
  false
);
check('an entry with no metadata at all', isLumenProxiedEntry(entry({ json_metadata: '' })), false);
check('undefined', isLumenProxiedEntry(undefined), false);
check('null', isLumenProxiedEntry(null), false);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
