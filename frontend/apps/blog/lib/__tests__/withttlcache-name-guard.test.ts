/**
 * SOURCE-SCANNING GUARD: every `withTtlCache(...)` call in `apps/blog` must
 * pass a `name` (2026-09-06, review fix on the module-copies build map).
 * Same style and philosophy as `server-cache-time-guard.test.ts` — a
 * hand-rolled tokenizer, not a real TS parser, run under `test:unit`.
 *
 * WHY THIS EXISTS: an unnamed `withTtlCache` keeps its own module-local
 * `fresh`/`inFlight`/`counters`, so it silently gets ONE copy per webpack
 * layer that imports it, invisible in `/api/debug/mem` and immune to the boot
 * warm — exactly the bug this build's R1 fixed for the eight caches in
 * `cached-api.ts`, and that a review pass then found FOUR more of
 * (`block-filter.ts`, `search/suggest.ts`, `search/people.ts` x2), all
 * unnamed. This test makes the NEXT unnamed `withTtlCache` a red `test:unit`
 * run instead of a silent duplicate.
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/__tests__/withttlcache-name-guard.test.ts
 *
 * WHAT IS SCANNED: every `.ts`/`.tsx` file under `apps/blog`, EXCLUDING
 * `*.test.ts(x)` files. Unlike `server-cache-time-guard.test.ts` (which has
 * no legitimate reason for a test fixture to use the banned shape), this
 * repo's own `lib/__tests__/server-ttl-cache.test.ts` and
 * `lib/__tests__/module-copies-shared-slots.test.ts` construct UNNAMED
 * `withTtlCache(...)` instances ON PURPOSE, to test the unnamed (per-copy,
 * not shared) path itself — a real, permanent feature of the module, not an
 * oversight. Flagging those would either break a legitimate negative-control
 * test or force it to lie about what it is testing, so test files are exempt
 * from this specific guard; production code is not.
 *
 * KNOWN LIMITATIONS (accepted, same posture as the cacheTime guard):
 *   - Comments and string/template literals are masked out first, so a
 *     `withTtlCache(` mention in a doc comment (this file's own header, for
 *     instance) is correctly ignored.
 *   - `withTtlCache(...)`'s call is split into TOP-LEVEL (depth-0 relative to
 *     the call's own parens) comma-separated arguments; the LAST one is
 *     assumed to be the options object (every real call site today passes
 *     exactly `(loader, keyOf, options)`), and is checked for a `name\s*:`
 *     occurring anywhere within just that isolated argument. A call that
 *     restructures its arguments away from that 3-argument shape, or wraps
 *     the options object in a spread/variable instead of a literal, would not
 *     be understood by this scanner and reported as a violation — conservative
 *     (fails loud), not a silent pass.
 *   - REGEX LITERALS containing a quote character are handled — see
 *     `./source-scan-tokenizer.ts`'s own doc comment for the real bug this
 *     caught (`feed-prefetch.ts`'s `BODY_IMAGE_PATTERNS`) — via a
 *     regex-vs-divide heuristic that is conservative in the OTHER direction
 *     for one shape: `return /foo/`-style regexes (immediately preceded by
 *     an identifier ending in a letter/digit, e.g. a keyword) are misread as
 *     division and NOT masked as a regex. None of that shape exist in the
 *     files this guard scans today (the real-scan baseline in section B
 *     would not vacuously pass if the masker were broken outright — proven
 *     live by the bug this fix caught). ★ 2026-09-06 UPDATE: the masker was
 *     extracted into the shared `./source-scan-tokenizer.ts` and
 *     `server-cache-time-guard.test.ts` (whose OWN masker was the starting
 *     point for this one, and carried the IDENTICAL gap — no regex-literal
 *     awareness at all) now imports that same tokenizer too, so both guards
 *     get this fix from one shared source instead of one carrying a gap the
 *     other already closed.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
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

// ---------------------------------------------------------------------------
// 1. THE MASKER. Extracted 2026-09-06 into `./source-scan-tokenizer.ts` and
//    shared byte-for-byte with `server-cache-time-guard.test.ts` (which used
//    to carry its own, older copy of this function with no regex-literal
//    handling at all -- see that file's header note, now updated, on the
//    fix this guard found and that guard has since received). See
//    `source-scan-tokenizer.ts`'s own doc comment for the regex-vs-divide
//    heuristic and the exact `feed-prefetch.ts` bug this masker's
//    regex-literal awareness exists to prevent.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 2. FIND EACH withTtlCache(...) CALL AND SPLIT ITS TOP-LEVEL ARGUMENTS
// ---------------------------------------------------------------------------

const CALL_RE = /\bwithTtlCache\s*\(/g;

/** From `openParenIndex` (index of the `(` itself), find the matching `)`. */
function findMatchingParen(text: string, openParenIndex: number): number {
  let depth = 0;
  for (let i = openParenIndex; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1; // unterminated — treated as a violation by the caller
}

/** Split the text strictly BETWEEN the call's outer parens on depth-0 commas. */
function splitTopLevelArgs(inner: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      args.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  args.push(inner.slice(start));
  return args.map((a) => a.trim()).filter((a) => a.length > 0);
}

const NAME_KEY_RE = /\bname\s*:/;

interface CallCheck {
  named: boolean;
  reason: string;
}

/** Runs the whole pipeline (mask -> find calls -> split args -> check last arg) on one masked file's text. */
function checkCalls(masked: string): CallCheck[] {
  const results: CallCheck[] = [];
  CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL_RE.exec(masked)) !== null) {
    const openParen = m.index + m[0].length - 1;
    const closeParen = findMatchingParen(masked, openParen);
    if (closeParen === -1) {
      results.push({ named: false, reason: 'unterminated call (unbalanced parens)' });
      continue;
    }
    const inner = masked.slice(openParen + 1, closeParen);
    const args = splitTopLevelArgs(inner);
    const last = args[args.length - 1];
    if (!last || !last.startsWith('{')) {
      results.push({ named: false, reason: `expected a trailing options object literal, got: ${JSON.stringify(last)}` });
      continue;
    }
    results.push({ named: NAME_KEY_RE.test(last), reason: NAME_KEY_RE.test(last) ? 'has name:' : 'no name: in options object' });
  }
  return results;
}

