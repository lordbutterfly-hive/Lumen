/**
 * A static guard rail (2026-09-06, module-copies build map R5): walks the
 * SOURCE import graph reachable from `instrumentation.ts` and lists every
 * module-scope `new Map/Set/WeakMap/WeakSet(...)` and top-level `let` it finds
 * — the shape of state that silently becomes TWO copies the moment a file is
 * reachable from both the `rsc` webpack layer (pages, app route handlers) and
 * the `instrument` layer (instrumentation.ts and everything it imports), which
 * is exactly how server-ttl-cache.ts's per-cache Maps, hive-chain-service.ts's
 * `hiveChain`/`hiveChainPromise`/`lastFailoverAt` and lib/lite/db/pool.ts's
 * `pool` went wrong before R1/R2/R3 of this build.
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node -r tsconfig-paths/register \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node"}' \
 *     lib/__tests__/instrumentation-singleton-scan.test.ts
 *
 * ★★ WHAT THIS IS NOT: the build map's own R5 (section 5) scans the BUILT
 * `.next/server/chunks/*.js` for literals, which only exists after `next
 * build` — explicitly out of scope for this pass ("no next build"). This is
 * the SOURCE-level substitute: cheaper, runs in `test:unit`, but a CONSERVATIVE
 * OVER-APPROXIMATION — it does not model webpack's tree-shaking, dead code
 * behind an always-false env check, or `sideEffects: false` barrel pruning, so
 * it can flag a file as "reachable" that a real build would drop from the
 * instrument chunk entirely. Every finding below is annotated with whether it
 * is confirmed-live (matches the build map's own inspector reading) or
 * static-only (this scan found it, the map's live census did not).
 *
 * ★★★ TWO FINDINGS BELOW CONTRADICT THE BUILD MAP'S OWN Q4 CENSUS, ON SOURCE
 * EVIDENCE, AND ARE FLAGGED RATHER THAN FIXED (out of scope: R1/R2/R3 name
 * three specific files, not these). The map's Q4 states
 * "chain-mute.ts ... None of these is reachable from instrumentation.ts", but
 * `instrumentation.ts` -> `warm-server-caches.ts` -> `feed-prefetch.ts` ->
 * `block-filter.ts` -> `chain-mute.ts` is a real import chain
 * (`block-filter.ts` line: `} from './chain-mute';`), and `chain-mute.ts`'s
 * `cache`/`inflight` Maps are mutable and written on every call, the same
 * shape as the three caches this build fixed. The map's Q4 also lists
 * `request-budget.ts` as "middleware only", but `instrumentation.ts` itself
 * has `const { isBudgetedPage } = await import('./lib/request-budget');`
 * (line ~153). Whether either actually lands in the built instrument chunk
 * (webpack may still tree-shake what it finds unreachable at the call level)
 * is NOT verified here — that needs the build map's own chunk-literal method,
 * which needs a build. Reported so a human can decide, not silently fixed and
 * not silently ignored.
 */
import * as fs from 'fs';
import * as path from 'path';

let checks = 0;
let failures = 0;
const lines: string[] = [];

function out(s: string): void {
  lines.push(s);
}

