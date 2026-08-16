/**
 * Reserved-name rules — plain assertions, no test runner (this repo has none;
 * same shape as features/post-editor/__tests__/preview-gate.test.ts).
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/lite/names/__tests__/reserved-names.test.ts
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 *
 * WHY THIS FILE EXISTS (2026-08-16, QA report H6). The rule used to be two rules
 * wearing one name: `lumen`/`admin`/`moderator`/`official` matched as SUBSTRINGS
 * while `hive`/`support`/`root` matched EXACTLY, so `myadmin` was refused and
 * `xhivex` was not, and no user could predict either. Unifying them is a
 * product-visible change, so the resulting table is pinned here rather than left
 * to be rediscovered by probing the endpoint.
 *
 * Two defects found by running the table BEFORE trusting the code, both fixed:
 *   - `mood` was REFUSED. The doubled-letter collapse folds it to `mod`, which is
 *     a 3-letter entry on the list. Nobody typed an evasion; they typed a word.
 *   - `adm1n` was FREE. The leetspeak map sent `1` to `l` only, giving `admln`,
 *     which matches nothing, while the code's own comment claimed that case was
 *     defended. `1` is now folded BOTH ways.
 */
import { vetNameFormat } from '../vetting';

type Case = { name: string; reserved: boolean; why: string };

const CASES: Case[] = [
  // The brand: the one deliberate substring rule.
  { name: 'lumen', reserved: true, why: 'the brand itself' },
  { name: 'mylumen', reserved: true, why: 'contains the brand' },
  { name: 'zzz-lumen-zzz', reserved: true, why: 'contains the brand, separators stripped' },
  { name: 'lum3n', reserved: true, why: 'leetspeak evasion of the brand' },
  { name: 'lu-men', reserved: true, why: 'separator evasion of the brand' },
  { name: 'luumen', reserved: true, why: 'doubled-letter evasion of the brand' },
  { name: 'deluminate', reserved: false, why: 'contains "lumin", not "lumen"' },

  // Generic reserved words: EXACT only. These four changed behaviour in H6.
  { name: 'admin', reserved: true, why: 'exact match' },
  { name: 'myadmin', reserved: false, why: 'H6: substring no longer reserved' },
  { name: 'moderator', reserved: true, why: 'exact match' },
  { name: 'moderator-x', reserved: false, why: 'H6: substring no longer reserved' },
  { name: 'unofficial', reserved: false, why: 'H6: substring no longer reserved' },
  { name: 'hive', reserved: true, why: 'exact match, unchanged by H6' },
  { name: 'xhivex', reserved: false, why: 'was already free, unchanged by H6' },
  { name: 'support', reserved: true, why: 'exact match, unchanged by H6' },
  { name: 'xsupportx', reserved: false, why: 'was already free, unchanged by H6' },

  // Evasions of the exact rule that normalisation must still catch.
  { name: 'adm1n', reserved: true, why: 'REGRESSION GUARD: 1 folds to i as well as l' },
  { name: 'mod3rator', reserved: true, why: 'leetspeak, and starts with a letter so it reaches the rule' },
  { name: 'supp0rt', reserved: true, why: 'zero for o' },
  { name: 'm0der4tor', reserved: true, why: 'two substitutions at once' },

  // Ordinary words the collapse must NOT swallow.
  { name: 'mood', reserved: false, why: 'REGRESSION GUARD: collapses to "mod", must stay free' },
  { name: 'model', reserved: false, why: 'ordinary word near a short entry' },
  { name: 'modern', reserved: false, why: 'ordinary word near a short entry' },
  { name: 'mod', reserved: true, why: 'the short entry itself is still reserved' }
];

let failures = 0;
for (const c of CASES) {
  const vet = vetNameFormat(c.name);
  // `ok:false` can also mean a FORMAT refusal; this suite only asserts the
  // reserved-name verdict, so a format error would be a bad test case, not a
  // reserved hit. Guard against that rather than silently counting it as a pass.
  const isReserved = !vet.ok && typeof (vet as { code?: string }).code === 'string';
  const formatRefusal = !vet.ok && !(vet as { code?: string }).code;
  if (formatRefusal) {
    console.error(`BAD CASE  ${c.name}: refused on FORMAT, not reserved rules (${(vet as { error: string }).error})`);
    failures += 1;
    continue;
  }
  if (isReserved !== c.reserved) {
    console.error(`FAIL  ${c.name}: expected ${c.reserved ? 'RESERVED' : 'free'}, got ${isReserved ? 'RESERVED' : 'free'} (${c.why})`);
    failures += 1;
  }
}

// A suite that asserted nothing would "pass". Refuse that.
if (CASES.length < 20) {
  console.error(`FAIL  the table shrank to ${CASES.length} cases; it is meant to pin the whole rule`);
  failures += 1;
}

console.log(`${CASES.length - failures} PASS, ${failures} FAIL (${CASES.length} cases)`);
process.exit(failures ? 1 : 0);
