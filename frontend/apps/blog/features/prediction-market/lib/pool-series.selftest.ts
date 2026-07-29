/* eslint-disable no-console -- a CLI self-test script: its output IS the result. */
/**
 * Self-test for buildOddsSeries. Run:
 *   cd apps/blog && npx tsx features/prediction-market/lib/pool-series.selftest.ts
 *
 * Follows the precedent of features/creator-tokens/lib/vsc/payload-contract.selftest.ts:
 * a plain script with no test-runner dependency, because the blog app has no unit
 * test harness — only Playwright, which cannot reach a pure function like this.
 */

import { buildOddsSeries, type PoolPoint } from './pool-series';

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
  } else {
    console.log(`ok    ${name}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `got ${a}\n      want ${e}`);
}

// --- not enough history to draw honestly -----------------------------------

eq('no points -> null', buildOddsSeries([], 3), null);
eq('zero outcomes -> null', buildOddsSeries([{ outcome: 0, block: 1, poolAfter: '10' }], 0), null);
eq(
  'a single block -> null (one point drawn as a line claims the odds held steady)',
  buildOddsSeries(
    [
      { outcome: 0, block: 10, poolAfter: '100' },
      { outcome: 1, block: 10, poolAfter: '100' }
    ],
    2
  ),
  null
);

// --- the forward-fill, which is the whole reason this module exists ---------

// Bucket 1 bets once at block 10 and never again. At block 20 it still holds
// 100 base units. Reading rows literally would drop it to 0 and hand bucket 0
// a 100% share it never had.
eq(
  'a bucket with no later row keeps its stake',
  buildOddsSeries(
    [
      { outcome: 0, block: 10, poolAfter: '100' },
      { outcome: 1, block: 10, poolAfter: '100' },
      { outcome: 0, block: 20, poolAfter: '300' }
    ],
    2
  ),
  [
    [50, 75],
    [50, 25]
  ]
);

// Several bets inside one block are simultaneous on chain and must collapse into
// a single column, not produce a spurious intermediate state.
eq(
  'bets sharing a block collapse into one column',
  buildOddsSeries(
    [
      { outcome: 0, block: 10, poolAfter: '100' },
      { outcome: 1, block: 20, poolAfter: '100' },
      { outcome: 1, block: 20, poolAfter: '300' }
    ],
    2
  ),
  [
    [100, 25],
    [0, 75]
  ]
);

// Rows arriving out of order (merged pages) must not change the answer.
{
  const inOrder: PoolPoint[] = [
    { outcome: 0, block: 10, poolAfter: '100' },
    { outcome: 1, block: 20, poolAfter: '100' },
    { outcome: 0, block: 30, poolAfter: '200' }
  ];
  const shuffled: PoolPoint[] = [inOrder[2], inOrder[0], inOrder[1]];
  eq('shuffled input matches ordered input', buildOddsSeries(shuffled, 2), buildOddsSeries(inOrder, 2));
}

// --- precision -------------------------------------------------------------

// Sums past 2^53 must stay exact. Done as floats, the two buckets below would
// compare equal and both report 50%.
{
  const big = '9007199254740993'; // 2^53 + 1
  const series = buildOddsSeries(
    [
      { outcome: 0, block: 1, poolAfter: big },
      { outcome: 1, block: 1, poolAfter: '1' },
      { outcome: 1, block: 2, poolAfter: '2' }
    ],
    2
  );
  check('a pool past 2^53 does not lose units', series !== null && series[0][0] > 99.9 && series[1][0] < 0.1,
    `got ${JSON.stringify(series)}`);
}

// --- degenerate input ------------------------------------------------------

eq(
  'columns before any money exists are dropped',
  buildOddsSeries(
    [
      { outcome: 0, block: 5, poolAfter: '0' },
      { outcome: 0, block: 10, poolAfter: '100' },
      { outcome: 1, block: 20, poolAfter: '100' }
    ],
    2
  ),
  [
    [100, 50],
    [0, 50]
  ]
);

{
  // An outcome index the round does not have means the client and the chain
  // disagree about the bucket count. It must be ignored, never widen the series.
  const series = buildOddsSeries(
    [
      { outcome: 0, block: 10, poolAfter: '100' },
      { outcome: 9, block: 15, poolAfter: '500' },
      { outcome: 1, block: 20, poolAfter: '100' }
    ],
    2
  );
  check('an out-of-range outcome is ignored, not given a lane', series !== null && series.length === 2,
    `got ${JSON.stringify(series)}`);
}

{
  // A column is emitted per DISTINCT BLOCK, so this yields three of them — the
  // middle one identical to the first, because the unparseable row contributes
  // nothing. The guarantee under test is not the column count: it is that a
  // value we cannot read degrades to zero instead of turning the whole column
  // into NaN, which would render as a hole in every line at once.
  const series = buildOddsSeries(
    [
      { outcome: 0, block: 10, poolAfter: '100' },
      { outcome: 1, block: 20, poolAfter: 'not-a-number' },
      { outcome: 0, block: 30, poolAfter: '300' }
    ],
    2
  );
  check(
    'unparseable money reads as zero rather than NaN-poisoning the column',
    series !== null &&
      series[0].every((v) => v === 100) &&
      series[1].every((v) => v === 0) &&
      series.every((line) => line.every((v) => Number.isFinite(v))),
    `got ${JSON.stringify(series)}`
  );
}

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
