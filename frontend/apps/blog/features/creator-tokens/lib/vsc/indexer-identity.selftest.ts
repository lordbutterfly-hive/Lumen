/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * ★★★ EVERY ACCOUNT SENT TO THE INDEXER MUST BE A DID (2026-08-28).
 *
 * THE DEFECT THIS EXISTS TO CATCH. `VscCreatorTokensDataSource.readPriceHistory`
 * called `this.indexer.priceHistoryOf(creator, limit)` with the BARE handle the
 * page routes on (`/creators/lumen.beat`), while the indexer stores the creator
 * as `hive:lumen.beat`. Its three sibling reads on the same class remember the
 * conversion — `balancesOf(toDid(holder))`, `asksOf(toDid(asker))`,
 * `deliveryOf(toDid(creator))` — and this one did not.
 *
 * Hasura answers a no-match with an EMPTY ARRAY, never an error. So the price
 * chart and the price-change indicator rendered "no history yet" on every market
 * that had ever traded, and nothing anywhere reported a failure. Measured live
 * the same day: `lumen.beat` returned 0 rows and `hive:lumen.beat` returned 17
 * from the identical query.
 *
 * WHY A SCAN AND NOT A UNIT TEST. The bug is not in any function's logic — every
 * function here is correct in isolation. It is a CALL SITE that forgot a
 * conversion, and the only thing that catches a forgotten call site is looking at
 * all of them. reads.ts already makes this argument for its key builders ("every
 * account parameter is routed through toDid() so this can never be forgotten at
 * a call site"); the indexer reads are the other half of the same rule and had no
 * guard at all.
 *
 * Run: cd apps/blog && npx tsx features/creator-tokens/lib/vsc/indexer-identity.selftest.ts
 * Add MAGI_INDEXER_URL=https://indexer.testnet.magi.milohpr.com for the live half.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { toDid } from './reads';
import { MagiIndexerClient } from './hasura';

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: string): void {
  checks += 1;
  if (ok) console.log(`ok    ${name}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

/**
 * Which `MagiIndexerClient` methods take an ACCOUNT as their first argument.
 * Kept as an explicit list so a NEW indexer method is a deliberate decision:
 * the completeness check below fails if hasura.ts grows a method that appears in
 * neither list, rather than silently defaulting it to "needs no conversion".
 */
const TAKES_ACCOUNT = ['balancesOf', 'asksOf', 'deliveryOf', 'priceHistoryOf'];
const TAKES_NO_ACCOUNT = ['health', 'discovery'];

const here = __dirname;
const sourcePath = join(here, '..', 'vsc-data-source.ts');
const hasuraPath = join(here, 'hasura.ts');
const sourceRaw = readFileSync(sourcePath, 'utf8');
const hasuraRaw = readFileSync(hasuraPath, 'utf8');

// ── 0. THE INSTRUMENT. A scan that read nothing, or that reads its own dated
// notes as if they were code, must FAIL rather than pass by absence.
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const source = stripComments(sourceRaw);
const hasura = stripComments(hasuraRaw);

console.log('\n── 0. the instrument\n');
check('the data source was read', sourceRaw.length > 20000, `${sourceRaw.length} bytes`);
check('the indexer client was read', hasuraRaw.length > 5000, `${hasuraRaw.length} bytes`);
check(
  'stripping shrank both without emptying either',
  source.length > 10000 && source.length < sourceRaw.length && hasura.length > 2000 && hasura.length < hasuraRaw.length,
  `source ${sourceRaw.length}->${source.length}, hasura ${hasuraRaw.length}->${hasura.length}`
);
check(
  '★ …and it really removed comment prose (negative control)',
  !source.includes('toDid() WAS MISSING HERE') && source.includes('async readPriceHistory'),
  'the dated note quoting the defect is gone; live code survives'
);

// ── 1. THE RULE ITSELF.
console.log('\n── 1. every account-taking indexer read routes through toDid()\n');
const calls = [...source.matchAll(/this\.indexer\.(\w+)\(([^)]*)\)/g)].map((m) => ({
  method: m[1],
  args: m[2].trim()
}));
check('the scan found the indexer call sites', calls.length >= 5, `${calls.length} calls: ${calls.map((c) => c.method).join(', ')}`);

for (const { method, args } of calls) {
  if (!TAKES_ACCOUNT.includes(method)) continue;
  const firstArg = args.split(',')[0].trim();
  check(
    `${method}() is called with a DID, not a bare handle`,
    /^toDid\(/.test(firstArg),
    `first argument is \`${firstArg}\` — the indexer stores \`hive:<name>\` and answers a no-match with [], not an error`
  );
}

// Completeness: a new method on the client must be classified, or this fails.
console.log('\n── 2. the two lists still cover the client\n');
const declared = [...hasura.matchAll(/^\s{2}async (\w+)\(/gm)].map((m) => m[1]).filter((n) => n !== 'query');
check('the client method list was extracted', declared.length >= 5, declared.join(', '));
const unclassified = declared.filter((n) => !TAKES_ACCOUNT.includes(n) && !TAKES_NO_ACCOUNT.includes(n));
check(
  '★ every client method is classified as account-taking or not',
  unclassified.length === 0,
  unclassified.length ? `unclassified: ${unclassified.join(', ')} — add each to TAKES_ACCOUNT or TAKES_NO_ACCOUNT deliberately` : 'all classified'
);

// ── 3. toDid itself.
console.log('\n── 3. the conversion is idempotent, so wrapping twice is safe\n');
check('a bare handle gains the prefix', toDid('lumen.beat') === 'hive:lumen.beat');
check('an already-prefixed handle is untouched', toDid('hive:lumen.beat') === 'hive:lumen.beat');
check('a did:pkh wallet is untouched', toDid('did:pkh:eip155:1:0xabc') === 'did:pkh:eip155:1:0xabc');

// ── 4. THE LIVE HALF. Read-only; skipped when no endpoint is given.
// Wrapped in an async main() rather than top-level await: tsx transforms this
// file as CJS, where top-level await is a hard transform error.
async function liveHalf(): Promise<void> {
const liveUrl = process.env.MAGI_INDEXER_URL ?? '';
if (!liveUrl) {
  console.log('\nnote  live read skipped (set MAGI_INDEXER_URL to include it)');
} else {
  console.log('\n── 4. against the real indexer\n');
  const client = new MagiIndexerClient(liveUrl, process.env.MAGI_CT_CONTRACT ?? '');
  const handle = process.env.MAGI_CT_CREATOR ?? 'lumen.beat';
  const bare = await client.priceHistoryOf(handle);
  const did = await client.priceHistoryOf(toDid(handle));
  check(
    `★ "${toDid(handle)}" returns real history`,
    did.length > 0,
    `${did.length} points`
  );
  check(
    `★ …and "${handle}" (the bare handle the page routes on) returns NOTHING, silently`,
    bare.length === 0,
    `${bare.length} points — this is the whole defect: no error, just an empty chart`
  );
  check(
    'history comes back oldest -> newest, which is what the chart and the change indicator assume',
    did.every((p, i) => i === 0 || p.block >= did[i - 1].block),
    did.length ? `${did[0].block} .. ${did[did.length - 1].block}` : 'no points'
  );
}

}

void liveHalf().then(() => {
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exit(1);
});
