/**
 * Static import scanner for the public, read only wallet surface
 * (BUILDMAP-PUBLIC-WALLET-2026-09-09, invariants S1 to S4 and S8).
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/public-wallet-surface.test.ts
 *
 * WHAT THIS PROVES. The public wallet tree (features/wallet/public/**,
 * features/creator-tokens/live/use-public-portfolio.ts, app/[param]/wallet/**)
 * must carry zero signing surface and zero session derived identity (D1, D5,
 * D11). This walks the SOURCE import graph reachable from every file in that
 * tree, transitively, and fails the moment any edge resolves to (or is
 * spelled as) a module on the money denylist, or a target file's own text
 * contains one of a small set of literal call sites. It also checks each
 * target file's OWN import statements, not transitively, against a second
 * denylist of session/login identifiers: those are legitimate in the shared
 * chrome (LeftRail's own login button) but must never appear directly in a
 * wallet specific file.
 *
 * Modelled on lib/__tests__/instrumentation-singleton-scan.test.ts: same
 * resolveSpecifier/findFile shape mirroring this project's tsconfig.json
 * paths, same conservative over approximation posture (webpack tree shaking
 * is not modelled; a reachable import here may or may not survive a real
 * build, and that is fine, since this test's job is to prove ZERO reachable
 * edges, not to model bundling).
 *
 * PARALLEL BUILD NOTE. features/wallet/public/**, app/[param]/wallet/** and
 * use-public-portfolio.ts are being built by other work packages at the same
 * time as this file. A target directory or file that does not exist yet is
 * treated as empty (zero targets, zero violations) rather than an error, so
 * this test can be written and pass before that tree lands. The positive
 * controls below point at files OUTSIDE the public tree that already exist
 * today, so "scanner dead" is still caught even while the public tree is
 * empty.
 */
import * as fs from 'fs';
import * as path from 'path';

let failures = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`  FAIL ${label}`);
    failures += 1;
  }
}

// This file lives at apps/blog/lib/public-wallet-surface.test.ts, one level
// under the app root.
const APP_ROOT = path.resolve(__dirname, '..');
const MONOREPO_ROOT = path.resolve(APP_ROOT, '../..');
const PACKAGES_ROOT = path.join(MONOREPO_ROOT, 'packages');

function toAppRelative(file: string): string {
  return path.relative(APP_ROOT, file).split(path.sep).join('/');
}

/**
 * Mirrors apps/blog/tsconfig.json's `paths` plus the one real workspace
 * package (`@hive/ui`) that resolves through node_modules rather than a
 * tsconfig path, so it is not in that file at all.
 */
function resolveAliasBase(spec: string): string | null {
  if (spec.startsWith('@/blog/')) return path.join(APP_ROOT, spec.slice('@/blog/'.length));
  if (spec.startsWith('@ui/')) return path.join(PACKAGES_ROOT, 'ui', spec.slice('@ui/'.length));
  if (spec.startsWith('@transaction/')) return path.join(PACKAGES_ROOT, 'transaction', spec.slice('@transaction/'.length));
  if (spec.startsWith('@smart-signer/')) return path.join(PACKAGES_ROOT, 'smart-signer', spec.slice('@smart-signer/'.length));
  if (spec === '@hive/ui') return path.join(PACKAGES_ROOT, 'ui');
  if (spec.startsWith('@hive/ui/')) return path.join(PACKAGES_ROOT, 'ui', spec.slice('@hive/ui/'.length));
  return null;
}

function asFile(candidate: string): string | null {
  try {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  } catch {
    // unreadable path segment, treat as not found
  }
  return null;
}

/** Tries exact, .ts, .tsx, /index.ts, /index.tsx, then a package.json main/types field for a bare workspace package directory (only @hive/ui needs this, since every tsconfig alias above already points at a concrete subpath). */
function findFile(base: string, packageDepth = 0): string | null {
  const direct = asFile(base) ?? asFile(`${base}.ts`) ?? asFile(`${base}.tsx`) ?? asFile(path.join(base, 'index.ts')) ?? asFile(path.join(base, 'index.tsx'));
  if (direct) return direct;
  if (packageDepth >= 2) return null;
  try {
    if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
      const pkgJsonPath = path.join(base, 'package.json');
      if (fs.existsSync(pkgJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { main?: unknown; types?: unknown };
        const main = typeof pkg.main === 'string' ? pkg.main : typeof pkg.types === 'string' ? pkg.types : null;
        if (main) return findFile(path.join(base, main), packageDepth + 1);
      }
    }
  } catch {
    // malformed package.json or unreadable directory, treat as unresolved
  }
  return null;
}

