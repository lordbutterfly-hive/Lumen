/**
 * parse-account-list.ts — plain assertions, no test runner (same convention as
 * features/retention/lib/__tests__/ladder.test.ts: this repo has none, and
 * adding one is out of scope for this job).
 *
 * RUN IT (from apps/blog):
 *   pnpm exec ts-node \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     features/account-lists/lib/__tests__/parse-account-list.test.ts
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 *
 * This is the input table G2 was asked to report: comma-separated, leading
 * '@', duplicates (within input and against the existing list), empties,
 * mixed whitespace/commas, and the exact string from the bug report.
 */

import { joinAccountNames, normalizeAccountName, parseAccountListInput, splitAccountNamesRaw } from '../parse-account-list';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, evidence?: string) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}${evidence ? `  — ${evidence}` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${evidence ? `  — ${evidence}` : ''}`);
  }
}

console.log('1. splitAccountNamesRaw — the B1 bug: comma-separated must actually split');
check(
  'the exact bug-report string, comma+space',
  JSON.stringify(splitAccountNamesRaw('null, steemit, ned')) === JSON.stringify(['null', 'steemit', 'ned']),
  JSON.stringify(splitAccountNamesRaw('null, steemit, ned'))
);
check(
  'the observed post-trim string with NO spaces (what the old controlled input actually produced)',
  JSON.stringify(splitAccountNamesRaw('null,steemit,ned')) === JSON.stringify(['null', 'steemit', 'ned']),
  JSON.stringify(splitAccountNamesRaw('null,steemit,ned'))
);
check(
  'whitespace-only separated (no commas at all)',
  JSON.stringify(splitAccountNamesRaw('null steemit ned')) === JSON.stringify(['null', 'steemit', 'ned']),
  JSON.stringify(splitAccountNamesRaw('null steemit ned'))
);
check(
  'mixed commas + runs of whitespace + doubled commas',
  JSON.stringify(splitAccountNamesRaw('null,,  steemit   ,ned')) === JSON.stringify(['null', 'steemit', 'ned']),
  JSON.stringify(splitAccountNamesRaw('null,,  steemit   ,ned'))
);
check('empty string yields no tokens', splitAccountNamesRaw('').length === 0, JSON.stringify(splitAccountNamesRaw('')));
check(
  'commas/whitespace only yields no tokens',
  splitAccountNamesRaw(' , , ,  ').length === 0,
  JSON.stringify(splitAccountNamesRaw(' , , ,  '))
);
check('single account, no delimiter', JSON.stringify(splitAccountNamesRaw('steemit')) === JSON.stringify(['steemit']));

console.log('\n2. normalizeAccountName — lowercase, strip leading @');
check('lowercases', normalizeAccountName('STEEMIT') === 'steemit', normalizeAccountName('STEEMIT'));
check('strips one leading @', normalizeAccountName('@steemit') === 'steemit', normalizeAccountName('@steemit'));
check('strips multiple leading @', normalizeAccountName('@@steemit') === 'steemit', normalizeAccountName('@@steemit'));
check('trims surrounding whitespace', normalizeAccountName('  steemit  ') === 'steemit', JSON.stringify(normalizeAccountName('  steemit  ')));
check(
  'mixed case + leading @ together',
  normalizeAccountName('@NeD') === 'ned',
  normalizeAccountName('@NeD')
);

console.log('\n3. parseAccountListInput — full pipeline incl. dedupe + existing-list rejection (B3)');
{
  const r = parseAccountListInput('null, steemit, ned', ['bpcvoter2', 'daylaykay']);
  check(
    'the bug-report input against the REAL current on-chain list produces 3 clean candidates',
    JSON.stringify(r.candidates) === JSON.stringify(['null', 'steemit', 'ned']) && r.alreadyOnList.length === 0,
    JSON.stringify(r)
  );
}
{
  const r = parseAccountListInput('@Steemit, steemit, STEEMIT', []);
  check(
    'case+@ variants of the SAME name collapse to one candidate (within-input dedupe)',
    JSON.stringify(r.candidates) === JSON.stringify(['steemit']),
    JSON.stringify(r)
  );
}
{
  const r = parseAccountListInput('bpcvoter2, steemit', ['bpcvoter2', 'daylaykay']);
  check(
    'a name already on the list is reported separately, NOT silently added or silently dropped',
    JSON.stringify(r.candidates) === JSON.stringify(['steemit']) && JSON.stringify(r.alreadyOnList) === JSON.stringify(['bpcvoter2']),
    JSON.stringify(r)
  );
}
{
  const r = parseAccountListInput('BPCvoter2, DAYLAYKAY', ['bpcvoter2', 'daylaykay']);
  check(
    'existing-list match is case-insensitive',
    r.candidates.length === 0 && JSON.stringify(r.alreadyOnList.sort()) === JSON.stringify(['bpcvoter2', 'daylaykay']),
    JSON.stringify(r)
  );
}
{
  const r = parseAccountListInput('   ', ['bpcvoter2', 'daylaykay']);
  check('whitespace-only input produces zero candidates and zero already-on-list entries (the empty case)', r.candidates.length === 0 && r.alreadyOnList.length === 0, JSON.stringify(r));
}
{
  const r = parseAccountListInput(',,,', []);
  check('commas-only input produces zero candidates', r.candidates.length === 0, JSON.stringify(r));
}
{
  // Invalid-looking names (format is NOT this module's job — see use-add-to-list-form.ts,
  // which runs isValidAccountNameFormat/checkAccountExists on each candidate this
  // function returns) — but the parser itself must not choke on or silently eat them.
  const r = parseAccountListInput('null, a, this-name-is-way-too-long-for-hive-1234567890', []);
  check(
    'obviously-invalid-format tokens still come through as candidates (format validation is a separate, later step)',
    JSON.stringify(r.candidates) === JSON.stringify(['null', 'a', 'this-name-is-way-too-long-for-hive-1234567890']),
    JSON.stringify(r)
  );
}

console.log('\n4. joinAccountNames — what actually gets submitted (ONE custom_json, per the fix spec)');
check(
  'joins with ", " — the exact delimiter transactionService.*Blog(...).split(\', \') expects',
  joinAccountNames(['null', 'steemit', 'ned']) === 'null, steemit, ned'
);
check('single name has no trailing delimiter', joinAccountNames(['steemit']) === 'steemit');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
