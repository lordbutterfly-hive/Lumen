/**
 * Small standalone self-test for `source-scan-tokenizer.ts`'s `maskNonCode`
 * — the tokenizer shared by `server-cache-time-guard.test.ts` and
 * `withttlcache-name-guard.test.ts`. Each guard already exercises this
 * function against its own real-world shapes (cacheTime/gcTime lines,
 * withTtlCache( calls); this file checks the tokenizer in isolation so a
 * future edit to the shared module has one place proving the primitives
 * still hold, independent of either guard's higher-level logic.
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/__tests__/source-scan-tokenizer.test.ts
 */
import { maskNonCode } from './source-scan-tokenizer';

let failures = 0;
let checks = 0;
function check(label: string, cond: boolean): void {
  checks += 1;
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    failures += 1;
  }
}

check('a line comment is blanked', maskNonCode('// hello world').trim() === '');
check(
  'a block comment spanning lines is blanked, code after it survives',
  maskNonCode(['/** doc', ' * more', ' */', 'const x = 1;'].join('\n')).includes('const x = 1;')
);
check(
  "a single-quoted string body is blanked but doesn't leak past its close",
  maskNonCode("const s = 'contains /* not a comment */ text'; const real = 1;").includes('const real = 1;')
);
check('a double-quoted string body is blanked', !maskNonCode('const s = "cacheTime: 1";').includes('cacheTime'));
check('a template literal body is blanked', !maskNonCode('const s = `cacheTime: 1`;').includes('cacheTime'));
check(
  'an escaped quote inside a string does not end the string early',
  maskNonCode("const s = 'it\\'s not the end'; const real = 2;").includes('const real = 2;')
);

// --- regex-literal awareness -----------------------------------------------

check(
  'a simple regex literal is blanked out (its body does not survive masking)',
  !maskNonCode('const RE = /abc/;').includes('abc')
);
check(
  'a regex literal with an ODD number of double-quotes does not desync masking for the rest of the file ' +
    '(the exact feed-prefetch.ts BODY_IMAGE_PATTERNS shape)',
  (() => {
    const snippet = [
      'const PATTERNS = [',
      '  /<img\\s+[^>]*src="[^"]+"[^>]*>/i',
      '];',
      'const cacheTime = 60000;'
    ].join('\n');
    const masked = maskNonCode(snippet);
    return masked.includes('const cacheTime = 60000;');
  })()
);
check(
  'a character class inside a regex can contain an unescaped `/` without ending the regex early',
  (() => {
    const snippet = 'const RE = /[a\\/b]/;\nconst real = 1;';
    return maskNonCode(snippet).includes('const real = 1;');
  })()
);
check(
  'division (an actual `/`, not a regex) after a value is left as code, not treated as a regex start',
  maskNonCode('const half = total / 2;').includes('total / 2')
);
check(
  'a regex immediately after `(`, `[`, `,` or `=` (none of which end a value) is recognised as a regex',
  (() => {
    const snippet = 'const arr = [/x"y/, 1];\nconst cacheTime = 5;';
    return maskNonCode(snippet).includes('const cacheTime = 5;') && !maskNonCode(snippet).includes('x"y');
  })()
);
check(
  'regex flag letters after the closing slash are consumed as part of the same blanked token',
  !maskNonCode("const RE = /it's/gi;\nconst real = 1;").includes("it's")
);

if (failures === 0) {
  console.log(`\nsource-scan-tokenizer: ALL CHECKS PASSED (${checks} checks)`);
  process.exit(0);
} else {
  console.error(`\nsource-scan-tokenizer: ${failures} of ${checks} CHECK(S) FAILED`);
  process.exit(1);
}
