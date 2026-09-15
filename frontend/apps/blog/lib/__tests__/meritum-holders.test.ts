/** UNIT TESTS for `lib/meritum/holders.ts`. Run by `pnpm --filter @hive/blog test:unit` under ts-node; own harness. */
import { shapeHolders, monthLabel, holdersHeadline, tokensLabel } from '../meritum/holders';

let checks = 0;
let failures = 0;
function ok(label: string, pass: boolean, detail = '') {
  checks++;
  if (pass) console.log(`  ok    ${label}`);
  else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\nshapeHolders');
const view = shapeHolders(
  [
    { holder: 'hive:dlmmqb', tokens: 1 },
    { holder: 'hive:daveks', tokens: 4 },
    { holder: 'did:pkh:eip155:1:0xAbC', tokens: 2.5 },
    { holder: 'hive:zero', tokens: 0 },
    { holder: '', tokens: 3 },
    { holder: 'hive:nan', tokens: Number.NaN }
  ],
  9
);
ok('largest first', view.rows.map((r) => r.handle).join() === 'daveks,did:pkh:eip155:1:0xAbC,dlmmqb');
ok('hive: prefix stripped, a DID kept whole', view.rows[0].handle === 'daveks' && view.rows[1].handle === 'did:pkh:eip155:1:0xAbC');
ok('only a Hive name gets a profile link', view.rows[0].hasProfile && !view.rows[1].hasProfile);
ok('zero, empty and NaN rows are dropped', view.rows.length === 3);
ok('a holder that is not an account shape (a pipe, a space, non-ASCII, over 160 bytes) is dropped', shapeHolders([{ holder: 'hive:a|b', tokens: 1 }, { holder: 'hive:a b', tokens: 1 }, { holder: 'hive:ünï', tokens: 1 }, { holder: 'hive:' + 'a'.repeat(170), tokens: 1 }, { holder: 'hive:ok', tokens: 1 }], 5).rows.map((r) => r.handle).join() === 'ok');
ok('the header count is the aggregate, not the page', view.count === 9 && view.truncated);
ok('token labels are formatted', view.rows[1].tokensLabel === '2.5' && tokensLabel(1234.5678) === '1,234.57');
ok('a count below the rows shown is corrected upward (the aggregate can never be smaller than what we listed)', shapeHolders([{ holder: 'hive:a', tokens: 1 }, { holder: 'hive:b', tokens: 1 }], 1).count === 2);
ok('limit caps the rows, not the count', shapeHolders(Array.from({ length: 12 }, (_, i) => ({ holder: `hive:h${i}`, tokens: i + 1 })), 12, 8).rows.length === 8);
ok('an empty read shapes to nothing', JSON.stringify(shapeHolders([], 0)) === JSON.stringify({ rows: [], count: 0, truncated: false }));
ok('one holder (the owner\'s real market today)', shapeHolders([{ holder: 'hive:dlmmqb', tokens: 1 }], 1).count === 1);

console.log('\nmonthLabel');
ok('indexer timestamp without a zone is UTC', monthLabel('2026-09-09T19:47:00') === 'Sep 2026');
ok('a Z-suffixed timestamp', monthLabel('2026-06-30T23:30:00Z') === 'Jun 2026');
ok('an offset timestamp keeps its instant', monthLabel('2026-07-01T00:30:00+02:00') === 'Jun 2026');
ok('garbage -> null (cell dropped)', monthLabel('not a date') === null && monthLabel('') === null && monthLabel(null) === null && monthLabel(undefined) === null);

console.log('\nholdersHeadline');
ok('singular', holdersHeadline(1) === '1 person holds this Meritum');
ok('plural', holdersHeadline(14) === '14 people hold this Meritum');
ok('zero is plural', holdersHeadline(0) === '0 people hold this Meritum');
ok('thousands separated', holdersHeadline(1234) === '1,234 people hold this Meritum');

if (failures === 0) {
  console.log(`\nmeritum-holders: ALL ${checks} CHECKS PASSED`);
  process.exit(0);
} else {
  console.error(`\nmeritum-holders: ${failures}/${checks} CHECK(S) FAILED`);
  process.exit(1);
}
