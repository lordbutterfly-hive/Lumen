/**
 * `seededRankMarks` invariants - plain assertions, no test runner (same style as
 * lib/render-timing.test.ts). Exits 0 when every check passes, 1 otherwise.
 *
 * WHY: the seed is only honest while it answers the exact question the client would ask.
 * A seed used for an account the server never asked would render "no mark" for an author
 * who has one, until the 10 minute staleTime ran out.
 */
import { seededRankMarks } from './rank-marks-seed';

let failed = 0;
function check(name: string, ok: boolean) {
  if (!ok) {
    failed++;
    console.error('FAIL', name);
  }
}

const spark = { tier: 'spark', rankNumber: 1, showMark: false };
const torch = { tier: 'torch', rankNumber: 5, showMark: true };
const seed = { accounts: ['alice', 'bob', 'carol'], marks: { alice: spark, carol: torch }, at: 1000 };

check('no seed -> undefined', seededRankMarks(['alice'], undefined) === undefined);
check('null seed -> undefined', seededRankMarks(['alice'], null) === undefined);
check('empty key -> undefined', seededRankMarks([], seed) === undefined);

const all = seededRankMarks(['alice', 'bob', 'carol'], seed);
check('covered -> seeded', !!all);
check('covered keeps marks', JSON.stringify(all) === JSON.stringify({ marks: { alice: spark, carol: torch } }));
check('asked but unranked stays absent', !!all && !('bob' in all.marks));

const subset = seededRankMarks(['bob', 'carol'], seed);
check('subset -> only its own accounts', JSON.stringify(subset) === JSON.stringify({ marks: { carol: torch } }));

check('one account not asked -> no seed', seededRankMarks(['alice', 'dave'], seed) === undefined);
check('case differs from asked -> no seed', seededRankMarks(['Alice'], seed) === undefined);

if (failed > 0) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('rank-marks-seed: all checks passed');