// ---------------------------------------------------------------------------
// A. SYNTHETIC SELF-TEST (negative control for section B).
// ---------------------------------------------------------------------------

function callsIn(snippet: string): CallCheck[] {
  return checkCalls(maskNonCode(snippet));
}

check(
  'a single-line named call is recognised',
  callsIn("const x = withTtlCache(load, keyOf, { name: 'x', ttlMs: 1000 });")[0]?.named === true
);
check(
  'a multi-line named call (the real shape in cached-api.ts) is recognised',
  callsIn(
    [
      'const x = withTtlCache(',
      '  load,',
      '  (a: string, b: string) => `${a}|${b}`,',
      '  { name: "x", ttlMs: 1000, max: 100 }',
      ');'
    ].join('\n')
  )[0]?.named === true
);
check(
  'VIOLATION: a call with no name: in its options object is rejected',
  callsIn("const x = withTtlCache(load, keyOf, { ttlMs: 1000 });")[0]?.named === false
);
check(
  'VIOLATION: a call whose last argument is not an object literal at all is rejected',
  callsIn('const x = withTtlCache(load, keyOf, options);')[0]?.named === false
);
check(
  'a keyOf arrow function whose PARAMETER is literally called `name` does not fool the ' +
    'scanner into thinking the OPTIONS object (a separate, later argument) has a real name: ' +
    '(getCommunityCached\'s actual shape) — this must still require the real name: in the options object',
  callsIn(
    [
      'const x = withTtlCache(',
      '  getCommunity,',
      '  (name: string, observer?: string) => `${name}|${observer ?? ""}`,',
      '  { name: "community", ttlMs: 30000, max: 100 }',
      ');'
    ].join('\n')
  )[0]?.named === true
);
check(
  'and WITHOUT the real name: option, that same keyOf-parameter-called-name shape is still a violation',
  callsIn(
    [
      'const x = withTtlCache(',
      '  getCommunity,',
      '  (name: string, observer?: string) => `${name}|${observer ?? ""}`,',
      '  { ttlMs: 30000, max: 100 }',
      ');'
    ].join('\n')
  )[0]?.named === false
);
check(
  'a withTtlCache( mention inside a comment produces zero calls',
  callsIn('// see withTtlCache(load, keyOf, {}) for the pattern').length === 0
);
check(
  'a withTtlCache( mention inside a string literal produces zero calls',
  callsIn("const s = 'call withTtlCache(load, keyOf, {})';").length === 0
);
check('multiple calls in one file are each checked independently', (() => {
  const results = callsIn(
    [
      "const a = withTtlCache(la, ka, { name: 'a', ttlMs: 1 });",
      "const b = withTtlCache(lb, kb, { ttlMs: 1 });"
    ].join('\n')
  );
  return results.length === 2 && results[0].named === true && results[1].named === false;
})());

