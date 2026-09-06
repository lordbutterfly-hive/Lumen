/**
 * `usesDefaultUserOptions` invariants, plus two STATIC WIRING checks - plain
 * assertions, no test runner (this repo has none; same style as
 * lib/locale-cookie.test.ts).
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/auth/use-user-client-options.test.ts
 *
 * Exits 0 when every check passes, 1 (and prints each failure) otherwise.
 *
 * WHY THIS EXISTS (updated 2026-09-06, adversarial review): `useUserClient()`
 * (warm-reclick build map, option A: `/mnt/o/LUMEN-DOCS/
 * WARM-RECLICK-BUILD-MAP-2026-09-06.md` section 5.A) now takes NO options at
 * all and reads its answer from `UserClientProvider`'s shared context; a
 * caller that needs `redirectTo`/`redirectIfFound` calls the separate
 * `useUserClientWithRedirect(options)` instead, which always runs the full
 * per-call `useUserCore` implementation. `usesDefaultUserOptions` is no
 * longer a hook-count gate (that design threw "Rendered more hooks than
 * during the previous render" whenever a caller's options were conditional -
 * see `use-user-client.ts`'s own doc) - it now only powers a development-only
 * warning inside `useUserClientWithRedirect` steering a caller that does not
 * actually need it back to the cheaper `useUserClient()`. Getting IT wrong
 * only misfires a warning, which is why the two checks below matter more now:
 * they pin the actual invariants that keep the hoist safe - the provider is
 * really mounted, and nothing calls the now-zero-arg `useUserClient` with an
 * argument (TypeScript would catch a literal extra argument at compile time,
 * but this also catches the pattern regressing in a way `tsc` would not, e.g.
 * a stray options object spread in, and it fails loudly and immediately
 * regardless of what a future refactor does to the type checker's config).
 */
import * as fs from 'fs';
import * as path from 'path';
import { usesDefaultUserOptions } from '@smart-signer/lib/auth/use-user-client';

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    failures += 1;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 1. `usesDefaultUserOptions` — now a dev-warning gate, not a hook-count one.
// ═══════════════════════════════════════════════════════════════════════

check('an empty options object -> default', usesDefaultUserOptions({}) === true);
check('undefined -> default (a caller that passes nothing at all)', usesDefaultUserOptions(undefined) === true);
check(
  'negative control: an object with only UNRELATED fields is still default (proves the function checks the two named fields, not "is this object non-empty")',
  usesDefaultUserOptions({ foo: 1 } as any) === true
);

check('redirectTo set -> NOT default', usesDefaultUserOptions({ redirectTo: '/login' }) === false);
check("redirectTo set to an empty string -> still default (falsy, matches useUserCore's own `redirectTo = ''` default)", usesDefaultUserOptions({ redirectTo: '' }) === true);

check('redirectIfFound true, no redirectTo -> NOT default', usesDefaultUserOptions({ redirectIfFound: true }) === false);
check('redirectIfFound false, no redirectTo -> default', usesDefaultUserOptions({ redirectIfFound: false }) === true);

check('both redirectTo and redirectIfFound set -> NOT default', usesDefaultUserOptions({ redirectTo: '/x', redirectIfFound: true }) === false);

// ═══════════════════════════════════════════════════════════════════════
// 2. STATIC WIRING — read source text directly, no rendering. Two things
//    this fails on:
//      (a) `<UserClientProvider>` gets removed (or its import gets removed)
//          from providers.tsx -> every `useUserClient()` call would start
//          THROWING at runtime (it has no silent fallback any more).
//      (b) any file calls `useUserClient(` with an argument -> that caller
//          believes it can still pass redirect options through the hoisted
//          hook; it cannot, and must use `useUserClientWithRedirect` instead.
// ═══════════════════════════════════════════════════════════════════════

const repoRoot = path.join(__dirname, '../../../../');

function readFile(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

const providersSrc = readFile('apps/blog/features/layouts/providers.tsx');

check(
  'providers.tsx imports UserClientProvider from the shared context module',
  /import\s*\{\s*UserClientProvider\s*\}\s*from\s*['"]@smart-signer\/lib\/auth\/user-client-context['"]/.test(providersSrc)
);
check(
  'providers.tsx actually MOUNTS <UserClientProvider> (an import with no JSX use would not save anything)',
  /<UserClientProvider>/.test(providersSrc)
);

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
}

const sourceFiles: string[] = [];
walk(path.join(repoRoot, 'apps/blog'), sourceFiles);
walk(path.join(repoRoot, 'packages/smart-signer'), sourceFiles);

// The hook's own definition file legitimately mentions `useUserClient(` in
// its declaration and doc comments, and THIS test's own prose does too (the
// comment block above and the label strings below both spell it out) -
// neither is a real call site, so both are excluded by name.
const excludedFileNames = new Set(['use-user-client.ts', 'use-user-client-options.test.ts']);

let totalZeroArgCalls = 0;
const offenders: string[] = [];
for (const file of sourceFiles) {
  const src = fs.readFileSync(file, 'utf8');
  totalZeroArgCalls += (src.match(/useUserClient\(\)/g) || []).length;
  if (excludedFileNames.has(path.basename(file))) continue;
  // Anything other than whitespace between the parens is an argument.
  // `[^)\n]` (not `[^)]`) keeps the match on ONE line - without it, a
  // `useUserClient(` with no `)` on its own line (e.g. inside a comment)
  // would keep matching across every following line hunting for the next
  // `)` anywhere in the file, however far away, which is not a call site.
  const withArgs = src.match(/useUserClient\(\s*[^)\s][^)\n]*\)/g);
  if (withArgs) offenders.push(`${path.relative(repoRoot, file)}: ${withArgs.join(', ')}`);
}

check(
  `no file calls useUserClient(...) with an argument (found ${offenders.length}${offenders.length ? ': ' + offenders.join('; ') : ''})`,
  offenders.length === 0
);
check(
  `★ non-vacuity: the walk actually found real zero-arg call sites to check (got ${totalZeroArgCalls}, expected >= 150 — a walk that silently found 0 files would pass the check above for the wrong reason)`,
  totalZeroArgCalls >= 150
);

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('\nusesDefaultUserOptions + static wiring: ALL CHECKS PASSED');
}
