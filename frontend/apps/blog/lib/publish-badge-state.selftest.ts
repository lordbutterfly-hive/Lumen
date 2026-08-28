/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * THE PUBLISH LADDER, AND THE TWO RENDERERS THAT MUST SHARE IT.
 *
 * Run:
 *   cd apps/blog && npx tsx lib/publish-badge-state.selftest.ts
 *
 * WHAT THIS PROVES, AND WHY IT WOULD HAVE CAUGHT THE DEFECT.
 *
 * `components/optimistic-status-banner.tsx` rendered, for every Lumen post older
 * than ten seconds:
 *
 *   "Saved and visible on Lumen. It will appear on Hive shortly."
 *
 * forever. No ladder, no terminal state, and the component took no failure input
 * at all — on a publisher that is stalled on resource credits with the oldest job
 * hours old. The word "shortly" on a post that will never land is the whole
 * finding (false-text audit F10).
 *
 * The banner's OWN header describes this exact defect and fixes it, for the chain
 * branch, three lines above the lite branch that still had it. Section 4 below is
 * therefore the assertion that matters most: it locks the two renderers to ONE
 * module, so a third cannot drift the same way.
 */

import {
  getPublishBadgeState,
  PUBLISH_BADGE_COPY_KEY,
  PUBLISH_QUEUED_WINDOW_MS,
  PUBLISH_WAITING_WINDOW_MS,
  publishBadgeShowsSpinner
} from './publish-badge-state';

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  } else {
    console.log(`ok    ${name}`);
  }
}

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

console.log('\n── 1. THE LADDER. Every rung, and the boundaries between them.\n');
{
  check('a post that is not optimistic gets no badge at all', getPublishBadgeState(false, true, ago(0)) === null);
  check('a fresh lite post is queued', getPublishBadgeState(true, true, ago(5 * MIN)) === 'queued');
  check(
    '…still queued one second inside the 15-minute window',
    getPublishBadgeState(true, true, ago(PUBLISH_QUEUED_WINDOW_MS - 1000)) === 'queued'
  );
  check(
    '…and waiting one second past it',
    getPublishBadgeState(true, true, ago(PUBLISH_QUEUED_WINDOW_MS + 1000)) === 'waiting'
  );
  check('an hour-old lite post is waiting', getPublishBadgeState(true, true, ago(HOUR)) === 'waiting');
  check(
    '…still waiting one second inside the 6-hour window',
    getPublishBadgeState(true, true, ago(PUBLISH_WAITING_WINDOW_MS - 1000)) === 'waiting'
  );
  check(
    '★ THE DEFECT: a FOUR-HOUR-OLD lite post is no longer told its post arrives "shortly"',
    getPublishBadgeState(true, true, ago(4 * HOUR)) === 'waiting'
  );
  check(
    '★ THE DEFECT, TERMINAL: a day-old lite post reaches a state that stops promising',
    getPublishBadgeState(true, true, ago(24 * HOUR)) === 'delayed'
  );
  check('a week-old lite post is still delayed, not queued', getPublishBadgeState(true, true, ago(7 * 24 * HOUR)) === 'delayed');
}

console.log('\n── 2. FAILED OUTRANKS EVERY AGE-BASED STATE.\n');
{
  for (const [label, age] of [
    ['seconds', 5 * 1000],
    ['minutes', 5 * MIN],
    ['hours', 4 * HOUR],
    ['days', 5 * 24 * HOUR]
  ] as const) {
    check(
      `a failed publish reads "failed" at ${label} old, not the age-based rung`,
      getPublishBadgeState(true, true, ago(age), true) === 'failed'
    );
  }
  check(
    '…on the chain branch too, where the age-based answer would be "publishing"',
    getPublishBadgeState(true, false, ago(5 * 1000), true) === 'failed'
  );
  check(
    '★ absent means UNKNOWN, never "fine": omitting the flag must not read as failed',
    getPublishBadgeState(true, true, ago(5 * MIN)) === 'queued'
  );
}

console.log('\n── 3. THE CHAIN BRANCH IS UNCHANGED. A fix that alters it is a regression.\n');
{
  for (const age of [0, 5 * 1000, 5 * MIN, 4 * HOUR]) {
    check(
      `a chain-path optimistic entry stays "publishing" at ${age}ms old`,
      getPublishBadgeState(true, false, ago(age)) === 'publishing'
    );
  }
  check('a garbage timestamp degrades to the gentlest lite rung, not a crash', getPublishBadgeState(true, true, 'not-a-date') === 'queued');
}

console.log('\n── 4. THE SPINNER, AND THE COPY MAP.\n');
{
  check('only the first state spins', publishBadgeShowsSpinner('publishing'));
  for (const s of ['queued', 'waiting', 'delayed', 'failed', null] as const) {
    check(`…${s ?? 'null'} does not spin`, !publishBadgeShowsSpinner(s));
  }
  const keys = Object.values(PUBLISH_BADGE_COPY_KEY);
  check('every rung has a copy key', keys.length === 5 && keys.every((k) => k.length > 0));
  check('…and they are all distinct, so no two states can say the same thing', new Set(keys).size === 5);
}