/** Relative specs resolve against the importing file; alias specs resolve against the mapped base; anything else (a bare node_modules package: react, next/navigation, @tanstack/react-query, ...) is unresolvable and skipped, per this test's own scope. */
function resolveSpecifier(spec: string, fromFile: string): string | null {
  if (spec.startsWith('.')) return findFile(path.resolve(path.dirname(fromFile), spec));
  const base = resolveAliasBase(spec);
  return base === null ? null : findFile(base);
}

interface ImportRef {
  spec: string;
  /** The full matched text: for a static import/export this includes the named bindings, which is what the direct only denylist below needs to see (it lists both hook names like useSessionIdentity and module names like server-session). */
  statementText: string;
}

// `import ... from '<spec>'`, `export ... from '<spec>'` (default, named,
// `* as x`, `type`, `export *`), `import('<spec>')`, `require('<spec>')`.
// [^;]* (not `.*`) spans newlines inside a multi line named import list,
// since `.` does not match `\n` but a negated character class does.
const IMPORT_RE =
  /import\s+[^;]*?\s+from\s+['"]([^'"]+)['"]|export\s+[^;]*?\s+from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function extractImports(source: string): ImportRef[] {
  const refs: ImportRef[] = [];
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(source))) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (spec) refs.push({ spec, statementText: m[0] });
  }
  return refs;
}

interface DenyRule {
  label: string;
  test: (resolved: string | null, spec: string) => boolean;
}

function substringRule(label: string): DenyRule {
  return {
    label,
    test: (resolved, spec) => (resolved !== null && resolved.includes(label)) || spec.includes(label)
  };
}

// TRANSITIVE denylist (S1 to S4): checked against every import edge reached
// while walking the graph from a public tree root, at any depth, matched
// against the resolved file path AND the raw specifier as written.
const TRANSITIVE_DENYLIST: DenyRule[] = [
  'features/wallet/components/dialogs',
  'use-send-mutation',
  'use-power-mutations',
  'use-savings-mutations',
  'use-delegate-mutation',
  'use-convert-mutation',
  'use-recurring-transfer-mutation',
  'use-claim-account-mutation',
  'use-magi-send-mutation',
  'use-magi-withdraw-mutation',
  'use-magi-deposit-mutation',
  'use-claim-now',
  'magi-sdk-swap',
  'magi-sdk-widget-client',
  'advanced-tools-card',
  'broadcast-raw-operation',
  'magi-l1-broadcast',
  'lib/vsc/broadcaster',
  'use-live-portfolio',
  'use-live-token-market',
  'use-magi-assets',
  // Anchored under features/wallet/components/ so the public tree's own
  // public-wallet-tabs.tsx, public-wallet-shell.tsx and public-wallet-right-rail.tsx
  // do not trip on their own names.
  'components/wallet-right-rail',
  'components/wallet-content',
  'components/wallet-tabs',
  'components/wallet-shell',
  'magi/magi-panel',
  'magi/magi-account-card',
  'meritum/meritum-panel',
  'your-tokens-view',
  'use-token-accounts',
  'btc-deposit-address'
].map(substringRule);

// The singular hook only: 'use-token-price-chip.ts'. A plain substring test
// would also flag the plural, ALLOWED hook (use-token-price-chips.ts, its
// file name literally contains 'use-token-price-chip' as a prefix), so this
// one rule matches the resolved path's own tail, or the spec's own tail,
// instead of a bare includes().
TRANSITIVE_DENYLIST.push({
  label: 'use-token-price-chip.ts (singular hook only)',
  test: (resolved, spec) =>
    (resolved !== null && resolved.endsWith('/use-token-price-chip.ts')) || spec.endsWith('/use-token-price-chip')
});

