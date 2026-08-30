/**
 * Proves the H13 fix WITHOUT broadcasting. See the module's own header for why that
 * matters: the only end-to-end proof of the original defect is to destroy a real
 * account's metadata, and nobody should buy a test result at that price.
 *
 * ★ THE NEGATIVE CONTROL IS THE POINT. `destructiveOldBehaviour` below reproduces
 * exactly what the code did before the fix. Every preservation assertion is paired
 * with a check that the OLD function loses the same key, so the suite cannot pass
 * vacuously against an input that was never at risk.
 */
import { mergePostingJsonMetadata } from './merge-posting-json-metadata';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `  <- ${detail}`}`);
  if (!ok) failed++;
};

/** What updateProfile did before 2026-08-30: build fresh, replace everything. */
const destructiveOldBehaviour = (_existing: string | undefined, fields: Record<string, unknown>) =>
  JSON.stringify({ profile: { ...fields } });

const FIELDS = { name: 'Alice', website: 'https://alice.dev', version: 2 };

// A real-shaped document: the keys below are the ones actually measured on live
// accounts, not invented ones.
const EXISTING = JSON.stringify({
  profile: {
    name: 'Alice',
    about: 'writes things',
    website: 'https://old.example',
    pinned: 'my-best-post',
    tokens: { LEO: 12 },
    badges: ['a', 'b'],
    twitter: 'alice'
  },
  otherAppState: { theme: 'dark' }
});

const merged = JSON.parse(mergePostingJsonMetadata(EXISTING, FIELDS));
const old = JSON.parse(destructiveOldBehaviour(EXISTING, FIELDS));

console.log('\n-- keys the enumerated set does not know about, INSIDE profile --');
for (const k of ['pinned', 'tokens', 'badges', 'twitter', 'about']) {
  check(`preserves profile.${k}`, merged.profile[k] !== undefined, JSON.stringify(merged.profile[k]));
  check(`  NEGATIVE CONTROL: the old code lost profile.${k}`, old.profile[k] === undefined);
}

console.log('\n-- top-level keys besides `profile` --');
check('preserves a sibling of `profile`', merged.otherAppState?.theme === 'dark');
check('  NEGATIVE CONTROL: the old code lost it', old.otherAppState === undefined);

console.log('\n-- the fields being written still win --');
check('website is overwritten by the new value', merged.profile.website === 'https://alice.dev');
check('name is written', merged.profile.name === 'Alice');
check('version is written', merged.profile.version === 2);

console.log('\n-- defensive parsing: none of these may throw, all fall back to old behaviour --');
for (const [label, input] of [
  ['undefined', undefined],
  ['empty string', ''],
  ['malformed json', '{not json'],
  ['a bare string', '"hello"'],
  ['an array', '[1,2,3]'],
  ['null', 'null'],
  ['profile is an array', '{"profile":[1,2]}'],
  ['profile is a string', '{"profile":"nope"}']
] as [string, string | undefined][]) {
  let out = '';
  let threw = false;
  try {
    out = mergePostingJsonMetadata(input, FIELDS);
  } catch {
    threw = true;
  }
  check(`${label}: does not throw`, !threw);
  check(`${label}: still writes the fields`, !threw && JSON.parse(out).profile?.name === 'Alice');
}

console.log('\n-- the shape a fresh account has --');
const fresh = JSON.parse(mergePostingJsonMetadata(undefined, FIELDS));
check('a brand-new profile is just the fields', JSON.stringify(fresh) === JSON.stringify({ profile: FIELDS }));


console.log('\n-- ★ undefined means KEEP, empty string means CLEAR (the 2026-08-31 residual) --');
{
  // A website-only save: every other field is undefined because the caller is not
  // editing them. This is the exact shape that erased real accounts' fields.
  const websiteOnly = JSON.parse(
    mergePostingJsonMetadata(EXISTING, { website: 'https://new.example', version: 2 })
  );
  check('undefined field KEEPS the preserved value (about)', websiteOnly.profile.about === 'writes things');
  check('undefined field KEEPS the preserved value (pinned)', websiteOnly.profile.pinned === 'my-best-post');
  check('the edited field is written', websiteOnly.profile.website === 'https://new.example');

  // Explicitly passing undefined must behave the same as omitting it.
  const explicitUndefined = JSON.parse(
    mergePostingJsonMetadata(EXISTING, { website: 'https://new.example', about: undefined, version: 2 })
  );
  check('an EXPLICIT undefined also keeps it', explicitUndefined.profile.about === 'writes things');

  // Empty string is a real instruction: the user cleared the box.
  const cleared = JSON.parse(mergePostingJsonMetadata(EXISTING, { about: '', version: 2 }));
  check("'' CLEARS the field (not the same as undefined)", cleared.profile.about === '');
  check('  ...and does not disturb its neighbours', cleared.profile.pinned === 'my-best-post');
}
console.log(failed === 0 ? '\nALL PASSED (incl. the residual)' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
