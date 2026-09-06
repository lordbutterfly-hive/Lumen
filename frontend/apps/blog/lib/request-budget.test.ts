/**
 * `classify()` invariants - plain assertions, no test runner (this repo has
 * none; same style as lib/feed/posts-prefetch-budget.test.ts).
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/request-budget.test.ts
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 *
 * WHY THIS EXISTS (2026-09-06, signed-in home build map item 1): `classify()`
 * decided the single biggest contention lever the analysis session found --
 * meta-webindexer was 76% of the origin's page renders, let through at the
 * CLIENT class's 90/min ceiling because its Chrome-shaped UA prefix outranked
 * the generic crawler fallback. This file pins the fix (its own crawler
 * vendor bucket) and the two ways it could silently regress: (a) someone
 * "simplifies" the alternation and drops the token, putting the crawler back
 * in the client bucket with no error anywhere, or (b) the fix is too broad
 * and starts reclassifying a REAL Chrome browser as a crawler.
 *
 * ★ THE THREE UA STRINGS BELOW ARE RECONSTRUCTED, NOT COPIED FROM THE LIVE
 * LOG. The build map (section 3.5) describes the shape ("meta-webindexer/1.1
 * behind a Chrome/145 Windows or Mac UA") but does not quote the exact
 * strings, and this session has no access to the Caddy access log to pull
 * them verbatim. The three below match that documented shape (a real
 * Chrome/145 signature on Windows, Mac and X11/Linux, with the vendor token
 * trailing) closely enough to prove the regex change; they are a stand-in for
 * the real log lines, not a claim of having reproduced them byte-for-byte.
 */
import { classify } from './request-budget';

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    failures += 1;
  }
}

const META_WEBINDEXER_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 meta-webindexer/1.1';
const META_WEBINDEXER_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 meta-webindexer/1.1';
const META_WEBINDEXER_X11 =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 meta-webindexer/1.1';

// 1. THE FIX ITSELF: all three variants land in the crawler class, keyed by
//    vendor (not by IP), regardless of the Chrome-shaped prefix.
for (const [label, ua] of [
  ['Windows', META_WEBINDEXER_WINDOWS],
  ['Mac', META_WEBINDEXER_MAC],
  ['X11/Linux', META_WEBINDEXER_X11]
] as const) {
  const result = classify(ua);
  check(`meta-webindexer (${label} UA) classifies as crawler`, result.klass === 'crawler');
  check(`meta-webindexer (${label} UA) buckets under its own vendor name`, result.vendor === 'meta-webindexer');
}

// 2. NEGATIVE CONTROL: a REAL Chrome browser, no vendor token anywhere, must
//    stay a client. If this fails, the regex is too broad and every ordinary
//    reader would fall into a 12/min crawler bucket -- the opposite bug.
const REAL_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
check('a real Chrome browser (no vendor token) stays a client', classify(REAL_CHROME).klass === 'client');

// 3. THE CUBOT CASE (already-guarded, must not regress): an Android phone
//    with upper-case BOT in its own device model name is a person, not a
//    crawler -- GENERIC_CRAWLER_UA's case-sensitivity is what protects this,
//    and it must keep working once meta-webindexer is added to a DIFFERENT
//    regex (VENDOR_UA, checked first).
const CUBOT_PHONE =
  'Mozilla/5.0 (Linux; Android 12; CUBOT MAX 3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.0.0 Mobile Safari/537.36';
check('a CUBOT phone (device name, not a bot) stays a client', classify(CUBOT_PHONE).klass === 'client');

// 4. THE UNFURLER CLASS IS UNTOUCHED. facebookexternalhit shares "meta" in
//    spirit with meta-webindexer but must stay in the unfurler bucket, per
//    this task's own scope: only meta-webindexer moves, nothing else does.
check(
  'facebookexternalhit stays an unfurler (unrelated to the meta-webindexer fix)',
  classify(
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'
  ).klass === 'unfurler'
);
// ★ ASSERT THE VENDOR NAME, NOT JUST THE CLASS (2026-09-06, review, caught
// before ship): this UA string contains the substring "crawler" in its own
// URL ("webmasters/crawler"), which GENERIC_CRAWLER_UA also matches -- so a
// check that only asserted `.klass === 'crawler'` would have kept passing
// even if `meta-externalagent` were accidentally deleted from VENDOR_UA; it
// would just silently reclassify under `vendor: 'generic'` instead of its
// own bucket. Asserting the vendor name is what actually catches that.
const metaExternalAgent = classify(
  'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)'
);
check('meta-externalagent (the existing crawler vendor) is unaffected by the addition', metaExternalAgent.klass === 'crawler');
check('meta-externalagent keeps its own vendor bucket (not swallowed by the generic fallback)', metaExternalAgent.vendor === 'meta-externalagent');

// 5. AN EXISTING NAMED VENDOR STILL WORKS (the alternation was extended, not
//    rewritten) -- a real regression here would mean the edit broke the list
//    itself, not just failed to add the new token.
check('claudebot is still a crawler after the edit', classify('ClaudeBot/1.0 (+https://claude.ai)').klass === 'crawler');
check(
  'claudebot still buckets under its own vendor name',
  classify('ClaudeBot/1.0 (+https://claude.ai)').vendor === 'claudebot'
);

if (failures === 0) {
  console.log('\nrequest-budget: ALL CHECKS PASSED');
  process.exit(0);
} else {
  console.error(`\nrequest-budget: ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
