/**
 * SOURCE-SCANNING GUARD: every `cacheTime:` / `gcTime:` in server-reachable
 * code must be `isServer`-aware (2026-09-06, worker-memory build map R1).
 *
 * WHY THIS EXISTS: a finite `cacheTime` arms query-core's GC `setTimeout` in
 * the `Query` constructor, and skips it only when the value is exactly
 * `Infinity`. Every SSR render gets its OWN `QueryClient`
 * (`lib/react-query.ts`'s `getQueryClient()` calls `new QueryClient()` per
 * render on the server), so a finite value there arms a real, ref'd timer
 * that keeps that whole render's `QueryClient` reachable — including every
 * `initialData` payload it was seeded with — for the timer's full duration.
 * Tonight's incident (`features/list-of-posts/hooks/use-reblogged-by-query.ts`
 * shipping a 1-hour-5-second `cacheTime` unconditionally) measured 1,652 live
 * `QueryClient`s on one worker at 54 minutes' uptime and ~1 GB of RSS from
 * this alone. The fix was two lines in one hook and one default in
 * `lib/react-query.ts` — this test exists so the NEXT `cacheTime:` or
 * `gcTime:` someone pastes into a query options object cannot reintroduce the
 * same class of leak without a red test:unit run.
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/__tests__/server-cache-time-guard.test.ts
 *
 * Exits 0 when every occurrence is allow-listed, 1 (printing each violation's
 * file:line and the fix pattern) otherwise. Runs under `pnpm --filter
 * @hive/blog test:unit`, which globs lib/**\/*.test.ts.
 *
 * WHAT IS SCANNED: every `.ts`/`.tsx` file under `app/`, `features/`,
 * `components/`, `lib/` (all inside `apps/blog`) and `packages/ui/`,
 * `packages/smart-signer/` (siblings of `apps/blog` under `frontend/`),
 * excluding any directory named `node_modules`, `.next` (or `.next*`), or
 * `tests`.
 *
 * THE ALLOW-LIST — a `cacheTime:`/`gcTime:` occurrence passes only if its
 * value, on the same source line, is one of:
 *   (a) a call to a helper whose name contains `CacheTimeMs` that is passed
 *       `isServer` as its argument — e.g. `cacheTime: rebloggedByCacheTimeMs(isServer)`,
 *       the pattern this fix introduced;
 *   (b) a ternary of the exact shape `isServer ? Infinity : ...`;
 *   (c) the bare literal `Infinity`.
 * Anything else — a plain number, a variable that isn't one of the above, a
 * helper call not fed `isServer`, a ternary that doesn't branch on
 * `isServer` — is a VIOLATION.
 *
 * ★ ON (d), 'use client' FILES: the obvious temptation is to exempt files
 * that open with `'use client'` on the theory that "client components don't
 * run on the server". THAT IS FALSE FOR THIS BUG. Next.js server-renders the
 * HTML for client components too (that's what makes SSR hydration work) —
 * `'use client'` only means the component ALSO hydrates and re-renders in the
 * browser, not that it skips SSR. `use-reblogged-by-query.ts`, the file that
 * caused tonight's incident, has no `'use client'` directive of its own but
 * is called from client components rendered inside every server-rendered
 * post card — proving by inspection which call sites are truly
 * server-reachable is exactly the whole-app data-flow analysis this
 * regex-based scanner cannot do. So: this scanner does NOT exempt `'use
 * client'` files. Every file in scope is treated as potentially
 * server-rendered, full stop.
 *
 * KNOWN LIMITATIONS (a hand-rolled tokenizer, not a real TS parser):
 *   - Comments (line and block) and single/double-quoted strings and
 *     template-literal bodies are masked out before matching, so a
 *     `cacheTime:`-shaped fragment sitting in a comment or a string (this
 *     file's own doc-comment above says `cacheTime:` in prose, for instance)
 *     is correctly ignored. This was proven the hard way: an earlier,
 *     line-by-line version of this masker used `.indexOf('/*')` — a STRING
 *     LITERAL containing the two characters `/` `*` — to detect comment
 *     starts, which made it misread its own source (that string literal)
 *     as an unterminated block comment and blank out ~120 unrelated lines.
 *     The masker below is character-by-character and quote-aware
 *     specifically so it cannot repeat that mistake against its own file,
 *     which the self-test in section A below checks for.
 *   - A `${...}` interpolation inside a template literal is NOT parsed back
 *     out to real code — the whole template, interpolations included, is
 *     masked as opaque string content. A real `cacheTime:`/`gcTime:` sitting
 *     inside a template-literal interpolation would therefore be MISSED
 *     (false negative), not falsely flagged. None exist in this codebase
 *     today (the real-scan baseline count below is the check for that).
 *   - Regex literals are not specially tokenized; a `cacheTime`/`gcTime`
 *     sequence inside one could in principle be matched. In practice this
 *     scanner's own allow-list regexes contain `cacheTime`/`gcTime` as
 *     alternation text followed by `\s*:` written in regex syntax (literal
 *     backslash-s-star), not actual whitespace, so `PROP_RE` does not match
 *     them — verified by this file scanning cleanly (see section B).
 *   - Classification looks only at the same source line as the key. A value
 *     that wraps onto a following line won't match any allow pattern and is
 *     reported as a violation — conservative (fails loud) rather than
 *     silently passing.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

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
// 1. THE MASKER + CLASSIFIER — pure, tested against synthetic snippets below
//    (section A) BEFORE either is ever pointed at real files, so a broken
//    masker or classifier cannot make the real-repo scan (section B)
//    vacuously pass.
// ---------------------------------------------------------------------------

type Verdict = 'helper' | 'ternary' | 'literal' | 'violation';

const PROP_RE = /\b(cacheTime|gcTime)\s*:/g;
const HELPER_ALLOW_RE = /\b(?:cacheTime|gcTime)\s*:\s*[A-Za-z0-9_$.]*CacheTimeMs[A-Za-z0-9_$]*\s*\(\s*isServer\b/;
const TERNARY_ALLOW_RE = /\b(?:cacheTime|gcTime)\s*:\s*isServer\s*\?\s*Infinity\b/;
const LITERAL_ALLOW_RE = /\b(?:cacheTime|gcTime)\s*:\s*Infinity\b/;

/**
 * `tail` is the masked source line starting at the matched `cacheTime`/
 * `gcTime` key (i.e. `maskedLine.slice(match.index)`).
 */