// CONTENT denylist (S1, S2, S4): literal text in a target file's OWN source,
// not its imports. Catches a call site even if it were somehow reached
// through a specifier this scanner cannot resolve.
const CONTENT_DENYLIST = [
  'useMutation',
  'transactionService',
  '/api/lite/wallet/dids',
  'lite/wallet/dids',
  'readMyAsks',
  // S3 parity with S2: the deposit-address route by its URL, so a raw fetch()
  // of it (no import to catch) still trips.
  '/api/magi/btc-deposit-address',
  'btc-deposit-address',
  // WRITE CALL SITES on the creator-tokens data source (every non-read method
  // of CreatorTokensDataSource, creator-tokens-data-source.ts). The public tree
  // may import that facade for its reads, exactly as the anonymous feed's price
  // chips do, so the facade itself is a reviewed boundary below and the thing
  // this test forbids is a CALL to any method that signs.
  '.buy(',
  '.sell(',
  '.transferTokens(',
  '.reclaim(',
  '.rate(',
  '.ask(',
  '.answer(',
  '.decline(',
  '.refund(',
  '.refundHolder(',
  '.registerMarket(',
  '.launchMarket(',
  '.createOffering(',
  '.deleteOffering(',
  '.setOfferingPrice(',
  '.setOfferingTitle(',
  '.renewSubscription(',
  '.retire(',
  '.setCap(',
  '.setFace(',
  '.withdrawTreasury(',
  '.claimTradeFees(',
  '.closeIfDrained(',
  'broadcast('
];

// REVIEWED BOUNDARY. The creator-tokens data source is one facade carrying
// reads AND writes, and it imports the Hive broadcaster so its write methods
// can sign. Every public read surface in the app already imports it (the
// anonymous feed's useTokenPriceChips), so an import of the facade is not a
// signing surface; a CALL to one of its write methods is, and the content
// denylist above catches that in the public tree's own text. The walk stops
// here instead of flagging the facade's own broadcaster import on every page.
const REVIEWED_BOUNDARIES = new Set<string>([path.join(APP_ROOT, 'features/creator-tokens/lib/creator-tokens-data-source.ts')]);

// DIRECT ONLY denylist (S8): a target file's OWN import statements, never
// walked transitively, because the shared chrome the public shell legitimately
// mounts (LeftRail, for its own login button) uses these exact names one hop
// away and must not trip this test.
const DIRECT_ONLY_DENYLIST = [
  'useSessionIdentity',
  'useUserClient',
  'server-session',
  'use-user-client',
  'DialogLogin',
  'dialog-login',
  'useServerAccountTier',
  'server-account-tier-context'
];

interface Violation {
  chain: string[];
  rule: string;
}

function readSourceOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const MAX_DEPTH = 12;

/** Every check this test runs, against ONE target file: content (own text), direct only (own imports), transitive (the whole reachable graph). */
function scanTarget(root: string): Violation[] {
  const violations: Violation[] = [];
  const rootSource = readSourceOrNull(root);
  if (rootSource === null) return violations;
  const rootLabel = toAppRelative(root);

  for (const literal of CONTENT_DENYLIST) {
    if (rootSource.includes(literal)) {
      violations.push({ chain: [rootLabel], rule: `content:${literal}` });
    }
  }

  for (const ref of extractImports(rootSource)) {
    for (const literal of DIRECT_ONLY_DENYLIST) {
      if (ref.statementText.includes(literal)) {
        violations.push({ chain: [rootLabel, ref.spec], rule: `direct-import:${literal}` });
      }
    }
  }

  const visited = new Set<string>([root]);
  const sourceCache = new Map<string, string>([[root, rootSource]]);
  const queue: Array<{ file: string; chain: string[]; depth: number }> = [{ file: root, chain: [rootLabel], depth: 0 }];

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item || item.depth >= MAX_DEPTH) continue;
    const source = sourceCache.get(item.file) ?? readSourceOrNull(item.file);
    if (source === null) continue;

    for (const ref of extractImports(source)) {
      const resolved = resolveSpecifier(ref.spec, item.file);
      for (const rule of TRANSITIVE_DENYLIST) {
        if (rule.test(resolved, ref.spec)) {
          const hop = resolved ? toAppRelative(resolved) : ref.spec;
          violations.push({ chain: [...item.chain, hop], rule: `transitive:${rule.label}` });
        }
      }
      if (resolved && !visited.has(resolved) && !REVIEWED_BOUNDARIES.has(resolved)) {
        visited.add(resolved);
        queue.push({ file: resolved, chain: [...item.chain, toAppRelative(resolved)], depth: item.depth + 1 });
      }
    }
  }

  return violations;
}

