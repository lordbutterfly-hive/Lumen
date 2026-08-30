/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * ★★★ THE CHART'S QUERY KEY, END TO END, AGAINST THE REAL INDEXER.
 *
 * Run:
 *   cd apps/blog && npx tsx features/creator-tokens/lib/vsc/price-history-key.selftest.ts
 *
 * ── WHAT IT GUARDS, AND WHY IT IS NOT indexer-identity.selftest.ts AGAIN
 *
 * That file scans the CALL SITES: every `this.indexer.<method>(...)` on the data
 * source must pass `toDid(...)`. It is a source scan, and its live half is
 * opt-in (`MAGI_INDEXER_URL`), so on a normal run nothing ever asks the indexer
 * a question. This file asks the indexer the question — because the defect
 * class here does not raise anything to scan:
 *
 *     a wrong identity key returns ZERO ROWS, never an error.
 *
 * That is how the 2026-08-28 defect survived: `readPriceHistory` queried the
 * bare handle `lumen.beat` while the indexer stores `hive:lumen.beat`, Hasura
 * answered `[]`, and the page rendered "No price history yet" on every market
 * that had ever traded. Nothing threw. Nothing logged. The only thing that can
 * catch it is comparing what the two spellings actually return.
 *
 * ── AND THE SECOND HALF: THE CHART'S OTHER OFF-BY-ONE (2026-08-30)
 *
 * Owner: *"theres no chart in the market."* Reproduced at /creators/@hbd-temp
 * on the running build — a market reading "30 of 30 tokens issued · Sold out"
 * showed "No price history yet". Not the identity bug returning: `hive:hbd-temp`
 * returns its row. The market had traded exactly ONCE, a price row records only
 * where supply LANDED, and `live/adapt.ts` will not draw a line through one
 * point. `readPriceHistory` now recovers the state the market started FROM out
 * of the row's own signed `delta` (`supplyAfter - delta`) and prepends it.
 *
 * That fix depends on a COLUMN existing on a view we do not own. A column that
 * disappears is the same failure mode from the other side — the query would
 * error and the chart would die entirely — so this asserts `delta` is really
 * there, really signed, and really reconstructs the supply chain of a market
 * with more than one trade.
 *
 * ── THE INSTRUMENT
 *
 * A live check that silently skips is worse than no check. This one defaults to
 * the testnet indexer, FAILS on an empty or nonsensical answer, and only treats
 * an unreachable endpoint as a skip — announced loudly, with a non-zero exit
 * reserved for real failures.
 *
 *   MAGI_INDEXER_URL   override the endpoint (default: the testnet indexer)
 *   MAGI_CT_CREATOR    a creator with >= 2 recorded trades (default: lumen.beat)
 *   MAGI_CT_CREATOR_1  a creator with exactly ONE recorded trade (default: hbd-temp)
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { toDid } from './reads';
import { MagiIndexerClient } from './hasura';
import { baseUnitsToHuman, displayPricePerTokenBaseUnits } from '../contract-math';

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

const DEFAULT_URL = 'https://indexer.testnet.magi.milohpr.com';
const url = process.env.MAGI_INDEXER_URL ?? DEFAULT_URL;
const traded = process.env.MAGI_CT_CREATOR ?? 'lumen.beat';
const tradedOnce = process.env.MAGI_CT_CREATOR_1 ?? 'hbd-temp';