function classify(tail: string): Verdict {
  if (HELPER_ALLOW_RE.test(tail)) return 'helper';
  if (TERNARY_ALLOW_RE.test(tail)) return 'ternary';
  if (LITERAL_ALLOW_RE.test(tail)) return 'literal';
  return 'violation';
}

type Mode = 'normal' | 'line' | 'block' | 'single' | 'double' | 'template';

/**
 * Replaces every character that is part of a `//` line comment, a `/* *\/`
 * block comment, or the body of a `'...'` / `"..."` / `` `...` `` literal
 * with a space, leaving every newline and every real-code character exactly
 * where it was — so line numbers and column positions of any surviving
 * `cacheTime`/`gcTime` match are unaffected. Character-by-character and
 * quote-aware ON PURPOSE (see the KNOWN LIMITATIONS note in the file header
 * for what broke the previous, substring-search version of this function).
 */
function maskNonCode(content: string): string {
  const n = content.length;
  const out: string[] = new Array(n);
  let mode: Mode = 'normal';
  let i = 0;
  while (i < n) {
    const c = content[i];

    if (mode === 'single' || mode === 'double' || mode === 'template') {
      if (c === '\n') {
        out[i] = '\n';
        i++;
        continue;
      }
      const quoteChar = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
      if (c === '\\') {
        out[i] = ' ';
        const nxt = i + 1 < n ? content[i + 1] : '';
        if (nxt === '\n') {
          i += 1; // leave the newline itself alone; loop handles it next pass
          continue;
        }
        if (i + 1 < n) out[i + 1] = ' ';
        i += 2;
        continue;
      }
      if (c === quoteChar) {
        out[i] = ' ';
        mode = 'normal';
        i++;
        continue;
      }
      out[i] = ' ';
      i++;
      continue;
    }

    if (mode === 'line') {
      if (c === '\n') {
        out[i] = '\n';
        mode = 'normal';
        i++;
        continue;
      }
      out[i] = ' ';
      i++;
      continue;
    }

    if (mode === 'block') {
      if (c === '\n') {
        out[i] = '\n';
        i++;
        continue;
      }
      const nxt = i + 1 < n ? content[i + 1] : '';
      if (c === '*' && nxt === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        mode = 'normal';
        i += 2;
        continue;
      }
      out[i] = ' ';
      i++;
      continue;
    }

    // mode === 'normal'
    if (c === '\n') {
      out[i] = '\n';
      i++;
      continue;
    }
    const nxt = i + 1 < n ? content[i + 1] : '';
    if (c === '/' && nxt === '/') {
      out[i] = ' ';
      out[i + 1] = ' ';
      mode = 'line';
      i += 2;
      continue;
    }
    if (c === '/' && nxt === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      mode = 'block';
      i += 2;
      continue;
    }
    if (c === "'") {
      out[i] = ' ';
      mode = 'single';
      i++;
      continue;
    }
    if (c === '"') {
      out[i] = ' ';
      mode = 'double';
      i++;
      continue;
    }
    if (c === '`') {
      out[i] = ' ';
      mode = 'template';
      i++;
      continue;
    }
    out[i] = c;
    i++;
  }
  return out.join('');
}