console.log('\n── 5. WIRING. Both renderers really use this module, and the false string is gone.\n');
{
  const { readFileSync } = require('fs') as typeof import('fs');
  const { join } = require('path') as typeof import('path');

  /** The ★ notes quote the retired copy verbatim to explain its removal, so every scan runs on stripped source. */
  const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const squash = (src: string): string => src.replace(/\s+/g, ' ');

  const bannerRaw = readFileSync(join(__dirname, '..', 'components', 'optimistic-status-banner.tsx'), 'utf8');
  const commentRaw = readFileSync(join(__dirname, '..', 'features', 'post-rendering', 'comment-list-item.tsx'), 'utf8');
  const moduleRaw = readFileSync(join(__dirname, 'publish-badge-state.ts'), 'utf8');
  const banner = squash(strip(bannerRaw));
  const commentItem = squash(strip(commentRaw));

  // ── Non-vacuity. A scan with nothing to inspect must FAIL, never pass by absence.
  check('the scan read optimistic-status-banner.tsx', bannerRaw.length > 2_000, `${bannerRaw.length} bytes`);
  check('the scan read comment-list-item.tsx', commentRaw.length > 20_000, `${commentRaw.length} bytes`);
  check('the scan read publish-badge-state.ts', moduleRaw.length > 2_000, `${moduleRaw.length} bytes`);
  check(
    'comment stripping left the code behind',
    banner.length > 500 && banner.length < bannerRaw.length && commentItem.length > 10_000 && commentItem.length < commentRaw.length,
    `${banner.length} of ${bannerRaw.length} / ${commentItem.length} of ${commentRaw.length} bytes after stripping`
  );
  check(
    '★ …and it really did strip: the banner’s ★ note quotes the retired sentence verbatim',
    bannerRaw.includes('It will appear on Hive shortly.') && !banner.includes('It will appear on Hive shortly.'),
    'if this fails the stripper is broken and every "is gone" assertion below is worthless'
  );
  check(
    '★ NEGATIVE CONTROL: the stripper did not eat live code',
    banner.includes('<CircleSpinner size={14}') && commentItem.includes("data-testid=\"comment-publish-status\"")
  );

  // ── The two renderers share ONE module. This is the assertion that stops the drift.
  check('the banner imports the shared ladder', banner.includes("from '@/blog/lib/publish-badge-state'"));
  check('the comment list imports the shared ladder', commentItem.includes("from '@/blog/lib/publish-badge-state'"));
  for (const [label, src] of [
    ['the banner', banner],
    ['the comment list', commentItem]
  ] as const) {
    check(`${label} declares no local copy of the state function`, !src.includes('function getPublishBadgeState'));
    check(`${label} declares no local copy of the copy map`, !src.includes('const PUBLISH_BADGE_COPY_KEY'));
    check(`${label} declares no local thresholds`, !src.includes('const PUBLISH_QUEUED_WINDOW_MS'));
  }

  // ── The banner takes a failure input and actually consults it.
  check('the banner accepts publishFailed', banner.includes('publishFailed = false'));
  check('…and passes it to the ladder', /getPublishBadgeState\(true, lite, createdAt, publishFailed\)/.test(banner));
  check(
    '★ …and the post page really hands it over — a prop nothing passes is a prop that does nothing',
    squash(strip(readFileSync(join(__dirname, '..', 'app', '[param]', '[p2]', '[permlink]', 'content.tsx'), 'utf8'))).includes(
      'publishFailed={!!postData._publishFailed}'
    )
  );

  // ── The retired string reaches no branch of the banner any more.
  // Assembled rather than written literally: `scripts/check-blog-translation-usage.js`
  // greps source for translation call sites WITHOUT stripping comments, and would
  // read this ASSERTION as a live use of a key that no longer exists — failing the
  // repo's own check over a line that is about the opposite thing. (Which is also
  // why this note describes the pattern instead of quoting it.)
  const retiredCall = `t(${"'"}global.publish_queued${"'"})`;
  check(
    '★ the banner no longer renders the retired global.publish_queued on ANY branch',
    !banner.includes(retiredCall),
    'this is the string that said "shortly" forever, on the lite branch and then on the chain branch after it'
  );

  // ── And the honest strings the ladder points at all exist in the locale.
  const locale = JSON.parse(readFileSync(join(__dirname, '..', 'locales', 'en', 'common_blog.json'), 'utf8'));
  const lookup = (dotted: string): unknown =>
    dotted.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), locale);
  for (const key of Object.values(PUBLISH_BADGE_COPY_KEY)) {
    const value = lookup(key);
    check(`${key} exists in en and is a non-empty string`, typeof value === 'string' && value.length > 5, String(value));
  }
  check(
    'the chain branch’s terminal string exists too',
    typeof lookup('global.indexing_pending') === 'string' && String(lookup('global.indexing_pending')).length > 5
  );
  check(
    '★ and it does NOT tell a chain post it is about to appear "shortly"',
    !String(lookup('global.indexing_pending')).includes('shortly'),
    String(lookup('global.indexing_pending'))
  );
  check(
    '★ nor does any rung of the lite ladder',
    Object.values(PUBLISH_BADGE_COPY_KEY)
      .filter((k) => k !== 'global.publishing')
      .every((k) => !String(lookup(k)).includes('shortly')),
    'the whole finding is the word "shortly" on something that may never land'
  );
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