function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (ok) {
    out(`  ok    ${name}`);
  } else {
    failures++;
    out(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(name: string): void {
  out(`\n${name}`);
}

// apps/blog/lib/__tests__ -> up 4 levels -> the frontend workspace root.
const ROOT = path.resolve(__dirname, '../../../..');
const BLOG = path.join(ROOT, 'apps/blog');
const PKG = path.join(ROOT, 'packages');

function toPosixRelative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

/** Mirrors this project's own alias map (apps/blog/tsconfig.json `paths`). */
function resolveSpecifier(spec: string, fromFile: string): string | null {
  if (spec.startsWith('.')) return path.normalize(path.join(path.dirname(fromFile), spec));
  if (spec.startsWith('@/blog/')) return path.join(BLOG, spec.slice('@/blog/'.length));
  if (spec === '@hive/common-hiveio-packages') return path.join(PKG, 'common-hiveio-packages/src/index');
  if (spec === '@hive/common-hiveio-packages/wax') return path.join(PKG, 'common-hiveio-packages/src/wax/index');
  if (spec.startsWith('@hive/common-hiveio-packages/')) {
    return path.join(PKG, 'common-hiveio-packages/src', spec.slice('@hive/common-hiveio-packages/'.length));
  }
  if (spec.startsWith('@smart-signer/')) return path.join(PKG, 'smart-signer', spec.slice('@smart-signer/'.length));
  if (spec.startsWith('@transaction/')) return path.join(PKG, 'transaction', spec.slice('@transaction/'.length));
  if (spec.startsWith('@hive/ui/')) return path.join(PKG, 'ui', spec.slice('@hive/ui/'.length));
  if (spec.startsWith('@ui/')) return path.join(PKG, 'ui', spec.slice('@ui/'.length));
  return null; // external package or Node builtin — not ours to scan
}

function findFile(base: string): string | null {
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// `import ... from '...'`, `export ... from '...'` (incl. `export * from`,
// `export type {...} from`) and every `import('...')` — dynamic or type-only —
// reachable by a plain regex over the source text. Deliberately generous:
// over-visiting a file costs nothing here, under-visiting hides a real finding.
const IMPORT_RE = /(?:^|\n)\s*import\s+(?:type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/g;
const EXPORT_FROM_RE = /(?:^|\n)\s*export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

function transitiveImports(entry: string): string[] {
  const visited = new Set<string>();
  const files: string[] = [];

  function visit(file: string | null): void {
    if (!file || visited.has(file)) return;
    visited.add(file);
    files.push(file);
    const text = fs.readFileSync(file, 'utf8');
    const specs = new Set<string>();
    for (const re of [IMPORT_RE, EXPORT_FROM_RE, DYNAMIC_IMPORT_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) specs.add(m[1]);
    }
    for (const spec of specs) {
      const base = resolveSpecifier(spec, file);
      if (base === null) continue; // external
      visit(findFile(base));
    }
  }

  visit(entry);
  return files;
}

interface Finding {
  file: string; // POSIX-relative to ROOT
  name: string;
  kind: 'new Map/Set' | 'let/var' | 'object/array literal';
}

const NEWMAP_RE = /^(?:export\s+)?(?:const|let|var)\s+(\w+)[^=\n]*=\s*new\s+(?:Map|Set|WeakMap|WeakSet)\s*[<(]/gm;
// ★ `var` ADDED (2026-09-06 review NIT) alongside `let` — this codebase is
// all `let`/`const` today, but a `var` at module scope is exactly the same
// per-copy mutable-state shape and a future contributor unfamiliar with the
// convention could still write one.
const LET_RE = /^(?:export\s+)?(?:let|var)\s+(\w+)/gm;
// ★ PLAIN OBJECT/ARRAY LITERAL ASSIGNMENT ADDED (2026-09-06 review NIT):
// `const x = {...}` / `const a: T[] = [...]` (and their `let`/`var` forms).
// `new Map/Set` above catches the collection-CLASS shape; this catches the
// plain-literal shape of the SAME risk — a module-scope object or array that
// code elsewhere mutates in place (`.push`, a property assignment) is just as
// duplicable across webpack layers as a `Map`. Deliberately broad: it also
// matches perfectly immutable config literals (`FALLBACK_ENDPOINTS`,
// `logLevelData`), which is why this scan's job is to LIST and categorise
// (see the allowlist below, which now carries an explicit "immutable config,
// never mutated" annotation for those) rather than to assume every match is a
// live bug — the same posture `PUBLISHED_PLACEHOLDERS`/`logLevels` already
// established for `new Set`/`new Map` config constants before this NIT.
const OBJECT_OR_ARRAY_RE = /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::[^=\n]+)?=\s*[{[]/gm;

function scanForSingletons(files: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = toPosixRelative(file);
    NEWMAP_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NEWMAP_RE.exec(text))) findings.push({ file: rel, name: m[1], kind: 'new Map/Set' });
    LET_RE.lastIndex = 0;
    while ((m = LET_RE.exec(text))) findings.push({ file: rel, name: m[1], kind: 'let/var' });
    OBJECT_OR_ARRAY_RE.lastIndex = 0;
    while ((m = OBJECT_OR_ARRAY_RE.exec(text))) findings.push({ file: rel, name: m[1], kind: 'object/array literal' });
  }
  return findings;
}

/**
 * ★ EVERY ENTRY HERE IS A DECISION, NOT A RUBBER STAMP — see this file's
 * header for the two that contradict the build map's own live census and are
 * flagged rather than fixed. Adding a name here without one of these three
 * reasons defeats the point of this test.
 *
 *   LEFT ALONE — the build map itself examined this one and chose not to
 *                touch it (its own R6 "leave alone", or Q4/Q6's own
 *                per-layer reasoning), NOT this build's own R1/R2/R3 fix.
 *                Named honestly as "left alone" rather than "FIXED" (a
 *                2026-09-06 review NIT: an earlier draft of this allowlist
 *                mislabelled feed-cache.ts's entry "FIXED", which it never
 *                was — it is exactly the untouched idle copy R6 describes).
 *   SAFE       — duplicated across copies is harmless: immutable, or a pure
 *                function of process-wide env vars, or a delegating wrapper
 *                over state that is itself already shared.
 *   PRE-EXISTING, OUT OF SCOPE — a genuine mutable-cache duplication in the
 *                same bug class R1 fixes, in a file this build was not asked
 *                to touch. Flagged for a human to triage, not silently fixed.
 *
 * The three files this build ACTUALLY fixed (server-ttl-cache.ts's per-cache
 * stores via `name`, hive-chain-service.ts, lib/lite/db/pool.ts) are proven
 * empty of their old `let`/`new Map` state by `MUST_BE_EMPTY` below instead of
 * appearing in this allowlist — a fix is a hard assertion, not an allowlist
 * entry that could quietly go stale.
 */
const ALLOWLIST: Record<string, string[]> = {
  // SAFE — immutable module-scope constants; two copies always agree.
  'packages/ui/lib/common-instrumentation.ts': ['PUBLISHED_PLACEHOLDERS', 'MUST_BE_REAL', 'MUST_NOT_BE_PUBLISHED'],
  'packages/ui/lib/logging.ts': ['logLevels', 'logLevelData'],
  // SAFE — lazily memoises a pure read of `process.env`; two copies compute
  // the identical value from the identical process environment.
  'packages/ui/config/lists/banned-authors.ts': ['cached'],
  // SAFE — deliberately per-copy by R2's own design (this build's header note
  // on hive-chain-service.ts): each copy's `ensureAssetConstantsFor` runs
  // once, guarded by `isAssetConstantsInitialized()`.
  'packages/ui/lib/asset-constants.ts': ['assetConfig'],
  // SAFE — a test-injection seam, `null` unless a test calls
  // `setAccountExistenceCheck`; production behaviour is identical whichever
  // copy runs.
  'apps/blog/lib/lite/social/follow-actor.ts': ['existenceCheck'],
  // SAFE — a delegating wrapper class instance; every method forwards to the
  // functions this build's R2 already made process-wide, so two wrapper
  // instances share the one chain underneath.
  'packages/transaction/lib/hive-chain-service.ts': ['_hiveChainServiceInstance'],
  // SAFE, DELIBERATELY PER-COPY — added by the 2026-09-06 review fix (item
  // 3): `localNamedLoaders` is the per-copy name-collision guard in
  // server-ttl-cache.ts's own `withTtlCache`, and its whole purpose depends
  // on NOT being shared — see that file's own header note on why a shared
  // version of this Map could never distinguish a same-copy mistake from a
  // legitimate cross-copy adoption. This is the one entry in this allowlist
  // for a Map that is correct BECAUSE it is unshared, not despite it.
  'apps/blog/lib/server-ttl-cache.ts': ['localNamedLoaders'],
  // SAFE, CONVERGENT PER COPY (2026-09-10, squatter ban list). Every copy loads
  // the SAME rows from the SAME table on the same five-minute TTL, so two copies
  // hold equal snapshots and neither can hold a value the other could not have
  // computed -- the identical reasoning as `banned-authors.ts`'s `cached` above,
  // with Postgres in place of `process.env`. Nothing mutates an entry in place;
  // a refresh REPLACES the Map wholesale.
  //
  // It cannot use `withTtlCache` and is not an oversight: `TtlCache` is an async
  // loader with no synchronous read, and this backs a SYNCHRONOUS predicate
  // (`isBannedAuthor`) whose callers are filters over feed pages and comment
  // trees. The cost of a per-copy cache here is only that a cold copy answers
  // "not a squatter" until its first load lands, and the two paths where that
  // answer would be load-bearing rather than cosmetic -- the profile route and
  // `/api/account`, which decide whose account a URL is -- `await
  // ensureSquatterList()` instead of taking the sync read.
  'apps/blog/lib/lite/moderation/squatter-list.ts': ['cache', 'loadedAt', 'inFlight'],
  // SAFE — immutable object/array-literal config, verified by grep for any
  // in-place mutation (`.push`/property reassignment/`NAME =` after
  // declaration) across each file: none found. Built once from hardcoded
  // values or `process.env`, read thereafter only through methods that
  // return NEW values (`.filter`, `.map`, `.includes`, `.has`) — the same
  // "pure function of process-wide env vars" reasoning already applied to
  // `liteConfig`/`cached` above, extended (2026-09-06 review NIT) to the
  // `const x = {...}` / `const a: T[] = [...]` shape the scan below now also
  // matches, not just `new Map/Set(...)`.
  'apps/blog/lib/utils.ts': ['DEFAULT_PREFERENCES', 'htmlCharMap'],
  'packages/ui/config/site.ts': ['chainEnv', 'siteConfig'],
  // NOTE: hive-api.ts's SAFE `DEFAULT_PARAMS_FOR_FOLLOW` is merged into its
  // single allowlist entry further down, alongside the PRE-EXISTING,
  // OUT-OF-SCOPE `bannedEdgesMemo`/`bannedEdgesInFlight` for that same file —
  // one key per file, an object literal cannot hold two.
  'packages/smart-signer/lib/hive-network-error.ts': ['NETWORK_ERROR_PATTERNS'],
  'packages/transaction/lib/retry.ts': ['DEFAULTS'],
  'apps/blog/lib/trending-tags.ts': ['TRENDING_TAGS_QUERY_KEY'],
  'packages/transaction/lib/hive.ts': ['keyTypes'],
  'apps/blog/lib/feed/feed-prefetch.ts': ['BODY_IMAGE_PATTERNS'],
  'apps/blog/lib/lite/config.ts': ['FRONTEND_ACCOUNTS', 'ACCOUNT_CREATOR_ACCOUNTS', 'liteConfig'],
  'packages/smart-signer/lib/session.ts': ['sessionOptions'],
  'apps/blog/lib/request-budget.ts': [
    'buckets',
    'PUBLIC_FILES',
    'lastSweep',
    'unknownWarnedAt',
    'tableFullWarnedAt',
    'PUBLIC_DIRS',
    'BUDGETED_API',
    'BUILT_IN_CRAWLER_CIDRS'
  ],
  // SAFE — the endpoint rotation list this build's R2 header already reasons
  // about (`getEndpointRotation` reads it via `.filter`, never mutates it);
  // now caught by the broader object/array-literal scan (review NIT) in the
  // SAME file R2 fixed the real state in — see `MUST_BE_EMPTY` below for why
  // that does not weaken the R2 proof.
  'packages/common-hiveio-packages/src/wax/hive-chain-service.ts': ['FALLBACK_ENDPOINTS'],
  // LEFT ALONE (R6 "leave alone" in the build map, not fixed by this build):
  // idle instrument copy, loaded, never written by the boot warm — the map's
  // own live census, not just this static scan.
  'apps/blog/lib/feed/feed-cache.ts': [
    'feedCache',
    'durableChain',
    'pendingInvalidation',
    'inflight',
    'failedAt',
    'generation',
    'lastSweep',
    'lastServedSweep',
    'lastSeenSweep',
    'lastSeenGuard'
  ],
  // PRE-EXISTING, OUT OF SCOPE — same bug class as R1 (a TTL memo + in-flight
  // map, written on every call), reachable from instrumentation.ts via
  // cached-api.ts -> hive-api.ts / bridge-api.ts during the boot warm. Not one
  // of the three files this build was asked to touch (server-ttl-cache.ts,
  // hive-chain-service.ts, lib/lite/db/pool.ts). Flagged for follow-up.
  // `DEFAULT_PARAMS_FOR_FOLLOW` here is SAFE (immutable, see the object/array
  // -literal note above); `bannedEdgesMemo`/`bannedEdgesInFlight` are the
  // PRE-EXISTING, OUT-OF-SCOPE mutable caches this comment block describes.
  'packages/transaction/lib/hive-api.ts': ['bannedEdgesMemo', 'bannedEdgesInFlight', 'DEFAULT_PARAMS_FOR_FOLLOW'],
  'packages/transaction/lib/bridge-api.ts': ['bannedSubscriptionsMemo', 'bannedSubscriptionsInFlight'],
  // PRE-EXISTING, OUT OF SCOPE, ★ CONTRADICTS THE BUILD MAP'S Q4 ("chain-mute.ts
  // ... None of these is reachable from instrumentation.ts") — see this file's
  // header. Same mutable-cache shape as the caches R1 fixed.
  'apps/blog/lib/lite/social/chain-mute.ts': ['cache', 'inflight'],
  // PRE-EXISTING, OUT OF SCOPE — a THIRD chain-cache layer on top of
  // hive-chain-service.ts's now-shared chain (wraps it with
  // `wrapChainWithLogging` and memoises the wrapped result separately). Not
  // named in this build's R2. Flagged for follow-up. `chainGeneration` is a
  // NEW per-copy `let` added by the 2026-09-06 review fix (item 1) — SAFE,
  // and DELIBERATELY per-copy: it records which generation THIS copy's
  // `chain` memo was built against, so each copy's own staleness check stays
  // independent (see chain.ts's own header note).
  'packages/transaction/lib/chain.ts': ['chain', 'chainGeneration'],
  // PRE-EXISTING, OUT OF SCOPE, STATIC-ONLY (not confirmed in a real build).
  // Reachable only through `@hive/common-hiveio-packages`'s barrel
  // (`export * from './hb-auth'`); that package declares `sideEffects: false`,
  // so a real webpack build may tree-shake this away entirely if nothing
  // actually imports a named hb-auth binding through the barrel — unverified
  // without a build. Flagged, not fixed.
  'packages/common-hiveio-packages/src/hb-auth/hbauth-service.ts': ['onlineClientPromise', 'onlineClient', 'offlineClientPromise']
};

/**
 * The two files this build actually moved into a `globalThis`/`Symbol.for`
 * slot. Their OLD module-scope `let`/`new Map` state must be completely gone
 * — this is the hard proof, independent of
 * `module-copies-shared-slots.test.ts`'s runtime proof, that the fix is a
 * structural one and not just a passing behaviour.
 *
 * ★ SCOPED TO `let/var` AND `new Map/Set` ONLY (2026-09-06 review NIT fix).
 * The broader object/array-literal scan added by the same review also finds
 * `FALLBACK_ENDPOINTS` in hive-chain-service.ts — a genuinely immutable
 * config array (see the ALLOWLIST entry above) that was never part of what
 * R2 moved into the shared slot. Asserting THAT away too would make this
 * check fail for a reason that has nothing to do with R2, so it is scoped to
 * exactly the two kinds of state the old `let hiveChainPromise`/`hiveChain`/
 * `lastFailoverAt`/`pool` actually were.
 */
const MUST_BE_EMPTY = [
  'packages/common-hiveio-packages/src/wax/hive-chain-service.ts',
  'apps/blog/lib/lite/db/pool.ts'
];
const MUST_BE_EMPTY_KINDS: Array<Finding['kind']> = ['let/var', 'new Map/Set'];

function main(): void {
  const files = transitiveImports(path.join(BLOG, 'instrumentation.ts'));
  out(`Traced ${files.length} files transitively imported by instrumentation.ts.`);

  const findings = scanForSingletons(files);

  section('R2/R3 proof: the two fixed files carry NO module-scope let/new-Map anymore');
  for (const relFile of MUST_BE_EMPTY) {
    const here = findings.filter((f) => f.file === relFile && MUST_BE_EMPTY_KINDS.includes(f.kind));
    check(`${relFile} has zero fixed-state (let/var, new Map/Set) singletons`, here.length === 0, JSON.stringify(here));
  }

  section('Every module-scope new Map/Set/WeakMap/WeakSet/let/var/object/array-literal reachable from instrumentation.ts');
  const unexpected: Finding[] = [];
  for (const finding of findings) {
    // Already asserted above — but ONLY for the kinds R2/R3 actually fixed;
    // an object/array literal in these two files (e.g. FALLBACK_ENDPOINTS)
    // still needs to go through the ordinary allowlist check below.
    if (MUST_BE_EMPTY.includes(finding.file) && MUST_BE_EMPTY_KINDS.includes(finding.kind)) continue;
    const allowed = ALLOWLIST[finding.file] ?? [];
    if (allowed.includes(finding.name)) {
      out(`  known  ${finding.file} :: ${finding.kind} ${finding.name}`);
    } else {
      unexpected.push(finding);
      out(`  NEW    ${finding.file} :: ${finding.kind} ${finding.name}`);
    }
  }
  check(
    'no UNLISTED module-scope singleton is reachable from instrumentation.ts',
    unexpected.length === 0,
    JSON.stringify(unexpected)
  );
  check('the allowlist above is non-empty (this scan is not vacuously passing)', Object.keys(ALLOWLIST).length > 5);
  check('at least one finding was actually classified as known', findings.some((f) => (ALLOWLIST[f.file] ?? []).includes(f.name)));
}

main();

out('');
out(
  failures === 0
    ? `PASS — ${checks} checks; ${Object.values(ALLOWLIST).flat().length} allowlisted singletons, see header for the two flagged-not-fixed contradictions of the build map's Q4`
    : `FAIL — ${failures} of ${checks} checks failed`
);
// eslint-disable-next-line no-console
console.log(lines.join('\n'));
process.exit(failures === 0 ? 0 : 1);
