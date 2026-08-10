/**
 * A creator-token read that did not succeed must reach the screen as UNKNOWN —
 * never as a zero balance or an empty shop.
 *
 * Plain assertions, no test runner (this repo has none; same shape as
 * features/retention/lib/__tests__/ladder.test.ts).
 *
 * RUN IT:
 *   pnpm --filter @hive/blog exec ts-node \
 *     --compilerOptions '{"module":"commonjs","moduleResolution":"node","jsx":"react"}' \
 *     features/creator-tokens/live/__tests__/failed-reads.test.ts
 *
 * ★ WHAT THIS CAN AND CANNOT PROVE — read this before trusting it.
 *
 * It proves the RULE (`collapseRead`) and the CONTRACT (`LiveStudio` still
 * admits null, checked by the compiler, so a future edit cannot quietly go back
 * to a non-nullable number). It does NOT drive the studio screen: the panels
 * only mount once a real market read succeeds, which needs the live contract on
 * a chain node, and a stubbed one that is subtly wrong renders "no market" and
 * passes every assertion while testing nothing. The `—` / "couldn't be loaded"
 * branches in creator-studio.tsx are therefore compile-enforced (making
 * `tradeFeeClaimableUsd` nullable turned all four call sites into type errors,
 * each handled) and code-reviewed — not runtime-proven. Settling that needs a
 * browser run against a reachable contract with the fee read failed at the
 * network boundary.
 */

import { collapseRead } from '../collapse-read';
import type { LiveStudio } from '../use-live-studio';

/* ── compile-time half: the contract itself ──────────────────────────────────
 * If someone changes these back to `number` / `Offering[]`, this file stops
 * compiling. That is the point: the type IS the guard that forced every screen
 * to handle "we do not know", and a test that only checks the helper would not
 * notice the guard being removed.
 */
type MustAdmitNull<T> = null extends T ? true : never;
const _feeMayBeUnknown: MustAdmitNull<LiveStudio['tradeFeeClaimableUsd']> = true;
const _shopMayBeUnknown: MustAdmitNull<LiveStudio['offerings']> = true;
void _feeMayBeUnknown;
void _shopMayBeUnknown;

/* ── runtime half: the rule ──────────────────────────────────────────────── */

const failures: string[] = [];
let checks = 0;

function check(name: string, condition: boolean, evidence: string): void {
  checks += 1;
  if (!condition) failures.push(`${name} — ${evidence}`);
  // eslint-disable-next-line no-console
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}\n          ${evidence}`);
}

console.log('\n1. a REJECTED read is unknown, not a value');
check(
  'a rejected fee read is null, not 0',
  collapseRead<number>({ isError: true, data: undefined }) === null,
  `collapseRead({isError:true}) = ${JSON.stringify(collapseRead<number>({ isError: true, data: undefined }))} ` +
    `(the old \`data ?? 0\` answered 0, which disabled Claim and read "Claimed")`
);
check(
  'a rejected shop read is null, not []',
  collapseRead<string[]>({ isError: true, data: undefined }) === null,
  `collapseRead({isError:true}) = ${JSON.stringify(collapseRead<string[]>({ isError: true, data: undefined }))} ` +
    `(the old \`data ?? []\` answered [], which read "You haven't posted any services yet")`
);
check(
  'a read that errored but has stale data is STILL unknown',
  collapseRead<number>({ isError: true, data: 12 }) === null,
  `collapseRead({isError:true,data:12}) = ${JSON.stringify(collapseRead<number>({ isError: true, data: 12 }))}`
);

console.log('\n2. a read still in flight is unknown too — not zero');
check(
  'no data yet is null',
  collapseRead<number>({ isError: false, data: undefined }) === null,
  `collapseRead({isError:false,data:undefined}) = ${JSON.stringify(
    collapseRead<number>({ isError: false, data: undefined })
  )}`
);

console.log('\n3. a genuine zero / a genuinely empty shop still come through');
check(
  'a real 0 balance is 0, not null',
  collapseRead<number>({ isError: false, data: 0 }) === 0,
  `collapseRead({isError:false,data:0}) = ${JSON.stringify(collapseRead<number>({ isError: false, data: 0 }))} ` +
    `(a fix that answered null here would hide "Claimed" from everyone)`
);
{
  const empty = collapseRead<string[]>({ isError: false, data: [] });
  check(
    'a real empty shop is [], not null',
    Array.isArray(empty) && empty.length === 0,
    `collapseRead({isError:false,data:[]}) = ${JSON.stringify(empty)}`
  );
}
{
  const full = collapseRead<string[]>({ isError: false, data: ['one'] });
  check(
    'a populated shop passes through unchanged',
    Array.isArray(full) && full.length === 1 && full[0] === 'one',
    `collapseRead({isError:false,data:['one']}) = ${JSON.stringify(full)}`
  );
}

console.log(`\nfailed-reads: ${checks - failures.length}/${checks} passed`);
if (failures.length) {
  console.log(`\n${failures.length} FAILING CHECK(S):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