// ★★★ REGRESSION SUITE for the regex-literal masking bug this file's own
// maskNonCode doc comment describes — found live in feed-prefetch.ts's
// BODY_IMAGE_PATTERNS array (a regex with an odd count of `"` desynced the
// masker for the rest of the file). Each check below reproduces the shape
// that broke, isolated, so a future edit to the masker cannot reintroduce it
// silently.
check(
  'a regex literal with an ODD number of double-quotes does not desync masking for the rest of the file ' +
    '(the exact feed-prefetch.ts shape)',
  (() => {
    const snippet = [
      'const PATTERNS = [',
      '  /<img\\s+[^>]*src="[^"]+"[^>]*>/i',
      '];',
      "const x = withTtlCache(load, keyOf, { name: 'x', ttlMs: 1 });"
    ].join('\n');
    const results = callsIn(snippet);
    return results.length === 1 && results[0].named === true;
  })()
);
check(
  'a regex literal containing parens/brackets does not corrupt paren-depth tracking of a LATER call',
  (() => {
    const snippet = [
      "const RE = /\\(not real code\\)\\[also not\\]/;",
      "const x = withTtlCache(load, keyOf, { name: 'x', ttlMs: 1 });"
    ].join('\n');
    const results = callsIn(snippet);
    return results.length === 1 && results[0].named === true;
  })()
);
check(
  'division (an actual `/`, not a regex) after a value is still masked correctly — the regex-vs-divide ' +
    'heuristic does not misfire on ordinary arithmetic and swallow a real call',
  (() => {
    const snippet = ['const half = total / 2;', "const x = withTtlCache(load, keyOf, { name: 'x', ttlMs: 1 });"].join('\n');
    const results = callsIn(snippet);
    return results.length === 1 && results[0].named === true;
  })()
);
check(
  'a single-quote regex flag combination (case-insensitive global) still resolves correctly',
  (() => {
    const snippet = ["const RE = /it's/gi;", "const x = withTtlCache(load, keyOf, { name: 'x', ttlMs: 1 });"].join('\n');
    const results = callsIn(snippet);
    return results.length === 1 && results[0].named === true;
  })()
);

// ---------------------------------------------------------------------------
// B. THE REAL SCAN — every .ts/.tsx file under apps/blog, excluding this
//    directory's own test files (which legitimately mention withTtlCache(
//    in prose/comments/synthetic strings, already proven masked above) and
//    node_modules/.next*.
// ---------------------------------------------------------------------------

const EXCLUDED_DIR_NAMES = new Set(['node_modules']);
function isExcludedDir(name: string): boolean {
  return EXCLUDED_DIR_NAMES.has(name) || name === '.next' || name.startsWith('.next');
}

/** `*.test.ts` / `*.test.tsx` — see this file's header on why these are exempt. */
function isTestFile(name: string): boolean {
  return name.endsWith('.test.ts') || name.endsWith('.test.tsx');
}

function walk(dirAbs: string, dirDisplay: string): string[] {
  let entries: import('fs').Dirent[];
  try {
    entries = readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (isExcludedDir(entry.name)) continue;
      files.push(...walk(join(dirAbs, entry.name), join(dirDisplay, entry.name)));
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) && !isTestFile(entry.name)) {
      files.push(join(dirDisplay, entry.name));
    }
  }
  return files;
}

// __dirname is apps/blog/lib/__tests__ regardless of process.cwd().
const blogRoot = resolve(__dirname, '..', '..');

// `.test.ts` files (this scanner's own file included) are already excluded by
// `walk`'s own filter above — no separate self-exclusion needed here anymore.
const files = walk(blogRoot, '.');
check(`scanned at least one file (${files.length} files under apps/blog)`, files.length > 0);

interface Violation {
  file: string;
  reason: string;
}

let realCallCount = 0;
const violations: Violation[] = [];
for (const displayPath of files) {
  const absPath = join(blogRoot, displayPath);
  const content = readFileSync(absPath, 'utf8');
  const masked = maskNonCode(content);
  const results = checkCalls(masked);
  realCallCount += results.length;
  for (const r of results) {
    if (!r.named) violations.push({ file: displayPath, reason: r.reason });
  }
}

// Baseline: 12 withTtlCache( call sites named as of this fix (the original 8
// in cached-api.ts, trending-tags.ts's and feed-prefetch.ts's, plus the 4 the
// review added: block-filter.ts, search/suggest.ts, search/people.ts x2). A
// LOWER bound, not exact — proves the walker actually found real calls rather
// than vacuously scanning nothing.
check(
  `found at least 12 withTtlCache( calls in the real tree (found ${realCallCount}) — proves the walker is reading files`,
  realCallCount >= 12
);

if (violations.length > 0) {
  console.error(`\n${violations.length} VIOLATION(S) — a withTtlCache( call has no name::\n`);
  for (const v of violations) {
    console.error(`  ${v.file}: ${v.reason}`);
  }
  console.error('\nFIX: add `name: \'somethingUnique\'` to the options object — see server-ttl-cache.ts\'s header note.');
}
check(`zero violations across ${realCallCount} call(s)`, violations.length === 0);

if (failures === 0) {
  console.log(`\nwithttlcache-name-guard: ALL CHECKS PASSED (${checks} checks, ${files.length} files scanned)`);
  process.exit(0);
} else {
  console.error(`\nwithttlcache-name-guard: ${failures} of ${checks} CHECK(S) FAILED`);
  process.exit(1);
}
