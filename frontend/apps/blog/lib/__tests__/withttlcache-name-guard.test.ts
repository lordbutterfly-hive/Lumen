/**
 * SOURCE-SCANNING GUARD: every `withTtlCache(...)` call in `apps/blog` must
 * pass a `name` (2026-09-06, review fix on the module-copies build map), AND
 * no two call sites anywhere in the tree may pass the SAME `name` (section C,
 * added the same day — see its own header for why `server-ttl-cache.ts`'s own
 * runtime guards cannot catch this specific case). Same style and philosophy
 * as `server-cache-time-guard.test.ts` — a hand-rolled tokenizer, not a real
 * TS parser, run under `test:unit`.
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
 *   - Section C's name-uniqueness check only sees a `name:` whose value is a
 *     plain single/double-quoted string literal (`NAME_VALUE_RE`). A call
 *     that still passes the mandatory `name:` key but as a template literal
 *     or a variable is still caught as NAMED by section B (nothing here lets
 *     that requirement lapse), just not entered into the uniqueness check,
 *     since a static scan cannot know its runtime value. No real call site
 *     does this today.
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

/**
 * Split the text strictly BETWEEN the call's outer parens on depth-0 commas.
 * Returns each argument's TRIMMED text plus its `[start, end)` offsets INTO
 * `inner` — offsets, not just text, because section C below needs to go back
 * to the UNMASKED source at the same positions to read a `name:` value's
 * actual characters (`maskNonCode` blanks string CONTENTS, so the masked text
 * alone can prove a call is named but not what it is named — see that
 * function's own doc comment).
 */
interface ArgSpan {
  text: string;
  start: number;
  end: number;
}

function splitTopLevelArgs(inner: string): ArgSpan[] {
  const raw: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      raw.push({ start, end: i });
      start = i + 1;
    }
  }
  raw.push({ start, end: inner.length });
  return raw
    .map(({ start, end }) => {
      const untrimmed = inner.slice(start, end);
      const text = untrimmed.trim();
      const leading = untrimmed.length - untrimmed.trimStart().length;
      const trailing = untrimmed.length - untrimmed.trimEnd().length;
      return { text, start: start + leading, end: end - trailing };
    })
    .filter((a) => a.text.length > 0);
}

const NAME_KEY_RE = /\bname\s*:/;

/** A `name:` value that is a plain quoted string literal — every real call site today. */
const NAME_VALUE_RE = /\bname\s*:\s*(['"])((?:\\.|(?!\1).)*)\1/;

interface CallCheck {
  named: boolean;
  reason: string;
  /**
   * The literal `name:` VALUE, when it could be read — only ever set when
   * `named` is true AND the value is a plain single/double-quoted string with
   * no more than backslash escapes (`NAME_VALUE_RE` above). `undefined` for
   * an unnamed call OR a named call whose value is not a simple literal (a
   * template literal or an identifier) — see this file's own "KNOWN
   * LIMITATIONS" note on why section C (name uniqueness) cannot check what it
   * cannot read.
   */
  name?: string;
}

/**
 * Runs the whole pipeline (mask -> find calls -> split args -> check last
 * arg) on one file's text. `masked` drives call/arg-boundary detection
 * (safe to split on, since a comma or brace INSIDE a string is blanked to a
 * space rather than left as real punctuation); `original` is the SAME file's
 * unmasked text, same length, same positions — used only to recover the
 * actual characters of a `name:` string literal, which `masked` has already
 * blanked out by design.
 */
function checkCalls(masked: string, original: string): CallCheck[] {
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
    if (!last || !last.text.startsWith('{')) {
      results.push({ named: false, reason: `expected a trailing options object literal, got: ${JSON.stringify(last?.text)}` });
      continue;
    }
    const named = NAME_KEY_RE.test(last.text);
    let name: string | undefined;
    if (named) {
      // Same `[openParen+1, closeParen)` window, but read from `original` —
      // see this function's own doc comment on why the two texts diverge
      // exactly where a `name:` VALUE lives.
      const rawInner = original.slice(openParen + 1, closeParen);
      const rawLast = rawInner.slice(last.start, last.end);
      name = rawLast.match(NAME_VALUE_RE)?.[2];
    }
    results.push({ named, reason: named ? 'has name:' : 'no name: in options object', name });
  }
  return results;
}

/**
 * Given every named call site found, group by `name:` and return only the
 * names used more than once — the exact failure mode this section exists to
 * catch (see section C's own header). A pure function so section A can drive
 * it with synthetic data without re-running the real file scan.
 */
function findDuplicateNames(entries: Array<{ name: string; file: string }>): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  for (const { name, file } of entries) {
    const files = byName.get(name);
    if (files) files.push(file);
    else byName.set(name, [file]);
  }
  const duplicates = new Map<string, string[]>();
  for (const [name, files] of byName) {
    if (files.length > 1) duplicates.set(name, files);
  }
  return duplicates;
}

// ---------------------------------------------------------------------------
// A. SYNTHETIC SELF-TEST (negative control for section B).
// ---------------------------------------------------------------------------