function printViolations(rootFile: string, violations: Violation[]): void {
  for (const v of violations) {
    console.error(`${toAppRelative(rootFile)} -> ${v.chain.join(' -> ')} -> ${v.rule}`);
  }
}

function walkTsFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // Does not exist yet, the tree is being built in parallel by other work
    // packages. Empty, not an error.
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      out.push(full);
    }
  }
  return out;
}

// The public tree, S1's own scope: features/wallet/public/**, the one
// creator-tokens public hook, and app/[param]/wallet/**.
const PUBLIC_TREE_TARGETS = [
  ...walkTsFiles(path.join(APP_ROOT, 'features/wallet/public')),
  path.join(APP_ROOT, 'features/creator-tokens/live/use-public-portfolio.ts'),
  ...walkTsFiles(path.join(APP_ROOT, 'app/[param]/wallet'))
].filter((f) => fs.existsSync(f));

console.log(`public wallet tree targets found: ${PUBLIC_TREE_TARGETS.length}`);

let anyPublicTreeViolation = false;
for (const target of PUBLIC_TREE_TARGETS) {
  const violations = scanTarget(target);
  if (violations.length > 0) {
    anyPublicTreeViolation = true;
    printViolations(target, violations);
  }
}
check('the public wallet tree imports/uses none of the money or session denylist', !anyPublicTreeViolation);

// Positive controls (S1): each of these files is a KNOWN, real offender
// outside the public tree, on today's source tree, before the public tree
// even exists. If any one of these produces zero violations, the scanner
// itself is dead and every clean result above is worthless.
const POSITIVE_CONTROLS: Array<{ file: string; label: string }> = [
  {
    file: path.join(APP_ROOT, 'features/wallet/components/hive-token-card.tsx'),
    label: 'hive-token-card.tsx pulls in features/wallet/components/dialogs transitively'
  },
  {
    file: path.join(APP_ROOT, 'features/wallet/components/magi/magi-panel.tsx'),
    label: 'magi-panel.tsx imports magi-sdk-swap'
  },
  {
    file: path.join(APP_ROOT, 'features/creator-tokens/ui/your-tokens/your-tokens-view.tsx'),
    label: 'your-tokens-view.tsx imports use-live-portfolio'
  },
  {
    file: path.join(APP_ROOT, 'features/wallet/hooks/use-magi-assets.ts'),
    label: 'use-magi-assets.ts pulls in use-token-accounts transitively'
  }
];

for (const control of POSITIVE_CONTROLS) {
  if (!fs.existsSync(control.file)) {
    check(`positive control file exists: ${control.label}`, false);
    continue;
  }
  const violations = scanTarget(control.file);
  if (violations.length === 0) {
    console.error(`scanner dead: ${control.label} produced zero violations`);
  } else {
    printViolations(control.file, violations);
  }
  check(`positive control trips: ${control.label}`, violations.length > 0);
}

// Positive control for the WRITE CALL content rule specifically: the live
// market hook calls dataSource.buy(...) and must trip 'content:.buy(' even
// though the facade itself is a reviewed boundary for the walk.
const writeCallControl = path.join(APP_ROOT, 'features/creator-tokens/live/use-live-token-market.ts');
const writeCallViolations = fs.existsSync(writeCallControl) ? scanTarget(writeCallControl) : [];
check(
  'positive control trips: use-live-token-market.ts calls dataSource.buy( (content rule)',
  writeCallViolations.some((v) => v.rule === 'content:.buy(')
);

// Negative control: a file with no imports at all and none of the denylisted
// literals in its own text must trip nothing.
const negativeControlFile = path.join(APP_ROOT, 'lib/anonymous-cache-policy.ts');
const negativeControlExists = fs.existsSync(negativeControlFile);
const negativeViolations = negativeControlExists ? scanTarget(negativeControlFile) : [];
if (negativeViolations.length > 0) printViolations(negativeControlFile, negativeViolations);
check('negative control (anonymous-cache-policy.ts) trips zero violations', negativeControlExists && negativeViolations.length === 0);

if (failures === 0) {
  console.log('\npublic-wallet-surface: ALL CHECKS PASSED');
  process.exit(0);
} else {
  console.error(`\npublic-wallet-surface: ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