interface Occurrence {
  file: string;
  line: number;
  text: string;
  verdict: Verdict;
}

/** Runs the masker + classifier over one file's full text (not per-line —
 * comments and strings can span lines, so masking needs the whole file). */
function findOccurrences(content: string, displayFile: string): Occurrence[] {
  const masked = maskNonCode(content);
  const maskedLines = masked.split('\n');
  const rawLines = content.split('\n');
  const occurrences: Occurrence[] = [];
  for (let i = 0; i < maskedLines.length; i++) {
    const maskedLine = maskedLines[i];
    PROP_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PROP_RE.exec(maskedLine)) !== null) {
      const tail = maskedLine.slice(m.index);
      occurrences.push({
        file: displayFile,
        line: i + 1,
        text: (rawLines[i] ?? '').trim(),
        verdict: classify(tail)
      });
    }
  }
  return occurrences;
}

const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'tests']);
function isExcludedDir(name: string): boolean {
  return EXCLUDED_DIR_NAMES.has(name) || name === '.next' || name.startsWith('.next');
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
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      files.push(join(dirDisplay, entry.name));
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// A. SYNTHETIC SELF-TEST OF THE MASKER + CLASSIFIER (negative control for
//    section B — proves each allow-branch actually fires, that a real
//    violation shape is actually rejected, and that comments/strings are
//    correctly masked, so a scan that finds zero violations below is not
//    just a classifier that always says "fine").
// ---------------------------------------------------------------------------

function occurrencesIn(snippet: string): Occurrence[] {
  return findOccurrences(snippet, '<synthetic>');
}

check(
  '(a) helper-call pattern is allowed: cacheTime: rebloggedByCacheTimeMs(isServer)',
  occurrencesIn('cacheTime: rebloggedByCacheTimeMs(isServer),')[0]?.verdict === 'helper'
);
check(
  '(a) gcTime + a differently-named CacheTimeMs helper is allowed',
  occurrencesIn('gcTime: fooBarCacheTimeMs(isServer)')[0]?.verdict === 'helper'
);
check(
  '(b) ternary pattern is allowed: cacheTime: isServer ? Infinity : undefined',
  occurrencesIn('cacheTime: isServer ? Infinity : undefined')[0]?.verdict === 'ternary'
);
check(
  '(c) bare Infinity literal is allowed: gcTime: Infinity',
  occurrencesIn('gcTime: Infinity')[0]?.verdict === 'literal'
);
check(
  'VIOLATION: a plain finite literal is rejected: cacheTime: 60000',
  occurrencesIn('cacheTime: 60000,')[0]?.verdict === 'violation'
);
check(
  'VIOLATION: a helper call NOT fed isServer is rejected',
  occurrencesIn('cacheTime: rebloggedByCacheTimeMs(true),')[0]?.verdict === 'violation'
);
check(
  'VIOLATION: a ternary not keyed on isServer is rejected',
  occurrencesIn('cacheTime: isLite ? Infinity : 5000')[0]?.verdict === 'violation'
);
check(
  'VIOLATION: an arbitrary variable is rejected',
  occurrencesIn('cacheTime: STALE_MS')[0]?.verdict === 'violation'
);
check(
  'a function whose name merely contains "cacheTime" (not "CacheTimeMs") is still a violation',
  occurrencesIn('cacheTime: myCacheTimeHelper(isServer)')[0]?.verdict === 'violation'
);

// Comment- and string-masking.
check(
  'a line-comment mention of cacheTime: produces zero occurrences',
  occurrencesIn('// grep for cacheTime: before adding one').length === 0
);
check(
  'a block-comment mention of cacheTime:/gcTime: spanning lines produces zero occurrences',
  occurrencesIn(
    ['/**', ' * still overrides this per-query. Grep for `cacheTime:` / `gcTime:`', ' * before adding a new one.', ' */'].join(
      '\n'
    )
  ).length === 0
);
check(
  'real code AFTER a closed block comment is still scanned',
  occurrencesIn(['/** a doc comment */', 'cacheTime: Infinity'].join('\n'))[0]?.verdict === 'literal'
);
check(
  'a trailing // comment does not hide a real occurrence before it on the same line',
  occurrencesIn('cacheTime: Infinity, // 1 hour on the client, Infinity on the server')[0]?.verdict === 'literal'
);
check(
  'a cacheTime:-shaped fragment inside a STRING LITERAL produces zero occurrences ' +
    '(this is the exact shape that broke the previous version of this masker: ' +
    "a string literal containing the characters '/' '*' )",
  occurrencesIn("const s = 'look for /* cacheTime: 123 */ patterns';\nconst real = 1;").length === 0
);
check(
  'a cacheTime:-shaped fragment inside a TEMPLATE LITERAL produces zero occurrences',
  occurrencesIn('const s = `cacheTime: 123`;').length === 0
);
check(
  "a string literal containing '/*' on one line does not leak into a false open comment " +
    'that swallows real code on the next line (this exact shape broke the previous version ' +
    "of this masker, which used .indexOf('/*') on raw text instead of tracking string state)",
  occurrencesIn(["const blockIdx = rest.indexOf('/*');", 'cacheTime: Infinity'].join('\n')).length === 1 &&
    occurrencesIn(["const blockIdx = rest.indexOf('/*');", 'cacheTime: Infinity'].join('\n'))[0]?.verdict === 'literal'
);
check(
  'an escaped quote inside a string does not end the string early',
  occurrencesIn("const s = 'it\\'s /* not a comment */ cacheTime: 60000';\nconst real = 2;").length === 0
);

// ---------------------------------------------------------------------------
// B. THE REAL SCAN.
// ---------------------------------------------------------------------------

// __dirname is apps/blog/lib/__tests__ regardless of process.cwd(), so this
// resolves correctly whether run from the canonical repo or the build tree.
const blogRoot = resolve(__dirname, '..', '..');
const frontendRoot = resolve(blogRoot, '..', '..');

const scanRoots: Array<{ abs: string; display: string }> = [
  { abs: join(blogRoot, 'app'), display: 'app' },
  { abs: join(blogRoot, 'features'), display: 'features' },
  { abs: join(blogRoot, 'components'), display: 'components' },
  { abs: join(blogRoot, 'lib'), display: 'lib' },
  { abs: join(frontendRoot, 'packages', 'ui'), display: 'packages/ui' },
  { abs: join(frontendRoot, 'packages', 'smart-signer'), display: 'packages/smart-signer' }
];

let scannedFileCount = 0;
const allOccurrences: Occurrence[] = [];
for (const root of scanRoots) {
  let rootExists = false;
  try {
    rootExists = statSync(root.abs).isDirectory();
  } catch {
    rootExists = false;
  }
  check(`scan root exists: ${root.display}`, rootExists);
  if (!rootExists) continue;
  const files = walk(root.abs, root.display);
  scannedFileCount += files.length;
  for (const displayPath of files) {
    const absPath = displayPath.startsWith('packages') ? join(frontendRoot, displayPath) : join(blogRoot, displayPath);
    const content = readFileSync(absPath, 'utf8');
    allOccurrences.push(...findOccurrences(content, displayPath));
  }
}

check(`scanned at least one file across all roots (${scannedFileCount} files total)`, scannedFileCount > 0);

// Baseline sanity: as of this fix there are exactly 2 real occurrences in the
// tree (the helper call in use-reblogged-by-query.ts and the ternary default
// in lib/react-query.ts) — PLUS whatever this guard file's own synthetic
// snippets and doc comments happen to still surface as real, unmasked,
// top-level code (there should be none; section A already checked the
// snippets are masked correctly, this is the end-to-end proof on the real
// file on disk). This is a LOWER bound, not an exact-match — new
// correctly-guarded occurrences are expected to grow this number over time —
// but if it ever comes back at 0 the walker itself is broken (wrong roots,
// wrong extension filter, etc.) and every other check in section B would be
// vacuously green.
check(
  `found at least 2 cacheTime/gcTime occurrences in the real tree (found ${allOccurrences.length}) — proves the walker is actually reading files`,
  allOccurrences.length >= 2
);

const violations = allOccurrences.filter((o) => o.verdict === 'violation');

if (violations.length > 0) {
  console.error(`\n${violations.length} VIOLATION(S) — a cacheTime/gcTime is not isServer-aware:\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.text}`);
  }
  console.error(
    '\nFIX PATTERN: either\n' +
      '  (a) pull the value out to a pure helper and call it with isServer, e.g.\n' +
      '        export function xCacheTimeMs(isServer: boolean): number {\n' +
      '          return isServer ? Infinity : 60000; // <-- your finite client value\n' +
      '        }\n' +
      '        cacheTime: xCacheTimeMs(isServer)\n' +
      '      (see features/list-of-posts/hooks/use-reblogged-by-query.ts), or\n' +
      '  (b) inline the ternary directly: cacheTime: isServer ? Infinity : <value>\n' +
      '      (see lib/react-query.ts).\n' +
      "  `isServer` comes from '@tanstack/react-query'.\n"
  );
}
check(`zero violations across ${allOccurrences.length} occurrence(s)`, violations.length === 0);

if (failures === 0) {
  console.log(`\nserver-cache-time-guard: ALL CHECKS PASSED (${checks} checks, ${scannedFileCount} files scanned)`);
  process.exit(0);
} else {
  console.error(`\nserver-cache-time-guard: ${failures} of ${checks} CHECK(S) FAILED`);
  process.exit(1);
}