function callsIn(snippet: string): CallCheck[] {
  return checkCalls(maskNonCode(snippet), snippet);
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

// ---------------------------------------------------------------------------
// A2. NAME EXTRACTION + UNIQUENESS (section C's own machinery), self-tested
// before section C runs it over the real tree.
// ---------------------------------------------------------------------------
check(
  "a single-quoted name: value is read from the RAW source, not the masked one " +
    "(masking blanks a string's CONTENTS, so this proves the offset math into `original` is right)",
  callsIn("const x = withTtlCache(load, keyOf, { name: 'accountFull', ttlMs: 1000 });")[0]?.name === 'accountFull'
);
check(
  'a double-quoted name: value is read the same way',
  callsIn('const x = withTtlCache(load, keyOf, { name: "accountFull", ttlMs: 1000 });')[0]?.name === 'accountFull'
);
check(
  'a multi-line call (the real cached-api.ts shape) still reads the right name: value',
  callsIn(
    [
      'const x = withTtlCache(',
      '  load,',
      '  (a: string, b: string) => `${a}|${b}`,',
      '  { name: "followList", ttlMs: 30000, max: 100 }',
      ');'
    ].join('\n')
  )[0]?.name === 'followList'
);
check(
  'an unnamed call has no name: value to read',
  callsIn('const x = withTtlCache(load, keyOf, { ttlMs: 1000 });')[0]?.name === undefined
);
check(
  'findDuplicateNames flags a name used by two different files',
  (() => {
    const dupes = findDuplicateNames([
      { name: 'foo', file: 'a.ts' },
      { name: 'foo', file: 'b.ts' }
    ]);
    return dupes.size === 1 && dupes.get('foo')?.join(',') === 'a.ts,b.ts';
  })()
);
check(
  'findDuplicateNames does not flag two distinct names',
  findDuplicateNames([
    { name: 'foo', file: 'a.ts' },
    { name: 'bar', file: 'b.ts' }
  ]).size === 0
);
check(
  'findDuplicateNames does not flag a name that appears exactly once',
  findDuplicateNames([{ name: 'foo', file: 'a.ts' }]).size === 0
);
check(
  'findDuplicateNames also flags the SAME file using one name twice (a copy-paste within one module)',
  findDuplicateNames([
    { name: 'foo', file: 'a.ts' },
    { name: 'foo', file: 'a.ts' }
  ]).size === 1
);

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
const namedEntries: Array<{ name: string; file: string }> = [];
for (const displayPath of files) {
  const absPath = join(blogRoot, displayPath);
  const content = readFileSync(absPath, 'utf8');
  const masked = maskNonCode(content);
  const results = checkCalls(masked, content);
  realCallCount += results.length;
  for (const r of results) {
    if (!r.named) {
      violations.push({ file: displayPath, reason: r.reason });
    } else if (r.name) {
      namedEntries.push({ name: r.name, file: displayPath });
    }
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

// ---------------------------------------------------------------------------
// C. NAME UNIQUENESS. Every call above was checked for HAVING a name:; this
//    section checks the actual VALUES are unique across the whole scanned
//    tree — the gap this guard did not close until now.
//
//    ★ WHY THIS IS A REAL GAP AND NOT ALREADY CAUGHT AT RUNTIME.
//    `server-ttl-cache.ts`'s shared slot throws at module load when two call
//    sites share a `name:` with DIFFERENT `ttlMs`/`max` (a real, load-bearing
//    guard — see its own header note), and a SEPARATE same-copy check catches
//    two calls in the identical module instantiation reusing a name for a
//    different loader/keyOf pair. Neither one catches two DIFFERENT modules
//    that happen to pick the same name AND agree on `ttlMs`/`max`: if they
//    never end up sharing one instantiation of `server-ttl-cache.ts` (plainly
//    possible — Next compiles it once per webpack LAYER, and the same-copy
//    check is a plain module-local `Map`, not `globalThis`-shared), the
//    cross-copy check sees matching options and ADOPTS silently instead of
//    throwing — two semantically unrelated caches sharing one store, with no
//    error anywhere. Two single-layer modules with the same name and the
//    common `{ttlMs: 30_000, max: 100}` shape (six of today's real caches use
//    exactly that pair) would hit precisely this. A static, whole-tree name
//    check makes the failure mode impossible regardless of how webpack
//    happens to chunk anything, which is the one thing runtime code cannot
//    promise about itself.
// ---------------------------------------------------------------------------
const duplicateNames = findDuplicateNames(namedEntries);
if (duplicateNames.size > 0) {
  console.error(`\n${duplicateNames.size} DUPLICATE NAME(S) — the same name: used by more than one call site:\n`);
  for (const [name, fs] of duplicateNames) {
    console.error(`  "${name}": ${fs.join(', ')}`);
  }
  console.error(
    '\nFIX: give one of them a different name — see server-ttl-cache.ts\'s header note on why two call sites ' +
      'that agree on ttlMs/max as well as name would otherwise silently share one store.'
  );
}
const distinctNameCount = new Set(namedEntries.map((e) => e.name)).size;
check(
  `every named cache's name: is unique (checked ${namedEntries.length} named call site(s), ` +
    `${distinctNameCount} distinct name(s))`,
  duplicateNames.size === 0
);

if (failures === 0) {
  console.log(`\nwithttlcache-name-guard: ALL CHECKS PASSED (${checks} checks, ${files.length} files scanned)`);
  process.exit(0);
} else {
  console.error(`\nwithttlcache-name-guard: ${failures} of ${checks} CHECK(S) FAILED`);
  process.exit(1);
}
