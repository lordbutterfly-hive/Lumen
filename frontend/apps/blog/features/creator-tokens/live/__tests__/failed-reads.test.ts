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

/* ── 4. THE ASKS READ, WHICH THIS RULE HAD NOT BEEN SWEPT TO ────────────────
 *
 * ★ THE INBOX WAS STILL DOING `asksQuery.data ?? []` (2026-08-28, false-text
 * audit F2), three lines from two reads that had been fixed. A rejected asks
 * read became zero requests, and the screen said "No requests waiting. Nice —
 * you're all caught up." to a creator with a real escrow running down its
 * deadline. That is a worse failure than the fee one this file was written for:
 * missing a deadline forfeits the ask.
 *
 * `inboxUnavailable` is a boolean rather than a nullable list, because the
 * answer path zips `inbox[i]` against `rawInbox[i]` by index and a nullable
 * list would have made that zip unexpressible. So the compile-time guard used
 * above does not apply here, and the wiring is proven by scanning the source
 * instead: the flag must EXIST, be DERIVED from collapseRead, and be BRANCHED
 * ON above the reassuring sentence. Each scan asserts it read a real file
 * first, so a moved or renamed file fails loudly rather than passing on an
 * empty string.
 */
console.log('\n4. the asks read routes through the same rule, and the screen branches on it');
{
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('path') as typeof import('path');
  const here = __dirname;
  const hookRaw = readFileSync(join(here, '..', 'use-live-studio.ts'), 'utf8');
  const screenRaw = readFileSync(join(here, '..', '..', 'ui', 'studio', 'creator-studio.tsx'), 'utf8');

  // ★ THE SCAN HAD TO STOP READING ITS OWN COMMENTS. Both dated notes written
  // with this fix QUOTE the retired code (`asksQuery.data ?? []`) and the
  // sentence it used to produce, so the first version of these checks failed
  // against a correctly-fixed file. A scan that cannot tell code from a comment
  // about code proves nothing in either direction.
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const hook = stripComments(hookRaw);
  const screen = stripComments(screenRaw);

  check('the hook source was actually read', hookRaw.length > 5000, `${hookRaw.length} bytes`);
  check('the studio source was actually read', screenRaw.length > 5000, `${screenRaw.length} bytes`);
  check(
    'stripping shrank both files without emptying either',
    hook.length > 2000 && hook.length < hookRaw.length && screen.length > 5000 && screen.length < screenRaw.length,
    `hook ${hookRaw.length}->${hook.length}, screen ${screenRaw.length}->${screen.length}`
  );
  // The stripper's own negative control: these two strings exist ONLY inside the
  // dated notes explaining the fix, so if either survives, the stripper is inert
  // and every scan below is meaningless.
  check(
    '★ …and the stripper really removed comment prose, not just whitespace',
    !hook.includes('collapsed a rejected read into zero requests') &&
      !screen.includes('Retry, do\n                not reassure'),
    'the retired code quoted inside the dated notes is gone from the stripped text'
  );
  check(
    '★ …while live code survived stripping (so the scans below can still fail)',
    hook.includes('const asksQuery = useQuery') && screen.includes('Requests waiting'),
    'a landmark from each file is still present after stripping'
  );
  check(
    'the asks read no longer collapses a failure into an empty array',
    !hook.includes('asksQuery.data ?? []'),
    `\`asksQuery.data ?? []\` present: ${hook.includes('asksQuery.data ?? []')}`
  );
  check(
    'it goes through collapseRead, the same door as the fee and shop reads',
    hook.includes('collapseRead(asksQuery)'),
    `\`collapseRead(asksQuery)\` present: ${hook.includes('collapseRead(asksQuery)')}`
  );
  check(
    'and the unknown state is exposed to the screen',
    /inboxUnavailable\s*=\s*asksRead === null/.test(hook) && /\n\s*inboxUnavailable,/.test(hook),
    'derived from the collapsed read AND returned from the hook'
  );
  const reassurance = screen.indexOf('No requests waiting. Nice');
  const guard = screen.indexOf('{inboxUnavailable ? (');
  check('the reassuring sentence is still in the screen', reassurance > 0, `at index ${reassurance}`);
  check(
    '★ …and the unknown branch is tested BEFORE it, so a failed read never reaches it',
    guard > 0 && guard < reassurance,
    `guard at ${guard}, reassurance at ${reassurance}`
  );
  check(
    '★ the count Stat stops asserting zero from an unread list',
    screen.includes("value={inboxUnavailable ? '—' : String(inbox.length)}"),
    'Requests waiting renders an em dash when the read has not succeeded'
  );
}

console.log(`\nfailed-reads: ${checks - failures.length}/${checks} passed`);
if (failures.length) {
  console.log(`\n${failures.length} FAILING CHECK(S):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