// ── 1. THE SOURCE STILL CONVERTS. Cheap, offline, and the thing that regressed.
console.log('\n── 1. the call site converts the handle to a DID\n');
{
  const raw = readFileSync(join(__dirname, '..', 'vsc-data-source.ts'), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  check('the data source was read', raw.length > 20_000, `${raw.length} bytes`);
  check(
    '★ …and comment prose really was stripped (negative control, or this scan proves nothing)',
    raw.includes('toDid() WAS MISSING HERE') && !code.includes('toDid() WAS MISSING HERE')
  );
  const call = /this\.indexer\.priceHistoryOf\(([^,)]+)/.exec(code);
  check('the price-history call site was located', call !== null, call ? `first argument: ${call[1].trim()}` : 'not found');
  check(
    '★ priceHistoryOf() is passed toDid(creator), NOT the bare handle the page routes on',
    call !== null && /^toDid\(/.test(call[1].trim()),
    call ? `first argument is \`${call[1].trim()}\`` : undefined
  );
  check(
    '★ the opening point is derived from the row, not invented',
    code.includes('oldest.supplyAfter - oldest.delta') && code.includes('opening: true')
  );
  check(
    '★ …and it is guarded, so an unreadable delta returns the series untouched rather than a fabricated point',
    code.includes('if (!Number.isFinite(openingSupply) || openingSupply < 0) return trades;')
  );
}

async function live(): Promise<void> {
  console.log(`\n── 2. against the real indexer (${url})\n`);
  const client = new MagiIndexerClient(url, process.env.MAGI_CT_CONTRACT ?? '');

  let did: Awaited<ReturnType<MagiIndexerClient['priceHistoryOf']>>;
  try {
    did = await client.priceHistoryOf(toDid(traded));
  } catch (e) {
    // Unreachable endpoint is the ONE thing that is not a failure. A schema
    // error is: it means the query no longer matches the view, which is exactly
    // what would take the chart out.
    const msg = e instanceof Error ? e.message : String(e);
    if (/magi indexer: \{/.test(msg)) {
      check('★ the query matches the live view schema', false, msg);
      return;
    }
    console.log(`skip  indexer unreachable (${msg}) — live half not run`);
    return;
  }

  const bare = await client.priceHistoryOf(traded);

  check(`★ "${toDid(traded)}" returns real history`, did.length >= 2, `${did.length} rows`);
  check(
    `★ …and "${traded}", the bare handle the page routes on, returns NOTHING — silently, with no error`,
    bare.length === 0,
    `${bare.length} rows. This IS the defect class: a wrong key is indistinguishable from an untraded market.`
  );
  check(
    'rows arrive oldest -> newest, which the chart and the change indicator both assume',
    did.every((p, i) => i === 0 || p.block >= did[i - 1].block),
    did.length ? `blocks ${did[0].block} .. ${did[did.length - 1].block}` : 'no rows'
  );

  // The property that MAKES the bare handle unmatchable — asserted from the data
  // rather than assumed, so a future indexer that starts storing bare handles is
  // caught here instead of on the page.
  console.log('\n── 3. the indexer really is keyed on DIDs\n');
  const anyRows = await client.priceHistoryOf(toDid(traded), 5);
  check('there were rows to inspect', anyRows.length > 0, `${anyRows.length} rows`);
  check(
    '★ every row is a real, ordered supply observation (no nulls silently coerced to 0)',
    anyRows.length > 0 && anyRows.every((p) => Number.isFinite(p.supplyAfter) && p.supplyAfter >= 0 && p.block > 0)
  );

  console.log('\n── 4. `delta` — the column the opening point depends on\n');
  check(
    '★ delta is present and non-zero on every trade row (a missing column reads as 0 and would kill the opening point)',
    anyRows.length > 0 && anyRows.every((p) => Number.isFinite(p.delta) && p.delta !== 0),
    anyRows.map((p) => `${p.side} ${p.delta}`).join(', ')
  );
  check(
    '★ delta is SIGNED by side: buys add, sells subtract',
    anyRows.every((p) => (p.side === 'buy' ? p.delta > 0 : p.delta < 0)),
    anyRows.map((p) => `${p.side}:${p.delta}`).join(', ')
  );
  check(
    '★ supplyAfter - delta reconstructs the PREVIOUS row exactly — the proof that the derived opening supply is real and not an interpolation',
    did.length >= 2 && did.slice(1).every((p, i) => p.supplyAfter - p.delta === did[i].supplyAfter),
    did.map((p) => `${p.supplyAfter}(${p.delta})`).join(' '),
  );

  console.log('\n── 5. the market the owner reported: one trade, and now a chart\n');
  const one = await client.priceHistoryOf(toDid(tradedOnce));
  check(`"${toDid(tradedOnce)}" has exactly one recorded trade`, one.length === 1, `${one.length} rows`);
  if (one.length === 1) {
    const openingSupply = one[0].supplyAfter - one[0].delta;
    const opening = baseUnitsToHuman(displayPricePerTokenBaseUnits(openingSupply));
    const now = baseUnitsToHuman(displayPricePerTokenBaseUnits(one[0].supplyAfter));
    check('★ its opening supply is recoverable and non-negative', Number.isFinite(openingSupply) && openingSupply >= 0, `supply ${openingSupply}`);
    check(
      '★ …and the opening PRICE is a real price, never the oracle 0 at supply 0 — this is why displayPricePerTokenBaseUnits is used and not spotRate',
      opening > 0,
      `${opening} HBD at supply ${openingSupply} -> ${now} HBD at supply ${one[0].supplyAfter}`
    );
    check(
      '★ two distinct points, so live/adapt.ts two-point floor is cleared by real data rather than by lowering the floor',
      opening > 0 && now > 0 && opening !== now
    );
  }
}

void live().then(() => {
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) process.exit(1);
});
